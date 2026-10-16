// formal-property-oracle, Properties 4, 5, 6, and 7: what a proof rests on, where a refutation comes
// from, and what every run records (task 5.7).
//
// TWO MEASURED FACTS THAT POINT IN OPPOSITE DIRECTIONS, WHICH IS WHY BOTH PROPERTIES EXIST
//   1. INDUCTION IS REQUIRED FOR A PROOF. Plain bounded BMC PASSED the real `JC_counter` mutant
//      `!Q[0]` -> `!Q[1]` at depths 20, 64, AND 66, and failed only at 70. So a bounded pass is not
//      a proof at any depth a budget can afford, and `induction-inconclusive` names the remedy:
//      more depth.
//   2. AN INDUCTION FAILURE IS NOT A REFUTATION. `yosys-smtbmc`'s k-induction emits NO simple-path
//      constraints, so a CORRECT design reports a PASSING base case with a FAILING inductive step at
//      every depth - measured on a constructed `bounded_ctr`, on `counter_12`'s `out != 4'd13`, and
//      on the Yosys issue-3378 ROM case at depths 1, 5, 20, and 40 - and upstream SymbiYosys treats
//      that situation as UNKNOWN rather than as a failure. The shipped code read `refuted` off the
//      induction check's `FAILED`, which REFUTES CORRECT DESIGNS; `induction-engine-incomplete` names
//      that fact, and no depth is known to repair it.
//   Conflating the two is the defect these properties pin apart: the first says a bounded pass must
//   never prove, the second says an induction failure must never refute.
//
// WHERE A REFUTATION DOES COME FROM
//   The BASE CASE, and nothing else (Req 4.8). With the reset assume present the base-case failure
//   rate on correct designs carrying known-true properties went from 4 of 6 to 0 of 6, so a
//   base-case `FAILED` is a counterexample reachable from the design's ACTUAL reset state. And it
//   refutes only when its evidence can be handed back: a `FAILED` base case with NO registered
//   Counterexample is `toolchain-unavailable` (Req 1.17), because a refutation whose evidence is
//   missing is a gap in our instrument rather than a finding about the design.
//
// ONE WORDING IN design.md's PROPERTY 6 THAT IS NOT ASSERTABLE AS WRITTEN, STATED RATHER THAN FUDGED
//   design.md's last clause reads "*for any* formal report whose induction check reported `FAILED`,
//   the derived verdict is never `refuted`". Taken literally that is FALSE, and correctly so: a
//   report whose BASE CASE also failed with a Counterexample registered IS `refuted`, whatever the
//   induction check said, because the refutation is sourced from the base case. The requirement
//   itself is precise where the property text is loose - Req 4.10 says the oracle "SHALL NOT DERIVE a
//   Formal_Verdict of `refuted` FROM an Induction_Check that reported a failure" - so what is
//   asserted below is the requirement's claim: where the base case did NOT fail, an induction
//   `FAILED` never yields `refuted`. That is also exactly the regression direction, since the defect
//   being closed refuted designs whose base case PASSED.
//
// HOW THE SAMPLE REACHES THE GATE'S BOUNDARY AT ALL
//   `arbFormalReport()` draws all four checks independently, which is what makes an exit code that
//   contradicts its own `Status:` and the `bad_init` signature generated cases rather than fixtures.
//   It also means a report satisfying four conditions and failing exactly the fifth is rare. So half
//   the sample is drawn from a NEAR-GATE arm: the same generator, with the three decisive `Status:`
//   strings redrawn from a pool weighted toward their admitting values, the cover always reached, and
//   the induction line drawn independently. The free arm keeps every claim honest over arbitrary
//   documents; the near-gate arm is what puts real counts behind the boundary clauses.
//   THE NEAR-GATE ARM CARRIES NO Solver_Cross_Check, deliberately: an audit generated against a
//   status this arm then overwrites would DISAGREE by construction, and a disagreement is itself a
//   `toolchain-unavailable` (Req 4.16), so every near-gate draw would collapse to that one cause.
//   The disagreement path is exercised by the free arm and pinned by its own unit test in
//   `formal-refutation-source.test.ts`.
//
// WHY THE EXPECTATIONS READ THE RESULT'S OWN RECORDED CONDITIONS
//   "The earlier conditions were satisfied" is a statement about the five Proof_Conditions, and
//   every `PropertyResult` member carries them - the five fields on `conditions`, or the same five
//   in their admitting form on a `proved` result's `evidence`. Reading them back is what lets these
//   properties state the classification rule WITHOUT re-spelling the `Status:`-to-condition maps that
//   produced them. That the record faithfully reflects the report is a separate claim, and it is
//   Property 4's, asserted in this file; the individual status reads are pinned by task 5.10's unit
//   tests.
//
// TWO PRECONDITIONS FORCED BY THE ARBITRARY RATHER THAN ASSERTED AS CONJUNCTS
//   A FAILED LOWERING and a KILLED RUN are both weighed AHEAD of the whole gate, on purpose: a
//   lowering that aborted wrote no SMT2, so every condition behind it is a consequence rather than a
//   finding, and a killed run's evidence is incomplete by definition (Req 7.3, 7.4). Properties 5, 6,
//   and 7 therefore run over completed, unkilled runs. Property 4 does NOT - it is the property that
//   must hold on a timed-out run and on a run with no report at all, so it draws those shapes too.
//
// THE COVER STEP IS DERIVED FROM THE DEPTH THE SAME CASE SUBMITS (Req 11.19)
//   `yosys-smtbmc -c` reaches a cover only at a step strictly below the depth it searched to, and
//   `interpretFormalReport` refuses a report naming anything else as `toolchain-unavailable`. The
//   case's `run.depth` and its report's `reachedStep` were drawn INDEPENDENTLY (depth 1..64, step
//   0..19 on the near-gate arm and 0..64 on the free arm), so about a sixth of the near-gate draws
//   and half the free ones named a step their own depth could not reach, and Properties 5 and 6
//   failed on the first of them (depth 1, step 1: an induction `FAILED` beside a passing base case
//   read `toolchain-unavailable`, not `induction-engine-incomplete`).
//   `arbCompletedCase` now CAPS the step at `depth - 1` (`withCoverStepBelowDepth`). The population
//   narrows by exactly the reports the real tool cannot write: a reached cover stays reached, every
//   other field is untouched, and the step value is not read by any assertion here. The impossible
//   step is asserted where it is the subject, in Property 25's cover-step clause. Properties 5 and 6
//   each count the shape that broke them, at the boundary - a reached cover sitting on the LAST
//   reachable step, `depth - 1` - so the derivation is shown to have kept it drawn.
//
// RUN COUNTS
//   2000 for Properties 5, 6, and 7; 1000 for Property 4. The rarest required shape across the first
//   three is a BOUNDED PASS reached past the four earlier conditions: within the near-gate arm that
//   needs a `PASSED` base case (4 of 8 weighted status draws) x a `PASSED` induction check (4 of 8)
//   x no induction line (~0.5) x a usable count (~0.8) x a presat that reads satisfiable (`PASSED`
//   or `FAILED`, 6 of 8), about 3.8% of near-gate draws and ~1.4% of the free arm, so ~2.5% of the
//   sample: ~50 expected cases at 2000 runs, with a miss probability of ~1e-22. A `refuted` outcome
//   lands near 5% of the same sample and a `proved` one near 4%. At the shared 100-run default the
//   bounded pass has an expected count of 2.5 and a miss probability of ~8%, which is a flake rather
//   than a claim. Property 4's rarest required shapes are a `proved` and a `refuted` outcome at ~3%
//   each of its own sample, so ~30 expected cases at 1000 runs and a miss probability of ~1e-13.
//   Recipe from
//   `chipAgent/_inbox/verification-recipe-every-row-coverage-needs-numruns-scaled-to-the-table.md`:
//   size `numRuns` to the rarest required shape, never weaken the claim to fit 100.
//
// The tag strings are literals, not `propertyTag(...)`, whose `FEATURE_TAG` is hardcoded to a
// different spec's property numbering
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// **Validates: Requirements 1.8, 1.10, 1.17, 2.7, 4.1, 4.2, 4.3, 4.4, 4.8, 4.10, 4.11, 4.12, 7.5,
// 12.16**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  COUNTEREXAMPLE_ARTIFACT_KEY,
  interpretFormalReport,
  type ArtifactBlobRef,
  type FormalCheckReport,
  type FormalProperty,
  type FormalReport,
  type FormalRunContext,
  type ProofConditions,
  type PropertyResult,
  type SandboxResult,
} from '@app/tools';

import { arbFormalProperty, arbFormalReport } from './formal-arbitraries.js';
import { withCoverStepBelowDepth } from './formal-cover-depth.js';
import { propertyParameters } from './property.js';

// **Feature: formal-property-oracle, Property 4: Every run records what it rested on**
const PROPERTY_4 = 'formal-property-oracle, Property 4: Every run records what it rested on';

// **Feature: formal-property-oracle, Property 5: A proof rests on induction AND a base case, never
// on a bounded pass, and the two induction failures are named apart**
const PROPERTY_5 =
  'formal-property-oracle, Property 5: A proof rests on induction AND a base case, never on a bounded pass, and the two induction failures are named apart';

// **Feature: formal-property-oracle, Property 6: Refuted occurs exactly on a failing BASE CASE with
// the guard satisfied and a registered counterexample, and never from induction**
const PROPERTY_6 =
  'formal-property-oracle, Property 6: Refuted occurs exactly on a failing BASE CASE with the guard satisfied and a registered counterexample, and never from induction';

// **Feature: formal-property-oracle, Property 7: A refutation carries its counterexample**
const PROPERTY_7 = 'formal-property-oracle, Property 7: A refutation carries its counterexample';

/** See the RUN COUNTS note: a `refuted` outcome is ~3.7% of this sample. */
const GATE_NUM_RUNS = 2000;

/** Property 4's own sample, whose rarest required shapes are a `proved` and a `refuted` outcome. */
const RECORD_NUM_RUNS = 1000;

/**
 * An explicit timeout, above vitest's 5s default. HEADROOM NOW, not a workaround.
 *
 * It was written for a MEASURED defect that is now FIXED: `sanitizeDiagnostic` applied its
 * redactions to the whole raw string and only then applied `MAX_DIAGNOSTIC_CHARS`, so a long
 * WHITESPACE-FREE `lowering.stderrTail` - which `arbFormalReport()` generates on about a fifth of
 * draws - cost quadratic time (84ms, 320ms, 1268ms, 5046ms per 100 calls at 500, 1000, 2000, 4000
 * characters), putting 2000 runs at ~5s of which almost all was that one path. `interpret.ts` now
 * bounds the text BEFORE any regex sees it, so that path costs 0.003ms and this file's slowest test
 * is a measured 126ms - 40x inside the default. The timeout stays only as headroom for these run
 * counts on a shared runner; nothing here depends on it
 * (`chipAgent/_inbox/gotcha-sanitizediagnostic-redacts-before-bounding-so-a-long-unbroken-tail-is-quadratic.md`,
 * and `app/test/formal-diagnostic-bound.test.ts` is the guard that keeps the cost from returning).
 */
const SLOW_PROPERTY_TIMEOUT_MS = 30_000;

/** The deepest generated Proof_Depth. The measured worst reached cover on this corpus is step 19. */
const MAX_DEPTH = 64;

/**
 * The four check slots every report carries, in the worker's own run order.
 *
 * An explicit key list rather than `Object.values`, which types this record's values as `any` and so
 * would make every field read through it unchecked - the same shape
 * `formal-arbitraries.self-check.test.ts` uses for the same reason.
 */
const CHECK_NAMES = ['presat', 'base', 'cover', 'induct'] as const;

/** One formal invocation as the interpreter sees it: the run, the report, and the property. */
interface FormalRunCase {
  readonly report: FormalReport | null;
  readonly property: FormalProperty;
  readonly counterexample: ArtifactBlobRef | null;
  readonly timedOut: boolean;
  readonly run: FormalRunContext;
}

/** One check with only the fields the near-gate arm decides, and no audit. See the header. */
function decisiveCheck(generated: FormalCheckReport, status: string | null): FormalCheckReport {
  return { exitCode: generated.exitCode, status, elapsedMs: generated.elapsedMs };
}

/** A `Status:` string weighted toward the admitting value, so the gate's boundary is reached. */
function nearGateStatus(): fc.Arbitrary<string | null> {
  return fc.oneof(
    { weight: 4, arbitrary: fc.constant<string | null>('PASSED') },
    { weight: 2, arbitrary: fc.constant<string | null>('FAILED') },
    { weight: 1, arbitrary: fc.constant<string | null>('PREUNSAT') },
    { weight: 1, arbitrary: fc.constant<string | null>(null) },
  );
}

/**
 * A generated report whose three decisive `Status:` strings are redrawn near the gate's boundary.
 *
 * The cover carries `Status: FAILED` BESIDE a reached step on purpose: in `-c` mode that string is
 * reported both for an unreached cover and for an assert failing on a covering path, so the cover
 * condition must be read from the step and never from the status.
 */
function arbNearGateReport(): fc.Arbitrary<FormalReport> {
  return fc
    .tuple(
      arbFormalReport(),
      nearGateStatus(),
      nearGateStatus(),
      nearGateStatus(),
      fc.boolean(),
      fc.integer({ min: 0, max: 19 }),
    )
    .map(([report, presat, base, induct, inductionSuccessful, reachedStep]): FormalReport => ({
      ...report,
      checks: {
        presat: decisiveCheck(report.checks.presat, presat),
        base: decisiveCheck(report.checks.base, base),
        cover: { ...decisiveCheck(report.checks.cover, 'FAILED'), reachedStep },
        induct: { ...decisiveCheck(report.checks.induct, induct), inductionSuccessful },
      },
    }));
}

/** A report whose lowering COMPLETED: the precondition Properties 5, 6, and 7 run under. */
function arbLoweredReport(): fc.Arbitrary<FormalReport> {
  return fc
    .oneof(
      { weight: 1, arbitrary: arbFormalReport() },
      { weight: 1, arbitrary: arbNearGateReport() },
    )
    .map((report): FormalReport => ({ ...report, lowering: { ...report.lowering, exitCode: 0 } }));
}

/** A registered Counterexample, or none. Its fields VARY, so Property 7 asserts an identity. */
function arbCounterexample(): fc.Arbitrary<ArtifactBlobRef | null> {
  const registered = fc
    .tuple(
      fc.constantFrom('formal-trace-base-bitwuzla.vcd', 'trace.vcd'),
      fc.integer({ min: 0, max: 4_096 }),
      fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', '0', '9'),
    )
    .map(([name, sizeBytes, digit]): ArtifactBlobRef => ({
      name,
      sizeBytes,
      sha256: digit.repeat(64),
    }));
  return fc.oneof(fc.constant<ArtifactBlobRef | null>(null), registered);
}

/**
 * The run context, with the depth and the elapsed time GENERATED.
 *
 * Property 4 claims the result carries the depth the run used and the time it took; over a fixed
 * pair, a result that echoed two constants would satisfy that claim without carrying anything.
 */
function arbRunContext(): fc.Arbitrary<FormalRunContext> {
  return fc.record<FormalRunContext>({
    depth: fc.integer({ min: 1, max: MAX_DEPTH }),
    elapsedMs: fc.integer({ min: 0, max: 200_000 }),
    designFileName: fc.constant('design.v'),
    wrapperFileName: fc.constant('wrapper.v'),
  });
}

/**
 * A completed, unkilled invocation carrying a report whose cover step its own depth could reach.
 *
 * The report and the run are drawn independently and then reconciled, so the depth stays a free
 * draw (Property 4 claims the result carries whichever depth the run used) and only the step moves.
 */
function arbCompletedCase(): fc.Arbitrary<FormalRunCase> {
  return fc
    .record<FormalRunCase>({
      report: arbLoweredReport(),
      property: arbFormalProperty(),
      counterexample: arbCounterexample(),
      timedOut: fc.constant(false),
      run: arbRunContext(),
    })
    .map((runCase): FormalRunCase => ({
      ...runCase,
      report:
        runCase.report === null ? null : withCoverStepBelowDepth(runCase.report, runCase.run.depth),
    }));
}

/** Whether the case's cover was reached on the LAST step its depth could reach: the guard's boundary. */
function coverAtLastReachableStep(runCase: FormalRunCase): boolean {
  return runCase.report?.checks.cover.reachedStep === runCase.run.depth - 1;
}

/**
 * Every invocation shape, including the two Property 4 must hold on that the others exclude: a run
 * the runner KILLED, and a run for which there is no report at all.
 *
 * The completed arm keeps the weight, because it is the only arm in which a verdict other than
 * `could-not-verify` is reachable and Property 4 asserts coverage of all three verdicts.
 */
function arbAnyCase(): fc.Arbitrary<FormalRunCase> {
  const completed = arbCompletedCase();
  return fc.oneof(
    { weight: 6, arbitrary: completed },
    { weight: 1, arbitrary: completed.map((runCase) => ({ ...runCase, timedOut: true })) },
    {
      weight: 1,
      arbitrary: fc
        .tuple(completed, fc.boolean())
        .map(([runCase, timedOut]) => ({ ...runCase, report: null, timedOut })),
    },
  );
}

/** The `SandboxResult` for one case: a completed run, or one the wall-clock cap killed. */
function sandboxResultFor(runCase: FormalRunCase): SandboxResult {
  return {
    verdict: runCase.timedOut ? 'error' : 'pass',
    timedOut: runCase.timedOut,
    exitCode: runCase.timedOut ? null : 0,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts:
      runCase.counterexample === null
        ? {}
        : { [COUNTEREXAMPLE_ARTIFACT_KEY]: runCase.counterexample },
    deniedOperations: [],
    resourceUsage: { wallMs: 10, maxMemMb: 1, cpuMs: 10 },
  };
}

/** Interpret one case exactly as production does. */
function interpretCase(runCase: FormalRunCase): PropertyResult {
  return interpretFormalReport(
    sandboxResultFor(runCase),
    runCase.report,
    runCase.property,
    runCase.run,
  );
}

/**
 * The five Proof_Conditions the result RECORDED, whichever member it is.
 *
 * A `proved` result carries them as `evidence`, in their admitting form; every other member carries
 * them as `conditions`. `ProvedEvidence` is assignable to `ProofConditions` because each of its five
 * fields is the admitting literal of the corresponding field, which is what makes one reader enough.
 */
function recordedConditions(result: PropertyResult): ProofConditions {
  return result.verdict === 'proved' ? result.evidence : result.conditions;
}

/** Whether the recorded count is a real, positive count. See `formal-five-condition-gate`. */
function countedAtLeastOneAssertion(conditions: ProofConditions): boolean {
  return Number.isSafeInteger(conditions.assertionCount) && conditions.assertionCount > 0;
}

/** Whether every condition the fixed order places AHEAD of the base case is satisfied. */
function earlierConditionsSatisfied(conditions: ProofConditions): boolean {
  return (
    countedAtLeastOneAssertion(conditions) &&
    conditions.presat === 'satisfiable' &&
    (conditions.cover.reached === true || conditions.cover.reached === 'not-applicable')
  );
}

/**
 * Whether the instrument did NOT contradict itself: no audit reported a different `Status:` or a
 * different temporal-induction line than the check it audits.
 *
 * A PRECONDITION about the report rather than a restatement of the classification rule. Req 4.16
 * makes a disagreement `could-not-verify` / `toolchain-unavailable` preferring NEITHER solver,
 * because a disagreement invalidates the basis on which the solver was chosen - so on those runs no
 * verdict is read from either side and there is no `proved` or `refuted` for a property about the
 * base case to be stated over. That path has its own unit test in
 * `formal-refutation-source.test.ts`.
 */
function instrumentAgreed(report: FormalReport, baseFailed: boolean): boolean {
  // The Cover_Check is EXEMPT where the Base_Check failed. Cover mode's `Status:` is overloaded at
  // its source: smtbmc breaks out on a failed assertion before it can report every cover reached,
  // so the string carries no answer there. Restated here rather than imported, so this stays an
  // independent model that can falsify `solversDisagreed`.
  const audited = CHECK_NAMES.filter((name) => !(baseFailed && name === 'cover'));
  return audited
    .map((name) => report.checks[name])
    .every((check) => {
      const audit = check.crossCheck;
      return (
        audit === undefined ||
        (audit.status === check.status && audit.inductionSuccessful === check.inductionSuccessful)
      );
    });
}

/** The cause of a `could-not-verify`, or `null` for any other verdict. */
function causeOf(result: PropertyResult): string | null {
  return result.verdict === 'could-not-verify' ? result.cause : null;
}

describe(PROPERTY_4, () => {
  it(
    'carries the assertion count it rested on, the depth it ran at, and the time it took',
    () => {
      let total = 0;
      let killedRuns = 0;
      let reportlessRuns = 0;
      let guardPassed = 0;
      const verdictsObserved = new Set<PropertyResult['verdict']>();
      fc.assert(
        fc.property(arbAnyCase(), (runCase: FormalRunCase) => {
          total += 1;
          if (runCase.timedOut) {
            killedRuns += 1;
          }
          if (runCase.report === null) {
            reportlessRuns += 1;
          }

          const result = interpretCase(runCase);
          verdictsObserved.add(result.verdict);
          const conditions = recordedConditions(result);
          if (countedAtLeastOneAssertion(conditions)) {
            guardPassed += 1;
          }

          // The Proof_Depth and the elapsed time, on EVERY member including a run that was killed
          // (Req 4.4, 7.5): a timed-out run's elapsed time is the fact a reader most needs.
          expect({ depth: result.depth, elapsedMs: result.elapsedMs }).toEqual({
            depth: runCase.run.depth,
            elapsedMs: runCase.run.elapsedMs,
          });
          // The counted assertion number, as the report carried it (Req 2.7). With no report there is
          // no evidence, so the recorded count is zero - Req 2.8's rule that an absent count reads as
          // zero rather than as a satisfied precondition.
          expect(conditions.assertionCount).toEqual(runCase.report?.assertionCount ?? 0);
          // And the criterion the property was written against, so a result is attributable at all.
          expect(result.criterionRef).toBe(runCase.property.criterionRef);
        }),
        propertyParameters({ numRuns: RECORD_NUM_RUNS }),
      );
      // Non-vacuity: the two shapes the property text names explicitly, plus every verdict, because a
      // record claim asserted only over refusals says nothing about what a proof records.
      expect(total).toBe(RECORD_NUM_RUNS);
      expect(killedRuns).toBeGreaterThan(0);
      expect(reportlessRuns).toBeGreaterThan(0);
      expect(guardPassed).toBeGreaterThan(0);
      expect(verdictsObserved).toEqual(
        new Set<PropertyResult['verdict']>(['proved', 'refuted', 'could-not-verify']),
      );
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );
});

describe(PROPERTY_5, () => {
  it(
    'never proves a bounded pass, and names the engine incompleteness apart from a shallow depth',
    () => {
      let total = 0;
      let provedCases = 0;
      let boundedPassCases = 0;
      let engineIncompleteCases = 0;
      let engineIncompleteAtLastStep = 0;
      fc.assert(
        fc.property(arbCompletedCase(), (runCase: FormalRunCase) => {
          total += 1;
          const report = runCase.report;
          if (report === null) {
            throw new Error('arbCompletedCase must always carry a report');
          }
          const result = interpretCase(runCase);
          const conditions = recordedConditions(result);
          const induct = report.checks.induct;

          if (result.verdict === 'proved') {
            provedCases += 1;
            // A PROOF RESTS ON INDUCTION AND ON A BASE CASE. Asserted as the contrapositive of the
            // property's first clause, which is the stronger direction: a bounded pass reports
            // `PASSED` and prints no induction line, so `PASSED` alone must never get here (Req 4.1,
            // 4.2), and the base case is what makes the induction result mean anything (Req 4.9).
            expect({
              inductStatus: induct.status,
              inductionSuccessful: induct.inductionSuccessful,
              baseStatus: report.checks.base.status,
            }).toEqual({ inductStatus: 'PASSED', inductionSuccessful: true, baseStatus: 'PASSED' });
            return;
          }

          // The two named induction failures. Both clauses apply only where no EARLIER condition
          // failed and the instrument did not contradict itself; otherwise the fixed order reports
          // the earlier cause, which is Property 2's claim rather than this one's.
          const reachedTheInductionStep =
            earlierConditionsSatisfied(conditions) &&
            conditions.base === 'passed' &&
            // Not exempt: this clause already requires a PASSED base case, so the cover's audit
            // is meaningful here and is compared.
            instrumentAgreed(report, false);
          if (!reachedTheInductionStep) {
            return;
          }
          if (induct.status === 'PASSED' && induct.inductionSuccessful !== true) {
            // A BOUNDED PASS: the remedy is more depth (Req 4.3). Measured on the `JC_counter`
            // mutant, which plain BMC passed at depths 20, 64, and 66.
            boundedPassCases += 1;
            expect(causeOf(result)).toBe('induction-inconclusive');
            return;
          }
          if (induct.status === 'FAILED') {
            // AN ENGINE INCOMPLETENESS over a PASSING base case, which no depth is known to repair
            // (Req 4.11, 4.12). This is the case the shipped code called `refuted`.
            engineIncompleteCases += 1;
            engineIncompleteAtLastStep += coverAtLastReachableStep(runCase) ? 1 : 0;
            expect(causeOf(result)).toBe('induction-engine-incomplete');
          }
        }),
        propertyParameters({ numRuns: GATE_NUM_RUNS }),
      );
      // Non-vacuity: all three clauses need their own shape in the sample, and the two induction
      // failures need to have been told apart on real draws rather than in principle.
      expect(total).toBe(GATE_NUM_RUNS);
      expect(provedCases).toBeGreaterThan(0);
      expect(boundedPassCases).toBeGreaterThan(0);
      expect(engineIncompleteCases).toBeGreaterThan(0);
      // The shape that failed when the Req 11.19 guard landed - an induction `FAILED` over a passing
      // base case, beside a cover on the last step its depth could reach - is still drawn.
      expect(engineIncompleteAtLastStep).toBeGreaterThan(0);
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );
});

describe(PROPERTY_6, () => {
  it(
    'refutes exactly on a failing base case with the earlier conditions held and evidence in hand',
    () => {
      let total = 0;
      let refutedCases = 0;
      let failingBaseWithoutEvidence = 0;
      let inductionFailedOverAnUnfailedBase = 0;
      let refutedAtLastStep = 0;
      fc.assert(
        fc.property(arbCompletedCase(), (runCase: FormalRunCase) => {
          total += 1;
          const report = runCase.report;
          if (report === null) {
            throw new Error('arbCompletedCase must always carry a report');
          }
          const result = interpretCase(runCase);
          const conditions = recordedConditions(result);

          // THE IF AND ONLY IF (Req 4.8, 1.10, 1.17). Four conjuncts about the run, read back off the
          // record it kept, plus the one fact the record cannot carry: whether the Counterexample was
          // registered on the invocation at all.
          const refutable =
            conditions.base === 'failed' &&
            earlierConditionsSatisfied(conditions) &&
            runCase.counterexample !== null &&
            instrumentAgreed(report, conditions.base === 'failed');
          expect(result.verdict === 'refuted').toBe(refutable);

          if (result.verdict === 'refuted') {
            refutedCases += 1;
            refutedAtLastStep += coverAtLastReachableStep(runCase) ? 1 : 0;
          }
          // A FAILED base case whose evidence cannot be handed back is a gap in OUR instrument, never
          // a finding about the design (Req 1.17).
          if (
            conditions.base === 'failed' &&
            earlierConditionsSatisfied(conditions) &&
            runCase.counterexample === null &&
            instrumentAgreed(report, conditions.base === 'failed')
          ) {
            failingBaseWithoutEvidence += 1;
            expect(causeOf(result)).toBe('toolchain-unavailable');
          }
          // AND INDUCTION NEVER SOURCES A REFUTATION (Req 4.10). See the header for why this is
          // phrased over a base case that did not fail rather than over any induction failure at all.
          if (report.checks.induct.status === 'FAILED' && conditions.base !== 'failed') {
            inductionFailedOverAnUnfailedBase += 1;
            expect(result.verdict).not.toBe('refuted');
          }
        }),
        propertyParameters({ numRuns: GATE_NUM_RUNS }),
      );
      // Non-vacuity: an iff whose sample never refutes is a one-directional claim, and the two named
      // clauses each need their own shape.
      expect(total).toBe(GATE_NUM_RUNS);
      expect(refutedCases).toBeGreaterThan(0);
      expect(failingBaseWithoutEvidence).toBeGreaterThan(0);
      expect(inductionFailedOverAnUnfailedBase).toBeGreaterThan(0);
      // And the refutation that failed beside a cover on the last reachable step is still drawn.
      expect(refutedAtLastStep).toBeGreaterThan(0);
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );
});

describe(PROPERTY_7, () => {
  it(
    'carries the counterexample reference the run produced on every refutation',
    () => {
      let total = 0;
      let refutedCases = 0;
      const digestsObserved = new Set<string>();
      fc.assert(
        fc.property(arbCompletedCase(), (runCase: FormalRunCase) => {
          total += 1;
          const result = interpretCase(runCase);
          if (result.verdict !== 'refuted') {
            return;
          }
          refutedCases += 1;
          digestsObserved.add(result.counterexample.sha256);
          // THE reference the run produced, not merely some reference: the generated artifact's own
          // name, size, and digest (Req 1.10, 12.16).
          expect(result.counterexample).toEqual(runCase.counterexample);
          // A refuted result also carries the conditions it was reached under, so a reader can see
          // the base case that failed rather than only the trace.
          expect(result.conditions.base).toBe('failed');
        }),
        propertyParameters({ numRuns: GATE_NUM_RUNS }),
      );
      // Non-vacuity: no refutations means no claim, and one digest throughout would mean the identity
      // above was asserted against a constant.
      expect(total).toBe(GATE_NUM_RUNS);
      expect(refutedCases).toBeGreaterThan(0);
      expect(digestsObserved.size).toBeGreaterThan(1);
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );
});
