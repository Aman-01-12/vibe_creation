// The Default_Timescale_Probe (testbench-spec-grounding, C11): whether the runtime this adapter
// is wired to honours the Default_Timescale_Entry, tested through the harness and reader it
// protects. Honoured, `#1000` is 1000 ns; not honoured, it is 1000 s and the Watchdog fires.

import type { ResourceLimits } from '../sandbox/contract.js';
import type { SimulatorAdapter } from './adapter.js';

export type DefaultTimescaleProbeOutcome = 'honored' | 'not-honored' | 'unavailable';

/** The one Required_Check the probe fixture prints. */
export const DEFAULT_TIMESCALE_PROBE_CHECK = 'default_timescale_probe';

/** A testbench with no `timescale`, so its delay unit comes from the entry or the default. */
const PROBE_FIXTURE = {
  path: 'ece_default_timescale_probe.v',
  contents: [
    'module ece_default_timescale_probe;',
    '  initial begin',
    '    #1000;',
    `    $display("CHECK ${DEFAULT_TIMESCALE_PROBE_CHECK} PASS");`,
    '    $finish;',
    '  end',
    'endmodule',
    '',
  ].join('\n'),
} as const;

/** Runs the untimescaled probe fixture with the harness and the entry; pure over the port. */
export async function probeDefaultTimescale(
  simulator: SimulatorAdapter,
  limits: ResourceLimits,
): Promise<DefaultTimescaleProbeOutcome> {
  const verdict = await simulator.simulate([], PROBE_FIXTURE, limits, {
    requiredCheckNames: [DEFAULT_TIMESCALE_PROBE_CHECK],
  });
  if (verdict.verdict === 'pass') {
    return 'honored';
  }
  return verdict.verdict === 'fail' && verdict.watchdog.stopped ? 'not-honored' : 'unavailable';
}
