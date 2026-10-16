// The Testbench_Precheck runs a model-written testbench as a Testbench_Run, and a Watchdog stop
// reads to it as any finished run (testbench-spec-grounding, C9, Req 5.8).

import { describe, expect, it } from 'vitest';

import { TestbenchPrecheck } from '@app/agent';
import type { ModuleInterface } from '@app/core';
import type {
  ResourceLimits,
  SimulationVerdict,
  SimulatorAdapter,
  SourceFile,
  TestbenchRun,
} from '@app/tools';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 32, diskMb: 128, wallMs: 30_000 };

const IFACE: ModuleInterface = {
  validityOutputName: null,
  moduleName: 'dut',
  ports: [
    { name: 'clk', direction: 'input', width: 1 },
    { name: 'q', direction: 'output', width: 4 },
  ],
  clocking: { clockName: 'clk', resetName: null, resetActiveLow: false },
};

/** A verdict the Watchdog ended: compiled, one check printed, one timed out. */
const WATCHDOG_VERDICT: SimulationVerdict = {
  verdict: 'fail',
  checks: [
    { name: 'a_ok', passed: true },
    { name: 'b_ok', passed: false },
  ],
  vcd: null,
  stdout: 'CHECK a_ok PASS\nECE_WATCHDOG_TIMEOUT\n',
  stderr: '',
  exitCode: 0,
  resourceUsage: { wallMs: 1, maxMemMb: 1, cpuMs: 1 },
  failureCause: 'none',
  attributedFiles: [],
  watchdog: { stopped: true, timedOutChecks: ['b_ok'] },
};

class RecordingSimulator implements SimulatorAdapter {
  readonly runs: (TestbenchRun | undefined)[] = [];
  simulate(
    _rtl: readonly SourceFile[],
    _testbench: SourceFile,
    _limits: ResourceLimits,
    testbenchRun?: TestbenchRun,
  ): Promise<SimulationVerdict> {
    this.runs.push(testbenchRun);
    return Promise.resolve(WATCHDOG_VERDICT);
  }
}

describe('the Testbench_Precheck as a Testbench_Run caller', () => {
  it('passes a TestbenchRun and decides a Watchdog stop as a finished run', async () => {
    const simulator = new RecordingSimulator();
    const precheck = new TestbenchPrecheck(simulator);

    const outcome = await precheck.run(
      { path: 'tb.v', contents: 'module tb; endmodule' },
      IFACE,
      LIMITS,
    );

    expect(outcome).toBe('undecided');
    expect(simulator.runs).toEqual([{ requiredCheckNames: [] }]);
  });
});
