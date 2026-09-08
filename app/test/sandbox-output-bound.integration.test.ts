// Real-toolchain integration test for the Tool_Runner's OUTPUT BOUND.
//
// This is the end-to-end counterpart to the worker's own pytest cases (which use a
// synthetic high-volume child) and to the mock-only verdict tests. It drives the
// REAL `iverilog` + `vvp` through the settled seam and asserts the two halves of
// the fix for a measured resource-exhaustion defect:
//
//   1. THE BOUND. The worker used to buffer a child's entire stdout in memory.
//      Reproduced on a developer machine against a non-terminating simulation with
//      a 5s cap: 55.9 MB buffered in 5.03s (11.1 MB/s), projecting to ~333 MB per
//      run at the 30s cap the real-oracle path uses; a faster machine measured
//      114 MB in 5.07s (21.5 MB/s), ~654 MB at 30s. `ResourceLimits.memMb` caps
//      the sandboxed child, not the worker's own buffer of its output, so
//      concurrent sessions multiplied it into an out-of-memory vector.
//   2. THE CORRECTNESS HALF. Bounded output must never read as a pass: a
//      `CHECK ... FAIL` line may sit in the bytes that were discarded.
//
// WHY THE BOUND IS ASSERTED BY DOUBLING THE CAP RATHER THAN AGAINST A CONSTANT
//   The retention caps are worker-internal by design (a cap a caller can raise is
//   not a bound), so pinning their exact values here would duplicate a Python
//   constant in TypeScript and drift. Instead this asserts the PROPERTY: run the
//   same runaway design at two wall caps and the retained output must not grow.
//   Unbounded buffering is linear in run time - double the cap, double the buffer -
//   so that single comparison fails loudly if the bound is ever removed, whatever
//   the cap happens to be.
//
// GATING
//   Same mechanism as every other real-oracle suite: `describe.skipIf(!PROBE
//   .available)` over the shared module-load probe in `./real-oracle-harness`, so a
//   toolchain-less CI skips cleanly instead of failing spuriously. Wall caps are
//   kept to a couple of seconds so the suite stays fast.

import { spawn } from 'node:child_process';

import {
  readCheckSignals,
  WORKER_SOURCE_ROOT,
  type ResourceLimits,
  type SandboxJob,
  type SimulationVerdict,
  type SourceFile,
} from '@app/tools';
import { describe, expect, it } from 'vitest';

import {
  COUNTER_MODULE_NAME,
  PASSING_COUNTER_RTL,
  PROBE,
  realOracleAdapter,
} from './real-oracle-harness.js';

// -- Caps and ceilings -------------------------------------------------------

/** The short wall cap for the runaway runs (ms). Kept small so the suite is fast. */
const SHORT_WALL_MS = 1_500;

/** The doubled wall cap. An unbounded capture would retain ~2x the short run's. */
const DOUBLED_WALL_MS = 3_000;

/** Wall cap for the runs that terminate on their own (ms). */
const TERMINATING_WALL_MS = 20_000;

/**
 * A ceiling the worker's report must stay under, in bytes.
 *
 * Deliberately loose: it is an ORDER-OF-MAGNITUDE assertion, not a restatement of
 * the worker's caps. It sits comfortably above them (which total a little over a
 * mebibyte plus JSON overhead) and far below the volume an unbounded capture
 * reaches at these wall caps (>= 16 MB at the measured 11 MB/s floor).
 */
const MAX_REPORT_BYTES = 8 * 1024 * 1024;

/**
 * How much of the worker's stdout this TEST retains.
 *
 * The test applies the same discipline it is asserting: if the bound under test
 * were removed, the report would be tens of megabytes, and a test that buffered
 * all of it to measure it would be the same defect one layer up. Bytes are COUNTED
 * in full and retained only up to here, so the size assertions stay exact while
 * the test's own memory is bounded.
 */
const TEST_RETENTION_BYTES = 4 * 1024 * 1024;

/** Vitest per-test timeout for the two-run doubling comparison (ms). */
const DOUBLING_TIMEOUT = 60_000;

/** Vitest per-test timeout for one real compile-and-simulate (ms). */
const RUN_TIMEOUT = 60_000;

/** How many noisy monitor lines the flooding-but-terminating testbench prints. */
const FLOOD_LINE_COUNT = 40_000;

/**
 * A conservative floor on the bytes the flooding testbench actually prints.
 *
 * Each monitor line is comfortably over 40 bytes, so 40,000 of them exceed this.
 * Retained output below this floor is therefore proof that bytes were dropped,
 * without restating the worker's internal cap.
 */
const MIN_FLOOD_OUTPUT_BYTES = FLOOD_LINE_COUNT * 40;

// -- Fixtures ----------------------------------------------------------------

/** Generous resource caps; only `wallMs` varies between the cases below. */
function limits(wallMs: number): ResourceLimits {
  return { cpu: 1, memMb: 512, procs: 128, diskMb: 256, wallMs };
}

/**
 * A testbench that never finishes, printing one monitor line per clock edge.
 *
 * This is the measured defect's own shape: a wait condition that never becomes
 * true, which is the normal consequence of RTL that never asserts what the
 * testbench is waiting on. It deliberately writes NO waveform - an unbounded
 * `$dumpvars` would grow a file on disk for as long as the run lasts, and the
 * waveform is irrelevant to the memory bound under test here.
 */
const NON_TERMINATING_TESTBENCH = `\`timescale 1ns/1ps
module counter_tb;
  reg clk;
  reg rst;
  wire [3:0] count;

  counter dut (.clk(clk), .rst(rst), .count(count));

  initial clk = 1'b0;
  always #5 clk = ~clk;

  initial begin
    rst = 1'b0;
    forever @(posedge clk)
      $display("monitor time=%0t count=%b rst=%b still waiting for done", $time, count, rst);
  end
endmodule
`;

/**
 * A testbench that signals its checks, then floods, then finishes normally.
 *
 * The checks are printed FIRST, so they survive in the retained prefix and the run
 * looks entirely clean to the reader - which is precisely why truncation has to
 * force a non-pass. `lineCount` controls whether the run overruns the worker's
 * stdout cap, so the same fixture produces both the truncated and the untruncated
 * case and the contrast between them is non-vacuous.
 */
function floodingTestbench(lineCount: number): string {
  return `\`timescale 1ns/1ps
module counter_tb;
  reg clk;
  reg rst;
  wire [3:0] count;
  integer i;

  counter dut (.clk(clk), .rst(rst), .count(count));

  initial clk = 1'b0;
  always #5 clk = ~clk;

  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, counter_tb);

    rst = 1'b1;
    @(posedge clk);
    @(negedge clk);
    if (count === 4'd0)
      $display("CHECK reset_clears_output PASS");
    else
      $display("CHECK reset_clears_output FAIL");

    rst = 1'b0;
    @(posedge clk);
    @(posedge clk);
    @(posedge clk);
    @(negedge clk);
    if (count === 4'd3)
      $display("CHECK counts_up PASS");
    else
      $display("CHECK counts_up FAIL");

    for (i = 0; i < ${lineCount}; i = i + 1) begin
      @(posedge clk);
      $display("monitor cycle=%0d time=%0t count=%b rst=%b payload=%h", i, $time, count, rst, i);
    end

    $finish;
  end
endmodule
`;
}

/** One runaway simulate job for the worker, at the given wall cap. */
function runawayJob(wallMs: number): SandboxJob {
  return {
    kind: 'simulate',
    workspaceFiles: [
      { path: `${COUNTER_MODULE_NAME}.v`, contents: PASSING_COUNTER_RTL },
      { path: `${COUNTER_MODULE_NAME}_tb.v`, contents: NON_TERMINATING_TESTBENCH },
    ],
    limits: limits(wallMs),
    requiredOutputs: ['stdout', 'exitCode'],
  };
}

// -- Driving the real worker process -----------------------------------------

/** What one direct worker invocation reported, measured rather than parsed whole. */
interface WorkerRun {
  /** Total bytes the worker wrote on stdout, counted in full. */
  readonly reportBytes: number;
  /** Whether the worker flagged its captured stdout as a bounded prefix. */
  readonly stdoutTruncated: boolean;
  /** Bytes of the run's captured stdout inside the report. */
  readonly capturedStdoutBytes: number;
  /** The tool exit code the worker reported. */
  readonly exitCode: number | null;
}

/** Read the truncation flag and captured-stdout size out of a worker report. */
function measureReport(raw: string): Omit<WorkerRun, 'reportBytes'> {
  const parsed: unknown = JSON.parse(raw);
  const record = parsed as {
    stdout?: unknown;
    stdoutTruncated?: unknown;
    exitCode?: unknown;
  };
  const stdout = typeof record.stdout === 'string' ? record.stdout : '';
  return {
    stdoutTruncated: record.stdoutTruncated === true,
    capturedStdoutBytes: Buffer.byteLength(stdout, 'utf8'),
    exitCode: typeof record.exitCode === 'number' ? record.exitCode : null,
  };
}

/**
 * Run one job through the REAL worker process and measure what it reported.
 *
 * Deliberately spawned directly rather than through `LocalWorkerRuntime`: that
 * runtime enforces the same `wallMs` with its own kill timer, so for a
 * non-terminating child it would always fire first and discard the report this test
 * exists to measure. The same interpreter and `PYTHONPATH` wiring is used, so the
 * worker, the contract, and the real toolchain are all the production ones.
 *
 * A safety timer well above the job's own cap guarantees the test cannot hang even
 * if the bound under test is broken.
 */
function runWorkerDirectly(job: SandboxJob, pythonBin: string): Promise<WorkerRun> {
  return new Promise<WorkerRun>((resolvePromise, rejectPromise) => {
    const child = spawn(pythonBin, ['-m', 'tool_runner_worker'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONPATH: WORKER_SOURCE_ROOT },
    });

    let reportBytes = 0;
    let retained = '';
    const safetyTimer = setTimeout(
      () => {
        child.kill('SIGKILL');
      },
      job.limits.wallMs * 4 + 20_000,
    );

    child.stdout.on('data', (chunk: Buffer) => {
      reportBytes += chunk.byteLength;
      if (retained.length < TEST_RETENTION_BYTES) {
        retained += chunk.toString('utf8');
      }
    });
    child.on('error', rejectPromise);
    child.on('close', () => {
      clearTimeout(safetyTimer);
      if (reportBytes > TEST_RETENTION_BYTES) {
        // The bound is broken; report the measurement rather than trying to parse a
        // report this test deliberately refused to hold in full.
        resolvePromise({
          reportBytes,
          stdoutTruncated: false,
          capturedStdoutBytes: reportBytes,
          exitCode: null,
        });
        return;
      }
      resolvePromise({ reportBytes, ...measureReport(retained) });
    });

    child.stdin.end(JSON.stringify(job));
  });
}

/** Compile and simulate one RTL + testbench pair through the settled real-oracle seam. */
function simulatePair(testbench: string, wallMs: number): Promise<SimulationVerdict> {
  const rtl: SourceFile = { path: `${COUNTER_MODULE_NAME}.v`, contents: PASSING_COUNTER_RTL };
  const testbenchFile: SourceFile = {
    path: `${COUNTER_MODULE_NAME}_tb.v`,
    contents: testbench,
  };
  return realOracleAdapter().simulate([rtl], testbenchFile, limits(wallMs));
}

// -- Tests -------------------------------------------------------------------

if (!PROBE.available) {
  console.warn(
    `[sandbox-output-bound.integration] Real-toolchain output-bound assertions NOT ` +
      `exercised: ${PROBE.reason}. The bound is still asserted against a synthetic ` +
      `high-volume child by the worker's pytest suite.`,
  );
}

describe.skipIf(!PROBE.available)(
  'Tool_Runner output bound against the real toolchain (iverilog + vvp)',
  () => {
    it(
      'bounds the retained output of a non-terminating simulation, and does not grow it with the wall cap',
      async () => {
        const short = await runWorkerDirectly(runawayJob(SHORT_WALL_MS), PROBE.pythonBin);
        const doubled = await runWorkerDirectly(runawayJob(DOUBLED_WALL_MS), PROBE.pythonBin);

        // Both runs really did overrun: the flood was stopped by the cap, not by the
        // simulation ending, so neither case is vacuous.
        expect(short.stdoutTruncated).toBe(true);
        expect(doubled.stdoutTruncated).toBe(true);
        expect(short.exitCode).not.toBe(0);
        expect(doubled.exitCode).not.toBe(0);

        // THE BOUND: doubling the wall cap doubles how much a runaway child writes,
        // so an unbounded capture would retain about twice as much. It must not.
        expect(doubled.capturedStdoutBytes).toBeLessThanOrEqual(short.capturedStdoutBytes);
        expect(doubled.reportBytes).toBeLessThan(MAX_REPORT_BYTES);
        expect(short.reportBytes).toBeLessThan(MAX_REPORT_BYTES);
      },
      DOUBLING_TIMEOUT,
    );

    it(
      'refuses a pass for a real run whose retained checks all passed but whose output was truncated',
      async () => {
        const verdict = await simulatePair(
          floodingTestbench(FLOOD_LINE_COUNT),
          TERMINATING_WALL_MS,
        );

        // The retained output really does read as a clean run: every CHECK line in
        // it passed and none failed, so this is the exact shape that used to be
        // reported `pass`.
        const retained = readCheckSignals(verdict.stdout);
        expect(retained.checks.length).toBeGreaterThan(0);
        expect(retained.checks.every((check) => check.passed)).toBe(true);
        expect(retained.unreadableSignals).toBe(0);

        // And it really was truncated rather than failing some other way: the
        // waveform WAS captured, which rules out the timeout, infrastructure, and
        // missing-artifact routes to `error` - they all yield a null waveform. The
        // simulation also printed far more than was retained.
        expect(verdict.vcd).not.toBeNull();
        expect(Buffer.byteLength(verdict.stdout, 'utf8')).toBeLessThan(MIN_FLOOD_OUTPUT_BYTES);

        // The correctness half: a `CHECK ... FAIL` line may be among the discarded
        // bytes, and the retained prefix cannot rule it out.
        expect(verdict.verdict).toBe('error');
      },
      RUN_TIMEOUT,
    );

    it(
      'still returns pass for the same design when its output fits under the bound',
      async () => {
        // The contrast that makes the case above non-vacuous, and the guarantee that
        // normal-sized runs are unaffected by the bound.
        const verdict = await simulatePair(floodingTestbench(10), TERMINATING_WALL_MS);

        expect(verdict.verdict).toBe('pass');
        expect(verdict.checks.every((check) => check.passed)).toBe(true);
        expect(verdict.vcd).not.toBeNull();
      },
      RUN_TIMEOUT,
    );
  },
);
