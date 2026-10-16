// The Check_Report_Task on the REAL Icarus toolchain (testbench-failure-reportability, C1, C2).
// The claim under test is the toolchain's: that a testbench compiled as a separate input can
// call a task declared in the uninstantiated harness root, and that its lines read back as checks.

import { describe, expect, it } from 'vitest';

import {
  CHECK_REPORT_TASK_PATH,
  IcarusSimulatorAdapter,
  LocalWorkerRuntime,
  SandboxToolRunner,
  readCheckSignals,
  type ResourceLimits,
  type SimulationVerdict,
} from '@app/tools';

import { PROBE } from './real-oracle-harness.js';

/** The Campaign's caps, matching the sibling Simulation_Harness integration test. */
const LIMITS: ResourceLimits = { cpu: 1, memMb: 2048, procs: 64, diskMb: 128, wallMs: 30_000 };

/** A trivial DUT, so every claim below is about the harness task and not about a design. */
const DUT = { path: 'dut.v', contents: 'module dut(input wire clk);\nendmodule\n' };

/** One call per case, in emission order: FAIL, PASS, a 65-bit FAIL, and an `x` actual. */
const CALLS = [
  `${CHECK_REPORT_TASK_PATH}("ac1_reset_clears_output", 8'h0b, a);`,
  `${CHECK_REPORT_TASK_PATH}("ac2_sum_is_a_plus_b", 8'h0f, a + b);`,
  `${CHECK_REPORT_TASK_PATH}("ac3_wide_sum", 65'h1_0000_0000_0000_0000, wide_sum);`,
  `${CHECK_REPORT_TASK_PATH}("ac4_unknown_actual", 8'h05, unknown);`,
] as const;

const REQUIRED_CHECK_NAMES = [
  'ac1_reset_clears_output',
  'ac2_sum_is_a_plus_b',
  'ac3_wide_sum',
  'ac4_unknown_actual',
] as const;

/** `unknown` is never assigned, so it holds `x` when the fourth call reads it. */
const CALLING_TB = [
  'module tb;',
  "  reg [7:0] a = 8'h0a;",
  "  reg [7:0] b = 8'h05;",
  '  reg [64:0] wide_sum;',
  '  reg [7:0] unknown;',
  '  initial begin',
  "    wide_sum = {1'b0, 64'hffff_ffff_ffff_ffff};",
  '    #1;',
  ...CALLS.map((call) => `    ${call}`),
  '    $finish;',
  '  end',
  'endmodule',
  '',
].join('\n');

function run(): Promise<SimulationVerdict> {
  const adapter = new IcarusSimulatorAdapter(
    new SandboxToolRunner(new LocalWorkerRuntime(PROBE.pythonBin)),
  );
  return adapter.simulate([DUT], { path: 'tb.v', contents: CALLING_TB }, LIMITS, {
    requiredCheckNames: REQUIRED_CHECK_NAMES,
  });
}

if (!PROBE.available) {
  console.warn(`[check-report-task] SKIPPED - the task is NOT exercised here: ${PROBE.reason}`);
}

describe.skipIf(!PROBE.available)('the Check_Report_Task on real Icarus', () => {
  it('prints one readable line per hierarchical call (Req 1.2, 1.3, 1.7, 2.1, 2.2, 2.5)', async () => {
    const verdict = await run();

    expect(verdict.failureCause).toBe('none');
    const printed = verdict.stdout.split('\n').filter((line) => line.startsWith('CHECK '));
    expect(printed).toEqual([
      'CHECK ac1_reset_clears_output FAIL: expected b, got a',
      'CHECK ac2_sum_is_a_plus_b PASS',
      'CHECK ac3_wide_sum FAIL: expected 10000000000000000, got ffffffffffffffff',
      'CHECK ac4_unknown_actual FAIL: expected 5, got xx',
    ]);
    // The shipped reader over the real stdout, not over a line we formatted ourselves.
    expect(readCheckSignals(verdict.stdout)).toEqual({
      checks: [
        { name: 'ac1_reset_clears_output', passed: false },
        { name: 'ac2_sum_is_a_plus_b', passed: true },
        { name: 'ac3_wide_sum', passed: false },
        { name: 'ac4_unknown_actual', passed: false },
      ],
      unreadableSignals: 0,
    });
    expect(verdict.verdict).toBe('fail');
  }, 120_000);
});
