// stimulus-transaction-structure, Property 14: A period failing its constraints is refused,
// naming the first failed criterion (task 3.2, C2).
//
// THE ORACLE IS THE REQUIREMENT TEXT, RESTATED WITHOUT A FLOORED DIVISION
//   Criterion 3.4, with criterion 6.2's ceiling folded in, becomes two integer comparisons here
//   rather than one floored division: `period < 64` is the headroom floor, and
//   `SAMPLE_BUDGET < 16 * period` is "fewer than 16 whole Hold_Windows fit in one Sample_Budget"
//   multiplied out instead of divided, which agrees with `Math.floor(SAMPLE_BUDGET / period) < 16`
//   for every positive period and needs no division at all for a non-positive one. Criteria 3.5
//   and 3.6 are each already a single modulo check, as literal a restatement of the requirement
//   text as exists. Calling `periodConstraintFault`'s own arithmetic here would make this file
//   assert the function equals itself.
//
// THE CLAIM IS ABOUT ORDER, NOT ONLY OUTCOME
//   A period can fail more than one criterion, and the contract is which ONE comes back: the
//   first of 3.4, 3.5, 3.6 it fails, in that fixed order (Req 3.11). `fail-3.4-and-3.5` and
//   `fail-3.4-and-3.6` below are CONSTRUCTED rather than left to a wide integer draw that would
//   rarely land on a double failure by chance, per the vault's recorded rule for a closed-union
//   non-vacuity row:
//   chipAgent/_inbox/gotcha-a-closed-union-non-vacuity-row-should-be-exhausted-not-sampled.md
//   No period can fail BOTH 3.5 and 3.6 at once: 3.6's only failing periods in range are 64 and
//   128, and neither is a multiple of ENABLE_FRAME_PERIOD, so that ordering pair is unwitnessable
//   and carries no obligation below.
//
// Validates: Requirements 3.4, 3.5, 3.6, 3.11, 4.9, 6.2, 6.9

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { SAMPLE_BUDGET } from '@app/tools';
// Not re-exported through the `@app/tools` barrel (simulator/index.ts), so these are read from
// their own module directly, the convention `rendered-stimulus-enable.property.test.ts` already
// uses for `ENABLE_FRAME_PERIOD`.
import {
  ENABLE_FRAME_PERIOD,
  periodConstraintFault,
  RESET_FRAME_PERIOD,
  type PeriodConstraintFault,
} from '../tools/simulator/consensus-harness.js';

import { propertyParameters } from './property.js';

const PROPERTY =
  'stimulus-transaction-structure, Property 14: A period failing its constraints is refused, ' +
  'naming the first failed criterion';

/** The first of criteria 3.4, 3.5, 3.6 that `period` fails, re-derived from the requirement text. */
function expectedFault(period: number): PeriodConstraintFault | null {
  if (period < 64 || SAMPLE_BUDGET < 16 * period) return '3.4';
  if (period % ENABLE_FRAME_PERIOD === 0) return '3.5';
  if (RESET_FRAME_PERIOD % period === 0) return '3.6';
  return null;
}

/**
 * The seven period shapes this property must reach, named by what they make true rather than by
 * outcome, matching `timing-ordered-classification-rule.property.test.ts`'s `FactsKind` style.
 */
type PeriodShape =
  | 'pass'
  | 'fail-3.4-low'
  | 'fail-3.4-high'
  | 'fail-3.5'
  | 'fail-3.6'
  | 'fail-3.4-and-3.5'
  | 'fail-3.4-and-3.6';

const PERIOD_SHAPES: readonly PeriodShape[] = [
  'pass',
  'fail-3.4-low',
  'fail-3.4-high',
  'fail-3.5',
  'fail-3.6',
  'fail-3.4-and-3.5',
  'fail-3.4-and-3.6',
];

/** Every value in [64, 128] failing none of 3.4, 3.5 or 3.6 - the Strobe_Period's own range. */
const PASSING_PERIODS: readonly number[] = Array.from(
  { length: 65 },
  (_, index) => 64 + index,
).filter((period) => period % ENABLE_FRAME_PERIOD !== 0 && RESET_FRAME_PERIOD % period !== 0);

/** One concrete period for `shape`, drawn so every category stays reachable on every run. */
function periodArbitraryFor(shape: PeriodShape): fc.Arbitrary<number> {
  switch (shape) {
    case 'pass':
      return fc.constantFrom(...PASSING_PERIODS);
    case 'fail-3.4-low':
      // Below the 64-step floor; zero and negative periods land here too.
      return fc.integer({ min: -1_000, max: 63 });
    case 'fail-3.4-high':
      // Above the 128-step ceiling criterion 6.2's 16-whole-windows reading sets.
      return fc.integer({ min: 129, max: 4_000 });
    case 'fail-3.5':
      // ENABLE_FRAME_PERIOD's multiples inside [64, 128]: only 80, 100 and 120.
      return fc.constantFrom(80, 100, 120);
    case 'fail-3.6':
      // RESET_FRAME_PERIOD's only divisors inside [64, 128], since 256 is a power of two.
      return fc.constantFrom(64, 128);
    case 'fail-3.4-and-3.5':
      // Below 64 AND a multiple of 20 - the task's own example of a double failure.
      return fc.constantFrom(20, 40, 60);
    case 'fail-3.4-and-3.6':
      // Below 64 AND a divisor of 256, so 3.6 would also fire were 3.4 not checked first.
      return fc.constantFrom(1, 2, 4, 8, 16, 32);
  }
}

function scenarioArbitrary(): fc.Arbitrary<{ shape: PeriodShape; period: number }> {
  return fc
    .constantFrom(...PERIOD_SHAPES)
    .chain((shape) => periodArbitraryFor(shape).map((period) => ({ shape, period })));
}

describe(PROPERTY, () => {
  it('reports the first of 3.4, 3.5, 3.6 a period fails, or null when it fails none', () => {
    const reached = new Map<PeriodShape, number>();

    fc.assert(
      fc.property(scenarioArbitrary(), ({ shape, period }) => {
        reached.set(shape, (reached.get(shape) ?? 0) + 1);
        expect(periodConstraintFault(period)).toBe(expectedFault(period));
      }),
      propertyParameters(),
    );

    // NON-VACUITY: every shape, including both two-failure orderings, was drawn at least once -
    // which is what proves the fixed order was exercised rather than assumed.
    expect({
      pass: (reached.get('pass') ?? 0) > 0,
      fail34Low: (reached.get('fail-3.4-low') ?? 0) > 0,
      fail34High: (reached.get('fail-3.4-high') ?? 0) > 0,
      fail35: (reached.get('fail-3.5') ?? 0) > 0,
      fail36: (reached.get('fail-3.6') ?? 0) > 0,
      fail34And35: (reached.get('fail-3.4-and-3.5') ?? 0) > 0,
      fail34And36: (reached.get('fail-3.4-and-3.6') ?? 0) > 0,
    }).toEqual({
      pass: true,
      fail34Low: true,
      fail34High: true,
      fail35: true,
      fail36: true,
      fail34And35: true,
      fail34And36: true,
    });
  });
});
