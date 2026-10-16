// formal-property-oracle, Property 26: The record round-trips every new field and rejects every
// non-member value (task 12.6).
//
// WHAT IS CLAIMED, OVER WHAT
//   1. ROUND TRIP. Over every sample record this file generates, the line `encodeSampleRecord`
//      writes reads back through `parseResultsLog` as exactly that record and nothing else: one
//      record, no malformed line, no stale one. The comparison is strict over the WHOLE record, so
//      every formal field is held at once - the Formal_Verdict, the Could_Not_Verify_Cause, the
//      FIVE Proof_Conditions, the Proof_Depth, the elapsed time, the Fallback_Reason (Req 7.9), the
//      Property_Set admission outcome over its four members and the surviving-mutant count
//      (Req 10.8), the derived Reset_Contract's net, polarity, kind, and free-initial-state fact,
//      whether the `if (!$initstate)` gate was emitted, and the Clock_Contract's `clockPolarity`
//      (Req 12.11, 12.21, persisting what Req 14.27 and 14.39 have the Formal_Outcome record).
//      Two distinctions ride on that equality: a `null` Reset_Contract and a `{ derived: false }`
//      one each decode to themselves, and a `null` `clockPolarity` decodes as `null` rather than
//      as `'none'` or any other member.
//      Three more fields ride on it (Req 7.21, 9.9, 9.10). The Fallback_Route (`formalFallbackRoute`)
//      is EXHAUSTED rather than sampled: a loop takes each of the FOURTEEN pairings Req 7.19
//      allows - the `cause` route beside each of the eleven causes, and each of the three other
//      routes beside no reason - so every member of the closed vocabulary survives the line as a
//      fact and not as a draw (`chipAgent/_inbox/gotcha-a-closed-union-non-vacuity-row-should-be-exhausted-not-sampled.md`).
//      The `formalMutationCounts` block decodes to itself in four states: `null` ("no gate ran"),
//      an all-zero tally ("a gate ran and calibrated nothing"), a tally with nothing scorable, and
//      a scored one. The first two are different facts and must stay different (Req 9.10). And a
//      `setup-failed` sample, which carries no formal run (Req 12.29), decodes to itself too, so a
//      decoder refusing the status outright is as visible as one that fails to refuse the run.
//   2. MALFORMED. For each of the SIX slots a closed vocabulary governs - `formal.verdict` and
//      `formal.cause` (Req 12.12), `formalFallbackReason` (the cause vocabulary's second slot),
//      `formalFallbackRoute` (Req 7.21), `formalClockPolarity`, and `propertySetAdmitted` - a line
//      carrying a GENERATED non-member in that one slot, every other field valid, is counted
//      malformed. No record comes back, so the decoder neither
//      defaulted the value nor dropped the field it sits in. Each case carries a POSITIVE CONTROL -
//      the same record with its own member there decodes - so the refusal is the value's doing and
//      not the skeleton's, and the generated value is read back off the line first, so the encoder
//      did not drop it before the decoder was asked. A slot is tried only on records where no
//      cross-field rule would refuse the tampered record FOR ITS OWN REASON (`VocabularySlot.carries`),
//      because a decoder that read a non-member leniently would otherwise be refused by Req 12.31
//      or 12.32 and the vocabulary check would never be shown to be the one that works.
//   3. CROSS-FIELD. Each refusal of Requirements 12.29 through 12.33 is its own row of a table
//      (`CROSS_FIELD_ROWS`), run over generated records. A row pairs a VIOLATING record with
//      CONTROLS the product can write, and it asserts three things: every control decodes to itself,
//      the violating LINE differs from its first control in EXACTLY the fields the rule names (so
//      the refusal is that rule's doing and no other field's), and the violating line is counted
//      malformed. Every closed part of a rule is its own row rather than a draw: each of the
//      three routes other than `cause` beside a reason, each of the three outcomes other than
//      `refused` beside a survivor, and both verdicts other than `could-not-verify` beside a
//      cause - and each half of an iff is its own row, since a decoder enforcing one half passes
//      every row of the other.
//   4. MISSING KEY (Req 12.34). For each of the NINE formal keys, a line with that key deleted is
//      counted malformed, where the same record with the key present - as an explicit `null` on the
//      four keys that read absent as a meaningful `null` - decodes.
//   5. NEWER SCHEMA (Req 12.28). A well-formed record at a higher version is counted stale and NOT
//      malformed, and the narrowness that keeps noise from refusing a file holds: a non-integer
//      version stays malformed.
//
// THE RECORDS ARE BUILT THE WAY `recordFor` BUILDS THEM
//   `recordFor` in `app/eval/sweep/runner.ts` is private, so its field mapping is mirrored rather
//   than called: `formal` is `recordedFormalRun` over the deciding result, the flat formal fields
//   are read off one generated `FormalProvenance` (`arbFormalProvenance()`, which composes
//   `arbResetContractOrAbsent()` and `arbClockPolarityOrAbsent()`), and the admission outcome and
//   survivor count are the eval-side pair the harness writes. Every field is drawn independently,
//   the full cross a decoder reading field by field must survive, EXCEPT where the decoder itself
//   refuses a pairing - and a record the round trip is claimed over must be one the product can
//   write, or the round trip counts this file's own fixtures malformed
//   (`chipAgent/_inbox/gotcha-a-cross-field-decoder-rule-costs-exactly-the-fixtures-that-state-an-unproducible-record.md`).
//   Four couplings follow, each named at `sampleRecordArbitrary`: the Fallback_Reason and the
//   Fallback_Route are ONE drawn reading (Req 7.19), a `setup-failed` sample carries no formal run
//   (Req 12.29), a survivor count sits beside `refused` only (Req 12.32), and a mutant tally
//   satisfies its partition and its denominator (Req 12.33). `arbFormalProvenance()` draws the
//   reason and the route independently, by design, so that a property asserting their iff can draw
//   a violator; its two fields are ignored here and the pairing is re-established from the
//   fourteen readings. `arbPropertyResult()` is widened in two stated ways, at
//   `decidingResultArbitrary`: its cause is redrawn over all eleven causes, and an assertion
//   count no worker report can carry is filtered out as unreachable.
//
// THE NON-MEMBERS ARE CLASSES, NOT A LIST
//   A list of literal strings covers the spellings a reader imagined, and every one of them is a
//   string, so it cannot fail a decoder that keeps its type check and loses its vocabulary check
//   (`chipAgent/_inbox/gotcha-a-closed-string-vocabulary-is-not-closed-at-runtime-because-a-record-index-coerces-its-key.md`).
//   So six CLASSES are generated, each named for the lenient read it defeats, and the closed table
//   of six slots by six classes is EXHAUSTED by a loop, each cell its own property, so every class
//   meets every slot as a fact rather than as a draw. `results-log.test.ts` keeps its one literal
//   non-member per slot; this file quantifies over the classes.
//
// RUN COUNTS
//   The round trip is sized to its rarest required row; see `ROUND_TRIP_NUM_RUNS` for the measured
//   shares. Each malformed cell and each cross-field row runs the shared 100: a cell has no
//   required row inside it, because every value its class yields is an instance of the claim, and
//   a row's `applies` filter is one fast-check refuses to run a property past if it never matches.
//
// FALSIFIED, out of tree, with no shared file edited
//   This file was run unedited with `@app/eval` redirected to a scratch shim taking
//   `parseResultsLog` and `encodeSampleRecord` from a scratch copy of the BUILT `results-log.js`
//   (`chipAgent/_inbox/verification-recipe-falsify-a-test-against-a-one-line-mutant-of-the-built-dist-without-touching-shared-source.md`).
//   The unmutated copy passed all 33 tests, and each of 25 one-line mutants failed at least one:
//     - Req 12.29 removed; and over-broadened to refuse every `setup-failed` record (which fails
//       28 tests, the round trip among them, because the `setup-failed` records are generated);
//     - Req 12.30 with either half removed (a cause beside a `proved` or `refuted` verdict, and a
//       `could-not-verify` verdict with no cause);
//     - Req 12.31 reduced to either half alone, which fails only the rows of the other half;
//     - Req 12.32 removed, and reduced to the `admitted` outcome alone;
//     - Req 12.33's denominator rule removed, and reduced to either direction alone;
//     - the partition rule removed, and reduced to one direction;
//     - Req 12.34's presence sweep removed, and then again with each of the four keys that read
//       absent as a meaningful `null` dropped from it ALONE, which fails exactly that key's test;
//     - Req 12.28 reduced to older versions only;
//     - a route, an admission outcome, and a Fallback_Reason each decoded leniently (a non-member
//       read as a member or as `null`), which fail only the one slot's non-member test;
//     - a route COLLAPSED onto another on read (`no-property-expressed` read as `not-applicable`),
//       which fails the round trip and the exhaustive route loop;
//     - the excluded count dropped to zero on read, and an all-zero tally read as `null`.
//   The over-broad 12.29 mutant is what the generated `setup-failed` records are for, and each
//   half-rule mutant is why every closed part of a rule is its own row.
//
// NOT CLAIMED HERE
//   - Refusing a version-12-or-lower record is Property 29 (task 12.8).
//   - The inner shape of a Formal_Mutation_Counts block - an absent, negative, or fractional count
//     - is `results-log.test.ts`'s. This file holds the block's two ARITHMETIC refusals, the
//     partition and the denominator, because those are the cross-field rules Req 12.33 names.
//   - That a route agrees with the admission outcome (`property-set-refused` only beside
//     `refused`) is NOT a decoder rule, so the records here draw the two independently; a record
//     pairing them any other way is one the Verification_Loop will not write, but the decoder is
//     claimed only over what it is specified to refuse.
//   - `recordedFormalRun` builds `formal` here from ONE deciding result, so the roll-up precedence
//     it applies across a set (Req 7.17) is neither exercised nor claimed; `results-log.test.ts`
//     pins it.
//   - The elapsed time is round-tripped as generated and never pinned to what the formal adapter
//     reports, which under-reports it today (Req 7.11).
//
// The tag string is a literal, not `propertyTag(...)`, whose `FEATURE_TAG` is hardcoded to a
// different spec's property numbering
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// **Validates: Requirements 7.9, 7.21, 9.9, 9.10, 10.8, 12.11, 12.12, 12.28, 12.29, 12.30, 12.31,
// 12.32, 12.33, 12.34**

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
  MAX_MUTANTS_PER_PROBLEM_LIMIT,
  parseResultsLog,
  recordedFormalRun,
  RESULTS_SCHEMA_VERSION,
  type FormalMutationCounts,
  type ParsedResultsLog,
  type RecordedFormalRun,
  type SweepSampleRecord,
} from '@app/eval';
import {
  CLOCK_POLARITIES,
  COULD_NOT_VERIFY_CAUSES,
  FORMAL_VERDICTS,
  type CouldNotVerifyCause,
  type CoverCondition,
  type FormalVerdict,
  type ProofConditions,
  type PropertyResult,
  type ResetContract,
} from '@app/tools';

import { arbFormalProvenance, arbPropertyResult } from './formal-arbitraries.js';
import { propertyParameters } from './property.js';

// **Feature: formal-property-oracle, Property 26: The record round-trips every new field and
// rejects every non-member value**
const PROPERTY =
  'formal-property-oracle, Property 26: The record round-trips every new field and rejects every non-member value';

/**
 * Sized to the rarest required row. Measured over 20,000 draws of `sampleRecordArbitrary()` at
 * seeds 1 and 42 (task 19.6, re-measured because it added the `setup-failed` records and the
 * fourteen readings), the rarest is a `proved` deciding run, at 2.95% / 2.87%: `arbPropertyResult()`
 * admits a proof only where all five generated conditions admit, a fifth of records carry no run,
 * and a fifth more are `setup-failed`, which carry none. Next are the eleven causes on a
 * `could-not-verify` run, each between 3.38% and 3.88%; then the eleven Fallback_Reasons and the
 * three reasonless routes, each between 6.63% and 7.75%; then `count:zero` at 15.0%; and every
 * other row, the `setup-failed` status and the mutant tallies among them, is at least 15.4%.
 * So at 1000 runs the `proved` row is missed with probability about 0.9713^1000 ~ 2e-13, and the
 * eleven cause rows together about 11 x 0.9662^1000 ~ 1e-14. Each row is asserted as present, not
 * as a share, so the arithmetic is `(1 - p)^n` rather than a binomial tail.
 */
const ROUND_TRIP_NUM_RUNS = 1_000;

/** The verdict that carries a cause. `satisfies`, so a rename breaks here. */
const COULD_NOT_VERIFY = 'could-not-verify' satisfies FormalVerdict;

/** The verdict that carries `ProvedEvidence` in place of `conditions`. */
const PROVED = 'proved' satisfies FormalVerdict;

/** The one admission outcome that carries surviving mutants (`propertySetSurvivorCountOf`). */
const REFUSED = 'refused' satisfies PropertySetAdmissionOutcome;

/** How much likelier a submitted Formal_Property is than none: none is a fifth of records. */
const SUBMITTED_WEIGHT = 4;

/** The only Fallback_Route beside which a Fallback_Reason sits (Req 7.19, 12.31). */
const CAUSE_ROUTE = 'cause' satisfies FallbackRoute;

/** The sample status whose record carries no formal run (Req 12.29). */
const SETUP_FAILED = 'setup-failed' satisfies SweepSampleRecord['outcomeStatus'];

/** The status every other record here carries. */
const VERIFIED = 'verified' satisfies SweepSampleRecord['outcomeStatus'];

/** How much likelier a record is `verified` than `setup-failed`: a fifth of records failed setup. */
const VERIFIED_WEIGHT = 4;

/** The Fallback_Routes that sit beside NO Fallback_Reason. */
const REASONLESS_ROUTES = FALLBACK_ROUTES.filter((route) => route !== CAUSE_ROUTE);

/**
 * The v13 formal fields Property 26 GENERATES rather than fixes: ALL NINE formal keys of a record.
 *
 * It is also the list the missing-key rule (Req 12.34) is tried over, so a tenth formal field
 * added to `SweepSampleRecord` is a compile error in `BASE_RECORD` below - the key would be
 * neither generated nor deleted here - rather than a key whose absence nothing exercises.
 */
type FormalField =
  | 'formal'
  | 'formalFallbackReason'
  | 'formalFallbackRoute'
  | 'formalResetContract'
  | 'formalAssertionGateEmitted'
  | 'formalClockPolarity'
  | 'propertySetAdmitted'
  | 'propertySetAuthoredUpFront'
  | 'propertySetSurvivorCount'
  | 'formalMutationCounts';

/** Every field Property 26 does NOT read, at values the decoder accepts and returns unchanged. */
const BASE_RECORD: Omit<SweepSampleRecord, FormalField> = {
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
  configHash: 'cfg-property-26',
  armName: 'arm-a',
  modelSignature: 'zai.glm-5',
  problemId: 'rtllm/arithmetic/adder_8bit',
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
  durationMs: 1_000,
  completedAtMs: 1_000,
  failureNote: null,
  noVerdictCause: null,
};

/**
 * What the product writes for a sample that failed in setup, laid over `BASE_RECORD`.
 *
 * The same shape `formal-summary-aggregation.property.test.ts` draws as its `deferred` kind: no
 * candidate, so no iteration, no golden verdict, no mutation probe, an `unchecked` instrument that
 * names the missing testbench, and an infrastructure cause. A `setup-failed` record stating
 * anything else would be a fixture no writer produces, which is the trap Req 12.29 is a rule about.
 */
const SETUP_FAILED_SHAPE: Partial<SweepSampleRecord> = {
  passed: false,
  outcomeStatus: SETUP_FAILED,
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
};

// ---------------------------------------------------------------------------
// The generated records
// ---------------------------------------------------------------------------

/**
 * Whether a result's assertion count is one a worker report can carry.
 *
 * The report schema holds `assertionCount` to a non-negative integer (`report.ts`), so the shared
 * generator's `-1`, `0.5`, `NaN`, and `Infinity` - there to exercise the gate's own guard - can
 * never reach a record. A record carrying one is refused, correctly, as unreadable; it is filtered
 * out here because it is unreachable, not because the decoder is wrong about it.
 */
function carriesAReportableCount(result: PropertyResult): boolean {
  const count =
    result.verdict === PROVED ? result.evidence.assertionCount : result.conditions.assertionCount;
  return Number.isInteger(count) && count >= 0;
}

/**
 * The ONE result a record is rolled up from, or `null` where no Formal_Property was submitted.
 *
 * One result rather than a set: a record carries only the deciding result's facts, so every
 * `RecordedFormalRun` a set can roll up to is also the roll-up of that one result alone.
 *
 * THE CAUSE IS REDRAWN over the whole of `COULD_NOT_VERIFY_CAUSES`. `arbPropertyResult()` takes its
 * `could-not-verify` cause from `admitProved`, whose range is FIVE of the eleven. The other six -
 * `frontend-rejected`, `property-build-failed`, `induction-engine-incomplete`,
 * `reset-contract-unresolved`, `clock-contract-unsupported`, and `proof-timeout` - are reported by
 * the interpreter and the pre-pass rather than by the gate, and every one of them reaches a record.
 */
function decidingResultArbitrary(): fc.Arbitrary<PropertyResult | null> {
  const submitted = fc
    .tuple(arbPropertyResult(), fc.constantFrom(...COULD_NOT_VERIFY_CAUSES))
    .map(([result, cause]): PropertyResult =>
      result.verdict === COULD_NOT_VERIFY ? { ...result, cause } : result,
    )
    .filter(carriesAReportableCount);
  return fc.oneof(
    { weight: SUBMITTED_WEIGHT, arbitrary: submitted },
    { weight: 1, arbitrary: fc.constant<PropertyResult | null>(null) },
  );
}

/**
 * The admission outcome and its survivor count, paired the way the harness pairs them.
 *
 * `recordedPropertySetAdmission` in `app/eval/harness.ts` writes a count only on a refusal, from
 * the refusal's own survivors, and zero for the other three outcomes. A refusal names at least one
 * survivor (Req 10.2, 10.6), and no Property_Set can be survived by more mutants than the
 * reference design has, which `MAX_MUTANTS_PER_PROBLEM_LIMIT` bounds.
 */
function admissionArbitrary(): fc.Arbitrary<
  Pick<
    SweepSampleRecord,
    'propertySetAdmitted' | 'propertySetAuthoredUpFront' | 'propertySetSurvivorCount'
  >
> {
  return fc
    .tuple(
      fc.constantFrom(...PROPERTY_SET_ADMISSION_OUTCOMES),
      fc.integer({ min: 1, max: MAX_MUTANTS_PER_PROBLEM_LIMIT }),
      // Generated independently of the outcome, which is the point of the field: a gate that
      // found no reference design records `not-gated` AFTER the set was authored, so every
      // outcome pairs with either answer.
      fc.boolean(),
    )
    .map(([outcome, survivors, authoredUpFront]) => ({
      propertySetAdmitted: outcome,
      propertySetAuthoredUpFront: authoredUpFront,
      propertySetSurvivorCount: outcome === REFUSED ? survivors : 0,
    }));
}

/** A Fallback_Reason and the Fallback_Route beside it, paired the way Req 7.19 allows. */
interface FallbackReading {
  readonly reason: CouldNotVerifyCause | null;
  readonly route: FallbackRoute;
}

/**
 * EVERY pairing Req 7.19 allows: the `cause` route beside each Could_Not_Verify_Cause, and each
 * other route beside no reason - 11 + 3 = 14 readings, spread from both vocabularies' owners, so a
 * member added to either is a reading here at once rather than a value silently never written.
 */
const EVERY_FALLBACK_READING: readonly FallbackReading[] = FALLBACK_ROUTES.flatMap(
  (route): readonly FallbackReading[] =>
    route === CAUSE_ROUTE
      ? COULD_NOT_VERIFY_CAUSES.map((reason) => ({ reason, route }))
      : [{ reason: null, route }],
);

/** One tally from its three parts; the other two counts are the sums Req 12.33 fixes. */
function tallyOf(killed: number, survived: number, excluded: number): FormalMutationCounts {
  return {
    totalCount: killed + survived + excluded,
    denominator: killed + survived,
    killedCount: killed,
    survivedCount: survived,
    couldNotVerifyCount: excluded,
  };
}

/**
 * A gate that ran and calibrated NO mutant: a MEASURED tally of nothing, which is a different fact
 * from `null` ("no gate ran", Req 9.10) and must stay one through the line.
 */
const NOTHING_CALIBRATED = tallyOf(0, 0, 0);

/**
 * A scored tally: `total` mutants calibrated, `scored` of them in the denominator, `killed` of
 * those killed. The total is bounded by the most mutants a sweep may ask of one problem, which no
 * Property_Set_Admission can calibrate more of.
 */
function scoredTallyArbitrary(): fc.Arbitrary<FormalMutationCounts> {
  return fc
    .integer({ min: 0, max: MAX_MUTANTS_PER_PROBLEM_LIMIT })
    .chain((total) =>
      fc
        .integer({ min: 0, max: total })
        .chain((scored) =>
          fc
            .integer({ min: 0, max: scored })
            .map((killed) => tallyOf(killed, scored - killed, total - scored)),
        ),
    );
}

/**
 * The four states a sample's Formal_Mutation_Counts can be in, each a quarter-ish share by
 * construction: `null`, an all-zero tally, a tally with mutants calibrated and NONE scorable (a
 * zero denominator beside a non-zero excluded count), and a scored one at half the weight.
 */
function mutationCountsArbitrary(): fc.Arbitrary<FormalMutationCounts | null> {
  return fc.oneof(
    { weight: 1, arbitrary: fc.constant<FormalMutationCounts | null>(null) },
    { weight: 1, arbitrary: fc.constant<FormalMutationCounts | null>(NOTHING_CALIBRATED) },
    {
      weight: 1,
      arbitrary: fc
        .integer({ min: 1, max: MAX_MUTANTS_PER_PROBLEM_LIMIT })
        .map((excluded) => tallyOf(0, 0, excluded)),
    },
    { weight: 3, arbitrary: scoredTallyArbitrary() },
  );
}

/** The status a record carries: `verified`, or `setup-failed` at a fifth of the weight. */
function statusArbitrary(): fc.Arbitrary<typeof VERIFIED | typeof SETUP_FAILED> {
  return fc.oneof(
    { weight: VERIFIED_WEIGHT, arbitrary: fc.constant(VERIFIED) },
    { weight: 1, arbitrary: fc.constant(SETUP_FAILED) },
  );
}

/**
 * One sample record, its nine formal fields mapped the way `recordFor` maps them.
 *
 * THE RECORD IS ONE THE PRODUCT CAN WRITE, wherever the decoder would refuse one it cannot:
 *
 *   - THE ROUTE AND THE REASON ARE ONE DRAWN READING (Req 7.19, 12.31). `formalProvenanceOf` in
 *     the Verification_Loop satisfies the iff BY CONSTRUCTION off a discriminated `TakenRoute`.
 *     `arbFormalProvenance()` draws the two independently so that a property asserting the iff can
 *     draw a violating record; a record the ROUND TRIP is claimed over must not be one, so the
 *     pairing is re-established here from `readings`, and the provenance's own two fields are
 *     ignored.
 *   - A `setup-failed` RECORD CARRIES NO FORMAL RUN (Req 12.29): `VerificationLoop#verify` returns
 *     that outcome out of `#setup`, before a candidate exists, so `recordedFormalRun` has nothing
 *     to roll up. The other formal fields stay the full independent cross, because no rule couples
 *     them to the status.
 *   - A SURVIVOR COUNT SITS BESIDE `refused` ONLY (Req 12.32), which `admissionArbitrary` holds.
 *   - A TALLY SATISFIES THE PARTITION AND THE DENOMINATOR (Req 12.33), which `tallyOf` holds by
 *     construction.
 *
 * `readings` defaults to all fourteen; the exhaustive route loop passes one at a time.
 */
function sampleRecordArbitrary(
  readings: readonly FallbackReading[] = EVERY_FALLBACK_READING,
): fc.Arbitrary<SweepSampleRecord> {
  return fc
    .tuple(
      arbFormalProvenance(),
      decidingResultArbitrary(),
      admissionArbitrary(),
      mutationCountsArbitrary(),
      fc.constantFrom(...readings),
      statusArbitrary(),
    )
    .map(([provenance, deciding, admission, counts, reading, status]): SweepSampleRecord => {
      const failedInSetup = status === SETUP_FAILED;
      return {
        ...BASE_RECORD,
        ...(failedInSetup ? SETUP_FAILED_SHAPE : {}),
        formal: failedInSetup
          ? null
          : recordedFormalRun({ ...provenance, results: deciding === null ? [] : [deciding] }),
        formalFallbackReason: reading.reason,
        formalFallbackRoute: reading.route,
        formalResetContract: provenance.resetContract,
        formalAssertionGateEmitted: provenance.assertionGateEmitted,
        formalClockPolarity: provenance.clockPolarity,
        formalMutationCounts: counts,
        ...admission,
      };
    });
}

// ---------------------------------------------------------------------------
// The rows the round trip must exercise
// ---------------------------------------------------------------------------

/**
 * Every member of a string-literal union, read off a TOTAL record of it.
 *
 * For the unions no module exports an enumerable list of: a member added to the union is a missing
 * key here, which is a compile error rather than a row this file silently never requires.
 */
function membersOf<Member extends string>(
  total: Readonly<Record<Member, true>>,
): readonly Member[] {
  return Object.keys(total) as Member[];
}

/** The kind a derived Reset_Contract carries. */
type ResetKind = Extract<ResetContract, { readonly derived: true }>['resetKind'];

const RESET_KINDS = membersOf<ResetKind>({ async: true, sync: true });
const PRESAT_VALUES = membersOf<ProofConditions['presat']>({
  satisfiable: true,
  preunsat: true,
  'not-run': true,
});
const BASE_VALUES = membersOf<ProofConditions['base']>({
  passed: true,
  failed: true,
  'not-run': true,
});
const INDUCTION_VALUES = membersOf<ProofConditions['induction']>({
  successful: true,
  inconclusive: true,
  'not-run': true,
});

/** All three Cover_Check readings, one of each shape. */
const EVERY_COVER: readonly CoverCondition[] = [
  { reached: true, step: 0 },
  { reached: false },
  { reached: 'not-applicable' },
];

/** The row one Cover_Check reading exercises. */
function coverRowOf(cover: CoverCondition): string {
  if (cover.reached === 'not-applicable') {
    return 'cover:not-applicable';
  }
  return cover.reached ? 'cover:reached' : 'cover:unreached';
}

/** The rows a deciding run exercises: its verdict, any cause it carries, its five conditions. */
function formalRunRowsOf(run: RecordedFormalRun): readonly string[] {
  const { conditions } = run;
  return [
    `verdict:${run.verdict}`,
    ...(run.cause === null ? [] : [`cause:${run.cause}`]),
    conditions.assertionCount === 0 ? 'count:zero' : 'count:positive',
    `presat:${conditions.presat}`,
    coverRowOf(conditions.cover),
    `base:${conditions.base}`,
    `induction:${conditions.induction}`,
  ];
}

/** The rows a Reset_Contract reading exercises: never read, refused, or each derived fact. */
function resetRowsOf(contract: ResetContract | null): readonly string[] {
  if (contract === null) {
    return ['reset:never-read'];
  }
  if (!contract.derived) {
    return ['reset:refused'];
  }
  return [
    `reset-kind:${contract.resetKind}`,
    contract.resetActiveLow ? 'reset-polarity:active-low' : 'reset-polarity:active-high',
    contract.initialStateFree ? 'initial-state:free' : 'initial-state:pinned',
  ];
}

/**
 * The rows a Formal_Mutation_Counts reading exercises: never gated, a gate that calibrated
 * nothing, mutants calibrated with none scorable, or a scored tally and which of its three parts
 * are non-zero (so a codec dropping or swapping a count is visible, not only one dropping a block).
 */
function countsRowsOf(counts: FormalMutationCounts | null): readonly string[] {
  if (counts === null) {
    return ['counts:no-gate-ran'];
  }
  if (counts.totalCount === 0) {
    return ['counts:all-zero'];
  }
  if (counts.denominator === 0) {
    return ['counts:nothing-scorable'];
  }
  return [
    'counts:scored',
    ...(counts.killedCount > 0 ? ['counts:killed'] : []),
    ...(counts.survivedCount > 0 ? ['counts:survived'] : []),
    ...(counts.couldNotVerifyCount > 0 ? ['counts:excluded'] : []),
  ];
}

/** Every row one record exercises, read off the fields the round trip is claimed over. */
function roundTripRowsOf(record: SweepSampleRecord): readonly string[] {
  return [
    `status:${record.outcomeStatus}`,
    ...(record.formal === null ? ['formal:none-submitted'] : formalRunRowsOf(record.formal)),
    `fallback:${record.formalFallbackReason ?? 'none'}`,
    `route:${record.formalFallbackRoute}`,
    ...countsRowsOf(record.formalMutationCounts),
    ...resetRowsOf(record.formalResetContract),
    record.formalAssertionGateEmitted ? 'gate:emitted' : 'gate:not-emitted',
    `clock:${record.formalClockPolarity ?? 'never-read'}`,
    `admission:${record.propertySetAdmitted}`,
    // A count no boolean could carry, so a decoder flattening the count to a flag is visible.
    ...(record.propertySetSurvivorCount > 1 ? ['survivors:several'] : []),
  ];
}

/**
 * Every row the round trip must exercise, each vocabulary spread from its owner, so a member
 * added there is a row required here at once rather than a value silently never generated.
 */
const REQUIRED_ROUND_TRIP_ROWS: readonly string[] = [
  `status:${VERIFIED}`,
  `status:${SETUP_FAILED}`,
  ...FALLBACK_ROUTES.map((route) => `route:${route}`),
  'counts:no-gate-ran',
  'counts:all-zero',
  'counts:nothing-scorable',
  'counts:scored',
  'counts:killed',
  'counts:survived',
  'counts:excluded',
  'formal:none-submitted',
  ...FORMAL_VERDICTS.map((verdict) => `verdict:${verdict}`),
  ...COULD_NOT_VERIFY_CAUSES.map((cause) => `cause:${cause}`),
  'count:zero',
  'count:positive',
  ...PRESAT_VALUES.map((presat) => `presat:${presat}`),
  ...EVERY_COVER.map(coverRowOf),
  ...BASE_VALUES.map((base) => `base:${base}`),
  ...INDUCTION_VALUES.map((induction) => `induction:${induction}`),
  'fallback:none',
  ...COULD_NOT_VERIFY_CAUSES.map((cause) => `fallback:${cause}`),
  'reset:never-read',
  'reset:refused',
  ...RESET_KINDS.map((kind) => `reset-kind:${kind}`),
  'reset-polarity:active-low',
  'reset-polarity:active-high',
  'initial-state:free',
  'initial-state:pinned',
  'gate:emitted',
  'gate:not-emitted',
  'clock:never-read',
  ...CLOCK_POLARITIES.map((polarity) => `clock:${polarity}`),
  ...PROPERTY_SET_ADMISSION_OUTCOMES.map((outcome) => `admission:${outcome}`),
  'survivors:several',
];

// ---------------------------------------------------------------------------
// The non-members
// ---------------------------------------------------------------------------

/** One slot a closed vocabulary governs, and what the decoder must accept there. */
interface VocabularySlot {
  /** Where the slot sits on the line, as a dotted key path. */
  readonly label: string;
  /** The closed vocabulary, spread from its owner. */
  readonly vocabulary: readonly string[];
  /** Whether `null` is itself a READING of the slot ("never reached", "did not fall back"). */
  readonly nullIsReading: boolean;
  /**
   * Whether `record` is one this slot is tried on: it carries a member there that decodes (the
   * positive control needs that), AND no cross-field rule would refuse a tampered copy for its own
   * reason. The second condition is what keeps a refusal attributable to the vocabulary check: a
   * decoder reading a non-member route as `null`, say, would be refused by Req 12.31 on a record
   * holding a reason anyway, and the slot would pass without its own check ever being the one that
   * worked.
   */
  readonly carries: (record: SweepSampleRecord) => boolean;
}

/**
 * The six slots. The cause sits on a `could-not-verify` run only, because a cause on any other
 * verdict is refused whatever its value, and that refusal would not be about the vocabulary.
 *
 * Three slots sit beside a cross-field rule, and each is tried only on records where that rule has
 * nothing to say about a lenient read of the slot. A reason and a route are an iff (Req 12.31), so
 * the reason slot is tried off the `cause` route, where a reason read as `null` is still a legal
 * pairing, and the route slot on records with no reason, where a route read as anything but
 * `cause` is. A survivor count sits beside `refused` only (Req 12.32), so the admission slot is
 * tried on records with no survivors.
 */
const VOCABULARY_SLOTS: readonly VocabularySlot[] = [
  {
    label: 'formal.verdict',
    vocabulary: FORMAL_VERDICTS,
    nullIsReading: false,
    carries: (record) => record.formal !== null,
  },
  {
    label: 'formal.cause',
    vocabulary: COULD_NOT_VERIFY_CAUSES,
    nullIsReading: false,
    carries: (record) => record.formal?.verdict === COULD_NOT_VERIFY,
  },
  {
    label: 'formalFallbackReason',
    vocabulary: COULD_NOT_VERIFY_CAUSES,
    nullIsReading: true,
    carries: (record) => record.formalFallbackRoute !== CAUSE_ROUTE,
  },
  {
    label: 'formalFallbackRoute',
    vocabulary: FALLBACK_ROUTES,
    nullIsReading: false,
    carries: (record) => record.formalFallbackReason === null,
  },
  {
    label: 'formalClockPolarity',
    vocabulary: CLOCK_POLARITIES,
    nullIsReading: true,
    carries: () => true,
  },
  {
    label: 'propertySetAdmitted',
    vocabulary: PROPERTY_SET_ADMISSION_OUTCOMES,
    nullIsReading: false,
    carries: (record) => record.propertySetSurvivorCount === 0,
  },
];

/** The classes of non-member, each named for the lenient read it defeats. */
const NON_MEMBER_CLASSES = [
  'near-miss',
  'foreign',
  'blank',
  'container',
  'scalar',
  'fuzz',
] as const;
type NonMemberClass = (typeof NON_MEMBER_CLASSES)[number];

/** Edits that turn a member into a near miss; one landing on another member is filtered out. */
const NEAR_MISS_EDITS: readonly ((member: string) => string)[] = [
  // A case-insensitive read.
  (member) => member.toUpperCase(),
  // A trimming read, on either side.
  (member) => ` ${member}`,
  (member) => `${member}\n`,
  // A prefix read.
  (member) => `${member}s`,
  // A substring read.
  (member) => member.slice(1),
  // Two findings in one field, which a split-on-separator read takes the first of.
  (member) => `${member}|${member}`,
];

/**
 * Values a writer copying ANOTHER vocabulary through would emit: every member of the five
 * vocabularies named here, the `Status:` words the tool prints, the base check's own `passed`,
 * and the raw `CLK_POLARITY` values a worker passing the parameter through unread would write.
 * Each slot draws the ones outside its own vocabulary.
 */
const FOREIGN_TOKENS: readonly string[] = [
  ...FORMAL_VERDICTS,
  ...COULD_NOT_VERIFY_CAUSES,
  ...CLOCK_POLARITIES,
  ...PROPERTY_SET_ADMISSION_OUTCOMES,
  ...FALLBACK_ROUTES,
  'PASSED',
  'FAILED',
  'passed',
  '1',
  '0',
];

/**
 * A member inside a JSON container. A `Record` lookup stringifies its key, so `['posedge']` and
 * `[['posedge']]` read as `'posedge'` wherever a total map is all that stands between the value
 * and a member; the decoder's string check is what refuses them.
 */
const CONTAINER_WRAPS: readonly ((member: string) => unknown)[] = [
  (member) => [member],
  (member) => [[member]],
  (member) => [member, member],
  (member) => ({ value: member }),
];

/**
 * JSON scalars that are not strings. `NaN` and `Infinity` are absent because `JSON.stringify`
 * writes them as `null`, which would put a different value on the line than the one generated.
 */
const NON_STRING_SCALARS: readonly unknown[] = [0, 1, -1, 2.5, true, false];

/** Longest fuzz string; the classes above carry the shapes, this one carries the surprise. */
const FUZZ_MAX_LENGTH = 24;

/** The values each class yields for one slot, before its readings are filtered out. */
const NON_MEMBER_VALUES: Readonly<
  Record<NonMemberClass, (slot: VocabularySlot) => fc.Arbitrary<unknown>>
> = {
  'near-miss': (slot) =>
    fc
      .tuple(fc.constantFrom(...slot.vocabulary), fc.constantFrom(...NEAR_MISS_EDITS))
      .map(([member, edit]) => edit(member)),
  foreign: (slot) =>
    fc.constantFrom(...FOREIGN_TOKENS.filter((token) => !slot.vocabulary.includes(token))),
  blank: () => fc.constantFrom('', ' ', '\t\n'),
  container: (slot) =>
    fc
      .tuple(fc.constantFrom(...slot.vocabulary), fc.constantFrom(...CONTAINER_WRAPS))
      .map(([member, wrap]) => wrap(member)),
  scalar: (slot) =>
    fc.constantFrom<unknown>(...NON_STRING_SCALARS, ...(slot.nullIsReading ? [] : [null])),
  fuzz: () => fc.string({ maxLength: FUZZ_MAX_LENGTH }),
};

/** Whether `value` is a READING of the slot - a member, or `null` where null is one. */
function isReadingOf(slot: VocabularySlot, value: unknown): boolean {
  return (
    (typeof value === 'string' && slot.vocabulary.includes(value)) ||
    (value === null && slot.nullIsReading)
  );
}

// ---------------------------------------------------------------------------
// The codec under test, and the assertions over it
// ---------------------------------------------------------------------------

/**
 * The results log's line codec: the real encoder and the real line reader, never a hand serializer.
 *
 * A PARAMETER of the assertions rather than a call inside them, so a deliberately wrong codec can
 * be handed to the very same clauses to show they fail, without editing `results-log.ts`, which a
 * killed tool call would leave mutated in the build every concurrent agent reads
 * (`chipAgent/_inbox/gotcha-a-scratch-script-exit-trap-does-not-run-when-the-agent-tool-kills-the-shell.md`).
 */
interface LineCodec {
  readonly encode: (record: SweepSampleRecord) => string;
  readonly read: (text: string) => ParsedResultsLog;
}

const RESULTS_LOG_CODEC: LineCodec = { encode: encodeSampleRecord, read: parseResultsLog };

/** What reading exactly one malformed line reports. */
const MALFORMED_LINE: ParsedResultsLog = { records: [], malformedLines: 1, staleSchemaLines: 0 };

/**
 * A deep copy whose every object sits on `Object.prototype`.
 *
 * `fc.record` builds NULL-PROTOTYPE objects and the generated conditions reach the record through
 * one, so `toStrictEqual` against the decoder's plain objects would fail with "no visual
 * difference"
 * (`chipAgent/_inbox/gotcha-fc-record-builds-null-prototype-objects-so-tostrictequal-fails-with-no-visual-difference.md`).
 * The copy changes no value; it normalizes the expectation, never the codec.
 */
function plainCopy(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(plainCopy);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, plainCopy(entry)]));
  }
  return value;
}

/** `target` with `value` placed at `path` and every other field kept. Never mutates. */
function withValueAt(target: unknown, path: readonly string[], value: unknown): unknown {
  const [head, ...rest] = path;
  if (head === undefined) {
    return value;
  }
  const fields = target as Readonly<Record<string, unknown>>;
  return { ...fields, [head]: withValueAt(fields[head], rest, value) };
}

/** The record survives the codec exactly: one record back, strictly equal, nothing else counted. */
function expectRoundTrip(codec: LineCodec, record: SweepSampleRecord): void {
  expect(codec.read(codec.encode(record))).toStrictEqual({
    records: [plainCopy(record)],
    malformedLines: 0,
    staleSchemaLines: 0,
  });
}

/** Run the round trip over `records` through `codec`, and return every row the run exercised. */
function roundTripRowsExercised(
  codec: LineCodec,
  records: fc.Arbitrary<SweepSampleRecord>,
): ReadonlySet<string> {
  const exercised = new Set<string>();
  fc.assert(
    fc.property(records, (record) => {
      for (const row of roundTripRowsOf(record)) {
        exercised.add(row);
      }
      expectRoundTrip(codec, record);
    }),
    propertyParameters({ numRuns: ROUND_TRIP_NUM_RUNS }),
  );
  return exercised;
}

/**
 * The line carrying `value` in `slot` of `record` is counted malformed, and nothing comes back.
 *
 * The tampered record leaves the type on purpose: it is the line a hand edit or a foreign writer
 * produces, and the real encoder is the only serializer the log has, so the line is byte for byte
 * the real encoding with one value changed.
 */
function expectReportedMalformed(
  codec: LineCodec,
  slot: VocabularySlot,
  record: SweepSampleRecord,
  value: unknown,
): void {
  // POSITIVE CONTROL: the untampered line decodes, so the refusal below is the value's doing.
  expect(codec.read(codec.encode(record)).records).toHaveLength(1);
  const path = slot.label.split('.');
  const line = codec.encode(withValueAt(record, path, value) as SweepSampleRecord);
  // The value is ON the line, so a refusal is the decoder's and not an encoder that dropped it.
  const persisted: unknown = JSON.parse(line);
  expect(persisted).toHaveProperty(path, value);
  expect(codec.read(line)).toStrictEqual(MALFORMED_LINE);
}

/** Every non-member of one class, in one slot of every record that carries it, is malformed. */
function expectNonMembersMalformed(
  codec: LineCodec,
  slot: VocabularySlot,
  kind: NonMemberClass,
): void {
  const nonMembers = NON_MEMBER_VALUES[kind](slot).filter((value) => !isReadingOf(slot, value));
  fc.assert(
    fc.property(sampleRecordArbitrary().filter(slot.carries), nonMembers, (record, value) => {
      expectReportedMalformed(codec, slot, record, value);
    }),
    propertyParameters(),
  );
}

// ---------------------------------------------------------------------------
// The cross-field rules (Req 12.29 - 12.33), the missing-key rule (Req 12.34), the newer schema
// ---------------------------------------------------------------------------

/** Everything a cross-field row builds its records from, drawn once per case. */
interface CellDraw {
  readonly record: SweepSampleRecord;
  /** A cause for a row that needs one to put beside a verdict or a route. */
  readonly cause: CouldNotVerifyCause;
  /** A scored tally, for the rows that break the arithmetic of one. */
  readonly tally: FormalMutationCounts;
  /** A surviving-mutant count a refusal may carry: at least one. */
  readonly survivors: number;
}

/**
 * One violating record and the records the product CAN write that it is a one-rule edit of.
 *
 * Every violating record here is type-correct: no cross-field rule is expressible in the flat
 * `SweepSampleRecord`, which is exactly why the decoder, and not the compiler, has to refuse it.
 */
interface CrossFieldCase {
  /** Records that each decode. The violating record is an edit of the FIRST. */
  readonly controls: readonly [SweepSampleRecord, ...SweepSampleRecord[]];
  readonly violating: SweepSampleRecord;
}

/** One refusal of Requirements 12.29 through 12.33, or one half of one. */
interface CrossFieldRow {
  readonly label: string;
  /** The top-level keys the violating LINE differs from its first control's in, and no others. */
  readonly touches: readonly (keyof SweepSampleRecord)[];
  /** Whether a draw is one this row can be built from; a row no draw fits fails the run. */
  readonly applies: (draw: CellDraw) => boolean;
  readonly build: (draw: CellDraw) => CrossFieldCase;
}

/** The outcomes that carry no survivor (`propertySetSurvivorCountOf` writes zero for them). */
const SURVIVORLESS_OUTCOMES = PROPERTY_SET_ADMISSION_OUTCOMES.filter(
  (outcome) => outcome !== REFUSED,
);

/** The verdicts that carry no cause (Req 1.5, 12.30). */
const CAUSELESS_VERDICTS = FORMAL_VERDICTS.filter((verdict) => verdict !== COULD_NOT_VERIFY);

/** The deciding run of a record a row's `applies` has already shown carries one. */
function runOf(record: SweepSampleRecord): RecordedFormalRun {
  if (record.formal === null) {
    throw new Error('a row built for a record carrying a formal run was handed one without');
  }
  return record.formal;
}

/** `record` as a sample that failed in setup: the shape the product writes, with no formal run. */
function failedInSetup(record: SweepSampleRecord): SweepSampleRecord {
  return { ...record, ...SETUP_FAILED_SHAPE, formal: null };
}

/** The ways to break a tally's arithmetic, each an edit of ONE count and the draws it fits. */
const TALLY_BREAKS: readonly {
  readonly label: string;
  readonly applies: (tally: FormalMutationCounts) => boolean;
  readonly edit: (tally: FormalMutationCounts) => FormalMutationCounts;
}[] = [
  {
    label: 'Req 12.33: a denominator above killed + survived',
    applies: () => true,
    edit: (tally) => ({ ...tally, denominator: tally.denominator + 1 }),
  },
  {
    label: 'Req 12.33: a denominator below killed + survived',
    applies: (tally) => tally.denominator > 0,
    edit: (tally) => ({ ...tally, denominator: tally.denominator - 1 }),
  },
  {
    label: 'the partition: a total above killed + survived + excluded',
    applies: () => true,
    edit: (tally) => ({ ...tally, totalCount: tally.totalCount + 1 }),
  },
  {
    label: 'the partition: a total below killed + survived + excluded',
    applies: (tally) => tally.totalCount > 0,
    edit: (tally) => ({ ...tally, totalCount: tally.totalCount - 1 }),
  },
];

/**
 * Every refusal, each closed part its own row. Both halves of an iff are rows, since a decoder
 * enforcing only one half passes every row of the other.
 */
const CROSS_FIELD_ROWS: readonly CrossFieldRow[] = [
  {
    label: 'Req 12.29: a setup-failed record carrying a formal run',
    touches: ['formal'],
    applies: ({ record }) => record.formal !== null,
    // The second control is the SAME run on a sample that did not fail in setup, so it is the
    // status beside the run that is refused and not the run.
    build: ({ record }) => {
      const noRun = failedInSetup(record);
      return { controls: [noRun, record], violating: { ...noRun, formal: record.formal } };
    },
  },
  ...CAUSELESS_VERDICTS.map((verdict): CrossFieldRow => ({
    label: `Req 12.30: a cause beside the ${verdict} verdict`,
    touches: ['formal'],
    applies: ({ record }) => record.formal?.verdict === verdict,
    build: ({ record, cause }) => ({
      controls: [record],
      violating: { ...record, formal: { ...runOf(record), cause } },
    }),
  })),
  {
    label: 'Req 12.30: a could-not-verify verdict with no cause',
    touches: ['formal'],
    applies: ({ record }) => record.formal?.verdict === COULD_NOT_VERIFY,
    build: ({ record }) => ({
      controls: [record],
      violating: { ...record, formal: { ...runOf(record), cause: null } },
    }),
  },
  ...REASONLESS_ROUTES.map((route): CrossFieldRow => ({
    label: `Req 12.31: a Fallback_Reason beside the ${route} route`,
    touches: ['formalFallbackReason'],
    applies: () => true,
    // The second control is the SAME reason on the `cause` route, so it is the route beside
    // the reason that is refused and not the reason.
    build: ({ record, cause }) => {
      const reasonless: SweepSampleRecord = {
        ...record,
        formalFallbackReason: null,
        formalFallbackRoute: route,
      };
      const caused: SweepSampleRecord = {
        ...reasonless,
        formalFallbackReason: cause,
        formalFallbackRoute: CAUSE_ROUTE,
      };
      return {
        controls: [reasonless, caused],
        violating: { ...reasonless, formalFallbackReason: cause },
      };
    },
  })),
  {
    label: 'Req 12.31: the cause route with no Fallback_Reason',
    touches: ['formalFallbackReason'],
    applies: () => true,
    build: ({ record, cause }) => {
      const caused: SweepSampleRecord = {
        ...record,
        formalFallbackReason: cause,
        formalFallbackRoute: CAUSE_ROUTE,
      };
      // The second control is the reasonless pairing, so it is the route beside the missing reason
      // that is refused and not the missing reason.
      const reasonless: SweepSampleRecord = {
        ...record,
        formalFallbackReason: null,
        formalFallbackRoute: 'not-applicable',
      };
      return {
        controls: [caused, reasonless],
        violating: { ...caused, formalFallbackReason: null },
      };
    },
  },
  ...SURVIVORLESS_OUTCOMES.map((outcome): CrossFieldRow => ({
    label: `Req 12.32: surviving mutants beside the ${outcome} outcome`,
    touches: ['propertySetAdmitted'],
    applies: () => true,
    // The second control is the SAME outcome with ZERO survivors, so it is the count beside
    // the outcome that is refused and not the outcome.
    build: ({ record, survivors }) => {
      const refused: SweepSampleRecord = {
        ...record,
        propertySetAdmitted: REFUSED,
        propertySetAuthoredUpFront: false,
        propertySetSurvivorCount: survivors,
      };
      const none: SweepSampleRecord = {
        ...refused,
        propertySetAdmitted: outcome,
        propertySetAuthoredUpFront: false,
        propertySetSurvivorCount: 0,
      };
      return {
        controls: [refused, none],
        violating: { ...refused, propertySetAdmitted: outcome },
      };
    },
  })),
  ...TALLY_BREAKS.map(({ label, applies, edit }): CrossFieldRow => ({
    label,
    touches: ['formalMutationCounts'],
    applies: ({ tally }) => applies(tally),
    build: ({ record, tally }) => ({
      controls: [{ ...record, formalMutationCounts: tally }],
      violating: { ...record, formalMutationCounts: edit(tally) },
    }),
  })),
];

/** A draw for the cross-field rows: a record, and the spare parts a row edits it with. */
function cellDrawArbitrary(): fc.Arbitrary<CellDraw> {
  return fc.record({
    record: sampleRecordArbitrary(),
    cause: fc.constantFrom(...COULD_NOT_VERIFY_CAUSES),
    tally: scoredTallyArbitrary(),
    survivors: fc.integer({ min: 1, max: MAX_MUTANTS_PER_PROBLEM_LIMIT }),
  });
}

/** One encoded line read back as its top-level fields. */
function persistedFields(line: string): Readonly<Record<string, unknown>> {
  return JSON.parse(line) as Readonly<Record<string, unknown>>;
}

/** The top-level keys whose values differ between two encoded lines, sorted. */
function differingKeys(left: string, right: string): readonly string[] {
  const before = persistedFields(left);
  const after = persistedFields(right);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .sort();
}

/** The line with one top-level key deleted, every other field kept. */
function withoutKey(line: string, key: string): string {
  const fields = Object.entries(persistedFields(line)).filter(([name]) => name !== key);
  return JSON.stringify(Object.fromEntries(fields));
}

/**
 * One cross-field row over one draw: every control decodes, the violating line differs from its
 * first control in `row.touches` and nowhere else, and that line is counted malformed.
 *
 * The middle clause is what makes the refusal the RULE's: a violating record also differing in
 * some other field could be refused for that field, and the row would pass without the rule.
 */
function expectRowRefused(codec: LineCodec, row: CrossFieldRow, draw: CellDraw): void {
  const { controls, violating } = row.build(draw);
  for (const control of controls) {
    expectRoundTrip(codec, control);
  }
  const line = codec.encode(violating);
  expect(differingKeys(codec.encode(controls[0]), line)).toEqual([...row.touches].sort());
  expect(codec.read(line)).toStrictEqual(MALFORMED_LINE);
}

/** The nine formal keys, read off a TOTAL record of `FormalField` so a tenth is a compile error. */
const FORMAL_KEYS = membersOf<FormalField>({
  formal: true,
  formalFallbackReason: true,
  formalFallbackRoute: true,
  formalResetContract: true,
  formalAssertionGateEmitted: true,
  formalClockPolarity: true,
  propertySetAdmitted: true,
  propertySetAuthoredUpFront: true,
  propertySetSurvivorCount: true,
  formalMutationCounts: true,
});

/**
 * `record` with every formal key that may be `null` holding an explicit `null`.
 *
 * Four keys - `formal`, `formalFallbackReason`, `formalResetContract`, `formalClockPolarity` - read
 * an ABSENT value as a meaningful `null` on their own ("nothing submitted", "did not fall back",
 * "pre-pass never reached"), so the only thing separating a record from the one with the key
 * deleted is the presence of the key. The counts key reads `null` as "no gate ran". The route is
 * the statement `'not-applicable'`, which the reason being `null` requires it to be.
 */
function withExplicitNulls(record: SweepSampleRecord): SweepSampleRecord {
  return {
    ...record,
    formal: null,
    formalFallbackReason: null,
    formalFallbackRoute: 'not-applicable',
    formalResetContract: null,
    formalClockPolarity: null,
    formalMutationCounts: null,
  };
}

/** Pairings per reading in the exhaustive route loop: the route, not the rest, is what varies. */
const READING_NUM_RUNS = 20;

describe(PROPERTY, () => {
  it('given any record, when its line is read back, then every formal field survives', () => {
    const exercised = roundTripRowsExercised(RESULTS_LOG_CODEC, sampleRecordArbitrary());

    expect(REQUIRED_ROUND_TRIP_ROWS.filter((row) => !exercised.has(row))).toEqual([]);
  });

  it('given each Fallback_Route beside every reason it may carry, when read back, then the pair survives', () => {
    // The table is complete, so the loop below cannot quietly skip a route or a cause.
    expect(new Set(EVERY_FALLBACK_READING.map(({ route }) => route))).toEqual(
      new Set(FALLBACK_ROUTES),
    );
    expect(
      EVERY_FALLBACK_READING.flatMap(({ reason }) => (reason === null ? [] : [reason])),
    ).toEqual([...COULD_NOT_VERIFY_CAUSES]);
    for (const reading of EVERY_FALLBACK_READING) {
      fc.assert(
        fc.property(sampleRecordArbitrary([reading]), (record) => {
          // The generator honoured the reading, so this is 14 cases and not one drawn 14 times.
          expect({
            reason: record.formalFallbackReason,
            route: record.formalFallbackRoute,
          }).toEqual(reading);
          expectRoundTrip(RESULTS_LOG_CODEC, record);
        }),
        propertyParameters({ numRuns: READING_NUM_RUNS }),
      );
    }
  });

  it.each(CROSS_FIELD_ROWS)(
    'given a line violating $label, when it is read, then it is counted malformed',
    (row) => {
      fc.assert(
        fc.property(cellDrawArbitrary().filter(row.applies), (draw) => {
          expectRowRefused(RESULTS_LOG_CODEC, row, draw);
        }),
        propertyParameters(),
      );
    },
  );

  it.each(FORMAL_KEYS)(
    'given a line missing the key %s, when it is read, then it is counted malformed (Req 12.34)',
    (key) => {
      fc.assert(
        fc.property(sampleRecordArbitrary(), (generated) => {
          const record = withExplicitNulls(generated);
          // POSITIVE CONTROL: with the key present - `null` where that is a reading - it decodes.
          expectRoundTrip(RESULTS_LOG_CODEC, record);
          const line = RESULTS_LOG_CODEC.encode(record);
          expect(Object.hasOwn(persistedFields(line), key)).toBe(true);
          expect(RESULTS_LOG_CODEC.read(withoutKey(line, key))).toStrictEqual(MALFORMED_LINE);
        }),
        propertyParameters(),
      );
    },
  );

  it('given a well-formed record from a NEWER schema, when it is read, then it is stale and not corrupt (Req 12.28)', () => {
    fc.assert(
      fc.property(sampleRecordArbitrary(), (record) => {
        // POSITIVE CONTROL: at the current version it decodes.
        expectRoundTrip(RESULTS_LOG_CODEC, record);
        const atVersion = (version: number): string =>
          RESULTS_LOG_CODEC.encode(
            withValueAt(record, ['schemaVersion'], version) as SweepSampleRecord,
          );
        expect(RESULTS_LOG_CODEC.read(atVersion(RESULTS_SCHEMA_VERSION + 1))).toStrictEqual({
          records: [],
          malformedLines: 0,
          staleSchemaLines: 1,
        });
        // The refusal stays narrow: a version that is not an integer is noise, not a newer build.
        expect(RESULTS_LOG_CODEC.read(atVersion(RESULTS_SCHEMA_VERSION + 0.5))).toStrictEqual(
          MALFORMED_LINE,
        );
      }),
      propertyParameters(),
    );
  });

  it.each(VOCABULARY_SLOTS)(
    'given a line carrying a non-member $label, when it is read, then it is counted malformed',
    (slot) => {
      for (const kind of NON_MEMBER_CLASSES) {
        expectNonMembersMalformed(RESULTS_LOG_CODEC, slot, kind);
      }
    },
  );
});
