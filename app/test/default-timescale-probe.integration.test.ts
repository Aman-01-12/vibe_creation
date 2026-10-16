// The Default_Timescale_Entry on the REAL local worker (testbench-spec-grounding, C11).
//
// Two directions, because a probe that cannot fail proves nothing: with the entry the
// untimescaled fixture's `#1000` is 1000 ns and the check prints; with the entry stripped out
// of the job it is 1000 s, the Watchdog fires first, and the reader fails the unprinted check.

import { describe, expect, it } from 'vitest';

import {
  IcarusSimulatorAdapter,
  LocalWorkerRuntime,
  SandboxToolRunner,
  probeDefaultTimescale,
  type ResourceLimits,
  type SandboxJob,
  type SandboxResult,
  type ToolRunner,
} from '@app/tools';

import { PROBE } from './real-oracle-harness.js';

/** The Campaign's own caps: the 30 s wall the Watchdog_Budget is half of. */
const LIMITS: ResourceLimits = { cpu: 1, memMb: 2048, procs: 64, diskMb: 128, wallMs: 30_000 };

/** A runner that drops the `simulate` payload, modelling a host that ignores the entry. */
class EntryStrippingRunner implements ToolRunner {
  constructor(private readonly inner: ToolRunner) {}
  run(job: SandboxJob): Promise<SandboxResult> {
    const withoutEntry: SandboxJob = {
      kind: job.kind,
      workspaceFiles: job.workspaceFiles,
      limits: job.limits,
      requiredOutputs: job.requiredOutputs,
    };
    return this.inner.run(withoutEntry);
  }
}

function realRunner(): SandboxToolRunner {
  return new SandboxToolRunner(new LocalWorkerRuntime(PROBE.pythonBin));
}

if (!PROBE.available) {
  console.warn(
    `[default-timescale-probe] SKIPPED - the entry is NOT checked here: ${PROBE.reason}`,
  );
}

describe.skipIf(!PROBE.available)('the Default_Timescale_Entry on the local worker', () => {
  it('is honored, so an untimescaled testbench runs in the 1 ns base', async () => {
    const adapter = new IcarusSimulatorAdapter(realRunner());

    await expect(probeDefaultTimescale(adapter, LIMITS)).resolves.toBe('honored');
  }, 120_000);

  it('is not-honored when the job carries no entry, and the Watchdog ends the run', async () => {
    const adapter = new IcarusSimulatorAdapter(new EntryStrippingRunner(realRunner()));

    await expect(probeDefaultTimescale(adapter, LIMITS)).resolves.toBe('not-honored');
  }, 120_000);
});
