// Real Icarus oracle-path integration test (task 3.8).
//
// This test exercises the deterministic oracle END TO END against the REAL
// Icarus Verilog toolchain: it compiles and simulates representative Verilog +
// testbench pairs through the actual `iverilog` + `vvp` and asserts the
// pass/fail/error verdict the Simulator adapter derives, plus real-oracle
// determinism (Design: Testing Strategy (Integration tests), Tool_Runner sandbox
// design (Reproducibility); Req 1.4, 2.8). It is the non-vacuous, real-oracle
// counterpart to the mock-only Property 10 logic check in task 3.6.
//
// WHAT PATH IS EXERCISED
//   The full real-oracle stack is exercised through the settled seam:
//     IcarusSimulatorAdapter  (parses `CHECK <name> PASS|FAIL` signalling)
//       -> SandboxToolRunner  (validates the job, capture-all-or-error)
//         -> LocalWorkerRuntime  (this file: the "real oracle, local runtime")
//           -> tool_runner_worker (the real Python worker) -> iverilog + vvp
//   Only the ISOLATION WRAPPER differs from production. Production runs the same
//   worker inside a gVisor-isolated (`runsc`) container via `RunscSandboxRuntime`;
//   that path needs Docker + the `runsc` runtime + the built, pinned worker image,
//   which a plain dev/CI box does not have. So this test uses a documented
//   "real oracle, local runtime" path: the SAME language-neutral job/result
//   contract, the SAME worker, the SAME resource caps and kill-timer semantics,
//   but the worker is spawned as a local process instead of inside gVisor. The
//   real gVisor isolation is exercised and asserted separately by task 3.9. The
//   oracle itself (iverilog + vvp and the verdict derivation) is fully real here.
//
// CAPABILITY PROBE + SKIP
//   The real toolchain is absent in most environments. A runtime probe checks for
//   `iverilog`, `vvp`, and a Python interpreter that can import the worker
//   package; when any is missing the real-oracle suites SKIP (via
//   `describe.skipIf`) and a clear note is emitted that the real-oracle path was
//   NOT exercised here, so a toolchain-less CI never fails spuriously and no false
//   confidence is created. The test is genuinely executable and correct once the
//   toolchain is present - it is not a placeholder.

import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  IcarusSimulatorAdapter,
  SandboxToolRunner,
  type ArtifactBlobRef,
  type ContainerSpec,
  type DeniedOperation,
  type RawRunCapture,
  type ResourceLimits,
  type ResourceUsage,
  type SandboxJob,
  type SandboxRuntime,
  type SimulationVerdict,
  type SourceFile,
} from '@app/tools';

// -- Locations --------------------------------------------------------------

/** This test file's directory, resolved from its module URL. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** The thin Python worker's importable source root (`.../worker/src`). */
const WORKER_SRC = resolve(HERE, '../tools/sandbox/worker/src');

/**
 * Python interpreters to try, most-preferred first: the repo venv (per
 * `dev-tooling.md`), then the standard system interpreters. The worker itself
 * uses only the standard library, so any of these can run it given `PYTHONPATH`.
 */
const PYTHON_CANDIDATES: readonly string[] = [
  resolve(HERE, '../../.venv/bin/python'),
  'python3',
  'python',
];

// -- Capability probe -------------------------------------------------------

/** The outcome of probing for the real Icarus toolchain and worker runtime. */
interface OracleProbe {
  /** True only when iverilog, vvp, and a worker-capable Python are all present. */
  readonly available: boolean;
  /** A human-readable reason, surfaced when the real-oracle path is skipped. */
  readonly reason: string;
  /** The Python interpreter that can import the worker (empty when unavailable). */
  readonly pythonBin: string;
}

/**
 * Whether a binary is launchable on PATH. A spawn error (for example `ENOENT`)
 * means the binary is absent; a non-zero exit from a probe flag does not, so only
 * the spawn error is treated as "missing".
 */
function binaryPresent(bin: string, args: readonly string[]): boolean {
  const result = spawnSync(bin, [...args], { encoding: 'utf8' });
  return result.error === undefined;
}

/** The first Python candidate that can import the worker package, or null. */
function findWorkerPython(): string | null {
  for (const candidate of PYTHON_CANDIDATES) {
    const result = spawnSync(candidate, ['-c', 'import tool_runner_worker'], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONPATH: WORKER_SRC },
    });
    if (result.error === undefined && result.status === 0) {
      return candidate;
    }
  }
  return null;
}

/** Probe for the real toolchain once at module load; drives the skip decision. */
function probeRealOracle(): OracleProbe {
  if (!binaryPresent('iverilog', ['-V'])) {
    return { available: false, reason: 'iverilog is not installed on PATH', pythonBin: '' };
  }
  if (!binaryPresent('vvp', ['-V'])) {
    return { available: false, reason: 'vvp is not installed on PATH', pythonBin: '' };
  }
  const python = findWorkerPython();
  if (python === null) {
    return {
      available: false,
      reason: 'no Python interpreter can import the tool_runner_worker package',
      pythonBin: '',
    };
  }
  return {
    available: true,
    reason: 'iverilog + vvp + tool_runner_worker are present',
    pythonBin: python,
  };
}

const PROBE = probeRealOracle();

if (!PROBE.available) {
  // A clear, single note that the real oracle was NOT exercised in this
  // environment (continuity-critical for the M0 checkpoint): the deterministic
  // oracle is wired and logic-tested, but unvalidated against real iverilog here.
  console.warn(
    `[icarus-oracle.integration] Real-oracle path NOT exercised: ${PROBE.reason}. ` +
      'iverilog/vvp (and the gVisor worker image) are unavailable, so the verdict ' +
      'and determinism assertions are SKIPPED in this environment.',
  );
}

// -- Real oracle, local runtime ---------------------------------------------

/** Zeroed usage for a run that could not report its own consumption. */
const ZERO_USAGE: ResourceUsage = { wallMs: 0, maxMemMb: 0, cpuMs: 0 };

/** An infrastructure-failure capture: nothing usable was produced. */
function infraCapture(timedOut: boolean): RawRunCapture {
  return {
    timedOut,
    infraFailure: !timedOut,
    exitCode: null,
    stdout: null,
    stderr: null,
    artifacts: {},
    deniedOperations: [],
    resourceUsage: ZERO_USAGE,
  };
}

/** Narrow an unknown to a plain object record, or null. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** Narrow an unknown to a string, or null. */
function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Narrow an unknown to a finite number, defaulting to 0. */
function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Narrow an unknown exit code to a number, or null. */
function asExitCode(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

/** Narrow an unknown to an array of unknowns (empty when it is not an array). */
function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

/** Parse one artifact reference from the worker report, or null when malformed. */
function parseArtifactRef(value: unknown): ArtifactBlobRef | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const name = asString(record.name);
  const sha256 = asString(record.sha256);
  if (name === null || sha256 === null) {
    return null;
  }
  return { name, sizeBytes: asNumber(record.sizeBytes), sha256 };
}

/** Parse the name-keyed artifact map from the worker report. */
function parseArtifacts(value: unknown): Record<string, ArtifactBlobRef> {
  const record = asRecord(value);
  if (record === null) {
    return {};
  }
  const artifacts: Record<string, ArtifactBlobRef> = {};
  for (const [key, entry] of Object.entries(record)) {
    const ref = parseArtifactRef(entry);
    if (ref !== null) {
      artifacts[key] = ref;
    }
  }
  return artifacts;
}

/** The denial kinds the seam recognizes. */
const DENIAL_KINDS: readonly DeniedOperation['kind'][] = ['filesystem', 'network', 'process'];

/** Parse the recorded out-of-workspace denials from the worker report. */
function parseDeniedOperations(value: unknown): DeniedOperation[] {
  const denials: DeniedOperation[] = [];
  for (const entry of asArray(value)) {
    const record = asRecord(entry);
    if (record === null) {
      continue;
    }
    const kind = asString(record.kind);
    const detail = asString(record.detail);
    if (
      kind === null ||
      detail === null ||
      !DENIAL_KINDS.includes(kind as DeniedOperation['kind'])
    ) {
      continue;
    }
    const path = asString(record.path);
    denials.push(
      path === null
        ? { kind: kind as DeniedOperation['kind'], detail }
        : { kind: kind as DeniedOperation['kind'], detail, path },
    );
  }
  return denials;
}

/** Parse the observed resource usage from the worker report. */
function parseResourceUsage(value: unknown): ResourceUsage {
  const record = asRecord(value);
  if (record === null) {
    return ZERO_USAGE;
  }
  return {
    wallMs: asNumber(record.wallMs),
    maxMemMb: asNumber(record.maxMemMb),
    cpuMs: asNumber(record.cpuMs),
  };
}

/**
 * Turn the worker's stdout report into a `RawRunCapture`. Mirrors the parsing
 * `RunscSandboxRuntime` performs on the same report shape; an unparseable report
 * is an infrastructure failure (never a fabricated run).
 */
function captureFromWorkerReport(raw: string): RawRunCapture {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return infraCapture(false);
  }
  const record = asRecord(parsed);
  if (record === null) {
    return infraCapture(false);
  }
  return {
    timedOut: false,
    infraFailure: false,
    exitCode: asExitCode(record.exitCode),
    stdout: asString(record.stdout),
    stderr: asString(record.stderr),
    artifacts: parseArtifacts(record.artifacts),
    deniedOperations: parseDeniedOperations(record.deniedOperations),
    resourceUsage: parseResourceUsage(record.resourceUsage),
  };
}

/**
 * A `SandboxRuntime` that runs the REAL Python worker (and thus the real iverilog
 * + vvp) as a local process, honoring the same job/result contract and the same
 * wall-clock kill-timer semantics as `RunscSandboxRuntime`. It deliberately does
 * NOT provide gVisor isolation - that production boundary is validated by task
 * 3.9 - so this is the documented "real oracle, local runtime" path used only in
 * this integration test.
 */
class LocalWorkerRuntime implements SandboxRuntime {
  private readonly pythonBin: string;

  constructor(pythonBin: string) {
    this.pythonBin = pythonBin;
  }

  launch(spec: ContainerSpec, job: SandboxJob): Promise<RawRunCapture> {
    return new Promise<RawRunCapture>((resolvePromise) => {
      let capturedStdout = '';
      let timedOut = false;
      let spawnFailed = false;

      // No shell and array args prevent command injection from job contents; the
      // worker package is made importable via PYTHONPATH without an install step.
      const child = spawn(this.pythonBin, ['-m', 'tool_runner_worker'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONPATH: WORKER_SRC },
      });

      const killTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, spec.limits.wallMs);

      child.stdout.on('data', (chunk: Buffer) => {
        capturedStdout += chunk.toString('utf8');
      });
      child.on('error', () => {
        spawnFailed = true;
      });
      child.on('close', () => {
        clearTimeout(killTimer);
        if (timedOut) {
          resolvePromise(infraCapture(true));
          return;
        }
        if (spawnFailed) {
          resolvePromise(infraCapture(false));
          return;
        }
        resolvePromise(captureFromWorkerReport(capturedStdout));
      });

      child.stdin.end(JSON.stringify(job));
    });
  }
}

// -- Representative fixtures -------------------------------------------------
//
// A single spec-derived testbench drives all three RTL variants. It is
// independent of the RTL (it only knows the module interface and the acceptance
// checks), it emits the machine-readable `CHECK <name> PASS|FAIL` signalling the
// Simulator adapter parses, and it writes a VCD waveform (a required output) so a
// completed run is classified functionally rather than as a missing-artifact
// error. Checks are sampled on the falling edge to avoid a race with the DUT's
// non-blocking updates on the rising edge.

/** Spec-derived testbench for a 4-bit synchronous up-counter with sync reset. */
const COUNTER_TESTBENCH = `\`timescale 1ns/1ps
module counter_tb;
  reg clk;
  reg rst;
  wire [3:0] count;

  counter dut (.clk(clk), .rst(rst), .count(count));

  initial clk = 1'b0;
  always #5 clk = ~clk;

  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, counter_tb);

    rst = 1'b1;
    @(posedge clk);   // reset takes effect on this edge
    @(negedge clk);   // sample after the non-blocking update settles
    if (count === 4'd0)
      $display("CHECK reset_clears_output PASS");
    else
      $display("CHECK reset_clears_output FAIL");

    rst = 1'b0;
    @(posedge clk);   // 0 -> 1
    @(posedge clk);   // 1 -> 2
    @(posedge clk);   // 2 -> 3
    @(negedge clk);
    if (count === 4'd3)
      $display("CHECK counts_up PASS");
    else
      $display("CHECK counts_up FAIL");

    $finish;
  end
endmodule
`;

/** Correct counter: both spec checks pass, so the oracle verdict is `pass`. */
const PASSING_COUNTER_RTL = `module counter (
  input  wire       clk,
  input  wire       rst,
  output reg  [3:0] count
);
  always @(posedge clk) begin
    if (rst)
      count <= 4'd0;
    else
      count <= count + 4'd1;
  end
endmodule
`;

/** Buggy counter (increments by two): the counts-up check fails, so verdict is `fail`. */
const BUGGY_COUNTER_RTL = `module counter (
  input  wire       clk,
  input  wire       rst,
  output reg  [3:0] count
);
  always @(posedge clk) begin
    if (rst)
      count <= 4'd0;
    else
      count <= count + 4'd2; // BUG: should increment by one
  end
endmodule
`;

/** RTL with a deliberate syntax error: iverilog fails to compile, so no waveform
 *  is produced and the run classifies as `error` (capture-all-or-error). */
const COMPILE_ERROR_RTL = `module counter (
  input  wire       clk,
  input  wire       rst,
  output reg  [3:0] count
);
  always @(posedge clk) begin
    count <= count + // deliberate unterminated expression
  end
endmodule
`;

// -- Harness ----------------------------------------------------------------

/** Generous real-run caps: local process startup plus a real iverilog+vvp run. */
const REAL_LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };

/** Build the real-oracle simulator adapter over the local worker runtime. */
function realOracleAdapter(): IcarusSimulatorAdapter {
  const runtime = new LocalWorkerRuntime(PROBE.pythonBin);
  const runner = new SandboxToolRunner(runtime);
  return new IcarusSimulatorAdapter(runner);
}

/** Compile-and-simulate one RTL + testbench pair through the real oracle. */
function simulatePair(rtl: string, testbench: string): Promise<SimulationVerdict> {
  const rtlFile: SourceFile = { path: 'counter.v', contents: rtl };
  const testbenchFile: SourceFile = { path: 'counter_tb.v', contents: testbench };
  return realOracleAdapter().simulate([rtlFile], testbenchFile, REAL_LIMITS);
}

/** Per-run timeout for a single real compile-and-simulate (ms). */
const RUN_TIMEOUT = 60_000;
/** Per-run timeout for the two-run determinism cases (ms). */
const DETERMINISM_TIMEOUT = 120_000;

// -- Tests ------------------------------------------------------------------

describe('icarus real-oracle capability probe', () => {
  it('documents whether the real oracle path was exercised in this environment', () => {
    // Always runs; it asserts the probe is well-formed and, on skip, the note
    // above has already recorded that the real oracle was not exercised.
    expect(typeof PROBE.available).toBe('boolean');
    expect(PROBE.reason.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!PROBE.available)(
  'Icarus real oracle path (iverilog + vvp, local runtime; Req 1.4)',
  () => {
    it(
      'returns pass for a correct counter whose spec-derived checks all pass',
      async () => {
        const verdict = await simulatePair(PASSING_COUNTER_RTL, COUNTER_TESTBENCH);
        expect(verdict.verdict).toBe('pass');
        expect(verdict.checks.length).toBeGreaterThan(0);
        expect(verdict.checks.every((check) => check.passed)).toBe(true);
        expect(verdict.vcd).not.toBeNull();
      },
      RUN_TIMEOUT,
    );

    it(
      'returns fail for a buggy counter that violates a spec-derived check',
      async () => {
        const verdict = await simulatePair(BUGGY_COUNTER_RTL, COUNTER_TESTBENCH);
        expect(verdict.verdict).toBe('fail');
        expect(verdict.checks.some((check) => !check.passed)).toBe(true);
      },
      RUN_TIMEOUT,
    );

    it(
      'returns error for RTL that fails to compile (no waveform captured)',
      async () => {
        const verdict = await simulatePair(COMPILE_ERROR_RTL, COUNTER_TESTBENCH);
        expect(verdict.verdict).toBe('error');
        expect(verdict.vcd).toBeNull();
      },
      RUN_TIMEOUT,
    );
  },
);

describe.skipIf(!PROBE.available)(
  'Icarus real-oracle determinism (Property 10, non-vacuous; Req 2.8)',
  () => {
    it(
      'yields an identical pass verdict and checks when the same design runs twice',
      async () => {
        const first = await simulatePair(PASSING_COUNTER_RTL, COUNTER_TESTBENCH);
        const second = await simulatePair(PASSING_COUNTER_RTL, COUNTER_TESTBENCH);
        expect(first.verdict).toBe('pass');
        expect(second.verdict).toBe(first.verdict);
        expect(second.checks).toEqual(first.checks);
      },
      DETERMINISM_TIMEOUT,
    );

    it(
      'reproducibly classifies a failing design as fail across repeated runs',
      async () => {
        const first = await simulatePair(BUGGY_COUNTER_RTL, COUNTER_TESTBENCH);
        const second = await simulatePair(BUGGY_COUNTER_RTL, COUNTER_TESTBENCH);
        expect(first.verdict).toBe('fail');
        expect(second.verdict).toBe(first.verdict);
        expect(second.checks).toEqual(first.checks);
      },
      DETERMINISM_TIMEOUT,
    );
  },
);
