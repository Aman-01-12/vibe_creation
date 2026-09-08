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
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  IcarusSimulatorAdapter,
  LocalWorkerRuntime,
  SandboxToolRunner,
  WORKER_SOURCE_ROOT,
  YosysNetlistSvgAdapter,
} from '@app/tools';

// -- Locations --------------------------------------------------------------

/** This module's directory, resolved from its module URL. */
const HERE = dirname(fileURLToPath(import.meta.url));

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

/** The single, module-load-time probe consumers gate their real-oracle suites on. */
export const PROBE: OracleProbe = probeRealOracle();

/** The module-load-time probe consumers gate their real-synth suites on (task 15.8). */
export const SYNTH_PROBE: OracleProbe = probeRealSynth();

/**
 * The worker-capable Python interpreter, or null when none is available.
 *
 * Exposed so the synth fail-safe suite can exercise the REAL worker seam (the
 * degrade-to-`unavailable` path) even in an environment that has the worker Python
 * but not yosys/netlistsvg, keeping that assertion non-vacuous.
 */
export const WORKER_PYTHON: string | null = WORKER_PYTHON_BIN;

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
