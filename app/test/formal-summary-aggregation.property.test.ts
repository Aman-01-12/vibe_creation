// formal-property-oracle, Property 28: Every reported count equals the population's own tally
// (task 12.8).
//
// WHAT IS CLAIMED, OVER WHAT
//   Over every population of sample records this file generates - spread over three arms and over
//   four kinds of sample, with each record's counted formal fields drawn INDEPENDENTLY over their
//   full closed vocabularies, so the fields disagree as often as they agree - the Sweep_Summary,
//   which is `parseResultsLog` -> `summarizeRecords` -> `renderSummary` over the JSONL the records
//   persist as, reports for every arm:
//
//     1. COUNTS. Each Formal_Verdict count, the none-submitted count, each Could_Not_Verify_Cause
//        count, the fallback count and each Fallback_Reason count, the frontend-rejected count,
//        and the refused-Property_Set count equal that arm's own tally (Req 7.10, 8.7, 10.9,
//        12.17). So do each Fallback_Route count (Req 7.22) and the Formal_Mutation_Counts
//        SUMMED over the samples that carry one - the killed, survived, excluded, denominator,
//        and total counts, the excluded count being the mutants a sample's gate could not reason
//        about (Req 9.4) - and the formal kill rate, which is the summed killed count over the
//        summed denominator (Req 9.6).
//     2. PARTITION. The three verdict buckets plus `noneSubmittedSamples` sum to the arm's sample
//        count, the Fallback_Route counts sum to it too (every record carries exactly one route),
//        the arms' sample counts sum to the population, and exactly the arms the population holds
//        are reported, so no record sits in two buckets or two arms and none is dropped.
//     3. NO ZERO ROW. No cause, no Fallback_Reason, and no Fallback_Route holding zero samples has
//        an entry (Req 12.17 reports "each Could_Not_Verify_Cause that holds at least one
//        sample", and Req 7.22 the same for each route).
//     4. SUMS. The cause entries sum to the `could-not-verify` bucket, the Fallback_Reason entries
//        sum to the fallback count, and the frontend-rejected count is the cause breakdown's own
//        `frontend-rejected` entry, or zero where it has none.
//     5. RENDERED. The arm's rendered block prints those same numbers: the verdict line, the three
//        headline counts, the entries of both cause breakdowns, the Fallback_Route rows, the
//        mutant tally with its excluded count, and the kill rate. The criteria say REPORT, and no
//        other test pins a non-zero headline count as printed.
//     6. NO RATE IS NOT A ZERO RATE (Req 9.11, 9.12, and Property 22's zero-denominator clause).
//        An arm no sample's tally reaches renders `formal mutants:  NOT MEASURED` and no rate
//        line; an arm whose summed denominator is zero renders its counts and the kill rate
//        `NOT MEASURED`; and an arm that scored and killed nothing renders the number
//        `0.000`. The first two are asserted as text and as a `null` rate, in the property over
//        populations and again as three closed inputs; the third is the sibling that makes
//        `NOT MEASURED` a claim about the denominator and not about a falsy rate.
//
// THE ORACLE IS AN INDEPENDENT TALLY
//   Every expectation is counted straight off the GENERATED fields by `tallyOf`, before a record
//   is encoded, so a decoder that rewrote a field on the way in would be caught too. No counting
//   helper of `summary.ts` builds an expectation, and the kill rate is divided here rather than
//   taken from `formalKillRateOf`. Each count reads the one field its criterion names: the
//   deciding run's verdict and cause, `formalFallbackReason`, `formalFallbackRoute`,
//   `propertySetAdmitted`, and `formalMutationCounts`.
//   A refused Property_Set reaches the loop empty and falls back with NO Fallback_Reason, so the
//   fallback count, read off `formalFallbackReason`, does not hold it; and `no-gate-set` is a gate
//   that ran with nothing to hold the set to, so the refused count does not hold it either
//   (`chipAgent/_inbox/decision-no-gate-set-does-not-take-the-simulation-fallback-only-refused-does.md`).
//   The route is DRAWN, as a pairing of the reason (`cause` beside a reason, one of the other
//   three beside none), and tallied off its own field. It is never derived from the reason or
//   from the admission outcome, because the three reasonless routes are exactly what such a
//   derivation would merge, and a refused route is counted apart from a refused admission.
//   Breakdowns are compared as cause -> count maps, so the claim is about counts, not their order.
//
// MULTI-ARM, SO A LEAK FAILS
//   Every population is spread over three arms whose tallies differ, so a count taken over the
//   whole file, or over the neighbouring arm, misses its own arm's tally.
//
// EVERY KIND OF SAMPLE, SO A SUB-POPULATION FAILS
//   Each record is also one of four kinds of sample, which no formal count reads: a verified pass,
//   a judged failure, an instrument-invalid failure, and a deferred sample the oracle never
//   reached. The summary filters an arm into its passing samples, its pass@k and golden
//   denominators, and its non-deferred samples for its OTHER numbers, so a formal count taken over
//   any one of those misses the tally. While every generated record was a verified pass, a formal
//   block summarized over the passing samples alone passed this file.
//
// THE CLOSED PART IS EXHAUSTED, THE OPEN PART IS SAMPLED
//   One sample's counted fields have 14 x 14 x 4 = 784 shapes: no run, `proved`, `refuted`, or
//   `could-not-verify` under each of the 11 causes; each of the 14 Fallback_Reason / Fallback_Route
//   pairings (`cause` beside each of the 11 reasons, and each of the 3 other routes beside none);
//   and each of the 4 admission outcomes. A fixed population holds every shape in every kind of
//   sample, so every member of every counted vocabulary is counted on every run as a fact rather
//   than a draw
//   (`chipAgent/_inbox/gotcha-a-closed-union-non-vacuity-row-should-be-exhausted-not-sampled.md`).
//   Each shape also carries one of five mutant tallies, handed out by position: none, an all-zero
//   tally, nothing scorable, and two scored tallies whose every part differs. Five is coprime to
//   the arms' strides of two and three, so every arm sums tallies that differ from its neighbours'.
//   The property covers what no fixed population can: small multisets of shapes across arms, and
//   the two no-rate arms in the mix a population actually draws them in.
//
// RUN COUNT: the shared 100
//   SEE THE NOTE ON `NUM_RUNS` for the measured share of each required row.
//
// FALSIFIED, out of tree, with no shared file edited
//   This file was run unedited with `@app/eval` redirected to a scratch shim taking
//   `summarizeRecords` and `renderSummary` from a scratch copy of `summary.ts`. The unmutated copy
//   passed, and each of 13 one-line mutants failed: the formal block taken over the passing
//   samples, the pass@k denominator, the golden denominator, the non-deferred samples, or every
//   arm's records; `no-gate-set` counted as refused; the fallback count read off the verdict; the
//   frontend-rejected count read off the Fallback_Reason; zero rows kept; none-submitted
//   excluding the fallbacks; the `refuted` bucket never filled; the frontend line printing the
//   fallback count; and only the first breakdown entry printed. The passing-samples mutant PASSED
//   while every generated record was a verified pass, which is why the four kinds are drawn. The
//   zero-row mutant failed the property alone, because every cause fires in every arm of the
//   exhaustive population
//   (`chipAgent/_inbox/gotcha-a-scratch-script-exit-trap-does-not-run-when-the-agent-tool-kills-the-shell.md`).
//   Task 19.6 re-ran TEN of those against the extended file - the three sub-population ones, the
//   `no-gate-set` one, the fallback count and the frontend count read off the wrong field, zero
//   cause rows kept, none-submitted excluding the fallbacks, the `refuted` bucket never filled, and
//   the frontend line printing the fallback count - and every one still fails both the closed
//   extremes and the property; the zero-cause-row one now fails five tests, since the closed
//   no-rate arms carry no cause either. The other three (the golden denominator, every arm's
//   records, and the first breakdown entry only) were not repeated.
//   Task 19.6 then repeated the run over the fields it added, with the same recipe
//   (`chipAgent/_inbox/verification-recipe-falsify-a-test-against-a-one-line-mutant-of-the-built-dist-without-touching-shared-source.md`):
//   the unmutated copy passed, and each of 13 further one-line mutants of the built `summary.js`
//   failed at least two of the six tests. They were: the route derived from the reason; the
//   route taken from the admission outcome; zero route rows kept; the route counts taken over the
//   non-deferred samples; the excluded count not summed; the excluded count added to the
//   denominator; a sample carrying no tally summed as a zero tally; killed summed into survived;
//   the mutant tally taken over the passing samples; the kill rate `?? 0`; the kill rate RENDERED
//   as `0.000` where it is `null`; the excluded count rendered as `0`; and the route rows not
//   rendered. The two no-rate mutants and the no-tally one fail the closed NOT MEASURED tests as
//   well as the property, which is what those tests are for.
//
// REQUIREMENT 9.4 IS CLAIMED HERE AS OF SCHEMA 13
//   Req 9.4 used to have no data path: the excluded count lived on `FormalMutationCounts` and
//   never reached `SweepSampleRecord`, so there was nothing for this property to assert
//   (`chipAgent/_inbox/gotcha-req-9-4-has-no-data-path-the-excluded-formal-mutant-count-never-reaches-the-sweep-record.md`).
//   Task 19.1 persisted the block inside schema 13 and task 19.5 reads it back, so the count is
//   asserted here as it is persisted, summed over the samples that carry one.
//   Property 22 asserts the pure counts.
//
// The tag string is a literal, not `propertyTag(...)`, whose `FEATURE_TAG` is hardcoded to a
// different spec's property numbering
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// **Validates: Requirements 7.10, 7.22, 8.7, 9.4, 9.6, 9.11, 9.12, 10.9, 12.17**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { SIMULATION_HARNESS_VERSION } from '@app/tools';

import {
  FALLBACK_ROUTES,
  PROPERTY_SET_ADMISSION_OUTCOMES,
  type FallbackRoute,
  type PropertySetAdmissionOutcome,
} from '@app/agent';
import {
  encodeSampleRecord,
  parseResultsLog,
  renderSummary,
  RESULTS_SCHEMA_VERSION,
  summarizeRecords,
  type ArmSummary,
  type FormalMutationCounts,
  type RecordedFormalRun,
  type SweepSampleRecord,
} from '@app/eval';
import {
  COULD_NOT_VERIFY_CAUSES,
  FORMAL_VERDICTS,
  type CouldNotVerifyCause,
  type FormalVerdict,
  type ProofConditions,
} from '@app/tools';

import { propertyParameters } from './property.js';

// **Feature: formal-property-oracle, Property 28: Every reported count equals the population's own
// tally**
const PROPERTY =
  "formal-property-oracle, Property 28: Every reported count equals the population's own tally";

/**
 * The shared default, sized to the rarest required row. Measured over 20,000 draws of
 * `populationArbitrary()` at seeds 1 and 42 (task 19.6, which re-measured every row because the
 * `producible` coupling of task 19.4 had moved the earlier figures), the share of populations
 * holding each row was: an arm whose frontend-rejected count differs from its `frontend-rejected`
 * Fallback_Reasons 24.2% / 24.3%, an arm no sample's tally reaches 26.7% / 26.9%, an arm holding a
 * refused and a `no-gate-set` sample 31.7% / 31.5%, a zero row to drop 55.0% / 55.3%, an arm whose
 * tallies sum to a zero denominator 56.4% / 57.6%, each kind of sample 63.2% to 64.2%, an excluded
 * mutant beside a scored one 65.9% / 66.6%, a measured kill rate 68.0% / 68.6%, a
 * `property-set-refused` route count that differs from the refused-admission count 68.1% / 67.3%,
 * a named reasonless route 71.2% / 71.6%, two arms whose tallies differ 75.5% / 76.1%, and an arm
 * whose fallback count differs from its `could-not-verify` bucket 78.3% / 78.7%. So the rarest is
 * missed in 100 runs with probability about 0.758^100 ~ 9e-13.
 * Each row is asserted as `> 0`, not as a share, so the arithmetic is `(1 - p)^n` rather than a
 * binomial tail.
 */
const NUM_RUNS = 100;

/** The experiment every generated record belongs to, and the one the summary is scoped to. */
const CONFIG_HASH = 'cfg-property-28';

/** The pass@k k values; no formal count reads them. */
const KS: readonly number[] = [1];

/** Three arms, so a count leaking between any two of them is visible. */
const ARM_NAMES = ['arm-a', 'arm-b', 'arm-c'] as const;
type ArmName = (typeof ARM_NAMES)[number];

/**
 * The longest population drawn. Measured mean length 4.9, with 10% of draws empty and 49% holding
 * all three arms; the long populations are the exhaustive case's job, not this generator's.
 */
const MAX_POPULATION = 10;

/** How many problems the samples are spread over; no formal count reads the problem. */
const PROBLEM_COUNT = 5;

/** The verdict that carries a cause. `satisfies`, so a rename breaks here. */
const COULD_NOT_VERIFY = 'could-not-verify' satisfies FormalVerdict;

/** The cause Req 8.7 counts on its own line. */
const FRONTEND_REJECTED = 'frontend-rejected' satisfies CouldNotVerifyCause;

/** The only Fallback_Route beside which a Fallback_Reason sits (Req 7.19, 12.31). */
const CAUSE_ROUTE = 'cause' satisfies FallbackRoute;

/** The Fallback_Routes that sit beside NO Fallback_Reason. */
const REASONLESS_ROUTES = FALLBACK_ROUTES.filter((route) => route !== CAUSE_ROUTE);

/** The route of a sample no gate ran for, which no route count may fold a fall back into. */
const NOT_APPLICABLE = 'not-applicable' satisfies FallbackRoute;

/** The route a refused Property_Set takes; its count is NOT the refused-admission count. */
const REFUSED_ROUTE = 'property-set-refused' satisfies FallbackRoute;

/**
 * The reasonless routes that NAME why a sample fell back without a cause: a route derived from
 * "has a reason" folds both of them into `not-applicable`, which claims nothing fell back.
 */
const NAMED_ABSENCE_ROUTES = REASONLESS_ROUTES.filter((route) => route !== NOT_APPLICABLE);

/** How many decimal places `renderSummary` prints a rate with; pinned here, not borrowed. */
const RATE_DIGITS = 3;

/** The most any one part of a sampled tally holds: small, so a failing sum is readable. */
const MAX_TALLY_PART = 9;

/** One mutant tally from its three parts; the other two counts are the sums Req 12.33 fixes. */
function mutantTallyOf(killed: number, survived: number, excluded: number): FormalMutationCounts {
  return {
    totalCount: killed + survived + excluded,
    denominator: killed + survived,
    killedCount: killed,
    survivedCount: survived,
    couldNotVerifyCount: excluded,
  };
}

/** The one admission outcome Req 10.9 counts. `no-gate-set` is NOT a refusal. */
const REFUSED = 'refused' satisfies PropertySetAdmissionOutcome;

/** The five conditions at their admitting values. No count reads them; the decoder needs them. */
const CONDITIONS: ProofConditions = {
  assertionCount: 2,
  presat: 'satisfiable',
  cover: { reached: true, step: 1 },
  base: 'passed',
  induction: 'successful',
};

/**
 * Every field the formal counts do NOT read, at values the decoder accepts. Each generated sample
 * overrides its arm, its slot, and the three fields the counts read.
 */
const BASE_RECORD: SweepSampleRecord = {
  schemaVersion: RESULTS_SCHEMA_VERSION,
  strategyArm: 'control',
  checkingApproach: 'cycle-timed',
  designGroup: 'cycle-exact',
  testbenchPromptVersion: 4,
  simulationHarnessVersion: SIMULATION_HARNESS_VERSION,
  testbenchParseRefusal: null,
  positiveControlRun: null,
  // The base sample's testbench was measured and gave every failure report a value.
  valuelessFailureReports: 0,
  configHash: CONFIG_HASH,
  armName: 'arm-a',
  modelSignature: 'zai.glm-5',
  problemId: 'problem-0',
  sampleIndex: 0,
  seed: 1,
  passed: true,
  outcomeStatus: 'verified',
  iterations: 1,
  costCents: 1,
  costKnown: true,
  promptTokens: 800,
  completionTokens: 200,
  totalTokens: 1_000,
  unreportedUsageCalls: 0,
  stopReason: null,
  goldenVerdict: 'passed',
  goldenFailureCount: 0,
  instrumentValidity: 'valid',
  instrumentDefect: null,
  instrumentUncheckedReason: null,
  mutation: {
    validCount: 4,
    killedCount: 4,
    noVerdictKills: 0,
    coverageGapOperators: [],
    candidateEquivalentOperators: [],
    goldenSurvivedCount: 2,
    goldenTimeoutCount: 0,
    nonCompilingCount: 1,
    goldenErroredCount: 0,
    elapsedMs: 3_200,
  },
  repairAttempted: false,
  repairAccepted: false,
  repairDeclineReason: null,
  checkNameVisibilitySignal: false,
  formal: null,
  formalFallbackReason: null,
  // The route and the mutant tally below are the two fields a sample DRAWS, so these are the
  // statements of a sample no gate ran for; `recordOf` overrides both.
  formalFallbackRoute: NOT_APPLICABLE,
  formalResetContract: null,
  formalAssertionGateEmitted: false,
  formalClockPolarity: null,
  propertySetAdmitted: 'not-gated',
  propertySetAuthoredUpFront: false,
  propertySetSurvivorCount: 0,
  formalMutationCounts: null,
  durationMs: 1_000,
  completedAtMs: 1_000,
  failureNote: null,
  noVerdictCause: null,
};

/** The four kinds of sample the summary's OTHER numbers tell apart. */
const REST_KINDS = ['verified-pass', 'judged-failure', 'instrument-invalid', 'deferred'] as const;
type RestKind = (typeof REST_KINDS)[number];

/** A sample the oracle judged and failed, on a valid instrument. */
const JUDGED_FAILURE: Partial<SweepSampleRecord> = {
  passed: false,
  outcomeStatus: 'unverified',
  iterations: 3,
  stopReason: 'max-iterations',
  goldenVerdict: 'failed',
  goldenFailureCount: 2,
};

/**
 * The fields that make each kind, laid over `BASE_RECORD`, which is the verified pass.
 *
 * The summary filters an arm into its passing samples, its pass@k denominator, its golden
 * denominator, and its non-deferred samples for its other numbers. While every record was a
 * verified pass, all of those WERE the arm, so a formal count taken over one of them passed this
 * file. A judged failure leaves the passing set; an instrument-invalid failure leaves the pass@k
 * denominator too; a deferred sample, which the oracle never reached, leaves every one of them.
 */
const REST_OF_RECORD: Readonly<Record<RestKind, Partial<SweepSampleRecord>>> = {
  'verified-pass': {},
  'judged-failure': JUDGED_FAILURE,
  'instrument-invalid': {
    ...JUDGED_FAILURE,
    instrumentValidity: 'invalid',
    instrumentDefect: 'TESTBENCH_FAILED_REFERENCE',
  },
  deferred: {
    passed: false,
    outcomeStatus: 'setup-failed',
    iterations: 0,
    stopReason: null,
    goldenVerdict: null,
    goldenFailureCount: null,
    instrumentValidity: 'unchecked',
    instrumentUncheckedReason: 'no-testbench',
    mutation: null,
    valuelessFailureReports: null,
    failureNote: 'testbench-unavailable: ALL_PROVIDERS_FAILED',
    noVerdictCause: 'provider-unreachable',
  },
};

/** One sample's counted fields, as generated: the snapshot every expectation is tallied from. */
interface DrawnSample {
  readonly armName: ArmName;
  /** The kind of sample the rest of its record makes it. No formal count reads it. */
  readonly rest: RestKind;
  /** The deciding Formal_Verdict, or `null` where no Formal_Property was submitted. */
  readonly verdict: FormalVerdict | null;
  /** The Could_Not_Verify_Cause, on a `could-not-verify` verdict only, as the decoder pairs it. */
  readonly cause: CouldNotVerifyCause | null;
  readonly fallbackReason: CouldNotVerifyCause | null;
  /**
   * The Fallback_Route, drawn as the pairing of `fallbackReason` Req 7.19 allows: `cause` beside a
   * reason, and one of the three other routes beside none. Tallied off THIS field, never derived
   * from the reason, since the three reasonless routes are exactly what a derivation would merge.
   */
  readonly route: FallbackRoute;
  readonly admission: PropertySetAdmissionOutcome;
  /** The Formal_Mutation_Counts the sample persists, `null` where no gate ran. */
  readonly mutationCounts: FormalMutationCounts | null;
}

/**
 * The route a drawn reason is written beside: `cause` for any reason, and `reasonlessRoute` -
 * one of the three others - for none (Req 7.19, 12.31).
 */
function routeBeside(
  fallbackReason: CouldNotVerifyCause | null,
  reasonlessRoute: FallbackRoute,
): FallbackRoute {
  return fallbackReason === null ? reasonlessRoute : CAUSE_ROUTE;
}

/**
 * The tallies a sampled sample may carry, in four states: no gate ran (`null`), a gate that
 * calibrated NOTHING, mutants calibrated with none scorable, and a scored tally of small parts.
 *
 * The first three weigh seven in ten, so an arm with no tally at all and an arm whose tallies
 * all have a zero denominator are both common. Those two are the no-rate arms of Req 9.11 and
 * 9.12, and a rate computed over them must read "not measured".
 */
function mutationCountsArbitrary(): fc.Arbitrary<FormalMutationCounts | null> {
  const part = fc.integer({ min: 0, max: MAX_TALLY_PART });
  return fc.oneof(
    { weight: 3, arbitrary: fc.constant<FormalMutationCounts | null>(null) },
    { weight: 2, arbitrary: fc.constant<FormalMutationCounts | null>(mutantTallyOf(0, 0, 0)) },
    {
      weight: 2,
      arbitrary: fc
        .integer({ min: 1, max: MAX_TALLY_PART })
        .map((excluded) => mutantTallyOf(0, 0, excluded)),
    },
    {
      weight: 3,
      arbitrary: fc
        .tuple(part, part, part)
        .map(([killed, survived, excluded]) => mutantTallyOf(killed, survived, excluded)),
    },
  );
}

/**
 * One sample's counted fields, each drawn over its whole closed vocabulary, read off its owner.
 *
 * Drawn INDEPENDENTLY of one another, so a Fallback_Reason sits beside every verdict and beside
 * none, and every admission outcome, every route, every mutant tally, and every kind of sample
 * beside every formal outcome. A summary that derived one count from another field would agree
 * with the loop's own pairing of them and still be caught here. The one coupling is the route's
 * to the reason (Req 7.19), which the decoder enforces, so a route drawn free of it would be a
 * record this file could persist and the product could not.
 */
function sampleArbitrary(): fc.Arbitrary<DrawnSample> {
  return fc
    .tuple(
      fc.constantFrom(...ARM_NAMES),
      fc.constantFrom(...REST_KINDS),
      fc.constantFrom<FormalVerdict | null>(null, ...FORMAL_VERDICTS),
      fc.constantFrom(...COULD_NOT_VERIFY_CAUSES),
      fc.oneof(fc.constant(null), fc.constantFrom(...COULD_NOT_VERIFY_CAUSES)),
      fc.constantFrom(...PROPERTY_SET_ADMISSION_OUTCOMES),
      fc.constantFrom(...REASONLESS_ROUTES),
      mutationCountsArbitrary(),
    )
    .map(
      ([
        armName,
        rest,
        verdict,
        cause,
        fallbackReason,
        admission,
        reasonlessRoute,
        mutationCounts,
      ]) =>
        producible({
          armName,
          rest,
          verdict,
          cause: verdict === COULD_NOT_VERIFY ? cause : null,
          fallbackReason,
          route: routeBeside(fallbackReason, reasonlessRoute),
          admission,
          mutationCounts,
        }),
    );
}

/** The kind of sample whose record can carry no formal run at all. */
const DEFERRED = 'deferred' satisfies RestKind;

/**
 * One drawn shape reduced to a shape the product can actually WRITE (Req 12.29).
 *
 * A `deferred` sample is `outcomeStatus: 'setup-failed'`, which `VerificationLoop#verify`
 * returns straight out of `#setup` - before a candidate or an independent testbench exists - so
 * no Formal_Property can have been submitted and the deciding run is `null`. The decoder refuses
 * a `setup-failed` record carrying one, so a drawn shape pairing the two is a record this file
 * could persist and the product could not, and the round trip through the real log would count
 * it malformed rather than aggregate it.
 *
 * Applied where the shape is DRAWN rather than where the record is built, because `tallyOf`
 * reads `verdict` off the drawn shape: fixing it only in `recordOf` would leave this file's own
 * tally expecting a verdict the persisted record does not carry. Every other pairing stays the
 * full independent cross, which is what makes a summary that derives one count from another
 * field visible here.
 */
function producible<Shape extends Pick<DrawnSample, 'rest' | 'verdict' | 'cause'>>(
  shape: Shape,
): Shape {
  return shape.rest === DEFERRED ? { ...shape, verdict: null, cause: null } : shape;
}

/** A population: empty, or up to `MAX_POPULATION` samples over the three arms. */
function populationArbitrary(): fc.Arbitrary<readonly DrawnSample[]> {
  return fc.array(sampleArbitrary(), { maxLength: MAX_POPULATION });
}

/**
 * The tallies the exhaustive population hands out round-robin: no gate ran, a gate that
 * calibrated nothing, mutants calibrated with none scorable, and two scored tallies whose every
 * part differs, in every pair and from the other tallies.
 *
 * DISTINCT PARTS, so a summation that swapped two counts, summed a rate instead of a count, or
 * put the excluded count into the denominator changes the arm's totals. Over one cycle of the
 * five, the killed, survived, excluded, denominator, and total sums are 14, 7, 11, 21, and 32, all
 * different; and the two scored rates, 3/8 and 11/13, average to a number that is not 14/21.
 */
const EXHAUSTIVE_TALLIES: readonly (FormalMutationCounts | null)[] = [
  null,
  mutantTallyOf(0, 0, 0),
  mutantTallyOf(0, 0, 3),
  mutantTallyOf(3, 5, 7),
  mutantTallyOf(11, 2, 1),
];

/** The exhaustive tally shape `index` carries. FIVE, which is coprime to both arm strides. */
function exhaustiveTallyAt(index: number): FormalMutationCounts | null {
  const tally = EXHAUSTIVE_TALLIES[index % EXHAUSTIVE_TALLIES.length];
  if (tally === undefined) {
    throw new Error('the exhaustive tally table is empty');
  }
  return tally;
}

/** A Fallback_Reason and the route beside it: `cause` beside each cause, each other route alone. */
const EVERY_FALLBACK_READING: readonly Pick<DrawnSample, 'fallbackReason' | 'route'>[] =
  FALLBACK_ROUTES.flatMap((route): readonly Pick<DrawnSample, 'fallbackReason' | 'route'>[] =>
    route === CAUSE_ROUTE
      ? COULD_NOT_VERIFY_CAUSES.map((fallbackReason) => ({ fallbackReason, route }))
      : [{ fallbackReason: null, route }],
  );

/**
 * Every shape one sample's counted fields can take, each exactly once in each kind of sample:
 * 14 formal x 14 fallback readings x 4 admissions = 784 counted shapes, in each of the 4 kinds.
 *
 * Built from the vocabularies' owners, so a member added to one of them is a shape here at once.
 * A fallback reading is a reason AND its route: the `cause` route beside each of the 11 causes,
 * and each of the 3 other routes beside no reason (Req 7.19).
 *
 * Each shape then passes through `producible`, so the `deferred` kind's 14 formal shapes all
 * collapse onto the no-run one - a `setup-failed` record carries no Formal_Verdict (Req 12.29).
 * The list KEEPS its length rather than being filtered, so `exhaustivePopulation`'s every-second
 * and every-third strides across it are unchanged; the collapsed cells are duplicates, and a
 * duplicate costs a tally nothing because every count here is a count.
 *
 * The mutant tallies are handed out by position, five to a cycle, which is coprime to both
 * strides, so each of the three arms sees every tally and no two arms sum alike.
 */
function everyShape(): readonly Omit<DrawnSample, 'armName'>[] {
  const formalShapes: readonly Pick<DrawnSample, 'verdict' | 'cause'>[] = [
    { verdict: null, cause: null },
    ...FORMAL_VERDICTS.flatMap((verdict): Pick<DrawnSample, 'verdict' | 'cause'>[] =>
      verdict === COULD_NOT_VERIFY
        ? COULD_NOT_VERIFY_CAUSES.map((cause) => ({ verdict, cause }))
        : [{ verdict, cause: null }],
    ),
  ];
  return REST_KINDS.flatMap((rest) =>
    formalShapes.flatMap((formal) =>
      EVERY_FALLBACK_READING.flatMap((reading) =>
        PROPERTY_SET_ADMISSION_OUTCOMES.map((admission) =>
          producible({ rest, ...formal, ...reading, admission }),
        ),
      ),
    ),
  ).map((shape, index) => ({ ...shape, mutationCounts: exhaustiveTallyAt(index) }));
}

/**
 * The closed part of the space, as one population: `arm-a` holds every shape once, `arm-b` every
 * second shape, and `arm-c` every third, so every member of every counted vocabulary is counted
 * and no two arms tally alike.
 */
function exhaustivePopulation(): readonly DrawnSample[] {
  return everyShape().flatMap((shape, index) => [
    { ...shape, armName: 'arm-a' as const },
    ...(index % 2 === 0 ? [{ ...shape, armName: 'arm-b' as const }] : []),
    ...(index % 3 === 0 ? [{ ...shape, armName: 'arm-c' as const }] : []),
  ]);
}

/** The deciding run a drawn verdict stands for, or `null` where none was submitted. */
function formalRunOf(sample: DrawnSample): RecordedFormalRun | null {
  if (sample.verdict === null) {
    return null;
  }
  return {
    verdict: sample.verdict,
    cause: sample.cause,
    conditions: CONDITIONS,
    depth: 20,
    elapsedMs: 3_350,
  };
}

/** The persisted record for one drawn sample, in its own slot of its own arm. */
function recordOf(sample: DrawnSample, index: number): SweepSampleRecord {
  return {
    ...BASE_RECORD,
    ...REST_OF_RECORD[sample.rest],
    armName: sample.armName,
    problemId: `problem-${index % PROBLEM_COUNT}`,
    sampleIndex: index,
    formal: formalRunOf(sample),
    formalFallbackReason: sample.fallbackReason,
    // Req 7.19, 12.31: the route is the drawn pairing of the reason, so this is a record the
    // decoder reads; the route is still tallied off `sample.route`, never off the reason.
    formalFallbackRoute: sample.route,
    propertySetAdmitted: sample.admission,
    propertySetAuthoredUpFront: false,
    formalMutationCounts: sample.mutationCounts,
  };
}

/** A breakdown as a cause -> count map, holding only the causes that occur. */
type CauseTally = Readonly<Record<string, number>>;

/** One arm's formal numbers as this file states them, tallied straight off the drawn fields. */
interface ArmTally {
  readonly sampleCount: number;
  readonly verdictCounts: Readonly<Record<FormalVerdict, number>>;
  readonly noneSubmittedSamples: number;
  readonly causeCounts: CauseTally;
  readonly fallbackSamples: number;
  readonly fallbackReasonCounts: CauseTally;
  readonly frontendRejectedSamples: number;
  /** Refused admissions, or `null` where NO sample in the arm was gated at all (Req 9.5, 9.6). */
  readonly propertySetRefusedSamples: number | null;
  readonly routeCounts: CauseTally;
  /** The arm's summed Formal_Mutation_Counts, or `null` where no sample carries a tally. */
  readonly mutationCounts: FormalMutationCounts | null;
  /** `killed / denominator` over the SUMMED counts, or `null` where there is nothing to rate. */
  readonly mutationKillRate: number | null;
}

/**
 * Count each member of `vocabulary` a list holds, keeping only the members that occur at least
 * once.
 *
 * Keyed in the vocabulary's own order, so two equal tallies serialize alike (see `recordShape`).
 */
function occurrences(
  vocabulary: readonly string[],
  values: readonly (string | null)[],
): CauseTally {
  return Object.fromEntries(
    vocabulary.flatMap((member) => {
      const count = values.filter((candidate) => candidate === member).length;
      return count === 0 ? [] : [[member, count] as const];
    }),
  );
}

/** The sum of one count over the tallies an arm carries. */
function sumOf(carried: readonly FormalMutationCounts[], part: keyof FormalMutationCounts): number {
  return carried.reduce((total, counts) => total + counts[part], 0);
}

/**
 * The arm's mutant tallies summed field by field, or `null` where NO sample carries one.
 *
 * Summing nothing is an all-zero tally, which reads as a gate that calibrated mutants and scored
 * none; `null` reads as "no gate ran" (Req 9.10, 9.12). The guard is therefore on how many
 * samples carry a tally, not on the totals: an arm whose gate calibrated zero mutants is MEASURED.
 */
function summedMutationCounts(samples: readonly DrawnSample[]): FormalMutationCounts | null {
  const carried = samples.flatMap((sample) =>
    sample.mutationCounts === null ? [] : [sample.mutationCounts],
  );
  if (carried.length === 0) {
    return null;
  }
  return {
    totalCount: sumOf(carried, 'totalCount'),
    denominator: sumOf(carried, 'denominator'),
    killedCount: sumOf(carried, 'killedCount'),
    survivedCount: sumOf(carried, 'survivedCount'),
    couldNotVerifyCount: sumOf(carried, 'couldNotVerifyCount'),
  };
}

/**
 * The refused admissions of one arm, or `null` where NO sample was gated (Req 9.5, 9.6).
 *
 * The same shape as `summedMutationCounts` above, and for the same reason: an arm whose every
 * sample reads `not-gated` has no refusal count to report, while an arm that was gated and
 * refused none reports `0`. A count of `0` for both would read as a gate that ran cleanly.
 * `no-gate-set` is a gate that RAN, so it is gated here and still not a refusal.
 */
function refusedAdmissions(samples: readonly DrawnSample[]): number | null {
  const gated = samples.filter((sample) => sample.admission !== 'not-gated');
  return gated.length === 0 ? null : gated.filter((sample) => sample.admission === REFUSED).length;
}

/** The independent tally of one arm: every count, read off the one drawn field it names. */
function tallyOf(samples: readonly DrawnSample[]): ArmTally {
  const count = (holds: (sample: DrawnSample) => boolean): number => samples.filter(holds).length;
  const mutationCounts = summedMutationCounts(samples);
  return {
    sampleCount: samples.length,
    verdictCounts: {
      proved: count((sample) => sample.verdict === 'proved'),
      refuted: count((sample) => sample.verdict === 'refuted'),
      'could-not-verify': count((sample) => sample.verdict === COULD_NOT_VERIFY),
    },
    noneSubmittedSamples: count((sample) => sample.verdict === null),
    causeCounts: occurrences(
      COULD_NOT_VERIFY_CAUSES,
      samples.map((sample) => sample.cause),
    ),
    fallbackSamples: count((sample) => sample.fallbackReason !== null),
    fallbackReasonCounts: occurrences(
      COULD_NOT_VERIFY_CAUSES,
      samples.map((sample) => sample.fallbackReason),
    ),
    frontendRejectedSamples: count((sample) => sample.cause === FRONTEND_REJECTED),
    propertySetRefusedSamples: refusedAdmissions(samples),
    routeCounts: occurrences(
      FALLBACK_ROUTES,
      samples.map((sample) => sample.route),
    ),
    mutationCounts,
    mutationKillRate:
      mutationCounts === null || mutationCounts.denominator === 0
        ? null
        : mutationCounts.killedCount / mutationCounts.denominator,
  };
}

/** Each arm the population holds, with its tally; an arm holding no sample is absent. */
function tallyByArm(population: readonly DrawnSample[]): ReadonlyMap<string, ArmTally> {
  return new Map(
    ARM_NAMES.flatMap((armName) => {
      const own = population.filter((sample) => sample.armName === armName);
      return own.length === 0 ? [] : [[armName, tallyOf(own)] as const];
    }),
  );
}

type ArmFormal = ArmSummary['formal'];
type CauseEntry = ArmFormal['causeCounts'][number];

/** A reported breakdown as a cause -> count map; a cause reported twice fails here. */
function entriesOf(breakdown: readonly CauseEntry[]): CauseTally {
  const entries = Object.fromEntries(breakdown.map(({ cause, count }) => [cause, count]));
  expect(Object.keys(entries)).toHaveLength(breakdown.length);
  return entries;
}

/** The reported Fallback_Route breakdown as a route -> count map; a route reported twice fails. */
function routeEntriesOf(breakdown: ArmFormal['routeCounts']): CauseTally {
  const entries = Object.fromEntries(breakdown.map(({ route, count }) => [route, count]));
  expect(Object.keys(entries)).toHaveLength(breakdown.length);
  return entries;
}

/** Clause 1: every count the arm reports equals its own tally. */
function assertCounts(formal: ArmFormal, tally: ArmTally): void {
  expect(formal.verdictCounts).toEqual(tally.verdictCounts);
  expect(formal.noneSubmittedSamples).toBe(tally.noneSubmittedSamples);
  expect(entriesOf(formal.causeCounts)).toEqual(tally.causeCounts);
  expect(formal.fallbackSamples).toBe(tally.fallbackSamples);
  expect(entriesOf(formal.fallbackReasonCounts)).toEqual(tally.fallbackReasonCounts);
  expect(formal.frontendRejectedSamples).toBe(tally.frontendRejectedSamples);
  expect(formal.propertySetRefusedSamples).toBe(tally.propertySetRefusedSamples);
  expect(routeEntriesOf(formal.routeCounts)).toEqual(tally.routeCounts);
  // The excluded-mutant count is `couldNotVerifyCount` of this block (Req 9.4), and `null` is
  // "no sample carries a tally", which `toEqual` keeps apart from an all-zero block.
  expect(formal.mutationCounts).toEqual(tally.mutationCounts);
  expect(formal.mutationKillRate).toBe(tally.mutationKillRate);
}

/** Clause 2: the verdict buckets and the none-submitted count partition the arm, and so do the routes. */
function assertPartition(arm: ArmSummary, tally: ArmTally): void {
  // Summed over the vocabulary's owner, so a bucket the summary failed to fill fails the sum.
  const submitted = FORMAL_VERDICTS.reduce(
    (sum, verdict) => sum + arm.formal.verdictCounts[verdict],
    0,
  );
  expect(submitted + arm.formal.noneSubmittedSamples).toBe(arm.sampleCount);
  expect(arm.sampleCount).toBe(tally.sampleCount);
  // Every record carries exactly one route, so the route entries sum to the arm (Req 7.21).
  expect(arm.formal.routeCounts.reduce((sum, { count }) => sum + count, 0)).toBe(arm.sampleCount);
}

/** Clauses 3 and 4: no zero row, and each breakdown sums to the total it breaks down. */
function assertBreakdowns(formal: ArmFormal): void {
  const sum = (entries: readonly CauseEntry[]): number =>
    entries.reduce((total, entry) => total + entry.count, 0);
  for (const entry of [
    ...formal.causeCounts,
    ...formal.fallbackReasonCounts,
    ...formal.routeCounts,
  ]) {
    expect(entry.count).toBeGreaterThan(0);
  }
  expect(sum(formal.causeCounts)).toBe(formal.verdictCounts[COULD_NOT_VERIFY]);
  expect(sum(formal.fallbackReasonCounts)).toBe(formal.fallbackSamples);
  const frontendEntry = formal.causeCounts.find((entry) => entry.cause === FRONTEND_REJECTED);
  expect(formal.frontendRejectedSamples).toBe(frontendEntry?.count ?? 0);
}

/** A rendered breakdown entry: a cause, then its count, ending the line. */
const RENDERED_ENTRY = /\s([a-z-]+) x(\d+)$/;

/** The rendered lines of one arm: its header up to the next arm's header, or the end. */
function armBlock(lines: readonly string[], armName: string): readonly string[] {
  const start = lines.findIndex((line) => line.startsWith(`arm ${armName}  [`));
  expect(start).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('arm '));
  return lines.slice(start, end === -1 ? lines.length : end);
}

/** The breakdown entries a span of rendered lines prints, as a cause -> count map. */
function renderedEntries(span: readonly string[]): CauseTally {
  const entries = span.flatMap((line) => {
    const match = RENDERED_ENTRY.exec(line);
    return match?.[1] === undefined ? [] : [[match[1], Number(match[2])] as const];
  });
  expect(new Set(entries.map(([cause]) => cause)).size).toBe(entries.length);
  return Object.fromEntries(entries);
}

/**
 * Clause 5: the arm's rendered block prints the tallied numbers.
 *
 * The refused count prints NOT MEASURED where no sample was gated and a number otherwise
 * (Req 9.5, 9.6). The `NO_RATE_ARMS` populations below are all-`not-gated`, so that branch is met
 * on every run rather than waited on from a draw.
 */
function assertRendered(lines: readonly string[], armName: string, tally: ArmTally): void {
  const block = armBlock(lines, armName);
  const lineAt = (prefix: string): number => block.findIndex((line) => line.startsWith(prefix));
  const verdicts = FORMAL_VERDICTS.map((verdict) => `${verdict} ${tally.verdictCounts[verdict]}`);
  const [verdictLine, fallbackLine, frontendLine, refusedLine] = [
    lineAt('  formal verdict:'),
    lineAt('  fallback:'),
    lineAt('  frontend-rejected:'),
    lineAt('  property-set-refused:'),
  ];
  expect(block[verdictLine]).toBe(
    `  formal verdict:  ${verdicts.join('  ')}  none-submitted ${tally.noneSubmittedSamples}  ` +
      `(of ${tally.sampleCount} recorded sample(s))`,
  );
  expect(block[fallbackLine]).toBe(
    `  fallback:        ${tally.fallbackSamples} sample(s) decided by the Simulation_Fallback ` +
      'on a recorded Fallback_Reason',
  );
  expect(block[frontendLine]).toBe(
    `  frontend-rejected: ${tally.frontendRejectedSamples} sample(s) whose candidate design the ` +
      'formal frontend rejected',
  );
  expect(block[refusedLine]).toBe(
    tally.propertySetRefusedSamples === null
      ? '  property-set-refused: NOT MEASURED - no sample in this arm was gated, so there is no'
      : `  property-set-refused: ${tally.propertySetRefusedSamples} sample(s), of the samples ` +
          'this arm gated, whose Property_Set was refused as inadmissible',
  );
  expect(renderedEntries(block.slice(verdictLine + 1, fallbackLine))).toEqual(tally.causeCounts);
  expect(renderedEntries(block.slice(fallbackLine + 1, frontendLine))).toEqual(
    tally.fallbackReasonCounts,
  );
  assertRenderedRoutes(block, refusedLine, tally);
  assertRenderedMutants(block, tally);
}

/**
 * The Fallback_Route rows: printed BELOW `property-set-refused:`, and exactly the tallied routes.
 *
 * The position is part of the claim. The two windows above scrape every `<key> x<n>` line between
 * the verdict and `fallback:` lines and between `fallback:` and `frontend-rejected:`, so a route
 * row printed inside either would be read as a cause or a reason and fail those two assertions
 * for a reason that is not the aggregation's
 * (`chipAgent/_inbox/gotcha-a-new-tally-row-between-the-fallback-and-frontend-rejected-lines-breaks-property-28s-rendered-scraper.md`).
 * The rows are the run of `<key> x<n>` lines from the `fallback route:` label onward.
 */
function assertRenderedRoutes(
  block: readonly string[],
  refusedLine: number,
  tally: ArmTally,
): void {
  const routeLine = block.findIndex((line) => line.startsWith('  fallback route:'));
  expect(routeLine).toBeGreaterThan(refusedLine);
  const fromLabel = block.slice(routeLine);
  const end = fromLabel.findIndex((line) => !RENDERED_ENTRY.test(line));
  expect(renderedEntries(end === -1 ? fromLabel : fromLabel.slice(0, end))).toEqual(
    tally.routeCounts,
  );
}

/**
 * The formal mutant block: the excluded count printed beside the killed and survived ones, and
 * the kill rate printed as a number only where there is a denominator to divide by.
 *
 * NOT MEASURED, NEVER `0` (Req 9.11, 9.12). An arm no sample's tally reaches prints the one
 * `formal mutants:  NOT MEASURED` block and no rate line at all; an arm whose summed denominator is
 * zero prints its counts and a `NOT MEASURED` rate. A rate of `0` is for an arm that scored and
 * killed nothing, which is asserted to render as a number.
 */
function assertRenderedMutants(block: readonly string[], tally: ArmTally): void {
  const mutantsLine = block.find((line) => line.startsWith('  formal mutants:'));
  const rateLine = block.find((line) => line.startsWith('  formal kill rate:'));
  const counts = tally.mutationCounts;
  if (counts === null) {
    expect(mutantsLine?.startsWith('  formal mutants:  NOT MEASURED')).toBe(true);
    expect(rateLine).toBeUndefined();
    return;
  }
  expect(mutantsLine).toBe(
    `  formal mutants:  killed ${counts.killedCount}/${counts.denominator} scored  ` +
      `survived ${counts.survivedCount}  excluded ${counts.couldNotVerifyCount}  ` +
      `of ${counts.totalCount} calibrated mutant(s)`,
  );
  expect(rateLine).toBe(
    tally.mutationKillRate === null
      ? '  formal kill rate: NOT MEASURED'
      : `  formal kill rate: ${tally.mutationKillRate.toFixed(RATE_DIGITS)}`,
  );
}

/** The Sweep_Summary of a population's persisted file, and its rendered lines. */
function summarizePersisted(population: readonly DrawnSample[]): {
  readonly summary: ReturnType<typeof summarizeRecords>;
  readonly lines: readonly string[];
} {
  const parsed = parseResultsLog(population.map(recordOf).map(encodeSampleRecord).join('\n'));
  const summary = summarizeRecords(parsed.records, KS, CONFIG_HASH, parsed);
  return { summary, lines: renderSummary(summary) };
}

/**
 * Every clause of Property 28 for one population, over the TEXT its records persist as: the file
 * is parsed, aggregated scoped to its experiment, and rendered, as the sweep does.
 *
 * The tally is taken from the drawn fields BEFORE a record is encoded, so a summary or a decoder
 * that rewrote a field on the way through cannot move the expectation with it.
 */
function assertAggregation(population: readonly DrawnSample[]): void {
  const tallies = tallyByArm(population);
  const { summary, lines } = summarizePersisted(population);
  // Every record decoded and was aggregated, so the population IS the persisted file.
  expect(summary.refusedStaleSchema).toBe(false);
  expect(summary.malformedLines).toBe(0);
  expect(summary.totalSamples).toBe(population.length);
  expect(summary.arms).toHaveLength(tallies.size);
  expect(summary.arms.reduce((total, arm) => total + arm.sampleCount, 0)).toBe(population.length);
  for (const [armName, tally] of tallies) {
    const arm = summary.arms.find((candidate) => candidate.armName === armName);
    if (arm === undefined) {
      throw new Error(`arm ${armName} holds ${tally.sampleCount} sample(s) and was not reported`);
    }
    assertCounts(arm.formal, tally);
    assertPartition(arm, tally);
    assertBreakdowns(arm.formal);
    assertRendered(lines, armName, tally);
  }
}

/** What the run drew, so each clause is shown to have met the case it is about. */
interface DrawnShapes {
  runs: number;
  /** Populations over two or more arms whose tallies differ: where a leaked count shows. */
  leakVisible: number;
  /** Arms whose fallback count differs from their `could-not-verify` bucket. */
  fallbackDiverged: number;
  /** Arms whose frontend-rejected count differs from their `frontend-rejected` Fallback_Reasons. */
  frontendDiverged: number;
  /** Arms holding a refused AND a `no-gate-set` sample, where merging the two shows. */
  refusedBesideNoGateSet: number;
  /** Arms with a `could-not-verify` sample beside a cause that holds none: a zero row to drop. */
  zeroRowToDrop: number;
  /** Arms holding a route that is NEITHER `cause` nor `not-applicable`: what a route derived from the reason folds away. */
  reasonlessRoute: number;
  /** Arms whose `property-set-refused` route count differs from their refused-admission count. */
  routeAdmissionDiverged: number;
  /** Arms no sample's tally reaches: the `null` counts and the NOT MEASURED block. */
  noTally: number;
  /** Arms carrying tallies whose summed denominator is zero: a rate of nothing, not of zero. */
  zeroDenominator: number;
  /** Arms with a measured kill rate. */
  measuredRate: number;
  /** Arms with an excluded mutant beside a scored one: the excluded count is not in the denominator. */
  excludedBesideScored: number;
  /** Populations holding each kind of sample, where a formal count over a sub-population shows. */
  readonly restKinds: Map<RestKind, number>;
}

function noShapesDrawn(): DrawnShapes {
  return {
    runs: 0,
    leakVisible: 0,
    fallbackDiverged: 0,
    frontendDiverged: 0,
    refusedBesideNoGateSet: 0,
    zeroRowToDrop: 0,
    reasonlessRoute: 0,
    routeAdmissionDiverged: 0,
    noTally: 0,
    zeroDenominator: 0,
    measuredRate: 0,
    excludedBesideScored: 0,
    restKinds: new Map(),
  };
}

/** One `verified-pass` sample in `arm-a` with no formal run, carrying `mutationCounts`. */
function sampleWithTally(mutationCounts: FormalMutationCounts | null): DrawnSample {
  return {
    armName: 'arm-a',
    rest: 'verified-pass',
    verdict: null,
    cause: null,
    fallbackReason: null,
    route: NOT_APPLICABLE,
    admission: 'not-gated',
    mutationCounts,
  };
}

/**
 * The arms with NO formal kill rate (Req 9.11, 9.12), each a closed input rather than a draw:
 * no sample carries a tally, a gate that calibrated nothing, and a gate whose every calibrated
 * mutant was excluded - the last beside a `null` sample, so a summation that counted the sample
 * carrying no tally as a zero tally is not the one that gets the arm right.
 */
const NO_RATE_ARMS: readonly {
  readonly label: string;
  readonly tallies: readonly (FormalMutationCounts | null)[];
}[] = [
  { label: 'an arm no gate ran for', tallies: [null, null] },
  { label: 'an arm whose gate calibrated nothing', tallies: [mutantTallyOf(0, 0, 0)] },
  {
    label: 'an arm whose every calibrated mutant was excluded',
    tallies: [mutantTallyOf(0, 0, 3), null, mutantTallyOf(0, 0, 2)],
  },
];

/** Record the mutant-tally shape of one arm. A NON-VACUITY COUNTER, never part of an expectation. */
function recordMutantShape(drawn: DrawnShapes, tally: ArmTally): void {
  const counts = tally.mutationCounts;
  drawn.noTally += counts === null ? 1 : 0;
  drawn.zeroDenominator += counts !== null && counts.denominator === 0 ? 1 : 0;
  drawn.measuredRate += tally.mutationKillRate === null ? 0 : 1;
  drawn.excludedBesideScored +=
    counts !== null && counts.couldNotVerifyCount > 0 && counts.denominator > 0 ? 1 : 0;
}

/** Record one population's shape. A NON-VACUITY COUNTER, never part of an expectation. */
function recordShape(drawn: DrawnShapes, population: readonly DrawnSample[]): void {
  const tallies = [...tallyByArm(population).values()];
  const distinctTallies = new Set(tallies.map((tally) => JSON.stringify(tally))).size;
  drawn.runs += 1;
  drawn.leakVisible += distinctTallies > 1 ? 1 : 0;
  for (const tally of tallies) {
    const couldNotVerify = tally.verdictCounts[COULD_NOT_VERIFY];
    const frontendFallbacks = tally.fallbackReasonCounts[FRONTEND_REJECTED] ?? 0;
    drawn.fallbackDiverged += tally.fallbackSamples === couldNotVerify ? 0 : 1;
    drawn.frontendDiverged += tally.frontendRejectedSamples === frontendFallbacks ? 0 : 1;
    drawn.zeroRowToDrop +=
      couldNotVerify > 0 && Object.keys(tally.causeCounts).length < COULD_NOT_VERIFY_CAUSES.length
        ? 1
        : 0;
    recordMutantShape(drawn, tally);
    drawn.reasonlessRoute += NAMED_ABSENCE_ROUTES.some((route) => route in tally.routeCounts)
      ? 1
      : 0;
    drawn.routeAdmissionDiverged +=
      (tally.routeCounts[REFUSED_ROUTE] ?? 0) === (tally.propertySetRefusedSamples ?? 0) ? 0 : 1;
  }
  for (const armName of ARM_NAMES) {
    const admissions = new Set(
      population.filter((sample) => sample.armName === armName).map((sample) => sample.admission),
    );
    drawn.refusedBesideNoGateSet +=
      admissions.has(REFUSED) && admissions.has('no-gate-set') ? 1 : 0;
  }
  for (const rest of new Set(population.map((sample) => sample.rest))) {
    drawn.restKinds.set(rest, (drawn.restKinds.get(rest) ?? 0) + 1);
  }
}

describe(PROPERTY, () => {
  it('reports its own tally over the two closed extremes: no sample, and every shape at once', () => {
    assertAggregation([]);

    const population = exhaustivePopulation();
    const exhaustiveArm = population.filter((sample) => sample.armName === 'arm-a');
    const everyMember = tallyOf(exhaustiveArm);
    // The exhaustive arm really holds every member of every counted vocabulary, in every kind of
    // sample, so this case counts each of them on every run.
    expect(new Set(exhaustiveArm.map((sample) => sample.rest))).toEqual(new Set(REST_KINDS));
    expect(Object.keys(everyMember.causeCounts)).toEqual([...COULD_NOT_VERIFY_CAUSES]);
    expect(Object.keys(everyMember.fallbackReasonCounts)).toEqual([...COULD_NOT_VERIFY_CAUSES]);
    expect(FORMAL_VERDICTS.every((verdict) => everyMember.verdictCounts[verdict] > 0)).toBe(true);
    expect(everyMember.noneSubmittedSamples).toBeGreaterThan(0);
    expect(everyMember.propertySetRefusedSamples).toBeGreaterThan(0);
    // All FOUR Fallback_Routes are counted, in the vocabulary's own order, and the arm carries a
    // measured tally with an excluded mutant beside a scored one and a rate of its own.
    expect(Object.keys(everyMember.routeCounts)).toEqual([...FALLBACK_ROUTES]);
    expect(everyMember.mutationCounts?.couldNotVerifyCount).toBeGreaterThan(0);
    expect(everyMember.mutationCounts?.denominator).toBeGreaterThan(0);
    expect(everyMember.mutationKillRate).not.toBeNull();
    assertAggregation(population);
  });

  it.each(NO_RATE_ARMS)(
    'renders $label as NOT MEASURED, never as a rate of 0 (Property 22)',
    ({ tallies }) => {
      const population = tallies.map(sampleWithTally);
      assertAggregation(population);

      const { summary, lines } = summarizePersisted(population);
      const [arm] = summary.arms;
      expect(arm?.formal.mutationKillRate).toBeNull();
      // No line of the rendered summary states a rate of zero, as a number or as a `0` word.
      expect(lines.filter((line) => /formal kill rate: +0/.test(line))).toEqual([]);
    },
  );

  it('renders a gate that scored and killed nothing as the rate 0, which NOT MEASURED is not', () => {
    const population = [sampleWithTally(mutantTallyOf(0, 4, 1))];
    assertAggregation(population);

    const { summary, lines } = summarizePersisted(population);
    const [arm] = summary.arms;
    expect(arm?.formal.mutationKillRate).toBe(0);
    expect(lines).toContain(`  formal kill rate: ${(0).toFixed(RATE_DIGITS)}`);
  });

  it('reports its own tally for every arm of any population spread over three arms', () => {
    const drawn = noShapesDrawn();
    fc.assert(
      fc.property(populationArbitrary(), (population) => {
        recordShape(drawn, population);
        assertAggregation(population);
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );
    // Non-vacuity: each clause met the case it is about
    // (`chipAgent/_inbox/gotcha-golden-denominator-property-test-was-vacuous-for-new-status.md`).
    expect(drawn.runs).toBe(NUM_RUNS);
    expect(drawn.leakVisible).toBeGreaterThan(0);
    expect(drawn.fallbackDiverged).toBeGreaterThan(0);
    expect(drawn.frontendDiverged).toBeGreaterThan(0);
    expect(drawn.refusedBesideNoGateSet).toBeGreaterThan(0);
    expect(drawn.zeroRowToDrop).toBeGreaterThan(0);
    // The Fallback_Route and mutant-tally clauses met the arms they are about: a named reasonless
    // route a derivation would fold, a refused route beside a refusal count that differs, an arm
    // no tally reaches, an arm of tallies with nothing to rate, a measured rate, and an excluded
    // mutant beside a scored one.
    expect(drawn.reasonlessRoute).toBeGreaterThan(0);
    expect(drawn.routeAdmissionDiverged).toBeGreaterThan(0);
    expect(drawn.noTally).toBeGreaterThan(0);
    expect(drawn.zeroDenominator).toBeGreaterThan(0);
    expect(drawn.measuredRate).toBeGreaterThan(0);
    expect(drawn.excludedBesideScored).toBeGreaterThan(0);
    // Every kind of sample was drawn, so a formal count over the passing samples, the pass@k
    // denominator, or the non-deferred samples missed its tally somewhere in the run.
    expect([...drawn.restKinds.keys()].sort()).toEqual([...REST_KINDS].sort());
  });
});
