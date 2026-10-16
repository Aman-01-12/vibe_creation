// The Default_Timescale_Probe's three outcomes over a fake simulator (testbench-spec-grounding).

import { describe, expect, it } from 'vitest';

import type { ResourceLimits, SourceFile } from '../sandbox/contract.js';
import type { SimulationVerdict, SimulatorAdapter, TestbenchRun } from './adapter.js';
import { probeDefaultTimescale } from './default-timescale-probe.js';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 32, diskMb: 128, wallMs: 30_000 };

function verdict(overrides: Partial<SimulationVerdict>): SimulationVerdict {
  return {
    verdict: 'pass',
    checks: [],
    vcd: null,
    stdout: '',
    stderr: '',
    exitCode: 0,
    resourceUsage: { wallMs: 1, maxMemMb: 1, cpuMs: 1 },
    failureCause: 'none',
    attributedFiles: [],
    watchdog: { stopped: false },
    ...overrides,
  };
}

class FakeSimulator implements SimulatorAdapter {
  readonly runs: (TestbenchRun | undefined)[] = [];
  readonly testbenches: SourceFile[] = [];
  constructor(private readonly answer: SimulationVerdict) {}
  simulate(
    _rtl: readonly SourceFile[],
    testbench: SourceFile,
    _limits: ResourceLimits,
    testbenchRun?: TestbenchRun,
  ): Promise<SimulationVerdict> {
    this.runs.push(testbenchRun);
    this.testbenches.push(testbench);
    return Promise.resolve(this.answer);
  }
}

describe('probeDefaultTimescale', () => {
  it('is honored on a pass, and runs an untimescaled fixture as a Testbench_Run', async () => {
    const simulator = new FakeSimulator(verdict({ verdict: 'pass' }));
    await expect(probeDefaultTimescale(simulator, LIMITS)).resolves.toBe('honored');
    expect(simulator.runs).toEqual([{ requiredCheckNames: ['default_timescale_probe'] }]);
    // No `timescale` DIRECTIVE, so the unit comes from the entry (the module name has the word).
    expect(simulator.testbenches[0]?.contents).not.toMatch(/^\s*`timescale/mu);
    expect(simulator.testbenches[0]?.contents).toContain('#1000;');
  });

  it('is not-honored when the Watchdog ended the run', async () => {
    const stopped = verdict({
      verdict: 'fail',
      watchdog: { stopped: true, timedOutChecks: ['default_timescale_probe'] },
    });
    await expect(probeDefaultTimescale(new FakeSimulator(stopped), LIMITS)).resolves.toBe(
      'not-honored',
    );
  });

  it('is unavailable on an error, or a fail the Watchdog did not cause', async () => {
    const errored = new FakeSimulator(verdict({ verdict: 'error', failureCause: 'tool-failed' }));
    await expect(probeDefaultTimescale(errored, LIMITS)).resolves.toBe('unavailable');
    const failed = new FakeSimulator(verdict({ verdict: 'fail' }));
    await expect(probeDefaultTimescale(failed, LIMITS)).resolves.toBe('unavailable');
  });
});
