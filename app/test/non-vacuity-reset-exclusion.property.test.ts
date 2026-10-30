// stimulus-transaction-structure, Property 11: A reset-asserted step never contributes a value
// change (task 8.3, C9).
//
// THE CONDITION IS CONSTRUCTED, NOT LEFT TO CHANCE
//   Req 4.11's exclusion only has teeth when the reset-asserted step's own value actually
//   differs from both neighbours - a stream where it happens to match either neighbour would
//   read as excluded-and-correct even without the exclusion rule doing any work. This file
//   forces that condition, and a separate genuine non-reset-adjacent change, into an otherwise
//   freely generated stream rather than hoping a random draw lands on either.
//
// THE FIXTURE
//   One Held_Input port on a clocked-and-reset interface with no Strobe, so one Hold_Window
//   equals one Hold_Frame_Period (`readNonVacuity`'s own `windowPeriod` choice, C9). Window 0
//   carries the forced genuine change. The window containing the first NONZERO reset-asserted
//   step (RESET_FRAME_PERIOD itself - step 0 has only one neighbour, so it can never satisfy
//   "differs from both") carries the forced exclusion case. The fixture's window count is sized
//   from that step, so it always lands in the LAST window, distinct from window 0; a module-load
//   guard fails loudly instead of silently testing a boundary pair if the period constants ever
//   move such that the step is no longer strictly interior to its window.
//
// THE ORACLE
//   `expectedChangeSteps` is a direct transcription of Req 4.11's own rule (drop a pair when
//   either of its two steps is reset-asserted) applied to the exact generated-then-overridden
//   stream, checked against EVERY window `readNonVacuity` reports - not just the two constructed
//   ones, so an incidental filler-driven change elsewhere in the stream is neither missed nor
//   double-counted. The two assertions after it restate the literal claim under test directly:
//   the reset-touching pairs are absent from `changeSteps` despite genuinely differing, and the
//   forced genuine change is present.
//
// Validates: Requirements 4.11

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ClockingContract, ModuleInterface, Port } from '@app/core';
import {
  readNonVacuity,
  STIM_END_PREFIX,
  STIM_LINE_PREFIX,
  type RoleDeclaration,
} from '@app/tools';
// Neither period constant is re-exported through the `@app/tools` barrel (simulator/index.ts),
// the same convention `rendered-stimulus-reset.property.test.ts` and
// `rendered-stimulus-hold.property.test.ts` already follow for this pair.
import { HOLD_FRAME_PERIOD, RESET_FRAME_PERIOD } from '../tools/simulator/consensus-harness.js';

import { propertyParameters } from './property.js';

const PROPERTY =
  'stimulus-transaction-structure, Property 11: A reset-asserted step never contributes a ' +
  'value change';

const HELD_PORT_NAME = 'held_in';
const HELD_WIDTH = 4;
const VALUE_MAX = (1n << BigInt(HELD_WIDTH)) - 1n;

const WINDOW_PERIOD = HOLD_FRAME_PERIOD; // no Strobe declared: Hold_Window == Hold_Frame_Period
const GENUINE_WINDOW_INDEX = 0;
const RESET_STEP = RESET_FRAME_PERIOD; // first NONZERO reset-asserted step
const RESET_WINDOW_INDEX = Math.floor(RESET_STEP / WINDOW_PERIOD);
const RESET_WINDOW_FIRST_STEP = RESET_WINDOW_INDEX * WINDOW_PERIOD;
const RESET_OFFSET = RESET_STEP - RESET_WINDOW_FIRST_STEP;
const WINDOW_COUNT = RESET_WINDOW_INDEX + 1;
const SAMPLE_BUDGET = WINDOW_COUNT * WINDOW_PERIOD;

// Guards the fixture's own assumption rather than silently exercising the wrong pair: the reset
// step must sit strictly inside its window (both neighbour pairs then fall within the range the
// window's own loop examines) and that window must be distinct from the genuine-change window.
if (
  RESET_WINDOW_INDEX <= GENUINE_WINDOW_INDEX ||
  RESET_OFFSET < 1 ||
  RESET_OFFSET > WINDOW_PERIOD - 2
) {
  throw new Error(
    `fixture defect: RESET_FRAME_PERIOD (${String(RESET_FRAME_PERIOD)}) and HOLD_FRAME_PERIOD ` +
      `(${String(HOLD_FRAME_PERIOD)}) no longer place the first nonzero reset step strictly ` +
      'inside a window distinct from window 0 - this fixture must be revisited',
  );
}

const CLOCKED: ClockingContract = { clockName: 'clk', resetName: 'rst', resetActiveLow: false };

const HOLD_ONLY_PORTS: readonly Port[] = [
  { name: HELD_PORT_NAME, direction: 'input', width: HELD_WIDTH },
  { name: 'q', direction: 'output', width: 1 },
];
const HOLD_ONLY_INTERFACE: ModuleInterface = {
  moduleName: 'hold_reset_excl_mod',
  ports: HOLD_ONLY_PORTS,
  clocking: CLOCKED,
  validityOutputName: null,
};
const ROLES: RoleDeclaration = [{ portName: HELD_PORT_NAME, role: 'hold' }];
const NONCE = 'nvreset1';

/** The one input port here is `held_in` alone, so its bundle IS the held value - no shifting. */
function stimStdout(values: readonly bigint[]): string {
  const lines = values.map(
    (value, step) => `${STIM_LINE_PREFIX} ${NONCE} ${step} ${value.toString(16)}`,
  );
  lines.push(`${STIM_END_PREFIX} ${NONCE} ${String(values.length)}`);
  return lines.join('\n');
}

/** The first value in `[0, VALUE_MAX]` not equal to any of `excluded` - always exists here since
 * HELD_WIDTH's 16-value domain never has more than two values excluded by a caller below. */
function valueDifferentFrom(...excluded: readonly bigint[]): bigint {
  const forbidden = new Set(excluded.map((value) => value.toString()));
  for (let candidate = 0n; candidate <= VALUE_MAX; candidate += 1n) {
    if (!forbidden.has(candidate.toString())) {
      return candidate;
    }
  }
  throw new Error('fixture defect: no value left outside the excluded set for this width');
}

/** A direct transcription of Req 4.11's rule: drop a pair when either of its steps is
 * reset-asserted, over one window's own step range. */
function expectedChangeSteps(
  values: readonly bigint[],
  firstStep: number,
  period: number,
): number[] {
  const steps: number[] = [];
  for (let step = firstStep; step < firstStep + period - 1; step += 1) {
    const next = step + 1;
    if (step % RESET_FRAME_PERIOD === 0 || next % RESET_FRAME_PERIOD === 0) {
      continue;
    }
    if (values[step] !== values[next]) {
      steps.push(next);
    }
  }
  return steps;
}

interface Scenario {
  readonly filler: readonly bigint[];
  readonly resetNeighbourBefore: bigint;
  readonly resetNeighbourAfter: bigint;
  readonly genuineBefore: bigint;
  readonly genuineChangeOffset: number;
}

function valueArb(): fc.Arbitrary<bigint> {
  return fc.bigInt({ min: 0n, max: VALUE_MAX });
}

function scenarioArbitrary(): fc.Arbitrary<Scenario> {
  return fc.record({
    filler: fc.array(valueArb(), { minLength: SAMPLE_BUDGET, maxLength: SAMPLE_BUDGET }),
    resetNeighbourBefore: valueArb(),
    resetNeighbourAfter: valueArb(),
    genuineBefore: valueArb(),
    // The pair (offset, offset + 1) in window 0; offset >= 1 keeps it off pair (0, 1), which
    // step 0's own reset assertion already excludes regardless.
    genuineChangeOffset: fc.integer({ min: 1, max: WINDOW_PERIOD - 2 }),
  });
}

/** Overrides `scenario.filler` at exactly the positions the property forces: the reset step's
 * own neighbourhood, and window 0's single genuine, non-reset-adjacent change. */
function buildValues(scenario: Scenario): bigint[] {
  const values = scenario.filler.slice();

  values[RESET_STEP - 1] = scenario.resetNeighbourBefore;
  values[RESET_STEP + 1] = scenario.resetNeighbourAfter;
  values[RESET_STEP] = valueDifferentFrom(
    scenario.resetNeighbourBefore,
    scenario.resetNeighbourAfter,
  );

  const genuineAfter = valueDifferentFrom(scenario.genuineBefore);
  for (let step = 0; step <= scenario.genuineChangeOffset; step += 1) {
    values[step] = scenario.genuineBefore;
  }
  for (let step = scenario.genuineChangeOffset + 1; step < WINDOW_PERIOD; step += 1) {
    values[step] = genuineAfter;
  }

  return values;
}

describe(PROPERTY, () => {
  it(
    'never counts a change at a pair touching a reset-asserted step even when that step ' +
      'genuinely differs from both neighbours, while still counting a genuine, ' +
      'non-reset-adjacent change elsewhere in the same stream',
    () => {
      fc.assert(
        fc.property(scenarioArbitrary(), (scenario) => {
          const values = buildValues(scenario);
          const outcome = readNonVacuity(
            stimStdout(values),
            NONCE,
            HOLD_ONLY_INTERFACE,
            ROLES,
            SAMPLE_BUDGET,
          );

          expect(outcome.kind).toBe('read');
          if (outcome.kind !== 'read') return;

          const held = outcome.holdWindowsByPort.find((port) => port.portName === HELD_PORT_NAME);
          if (held === undefined) {
            throw new Error('fixture defect: no hold reading for held_in');
          }

          // General check across every window, not just the two constructed ones: a filler-only
          // change elsewhere in the stream is neither missed nor double-counted.
          for (const window of held.windows) {
            expect(window.changeSteps).toEqual(
              expectedChangeSteps(values, window.firstStep, WINDOW_PERIOD),
            );
          }

          // The literal claim: the pairs touching the reset-asserted step are excluded even
          // though the construction above made them genuinely differ.
          const resetWindow = held.windows[RESET_WINDOW_INDEX];
          if (resetWindow === undefined) {
            throw new Error('fixture defect: no reading for the reset-bearing window');
          }
          expect(resetWindow.changeSteps).not.toContain(RESET_STEP);
          expect(resetWindow.changeSteps).not.toContain(RESET_STEP + 1);

          // The exclusion does not over-reach: a genuine, non-reset-adjacent change is counted.
          const genuineWindow = held.windows[GENUINE_WINDOW_INDEX];
          if (genuineWindow === undefined) {
            throw new Error('fixture defect: no reading for the genuine-change window');
          }
          expect(genuineWindow.changeSteps).toEqual([scenario.genuineChangeOffset + 1]);
        }),
        propertyParameters(),
      );
    },
  );
});
