// Real-toolchain integration test: stimulus-transaction-structure, Property 7 - a Held_Input
// never changes inside a Hold_Window (task 8.9, C8/C9).
//
// WHY THIS TEST EXISTS
//
//   `rendered-stimulus-hold.property.test.ts` already pins the RENDERED TEXT of the hold
//   pattern, and `non-vacuity-reset-exclusion.property.test.ts` already pins `readNonVacuity`'s
//   reset-exclusion rule against a hand-built stdout stream. Neither runs a real simulator.
//   Req 7.1, 7.6 require the figures to come from a real toolchain invocation of the
//   Non_Vacuity_Probe, so this file is the one place that renders the probe from a hold-role
//   Total_Role_Declaration, drives it through real `iverilog` + `vvp`, and reads the actual
//   stdout back through `readNonVacuity`.
//
// WHY A CLOCK AND RESET ARE DECLARED HERE
//
//   The Non_Vacuity_Probe itself is self-contained (no clock, no DUT, no reset wire) - it is a
//   pure loop over `ece_stimulus(step)`. Declaring `clocking.clockName`/`resetName` on the
//   `ModuleInterface` makes `readNonVacuity`'s `hasReset` true, which is what makes some of the
//   Sample_Budget's whole Hold_Windows read as reset-bearing (Req 4.11) rather than every window
//   being reset-free the way task 8.8's simpler fixture can leave it. Property 7 is stated to
//   hold "for every window including the eight that contain a reset assertion", so this file
//   checks both kinds explicitly instead of only ever landing on the reset-free 22.
//
// SIZING THE SAMPLE_BUDGET
//
//   The product's own `SAMPLE_BUDGET` (2048) is reused rather than a custom smaller number: at
//   `HOLD_FRAME_PERIOD` (67) it yields 30 whole Hold_Windows, 8 of them reset-bearing (steps 0,
//   256, ..., 1792) and 22 reset-free - already past criterion 7.2's floor of 16 and the exact
//   split the design and task text name, with no extra arithmetic needed to hit it.
//
// Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.7, 4.10, 7.1, 7.2

import { describe, expect, it } from 'vitest';

import type { ModuleInterface } from '@app/core';
import {
  readNonVacuity,
  renderNonVacuityProbe,
  SAMPLE_BUDGET,
  type NonVacuityProbeRequest,
  type ResourceLimits,
  type RoleDeclaration,
} from '@app/tools';
// Neither period constant is re-exported through the `@app/tools` barrel (simulator/index.ts),
// the same convention `non-vacuity-reset-exclusion.property.test.ts` already follows for this
// pair.
import { HOLD_FRAME_PERIOD, RESET_FRAME_PERIOD } from '../tools/simulator/consensus-harness.js';

import { PROBE, realOracleAdapter } from './real-oracle-harness.js';

if (!PROBE.available) {
  console.warn(
    `[non-vacuity-hold-window.integration] Real-oracle path NOT exercised: ${PROBE.reason}. ` +
      'Property 7 across real reset-bearing and reset-free Hold_Windows is UNVALIDATED in this environment.',
  );
}

const REAL_LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };
const RUN_TIMEOUT = 60_000;

const HELD_PORT_NAME = 'held_in';
const HELD_WIDTH = 4;
const NONCE = 'holdwin1';

const HOLD_INTERFACE: ModuleInterface = {
  moduleName: 'hold_window_probe_mod',
  ports: [
    { name: HELD_PORT_NAME, direction: 'input', width: HELD_WIDTH },
    { name: 'q', direction: 'output', width: 1 },
  ],
  clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
  validityOutputName: null,
};
const ROLES: RoleDeclaration = [{ portName: HELD_PORT_NAME, role: 'hold' }];

// No Strobe is declared, so `readNonVacuity`'s window period is `HOLD_FRAME_PERIOD` - the same
// branch choice `buildReport` (`non-vacuity-check.ts`) makes.
const WINDOW_PERIOD = HOLD_FRAME_PERIOD;
const WHOLE_WINDOW_COUNT = Math.floor(SAMPLE_BUDGET / WINDOW_PERIOD);

/** Whether any step of the whole window at `windowIndex` is a reset-asserted step. */
function windowContainsReset(windowIndex: number): boolean {
  const firstStep = windowIndex * WINDOW_PERIOD;
  for (let step = firstStep; step < firstStep + WINDOW_PERIOD; step += 1) {
    if (step % RESET_FRAME_PERIOD === 0) {
      return true;
    }
  }
  return false;
}

const ALL_WINDOW_INDICES = Array.from({ length: WHOLE_WINDOW_COUNT }, (_, index) => index);
const RESET_BEARING_WINDOWS = ALL_WINDOW_INDICES.filter(windowContainsReset);
const RESET_FREE_WINDOWS = ALL_WINDOW_INDICES.filter((index) => !windowContainsReset(index));

// Guards the fixture's own assumption rather than silently exercising only one kind of window:
// window 0 always contains the step-0 reset trivially, so a second reset-bearing window is
// required to pick a non-trivial representative, distinct from the "every run has a window 0"
// case.
if (WHOLE_WINDOW_COUNT < 16 || RESET_BEARING_WINDOWS.length < 2 || RESET_FREE_WINDOWS.length < 1) {
  throw new Error(
    `fixture defect: HOLD_FRAME_PERIOD (${String(HOLD_FRAME_PERIOD)}) and RESET_FRAME_PERIOD ` +
      `(${String(RESET_FRAME_PERIOD)}) over SAMPLE_BUDGET (${String(SAMPLE_BUDGET)}) no longer ` +
      'yield at least 16 whole windows with both a non-trivial reset-bearing one and a ' +
      'reset-free one - this fixture must be revisited',
  );
}

const RESET_BEARING_WINDOW_INDEX = RESET_BEARING_WINDOWS[1];
const RESET_FREE_WINDOW_INDEX = RESET_FREE_WINDOWS[0];
if (RESET_BEARING_WINDOW_INDEX === undefined || RESET_FREE_WINDOW_INDEX === undefined) {
  throw new Error('fixture defect: unreachable given the length guard above');
}

describe('non-vacuity hold-window real-toolchain capability probe', () => {
  it('documents whether the real oracle path was exercised in this environment', () => {
    expect(typeof PROBE.available).toBe('boolean');
    expect(PROBE.reason.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!PROBE.available)(
  'a Held_Input never changes inside a whole Hold_Window, across 30 real windows including 8 reset-bearing ones (Property 7; Req 4.1-4.10, 7.1, 7.2)',
  () => {
    it(
      'reports zero change count for every whole Hold_Window read from real Non_Vacuity_Probe stdout, including an explicit reset-bearing window and an explicit reset-free one',
      async () => {
        const request: NonVacuityProbeRequest = {
          moduleInterface: HOLD_INTERFACE,
          nonce: NONCE,
          roles: ROLES,
          sampleBudget: SAMPLE_BUDGET,
        };
        const rendered = renderNonVacuityProbe(request);
        if (!rendered.ok) {
          throw new Error(`fixture defect: ${rendered.error.code}`);
        }

        const verdict = await realOracleAdapter().simulate([], rendered.value, REAL_LIMITS);
        expect(verdict.failureCause).toBe('none');

        const outcome = readNonVacuity(verdict.stdout, NONCE, HOLD_INTERFACE, ROLES, SAMPLE_BUDGET);
        expect(outcome.kind).toBe('read');
        if (outcome.kind !== 'read') {
          return;
        }

        // Req 7.2's floor, read from the REAL run rather than assumed from the sizing comment
        // above.
        expect(outcome.wholeHoldWindowCount).toBeGreaterThanOrEqual(16);

        const held = outcome.holdWindowsByPort.find((port) => port.portName === HELD_PORT_NAME);
        if (held === undefined) {
          throw new Error('fixture defect: no hold reading for held_in');
        }

        // The literal claim: the hold held for its entire window, for EVERY whole window read -
        // not just the two representative ones checked explicitly below.
        for (const window of held.windows) {
          expect(window.changeCount).toBe(0);
        }

        const resetBearingWindow = held.windows[RESET_BEARING_WINDOW_INDEX];
        const resetFreeWindow = held.windows[RESET_FREE_WINDOW_INDEX];
        if (resetBearingWindow === undefined || resetFreeWindow === undefined) {
          throw new Error('fixture defect: no reading for one of the representative windows');
        }
        expect(resetBearingWindow.changeCount).toBe(0);
        expect(resetFreeWindow.changeCount).toBe(0);
      },
      RUN_TIMEOUT,
    );
  },
);
