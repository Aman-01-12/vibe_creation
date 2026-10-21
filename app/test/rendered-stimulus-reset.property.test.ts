// Feature: reference-model-rendered-stimulus, Property 7: The mid-run reset recurs on schedule,
// re-primes the state, and skips no comparison (task 6.2, C6).
//
// THE ORACLE IS STRUCTURAL PLUS A SEPARATE ARITHMETIC CHECK
//   The rendered reset-assertion step set is ONE modulo expression
//   (`(step % ECE_RESET_FRAME) == 0`), not an unrolled per-step list, so this file's oracle has
//   two halves, matching `consensus-harness.test.ts`'s own "the mid-run reset (C6)" describe
//   block's stated split:
//     1. STRUCTURAL - the exact modulo expression, the task, and the localparam render once for a
//        reset-bearing interface; the `step == 0` guard (and none of the above) renders for a
//        no-reset one.
//     2. ARITHMETIC - the modulo's own semantics are evaluated independently of the renderer, by
//        TWO separately-computed step sets (one filtering `step % RESET_FRAME_PERIOD === 0` over
//        every step, one built by repeated addition of the period) that are cross-checked against
//        each other and then against design.md's own claim: "exactly the multiples of the
//        Reset_Frame_Period below the budget".
//
//   `RESET_FRAME_PERIOD` is not re-exported through the `@app/tools` barrel
//   (`simulator/index.ts`), so it is read from its own module directly, the same convention
//   `rendered-stimulus-enable.property.test.ts` and `rendered-stimulus-layout.property.test.ts`
//   already use for `ENABLE_FRAME_PERIOD`.
//
// WHY THE "REACHED UNCONDITIONALLY" HALF IS A LINE-POSITION CHECK, NOT A TEXTUAL ONE
//   The per-step comparison (`ece_exp_bits`/`$display` CHECK lines) and the sample emission
//   (`$display` ECE_SAMPLE) must sit OUTSIDE the reset guard's own `begin...end`, which a textual
//   `toContain` cannot distinguish from "nested inside it". This file locates the guard's closing
//   `end` by line index and asserts every comparison and emission line's index is strictly after
//   it - the same line-index technique `consensus-harness.test.ts`'s own "calls ece_harness_reset
//   from the loop head ..." test already uses to exclude the task's own declaration from a
//   "before the loop" scan.
//
// NON-VACUITY (design.md's own three-row table for Property 7, each constructed and exhausted)
//   1. A Sample_Budget strictly ABOVE RESET_FRAME_PERIOD (600) and one strictly BELOW it (64, the
//      pilot's old budget) - both their own fixtures, asserting the larger step-set carries more
//      than one scheduled reset and the smaller carries exactly one (step 0).
//   2. An interface WITH a declared reset and one WITHOUT - both constructed, confirming the two
//      branches render the documented different text.
//   3. A REGISTERED output and a COMBINATIONAL output on one interface (the ACCU shape from
//      `consensus-harness.test.ts`'s own "the state-convention comparison and the validity mask"
//      describe block) - confirming the per-step comparison logic for each still renders
//      unconditionally relative to the reset check.
//
// Validates: Requirements 5.1, 5.2, 5.4, 5.5, 5.7

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  makeTimingContract,
  type ClockingContract,
  type ModuleInterface,
  type Port,
  type TimingContract,
} from '@app/core';
import {
  renderConsensusHarness,
  sizedSampleBudget,
  type ConsensusHarnessRequest,
  type RoleDeclaration,
} from '@app/tools';
// RESET_FRAME_PERIOD is not re-exported through the `@app/tools` barrel (simulator/index.ts), so
// it is read from its own module directly, matching the convention
// `rendered-stimulus-enable.property.test.ts` and `rendered-stimulus-layout.property.test.ts`
// already use for ENABLE_FRAME_PERIOD.
import { RESET_FRAME_PERIOD } from '../tools/simulator/consensus-harness.js';

import { propertyParameters } from './property.js';

const PROPERTY =
  'reference-model-rendered-stimulus, Property 7: The mid-run reset recurs on schedule, ' +
  're-primes the state, and skips no comparison';

const CLOCKED_WITH_RESET: ClockingContract = {
  clockName: 'clk',
  resetName: 'rst',
  resetActiveLow: false,
};
const CLOCKED_NO_RESET: ClockingContract = {
  clockName: 'clk',
  resetName: null,
  resetActiveLow: false,
};

function moduleInterfaceWith(
  moduleName: string,
  ports: readonly Port[],
  clocking: ClockingContract,
): ModuleInterface {
  return { moduleName, ports, clocking, validityOutputName: null };
}

/** `clk`/`rst` are carried by `clocking`, not by `ports` (mirrors `consensus-harness.test.ts`'s
 * own `COUNTER_INTERFACE`): the Candidate_Design's module still declares those two ports,
 * connected via `clockName`/`resetName` rather than appearing in the declared port list. */
const RESET_BEARING_INTERFACE = moduleInterfaceWith(
  'counter_reset_prop',
  [
    { name: 'en', direction: 'input', width: 1 },
    { name: 'q', direction: 'output', width: 4 },
  ],
  CLOCKED_WITH_RESET,
);

const NO_RESET_INTERFACE = moduleInterfaceWith(
  'counter_no_reset_prop',
  [
    { name: 'en', direction: 'input', width: 1 },
    { name: 'q', direction: 'output', width: 4 },
  ],
  CLOCKED_NO_RESET,
);

/** One `registered` entry per output port of `moduleInterface`, built directly from its own ports. */
function allRegisteredTiming(moduleInterface: ModuleInterface): TimingContract {
  const entries = moduleInterface.ports
    .filter((port) => port.direction === 'output')
    .map((port) => ({ portName: port.name, timing: 'registered' as const }));
  const built = makeTimingContract(moduleInterface, entries);
  if (!built.ok) {
    throw new Error(`fixture defect building the timing contract: ${built.error.code}`);
  }
  return built.value;
}

/** A total Role_Declaration naming every input port of `moduleInterface` as `data`. */
function allDataRoles(moduleInterface: ModuleInterface): RoleDeclaration {
  return moduleInterface.ports
    .filter((port) => port.direction === 'input')
    .map((port) => ({ portName: port.name, role: 'data' as const }));
}

function outputBundleWidthOf(moduleInterface: ModuleInterface): number {
  return Math.max(
    1,
    moduleInterface.ports
      .filter((port) => port.direction === 'output')
      .reduce((sum, port) => sum + port.width, 0),
  );
}

const NONCE = 'rstprop';

function requestFor(
  moduleInterface: ModuleInterface,
  sampleBudget: number,
  timingContract: TimingContract = allRegisteredTiming(moduleInterface),
): ConsensusHarnessRequest {
  return {
    moduleInterface,
    timingContract,
    nonce: NONCE,
    watchdogBudgetNs: 2_000_000,
    sampleBudget,
    roles: allDataRoles(moduleInterface),
  };
}

/** The width-reduced budget the renderer's own `ECE_SAMPLE_BUDGET` literal records (mirrors
 * `rendered-stimulus-budget.property.test.ts`'s own `readRenderedBudget`). */
function readRenderedBudget(contents: string): number {
  const match = /localparam integer ECE_SAMPLE_BUDGET = (\d+);/u.exec(contents);
  if (match === null) {
    throw new Error('rendered text carries no ECE_SAMPLE_BUDGET localparam');
  }
  return Number(match[1]);
}

// ---------------------------------------------------------------------------
// The arithmetic half: two independently-computed step sets, cross-checked
// ---------------------------------------------------------------------------

/** Every step in `[0, budget)` for which the modulo check fires, computed by filtering. */
function resetStepsByModulo(budget: number): readonly number[] {
  return Array.from({ length: budget }, (_, step) => step).filter(
    (step) => step % RESET_FRAME_PERIOD === 0,
  );
}

/** The same set, built by repeated addition of the period rather than by filtering a modulo. */
function resetStepsByAddition(budget: number): readonly number[] {
  const steps: number[] = [];
  for (let step = 0; step < budget; step += RESET_FRAME_PERIOD) {
    steps.push(step);
  }
  return steps;
}

/**
 * design.md's own claim for Property 7: "exactly the multiples of the Reset_Frame_Period below
 * the budget". Cross-checks the two independent computations above against each other before
 * returning, so a defect in either enumeration cannot silently pass as agreement with itself.
 */
function scheduledResetSteps(budget: number): readonly number[] {
  const byModulo = resetStepsByModulo(budget);
  const byAddition = resetStepsByAddition(budget);
  expect(byModulo).toEqual(byAddition);
  for (const step of byModulo) {
    expect(step % RESET_FRAME_PERIOD).toBe(0);
  }
  return byModulo;
}

// ---------------------------------------------------------------------------
// The structural half
// ---------------------------------------------------------------------------

/** How many times `needle` occurs in `text`, non-overlapping. */
function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** The reset-bearing branch: one task, one localparam, one modulo check, immediately followed by
 * the state re-prime - the exact rendered shape `decision-mid-run-reset-...md` records. */
function assertResetBearingStructure(text: string): void {
  expect(text).toContain('task ece_harness_reset;');
  expect(text).toContain('endtask');
  expect(text).toContain(`localparam integer ECE_RESET_FRAME = ${String(RESET_FRAME_PERIOD)};`);
  expect(countOccurrences(text, '(step % ECE_RESET_FRAME) == 0')).toBe(1);

  const lines = text.split('\n');
  const guardIndex = lines.findIndex((line) =>
    line.includes('if ((step % ECE_RESET_FRAME) == 0) begin'),
  );
  expect(guardIndex).toBeGreaterThan(-1);
  expect(lines[guardIndex + 1]?.trim()).toBe('ece_harness_reset;');
  expect(lines[guardIndex + 2]?.trim()).toBe("ece_state = ece_reset_state(1'b0);");
}

/** The no-reset branch: different rendered text entirely, no task, no localparam, no modulo -
 * priming guarded by `step == 0` instead, immediately followed by the state re-prime. */
function assertNoResetStructure(text: string): void {
  expect(text).not.toContain('ece_harness_reset');
  expect(text).not.toContain('ECE_RESET_FRAME');
  expect(text).not.toContain('(step % ECE_RESET_FRAME) == 0');

  const lines = text.split('\n');
  const guardIndex = lines.findIndex((line) => line.trim() === 'if (step == 0) begin');
  expect(guardIndex).toBeGreaterThan(-1);
  expect(lines[guardIndex + 1]?.trim()).toBe("ece_state = ece_reset_state(1'b0);");
}

/**
 * Assert that every per-step comparison line (`ece_exp_bits`/CHECK `$display`) and the sample
 * emission line (`ECE_SAMPLE` `$display`) sit strictly AFTER the reset guard's own closing `end`,
 * i.e. outside its `begin...end` - the clause a renderer that skipped a step on reset would fail
 * while still passing every schedule-shape check above.
 */
function assertComparisonReachedUnconditionally(text: string): void {
  const lines = text.split('\n');
  const guardIndex = lines.findIndex(
    (line) =>
      line.includes('if ((step % ECE_RESET_FRAME) == 0) begin') ||
      line.trim() === 'if (step == 0) begin',
  );
  expect(guardIndex).toBeGreaterThan(-1);
  const guardEndIndex = lines.findIndex(
    (line, index) => index > guardIndex && line.trim() === 'end',
  );
  expect(guardEndIndex).toBeGreaterThan(guardIndex);

  const driveIndex = lines.findIndex((line) => line.includes('ece_in_bits = ece_stimulus(step);'));
  expect(driveIndex).toBeGreaterThan(guardEndIndex);

  // Matched against the literal quoted $display prefixes (not a bare substring search): the
  // localparam declaration `ECE_SAMPLE_BUDGET` renders ABOVE the loop and contains "ECE_SAMPLE"
  // as a substring, which a bare `line.includes('ECE_SAMPLE')` would wrongly count as a sample
  // emission line reached before the guard.
  const comparisonAndSampleIndices = lines
    .map((line, index) => ({ line, index }))
    .filter(
      ({ line }) =>
        line.includes('=== ') ||
        line.includes('"CHECK %0s PASS"') ||
        line.includes('"CHECK %0s FAIL') ||
        line.includes('"ECE_SAMPLE '),
    )
    .map(({ index }) => index);
  expect(comparisonAndSampleIndices.length).toBeGreaterThan(0);
  for (const index of comparisonAndSampleIndices) {
    expect(index).toBeGreaterThan(guardEndIndex);
  }
}

// ---------------------------------------------------------------------------
// The sampled property
// ---------------------------------------------------------------------------

describe(PROPERTY, () => {
  it(
    'renders exactly the documented reset schedule for a reset-bearing interface and the ' +
      'step==0-only guard for a no-reset one, with the loop bound recorded and every ' +
      'comparison reached unconditionally, over a sampled range of budgets',
    () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 2000 }),
          fc.boolean(),
          (sampleBudget, resetBearing) => {
            const moduleInterface = resetBearing ? RESET_BEARING_INTERFACE : NO_RESET_INTERFACE;
            const rendered = renderConsensusHarness(requestFor(moduleInterface, sampleBudget));
            expect(rendered.ok).toBe(true);
            if (!rendered.ok) return;
            const text = rendered.value.contents;

            // The rendered loop bound equals the recorded ECE_SAMPLE_BUDGET, sized the same way
            // `rendered-stimulus-budget.property.test.ts` already checks (Property 8).
            const effectiveBudget = sizedSampleBudget(
              NONCE.length,
              outputBundleWidthOf(moduleInterface),
              sampleBudget,
            );
            expect(readRenderedBudget(text)).toBe(effectiveBudget);

            if (resetBearing) {
              assertResetBearingStructure(text);
              // Arithmetic half: design.md's claim restated and cross-checked against the
              // renderer's own recorded loop bound, not against the raw requested budget.
              const scheduled = scheduledResetSteps(effectiveBudget);
              expect(scheduled[0]).toBe(0);
              expect(scheduled.every((step) => step < effectiveBudget)).toBe(true);
            } else {
              assertNoResetStructure(text);
            }
            assertComparisonReachedUnconditionally(text);
          },
        ),
        propertyParameters(),
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Non-vacuity row 1: a budget strictly above RESET_FRAME_PERIOD and one strictly below
// ---------------------------------------------------------------------------

describe(`${PROPERTY} - non-vacuity: budget above and below the period`, () => {
  it('schedules more than one mid-run reset for a budget strictly above RESET_FRAME_PERIOD (600)', () => {
    const steps = scheduledResetSteps(600);
    expect(steps.length).toBeGreaterThan(1);
    expect(steps).toEqual([0, 256, 512]);

    const rendered = renderConsensusHarness(requestFor(RESET_BEARING_INTERFACE, 600));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    assertResetBearingStructure(rendered.value.contents);
  });

  it("schedules exactly one mid-run reset (step 0) for a budget strictly below RESET_FRAME_PERIOD (64, the pilot's old budget)", () => {
    const steps = scheduledResetSteps(64);
    expect(steps).toEqual([0]);
    expect(64).toBeLessThan(RESET_FRAME_PERIOD);

    const rendered = renderConsensusHarness(requestFor(RESET_BEARING_INTERFACE, 64));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    // Same rendered shape as the 600-step case - one modulo expression - but the behavioural
    // claim ("only step 0 fires") is a property of the arithmetic above, not of distinct text.
    assertResetBearingStructure(rendered.value.contents);
  });
});

// ---------------------------------------------------------------------------
// Non-vacuity row 2: an interface WITH a declared reset and one WITHOUT
// ---------------------------------------------------------------------------

describe(`${PROPERTY} - non-vacuity: a declared reset and no declared reset`, () => {
  it('renders the task, localparam, and modulo guard for a reset-bearing interface', () => {
    const rendered = renderConsensusHarness(requestFor(RESET_BEARING_INTERFACE, 300));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    assertResetBearingStructure(rendered.value.contents);
  });

  it('renders none of the task, the localparam, or the modulo guard for a no-reset interface, using the step==0 guard instead', () => {
    const rendered = renderConsensusHarness(requestFor(NO_RESET_INTERFACE, 300));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    assertNoResetStructure(rendered.value.contents);
  });
});

// ---------------------------------------------------------------------------
// Non-vacuity row 3: a registered output and a combinational output on one interface
// ---------------------------------------------------------------------------

describe(`${PROPERTY} - non-vacuity: a registered and a combinational output together`, () => {
  // The ACCU shape from `consensus-harness.test.ts`'s own "the state-convention comparison and
  // the validity mask" describe block, given a declared reset so the mid-run schedule applies.
  const MIXED_OUTPUT_INTERFACE = moduleInterfaceWith(
    'accu_reset_prop',
    [
      { name: 'data_in', direction: 'input', width: 8 },
      { name: 'valid_out', direction: 'output', width: 1 },
      { name: 'data_out', direction: 'output', width: 10 },
    ],
    CLOCKED_WITH_RESET,
  );

  it('renders the per-step comparison for both a combinational and a registered output unconditionally relative to the reset check', () => {
    const timingContract = makeTimingContract(MIXED_OUTPUT_INTERFACE, [
      { portName: 'valid_out', timing: 'combinational' },
      { portName: 'data_out', timing: 'registered' },
    ]);
    if (!timingContract.ok) {
      throw new Error(`fixture defect building the timing contract: ${timingContract.error.code}`);
    }
    const rendered = renderConsensusHarness(
      requestFor(MIXED_OUTPUT_INTERFACE, 300, timingContract.value),
    );
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const text = rendered.value.contents;

    assertResetBearingStructure(text);
    // Both the combinational port's check (against ece_exp_bits) and the registered port's check
    // (against ece_exp_reg_bits) must be present and unconditional, not just one of the two.
    expect(text).toContain('if (ece_exp_bits[0:0] === valid_out)');
    expect(text).toContain('if (ece_exp_reg_bits[10:1] === data_out)');
    assertComparisonReachedUnconditionally(text);
  });
});
