// formal-property-oracle, Property 2: A could-not-verify carries exactly one cause, and it is the
// first failure in the fixed order (task 5.5).
//
// WHY THE ORDER IS A CORRECTNESS CLAIM AND NOT A PREFERENCE
//   Each EARLIER condition, when it fails, makes every later condition's verdict MEANINGLESS, so
//   reporting a later cause names a symptom and hides the cause. Measured, in the order the gate
//   evaluates: zero assertions make every subsequent `Status:` a statement about an EMPTY problem;
//   contradictory assumptions make a proof VACUOUSLY succeed, so a later base-case pass and a later
//   induction success are artifacts of the contradiction; an unreached antecedent means the
//   assertion was never triggered, so the base case passes vacuously; and a base-case failure is
//   only a counterexample once the assumptions are consistent and the antecedent was reached. A
//   gate that reported the LAST failure, or the failure of whichever check finished first, would be
//   handing a reader a remedy for the wrong problem on every multi-failure run.
//   So this property is asserted over conditions with TWO OR MORE failures, which is the only
//   sample in which an ordering claim can fail at all: over single-failure cases every order agrees.
//
// HOW "THE FIRST FAILURE IN THE FIXED ORDER" IS ASSERTED WITHOUT RE-SPELLING THE GATE
//   The test knows exactly one thing about the implementation: the ORDER design.md states -
//   assertion count, presat, antecedent reachability, base case, induction. That is the claim, so
//   stating it is the point. What it deliberately does NOT restate is the CAUSE MAP - which cause a
//   given failing value reports - because a test that re-spells `preunsat -> contradictory
//   -assumptions` asserts only that the code equals itself.
//   Instead the expected cause is DERIVED from the gate's own SINGLE-FAILURE behaviour: take the
//   generated conditions, repair every condition AFTER the earliest failing one to its admitting
//   value, and ask the gate what that one remaining failure reports. The claim then reads "a
//   multi-failure run reports exactly what its earliest failure alone would report", which is
//   falsifiable by every wrong order:
//     - a gate reporting the LAST failure returns the later condition's cause and fails here;
//     - a gate checking induction before the base case returns `induction-inconclusive` where the
//       probe returns the base case's cause, and fails here;
//     - a gate checking presat before the assertion count returns
//       `contradictory-assumptions` where the probe returns `zero-assertions`, and fails here.
//   The probe is asserted to carry EXACTLY ONE failing condition before it is used, so a drifted
//   repair helper fails loudly instead of quietly turning the oracle into the gate itself.
//
// THE PRE-PASS CAUSES, AND WHY THEIR ABSENCE IS THE ASSERTABLE HALF OF Req 1.18
//   `reset-contract-unresolved` and `clock-contract-unsupported` are reported by the
//   Reset_Contract_Prepass AHEAD OF THE WHOLE FIXED ORDER, with no Proof_Condition evaluated: the
//   pre-pass runs over the design alone, before a Property_Wrapper exists, so there is no
//   `ProofConditions` value for them to be taken over. The pre-pass itself lands in group 16. What
//   is assertable here and now is the half that must stay true whatever group 16 does - NO
//   `ProofConditions` value, however malformed, can make the fixed order report a cause that
//   belongs ahead of it
//   (`chipAgent/_inbox/gotcha-base-condition-field-is-base-not-basecase-and-admitproved-returns-only-eight-of-eleven-causes.md`).
//
// RUN COUNT: 1000, not the shared 100
//   The sample is filtered to two-or-more failures, which is ~72% of `arbProofConditions()` draws.
//   The rarest required shape within it is "the earliest failure is the BASE CASE with the induction
//   check also failing" - a usable count (0.6) x satisfiable presat (0.5) x reached cover (0.75) x
//   failing base (0.5) x failing induction (0.5) ~ 5.6% of unfiltered draws, so ~7.8% of the
//   filtered sample. At 100 runs the miss probability is ~0.03%; at 1000 it is ~6e-36, and the
//   expected count is ~78. Recipe from
//   `chipAgent/_inbox/verification-recipe-every-row-coverage-needs-numruns-scaled-to-the-table.md`.
//
// The tag string is a literal, not `propertyTag(...)`, whose `FEATURE_TAG` is hardcoded to a
// different spec's property numbering
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// **Validates: Requirements 1.5, 1.7, 4.3, 5.7, 7.2, 11.7**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  admitProved,
  COULD_NOT_VERIFY_CAUSES,
  type CouldNotVerifyCause,
  type ProofConditions,
} from '@app/tools';

import { arbProofConditions } from './formal-arbitraries.js';
import { propertyParameters } from './property.js';

// **Feature: formal-property-oracle, Property 2: A could-not-verify carries exactly one cause, and
// it is the first failure in the fixed order**
const PROPERTY =
  'formal-property-oracle, Property 2: A could-not-verify carries exactly one cause, and it is the first failure in the fixed order';

/** See the RUN COUNT note: the rarest required shape is ~7.8% of the filtered sample. */
const NUM_RUNS = 1000;

/** The smallest number of failing conditions an ordering claim can be asserted over. */
const MIN_FAILURES = 2;

/**
 * The two causes reported AHEAD of the whole fixed order, by the pre-pass rather than by the gate.
 *
 * Named here as an EXCLUSION, which is the direction this file can assert: no `ProofConditions`
 * value may produce either of them (Req 1.18).
 */
const PREPASS_CAUSES: readonly CouldNotVerifyCause[] = Object.freeze([
  'reset-contract-unresolved',
  'clock-contract-unsupported',
]);

/**
 * design.md's fixed order, one predicate per condition, in the order it names them.
 *
 * The assertion-count predicate is "not a positive safe integer" rather than "zero", for the reason
 * `formal-five-condition-gate.property.test.ts` records at length: `arbProofConditions()` generates
 * `NaN`, `Infinity`, `-1`, `0.5`, and a value above `Number.MAX_SAFE_INTEGER`, and every one of them
 * means "we do not have a count" rather than "we have one that is not zero".
 */
const CONDITION_FAILED: readonly ((conditions: ProofConditions) => boolean)[] = Object.freeze([
  (conditions) =>
    !(Number.isSafeInteger(conditions.assertionCount) && conditions.assertionCount > 0),
  (conditions) => conditions.presat !== 'satisfiable',
  (conditions) => conditions.cover.reached === false,
  (conditions) => conditions.base !== 'passed',
  (conditions) => conditions.induction !== 'successful',
]);

/** The same five conditions' names, for a failure message that says WHICH one was earliest. */
const CONDITION_NAMES: readonly string[] = Object.freeze([
  'assertion count',
  'presat',
  'antecedent reachability',
  'base case',
  'induction',
]);

/**
 * The five conditions in their admitting form, used to repair the conditions AFTER the earliest
 * failure so a single-failure probe can be built.
 *
 * `step: 0` is arbitrary and carries no meaning: the cover condition admits on `reached: true`
 * whatever the step, and no step value is read by the gate.
 */
const ADMITTING_CONDITIONS: ProofConditions = Object.freeze({
  assertionCount: 1,
  presat: 'satisfiable',
  cover: { reached: true, step: 0 },
  base: 'passed',
  induction: 'successful',
});

/** How many of the five conditions fail. */
function failureCount(conditions: ProofConditions): number {
  return CONDITION_FAILED.filter((failed) => failed(conditions)).length;
}

/** The index of the first failing condition in the fixed order, or `-1` when all five hold. */
function earliestFailureIndex(conditions: ProofConditions): number {
  return CONDITION_FAILED.findIndex((failed) => failed(conditions));
}

/**
 * The same conditions with every condition AFTER `earliest` replaced by its admitting value.
 *
 * Everything BEFORE `earliest` is already admitting by definition of "earliest", so the result
 * carries exactly one failing condition - which the caller asserts rather than assumes, because the
 * index-to-field mapping here is hand-written and a drift would silently turn the oracle into a
 * second copy of the gate.
 */
function withEveryLaterConditionRepaired(
  conditions: ProofConditions,
  earliest: number,
): ProofConditions {
  const keep = (index: number): boolean => index <= earliest;
  return {
    assertionCount: keep(0) ? conditions.assertionCount : ADMITTING_CONDITIONS.assertionCount,
    presat: keep(1) ? conditions.presat : ADMITTING_CONDITIONS.presat,
    cover: keep(2) ? conditions.cover : ADMITTING_CONDITIONS.cover,
    base: keep(3) ? conditions.base : ADMITTING_CONDITIONS.base,
    induction: keep(4) ? conditions.induction : ADMITTING_CONDITIONS.induction,
  };
}

/** The gate's answer as a cause, or a loud failure naming what came back instead. */
function refusalOf(conditions: ProofConditions): CouldNotVerifyCause {
  const admission = admitProved(conditions);
  if (typeof admission !== 'string') {
    throw new Error(
      `expected a refusal for ${JSON.stringify(conditions)}, got admitting evidence instead`,
    );
  }
  return admission;
}

describe(PROPERTY, () => {
  it('reports exactly what the earliest failing condition alone would report', () => {
    let total = 0;
    const earliestObserved = new Set<string>();
    const causesObserved = new Set<CouldNotVerifyCause>();
    fc.assert(
      fc.property(
        arbProofConditions().filter((conditions) => failureCount(conditions) >= MIN_FAILURES),
        (conditions: ProofConditions) => {
          total += 1;
          // The filter is asserted rather than trusted: a single-failure case would make every
          // ordering claim below hold for a reason that says nothing about the order. fast-check
          // reports the offending conditions itself, so the bare bound is the whole message.
          expect(failureCount(conditions)).toBeGreaterThanOrEqual(MIN_FAILURES);

          const earliest = earliestFailureIndex(conditions);
          const earliestName = CONDITION_NAMES.at(earliest) ?? 'none';
          earliestObserved.add(earliestName);

          // The oracle: the SAME gate, asked about the earliest failure ALONE. Derived, never a
          // restatement of the cause map.
          const probe = withEveryLaterConditionRepaired(conditions, earliest);
          expect({ probeFailures: failureCount(probe), probe }).toEqual({
            probeFailures: 1,
            probe,
          });
          const expectedCause = refusalOf(probe);

          const cause = refusalOf(conditions);
          causesObserved.add(cause);
          // The earliest failing condition's name travels with the comparison, because that is the
          // one fact fast-check's printed counterexample does not spell out for a reader.
          expect({ cause, earliestName }).toEqual({ cause: expectedCause, earliestName });
          // Exactly ONE cause, drawn from the closed vocabulary. The "exactly one" half is
          // structural - `admitProved` returns a single value and the `could-not-verify` member
          // carries a single `cause` field - so what is left to assert is that the value is a
          // member of the vocabulary rather than free prose.
          expect(COULD_NOT_VERIFY_CAUSES).toContain(cause);
          // Req 1.18: the pre-pass's two causes are reported ahead of the whole fixed order, with
          // no Proof_Condition evaluated, so the order can never produce them.
          expect(PREPASS_CAUSES).not.toContain(cause);
        },
      ),
      propertyParameters({ numRuns: NUM_RUNS }),
    );
    // Non-vacuity. An ordering claim is only asserted where the earliest failure VARIES: if every
    // draw had failed at the assertion count, the four later positions would be untested.
    expect(total).toBe(NUM_RUNS);
    // The induction check is last, so it cannot be the earliest failure of a two-or-more-failure
    // case - there would be no later condition to also fail. The other four must all appear.
    expect(earliestObserved).toEqual(
      new Set(['assertion count', 'presat', 'antecedent reachability', 'base case']),
    );
    // More than one cause observed, so the equality above is not holding over a single constant.
    expect(causesObserved.size).toBeGreaterThan(1);
  });
});
