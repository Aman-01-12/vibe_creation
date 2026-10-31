// stimulus-transaction-structure, Property 12: A reading is either complete with all three
// figures or refused with a reason (task 8.4, C9).
//
// GENERATED STDOUT, NOT HAND-BUILT EXAMPLES
//   `non-vacuity-check.test.ts` (task 8.2, co-located with the source) already pins one
//   hand-built example of each of Req 7.8's three causes. This file generalizes that into a
//   property: for ANY generated well-formed `ECE_STIM`/`ECE_STIM_END` stream, `readNonVacuity`
//   returns a complete `'read'` report carrying all three figures together (hold window
//   readings, strobe period readings, and Distinct_Hold_Value_Count); for the same stream
//   deliberately corrupted by exactly one of the three causes at a random step, it ALWAYS
//   returns `'incomplete'` with a reason and none of the three figures. The union is total, and
//   its two arms never both apply.
//
// THREE EXHAUSTED CASES, NOT ONE SAMPLED DRAW
//   Req 7.8's three causes are a closed set of three, so each gets its own `it` block that
//   always runs rather than one `fc.constantFrom` draw that could skip a cause on a given run
//   (chipAgent/_inbox/gotcha-a-closed-union-non-vacuity-row-should-be-exhausted-not-sampled.md).
//
// Validates: Requirements 7.7, 7.8

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ClockingContract, ModuleInterface } from '@app/core';
import {
  readNonVacuity,
  STIM_END_PREFIX,
  STIM_LINE_PREFIX,
  type NonVacuityOutcome,
  type RoleDeclaration,
} from '@app/tools';
// STROBE_PERIOD is read from its own defining module (`consensus-harness.ts`) rather than through
// the `@app/tools` barrel, the convention this spec's other property tests already use
// (e.g. `rendered-stimulus-strobe.property.test.ts`).
import { STROBE_PERIOD } from '../tools/simulator/consensus-harness.js';

import { propertyParameters } from './property.js';

const PROPERTY =
  'stimulus-transaction-structure, Property 12: A reading is either complete with all three ' +
  'figures or refused with a reason';

const CLOCKED: ClockingContract = { clockName: 'clk', resetName: 'rst', resetActiveLow: false };

// One Strobe and one Held_Input, matching `packedPortSlices`' declared-order layout (strobe at
// bit 0, held at bits 4:1) - the same fixture shape `non-vacuity-check.test.ts` uses, so the
// clean reading carries both strobe period readings and hold window readings at once.
const MODULE_INTERFACE: ModuleInterface = {
  moduleName: 'dut',
  ports: [
    { name: 'strobe_in', direction: 'input', width: 1 },
    { name: 'held_in', direction: 'input', width: 4 },
    { name: 'q', direction: 'output', width: 4 },
  ],
  clocking: CLOCKED,
  validityOutputName: null,
};

const ROLES: RoleDeclaration = [
  { portName: 'strobe_in', role: 'strobe' },
  { portName: 'held_in', role: 'hold' },
];

const NONCE = 'completeness9';

// Two whole Strobe_Periods: period 0 (steps 0-66) always contains the clocked-and-reset step-0
// reset and is dropped from the strobe reading, so two periods guarantee period 1 is still read
// and the clean case's strobe figure is actually non-empty, not just present-but-empty.
const SAMPLE_BUDGET = 2 * STROBE_PERIOD;

/** `SAMPLE_BUDGET` per-step input-bundle values; 5 bits (1 strobe + 4 held) fit in 0-31. */
const valuesArb = fc
  .array(fc.integer({ min: 0, max: 31 }), { minLength: SAMPLE_BUDGET, maxLength: SAMPLE_BUDGET })
  .map((ints) => ints.map((value) => BigInt(value)));

function stimLines(values: readonly bigint[], nonce: string): string[] {
  return values.map(
    (value, step) => `${STIM_LINE_PREFIX} ${nonce} ${String(step)} ${value.toString(16)}`,
  );
}

function endLine(nonce: string, count: number): string {
  return `${STIM_END_PREFIX} ${nonce} ${String(count)}`;
}

/** A well-formed stream: every step's line once, in order, and a matching end count. */
function cleanStdout(values: readonly bigint[], nonce: string): string {
  return [...stimLines(values, nonce), endLine(nonce, values.length)].join('\n');
}

/** Req 7.8 cause 1: `missingStep`'s line never arrives. A real truncated run still declares its
 * ORIGINAL intended end count, so that count is left unchanged here too. */
function stdoutMissingStep(values: readonly bigint[], nonce: string, missingStep: number): string {
  const lines = stimLines(values, nonce).filter((_line, step) => step !== missingStep);
  return [...lines, endLine(nonce, values.length)].join('\n');
}

/** Req 7.8 cause 2: `dupStep`'s line is emitted twice. The end count reflects the per-step lines
 * actually read (one more than the intended budget), matching a real duplicated emission. */
function stdoutDuplicatedStep(
  values: readonly bigint[],
  nonce: string,
  dupStep: number,
  dupValue: bigint,
): string {
  const lines = stimLines(values, nonce);
  lines.splice(
    dupStep + 1,
    0,
    `${STIM_LINE_PREFIX} ${nonce} ${String(dupStep)} ${dupValue.toString(16)}`,
  );
  return [...lines, endLine(nonce, lines.length)].join('\n');
}

/** Req 7.8 cause 3: every step's line is present exactly once, but the declared end count is off
 * by `delta` (always positive, so it is unambiguously not the per-step line count). */
function stdoutEndCountMismatch(values: readonly bigint[], nonce: string, delta: number): string {
  return [...stimLines(values, nonce), endLine(nonce, values.length + delta)].join('\n');
}

function expectRefusedWithReason(outcome: NonVacuityOutcome): void {
  expect(outcome.kind).toBe('incomplete');
  if (outcome.kind !== 'incomplete') return;
  expect(outcome.reason.length).toBeGreaterThan(0);
  expect('holdWindowsByPort' in outcome).toBe(false);
  expect('strobePeriodsByPort' in outcome).toBe(false);
}

function expectCompleteWithAllThreeFigures(outcome: NonVacuityOutcome): void {
  expect(outcome.kind).toBe('read');
  if (outcome.kind !== 'read') return;
  expect('reason' in outcome).toBe(false);

  expect(outcome.holdWindowsByPort.length).toBeGreaterThan(0);
  for (const port of outcome.holdWindowsByPort) {
    expect(port.windows.length).toBeGreaterThan(0);
    expect(Number.isInteger(port.distinctHoldValueCount)).toBe(true);
  }

  expect(outcome.strobePeriodsByPort.length).toBeGreaterThan(0);
  for (const port of outcome.strobePeriodsByPort) {
    expect(port.periods.length).toBeGreaterThan(0);
  }
}

function readOutcome(stdout: string, sampleBudget: number): NonVacuityOutcome {
  return readNonVacuity(stdout, NONCE, MODULE_INTERFACE, ROLES, sampleBudget);
}

describe(PROPERTY, () => {
  it('reports a complete reading with all three figures for any well-formed stream', () => {
    fc.assert(
      fc.property(valuesArb, (values) => {
        expectCompleteWithAllThreeFigures(readOutcome(cleanStdout(values, NONCE), SAMPLE_BUDGET));
      }),
      propertyParameters(),
    );
  });

  it('reports incomplete with a reason when a step line is absent', () => {
    fc.assert(
      fc.property(
        valuesArb,
        fc.integer({ min: 0, max: SAMPLE_BUDGET - 1 }),
        (values, missingStep) => {
          const stdout = stdoutMissingStep(values, NONCE, missingStep);
          expectRefusedWithReason(readOutcome(stdout, SAMPLE_BUDGET));
        },
      ),
      propertyParameters(),
    );
  });

  it('reports incomplete with a reason when a step line is duplicated', () => {
    fc.assert(
      fc.property(
        valuesArb,
        fc.integer({ min: 0, max: SAMPLE_BUDGET - 1 }),
        fc.integer({ min: 0, max: 31 }),
        (values, dupStep, dupValue) => {
          const stdout = stdoutDuplicatedStep(values, NONCE, dupStep, BigInt(dupValue));
          expectRefusedWithReason(readOutcome(stdout, SAMPLE_BUDGET));
        },
      ),
      propertyParameters(),
    );
  });

  it(
    'reports incomplete with a reason when the end-marker count does not match the per-step ' +
      'line count',
    () => {
      fc.assert(
        fc.property(valuesArb, fc.integer({ min: 1, max: 5 }), (values, delta) => {
          const stdout = stdoutEndCountMismatch(values, NONCE, delta);
          expectRefusedWithReason(readOutcome(stdout, SAMPLE_BUDGET));
        }),
        propertyParameters(),
      );
    },
  );
});
