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
//   2. `error` is reserved for tool/infra/incomplete/unreadable conditions: it is
//      returned if and only if the run timed out, was killed for exceeding its
//      workspace disk cap, hit a tool failure, did not complete, completed with zero
//      readable spec-derived checks, or - while every readable check passed - either
//      emitted a check signal the reader could not parse or had its output truncated
//      by the Tool_Runner's memory bound. Never for a functional check failure.
//   3. A functional check failure (completed, >=1 check, at least one failed) is
//      `fail`, never `error`, so tool/infra faults stay distinct from a real
//      functional failure. This holds even when the run ALSO emitted an unreadable
//      signal or was truncated: a definite failing check is the stronger fact. It
//      does NOT hold when a resource bound killed the run, which is the point of the
//      two disk facets below: that run never finished its stimulus, so there is no
//      functional verdict to report.
//   4. `pass` is returned if and only if the run completed with at least one
//      readable check, every readable check passed, NO resource bound killed it,
//      NOTHING it signalled was unreadable, and its output was not truncated. Those
//      last three clauses are the fail-safe: a run we terminated part-way, a `CHECK`
//      line the reader could not parse, and a `CHECK ... FAIL` line among bytes the
//      runner had to discard all verified nothing - and a `pass` that ignores any of
//      them is exactly how a failing design gets `Verified`.

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
 * How many `CHECK`-like lines the reader could not turn into a (name, status) pair.
 *
 * Weighted toward zero so the pass/fail split stays well-populated, while the
 * non-zero tail keeps the unreadable-signal facet non-vacuous.
 */
const unreadableArbitrary: fc.Arbitrary<number> = fc.oneof(
  { arbitrary: fc.constant(0), weight: 3 },
  { arbitrary: fc.nat({ max: 4 }), weight: 1 },
);

/**
 * Whether the stream the checks were read from was truncated by the Tool_Runner's
 * output bound.
 *
 * Weighted toward `false` for the same reason as the unreadable count: the pass /
 * fail split stays well-populated while the `true` tail keeps the truncation facet
 * non-vacuous.
 */
const truncatedArbitrary: fc.Arbitrary<boolean> = fc.oneof(
  { arbitrary: fc.constant(false), weight: 3 },
  { arbitrary: fc.constant(true), weight: 1 },
);

/**
 * Whether a resource bound on WORKSPACE DISK killed the run mid-flight.
 *
 * Weighted toward `false` for the same reason as the other two evidence signals:
 * a disk-cap kill classifies `error` on its own, so generating it uniformly would
 * starve the pass/fail split, while the `true` tail keeps the disk facet
 * non-vacuous. It is GENERATED and never pinned here, because this arbitrary is
 * the full input space: a field pinned to `false` would leave the `error`-iff and
 * `pass`-iff properties below unable to see the new signal at all, which is a
 * silent loss of exactly the coverage those two properties exist to provide.
 */
const diskKilledArbitrary: fc.Arbitrary<boolean> = fc.oneof(
  { arbitrary: fc.constant(false), weight: 3 },
  { arbitrary: fc.constant(true), weight: 1 },
);

/**
 * The full input space: the four orthogonal Tool_Runner signals crossed with an
 * arbitrary check set (including empty and mixed pass/fail sets) and an arbitrary
 * unreadable-signal count.
 */
const outcomeArbitrary: fc.Arbitrary<InvocationOutcome> = fc.record({
  timedOut: fc.boolean(),
  toolFailure: fc.boolean(),
  completed: fc.boolean(),
  checks: checksArbitrary,
  unreadableCheckSignals: unreadableArbitrary,
  diskLimitExceeded: diskKilledArbitrary,
  stdoutTruncated: truncatedArbitrary,
});

/**
 * A "good run" subspace: completed, no tool/infra fault, NOT killed for disk, and
 * at least one check. This is exactly the space where the pass/fail split is
 * decided, so it makes the pass and functional-fail facets non-vacuous rather than
 * mostly-error.
 *
 * `diskLimitExceeded` is pinned `false` HERE, alongside `timedOut` and
 * `toolFailure` and for the same reason: all three describe a run that did not end
 * on its own, they outrank the functional-fail rule, and a subspace that generated
 * one of them could not assert `fail` at all. So the facets below that use this
 * arbitrary hold only for runs NO resource bound killed - which is the honest scope,
 * not a weakening: the disk-killed half of the space is asserted by the two
 * dedicated facets and by the `error`-iff / `pass`-iff properties over
 * `outcomeArbitrary`, where the flag IS generated.
 */
const goodRunArbitrary: fc.Arbitrary<InvocationOutcome> = fc
  .record({
    checks: fc.array(checkArbitrary, { minLength: 1, maxLength: 6 }),
    unreadableCheckSignals: unreadableArbitrary,
    stdoutTruncated: truncatedArbitrary,
  })
  .map(({ checks, unreadableCheckSignals, stdoutTruncated }) => ({
    timedOut: false,
    toolFailure: false,
    completed: true,
    checks,
    unreadableCheckSignals,
    diskLimitExceeded: false,
    stdoutTruncated,
  }));

/**
 * A DISK-KILLED run that is otherwise indistinguishable from a good one:
 * completed, no tool failure, no wall-clock timeout, at least one readable check,
 * and readable, untruncated output.
 *
 * Every OTHER route to `error` is closed by construction, so the disk facets below
 * cannot pass for an unrelated reason - the flag is the only thing left that can
 * move the verdict. Checks are generated freely (including all-passing and
 * some-failing sets) because the rule must hold across both.
 */
const diskKilledRunArbitrary: fc.Arbitrary<InvocationOutcome> = fc
  .record({ checks: fc.array(checkArbitrary, { minLength: 1, maxLength: 6 }) })
  .map(({ checks }) => ({
    timedOut: false,
    toolFailure: false,
    completed: true,
    checks,
    unreadableCheckSignals: 0,
    diskLimitExceeded: true,
    stdoutTruncated: false,
  }));

/** Whether an outcome should classify as `error` per the reserved-error rule. */
function errorIsReserved(outcome: InvocationOutcome): boolean {
  if (outcome.timedOut || outcome.diskLimitExceeded || outcome.toolFailure || !outcome.completed) {
    return true;
  }
  if (outcome.checks.length === 0) {
    return true;
  }
  // A readable failure is a functional `fail` and outranks BOTH evidence-gap
  // signals; on an otherwise-clean run, either an unreadable signal or truncated
  // output makes the run `error`, never `pass`.
  const evidenceIncomplete = outcome.unreadableCheckSignals > 0 || outcome.stdoutTruncated;
  return outcome.checks.every((check) => check.passed) && evidenceIncomplete;
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

  it('never returns pass when a workspace disk-cap breach killed the run', () => {
    fc.assert(
      fc.property(diskKilledRunArbitrary, (outcome) => {
        // The disk half of the resource-bound fix. The Tool_Runner caps how many
        // bytes a run may write into its workspace, because a testbench that dumps
        // a waveform and never reaches `$finish` writes tens of megabytes per
        // second. When the cap fires the tool is KILLED part-way through, so the
        // stimulus never finished and the checks that did print describe a fraction
        // of it - however clean that fraction looks.
        expect(classifyVerdict(outcome)).not.toBe('pass');
      }),
      propertyParameters(),
    );
  });

  it('classifies a disk-killed run error even when a check failed, so our kill is not read as the design failing', () => {
    fc.assert(
      fc.property(diskKilledRunArbitrary, (outcome) => {
        fc.pre(outcome.checks.some((check) => !check.passed));

        // Where the disk rule deliberately DIFFERS from truncation, which ranks
        // below the functional-fail rule. A truncated run finished on its own, so a
        // legible FAIL in the retained prefix is a real verdict on the whole
        // stimulus. A disk-killed run is one WE terminated, so reporting `fail`
        // would attribute our own resource decision to the design.
        expect(classifyVerdict(outcome)).toBe('error');
      }),
      propertyParameters(),
    );
  });

  it('returns pass iff the run completed with >=1 check all passing on readable, untruncated output', () => {
    fc.assert(
      fc.property(outcomeArbitrary, (outcome) => {
        const isPass = classifyVerdict(outcome) === 'pass';
        const shouldPass =
          !outcome.timedOut &&
          !outcome.diskLimitExceeded &&
          !outcome.toolFailure &&
          outcome.completed &&
          outcome.checks.length > 0 &&
          outcome.checks.every((check) => check.passed) &&
          outcome.unreadableCheckSignals === 0 &&
          !outcome.stdoutTruncated;

        expect(isPass).toBe(shouldPass);
      }),
      propertyParameters(),
    );
  });

  it('never returns pass when the output the checks were read from was truncated', () => {
    fc.assert(
      fc.property(goodRunArbitrary, (outcome) => {
        fc.pre(outcome.stdoutTruncated);

        // The resource-exhaustion fix's correctness half: the Tool_Runner bounds
        // how much output it retains, so a `CHECK ... FAIL` line may sit in the
        // bytes it dropped. However clean the retained prefix looks, this run did
        // not establish that the design is correct.
        expect(classifyVerdict(outcome)).not.toBe('pass');
      }),
      propertyParameters(),
    );
  });

  it('never returns pass when the run emitted a check signal the reader could not read', () => {
    fc.assert(
      fc.property(goodRunArbitrary, (outcome) => {
        fc.pre(outcome.unreadableCheckSignals > 0);

        // THE severity-1 invariant: an unreadable CHECK line can never be voted
        // down by however many readable passes accompany it.
        expect(classifyVerdict(outcome)).not.toBe('pass');
      }),
      propertyParameters(),
    );
  });

  it('a readable failure outranks both evidence gaps, so it stays a functional fail', () => {
    fc.assert(
      fc.property(goodRunArbitrary, (outcome) => {
        fc.pre(outcome.checks.some((check) => !check.passed));

        // All three are non-pass; a definite failing check is the stronger, more
        // actionable fact, so neither an unreadable signal nor truncated output may
        // blur it into `error` and leave self-healing with nothing to repair.
        expect(classifyVerdict(outcome)).toBe('fail');
      }),
      propertyParameters(),
    );
  });
});
