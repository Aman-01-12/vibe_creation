// formal-property-oracle, Property 1: Proved holds exactly when all five conditions hold (task 5.4).
//
// WHAT IS UNDER TEST
//   `admitProved` in `app/tools/formal/conditions.ts`, the single owner of the five-condition rule
//   and the ONLY constructor of a `ProvedEvidence`. The claim is an IF AND ONLY IF, which is the
//   strongest available statement about a gate whose failing direction is a severity-1 defect: a
//   `Verified` label handed to an artifact the toolchain never actually checked.
//
// WHY AN IFF AND NOT TWO SEPARATE IMPLICATIONS
//   The two directions fail differently and both matter. `proved` where a condition failed is the
//   false proof - four independent mechanisms in one toolchain were MEASURED reporting
//   `Status: PASSED` for "not checked". `could-not-verify` where all five held is a gate that
//   refuses everything, which would read as safe while making the whole oracle useless and would
//   hide the first defect behind a wall of refusals. One `expect` over the two booleans catches
//   both, and it cannot be satisfied by a gate that is right in only one direction.
//
// HOW THE ASSERTION-COUNT CLAUSE IS PHRASED, AND WHY IT IS NOT "NON-ZERO"
//   design.md's Property 1 reads "the assertion count is non-zero". Asserted literally as
//   `count !== 0` this property FAILS, and it fails CORRECTLY, so the phrasing below is the fix
//   rather than a weakening of the claim.
//   `ProofConditions['assertionCount']` is a plain `number` because it was parsed out of a report
//   the worker wrote, and the guard behind the brand is `Number.isSafeInteger(count) && count > 0`.
//   `arbProofConditions()` deliberately generates the values that guard exists to refuse - `NaN`,
//   `-1`, `0.5`, `Infinity`, and a value above `Number.MAX_SAFE_INTEGER` - because otherwise the
//   `isSafeInteger` half of it is never exercised by any property in the suite. `NaN !== 0` is
//   `true`, and `admitProved` correctly returns `zero-assertions` for `NaN`, so an iff written as
//   `!== 0` reports a defect that is not there.
//   So the clause below is A POSITIVE SAFE INTEGER, which is what Req 2.8's "an absent count reads
//   as zero rather than as a satisfied precondition" means once the count is untrusted text: every
//   value that is not a real count is the same fact - we do not have a count.
//   `unusableCountCases` is asserted non-zero at the bottom of the test, because that share is
//   exactly what makes this phrasing load-bearing rather than pedantic: over a sample of clean
//   integers, `!== 0` and "positive safe integer" agree everywhere and the distinction is untested.
//
// WHY THE ORACLE IS A FLAT CONJUNCTION AND NOT A COPY OF THE GATE
//   `admitProved` is an ORDERED chain of five guards, each returning a CAUSE. The oracle below is a
//   single unordered conjunction of the five condition predicates and knows nothing about causes or
//   about the order. It is design.md's sentence, transcribed; it is not the implementation with the
//   names changed. The ORDER is Property 2's claim and is asserted in
//   `formal-cause-ordering.property.test.ts`; the cause VOCABULARY is asserted in
//   `formal-vocabulary.test.ts`.
//
// RUN COUNT: 2000, not the shared 100
//   The rarest required shape is the one the admitting direction needs - all five conditions
//   admitting at once - and `arbProofConditions()` weights each condition's admitting value 2
//   against 1 for each failing value, which works out to a MEASURED ~5.6% of draws (0.6 for a
//   usable count x 0.5 presat x 0.75 cover x 0.5 base x 0.5 induction). At the shared 100-run
//   default that is about 6 cases, which is thin for an iff and flaky besides: the miss probability
//   is `(1 - 0.056)^100` ~ 0.3%. At 2000 runs the expected count is ~112 and the miss probability
//   is ~1e-50. The recipe is the vault's: compute the share of the rarest required shape and size
//   `numRuns` to it, never weaken the claim to fit 100
//   (`chipAgent/_inbox/verification-recipe-every-row-coverage-needs-numruns-scaled-to-the-table.md`).
//   The whole property is object construction over a pure function, so 2000 runs is a fraction of a
//   second.
//
// The tag string is a literal, not `propertyTag(...)`: that helper's `FEATURE_TAG` is hardcoded to a
// different spec's property numbering
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// **Validates: Requirements 1.2, 1.3, 1.4, 2.3, 4.2, 5.3, 5.7, 7.3, 8.3, 11.13**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { admitProved, type ProofConditions } from '@app/tools';

import { arbProofConditions } from './formal-arbitraries.js';
import { propertyParameters } from './property.js';

// **Feature: formal-property-oracle, Property 1: Proved holds exactly when all five conditions
// hold**
const PROPERTY =
  'formal-property-oracle, Property 1: Proved holds exactly when all five conditions hold';

/** See the RUN COUNT note in the header: the all-five-admitting draw is ~5.6% of the sample. */
const NUM_RUNS = 2000;

/**
 * Whether the recorded assertion count is A POSITIVE SAFE INTEGER.
 *
 * See the header: this is design.md's "non-zero" clause phrased for a field whose value came out of
 * an untrusted report, where `NaN`, `Infinity`, `-1`, `0.5`, and anything above
 * `Number.MAX_SAFE_INTEGER` all mean "we do not have a count" rather than "we have a count that
 * happens not to be zero".
 */
function countedAtLeastOneAssertion(count: number): boolean {
  return Number.isSafeInteger(count) && count > 0;
}

/** Whether the count is non-zero yet still unusable: the share that makes the phrasing matter. */
function isUnusableButNonZero(count: number): boolean {
  return count !== 0 && !countedAtLeastOneAssertion(count);
}

/**
 * design.md's Property 1, transcribed: the five conditions in their admitting form.
 *
 * A flat conjunction, deliberately - no order, no causes. The cover clause is spelled as its two
 * ADMITTING shapes rather than as `!== false`, so a fourth `CoverCondition` member added later does
 * not silently admit a proof here: it would read as not-admitting, which is the same fail-safe
 * direction `ProvedEvidence` takes by spelling its two admitting shapes out.
 */
function allFiveConditionsHold(conditions: ProofConditions): boolean {
  return (
    countedAtLeastOneAssertion(conditions.assertionCount) &&
    conditions.presat === 'satisfiable' &&
    (conditions.cover.reached === true || conditions.cover.reached === 'not-applicable') &&
    conditions.base === 'passed' &&
    conditions.induction === 'successful'
  );
}

describe(PROPERTY, () => {
  it('admits a proof exactly when the count, presat, cover, base case, and induction all hold', () => {
    let total = 0;
    let admittingCases = 0;
    let refusingCases = 0;
    let unusableCountCases = 0;
    let notApplicableCoverCases = 0;
    fc.assert(
      fc.property(arbProofConditions(), (conditions: ProofConditions) => {
        total += 1;
        if (isUnusableButNonZero(conditions.assertionCount)) {
          unusableCountCases += 1;
        }
        if (conditions.cover.reached === 'not-applicable') {
          notApplicableCoverCases += 1;
        }
        const admission = admitProved(conditions);
        const provedHolds = typeof admission !== 'string';
        // The iff itself. The conditions are NOT folded into the expectation: fast-check prints the
        // shrunk counterexample, so a deep comparison against them per run buys nothing and costs a
        // structural equality on every one of 2000 draws.
        expect(provedHolds).toBe(allFiveConditionsHold(conditions));
        if (!provedHolds) {
          refusingCases += 1;
          return;
        }
        admittingCases += 1;
        // The evidence carries THE RUN's five facts, not a default set. Without this an evidence
        // assembled from admitting literals rather than from the input would satisfy the iff while
        // discarding the step a cover was reached at and the count that was actually observed.
        expect(admission).toEqual({
          assertionCount: conditions.assertionCount,
          presat: conditions.presat,
          cover: conditions.cover,
          base: conditions.base,
          induction: conditions.induction,
        });
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );
    // Non-vacuity. An iff over a sample that only ever refuses is a one-directional claim wearing
    // an iff's clothes, and this repository has already shipped a property test that silently
    // stopped exercising the shape it was about
    // (`chipAgent/_inbox/gotcha-golden-denominator-property-test-was-vacuous-for-new-status.md`).
    expect(total).toBe(NUM_RUNS);
    expect(admittingCases).toBeGreaterThan(0);
    expect(refusingCases).toBeGreaterThan(0);
    // Without these the "positive safe integer" phrasing is indistinguishable from `!== 0`.
    expect(unusableCountCases).toBeGreaterThan(0);
    // The `not-applicable` cover ADMITS, so it is the shape that separates "reached or
    // not-applicable" from "reached".
    expect(notApplicableCoverCases).toBeGreaterThan(0);
  });
});
