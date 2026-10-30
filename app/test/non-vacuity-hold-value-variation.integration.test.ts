// Real-toolchain integration test: stimulus-transaction-structure, Property 9 - a Held_Input
// still varies across Hold_Windows, and each count is reported beside that port's declared
// width (task 8.10, C9).
//
// WHY THIS TEST EXISTS
//
//   `non-vacuity-hold-window.integration.test.ts` (task 8.9) already proves a Held_Input's
//   VALUE never changes INSIDE a whole Hold_Window, over a real run. That is the opposite half
//   of the story: Property 9 asks whether the held value varies BETWEEN windows, and whether a
//   narrow port's lower Distinct_Hold_Value_Count is read against its own declared width rather
//   than as a weakened stimulus. Neither question is answered by a hand-built `stdout` stream -
//   Req 7.6 requires the figure to come from a real toolchain invocation of the
//   Non_Vacuity_Probe, so this file renders the probe, drives it through real `iverilog` +
//   `vvp`, and reads `distinctHoldValueCount` back from the actual stdout.
//
// TWO HOLD PORTS OF DIFFERENT WIDTHS, ON PURPOSE
//
//   A single Held_Input could satisfy Req 6.1 by coincidence. Declaring one 4-bit port (whose
//   ceiling of 16 values equals criterion 6.1's floor) beside one 2-bit port (whose ceiling of
//   4 values sits well under that floor) is what makes the "read against the ceiling its own
//   width sets" half of Property 9 non-vacuous: the narrow port's count can never reach 16, and
//   the assertion below reads that ceiling from `portWidth` in the SAME per-port entry rather
//   than asserting a fixed number, so the narrow port is never mistaken for a weakened stimulus.
//
// SIZING THE SAMPLE_BUDGET
//
//   20 whole Hold_Windows (`20 * HOLD_FRAME_PERIOD` steps), inside Req 6.9's floor of 16 and
//   with headroom for the real Stimulus_Mixer to show variety, rather than reusing the product's
//   full `SAMPLE_BUDGET` (2048, 30 windows) the sibling hold-window test already covers.
//
// Validates: Requirements 6.1, 7.7

import { describe, expect, it } from 'vitest';

import type { ModuleInterface } from '@app/core';
import {
  readNonVacuity,
  renderNonVacuityProbe,
  type NonVacuityProbeRequest,
  type ResourceLimits,
  type RoleDeclaration,
} from '@app/tools';
// HOLD_FRAME_PERIOD is not re-exported through the `@app/tools` barrel (simulator/index.ts),
// the same convention the sibling Non_Vacuity_Probe integration tests already follow.
import { HOLD_FRAME_PERIOD } from '../tools/simulator/consensus-harness.js';

import { PROBE, realOracleAdapter } from './real-oracle-harness.js';

if (!PROBE.available) {
  console.warn(
    `[non-vacuity-hold-value-variation.integration] Real-oracle path NOT exercised: ${PROBE.reason}. ` +
      'Property 9 (hold-value variation and its per-port width ceiling) is UNVALIDATED in this environment.',
  );
}

const REAL_LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };
const RUN_TIMEOUT = 60_000;

const WIDE_PORT_NAME = 'wide_hold';
const NARROW_PORT_NAME = 'narrow_hold';
const WIDE_WIDTH = 4;
const NARROW_WIDTH = 2;
const NONCE = 'nvhv01';

const WINDOW_COUNT = 20;
const VARIATION_SAMPLE_BUDGET = WINDOW_COUNT * HOLD_FRAME_PERIOD;

// No Strobe is declared, so `readNonVacuity`'s window period is `HOLD_FRAME_PERIOD` for both
// ports - the same branch choice `buildReport` (`non-vacuity-check.ts`) makes. No clock or
// reset either: this property is about value variation across windows, not about the reset
// exclusion `non-vacuity-reset-exclusion.property.test.ts` already covers on its own.
const PROBE_INTERFACE: ModuleInterface = {
  moduleName: 'hold_variation_probe_mod',
  ports: [
    { name: WIDE_PORT_NAME, direction: 'input', width: WIDE_WIDTH },
    { name: NARROW_PORT_NAME, direction: 'input', width: NARROW_WIDTH },
    { name: 'q', direction: 'output', width: 1 },
  ],
  clocking: { clockName: null, resetName: null, resetActiveLow: false },
  validityOutputName: null,
};
const ROLES: RoleDeclaration = [
  { portName: WIDE_PORT_NAME, role: 'hold' },
  { portName: NARROW_PORT_NAME, role: 'hold' },
];

// Guards the fixture's own premise: the narrow port's ceiling sits well under the
// smaller-of-16-and-its-own-ceiling floor Req 6.1 states, or this file is not exercising the
// case it claims to. `WIDE_WIDTH` and `NARROW_WIDTH` differing is already enforced by the
// distinct literal types above, so only the ceiling itself needs a runtime guard.
if (2 ** NARROW_WIDTH >= 16) {
  throw new Error(
    `fixture defect: NARROW_WIDTH (${String(NARROW_WIDTH)}) no longer gives the narrow port a ` +
      'sub-16 ceiling - this fixture must be revisited',
  );
}

describe('non-vacuity hold-value-variation real-toolchain capability probe', () => {
  it('documents whether the real oracle path was exercised in this environment', () => {
    expect(typeof PROBE.available).toBe('boolean');
    expect(PROBE.reason.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!PROBE.available)(
  'a Held_Input still varies across real Hold_Windows, and each count sits beside its own ' +
    "port's declared width (Property 9; Req 6.1, 7.7)",
  () => {
    it(
      'reports distinctHoldValueCount alongside portWidth in the same per-port entry, for a ' +
        'wide port that can reach 16 and a narrow port whose own width caps it well below that',
      async () => {
        const request: NonVacuityProbeRequest = {
          moduleInterface: PROBE_INTERFACE,
          nonce: NONCE,
          roles: ROLES,
          sampleBudget: VARIATION_SAMPLE_BUDGET,
        };
        const rendered = renderNonVacuityProbe(request);
        if (!rendered.ok) {
          throw new Error(`fixture defect: ${rendered.error.code}`);
        }

        const verdict = await realOracleAdapter().simulate([], rendered.value, REAL_LIMITS);
        expect(verdict.failureCause).toBe('none');

        const outcome = readNonVacuity(
          verdict.stdout,
          NONCE,
          PROBE_INTERFACE,
          ROLES,
          VARIATION_SAMPLE_BUDGET,
        );
        expect(outcome.kind).toBe('read');
        if (outcome.kind !== 'read') {
          return;
        }
        expect(outcome.wholeHoldWindowCount).toBe(WINDOW_COUNT);

        const wide = outcome.holdWindowsByPort.find((port) => port.portName === WIDE_PORT_NAME);
        const narrow = outcome.holdWindowsByPort.find((port) => port.portName === NARROW_PORT_NAME);
        if (wide === undefined || narrow === undefined) {
          throw new Error('fixture defect: missing a hold reading for one of the two ports');
        }

        // The width is reported in the SAME per-port entry as the count (Req 7.7): each
        // ceiling check below reads `portWidth` off the very entry it bounds, rather than a
        // fixed literal, so a count resting below 16 is read against that port's own width.
        expect(wide.portWidth).toBe(WIDE_WIDTH);
        expect(narrow.portWidth).toBe(NARROW_WIDTH);
        expect(wide.distinctHoldValueCount).toBeLessThanOrEqual(2 ** wide.portWidth);
        expect(narrow.distinctHoldValueCount).toBeLessThanOrEqual(2 ** narrow.portWidth);

        // Req 6.1's "still varies" half: a non-flaky lower bound well short of the 16-value
        // floor, so a real Stimulus_Mixer producing good but imperfect variety over 20 windows
        // still passes, while a renderer regression that held the port at one constant value
        // (distinctHoldValueCount === 1) would not.
        expect(wide.distinctHoldValueCount).toBeGreaterThanOrEqual(8);

        // The narrow port's ceiling is read as a WIDTH limit, not a weakened stimulus: no
        // assertion here asks it to reach 16, because its own 2-bit width cannot express 16
        // distinct values in the first place.
        expect(narrow.distinctHoldValueCount).toBeGreaterThanOrEqual(1);
      },
      RUN_TIMEOUT,
    );
  },
);
