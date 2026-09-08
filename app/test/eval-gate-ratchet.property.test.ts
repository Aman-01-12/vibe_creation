// Property 28: The eval-gate block decision follows the ratcheting rule
// (task 19.2).
//
// This is the universal complement to the pure ratcheting eval-gate in
// `app/core/eval-gate`. It asserts, over many generated gates, measurements,
// and baselines, the guarantees the CI eval gate must never break
// (Design: Property 28; Req 15.4, 15.7, 15.8, 15.9, 15.11):
//
//   1. Block decision (Req 15.4, 15.7, 15.8): the gate blocks iff it is armed
//      AND (measured pass@k is at/below the absolute floor OR strictly below
//      `baseline - tolerance`), and the typed reason matches. Expectations are
//      derived independently of `decideEvalGate` from the same public inputs.
//   2. Equal-to-baseline never blocks (Req 15.4): an armed gate measured exactly
//      at its baseline always allows, with the `within-tolerance` reason. This is
//      structural because `makeArmedGate` enforces `floor < baseline`.
//   3. An unarmed gate never blocks on this criterion (Req 15.7): whatever the
//      measurement, the decision is allow with the `unarmed` reason.
//   4. The baseline ratchets up only (Req 15.9): `ratchetBaseline` never lowers
//      the recorded baseline; it rises to the measured value exactly when the
//      measurement is strictly above the current baseline, and is unchanged
//      otherwise, so the high-water mark can only climb through this path.
//   5. Reviewed lowering is the only lowering path (Req 15.9, 15.11): a genuine
//      approved strict decrease is accepted (and it is a real decrease, never a
//      raise), while a missing approval, an empty reason, or a non-decreasing
//      target is refused - so the baseline cannot silently drift down.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  decideEvalGate,
  lowerBaselineWithReview,
  makeArmedGate,
  makeEvalBaseline,
  makePassAtK,
  ratchetBaseline,
  UNARMED_GATE,
  type ArmedGate,
  type EvalBaseline,
  type EvalGate,
  type PassAtK,
  type ReviewedLowering,
} from '@app/core';
import { propertyParameters, propertyTag } from '@app/test';

const PROPERTY = propertyTag(28, 'The eval-gate block decision follows the ratcheting rule');

// -- Unwrap helpers ---------------------------------------------------------
// The `make*` constructors validate untrusted numbers and return a Result. The
// generators below only ever feed them in-range values, so a failure here is a
// generator bug and must fail the property loudly rather than be swallowed.

/** Unwrap a validated pass@k or fail the property loudly (never expected). */
function buildPassAtK(value: number): PassAtK {
  const result = makePassAtK(value);
  if (!result.ok) {
    throw new Error(`generated pass@k invalid: ${result.error.code}`);
  }
  return result.value;
}

/** Unwrap a validated baseline or fail the property loudly (never expected). */
function buildBaseline(value: number): EvalBaseline {
  const result = makeEvalBaseline(value);
  if (!result.ok) {
    throw new Error(`generated baseline invalid: ${result.error.code}`);
  }
  return result.value;
}

/** Unwrap a validated armed gate or fail the property loudly (never expected). */
function buildArmedGate(baseline: number, tolerance: number, floor: number): ArmedGate {
  const result = makeArmedGate({ baseline, tolerance, floor });
  if (!result.ok) {
    throw new Error(`generated armed gate invalid: ${result.error.code}`);
  }
  return result.value;
}

// -- Generators -------------------------------------------------------------
//
// pass@k, baseline, and floor are fractions of solved problems over a fixed,
// finite benchmark subset, so their meaningful values are ordinary probabilities
// in `[0, 1]`, never sub-normal doubles. The baseline is drawn from a
// non-degenerate lower bound (`MIN_BASELINE`) so the derived floor and reviewed
// lowering stay a representable step away from it rather than underflowing to a
// value that rounds equal to the baseline or to zero. This constrains generator
// validity, not the rule under test: `measured` and the floor still span their
// full ranges, so every decision boundary is exercised.

/** Smallest baseline generated: well inside the normal-double range (Req 15.7). */
const MIN_BASELINE = 1e-3;
/** Widest gap fraction below a value, keeping a derived child strictly under it. */
const MAX_CHILD_FRACTION = 0.999;

/** A finite probability in `[0, 1]`: the shape of a measured pass@k. */
const probabilityArbitrary: fc.Arbitrary<number> = fc.double({
  min: 0,
  max: 1,
  noNaN: true,
  noDefaultInfinity: true,
});

/** A measured pass@k over the benchmark subset, spanning the whole `[0, 1]` range. */
const measuredArbitrary: fc.Arbitrary<PassAtK> = probabilityArbitrary.map(buildPassAtK);

/** A recorded ratcheting baseline in `[MIN_BASELINE, 1]` (always positive, Req 15.7). */
const baselineArbitrary: fc.Arbitrary<EvalBaseline> = fc
  .double({ min: MIN_BASELINE, max: 1, noNaN: true, noDefaultInfinity: true })
  .map(buildBaseline);

/**
 * A valid armed gate built through the real constructor, so every gate invariant
 * holds: baseline in `[MIN_BASELINE, 1]`, tolerance a finite non-negative delta,
 * floor in `[0, 1]`, and `floor < baseline`.
 *
 * The floor is derived as `baseline * fraction` with the fraction in
 * `[0, MAX_CHILD_FRACTION]`, which keeps it in `[0, baseline)` a representable
 * step below the baseline. The tolerance is allowed to exceed the baseline so the
 * `baseline - tolerance < 0` corner (where only the floor can block) is
 * exercised, not just the small-tolerance case.
 */
const armedGateArbitrary: fc.Arbitrary<ArmedGate> = fc
  .record({
    baseline: fc.double({ min: MIN_BASELINE, max: 1, noNaN: true, noDefaultInfinity: true }),
    floorFraction: fc.double({
      min: 0,
      max: MAX_CHILD_FRACTION,
      noNaN: true,
      noDefaultInfinity: true,
    }),
    tolerance: fc.double({ min: 0, max: 2, noNaN: true, noDefaultInfinity: true }),
  })
  .map(({ baseline, floorFraction, tolerance }) =>
    buildArmedGate(baseline, tolerance, baseline * floorFraction),
  );

/** The full gate space: an unarmed gate plus every kind of valid armed gate. */
const gateArbitrary: fc.Arbitrary<EvalGate> = fc.oneof(
  fc.constant<EvalGate>(UNARMED_GATE),
  armedGateArbitrary,
);

// -- Independent expectation ------------------------------------------------
// Re-derive the decision from the same public inputs, WITHOUT calling
// `decideEvalGate`, so the property checks the production logic against an
// independent statement of the rule rather than against itself.

type ExpectedReason =
  'unarmed' | 'at-or-below-floor' | 'below-baseline-minus-tolerance' | 'within-tolerance';

interface ExpectedDecision {
  readonly blocked: boolean;
  readonly reason: ExpectedReason;
}

/**
 * The rule from Property 28, stated directly: an unarmed gate always allows; an
 * armed gate blocks at/below the floor (catastrophic, checked first because it
 * holds regardless of the baseline) or strictly below `baseline - tolerance`
 * (a real regression beyond noise); otherwise it allows within tolerance.
 */
function expectedDecision(measured: PassAtK, gate: EvalGate): ExpectedDecision {
  if (!gate.armed) {
    return { blocked: false, reason: 'unarmed' };
  }
  if (measured.value <= gate.floor) {
    return { blocked: true, reason: 'at-or-below-floor' };
  }
  if (measured.value < gate.baseline - gate.tolerance) {
    return { blocked: true, reason: 'below-baseline-minus-tolerance' };
  }
  return { blocked: false, reason: 'within-tolerance' };
}

// -- Reviewed-lowering generators -------------------------------------------

/** A non-empty, non-whitespace justification for a reviewed lowering. */
const reasonArbitrary: fc.Arbitrary<string> = fc
  .string({ unit: 'grapheme', minLength: 1 })
  .filter((text) => text.trim().length > 0);

/** A whitespace-only (or empty) reason, which a reviewed lowering must refuse. */
const blankReasonArbitrary: fc.Arbitrary<string> = fc.constantFrom(
  '',
  ' ',
  '   ',
  '\t',
  '\n',
  ' \t\n ',
);

/**
 * A current baseline paired with a genuine strictly-lower target in `(0, current)`.
 * The target is `current * fraction` with the fraction in `(0, 1)`, so it stays a
 * valid positive baseline strictly below the current one.
 */
const genuineLoweringArbitrary: fc.Arbitrary<{
  readonly current: EvalBaseline;
  readonly newBaseline: number;
  readonly reason: string;
}> = fc
  .record({
    current: baselineArbitrary,
    fraction: fc.double({
      min: MIN_BASELINE,
      max: MAX_CHILD_FRACTION,
      noNaN: true,
      noDefaultInfinity: true,
    }),
    reason: reasonArbitrary,
  })
  .map(({ current, fraction, reason }) => ({
    current,
    newBaseline: current.value * fraction,
    reason,
  }));

// -- Property 28 ------------------------------------------------------------

describe(PROPERTY, () => {
  it('blocks iff armed and (at/below floor or below baseline minus tolerance), with the matching reason', () => {
    fc.assert(
      fc.property(measuredArbitrary, gateArbitrary, (measured, gate) => {
        const decision = decideEvalGate(measured, gate);
        const expected = expectedDecision(measured, gate);

        // The blocked flag and its typed reason both agree with the independent
        // statement of the rule (Req 15.4, 15.7, 15.8).
        expect(decision.blocked).toBe(expected.blocked);
        expect(decision.reason).toBe(expected.reason);

        // A block only ever happens on an armed gate.
        if (decision.blocked) {
          expect(gate.armed).toBe(true);
        }
      }),
      propertyParameters(),
    );
  });

  it('never blocks an armed gate measured exactly at its baseline', () => {
    fc.assert(
      fc.property(armedGateArbitrary, (gate) => {
        const measured = buildPassAtK(gate.baseline);
        const decision = decideEvalGate(measured, gate);

        // Equal-to-baseline is always within tolerance, because makeArmedGate
        // guarantees floor < baseline and tolerance >= 0 (Req 15.4).
        expect(decision.blocked).toBe(false);
        expect(decision.reason).toBe('within-tolerance');
      }),
      propertyParameters(),
    );
  });

  it('never blocks while the gate is unarmed, whatever the measurement', () => {
    fc.assert(
      fc.property(measuredArbitrary, (measured) => {
        const decision = decideEvalGate(measured, UNARMED_GATE);

        // The unarmed gate defers to the other CI gates (Req 15.7).
        expect(decision.blocked).toBe(false);
        expect(decision.reason).toBe('unarmed');
      }),
      propertyParameters(),
    );
  });

  it('ratchets the baseline up only, never down', () => {
    fc.assert(
      fc.property(baselineArbitrary, measuredArbitrary, (current, measured) => {
        const next = ratchetBaseline(current, measured);

        // The high-water mark never drops (Req 15.9).
        expect(next.value).toBeGreaterThanOrEqual(current.value);

        if (measured.value > current.value) {
          // A strictly higher measurement raises the baseline to it.
          expect(next.value).toBe(measured.value);
        } else {
          // Anything at or below leaves the baseline untouched (no lowering here).
          expect(next.value).toBe(current.value);
        }
      }),
      propertyParameters(),
    );
  });

  it('accepts a reviewed, approved, strictly-lower baseline as the only lowering path', () => {
    fc.assert(
      fc.property(genuineLoweringArbitrary, ({ current, newBaseline, reason }) => {
        const lowering: ReviewedLowering = { newBaseline, approved: true, reason };
        const result = lowerBaselineWithReview(current, lowering);

        // A genuine approved decrease is the one sanctioned way the baseline drops.
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.value).toBe(newBaseline);
          // It is always a real lowering, never a raise (a raise must ratchet).
          expect(result.value.value).toBeLessThan(current.value);
        }
      }),
      propertyParameters(),
    );
  });

  it('refuses a reviewed lowering that is not a genuine approved decrease', () => {
    fc.assert(
      fc.property(
        baselineArbitrary,
        measuredArbitrary,
        reasonArbitrary,
        blankReasonArbitrary,
        (current, target, reason, blankReason) => {
          // Missing approval: approved must be the literal true, so a false flag
          // (constructed via a cast to reach the runtime guard) is refused.
          const unapproved = {
            newBaseline: current.value / 2,
            approved: false,
            reason,
          } as unknown as ReviewedLowering;
          expect(lowerBaselineWithReview(current, unapproved).ok).toBe(false);

          // Empty / whitespace reason is refused even when approved.
          const blank: ReviewedLowering = {
            newBaseline: current.value / 2,
            approved: true,
            reason: blankReason,
          };
          expect(lowerBaselineWithReview(current, blank).ok).toBe(false);

          // A non-decreasing target (equal or higher) is refused: a raise or a
          // no-op must go through ratchetBaseline, never through review (Req 15.9).
          const notLower: ReviewedLowering = {
            newBaseline: current.value + target.value,
            approved: true,
            reason,
          };
          fc.pre(notLower.newBaseline >= current.value);
          expect(lowerBaselineWithReview(current, notLower).ok).toBe(false);
        },
      ),
      propertyParameters(),
    );
  });
});
