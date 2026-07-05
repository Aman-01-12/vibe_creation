// Property 7: Runner outcomes classify to exactly one verdict, with error
// reserved for tool/infra failure (task 2.3).
//
// This is the universal property complement to the verdict logic in
// `app/core/verdict`. It asserts, over many generated `InvocationOutcome`
// values, the guarantees `classifyVerdict` must never break
// (Design: Property 7; Req 1.4, 1.5, 8.7):
//
//   1. Totality and single-valued: every outcome maps to exactly one of
//      `pass` / `fail` / `error`, and the classifier is deterministic, so
//      overlapping signals still resolve to one stable verdict.
//   2. `error` is reserved for tool/infra/incomplete conditions: it is returned
//      if and only if the run timed out, hit a tool failure, did not complete,
//      or completed with zero spec-derived checks - never for a functional
//      check failure.
//   3. A functional check failure (completed, >=1 check, at least one failed) is
//      `fail`, never `error`, so tool/infra faults stay distinct from a real
//      functional failure.
//   4. `pass` is returned if and only if the run completed with at least one
//      check and every check passed.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { classifyVerdict, type CheckResult, type InvocationOutcome } from '@app/core';
import { propertyParameters, propertyTag } from '@app/test';

const PROPERTY = propertyTag(
  7,
  'Runner outcomes classify to exactly one verdict, with error reserved for tool/infra failure',
);

// -- Generators -------------------------------------------------------------

/** The closed set of verdicts a classification may ever produce. */
const ALL_VERDICTS = ['pass', 'fail', 'error'] as const;

/** One spec-derived check with an arbitrary name and pass/fail flag. */
const checkArbitrary: fc.Arbitrary<CheckResult> = fc.record({
  name: fc.string(),
  passed: fc.boolean(),
});

/** A check set that spans the empty case and several-check runs. */
const checksArbitrary: fc.Arbitrary<readonly CheckResult[]> = fc.array(checkArbitrary, {
  maxLength: 6,
});

/**
 * The full input space: the three orthogonal Tool_Runner signals crossed with an
 * arbitrary check set, including empty and mixed pass/fail sets.
 */
const outcomeArbitrary: fc.Arbitrary<InvocationOutcome> = fc.record({
  timedOut: fc.boolean(),
  toolFailure: fc.boolean(),
  completed: fc.boolean(),
  checks: checksArbitrary,
});

/**
 * A "good run" subspace: completed, no tool/infra fault, and at least one check.
 * This is exactly the space where the pass/fail split is decided, so it makes
 * the pass and functional-fail facets non-vacuous rather than mostly-error.
 */
const goodRunArbitrary: fc.Arbitrary<InvocationOutcome> = fc
  .array(checkArbitrary, { minLength: 1, maxLength: 6 })
  .map((checks) => ({ timedOut: false, toolFailure: false, completed: true, checks }));

/** Whether an outcome should classify as `error` per the reserved-error rule. */
function errorIsReserved(outcome: InvocationOutcome): boolean {
  return (
    outcome.timedOut || outcome.toolFailure || !outcome.completed || outcome.checks.length === 0
  );
}

// -- Property 7 -------------------------------------------------------------

describe(PROPERTY, () => {
  it('maps every outcome to exactly one verdict and is deterministic', () => {
    fc.assert(
      fc.property(outcomeArbitrary, (outcome) => {
        const verdict = classifyVerdict(outcome);

        // Single-valued: the result is a member of the closed verdict set.
        expect(ALL_VERDICTS).toContain(verdict);
        // Deterministic: overlapping signals still resolve to one stable verdict.
        expect(classifyVerdict(outcome)).toBe(verdict);
      }),
      propertyParameters(),
    );
  });

  it('returns error if and only if the failure is tool/infra/incomplete', () => {
    fc.assert(
      fc.property(outcomeArbitrary, (outcome) => {
        const isError = classifyVerdict(outcome) === 'error';

        expect(isError).toBe(errorIsReserved(outcome));
      }),
      propertyParameters(),
    );
  });

  it('never classifies a functional check failure as error', () => {
    fc.assert(
      fc.property(goodRunArbitrary, (outcome) => {
        const anyCheckFailed = outcome.checks.some((check) => !check.passed);
        fc.pre(anyCheckFailed);

        // A completed run with a real failed check is a functional fail, not error.
        expect(classifyVerdict(outcome)).toBe('fail');
      }),
      propertyParameters(),
    );
  });

  it('returns pass if and only if the run completed with >=1 check all passing', () => {
    fc.assert(
      fc.property(outcomeArbitrary, (outcome) => {
        const isPass = classifyVerdict(outcome) === 'pass';
        const shouldPass =
          !outcome.timedOut &&
          !outcome.toolFailure &&
          outcome.completed &&
          outcome.checks.length > 0 &&
          outcome.checks.every((check) => check.passed);

        expect(isPass).toBe(shouldPass);
      }),
      propertyParameters(),
    );
  });
});
