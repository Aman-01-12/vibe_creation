// Shared real-oracle integration harness: the "real oracle, local runtime" path.
//
// Both the Icarus oracle-path integration test (task 3.8) and the Verification_Loop
// integration test (task 14.2) need to drive the REAL Icarus toolchain
// (`iverilog` + `vvp`) through the settled Simulator seam, and both must SKIP
// cleanly when that toolchain is absent so a toolchain-less CI never fails
// spuriously. This module is the single owner of that machinery so the skip
// mechanism and the runtime are defined once, not copied per test.
//
// WHAT PATH IS EXERCISED
//   The full real-oracle stack is exercised through the settled seam:
//     IcarusSimulatorAdapter  (parses `CHECK <name> PASS|FAIL` signalling)
//       -> SandboxToolRunner  (validates the job, capture-all-or-error)
//         -> LocalWorkerRuntime  (@app/tools: the "real oracle, local runtime")
//           -> tool_runner_worker (the real Python worker) -> iverilog + vvp
//   Only the ISOLATION WRAPPER differs from production. Production runs the same
//   worker inside a gVisor-isolated (`runsc`) container via `RunscSandboxRuntime`;
//   that path needs Docker + the `runsc` runtime + the built, pinned worker image,
//   which a plain dev/CI box does not have. So this harness uses a documented
//   "real oracle, local runtime" path: the SAME language-neutral job/result
//   contract, the SAME worker, the SAME resource caps and kill-timer semantics,
//   but the worker is spawned as a local process instead of inside gVisor. The
//   real gVisor isolation is exercised and asserted separately by task 3.9. The
//   oracle itself (iverilog + vvp and the verdict derivation) is fully real here.
//
//   `LocalWorkerRuntime` itself now lives in `@app/tools` next to the other
//   `SandboxRuntime` implementations, because `@app/eval`'s production loop-runner
//   must drive the real oracle too and may not import `app/test`. What stays HERE is
//   the capability PROBE: it exists to decide whether a vitest suite skips, and it
//   encodes developer-environment policy (which repo venv to prefer, per
//   `dev-tooling.md`). Neither belongs in a shipped product layer.
//
// CAPABILITY PROBE + SKIP
//   The real toolchain is absent in most environments. `PROBE` checks for
//   `iverilog`, `vvp`, and a Python interpreter that can import the worker
//   package once at module load; consumers gate their real-oracle suites with
//   `describe.skipIf(!PROBE.available)` and surface `PROBE.reason` on skip.

import { spawnSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ToolchainStructuralGate } from '@app/agent';
import {
  BoundedArtifactRetention,
  IcarusSimulatorAdapter,
  LocalWorkerRuntime,
  SandboxToolRunner,
  WORKER_SOURCE_ROOT,
  YosysCheckLintAdapter,
  YosysNetlistSvgAdapter,
  YosysSmtBmcFormalOracle,
  type FormalResourceCaps,
} from '@app/tools';
import { FixedTimingDerivation, probeFormalToolchainAvailability } from '@app/eval';

// -- Locations --------------------------------------------------------------

/** This module's directory, resolved from its module URL. */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The repository root, resolved from this module's own location in either layout.
 *
 * Authored at `app/test/` and compiled to `app/test/dist/`, so the distance differs by one
 * level between the tree vitest loads and the build output a measurement script runs from.
 */
const REPOSITORY_ROOT = resolve(HERE, basename(HERE) === 'dist' ? '../../..' : '../..');

/**
 * Python interpreters to try, most-preferred first: the repo venv (per
 * `dev-tooling.md`), then the standard system interpreters. Measured on this host: the venv is
 * the only worker-capable one, because `contract.py` imports `jsonschema` and the system
 * interpreter has none - so a venv path that misses is a probe reporting a toolchain-less host.
 */
const PYTHON_CANDIDATES: readonly string[] = [
  resolve(REPOSITORY_ROOT, '.venv/bin/python'),
  'python3',
  'python',
];

// -- Capability probe -------------------------------------------------------

/**
 * The outcome of probing for a real EDA toolchain plus the worker runtime.
 *
 * Reused for both real-tool probes in this harness: the Icarus simulate path
 * (`PROBE`: iverilog + vvp + worker Python) and the Yosys/netlistsvg synthesize
 * path (`SYNTH_PROBE`: yosys + netlistsvg + worker Python). The shape is
 * tool-agnostic on purpose so the single skip mechanism serves every real-tool
 * suite.
 */
export interface OracleProbe {
  /** True only when every required binary and a worker-capable Python are present. */
  readonly available: boolean;
  /** A human-readable reason, surfaced when the real-tool path is skipped. */
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
      env: { ...process.env, PYTHONPATH: WORKER_SOURCE_ROOT },
    });
    if (result.error === undefined && result.status === 0) {
      return candidate;
    }
  }
  return null;
}

/**
 * The worker-capable Python interpreter, resolved once at module load and shared
 * by every probe below (both the Icarus and the synth path run the same worker,
 * so the interpreter is discovered once, not per probe).
 */
const WORKER_PYTHON_BIN: string | null = findWorkerPython();

/** The message shown when no interpreter can import the worker package. */
const NO_WORKER_PYTHON_REASON = 'no Python interpreter can import the tool_runner_worker package';

/** Probe for the real Icarus toolchain once at module load; drives the skip decision. */
function probeRealOracle(): OracleProbe {
  if (!binaryPresent('iverilog', ['-V'])) {
    return { available: false, reason: 'iverilog is not installed on PATH', pythonBin: '' };
  }
  if (!binaryPresent('vvp', ['-V'])) {
    return { available: false, reason: 'vvp is not installed on PATH', pythonBin: '' };
  }
  if (WORKER_PYTHON_BIN === null) {
    return { available: false, reason: NO_WORKER_PYTHON_REASON, pythonBin: '' };
  }
  return {
    available: true,
    reason: 'iverilog + vvp + tool_runner_worker are present',
    pythonBin: WORKER_PYTHON_BIN,
  };
}

/**
 * Probe for the real Yosys/netlistsvg synthesize toolchain once at module load.
 *
 * The schematic path (Req 9.2) runs Yosys `write_json` piped to netlistsvg through
 * the SAME worker seam as the simulate path, so it needs `yosys`, `netlistsvg`,
 * and a worker-capable Python. `binaryPresent` treats only a spawn error (for
 * example `ENOENT`) as "missing", so a non-zero exit from the probe flag never
 * reports a present tool as absent.
 */
function probeRealSynth(): OracleProbe {
  if (!binaryPresent('yosys', ['-V'])) {
    return { available: false, reason: 'yosys is not installed on PATH', pythonBin: '' };
  }
  if (!binaryPresent('netlistsvg', ['--help'])) {
    return { available: false, reason: 'netlistsvg is not installed on PATH', pythonBin: '' };
  }
  if (WORKER_PYTHON_BIN === null) {
    return { available: false, reason: NO_WORKER_PYTHON_REASON, pythonBin: '' };
  }
  return {
    available: true,
    reason: 'yosys + netlistsvg + tool_runner_worker are present',
    pythonBin: WORKER_PYTHON_BIN,
  };
}

/**
 * Probe for the real Structural_Gate toolchain once at module load: `yosys`, `iverilog`, `vvp`,
 * then the worker Python, in that order, so a skip names the first missing piece.
 *
 * The gate's four checks run compile (Icarus) and lint/synthesis (Yosys) over the same worker
 * seam as `PROBE` and `SYNTH_PROBE`, but it has no Schematic_Request, so `netlistsvg` is not
 * part of this chain (that is `SYNTH_PROBE`'s own tool, not this gate's).
 */
function probeRealStructural(): OracleProbe {
  if (!binaryPresent('yosys', ['-V'])) {
    return { available: false, reason: 'yosys is not installed on PATH', pythonBin: '' };
  }
  if (!binaryPresent('iverilog', ['-V'])) {
    return { available: false, reason: 'iverilog is not installed on PATH', pythonBin: '' };
  }
  if (!binaryPresent('vvp', ['-V'])) {
    return { available: false, reason: 'vvp is not installed on PATH', pythonBin: '' };
  }
  if (WORKER_PYTHON_BIN === null) {
    return { available: false, reason: NO_WORKER_PYTHON_REASON, pythonBin: '' };
  }
  return {
    available: true,
    reason: 'yosys + iverilog + vvp + tool_runner_worker are present',
    pythonBin: WORKER_PYTHON_BIN,
  };
}

/**
 * Probe for `yosys` alone, with no worker and no Python requirement.
 *
 * The Interface_Cross_Check (C7) spawns `yosys` directly rather than through the worker seam -
 * Requirement 9.2 permits this because it restricts adapters, not tests, and the input is the
 * trusted golden corpus, not generated RTL - so its own gate is this probe, not `STRUCTURAL_PROBE`.
 */
function probeYosysOnly(): OracleProbe {
  if (!binaryPresent('yosys', ['-V'])) {
    return { available: false, reason: 'yosys is not installed on PATH', pythonBin: '' };
  }
  return { available: true, reason: 'yosys is present', pythonBin: '' };
}

// -- The formal probe: the SHARED composed-invocation check, plus the worker Python ---
//
// The composed-invocation check is NOT defined here, and that is deliberate. Whether this
// host can run a proof cannot be answered by presence alone - `bitwuzla` 0.9.1 is installed
// and spawnable while `yosys-smtbmc -s bitwuzla` fails on EVERY input, because
// `smtio.py:229` builds `bitwuzla --smt2 -i` and 0.9.x rejects both flags - and it is the
// SAME question the Eval_Harness refuses a formal campaign on (Req 11.18). One question with
// one answer, so `probeFormalToolchainAvailability` in `@app/eval` owns it and this file
// calls it. Two copies could drift, and then a suite would skip while a campaign ran, or the
// reverse - and neither divergence is visible from a green suite.
//
// What stays HERE is what is genuinely test-side: the worker-interpreter discovery, which
// encodes developer-environment policy (which repo venv to prefer, per `dev-tooling.md`), and
// the skip mechanism itself. A present-but-not-invocable toolchain and a missing one are
// still reported alike, in the same terms, and neither is ever reported as a result.

/**
 * Probe for the real formal toolchain once at module load: the composed chain, THEN the
 * worker Python.
 *
 * The chain first, because it is the question that distinguishes this probe from the other
 * two; a missing interpreter is checked second so its reason never masks a broken solver.
 */
function probeRealFormal(): OracleProbe {
  const chain = probeFormalToolchainAvailability();
  if (!chain.available) {
    return { available: false, reason: chain.reason, pythonBin: '' };
  }
  if (WORKER_PYTHON_BIN === null) {
    return { available: false, reason: NO_WORKER_PYTHON_REASON, pythonBin: '' };
  }
  return {
    available: true,
    reason: `${chain.reason}, and tool_runner_worker is importable`,
    pythonBin: WORKER_PYTHON_BIN,
  };
}

/** The single, module-load-time probe consumers gate their real-oracle suites on. */
export const PROBE: OracleProbe = probeRealOracle();

/** The module-load-time probe consumers gate their real-synth suites on (task 15.8). */
export const SYNTH_PROBE: OracleProbe = probeRealSynth();

/** The module-load-time probe consumers gate their real-FORMAL suites on (task 6.2). */
export const FORMAL_PROBE: OracleProbe = probeRealFormal();

/** The module-load-time probe consumers gate their real-STRUCTURAL-GATE suites on (task 5.6). */
export const STRUCTURAL_PROBE: OracleProbe = probeRealStructural();

/** The module-load-time, yosys-alone probe the Interface_Cross_Check (C7) gates on (task 5.6). */
export const YOSYS_PROBE: OracleProbe = probeYosysOnly();

/**
 * The worker-capable Python interpreter, or null when none is available.
 *
 * Exposed so the synth fail-safe suite can exercise the REAL worker seam (the
 * degrade-to-`unavailable` path) even in an environment that has the worker Python
 * but not yosys/netlistsvg, keeping that assertion non-vacuous.
 */
export const WORKER_PYTHON: string | null = WORKER_PYTHON_BIN;

/**
 * The Timing_Derivation stand-in for suites that import the corpus but never read
 * `timingContract`.
 *
 * `importRtllmCorpus` requires a derivation port, and these suites want the corpus for its
 * problem ids, its golden testbenches, or its reference RTL. The real port would run a Yosys
 * elaboration per design in each of them, and a refusing port would quarantine every design
 * and leave them asserting over an empty corpus.
 *
 * `registered` rather than `combinational` because it is the value the importer used to
 * fabricate, so threading the port through changes nothing any of these suites measures.
 * Requirement 8's paired re-measurement is where the derived contract is measured against
 * it. A suite that READS `spec.timingContract` - feeding the Consensus_Harness, the
 * Reference_Model prompt, or a re-measurement - builds its own port instead of using this,
 * because there the fabricated value reaches what the suite measures.
 */
export const CORPUS_TIMING_STAND_IN = new FixedTimingDerivation('registered');

// -- Real-tool adapter builders over the rehomed local worker runtime --------

/**
 * Build the real-oracle Simulator adapter over the local worker runtime.
 *
 * Callers MUST gate use on `PROBE.available`; when the toolchain is absent
 * `PROBE.pythonBin` is empty and the adapter cannot run.
 */
export function realOracleAdapter(): IcarusSimulatorAdapter {
  const runtime = new LocalWorkerRuntime(PROBE.pythonBin);
  const runner = new SandboxToolRunner(runtime);
  return new IcarusSimulatorAdapter(runner);
}

/**
 * Build the real Synth adapter (Yosys `write_json` -> netlistsvg) over the local
 * worker runtime, on a given worker Python interpreter (task 15.8).
 *
 * Two callers with different gating needs share this builder:
 *   - the real schematic suite passes `SYNTH_PROBE.pythonBin` and runs only when
 *     `SYNTH_PROBE.available` (yosys + netlistsvg + worker Python all present);
 *   - the fail-safe suite passes `WORKER_PYTHON` and runs whenever the worker
 *     Python is present, exercising the real seam's degrade-to-`unavailable` path
 *     without the synth tools installed.
 */
export function realSynthAdapter(pythonBin: string): YosysNetlistSvgAdapter {
  const runtime = new LocalWorkerRuntime(pythonBin);
  const runner = new SandboxToolRunner(runtime);
  return new YosysNetlistSvgAdapter(runner);
}

/**
 * Build the real `ToolchainStructuralGate` over the local worker runtime (task 5.6).
 *
 * ONE RETENTION STORE, SHARED, the same discipline `realFormalAdapter` follows: the
 * `LocalWorkerRuntime` fills a `BoundedArtifactRetention` after the worker finishes and before
 * its workspace goes, and the `YosysCheckLintAdapter` reads the lint report back through that
 * SAME store, so a ref it was handed never resolves against a different store's bytes. The
 * `IcarusSimulatorAdapter` and the `YosysCheckLintAdapter` share one `SandboxToolRunner` too,
 * because both run through the one worker this gate is given.
 *
 * Returned directly as the gate, not wrapped the way `realFormalAdapter` wraps its oracle: a
 * `StructuralGateResult` carries no artifact ref for a caller to resolve later (Req 8.11), so
 * there is no second half a caller would ever need back.
 *
 * Callers MUST gate use on `STRUCTURAL_PROBE.available`; when the toolchain is absent
 * `STRUCTURAL_PROBE.pythonBin` is empty and the gate cannot run.
 */
export function realStructuralGate(pythonBin: string): ToolchainStructuralGate {
  const retention = new BoundedArtifactRetention();
  const runtime = new LocalWorkerRuntime(pythonBin, undefined, retention);
  const toolRunner = new SandboxToolRunner(runtime);
  return new ToolchainStructuralGate({
    toolRunner,
    simulator: new IcarusSimulatorAdapter(toolRunner),
    lint: new YosysCheckLintAdapter(toolRunner, retention),
  });
}

/**
 * The four resource caps a real formal run gets. `wallMs` is absent by construction:
 * the adapter derives it from the remaining Property_Time_Budget on every job.
 *
 * Wider than `netlistsvg`'s because bit-blasting is the expensive part of this chain,
 * and `diskMb` is the widest of the four because every check dumps a VCD trace.
 */
export const FORMAL_CAPS: FormalResourceCaps = { cpu: 1, memMb: 1024, procs: 128, diskMb: 256 };

/**
 * The real Formal_Oracle, together with the store its own artifact refs resolve through.
 *
 * BOTH HALVES ARE HANDED BACK BECAUSE A REFUTATION'S EVIDENCE IS A REF AND NOT BYTES.
 * `PropertyResult`'s `refuted` member carries an `ArtifactBlobRef` - a name, a size, and a
 * SHA-256 - so a caller that wants to check a counterexample is REAL rather than merely
 * PRESENT has to resolve that ref, and the only thing that can is the store the runtime
 * filled. Handing the store back rather than letting the caller build a second one is what
 * keeps ONE object on both sides of the composition: a ref cannot resolve to different bytes
 * depending on who asked for them.
 */
export interface RealFormalOracle {
  /** The oracle under test. Decides one Formal_Property per `prove` call. */
  readonly oracle: YosysSmtBmcFormalOracle;
  /** The SAME store the oracle reads its reports through. Resolves any ref it handed back. */
  readonly artifacts: BoundedArtifactRetention;
  /**
   * The SAME Tool_Runner the oracle submits every job through.
   *
   * Handed back for ONE reason: the Reset_Contract_Prepass derives facts - the reset net, its
   * polarity, its kind, and the Clock_Contract - that `PropertyResult` does not carry, so a test
   * asserting the DERIVED polarity has to submit an `assembleFormalPrepassJob` itself and read the
   * `formalPrepassReport` back. It is the same object rather than a second composition for the
   * reason `artifacts` is: a ref must not resolve to different bytes depending on who asked.
   */
  readonly toolRunner: SandboxToolRunner;
}

/**
 * Build the real Formal_Oracle over the local worker runtime (task 6.2).
 *
 * THE COMPOSITION ROOT FOR ARTIFACT RETENTION, and the reason it has to exist at all.
 * `SandboxResult.artifacts` carries refs and no bytes, and the runtime removes the
 * workspace in a `finally`, so the formal gate - whose whole verdict is a JSON report the
 * worker wrote into that workspace - could not read its own evidence. The resolution is
 * one `BoundedArtifactRetention` handed to BOTH sides: the runtime fills it after the
 * worker finishes and before the workspace goes, and the adapter reads it through the
 * `FormalArtifactReader` port. One object, so there is no second place where a ref could
 * resolve to different bytes, and the seam itself is untouched.
 *
 * The store's lifetime is the returned pair's: it is created here and referenced only by
 * the two collaborators plus the caller, so it is collected with them rather than
 * outliving every caller the way a module-level cache would.
 *
 * Callers MUST gate use on `FORMAL_PROBE.available`; when the toolchain is absent or not
 * invocable `FORMAL_PROBE.pythonBin` is empty and the adapter cannot run.
 */
export function realFormalAdapter(pythonBin: string): RealFormalOracle {
  const retention = new BoundedArtifactRetention();
  const runtime = new LocalWorkerRuntime(pythonBin, undefined, retention);
  const toolRunner = new SandboxToolRunner(runtime);
  return {
    oracle: new YosysSmtBmcFormalOracle({ toolRunner, artifacts: retention, caps: FORMAL_CAPS }),
    artifacts: retention,
    toolRunner,
  };
}

// -- Representative real-oracle fixtures -------------------------------------
//
// A single spec-derived testbench drives the counter RTL variants both the
// oracle-path test (3.8) and the Verification_Loop test (14.2) exercise. It is
// independent of the RTL (it only knows the module interface and the acceptance
// checks), it emits the machine-readable `CHECK <name> PASS|FAIL` signalling the
// Simulator adapter parses, and it writes a VCD waveform (a required output) so a
// completed run is classified functionally rather than as a missing-artifact
// error. Checks are sampled on the falling edge to avoid a race with the DUT's
// non-blocking updates on the rising edge.

/** The trusted module name shared by the counter RTL and its testbench instance. */
export const COUNTER_MODULE_NAME = 'counter';

/** Spec-derived testbench for a 4-bit synchronous up-counter with sync reset. */
export const COUNTER_TESTBENCH = `\`timescale 1ns/1ps
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
export const PASSING_COUNTER_RTL = `module counter (
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
export const BUGGY_COUNTER_RTL = `module counter (
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

// -- Representative schematic fixture (task 15.8) ----------------------------
//
// A small, fully synthesizable combinational module used by the netlistsvg
// schematic integration test. It is deliberately tiny so the real Yosys
// `write_json` + netlistsvg render is quick and its schematic is small enough to
// draw without drill-down, while still exercising gate-level structure (an
// AND/OR/NOT cone plus a multiplexer) rather than a single trivial wire.

/** The module name shared by the schematic RTL fixture. */
export const SCHEMATIC_MODULE_NAME = 'gate_demo';

/**
 * Synthesizable combinational RTL for the schematic path: a 2:1 mux whose data
 * inputs are simple gate expressions, so Yosys emits a small but non-trivial
 * gate-level netlist for netlistsvg to draw.
 */
export const SCHEMATIC_RTL = `module gate_demo (
  input  wire a,
  input  wire b,
  input  wire c,
  input  wire sel,
  output wire y
);
  wire and_term;
  wire or_term;

  assign and_term = a & b;
  assign or_term  = b | c;
  assign y        = sel ? and_term : or_term;
endmodule
`;
