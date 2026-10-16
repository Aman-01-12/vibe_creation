// DQ-01 A, Req 4.12: the PRODUCTION sandbox image's Icarus honours the Default_Timescale_Entry.
//
// The entry was measured on this host's Icarus 13.0, which is not the image's. Nothing else
// checks the image, so without this suite "the Campaign host honours the entry" is an
// assumption. The Campaign's own preflight runs the same probe on its own runtime.
//
// WHERE NO REAL RUNTIME EXISTS the suite SKIPS with the first missing piece named, so a skip is
// never read as a pass: `runsc` cannot run on macOS, so this host always skips.

import { describe, expect, it } from 'vitest';

import { RunscSandboxRuntime, SandboxToolRunner } from '../sandbox/index.js';
import type { ResourceLimits } from '../sandbox/index.js';
import { detectSandboxRuntime } from '../sandbox/runsc-capability.js';
import { IcarusSimulatorAdapter } from './adapter.js';
import { probeDefaultTimescale } from './default-timescale-probe.js';

const PROBE = detectSandboxRuntime();

if (!PROBE.available) {
  console.warn(
    `[default-timescale-image] SKIPPED - the production image's default timescale is NOT ` +
      `checked here: ${PROBE.reason}.`,
  );
}

/** The Campaign's own sandbox caps, so the probe runs the budget the Campaign runs. */
const LIMITS: ResourceLimits = { cpu: 1, memMb: 2048, procs: 64, diskMb: 128, wallMs: 30_000 };

describe.skipIf(!PROBE.available)(
  'the production sandbox image honours the Default_Timescale',
  () => {
    it('runs an untimescaled testbench in the 1 ns base the entry requests', async () => {
      const runner = new SandboxToolRunner(
        new RunscSandboxRuntime(PROBE.cli, PROBE.image),
        PROBE.image,
      );

      const outcome = await probeDefaultTimescale(new IcarusSimulatorAdapter(runner), LIMITS);

      expect(outcome).toBe('honored');
    }, 120_000);
  },
);
