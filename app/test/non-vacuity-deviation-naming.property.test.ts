// stimulus-transaction-structure, Property 13: Every deviation is fully named (task 8.5, C9).
//
// THE SYNTHETIC STREAM, AND WHY NO CLOCK/RESET
//   `readNonVacuity` is pure over its `stdout` argument, so this file builds `ECE_STIM`/
//   `ECE_STIM_END` lines by hand rather than running a simulator. The fixture interface declares
//   no clock and no reset, so `hasReset` is false throughout `buildReport` - no pair or period is
//   ever reset-excluded, which is exactly the "not reset-adjacent" condition the task asks for,
//   without needing to dodge `RESET_FRAME_PERIOD` windows by construction.
//
// ONE DEVIATION PER DRAW, HELD RATHER THAN TOGGLED BACK
//   A hold deviation sets the Held_Input's value to a new constant from one chosen step onward
//   and keeps it there: exactly one differing pair (the transition) falls inside the deviating
//   window, and every later window is clean because its own pair-to-pair comparisons see the
//   same held value throughout. Toggling back inside the window would add a second, unwanted
//   change and muddy which `changeSteps` entry the test is naming. A strobe deviation instead adds
//   one extra asserted step beside the period's own baseline assertion, so the deviating period
//   reads `assertedStepCount: 2` and every other period keeps its baseline `1`.
//
// THE BIT LAYOUT COMES FROM `packedPortSlices` ITSELF
//   The fixture's two ports' `high`/`low` ranges are read back from the real `packedPortSlices`
//   rather than assumed, so this file does not duplicate (and cannot drift from) the "first
//   declared port takes the lowest bits" layout `buildReport` relies on.
//
// Validates: Requirements 7.9

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { makePort, type ClockingContract, type ModuleInterface, type Port } from '@app/core';
import {
  packedPortSlices,
  readNonVacuity,
  STIM_END_PREFIX,
  STIM_LINE_PREFIX,
  type HoldWindowReading,
  type RoleDeclaration,
  type StrobePeriodReading,
} from '@app/tools';
// STROBE_PERIOD/HOLD_FRAME_PERIOD are not re-exported through the `@app/tools` barrel
// (simulator/index.ts); read from their own module directly, the convention
// `rendered-stimulus-strobe.property.test.ts` already uses.
import { HOLD_FRAME_PERIOD, STROBE_PERIOD } from '../tools/simulator/consensus-harness.js';

import { propertyParameters } from './property.js';

const PROPERTY = 'stimulus-transaction-structure, Property 13: Every deviation is fully named';

const NONCE = 'nvdn01';
const HOLD_PORT_NAME = 'hold_port';
const STROBE_PORT_NAME = 'strobe_port';
const HOLD_PORT_WIDTH = 4;
const STROBE_PORT_WIDTH = 3;

// Both ports present together, so the window/period layout both `buildReport` branches take is
// `STROBE_PERIOD` (Req 4.2, 4.3, 4.7) - fixed here to avoid duplicating that branch choice.
const PERIOD = STROBE_PERIOD;

const COMBINATIONAL: ClockingContract = { clockName: null, resetName: null, resetActiveLow: false };

function portOrThrow(name: string, width: number): Port {
  const built = makePort({ name, direction: 'input', width });
  if (!built.ok) {
    throw new Error(`fixture defect building port "${name}" (${built.error.code})`);
  }
  return built.value;
}

const MODULE_INTERFACE: ModuleInterface = {
  moduleName: 'nvdn_dut',
  ports: [
    portOrThrow(HOLD_PORT_NAME, HOLD_PORT_WIDTH),
    portOrThrow(STROBE_PORT_NAME, STROBE_PORT_WIDTH),
  ],
  clocking: COMBINATIONAL,
  validityOutputName: null,
};

const ROLES: RoleDeclaration = [
  { portName: HOLD_PORT_NAME, role: 'hold' },
  { portName: STROBE_PORT_NAME, role: 'strobe' },
];

const INPUT_SLICES = packedPortSlices(MODULE_INTERFACE.ports);

function sliceFor(name: string): { readonly high: number; readonly low: number } {
  const slice = INPUT_SLICES.find((entry) => entry.name === name);
  if (slice === undefined) {
    throw new Error(`fixture defect: no packed slice for port "${name}"`);
  }
  return slice;
}

const HOLD_LOW = sliceFor(HOLD_PORT_NAME).low;
const STROBE_LOW = sliceFor(STROBE_PORT_NAME).low;
const STROBE_ASSERTED_VALUE = (1n << BigInt(STROBE_PORT_WIDTH)) - 1n;

interface Scenario {
  readonly kind: 'hold' | 'strobe';
  readonly windowCount: number;
  readonly deviatingIndex: number;
  /** Step offset, strictly inside the deviating window/period, where the deviation sits. */
  readonly offset: number;
}

function scenarioArbitrary(): fc.Arbitrary<Scenario> {
  return fc.integer({ min: 2, max: 6 }).chain((windowCount) =>
    fc
      .record({
        kind: fc.constantFrom<'hold' | 'strobe'>('hold', 'strobe'),
        deviatingIndex: fc.integer({ min: 0, max: windowCount - 1 }),
        offset: fc.integer({ min: 1, max: PERIOD - 1 }),
      })
      .map((rest) => ({ windowCount, ...rest })),
  );
}

/** The one absolute step the deviation sits at, for either scenario kind. */
function deviatingStep(scenario: Scenario): number {
  return scenario.deviatingIndex * PERIOD + scenario.offset;
}

/**
 * Render the synthetic `ECE_STIM`/`ECE_STIM_END` stdout for `scenario`: the held port flips once
 * (held thereafter) for a `'hold'` scenario, and the strobe port gains one extra asserted step
 * beside its own baseline for a `'strobe'` scenario - the other port stays perfectly clean.
 */
function stdoutFor(scenario: Scenario): string {
  const sampleBudget = scenario.windowCount * PERIOD;
  const flipStep = deviatingStep(scenario);

  const lines: string[] = [];
  for (let step = 0; step < sampleBudget; step += 1) {
    const holdValue = scenario.kind === 'hold' && step >= flipStep ? 1n : 0n;

    const periodIndex = Math.floor(step / PERIOD);
    const offsetInPeriod = step % PERIOD;
    const isDeviatingExtraAssertion =
      scenario.kind === 'strobe' &&
      periodIndex === scenario.deviatingIndex &&
      offsetInPeriod === scenario.offset;
    const strobeValue =
      offsetInPeriod === 0 || isDeviatingExtraAssertion ? STROBE_ASSERTED_VALUE : 0n;

    const bundle = (holdValue << BigInt(HOLD_LOW)) | (strobeValue << BigInt(STROBE_LOW));
    lines.push(`${STIM_LINE_PREFIX} ${NONCE} ${String(step)} ${bundle.toString(16)}`);
  }
  lines.push(`${STIM_END_PREFIX} ${NONCE} ${String(sampleBudget)}`);
  return lines.join('\n');
}

/** Every window is clean except `deviatingIndex`, which names exactly `[expectedStep]`. */
function assertHoldDeviationNamed(
  windows: readonly HoldWindowReading[],
  deviatingIndex: number,
  expectedStep: number,
): void {
  for (const window of windows) {
    const label = `window ${String(window.windowIndex)}`;
    if (window.windowIndex === deviatingIndex) {
      expect(window.firstStep, label).toBe(deviatingIndex * PERIOD);
      expect(window.changeCount, label).toBe(1);
      expect(window.changeSteps, label).toEqual([expectedStep]);
    } else {
      expect(window.changeCount, label).toBe(0);
      expect(window.changeSteps, label).toEqual([]);
    }
  }
}

/** Every window carries no change at all - the role not under deviation in this scenario. */
function assertAllWindowsClean(windows: readonly HoldWindowReading[]): void {
  for (const window of windows) {
    expect(window.changeCount, `window ${String(window.windowIndex)}`).toBe(0);
  }
}

/** Every period is clean except `deviatingIndex`, which names exactly `[baseline, expectedStep]`. */
function assertStrobeDeviationNamed(
  periods: readonly StrobePeriodReading[],
  deviatingIndex: number,
  expectedStep: number,
): void {
  for (const period of periods) {
    const label = `period ${String(period.periodIndex)}`;
    const baselineStep = period.periodIndex * PERIOD;
    if (period.periodIndex === deviatingIndex) {
      expect(period.assertedStepCount, label).toBe(2);
      expect(period.assertedSteps, label).toEqual([baselineStep, expectedStep]);
    } else {
      expect(period.assertedStepCount, label).toBe(1);
      expect(period.assertedSteps, label).toEqual([baselineStep]);
    }
  }
}

/** Every period carries exactly its baseline assertion - the role not under deviation here. */
function assertAllPeriodsClean(periods: readonly StrobePeriodReading[]): void {
  for (const period of periods) {
    expect(period.assertedStepCount, `period ${String(period.periodIndex)}`).toBe(1);
  }
}

describe(PROPERTY, () => {
  it(
    'reports demonstratesTransactionStructure false and names the exact deviating window or ' +
      'period, with both period constants always present',
    () => {
      fc.assert(
        fc.property(scenarioArbitrary(), (scenario) => {
          const sampleBudget = scenario.windowCount * PERIOD;
          const outcome = readNonVacuity(
            stdoutFor(scenario),
            NONCE,
            MODULE_INTERFACE,
            ROLES,
            sampleBudget,
          );
          if (outcome.kind !== 'read') {
            throw new Error(`fixture defect: expected a complete reading, got "${outcome.reason}"`);
          }

          expect(outcome.demonstratesTransactionStructure).toBe(false);
          expect(outcome.strobePeriod).toBe(STROBE_PERIOD);
          expect(outcome.holdFramePeriod).toBe(HOLD_FRAME_PERIOD);

          const holdPort = outcome.holdWindowsByPort.find(
            (entry) => entry.portName === HOLD_PORT_NAME,
          );
          const strobePort = outcome.strobePeriodsByPort.find(
            (entry) => entry.portName === STROBE_PORT_NAME,
          );
          if (holdPort === undefined || strobePort === undefined) {
            throw new Error('fixture defect: report is missing the hold or strobe port entry');
          }

          const expectedStep = deviatingStep(scenario);
          if (scenario.kind === 'hold') {
            assertHoldDeviationNamed(holdPort.windows, scenario.deviatingIndex, expectedStep);
            assertAllPeriodsClean(strobePort.periods);
          } else {
            assertAllWindowsClean(holdPort.windows);
            assertStrobeDeviationNamed(strobePort.periods, scenario.deviatingIndex, expectedStep);
          }
        }),
        propertyParameters(),
      );
    },
  );
});
