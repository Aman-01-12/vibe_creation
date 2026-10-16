// formal-property-oracle, Property 3: A zero or absent assertion count overrides every other signal
// (task 5.6).
//
// THE MEASURED SILENT FAILURE THIS PROPERTY EXISTS FOR
//   `adder_8bit` asserting `cout == 1'b0` - a property that is PROVABLY FALSE of that design -
//   reported `Status: PASSED` at exit 0 with ZERO assertions in the generated SMT2. The lowering
//   chain was missing `async2sync` and `chformal -lower`, so nothing the solver saw carried the
//   assertion at all, and `grep -c assert` on the SMT2 returned 0. From the verdict alone that run
//   is indistinguishable from a real proof. So the assertion count is not one signal among five: it
//   is the precondition that makes the other four MEAN anything, and a `FAILED` under zero
//   assertions is no more meaningful than a `PASSED` under zero assertions.
//
// WHAT "OVERRIDES EVERY OTHER SIGNAL" IS ASSERTED AGAINST
//   Every other signal in the report is left GENERATED while the count is forced to an unusable
//   value, so the claim is asserted against the whole cross of them rather than against a fixture:
//     - all four checks' `Status:` strings, including `PASSED` on every one of them at once;
//     - the induction line, so a report that looks like a COMPLETE PROOF still reports
//       `zero-assertions` (counted below as `wouldBeProofShaped`, the strongest single case here);
//     - a registered Counterexample beside a `FAILED` base case, so the guard outranks the
//       REFUTATION and not only the proof;
//     - a DISAGREEING Solver_Cross_Check, which is itself a `toolchain-unavailable` path - two
//       solvers agreeing, or disagreeing, about an EMPTY problem is not information either way;
//     - exit codes that contradict their own `Status:` strings.
//
// THE TWO SIGNALS THAT ARE ORDERED AHEAD, AND WHY THEY ARE PRECONDITIONS RATHER THAN COUNTEREXAMPLES
//   `interpretFormalReport` weighs a FAILED LOWERING and a KILLED RUN before the count, and both
//   orderings are load-bearing rather than incidental: a lowering that aborted wrote no SMT2, so its
//   count is zero as a CONSEQUENCE, and reporting `zero-assertions` there would name a symptom and
//   throw away the attribution Req 8.1 and 8.8 require; a killed run's evidence is incomplete by
//   definition (Req 7.3, 7.4). So this property forces a completed lowering and an unkilled run.
//   Those two paths are Property 10's and Property 9's own claims - Property 10 is asserted in
//   `formal-build-failure-attribution.property.test.ts`.
//
// THE ONE CORNER WHERE REQ 2.2 AND REQ 11.19 CONTRADICT, AND WHY THIS PROPERTY DOES NOT GENERATE IT
//   Req 2.2 says a zero count is `zero-assertions`. Req 11.19 says a Cover_Check naming a step at or
//   past the run's own depth is `toolchain-unavailable`. Req 1.5 allows exactly one cause, so a
//   report carrying BOTH is a contradiction between two literal criteria, and `interpret.ts` decides
//   it by PLACEMENT: the cover-step guard sits ahead of the whole five-condition order, so that
//   corner reads `toolchain-unavailable` (a document already judged corrupt is not read for a
//   condition, and the step would otherwise feed the Proof_Depth rule Req 4.6 states).
//   DECISION: the corner is not this property's to generate. "A zero count overrides every other
//   SIGNAL" is a claim about signals the real tool can emit, and a step at or past the depth is not
//   one - so the Cover_Check's step is DERIVED from the run's depth (`withCoverStepBelowDepth`)
//   rather than drawn freely. The population NARROWS by exactly the reports the real tool cannot
//   write, and nothing else: a reached cover stays reached, so the proof-shaped and refutation-shaped
//   counters below still draw the shapes that make the override non-trivial. The corner itself is
//   pinned as a named single case, where the order is the thing asserted
//   (`formal-interpreter-single-cases.test.ts`, "a zero-assertion report that also names an
//   impossible step").
//   Before this derivation the property drew a step 0..64 against a FIXED depth of 20, so 69% of its
//   reached covers were impossible ones and it failed the day the guard landed
//   (`chipAgent/_inbox/gotcha-the-req-11-19-cover-step-guard-breaks-three-free-generator-cover-doubles.md`).
//
// WHY FIVE OF THE SIX COUNTS CANNOT COME THROUGH `parseFormalReport`, AND WHY THEY ARE HERE ANYWAY
//   The report schema bounds `assertionCount` to `{ type: 'integer', minimum: 0 }`, so a document
//   carrying `-1`, `0.5`, `NaN`, `Infinity`, or a value above `Number.MAX_SAFE_INTEGER` is REFUSED
//   by the parse and only `0` survives it. They are nonetheless the values the guard behind the
//   brand was written for - `Number.isSafeInteger(count) && count > 0`, not `count !== 0` - and
//   `interpretFormalReport`'s declared input type carries `assertionCount` as a plain `number`, so a
//   total function over that type has to be total over them. The parse's refusal of the other five
//   is a DIFFERENT claim, and it is Property 25's, asserted in
//   `formal-build-failure-attribution.property.test.ts`.
//
// RUN COUNT: 2000, not the shared 100
//   The rarest required shape is `wouldBeProofShaped`: presat `PASSED` (4 of 12 weighted status
//   draws, 0.33) x base `PASSED` (0.33) x induct `PASSED` (0.33) carrying `inductionSuccessful:
//   true` (present 3 of 4, true 1 of 2, so 0.375) x a cover that reached or does not apply (~0.8) ~
//   1.1% of draws. At 100 runs the miss probability is ~33%, which is a flake rather than a claim;
//   at 2000 the expected count is ~22 and the miss probability is ~1e-10. Recipe from
//   `chipAgent/_inbox/verification-recipe-every-row-coverage-needs-numruns-scaled-to-the-table.md`:
//   size `numRuns` to the rarest required shape, never weaken the claim to fit 100.
//
// The tag string is a literal, not `propertyTag(...)`, whose `FEATURE_TAG` is hardcoded to a
// different spec's property numbering
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// **Validates: Requirements 2.2, 2.3, 2.5, 2.8**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  COUNTEREXAMPLE_ARTIFACT_KEY,
  coveredAntecedent,
  interpretFormalReport,
  type ArtifactBlobRef,
  type FormalProperty,
  type FormalReport,
  type FormalRunContext,
  type SandboxResult,
} from '@app/tools';

import { arbFormalProperty, arbFormalReport } from './formal-arbitraries.js';
import { withCoverStepBelowDepth } from './formal-cover-depth.js';
import { propertyParameters } from './property.js';

// **Feature: formal-property-oracle, Property 3: A zero or absent assertion count overrides every
// other signal**
const PROPERTY =
  'formal-property-oracle, Property 3: A zero or absent assertion count overrides every other signal';

/** See the RUN COUNT note: the would-be-proof shape is ~1.1% of draws. */
const NUM_RUNS = 2000;

/**
 * An explicit timeout, above vitest's 5s default. HEADROOM NOW, not a workaround.
 *
 * It was written for a MEASURED defect that is now FIXED: `sanitizeDiagnostic` applied its
 * redactions to the whole raw string and only then applied `MAX_DIAGNOSTIC_CHARS`, so a long
 * WHITESPACE-FREE `lowering.stderrTail` - which `arbFormalReport()` generates on about a fifth of
 * draws - cost quadratic time (84ms, 320ms, 1268ms, 5046ms per 100 calls at 500, 1000, 2000, 4000
 * characters), putting this file's 2000 runs at ~5s of which almost all was that one path.
 * `interpret.ts` now bounds the text BEFORE any regex sees it, so that path costs 0.003ms and this
 * file's slowest test is a measured 154ms - 30x inside the default. The timeout stays only as
 * headroom for a 2000-run property on a shared runner; nothing here depends on it
 * (`chipAgent/_inbox/gotcha-sanitizediagnostic-redacts-before-bounding-so-a-long-unbroken-tail-is-quadratic.md`,
 * and `app/test/formal-diagnostic-bound.test.ts` is the guard that keeps the cost from returning).
 */
const SLOW_PROPERTY_TIMEOUT_MS = 30_000;

/**
 * Every count that is not a real count: zero, and the five the guard's `isSafeInteger` half exists
 * for.
 *
 * Zero is the MEASURED trap and the only one the parse admits; the other five are what an untrusted
 * `number` field can hold once it has crossed a seam. See the header for why all six belong here.
 */
const UNUSABLE_COUNTS: readonly number[] = Object.freeze([
  0,
  -1,
  0.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 2,
]);

/**
 * The run context. Fixed: this property is about the count. Only `depth` is read, and only by
 * `withCoverStepBelowDepth`, which keeps the generated cover step a step this depth could reach.
 */
const RUN: FormalRunContext = Object.freeze({
  depth: 20,
  elapsedMs: 1_234,
  designFileName: 'design.v',
  wrapperFileName: 'wrapper.v',
});

/** A counterexample trace, so the guard can be asserted to outrank a refutation. */
const TRACE: ArtifactBlobRef = Object.freeze({
  name: 'formal-trace-base-bitwuzla.vcd',
  sizeBytes: 512,
  sha256: 'c'.repeat(64),
});

/**
 * A run that COMPLETED and was not killed, carrying a counterexample or not.
 *
 * `timedOut: false` is a precondition rather than a pinned convenience - see the header: a killed
 * run is weighed ahead of the count on purpose.
 */
function completedRun(withCounterexample: boolean): SandboxResult {
  return {
    verdict: 'pass',
    timedOut: false,
    exitCode: 0,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts: withCounterexample ? { [COUNTEREXAMPLE_ARTIFACT_KEY]: TRACE } : {},
    deniedOperations: [],
    resourceUsage: { wallMs: 10, maxMemMb: 1, cpuMs: 10 },
  };
}

/**
 * The report as generated, with the lowering completed, the count made unusable, and the cover step
 * made one `RUN.depth` could have reached (Req 11.19; see the header's corner note).
 */
function withUnusableCount(report: FormalReport, count: number): FormalReport {
  return withCoverStepBelowDepth(
    {
      ...report,
      lowering: { ...report.lowering, exitCode: 0 },
      assertionCount: count,
    },
    RUN.depth,
  );
}

/** Whether the generated cover named a step the depth could not reach, so the derivation changed it. */
function hadImpossibleCoverStep(report: FormalReport): boolean {
  const step = report.checks.cover.reachedStep;
  return step !== undefined && step >= RUN.depth;
}

/**
 * Whether the four checks together report what a COMPLETE PROOF looks like.
 *
 * A NON-VACUITY COUNTER and never part of the expectation, which is why it may call production's own
 * `coveredAntecedent`: the question "does this property have an antecedent to cover" has a single
 * owner, shared with the renderer that emits the cover, and a second spelling of it here would drift.
 */
function looksLikeAProof(report: FormalReport, property: FormalProperty): boolean {
  const coverSatisfied =
    report.checks.cover.reachedStep !== undefined || coveredAntecedent(property) === null;
  return (
    report.checks.presat.status === 'PASSED' &&
    report.checks.base.status === 'PASSED' &&
    report.checks.induct.status === 'PASSED' &&
    report.checks.induct.inductionSuccessful === true &&
    coverSatisfied
  );
}

/**
 * The four check slots every report carries, in the worker's own run order.
 *
 * An explicit key list rather than `Object.values`, which types this record's values as `any` and so
 * would make every field read below unchecked - the same shape `formal-arbitraries.self-check.test.ts`
 * uses for the same reason.
 */
const CHECK_NAMES = ['presat', 'base', 'cover', 'induct'] as const;

/** Whether any check's audit reported a different `Status:` than the check it audits. */
function anyAuditDisagrees(report: FormalReport): boolean {
  return CHECK_NAMES.map((name) => report.checks[name]).some(
    (check) => check.crossCheck !== undefined && check.crossCheck.status !== check.status,
  );
}

describe(PROPERTY, () => {
  it(
    'reports zero-assertions for every Status combination, every audit, and every counterexample',
    () => {
      let total = 0;
      let wouldBeProofShaped = 0;
      let refutationShaped = 0;
      let disagreeingAudit = 0;
      let derivedCoverSteps = 0;
      let derivedProofShaped = 0;
      const countsObserved = new Set<number>();
      const baseStatusesObserved = new Set<string | null>();
      fc.assert(
        fc.property(
          arbFormalReport(),
          arbFormalProperty(),
          fc.constantFrom(...UNUSABLE_COUNTS),
          fc.boolean(),
          (
            generated: FormalReport,
            property: FormalProperty,
            count: number,
            withCounterexample: boolean,
          ) => {
            total += 1;
            const report = withUnusableCount(generated, count);
            countsObserved.add(count);
            baseStatusesObserved.add(report.checks.base.status);
            if (looksLikeAProof(report, property)) {
              wouldBeProofShaped += 1;
            }
            if (report.checks.base.status === 'FAILED' && withCounterexample) {
              refutationShaped += 1;
            }
            if (anyAuditDisagrees(report)) {
              disagreeingAudit += 1;
            }
            if (hadImpossibleCoverStep(generated)) {
              derivedCoverSteps += 1;
              derivedProofShaped += looksLikeAProof(report, property) ? 1 : 0;
            }

            const result = interpretFormalReport(
              completedRun(withCounterexample),
              report,
              property,
              RUN,
            );

            // The report is NOT folded into these expectations: fast-check prints the shrunk
            // counterexample already, and a deep comparison over a nested report on every one of 2000
            // draws costs more than the whole rest of the property.
            expect(result.verdict).toBe('could-not-verify');
            if (result.verdict !== 'could-not-verify') {
              return;
            }
            expect(result.cause).toBe('zero-assertions');
            // Req 2.7 and 2.8: the count is RECORDED as it arrived, so an absent or unreadable count
            // reads as the failing precondition it is rather than being quietly replaced.
            expect(result.conditions.assertionCount).toEqual(count);
          },
        ),
        propertyParameters({ numRuns: NUM_RUNS }),
      );
      // Non-vacuity. Each clause of "overrides every other signal" needs the signal it overrides to
      // have actually appeared in the sample
      // (`chipAgent/_inbox/gotcha-golden-denominator-property-test-was-vacuous-for-new-status.md`).
      expect(total).toBe(NUM_RUNS);
      expect(countsObserved).toEqual(new Set(UNUSABLE_COUNTS));
      // Every `Status:` value, and PASSED and FAILED by name, per task 5.6's own wording.
      expect(baseStatusesObserved).toContain('PASSED');
      expect(baseStatusesObserved).toContain('FAILED');
      expect(baseStatusesObserved.size).toBeGreaterThan(2);
      // The report that looks like a finished proof: the measured `adder_8bit` shape.
      expect(wouldBeProofShaped).toBeGreaterThan(0);
      // The guard outranks the refutation, not only the proof.
      expect(refutationShaped).toBeGreaterThan(0);
      // And it outranks the Solver_Cross_Check path, which is itself a `toolchain-unavailable`.
      expect(disagreeingAudit).toBeGreaterThan(0);
      // The shape that broke this property when the Req 11.19 guard landed - a reached cover at a step
      // the fixed depth could not reach, beside a report that looks like a finished proof - is still
      // DRAWN, now with a reachable step, so the derivation narrowed nothing but the impossible step.
      expect(derivedCoverSteps).toBeGreaterThan(0);
      expect(derivedProofShaped).toBeGreaterThan(0);
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );
});
