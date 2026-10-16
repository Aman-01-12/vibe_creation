// The per-arm summary: what the bake-off actually measured.
//
// COMPUTED FROM THE RESULTS FILE, NOT FROM MEMORY
//   Every number here is derived from persisted `SweepSampleRecord`s. That is what makes
//   the summary runnable standalone over an old results file - a re-summarize costs
//   nothing and re-runs nothing - and it means the report and the durable evidence can
//   never disagree, because they are the same data.
//
// THE ESTIMATORS ARE THE HARNESS'S OWN
//   `passAtK`, `meanPassAtK`, and `summarizeAgreement` are imported, not reimplemented.
//   A second pass@k implementation would be a second thing to get wrong, and the two
//   could drift silently in the direction nobody checks.
//
// THE EFFICIENCY FIGURE IS DENOMINATED IN WHAT WE ACTUALLY MEASURE
//   Tokens are measured: the endpoint returns `usage.prompt_tokens` /
//   `usage.completion_tokens`, validated at the reply boundary. Wall clock is measured.
//   DOLLARS ARE NOT - no endpoint returns money, so cents only exist once an external rate
//   card is configured. So the primary figures are TOKENS PER VERIFIED ARTIFACT and
//   WALL CLOCK PER VERIFIED ARTIFACT, which every campaign has, and the dollar
//   cost-per-verified-artifact is an optional restatement of the same consumption.
//
//   Both per-artifact rates are computed over the SAME set of samples pass@k is computed
//   over - the pass@k-eligible ones - so an arm cannot improve its rate by producing
//   samples pass@k refuses to count. See `armEfficiency`.
//
// UNKNOWN DOLLARS ARE PRINTED AS UNKNOWN, AND ONLY THE DOLLARS
//   The transport reports 0 cents for a model with no configured price. Zero is a
//   number; unknown is not. Summing them yields a total that looks measured and is
//   wrong-low, and dividing it by the verified count yields a cost per verified artifact
//   that looks like a bargain. So an arm with even one unpriced model reports UNKNOWN
//   dollars and NO dollar cost-per-verified-artifact at all - the field is structurally
//   absent, not zero, so no consumer can accidentally read it as free. The rendered
//   message says explicitly that only the DOLLAR figure is missing, because `UNKNOWN` on
//   its own was read as "no cost was measured at all".
//
// A SILENT PROVIDER IS NOT A FREE ONE
//   A model call whose reply carried no usable `usage` block contributes nothing to the
//   token totals, because zero tokens is a measurement and silence is not. Those calls are
//   COUNTED (`unreportedUsageCalls`) and the summary labels the totals a FLOOR, so a host
//   that stopped metering cannot win a bake-off on efficiency.
//
// THE CELL THAT MATTERS MOST
//   `loopPassGoldenFail` - our agent's testbench passed a design that the benchmark's
//   independent golden testbench failed. Every one of those is a real bug our generated
//   testbench did not catch, and it is the only falsifiable measure of testbench quality
//   we have. It is printed on its own line, never buried in an agreement percentage.
//
// THE DENOMINATOR IS GATED ON THE INSTRUMENT CONTROLS
//   pass@k here counts a sample only if the loop reached an oracle verdict AND the controls
//   proved that sample's own testbench valid - the single invariant in
//   `../instrument-control.ts`. An instrument-invalid sample is reported on its own line
//   instead, because it measures OUR testbench generator and counting it as a model failure
//   would attribute our defect to the model. When the control was never exercised the
//   denominator has nothing in it, and this summary says NOT VALIDATED rather than printing
//   a zero that would read as a total failure.
//
// THE MOST ACTIONABLE LINE IN THE WHOLE SUMMARY, AND THE ONE THAT GATES
//   `COVERAGE GAPS`. Each entry is a mutation operator whose injected defect the INDEPENDENT
//   golden testbench catches and ours does not, tallied across the arm. It is both a work item
//   and the gate: a sample with even one such survivor is instrument-invalid, because a third
//   party has demonstrated the bug is catchable. Across a campaign it is the clearest statement
//   available of what the Testbench_Agent systematically forgets to check.
//
//   The KILL RATE beside it does NOT gate. It is a quality signal over every mutant that
//   compiles - the widest honest denominator - and precisely because it is that wide it contains
//   mutants no testbench can kill, so a bar on it would fail good instruments. The block labels
//   which number is which, in the lines themselves, so the two are never cited interchangeably.
//
//   `review-equiv` is the quieter sibling: mutants NEITHER testbench killed. Those may be
//   equivalent to the original, so they are neither presented as defects nor held against
//   validity - but they are not hidden either, because simulation cannot decide equivalence and
//   they still count against the kill rate.
//
//   The golden-judge agreement numbers are scoped the same way: an `over-strict` sample
//   whose instrument is invalid is not a disagreement worth chasing, so it is counted under
//   the instrument block rather than blended into `over-strict`.
//
// A SUMMARY OF AN INCOMPLETE MATRIX MUST NOT READ AS A COMPLETE ONE
//   A record whose `noVerdictCause` is INFRASTRUCTURE describes a slot that was ATTEMPTED and
//   never measured (see `../no-verdict-cause.ts`). Those slots are not results: they are
//   already outside every number here, because they carry no oracle verdict and the pass@k
//   denominator excludes them. The danger is the opposite of a wrong number - it is a right
//   number presented as if it covered the whole matrix. Measured on
//   `.eval-runs/instrument-calibration`: one rate-limit burst emptied two thirds of the cells
//   and the run reported itself `completed`.
//
//   So the deferred count is announced FIRST, above the title's own totals and above every
//   arm, in the loudest wording the file supports; the arm's `samples:` line restates the
//   split so a reader who skips the banner still cannot read the count as measured; and the
//   causes are tallied from the TYPED field, never from a failure note. Nothing is deducted
//   from an existing population to make room for it - a deferred slot was still dispatched
//   and may still have cost tokens - so no previously cited number moves.
//
// A FORMAL PROOF IS REPORTED AS EXACTLY WHAT IT IS, AND NOTHING MORE
//   The formal block counts what the Formal_Oracle decided, per arm, from the record's own
//   typed fields: the deciding Formal_Verdict and its Could_Not_Verify_Cause, the
//   Fallback_Reason that sent a sample to the Simulation_Fallback, and the Property_Set
//   admission outcome. The three verdicts plus `none-submitted` partition the arm, so all four
//   always print; a cause row prints only when it holds a sample, so the causes that fired are
//   never buried under a wall of zeros. The Fallback_Route rows follow that same rule over their
//   own closed four-member vocabulary, read from `@app/agent` rather than restated here, so a
//   fifth route is a compile error instead of a row this file silently never prints.
//
//   The block ends with the FORMAL mutant tally: killed, survived, EXCLUDED, and the calibrated
//   total, summed over the samples carrying one, with the kill rate taken over the formal gate's
//   OWN denominator. The excluded count is the one that used to exist nowhere a reader could
//   reach it. Both no-rate cases - no sample carrying a tally, and a tally whose denominator is
//   zero - render NOT MEASURED and never `0`, because a `0` is a claim about a gate that ran and
//   killed nothing, which is the distinction `killRateOf` already draws on the simulation side.
//
//   A fixed caveat sits directly under the verdicts, because `proved` is the number most easily
//   read as more than it is: a proof of a STATED property is not a proof of correctness
//   (ADR-019), and the correlated-failure risk of one model writing both the design and its
//   properties is layer 3's work (ADR-018), which no number in this block measures.
//
// Pure: no clock, no I/O, no randomness.

import { FALLBACK_ROUTES, type FallbackRoute, type RepairDeclineReason } from '@app/agent';
import {
  COULD_NOT_VERIFY_CAUSES,
  FORMAL_VERDICTS,
  type CouldNotVerifyCause,
  type FormalVerdict,
} from '@app/tools';

import {
  countsInGoldenPassAtK,
  summarizeAgreement,
  summarizeGoldenPassAtK,
  type AgreementReport,
  type GoldenPassAtKEligibility,
  type GoldenPassAtKReport,
  type RecordedGoldenVerdict,
  type VerdictPair,
} from '../golden-judge.js';
import {
  countsInPassAtK,
  describeInstrumentVerdict,
  instrumentControlMeasured,
  reachedOracleVerdict,
  summarizeInstrumentControl,
  uncheckedInstrument,
  type InstrumentControlReport,
  type InstrumentSample,
  type InstrumentUncheckedReason,
} from '../instrument-control.js';
import {
  mutationControlMeasured,
  summarizeMutationControl,
  type MutationControlReport,
  type MutationSample,
  type SurvivedOperatorCount,
} from '../mutation-control.js';
import { meanPassAtK, passAtK } from '../metrics.js';
import { formalKillRateOf, type FormalMutationCounts } from '../property-set-admission.js';
import {
  describeNoVerdictCause,
  isDeferredSample,
  NO_VERDICT_CAUSES,
  type NoVerdictCause,
} from '../no-verdict-cause.js';
import type { SampleOutcomeStatus } from '../report.js';
import {
  instrumentVerdictOf,
  STALE_SCHEMA_ADVICE,
  type ResultsLogHealth,
  type SweepSampleRecord,
} from './results-log.js';

/** The summary filename inside a run's output directory. */
export const SUMMARY_FILENAME = 'summary.txt';

/** How many decimal places a reported rate is rendered with. */
const RATE_DIGITS = 3;

/** How many decimal places a reported cent amount is rendered with. */
const CENT_DIGITS = 2;

/**
 * Whether a record's outcome carries an oracle verdict at all.
 *
 * Read from `../instrument-control.ts` rather than restated here, because the same
 * definition decides the pass@k denominator and a second copy could drift from it.
 */
function hasOracleVerdict(record: SweepSampleRecord): boolean {
  return reachedOracleVerdict(record.outcomeStatus);
}

/**
 * An arm's cost IN DOLLARS, or the honest statement that it is unknown.
 *
 * The SECONDARY cost figure, and the only one that can be unknown: no endpoint returns
 * money, so cents are a token count multiplied by an external rate card the config may or
 * may not supply. The primary, always-measured figures live in `ArmEfficiency`.
 *
 * The `known: false` arm carries NO cost fields at all, so a consumer cannot read a
 * zero that was never measured.
 */
export type ArmCost =
  | { readonly known: false }
  | {
      readonly known: true;
      readonly totalCents: number;
      readonly meanCentsPerSample: number;
      /**
       * Cost per Verified Artifact in cents, or null when this arm verified nothing.
       *
       * Computed over EVERY recorded sample and the ungated verified count, which is a
       * DIFFERENT population from `ArmEfficiency`'s per-artifact rates. Left as it was
       * deliberately: this number has already been cited, and silently re-basing it would
       * make two reports disagree with no visible reason. The rendered line names its
       * population so the two are never confused.
       */
      readonly costPerVerifiedCents: number | null;
    };

/** Measured consumption summed over some set of samples, and how many there were. */
export interface ArmTokenTotals {
  readonly samples: number;
  /** Prompt tokens the providers reported; a FLOOR when `unreportedUsageCalls` > 0. */
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** The providers' own totals, summed - not `promptTokens + completionTokens`. */
  readonly totalTokens: number;
  /** Model calls that reported no usable usage; the looseness of the floors above. */
  readonly unreportedUsageCalls: number;
  /** Wall clock the samples took end to end, from `SweepSampleRecord.durationMs`. */
  readonly wallClockMs: number;
}

/**
 * An arm's MEASURED efficiency: tokens and wall clock per verified artifact.
 *
 * The primary answer to "which arm is cheapest", and it needs no price table, because
 * both numerators are things the world actually reports back - `usage.prompt_tokens` /
 * `usage.completion_tokens` from the endpoint, and the clock from the runner. `ArmCost`
 * above is the optional dollar restatement of the same consumption.
 *
 * TWO POPULATIONS, BOTH NAMED, because the ratio and the bill are different questions:
 *   - `recorded` is every sample in the file for this arm. It is what the arm actually
 *     consumed, including samples that were paid for and then excluded from pass@k.
 *   - `population` is the pass@k-eligible samples ONLY, and it is the one the rates are
 *     taken over, so a rate cannot be moved by a sample that is not in pass@k either.
 */
export interface ArmEfficiency {
  readonly recorded: ArmTokenTotals;
  readonly population: ArmTokenTotals;
  /**
   * Verified samples WITHIN `population` - the divisor of both rates below.
   *
   * The same count pass@k uses as its numerator, so the efficiency figure and the quality
   * figure are statements about one identical set of samples. Deliberately distinct from
   * `ArmSummary.verifiedSamples`, which is the ungated tally over every recorded sample.
   */
  readonly verifiedArtifacts: number;
  /** `population.totalTokens / verifiedArtifacts`, or null when nothing was verified. */
  readonly tokensPerVerified: number | null;
  /** `population.wallClockMs / verifiedArtifacts`, or null when nothing was verified. */
  readonly msPerVerified: number | null;
}

/** One sanitized failure note and how many no-verdict samples carried it. */
export interface NoVerdictNoteCount {
  readonly note: string;
  readonly count: number;
}

/** One TYPED no-verdict cause and how many deferred slots carried it. */
export interface DeferredCauseCount {
  readonly cause: NoVerdictCause;
  readonly count: number;
}

/** One `unchecked`-instrument reason and how many samples carried it. */
export interface UncheckedReasonCount {
  readonly reason: InstrumentUncheckedReason;
  readonly count: number;
}

/** One Repair_Decline_Reason and how many declined Testbench_Repair attempts carried it. */
export interface RepairDeclineReasonCount {
  readonly reason: RepairDeclineReason;
  readonly count: number;
}

/**
 * One Could_Not_Verify_Cause and how many samples carried it.
 *
 * Serves the Fallback_Reason breakdown as well, because a Fallback_Reason IS the
 * Could_Not_Verify_Cause that sent its sample to the Simulation_Fallback.
 */
export interface CouldNotVerifyCauseCount {
  readonly cause: CouldNotVerifyCause;
  readonly count: number;
}

/** One Fallback_Route member and how many samples took it (Req 7.22). */
export interface FallbackRouteCount {
  readonly route: FallbackRoute;
  readonly count: number;
}

/**
 * The `InstrumentUncheckedReason` members, in a fixed tie-break order.
 *
 * `../instrument-control.js` exports the type but no enumerable array of its members
 * (unlike `NO_VERDICT_CAUSES` in `../no-verdict-cause.js`), so this list is kept here as a
 * local const, following the exact precedent already set by `results-log.ts`'s own
 * `INSTRUMENT_UNCHECKED_REASONS`. Iterating this rather than the observed values means the
 * tie-break order is fixed and a summary is byte-identical no matter which order concurrent
 * samples finished in - the same discipline `deferredCauses` applies to `NO_VERDICT_CAUSES`.
 */
const INSTRUMENT_UNCHECKED_REASONS: readonly InstrumentUncheckedReason[] = [
  'control-absent',
  'no-testbench',
  'no-reference',
  'testbench-unsubmittable',
  'control-unavailable',
  'no-mutants-generated',
  'no-valid-mutants',
  'no-golden-killed-mutants',
  'mutation-probe-unavailable',
  'control-resource-exhausted',
];

/**
 * The `RepairDeclineReason` members, in a fixed tie-break order.
 *
 * `@app/agent` exports `RepairDeclineReason` as a type but no enumerable array of its
 * members, so this list is kept here as a local const, following the exact precedent
 * `./results-log.ts`'s own `REPAIR_DECLINE_REASONS` already set for the identical reason.
 * Iterating this rather than the observed values keeps the rendered breakdown
 * byte-identical no matter which order concurrent samples finished in, matching
 * `INSTRUMENT_UNCHECKED_REASONS` immediately above.
 */
const REPAIR_DECLINE_REASONS: readonly RepairDeclineReason[] = [
  'no-admissible-revision',
  'coverage-validation-failed',
  'recheck-failed',
  'port-threw',
  'port-unavailable',
];

/**
 * What the FORMAL oracle established across one arm, read off the persisted records alone.
 *
 * THE VERDICT BUCKETS PARTITION THE ARM. Every record lands in exactly one of the three
 * Formal_Verdict buckets or in `noneSubmittedSamples`, so the four sum to
 * `ArmSummary.sampleCount` by construction - the discipline the golden exclusion tally keeps -
 * and the formal population can never be mistaken for the whole arm.
 *
 * EVERY COUNT IS READ FROM ONE RECORD FIELD, never re-derived from a different one. The verdict
 * and its cause are the record's rolled-up `formal` run, the Fallback_Reason is
 * `formalFallbackReason`, the ROUTE is `formalFallbackRoute`, and a refusal is
 * `propertySetAdmitted`. The record keeps those apart for a reason the counts must not erase: a
 * Property_Set source that THREW falls back on `toolchain-unavailable` with no property
 * submitted, and a REFUSED Property_Set reaches the loop empty and falls back under the
 * Fallback_Route `property-set-refused` with no Fallback_Reason, because no
 * Could_Not_Verify_Cause caused it (Req 10.3) - which is precisely why the route is its own
 * closed vocabulary and `routeCounts` is tallied separately from `fallbackReasonCounts`.
 *
 * THE MUTANT COUNTS ARE SUMMED, NEVER RE-DERIVED, and `null` where no sample carried a tally:
 * no gate ran, so there is nothing to report, which is a different claim from an all-zero tally
 * (Req 9.12). The formal kill rate comes from `formalKillRateOf` over the SUMMED denominator and
 * is `null` where that denominator is zero (Req 9.11).
 */
export interface ArmFormalReport {
  /** Samples under each Formal_Verdict; all three members, always, even at zero (Req 12.17). */
  readonly verdictCounts: Readonly<Record<FormalVerdict, number>>;
  /** Samples whose record carries no formal run, because no Formal_Property was submitted. */
  readonly noneSubmittedSamples: number;
  /**
   * The `could-not-verify` samples by Could_Not_Verify_Cause, most frequent first (Req 12.17).
   *
   * Only a cause holding at least one sample has an entry, so the causes that fired are not
   * buried under zeros; the entries sum to exactly `verdictCounts['could-not-verify']`.
   */
  readonly causeCounts: readonly CouldNotVerifyCauseCount[];
  /** Samples decided from the Simulation_Fallback: those carrying a Fallback_Reason (Req 7.10). */
  readonly fallbackSamples: number;
  /** Those samples by Fallback_Reason, most frequent first, zero entries dropped; sums to them. */
  readonly fallbackReasonCounts: readonly CouldNotVerifyCauseCount[];
  /**
   * Samples whose candidate design the formal frontend rejected (Req 8.7).
   *
   * The `frontend-rejected` entry of `causeCounts`, kept as its own count because that entry is
   * dropped at zero and this one is the named quarantine, reported whether or not it fired.
   */
  readonly frontendRejectedSamples: number;
  /**
   * Samples whose Property_Set the admission gate refused as inadmissible (Req 10.9), or `null`
   * where NO sample in the arm was gated at all (Req 9.5).
   *
   * `null` is NOT MEASURED and a `0` is a gate that ran and refused nothing (Req 9.6): reporting
   * both as `0` would claim a clean gate for an arm no gate ran for - the same distinction
   * `mutationCounts` draws below.
   *
   * Over `'refused'` ALONE. `'no-gate-set'` is a gate that ran with nothing to hold the set to,
   * so tallying it here would report a refusal that never happened.
   */
  readonly propertySetRefusedSamples: number | null;
  /**
   * Samples under each Fallback_Route member HOLDING AT LEAST ONE, most frequent first (Req 7.22).
   *
   * A member with no sample yields no entry, so the routes that fired are not buried under four
   * rows of zeros - the rule `causeCounts` already follows. Every record carries exactly one
   * route (`formalFallbackRoute` is required and non-nullable), so these entries PARTITION the
   * arm and sum to `ArmSummary.sampleCount`, which is what makes a missing route visible rather
   * than merely absent.
   */
  readonly routeCounts: readonly FallbackRouteCount[];
  /**
   * The arm's Formal_Mutation_Counts, SUMMED over the samples carrying one (Req 9.4).
   *
   * `null` where NO sample in the arm carries a tally: no Property_Set_Admission ran, so the
   * excluded count is NOT MEASURED rather than zero (Req 9.12). An all-zero tally would read as
   * a gate that calibrated mutants and scored none of them, which is the opposite claim - the
   * same distinction `SweepSampleRecord.formalMutationCounts` draws one layer down.
   */
  readonly mutationCounts: FormalMutationCounts | null;
  /**
   * The FORMAL kill rate: `killedCount / denominator` over the summed counts, or `null`.
   *
   * Computed through `formalKillRateOf` rather than inline, so this file is not a second owner
   * of the rule that excludes an unscorable mutant from the denominator. `null` at a zero
   * denominator and at absent counts alike (Req 9.11, 9.12), rendered "not measured": a `0`
   * reads as a gate that killed nothing where no rate reads as nothing to rate.
   *
   * NOT comparable to `MutationControlReport.killRate`: the two gates exclude different mutants,
   * so the two denominators are different populations over the same mutant set (Req 9.6).
   */
  readonly mutationKillRate: number | null;
}

/** One arm's reportability figures, reported BESIDE Instrument_Valid and never inside it. */
export interface ArmReportabilityReport {
  /** Samples whose measured testbench held at least one Valueless_Failure_Report. */
  readonly withReport: number;
  /** Samples that HAD a measured testbench: a `null` count is not a denominator member. */
  readonly sources: number;
  /** `withReport / sources`, or `null` when no sample had a measured testbench (Req 8.11). */
  readonly valuelessReportRate: number | null;
}

/** One arm's aggregated result. */
export interface ArmSummary {
  readonly armName: string;
  /** The models that produced these numbers, as recorded on the samples themselves. */
  readonly modelSignature: string;
  /**
   * True when one arm name carries more than one model signature in the file.
   *
   * That means two different model configurations were recorded under one name, so the
   * arm's numbers blend two experiments and must not be cited. Surfaced, never merged
   * silently.
   */
  readonly signatureConflict: boolean;
  readonly sampleCount: number;
  readonly problemCount: number;
  /**
   * pass@k for each requested k, as the mean of the per-problem estimates.
   *
   * Computed over the DENOMINATOR-ELIGIBLE samples only (see `denominatorRecords`). Read
   * `passAtKValidated` before citing it: when that is `false` this is the uncontrolled
   * number and must be labeled NOT VALIDATED.
   */
  readonly passAtK: Readonly<Record<number, number>>;
  /**
   * Whether the positive control was exercised for this arm at all.
   *
   * `false` means no sample's instrument was checked, so `passAtK` above is the
   * verdict-bearing-only estimate with no instrument evidence behind it. It is reported
   * rather than zeroed, because a zero would read as a total model failure - but it is
   * labeled, because an unvalidated number must never be cited as a validated one.
   */
  readonly passAtKValidated: boolean;
  /**
   * GOLDEN pass@k for each requested k: the CAPABILITY number, decided by a judge we did
   * not write.
   *
   * Computed over the golden denominator (`goldenDenominatorRecords`) - the samples the
   * INDEPENDENT judge returned a behavioural verdict on - through the SAME `armPassAtK`
   * estimator and the SAME per-problem aggregation `passAtK` above uses, with the judge's
   * verdict as the numerator instead of our own oracle's. It sits BESIDE `passAtK`, never
   * instead of it: this answers "did the flow produce a correct design", `passAtK` answers
   * "may a `Verified` label be shown to a student". See `../golden-judge.ts` for why both
   * are needed and why neither substitutes for the other.
   */
  readonly goldenPassAtK: Readonly<Record<number, number>>;
  /**
   * How this arm's recorded samples split around its golden denominator.
   *
   * `goldenReport.judgedSamples` is the size of the denominator `goldenPassAtK` is taken
   * over, and it plus the five exclusion counts sums to `sampleCount` by construction - so
   * the capability number can never be cited without the count of what its denominator
   * leaves out, nor a shrunken denominator presented as a corpus-wide result.
   */
  readonly goldenReport: GoldenPassAtKReport;
  /**
   * What the POSITIVE CONTROL established about this arm's own testbenches.
   *
   * `instrument.invalidSamples` is the headline: samples whose testbench REJECTS the
   * benchmark's known-good reference design, and which therefore measured our testbench
   * generator rather than the model.
   */
  readonly instrument: InstrumentControlReport;
  /** Valueless_Failure_Report figures, reported beside `instrument` and never an input to it. */
  readonly reportability: ArmReportabilityReport;
  /**
   * What the NEGATIVE CONTROL established about this arm's own testbenches.
   *
   * `mutation.survivedOperators` is the headline for a campaign: across many samples, the
   * operators that survive most often are the defect classes our Testbench_Agent
   * systematically does not check for, which is the single most actionable output of the
   * whole sweep for improving it.
   */
  readonly mutation: MutationControlReport;
  /**
   * What the FORMAL oracle established for this arm: its verdicts, why it could not verify,
   * what fell back, what the frontend rejected, and what the admission gate refused.
   *
   * Read the caveat the rendered block prints under the verdicts before citing `proved`: a proof
   * of a STATED property is not a proof of correctness (Req 10.11, 10.12).
   */
  readonly formal: ArmFormalReport;
  readonly verifiedSamples: number;
  /** Passing samples whose FIRST candidate passed (iterations === 1). */
  readonly firstTrySamples: number;
  /** Passing samples that needed at least one repair iteration. */
  readonly repairedSamples: number;
  /** `firstTrySamples / sampleCount`. */
  readonly firstTryRate: number;
  /** `repairedSamples / sampleCount`. */
  readonly repairedRate: number;
  /**
   * Samples for which a Testbench_Repair was attempted - a DIFFERENT axis from
   * `repairedSamples` above.
   *
   * `repairedSamples` counts passing samples that needed a repair ITERATION of the
   * candidate design (the base hero-loop concept: same testbench, another try at the
   * RTL). This field counts samples whose TESTBENCH ITSELF was submitted for a
   * Testbench_Repair attempt, a distinct capability this spec adds. Read from
   * `SweepSampleRecord.repairAttempted`, so it is unaffected by whether the sample
   * ultimately passed.
   *
   * COUNTS EVERY DECLINED ATTEMPT TOO, not only accepted ones: `repairAttempted` persists
   * `true` for a decline at any stage (Req 1.7), the fix for the defect where a declined
   * control-path attempt used to persist as `attempted: false` and vanish from this count.
   * `testbenchRepairAttempted - testbenchRepairAccepted` is therefore exactly the declined
   * count, and `declinedByReason` below is that same count broken out by stage.
   */
  readonly testbenchRepairAttempted: number;
  /**
   * Of `testbenchRepairAttempted`, how many were accepted on re-check.
   *
   * Read from `SweepSampleRecord.repairAccepted`. ACCEPTANCE IS NOT INSTRUMENT VALIDITY: the
   * precheck path accepts on the repaired testbench passing its PRECHECK re-check, a build
   * check, so that sample goes on to `#iterate` and can still end `invalid`. Measured in
   * `.eval-runs/reportability-slice-v1`: 14 accepted, 0 of them instrument-valid.
   * `validAfterRepair` below is therefore a strictly smaller count, never this one.
   */
  readonly testbenchRepairAccepted: number;
  /**
   * Of `testbenchRepairAttempted`, the declined ones broken out by Repair_Decline_Reason,
   * most frequent first.
   *
   * Iterated over the closed five-member vocabulary rather than over the observed values,
   * matching `uncheckedReasonCounts` and `deferredCauses` on this same interface: a fixed
   * declaration order makes the rendered breakdown byte-identical regardless of completion
   * order under concurrency. Zero-count reasons are dropped, so an arm with no declines
   * gains no noise. Sums to exactly `testbenchRepairAttempted - testbenchRepairAccepted`.
   */
  readonly testbenchRepairDeclinedByReason: readonly RepairDeclineReasonCount[];
  /**
   * Of `instrument.validSamples`, how many needed no Testbench_Repair at all.
   *
   * `instrument.validSamples - validAfterRepair`. Subtracting `validAfterRepair` and not
   * `testbenchRepairAccepted` is what keeps this non-negative: an accepted repair need not
   * have ended `valid`, so the accepted count can exceed the headline total, which drove
   * this field to -10 on a measured run.
   */
  readonly validNoRepair: number;
  /**
   * Of `instrument.validSamples`, how many reached `valid` only after a Testbench_Repair.
   *
   * The INTERSECTION of accepted-on-re-check and instrument-valid, recounted from the
   * records rather than read off `testbenchRepairAccepted`, because acceptance does not
   * imply validity. A repair accepted that still ended `invalid` belongs to neither part of
   * this decomposition, which is of the valid total alone.
   */
  readonly validAfterRepair: number;
  /**
   * Samples carrying Council B's early-warning signal: a normalized-and-silently-emptied
   * testbench (Req 5.9, 5.11).
   *
   * Read from `SweepSampleRecord.checkNameVisibilitySignal`. Reported SEPARATELY from
   * `validNoRepair` and `validAfterRepair` rather than folded into either: a signalled
   * sample already reached `valid` (`checkNameVisibilitySignalOf` in `../harness.ts` can
   * only be `true` for a sample whose control passed), so it is already counted in exactly
   * one of those two buckets. Pooling a normalized-and-intact testbench with a
   * normalized-and-silently-emptied one there would hide the very defect this signal
   * exists to surface, which is why it gets its own count instead.
   */
  readonly checkNameVisibilitySignalSamples: number;
  /** Mean iterations over PASSING samples, or null when none passed. */
  readonly meanIterationsToPass: number | null;
  /**
   * The MEASURED efficiency figures: tokens and wall clock per verified artifact.
   *
   * Read this before `cost` below. It is always populated and never unknown, because its
   * inputs are reported by the endpoint and the clock rather than by a rate card.
   */
  readonly efficiency: ArmEfficiency;
  /** The optional DOLLAR restatement; `known: false` whenever any model was unpriced. */
  readonly cost: ArmCost;
  /**
   * How our own testbench and the independent judge compared - EXCLUDING samples whose
   * instrument is proven invalid.
   *
   * Scoped that way because a disagreement produced by a testbench that also rejects the
   * reference design is not a finding about the model or the judge; it is our own defect,
   * and it is counted under `instrument.invalidOverStrict` / `invalidMissedBug` instead.
   * Blending the two would send a reviewer chasing a model problem that does not exist.
   */
  readonly agreement: AgreementReport;
  /** How many samples ended in each outcome status, so failures are visible. */
  readonly statusCounts: Readonly<Partial<Record<SampleOutcomeStatus, number>>>;
  /**
   * Why the no-verdict samples produced no verdict: note to count, most frequent first.
   *
   * `statusCounts` says HOW MANY samples produced no verdict; this says WHY, which is the
   * difference between "setup-failed=300" and "setup-failed=300, all of them
   * generation-unavailable". Empty when no no-verdict sample carried a note.
   */
  readonly noVerdictNotes: readonly NoVerdictNoteCount[];
  /**
   * Why this arm's `unchecked`-instrument samples could not be spoken for: reason to count,
   * most frequent first.
   *
   * `instrument.uncheckedSamples` says HOW MANY; this says WHY, the same relationship
   * `noVerdictNotes` has to `statusCounts`. Empty exactly when `instrument.uncheckedSamples`
   * is 0.
   */
  readonly uncheckedReasonCounts: readonly UncheckedReasonCount[];
  /**
   * Slots this arm ATTEMPTED and never measured - the arm's matrix hole.
   *
   * Non-zero means this arm's numbers are computed over fewer cells than the campaign
   * planned, and the missing ones are an outage rather than a result. Counted from the TYPED
   * `noVerdictCause`, so it cannot be moved by rewording a note. A subset of `sampleCount`
   * deliberately: those records ARE in the file and were dispatched, so removing them from
   * the recorded population would understate what the arm consumed.
   */
  readonly deferredSamples: number;
  /**
   * Which infrastructure causes produced those holes, most frequent first.
   *
   * The actionable half: `provider-unreachable x29` says the campaign hit a rate limit, and
   * `harness-error x29` says our own code crashed. Those need opposite responses, and a bare
   * count cannot tell them apart. Empty exactly when `deferredSamples` is 0.
   */
  readonly deferredCauses: readonly DeferredCauseCount[];
}

/** The whole run's summary. */
export interface SweepSummary {
  readonly configHash: string | null;
  readonly ks: readonly number[];
  /** Empty when the file was REFUSED for holding stale-schema records. */
  readonly arms: readonly ArmSummary[];
  readonly totalSamples: number;
  /** Non-blank results lines that could not be decoded; 0 for a clean file. */
  readonly malformedLines: number;
  /** Lines written at an older schema version; any is enough to refuse the whole file. */
  readonly staleSchemaLines: number;
  /**
   * Slots the whole file ATTEMPTED and never measured; 0 for a matrix with no holes.
   *
   * THE FIRST THING A READER MUST SEE when it is non-zero, because every other number in
   * this summary is correct and covers fewer cells than the campaign planned. Summed over
   * the arms, so it is exactly `arms.flatMap(deferredSamples)` and cannot disagree with them.
   */
  readonly deferredSamples: number;
  /**
   * How many of the aggregated records carry no oracle verdict; 0 when every one does.
   *
   * A SUPERSET of `deferredSamples`, and the reason both are carried: a deferred slot is only
   * the INFRASTRUCTURE half, so a file whose no-verdict records are findings reports 0 deferred
   * and a non-zero count here. Taken over the same config-scoped population as `totalSamples`,
   * from the one `hasOracleVerdict` predicate, so the two numbers describe one file.
   */
  readonly noVerdictSamples: number;
  /**
   * Whether this summary REFUSED to aggregate.
   *
   * Set when the file holds records from an older schema, whose meaning differs from the
   * current one. Nothing is aggregated in that case - not even the current-version records
   * beside them - because a file mixing two schemas is a file whose totals are ambiguous,
   * and the remedy is a fresh output directory rather than a partial number.
   */
  readonly refusedStaleSchema: boolean;
}

/** Group records by a derived key, preserving first-seen order. */
function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): ReadonlyMap<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = groups.get(key);
    if (bucket === undefined) {
      groups.set(key, [item]);
      continue;
    }
    bucket.push(item);
  }
  return groups;
}

/** The distinct sample slots in a group, so a duplicated line cannot inflate n. */
function distinctSampleIndices(records: readonly SweepSampleRecord[]): number {
  return new Set(records.map((record) => record.sampleIndex)).size;
}

/**
 * The records eligible for the pass@k denominator: THE INVARIANT, applied.
 *
 * A sample counts only if the loop reached an oracle verdict AND the positive control proved
 * its testbench valid. The predicate itself lives in `../instrument-control.ts` so there is
 * exactly one implementation, and the reported `countedSamples` in the instrument block is
 * computed from that same predicate - so the denominator and the count that describes it
 * cannot disagree.
 */
function denominatorRecords(records: readonly SweepSampleRecord[]): readonly SweepSampleRecord[] {
  return records.filter((record) =>
    countsInPassAtK({
      outcomeStatus: record.outcomeStatus,
      instrument: instrumentVerdictOf(record),
    }),
  );
}

/**
 * The records pass@k is computed over when the control was never exercised.
 *
 * Verdict-bearing only - a sample the oracle never judged was never a model failure - but
 * NOT instrument-gated, because there is no instrument evidence to gate on. The result is
 * reported as NOT VALIDATED so it is never mistaken for a controlled number.
 */
function unvalidatedRecords(records: readonly SweepSampleRecord[]): readonly SweepSampleRecord[] {
  return records.filter(hasOracleVerdict);
}

/** The two facts the golden denominator is decided from, read off one record. */
function goldenEligibilityOf(record: SweepSampleRecord): GoldenPassAtKEligibility {
  return { outcomeStatus: record.outcomeStatus, golden: goldenOf(record) };
}

/**
 * The records eligible for the GOLDEN pass@k denominator: THE OTHER INVARIANT, applied.
 *
 * A sample counts only if the loop reached an oracle verdict AND the INDEPENDENT judge
 * returned a verdict on the candidate's behaviour. The predicate lives in
 * `../golden-judge.js` for the same reason `countsInPassAtK` lives in
 * `../instrument-control.js`: one implementation, read by both the estimator and the
 * exclusion tally the block prints beside it.
 *
 * This is a SECOND list beside `denominatorRecords`, never a replacement for it. The two
 * populations answer two different questions, and nothing in here can move the other one.
 */
function goldenDenominatorRecords(
  records: readonly SweepSampleRecord[],
): readonly SweepSampleRecord[] {
  return records.filter((record) => countsInGoldenPassAtK(goldenEligibilityOf(record)));
}

/**
 * Per-problem pass@k over the eligible records, keyed by k.
 *
 * `numerator` is a parameter rather than the hard-coded `record.passed`, and that is the
 * smallest change that lets ONE estimator and ONE aggregation shape serve both reported
 * numbers: the instrument-gated numerator is our own oracle's verdict, the golden numerator
 * is the independent judge's. A second implementation would be a second thing to get wrong,
 * and the two could drift silently in the direction nobody checks.
 */
function armPassAtK(
  eligible: readonly SweepSampleRecord[],
  ks: readonly number[],
  numerator: (record: SweepSampleRecord) => boolean,
): Readonly<Record<number, number>> {
  const byProblem = groupBy(eligible, (record) => record.problemId);
  const result: Record<number, number> = {};
  for (const k of ks) {
    const perProblem: number[] = [];
    for (const problemRecords of byProblem.values()) {
      const total = distinctSampleIndices(problemRecords);
      const correct = problemRecords.filter((record) => numerator(record)).length;
      perProblem.push(passAtK(total, correct, k));
    }
    result[k] = meanPassAtK(perProblem);
  }
  return result;
}

/** Whether OUR OWN oracle passed this sample: the instrument-gated numerator. */
function oraclePassed(record: SweepSampleRecord): boolean {
  return record.passed;
}

/** Whether the INDEPENDENT judge passed this sample: the golden numerator. */
function goldenPassed(record: SweepSampleRecord): boolean {
  return record.goldenVerdict === 'passed';
}

/** Turn a record's golden fields back into the judge's recorded shape, or null. */
function goldenOf(record: SweepSampleRecord): RecordedGoldenVerdict | null {
  if (record.goldenVerdict === null) {
    return null;
  }
  return { kind: record.goldenVerdict, failureCount: record.goldenFailureCount };
}

/**
 * The verdict pairs the agreement aggregator consumes.
 *
 * Exported so `./campaign-table.ts` reads Missed_Bug, Over_Strict, and Golden_Agreement through
 * the SAME projection this summary does; two readers of one word could otherwise disagree.
 */
export function verdictPairs(records: readonly SweepSampleRecord[]): readonly VerdictPair[] {
  return records.map((record) => ({ loopPassed: record.passed, golden: goldenOf(record) }));
}

/**
 * The records golden agreement is read over: an invalid instrument's verdict measured nothing, so
 * it is reported as an instrument defect instead. Exported so the Campaign table uses this filter.
 */
export function agreementRecords(
  records: readonly SweepSampleRecord[],
): readonly SweepSampleRecord[] {
  return records.filter((record) => record.instrumentValidity !== 'invalid');
}

/** The per-sample instrument facts the control aggregator consumes; exported with `verdictPairs`. */
export function instrumentSamples(
  records: readonly SweepSampleRecord[],
): readonly InstrumentSample[] {
  return records.map((record) => ({
    outcomeStatus: record.outcomeStatus,
    instrument: instrumentVerdictOf(record),
    loopPassed: record.passed,
    golden: goldenOf(record),
  }));
}

/**
 * The per-sample mutation facts the negative-control aggregator consumes.
 *
 * The problem id is carried because the calibration exclusions are a per-PROBLEM property and
 * the aggregator de-duplicates on it; summing them per sample would multiply a corpus fact by
 * the sample count.
 */
function mutationSamples(records: readonly SweepSampleRecord[]): readonly MutationSample[] {
  return records.map((record) => ({ problemId: record.problemId, probe: record.mutation }));
}

/** Tally how many samples ended in each outcome status. */
function statusCounts(
  records: readonly SweepSampleRecord[],
): Readonly<Partial<Record<SampleOutcomeStatus, number>>> {
  const counts: Partial<Record<SampleOutcomeStatus, number>> = {};
  for (const record of records) {
    counts[record.outcomeStatus] = (counts[record.outcomeStatus] ?? 0) + 1;
  }
  return counts;
}

/**
 * Tally the failure notes of the no-verdict samples, most frequent first.
 *
 * Scoped to the no-verdict statuses because a note is the explanation for the ABSENCE of a
 * verdict; the results file is untrusted input, so a note that turned up on a sample the
 * oracle did judge is not counted here. Ties break alphabetically: samples complete out of
 * order under concurrency, and a summary that reordered with them would not be citable.
 */
function noVerdictNotes(records: readonly SweepSampleRecord[]): readonly NoVerdictNoteCount[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    const note = record.failureNote;
    if (note === null || hasOracleVerdict(record)) {
      continue;
    }
    counts.set(note, (counts.get(note) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([note, count]) => ({ note, count }))
    .sort((left, right) => right.count - left.count || compareText(left.note, right.note));
}

/**
 * The records describing a slot that was ATTEMPTED and never measured.
 *
 * `isDeferredSample` is imported rather than restated for the same reason `hasOracleVerdict`
 * is: the resume index decides which slots it re-runs with that exact predicate, so a second
 * copy here could report a slot as final that the next run silently re-charges for - or the
 * reverse. One predicate, two readers.
 */
function deferredRecords(records: readonly SweepSampleRecord[]): readonly SweepSampleRecord[] {
  return records.filter((record) => isDeferredSample(record));
}

/**
 * Tally the TYPED causes behind an arm's deferred slots, most frequent first.
 *
 * Iterated over `NO_VERDICT_CAUSES` rather than over the observed values, so the tie-break
 * order is the union's own declaration order and a summary is byte-identical no matter which
 * order concurrent samples finished in. Zero-count causes are dropped, so a healthy arm gains
 * no noise.
 */
function deferredCauses(records: readonly SweepSampleRecord[]): readonly DeferredCauseCount[] {
  const counts = new Map<NoVerdictCause, number>();
  for (const record of records) {
    const cause = record.noVerdictCause;
    if (cause === null) {
      continue;
    }
    counts.set(cause, (counts.get(cause) ?? 0) + 1);
  }
  return NO_VERDICT_CAUSES.flatMap((cause) => {
    const count = counts.get(cause) ?? 0;
    return count === 0 ? [] : [{ cause, count }];
  }).sort((left, right) => right.count - left.count);
}

/**
 * Tally the reasons behind an arm's `unchecked`-instrument samples, most frequent first.
 *
 * Iterated over `INSTRUMENT_UNCHECKED_REASONS` rather than over the observed values, for the
 * same reason `deferredCauses` iterates `NO_VERDICT_CAUSES`: a fixed declaration order makes
 * the rendered breakdown byte-identical regardless of completion order under concurrency.
 * Zero-count reasons are dropped, so an arm with no unchecked samples gains no noise.
 */
function uncheckedReasonCounts(
  records: readonly SweepSampleRecord[],
): readonly UncheckedReasonCount[] {
  const counts = new Map<InstrumentUncheckedReason, number>();
  for (const record of records) {
    if (record.instrumentValidity !== 'unchecked' || record.instrumentUncheckedReason === null) {
      continue;
    }
    const reason = record.instrumentUncheckedReason;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return INSTRUMENT_UNCHECKED_REASONS.flatMap((reason) => {
    const count = counts.get(reason) ?? 0;
    return count === 0 ? [] : [{ reason, count }];
  }).sort((left, right) => right.count - left.count);
}

/**
 * Tally the declined Testbench_Repair attempts by Repair_Decline_Reason, most frequent first.
 *
 * Iterated over `REPAIR_DECLINE_REASONS` rather than over the observed values, for the same
 * reason `uncheckedReasonCounts` and `deferredCauses` iterate their own fixed vocabularies: a
 * declaration-order tie break makes the rendered breakdown byte-identical regardless of
 * completion order under concurrency. Scoped to `repairAttempted && !repairAccepted` records,
 * which is exactly the population `repairDeclineReason` is non-null for (see
 * `decodeRepairDeclineReason` in `./results-log.ts`). Zero-count reasons are dropped, so an
 * arm with no declines gains no noise.
 */
function repairDeclinedByReason(
  records: readonly SweepSampleRecord[],
): readonly RepairDeclineReasonCount[] {
  const counts = new Map<RepairDeclineReason, number>();
  for (const record of records) {
    if (!record.repairAttempted || record.repairAccepted || record.repairDeclineReason === null) {
      continue;
    }
    const reason = record.repairDeclineReason;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return REPAIR_DECLINE_REASONS.flatMap((reason) => {
    const count = counts.get(reason) ?? 0;
    return count === 0 ? [] : [{ reason, count }];
  }).sort((left, right) => right.count - left.count);
}

/**
 * Tally Could_Not_Verify_Causes over their closed vocabulary, most frequent first (pure).
 *
 * Iterated over `COULD_NOT_VERIFY_CAUSES` rather than over the observed values, for the reason
 * `deferredCauses` iterates `NO_VERDICT_CAUSES`: the declaration order is the tie break, so the
 * breakdown is byte-identical whatever order concurrent samples finished in. A cause holding no
 * sample yields no entry (Req 12.17), so a healthy arm gains no noise.
 */
function causeCounts(causes: readonly CouldNotVerifyCause[]): readonly CouldNotVerifyCauseCount[] {
  const counts = new Map<CouldNotVerifyCause, number>();
  for (const cause of causes) {
    counts.set(cause, (counts.get(cause) ?? 0) + 1);
  }
  return COULD_NOT_VERIFY_CAUSES.flatMap((cause) => {
    const count = counts.get(cause) ?? 0;
    return count === 0 ? [] : [{ cause, count }];
  }).sort((left, right) => right.count - left.count);
}

/**
 * The cause behind each `could-not-verify` deciding verdict, one per such record (pure).
 *
 * Read only where the verdict IS `could-not-verify`, the pairing `decodeFormalCause` in
 * `./results-log.ts` already holds on read, so the cause entries can only ever sum to that
 * verdict's bucket - the same double guard `uncheckedReasonCounts` keeps on its own pairing.
 */
function couldNotVerifyCauses(
  records: readonly SweepSampleRecord[],
): readonly CouldNotVerifyCause[] {
  return records.flatMap((record) => {
    const run = record.formal;
    return run?.verdict === 'could-not-verify' && run.cause !== null ? [run.cause] : [];
  });
}

/**
 * Tally the Fallback_Routes, most frequent first, dropping the members nothing took (pure).
 *
 * Iterated over `FALLBACK_ROUTES` - imported from `@app/agent`, which OWNS the vocabulary -
 * rather than over the observed values, for the reason `causeCounts` iterates
 * `COULD_NOT_VERIFY_CAUSES`: the declaration order is the tie break, so the breakdown is
 * byte-identical whatever order concurrent samples finished in. Reading the owner's array also
 * means a FIFTH route is a compile error here rather than a row this file silently never prints.
 */
function routeCounts(records: readonly SweepSampleRecord[]): readonly FallbackRouteCount[] {
  const counts = new Map<FallbackRoute, number>();
  for (const record of records) {
    const route = record.formalFallbackRoute;
    counts.set(route, (counts.get(route) ?? 0) + 1);
  }
  return FALLBACK_ROUTES.flatMap((route) => {
    const count = counts.get(route) ?? 0;
    return count === 0 ? [] : [{ route, count }];
  }).sort((left, right) => right.count - left.count);
}

/** A tally with nothing in it: the summation seed, never a reported value. */
const NO_FORMAL_MUTANTS: FormalMutationCounts = {
  totalCount: 0,
  denominator: 0,
  killedCount: 0,
  survivedCount: 0,
  couldNotVerifyCount: 0,
};

/**
 * Sum the arm's Formal_Mutation_Counts, or report that nothing carried any (pure).
 *
 * `null` for an arm where NO sample carries a tally, which is every arm until a production
 * `PropertySetGate` is wired: the summation of nothing is an all-zero tally, and that reads as a
 * gate that calibrated mutants and scored none of them (Req 9.12). The guard is on the length of
 * the carrying population rather than on the summed totals, so an arm whose gate genuinely
 * calibrated ZERO mutants still reports a measured tally.
 *
 * Every field is summed, including `couldNotVerifyCount`, which is the whole point: an excluded
 * mutant is reported rather than dropped on the way to the report (Req 9.4).
 */
function formalMutationTotals(records: readonly SweepSampleRecord[]): FormalMutationCounts | null {
  const tallied = records.flatMap((record) =>
    record.formalMutationCounts === null ? [] : [record.formalMutationCounts],
  );
  if (tallied.length === 0) {
    return null;
  }
  return tallied.reduce<FormalMutationCounts>(
    (totals, counts) => ({
      totalCount: totals.totalCount + counts.totalCount,
      denominator: totals.denominator + counts.denominator,
      killedCount: totals.killedCount + counts.killedCount,
      survivedCount: totals.survivedCount + counts.survivedCount,
      couldNotVerifyCount: totals.couldNotVerifyCount + counts.couldNotVerifyCount,
    }),
    NO_FORMAL_MUTANTS,
  );
}

/** Tally the deciding Formal_Verdicts; every member is present, so a zero still prints (pure). */
function formalVerdictCounts(
  records: readonly SweepSampleRecord[],
): Readonly<Record<FormalVerdict, number>> {
  const counts: Record<FormalVerdict, number> = { proved: 0, refuted: 0, 'could-not-verify': 0 };
  for (const record of records) {
    if (record.formal !== null) {
      counts[record.formal.verdict] += 1;
    }
  }
  return counts;
}

/**
 * One arm's refused-Property_Set count, or `null` where NO sample was gated (Req 9.5, 9.6).
 *
 * Decided ONE STEP EARLIER than the refusal filter: an arm whose every record reads `'not-gated'`
 * had nothing gated, so it has no refusal count to report, which is a different claim from a gate
 * that ran and refused nothing. `'no-gate-set'` is a gate that RAN with nothing to hold the set
 * to, so it counts as gated here while still not counting as a refusal.
 */
function refusedSamplesOf(records: readonly SweepSampleRecord[]): number | null {
  const gated = records.filter((record) => record.propertySetAdmitted !== 'not-gated');
  return gated.length === 0
    ? null
    : gated.filter((record) => record.propertySetAdmitted === 'refused').length;
}

/**
 * Aggregate one arm's FORMAL numbers (pure).
 *
 * Each total and its breakdown come from ONE list, so the cause entries cannot disagree with the
 * frontend-rejected count and the Fallback_Reason entries cannot disagree with the fallback
 * total - the one-filter discipline `deferredSamples` and `deferredCauses` already follow.
 */
function armFormal(records: readonly SweepSampleRecord[]): ArmFormalReport {
  const causes = couldNotVerifyCauses(records);
  const fallbackReasons = records.flatMap((record) =>
    record.formalFallbackReason === null ? [] : [record.formalFallbackReason],
  );
  const mutationCounts = formalMutationTotals(records);
  return {
    verdictCounts: formalVerdictCounts(records),
    noneSubmittedSamples: records.filter((record) => record.formal === null).length,
    causeCounts: causeCounts(causes),
    fallbackSamples: fallbackReasons.length,
    fallbackReasonCounts: causeCounts(fallbackReasons),
    frontendRejectedSamples: causes.filter((cause) => cause === 'frontend-rejected').length,
    propertySetRefusedSamples: refusedSamplesOf(records),
    routeCounts: routeCounts(records),
    mutationCounts,
    // THE EXISTING ESTIMATOR, not a second inline division: `formalKillRateOf` owns both the
    // denominator rule and the no-rate case, and a copy here could drift from it.
    mutationKillRate: mutationCounts === null ? null : formalKillRateOf(mutationCounts),
  };
}

/**
 * Count an arm's Valueless_Failure_Report sources, a `null` count in neither numerator nor
 * denominator. The rate is `null` at zero sources, because "no sample had a testbench" and
 * "no testbench had a valueless report" are opposite findings (pure).
 */
function armReportability(records: readonly SweepSampleRecord[]): ArmReportabilityReport {
  const counts = records.flatMap((record) =>
    record.valuelessFailureReports === null ? [] : [record.valuelessFailureReports],
  );
  const withReport = counts.filter((count) => count > 0).length;
  return {
    withReport,
    sources: counts.length,
    valuelessReportRate: counts.length === 0 ? null : withReport / counts.length,
  };
}

/** Order two strings deterministically, so every rendered list is stable. */
function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * Aggregate one arm's cost, refusing to report a number built on unknown prices.
 *
 * A single unpriced sample makes the whole arm UNKNOWN: a partial total understates
 * spend while looking authoritative, which is worse than declining to answer.
 */
function armCost(records: readonly SweepSampleRecord[], verifiedSamples: number): ArmCost {
  if (records.length === 0 || records.some((record) => !record.costKnown)) {
    return { known: false };
  }
  const totalCents = records.reduce((sum, record) => sum + record.costCents, 0);
  return {
    known: true,
    totalCents,
    meanCentsPerSample: totalCents / records.length,
    costPerVerifiedCents: verifiedSamples === 0 ? null : totalCents / verifiedSamples,
  };
}

/** Sum the measured token and wall-clock fields over one set of records (pure). */
function tokenTotals(records: readonly SweepSampleRecord[]): ArmTokenTotals {
  return records.reduce<ArmTokenTotals>(
    (totals, record) => ({
      samples: totals.samples + 1,
      promptTokens: totals.promptTokens + record.promptTokens,
      completionTokens: totals.completionTokens + record.completionTokens,
      totalTokens: totals.totalTokens + record.totalTokens,
      unreportedUsageCalls: totals.unreportedUsageCalls + record.unreportedUsageCalls,
      wallClockMs: totals.wallClockMs + record.durationMs,
    }),
    {
      samples: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      unreportedUsageCalls: 0,
      wallClockMs: 0,
    },
  );
}

/**
 * Aggregate one arm's MEASURED efficiency (pure).
 *
 * THE POPULATION IS THE CALLER'S `eligible` SET, and that is the whole point of the design:
 * it is the exact same list `armPassAtK` is handed, so the per-artifact rates and pass@k are
 * computed over one identical set of samples. A sample excluded from pass@k - no oracle
 * verdict, or an instrument the controls could not prove - contributes NEITHER tokens to the
 * numerator nor a verified artifact to the divisor, so it can neither inflate nor deflate the
 * rate. Passing `records` here instead would let an arm's rate improve by generating samples
 * the pass@k number refuses to count.
 *
 * No price is consulted anywhere in here, and none can be: the inputs are token counts the
 * endpoint reported and wall clock the runner observed.
 */
function armEfficiency(
  records: readonly SweepSampleRecord[],
  eligible: readonly SweepSampleRecord[],
): ArmEfficiency {
  const population = tokenTotals(eligible);
  const verifiedArtifacts = eligible.filter((record) => record.passed).length;
  const noVerified = verifiedArtifacts === 0;
  return {
    recorded: tokenTotals(records),
    population,
    verifiedArtifacts,
    // `null`, never a division by zero: an arm that verified nothing has no per-artifact
    // rate, and Infinity or NaN would travel onward as if it were one.
    tokensPerVerified: noVerified ? null : population.totalTokens / verifiedArtifacts,
    msPerVerified: noVerified ? null : population.wallClockMs / verifiedArtifacts,
  };
}

/** The mean of a non-empty numeric list, or null for an empty one. */
function meanOrNull(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** The pass@k population of one arm, and whether the instrument controls validated it. */
interface PassAtKPopulation {
  /** Whether the positive control was exercised at all; `false` labels pass@k NOT VALIDATED. */
  readonly validated: boolean;
  /**
   * The samples pass@k is taken over. ONE list, handed to `armEfficiency` as well, so the
   * per-artifact rates and pass@k are computed over one identical set of samples.
   */
  readonly eligible: readonly SweepSampleRecord[];
}

/** Decide one arm's pass@k population from what its instrument controls established (pure). */
function passAtKPopulation(
  records: readonly SweepSampleRecord[],
  instrument: InstrumentControlReport,
): PassAtKPopulation {
  const validated = instrumentControlMeasured(instrument);
  return {
    validated,
    eligible: validated ? denominatorRecords(records) : unvalidatedRecords(records),
  };
}

/** Name an arm and size it: its model set, its sample count, and its problem count (pure). */
function armIdentity(
  armName: string,
  records: readonly SweepSampleRecord[],
): Pick<
  ArmSummary,
  'armName' | 'modelSignature' | 'signatureConflict' | 'sampleCount' | 'problemCount'
> {
  const signatures = new Set(records.map((record) => record.modelSignature));
  return {
    armName,
    modelSignature: [...signatures].sort().join(' | '),
    signatureConflict: signatures.size > 1,
    sampleCount: records.length,
    problemCount: new Set(records.map((record) => record.problemId)).size,
  };
}

/** Estimate an arm's self-graded and golden pass@k, each over its own denominator (pure). */
function armPassAtKFigures(
  records: readonly SweepSampleRecord[],
  population: PassAtKPopulation,
  ks: readonly number[],
): Pick<ArmSummary, 'passAtK' | 'passAtKValidated' | 'goldenPassAtK' | 'goldenReport'> {
  return {
    // ONE estimator, TWO numerators: `oraclePassed` is our own verdict, `goldenPassed` is the
    // independent judge's. Passing the predicate keeps a single implementation and a single
    // aggregation shape, so the two numbers cannot drift in the direction nobody checks.
    passAtK: armPassAtK(population.eligible, ks, oraclePassed),
    passAtKValidated: population.validated,
    // The golden denominator is decided ENTIRELY by the independent judge, never by the
    // instrument controls, so this list is built and passed independently of `eligible`.
    goldenPassAtK: armPassAtK(goldenDenominatorRecords(records), ks, goldenPassed),
    goldenReport: summarizeGoldenPassAtK(records.map((record) => goldenEligibilityOf(record))),
  };
}

/** Count an arm's passing samples, split into first-try and repaired, with both rates (pure). */
function armVerifiedCounts(
  sampleCount: number,
  passing: readonly SweepSampleRecord[],
): Pick<
  ArmSummary,
  'verifiedSamples' | 'firstTrySamples' | 'repairedSamples' | 'firstTryRate' | 'repairedRate'
> {
  const firstTrySamples = passing.filter((record) => record.iterations <= 1).length;
  const repairedSamples = passing.length - firstTrySamples;
  return {
    verifiedSamples: passing.length,
    firstTrySamples,
    repairedSamples,
    firstTryRate: sampleCount === 0 ? 0 : firstTrySamples / sampleCount,
    repairedRate: sampleCount === 0 ? 0 : repairedSamples / sampleCount,
  };
}

/** Count an arm's Testbench_Repair attempts and the normalization signal beside them (pure). */
function armTestbenchRepair(
  records: readonly SweepSampleRecord[],
  instrument: InstrumentControlReport,
): Pick<
  ArmSummary,
  | 'testbenchRepairAttempted'
  | 'testbenchRepairAccepted'
  | 'testbenchRepairDeclinedByReason'
  | 'validNoRepair'
  | 'validAfterRepair'
  | 'checkNameVisibilitySignalSamples'
> {
  const accepted = records.filter((record) => record.repairAttempted && record.repairAccepted);
  // The decomposition is OF the valid total, so it counts the intersection: a repair can be
  // accepted on a build re-check and still end invalid (see `testbenchRepairAccepted`).
  const validAfterRepair = accepted.filter(
    (record) => record.instrumentValidity === 'valid',
  ).length;
  return {
    testbenchRepairAttempted: records.filter((record) => record.repairAttempted).length,
    testbenchRepairAccepted: accepted.length,
    testbenchRepairDeclinedByReason: repairDeclinedByReason(records),
    validNoRepair: instrument.validSamples - validAfterRepair,
    validAfterRepair,
    checkNameVisibilitySignalSamples: records.filter((record) => record.checkNameVisibilitySignal)
      .length,
  };
}

/** Measure what an arm's artifacts took: iterations per pass, efficiency, and dollars (pure). */
function armEffort(
  records: readonly SweepSampleRecord[],
  passing: readonly SweepSampleRecord[],
  eligible: readonly SweepSampleRecord[],
): Pick<ArmSummary, 'meanIterationsToPass' | 'efficiency' | 'cost'> {
  return {
    meanIterationsToPass: meanOrNull(passing.map((record) => record.iterations)),
    efficiency: armEfficiency(records, eligible),
    cost: armCost(records, passing.length),
  };
}

/** Break down how an arm's samples ended, and why the rest reached no verdict (pure). */
function armOutcomeBreakdowns(
  records: readonly SweepSampleRecord[],
): Pick<
  ArmSummary,
  | 'agreement'
  | 'statusCounts'
  | 'noVerdictNotes'
  | 'uncheckedReasonCounts'
  | 'deferredSamples'
  | 'deferredCauses'
> {
  const deferred = deferredRecords(records);
  return {
    agreement: summarizeAgreement(verdictPairs(agreementRecords(records))),
    statusCounts: statusCounts(records),
    noVerdictNotes: noVerdictNotes(records),
    uncheckedReasonCounts: uncheckedReasonCounts(records),
    // Both taken from the SAME filtered list, so the count and the causes describing it are
    // one population by construction and `deferredCauses` is empty exactly when the count is 0.
    deferredSamples: deferred.length,
    deferredCauses: deferredCauses(deferred),
  };
}

/**
 * Aggregate one arm's records into its summary (pure).
 *
 * The slices are spread in `ArmSummary`'s declaration order, so the assembled object carries its
 * fields in the order it always has.
 */
function summarizeArm(
  armName: string,
  records: readonly SweepSampleRecord[],
  ks: readonly number[],
): ArmSummary {
  const instrument = summarizeInstrumentControl(instrumentSamples(records));
  const population = passAtKPopulation(records, instrument);
  const passing = records.filter((record) => record.passed);
  return {
    ...armIdentity(armName, records),
    ...armPassAtKFigures(records, population, ks),
    instrument,
    reportability: armReportability(records),
    mutation: summarizeMutationControl(mutationSamples(records)),
    formal: armFormal(records),
    ...armVerifiedCounts(records.length, passing),
    ...armTestbenchRepair(records, instrument),
    ...armEffort(records, passing, population.eligible),
    ...armOutcomeBreakdowns(records),
  };
}

/**
 * Aggregate a whole results file into the per-arm summary (pure).
 *
 * Records carrying a `configHash` other than `configHash` are EXCLUDED when one is
 * supplied, so a file that accumulated two experiments is never blended. Passing `null`
 * summarizes everything present, which is the right behaviour for inspecting an
 * unknown file.
 *
 * REFUSES outright when `health.staleSchemaLines` is non-zero: a file holding records whose
 * fields mean something different cannot be aggregated into one number, and there is no
 * silent migration (see `STALE_SCHEMA_ADVICE` in `./results-log.ts`).
 */
export function summarizeRecords(
  records: readonly SweepSampleRecord[],
  ks: readonly number[],
  configHash: string | null,
  health: ResultsLogHealth,
): SweepSummary {
  const base = {
    configHash,
    ks,
    malformedLines: health.malformedLines,
    staleSchemaLines: health.staleSchemaLines,
  };
  if (health.staleSchemaLines > 0) {
    // Zero because nothing was aggregated, not because the file has no holes: a refused file
    // has no arms to sum, and the REFUSAL is the finding a reader must act on.
    return {
      ...base,
      arms: [],
      totalSamples: 0,
      deferredSamples: 0,
      noVerdictSamples: 0,
      refusedStaleSchema: true,
    };
  }
  const scoped =
    configHash === null ? records : records.filter((record) => record.configHash === configHash);
  const byArm = groupBy(scoped, (record) => record.armName);
  const arms = [...byArm.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([armName, armRecords]) => summarizeArm(armName, armRecords, ks));
  return {
    ...base,
    arms,
    totalSamples: scoped.length,
    // Summed over the arms rather than recomputed from `scoped`, so the banner and the arm
    // blocks cannot disagree: there is one filter, applied once, per arm.
    deferredSamples: arms.reduce((total, arm) => total + arm.deferredSamples, 0),
    // Taken from `scoped` rather than the arms, because no arm carries this count and the
    // claim is about the file: one filter over the same records `totalSamples` counts.
    noVerdictSamples: scoped.filter((record) => !hasOracleVerdict(record)).length,
    refusedStaleSchema: false,
  };
}

/** Render a rate as a fixed-precision string. */
function rate(value: number): string {
  return value.toFixed(RATE_DIGITS);
}

/** Render a whole-number count; the per-artifact rates are large, so decimals are noise. */
function whole(value: number): string {
  return String(Math.round(value));
}

/**
 * Render the MEASURED efficiency block: the primary answer to "which arm is cheapest".
 *
 * PRINTED BEFORE THE DOLLAR BLOCK on purpose. Dollars used to be the only cost figure here,
 * so an operator who reads top to bottom must meet the measured number first and the
 * rate-card restatement second - otherwise `UNKNOWN` is the first cost word on the page and
 * reads as "nothing was measured".
 *
 * EVERY DIVISION IS REPRODUCIBLE FROM THE PRINTED NUMBERS. The rate line states its own
 * numerator and divisor inline rather than only the quotient, because the totals on the line
 * above it are over a WIDER set (every recorded sample, all of which were paid for) and a
 * reader who divided those would get a different number and assume one of them is wrong.
 */
function efficiencyLines(summary: ArmSummary): readonly string[] {
  const { recorded, population, verifiedArtifacts, tokensPerVerified, msPerVerified } =
    summary.efficiency;
  const scope = `over ${population.samples} pass@k sample(s)`;
  const tokenRate =
    tokensPerVerified === null
      ? `n/a (no verified artifact; ${population.totalTokens} tok ${scope})`
      : `${whole(tokensPerVerified)} tok  (${population.totalTokens} tok / ` +
        `${verifiedArtifacts} verified, ${scope})`;
  const wallRate =
    msPerVerified === null
      ? `n/a (no verified artifact; ${population.wallClockMs}ms ${scope})`
      : `${whole(msPerVerified)}ms  (${population.wallClockMs}ms / ` +
        `${verifiedArtifacts} verified, same ${population.samples} sample(s))`;
  return [
    `  tokens:          prompt ${recorded.promptTokens}  completion ${recorded.completionTokens}  ` +
      `total ${recorded.totalTokens}  over all ${recorded.samples} recorded sample(s)`,
    "                   <== MEASURED from the endpoint's own usage counts; needs no price",
    `  tokens/verified: ${tokenRate}`,
    `  wall/verified:   ${wallRate}`,
    ...unreportedUsageLines(recorded),
  ];
}

/**
 * Warn that the token counts are FLOORS, and only when they actually are.
 *
 * A provider that sends no usable `usage` block has reported nothing, and that call
 * contributes zero to every token total above. Silence and a genuinely free call are
 * indistinguishable in a sum, so the count of silent calls is printed instead of being
 * folded in - otherwise a host that stopped metering would read as the efficient arm.
 */
function unreportedUsageLines(recorded: ArmTokenTotals): readonly string[] {
  if (recorded.unreportedUsageCalls === 0) {
    return [];
  }
  return [
    `  usage unreported: ${recorded.unreportedUsageCalls} model call(s) returned no usable usage ` +
      'block, so every',
    '                   token figure above is a FLOOR and tokens/verified understates the truth',
  ];
}

/**
 * Render the arm's cost IN DOLLARS: the optional secondary figure.
 *
 * The UNKNOWN branch is worded to defeat one specific misreading. `UNKNOWN` used to be the
 * only cost word an unpriced campaign ever saw, so it read as "efficiency was not measured"
 * - which was true then and is false now. It therefore has to state which single figure is
 * missing and that the measured ones are above it, not merely that a price is absent.
 *
 * The known branch names its population, because it is a WIDER one than
 * `tokens/verified` uses (see `ArmCost.costPerVerifiedCents`) and two per-artifact rates over
 * two unnamed populations would be read as though they were over one.
 */
function costLines(summary: ArmSummary): readonly string[] {
  if (!summary.cost.known) {
    return [
      '  cost (dollars):  UNKNOWN - at least one model in this arm has no configured price, and',
      '                   no price is ever assumed. This is the ONLY unmeasured figure in this',
      '                   block: tokens and wall clock per verified artifact above ARE measured',
      '                   and are the primary efficiency numbers. Set prices.<modelId> in the',
      '                   config to add the dollar restatement of the same consumption',
    ];
  }
  const cpva = summary.cost.costPerVerifiedCents;
  return [
    `  cost (dollars):  total ${summary.cost.totalCents.toFixed(CENT_DIGITS)}c, ` +
      `mean ${summary.cost.meanCentsPerSample.toFixed(CENT_DIGITS)}c/sample ` +
      '(a rate card applied to the measured tokens, not a measurement)',
    `  cost/verified:   ${cpva === null ? 'n/a (no verified artifact)' : `${cpva.toFixed(CENT_DIGITS)}c`}` +
      ` (over all ${summary.sampleCount} recorded sample(s), a wider set than tokens/verified)`,
  ];
}

/** Render the agreement block, with the missed-bug count on its own line. */
function agreementLines(summary: ArmSummary): readonly string[] {
  const { agreement } = summary;
  if (agreement.judgedSamples === 0) {
    return ['  golden judge:    NOT MEASURED (no sample was judged)'];
  }
  return [
    `  golden judge:    ${agreement.agreeingSamples}/${agreement.judgedSamples} agree ` +
      `(rate ${rate(agreement.agreementRate)})`,
    `  MISSED BUGS:     ${agreement.loopPassGoldenFail} (our testbench passed, golden failed)`,
    `  over-strict:     ${agreement.loopFailGoldenPass} (our testbench failed, golden passed)`,
  ];
}

/**
 * Render the POSITIVE CONTROL block, next to the golden-judge block it reinterprets.
 *
 * `instrument-invalid` is printed whenever it is non-zero, on its own line, because it is a
 * first-class result and not a footnote: each one is a sample whose testbench rejects the
 * benchmark's own reference design, so its verdict was never about the model. When any of
 * those also read as a golden-judge disagreement, the split is printed too - that is the
 * difference between "chase the model" and "fix our testbench generator".
 */
function instrumentLines(summary: ArmSummary): readonly string[] {
  const { instrument } = summary;
  if (!summary.passAtKValidated) {
    return [
      '  instrument:      NOT MEASURED (no positive control ran, so pass@k above is',
      '                   UNVALIDATED: our own testbenches were never checked against the',
      '                   reference designs they are supposed to be able to pass)',
    ];
  }
  return [
    `  instrument:      ${instrument.validSamples}/${instrument.checkedSamples} testbenches ` +
      'pass their reference design',
    ...testbenchRepairLines(summary),
    // One spelling of the key in both branches, so `instrument-invalid` is greppable across a
    // campaign's summaries whether or not any turned up. The emphasis lives in the message.
    ...(instrument.invalidSamples > 0
      ? [
          `  instrument-invalid: ${instrument.invalidSamples}  <== OUR TESTBENCH IS NOT A ` +
            'MEASURING STICK; excluded from pass@k',
          `                   of these: rejected-reference ${instrument.failedReferenceSamples}  ` +
            `did-not-build ${instrument.unbuildableSamples}  ` +
            `survived-mutants ${instrument.survivedMutantsSamples}  ` +
            `no-verdict ${instrument.erroredSamples}`,
        ]
      : ['  instrument-invalid: 0']),
    // Disjoint from the agreement block above, not a subset of it: those numbers already
    // exclude the invalid instruments. Said explicitly, because both use the word
    // "over-strict" and a reader must not add them up or mistake one for the other.
    ...(instrument.invalidOverStrict > 0 || instrument.invalidMissedBug > 0
      ? [
          '                   NOT counted in the agreement numbers above, and NOT disagreements',
          `                   to chase: over-strict ${instrument.invalidOverStrict}, ` +
            `missed-bugs ${instrument.invalidMissedBug} came from these broken instruments`,
        ]
      : []),
    ...(instrument.uncheckedWithVerdict > 0
      ? [
          `  instrument-unchecked: ${instrument.uncheckedWithVerdict} judged sample(s) whose ` +
            'instrument could not be proven; also excluded',
          ...uncheckedReasonLines(summary.uncheckedReasonCounts),
        ]
      : []),
    ...instrumentRefusedLines(summary),
  ];
}

/**
 * Render the `instrument-valid` decomposition: how many needed a Testbench_Repair.
 *
 * Printed only when `testbenchRepairAttempted > 0`, matching this file's convention of
 * gating a sub-block on it having something to say (see `instrument.invalidSamples > 0` /
 * `instrument.uncheckedWithVerdict > 0` above). Nested under the `instrument:` line it
 * decomposes, at the same indentation column `instrument-invalid`'s own defect breakdown
 * uses, because it is the same kind of thing: the headline total broken into its parts.
 *
 * `testbenchRepairAttempted` now counts EVERY declined attempt too (Req 1.7), so this line's
 * own attempted/accepted pair already reflects that; `repairDeclineReasonLines` immediately
 * below adds the per-reason breakdown of the gap between them, and
 * `checkNameVisibilitySignalLine` adds the separately-counted early-warning signal.
 */
function testbenchRepairLines(summary: ArmSummary): readonly string[] {
  if (summary.testbenchRepairAttempted === 0) {
    return checkNameVisibilitySignalLine(summary);
  }
  return [
    `                   of these: valid-no-repair ${summary.validNoRepair}  ` +
      `valid-after-repair ${summary.validAfterRepair}  ` +
      `(testbench-repair attempted ${summary.testbenchRepairAttempted}, ` +
      `accepted-on-recheck ${summary.testbenchRepairAccepted})`,
    ...repairDeclineReasonLines(summary.testbenchRepairDeclinedByReason),
    ...checkNameVisibilitySignalLine(summary),
  ];
}

/** The label that opens the Testbench_Repair decline breakdown; sets the value column. */
const REPAIR_DECLINE_REASON_LABEL = '                   declined: ';

/**
 * Render the declined Testbench_Repair attempts broken out by Repair_Decline_Reason, one
 * reason per line, most frequent first.
 *
 * Nested under the `of these:` attempted/accepted line exactly as `instrument-invalid`'s own
 * defect breakdown is nested under it a few lines up: a reader who already stopped at the
 * attempted/accepted pair finds WHICH STAGE each decline happened at in the same block
 * instead of having to search a second one. Printed only when at least one attempt was
 * declined, matching every other conditional breakdown in this file.
 */
function repairDeclineReasonLines(counts: readonly RepairDeclineReasonCount[]): readonly string[] {
  if (counts.length === 0) {
    return [];
  }
  const continuation = ' '.repeat(REPAIR_DECLINE_REASON_LABEL.length);
  return counts.map(
    ({ reason, count }, index) =>
      `${index === 0 ? REPAIR_DECLINE_REASON_LABEL : continuation}${reason} x${count}`,
  );
}

/**
 * Render Council B's early-warning signal count: a normalized-and-silently-emptied testbench
 * (Req 5.9, 5.11).
 *
 * REPORTED SEPARATELY from `valid-no-repair` and `valid-after-repair` above rather than folded
 * into either, so a normalized-and-silently-emptied testbench is never pooled with a
 * normalized-and-intact one (see `ArmSummary.checkNameVisibilitySignalSamples`). Printed
 * whenever the instrument was measured at all, even at zero, because a reader who saw the line
 * once and stops seeing it must not wonder whether the signal is still being computed.
 */
function checkNameVisibilitySignalLine(summary: ArmSummary): readonly string[] {
  return [
    `                   check-name-visibility-signal: ${summary.checkNameVisibilitySignalSamples} ` +
      '(normalized testbench whose check name(s) went silent; see per-sample artifacts)',
  ];
}

/** The label that opens the unchecked-instrument reason breakdown; sets the value column. */
const UNCHECKED_REASON_LABEL = '                   of these: ';

/**
 * Render WHY this arm's unchecked-instrument samples could not be spoken for, one reason per
 * line, most frequent first.
 *
 * Nested under the `instrument-unchecked` line it explains, exactly as
 * `instrument-invalid`'s own defect breakdown is nested under it a few lines up: a reader who
 * already stopped at `instrument-unchecked` finds the WHY in the same block instead of having
 * to search a second one.
 */
function uncheckedReasonLines(counts: readonly UncheckedReasonCount[]): readonly string[] {
  const continuation = ' '.repeat(UNCHECKED_REASON_LABEL.length);
  return counts.map(
    ({ reason, count }, index) =>
      `${index === 0 ? UNCHECKED_REASON_LABEL : continuation}${reason} x${count} - ` +
      describeInstrumentVerdict(uncheckedInstrument(reason)),
  );
}

/**
 * Render this arm's `instrument-refused` count and the reason it exists at all.
 *
 * A REFUSED instrument is a THIRD population beside `instrument-invalid` and
 * `instrument-unchecked`: the Testbench_Precheck or the Instrument_Admission port stopped the
 * loop before it spent an iteration, so - unlike an invalid or unchecked instrument - this
 * sample's candidate is the loop's FIRST candidate and never saw a repair. That is the fact a
 * reader must not lose track of when this line is non-zero: the accompanying golden pass@k
 * (`goldenPassAtKLines`) is not a like-for-like measurement against a sample that ran the full
 * loop (Req 5.11, 5.12).
 *
 * Printed only when non-zero, matching every other conditional block in this file.
 */
function instrumentRefusedLines(summary: ArmSummary): readonly string[] {
  const refused = summary.statusCounts['instrument-refused'] ?? 0;
  if (refused === 0) {
    return [];
  }
  return [
    `  instrument-refused: ${refused}  <== the loop stopped BEFORE any repair iteration; each`,
    '                   of these samples was judged as a FIRST candidate with NO repair, so',
    '                   its golden pass@k contribution is NOT comparable to a sample that ran',
    '                   the full repair loop',
  ];
}

/** How many survived operators are named before the list is elided. */
const MAX_RENDERED_SURVIVED_OPERATORS = 6;

/**
 * Render the NEGATIVE CONTROL block: the kill rate, the two survivor buckets, and the cost.
 *
 * WHICH NUMBER GATES IS STATED IN THE OUTPUT, not left to be inferred. The kill-rate line is
 * marked `signal, does not gate` and the coverage-gap line is marked as the gate, because the
 * rate WAS the gate until it was measured to fail good instruments and an operator reading two
 * summaries side by side must not assume the familiar number still decides anything.
 *
 * THE DENOMINATOR IS NAMED IN THE LINE ITSELF (`valid mutant(s)`), for the same reason: it has
 * been two different populations across three schema versions.
 *
 * THE COVERAGE-GAP BUCKET COMES FIRST and is the loudest thing in the block. Each entry is a
 * defect class the INDEPENDENT judge has demonstrated is catchable and ours does not catch, so
 * it is a work item AND the thing that decided validity. The candidate-equivalent bucket
 * follows, marked as needing review rather than as a defect, because nobody has established
 * those mutants are killable at all.
 *
 * The per-PROBLEM calibration facts are printed with their scope stated, because the kill
 * counts beside them are per-SAMPLE. A reader who added them up would otherwise reach a mutant
 * total that never existed.
 */
function mutationLines(summary: ArmSummary): readonly string[] {
  const { mutation } = summary;
  if (!mutationControlMeasured(mutation)) {
    return [
      '  mutation:        NOT MEASURED (no negative control ran, so instrument-valid above',
      '                   means only "our testbench passes the reference design" - it does NOT',
      '                   rule out a testbench that passes everything)',
    ];
  }
  const killRate = mutation.killRate === null ? 'n/a' : rate(mutation.killRate);
  return [
    `  mutation:        killed ${mutation.killedMutants}/${mutation.validMutants} ` +
      `valid mutant(s) (kill rate ${killRate}) over ${mutation.probedSamples} probed sample(s)`,
    '                   <== quality SIGNAL, does NOT gate: this denominator includes mutants no',
    '                   testbench can kill. The gate is the coverage-gap line below',
    ...timeoutKillLines(mutation),
    `  calibration:     per problem, ${mutation.nonCompilingMutants} mutant(s) did not build and ` +
      `${mutation.goldenErroredMutants} produced nothing at all; both are OUT of the ` +
      `denominator. The golden testbench is blind to ${mutation.goldenSurvivedMutants} of the ` +
      `valid one(s), which are still IN it`,
    ...goldenTimeoutLines(mutation),
    ...coverageGapLines(mutation),
    ...candidateEquivalentLines(mutation),
    `  mutation cost:   mean ${mutation.meanElapsedMs === null ? 0 : Math.round(mutation.meanElapsedMs)}ms ` +
      `added per probed sample (max ${mutation.maxElapsedMs}ms)`,
  ];
}

/**
 * Render the no-verdict share of the kills, and only when there is one.
 *
 * A timeout counts as a kill - the mutant produced an observable behavioural difference - but it
 * is not demonstrated coverage, so a run whose kills are mostly timeouts must not read as a
 * well-covered one. Printed only when non-zero so a clean arm gains no noise.
 */
function timeoutKillLines(mutation: MutationControlReport): readonly string[] {
  if (mutation.noVerdictKills === 0) {
    return [];
  }
  return [
    `  kills w/o verdict: ${mutation.noVerdictKills}/${mutation.killedMutants} kill(s) came from a ` +
      'timeout or crash, not a reported failure',
    '                   <== weaker evidence of coverage; a timeout-heavy kill rate is suspect',
  ];
}

/**
 * Render how much of the GATE SET rests on the golden testbench HANGING, when any of it does.
 *
 * A mutant the independent judge never terminates on is a kill - it produced an observable
 * behavioural difference - and it is therefore in the set our testbench is REQUIRED to kill. But
 * a hang is not a demonstration that the judge detects that defect class, so a gate built mostly
 * out of hangs is a wall-clock finding an operator must explain before citing the coverage-gap
 * line. Exactly the discipline `kills w/o verdict` applies to our own side, pointed at the judge.
 *
 * Printed only when non-zero, so a corpus slice with no hangs gains no noise.
 */
function goldenTimeoutLines(mutation: MutationControlReport): readonly string[] {
  if (mutation.goldenTimeoutMutants === 0) {
    return [];
  }
  return [
    `  golden hangs:    ${mutation.goldenTimeoutMutants} of the golden kill(s) came from the ` +
      'judge NOT TERMINATING, not from a reported failure',
    '                   <== still gated (the mutant changed observable behaviour) but weaker',
    '                   evidence that the defect class is detectable; explain a hang-heavy gate',
  ];
}

/** Render the coverage-gap tally: survivors the INDEPENDENT judge killed. This is THE gate. */
function coverageGapLines(mutation: MutationControlReport): readonly string[] {
  if (mutation.coverageGapOperators.length === 0) {
    return [
      '  coverage gaps:   none - our testbench killed every mutant the golden judge kills (THE',
      '                   GATE, and it is met)',
    ];
  }
  return [
    `  COVERAGE GAPS:   ${renderOperatorTally(mutation.coverageGapOperators)}`,
    '                   <== THE GATE, and it is NOT met. Each is a defect class the golden',
    '                   testbench catches and ours does not, so each is provably our own gap',
  ];
}

/** Render the candidate-equivalent tally: survivors the independent judge also passed. */
function candidateEquivalentLines(mutation: MutationControlReport): readonly string[] {
  if (mutation.candidateEquivalentOperators.length === 0) {
    return [];
  }
  return [
    `  review-equiv:    ${renderOperatorTally(mutation.candidateEquivalentOperators)}`,
    '                   <== neither testbench killed these, so they MAY be equivalent mutants.',
    '                   Review items, NOT gate failures: nobody has shown they are killable.',
    '                   They still count against the kill rate above, because simulation cannot',
    '                   decide equivalence; read their sites in the per-sample artifacts',
  ];
}

/** One operator tally, most frequent first, elided past the rendering cap (pure). */
function renderOperatorTally(operators: readonly SurvivedOperatorCount[]): string {
  const named = operators.slice(0, MAX_RENDERED_SURVIVED_OPERATORS);
  const elided = operators.length - named.length;
  const rendered = named.map((entry) => `${entry.operator} x${entry.count}`).join('  ');
  return `${rendered}${elided > 0 ? `  (+${elided} more)` : ''}`;
}

/** The label that opens this arm's deferred-cause breakdown; sets the value column. */
const DEFERRED_LABEL = '  deferred why:    ';

/**
 * Render this arm's matrix hole: how many slots were attempted and never measured, and why.
 *
 * PRINTED ABOVE THE ARM'S OWN pass@k LINE, not beside the status tally at the bottom, because
 * it changes how every number under it must be read. Those numbers are not wrong - a deferred
 * slot carries no oracle verdict, so it was never in the pass@k denominator or in any control
 * tally - they simply cover fewer cells than the campaign planned, and that is invisible in a
 * correct number presented on its own.
 *
 * EACH CAUSE CARRIES ITS MEANING, from `describeNoVerdictCause`. `provider-unreachable x29` is
 * a rate limit and `harness-error x29` is our own crash; they need opposite responses, and a
 * bare identifier makes an operator guess which one they are looking at.
 *
 * Printed only when at least one slot was deferred, so a healthy arm gains no noise.
 */
function deferredLines(summary: ArmSummary): readonly string[] {
  if (summary.deferredSamples === 0) {
    return [];
  }
  const continuation = ' '.repeat(DEFERRED_LABEL.length);
  return [
    `  deferred:        ${summary.deferredSamples} of ${summary.sampleCount} recorded sample(s) ` +
      'were ATTEMPTED and NEVER MEASURED',
    '                   <== NOT A COMPLETE ARM: the numbers below are correct over the cells',
    `                   that DID complete, and ${summary.deferredSamples} cell(s) hold an ` +
      'attempt rather than a result',
    ...summary.deferredCauses.map(
      ({ cause, count }, index) =>
        `${index === 0 ? DEFERRED_LABEL : continuation}${cause} x${count} - ` +
        describeNoVerdictCause(cause),
    ),
  ];
}

/** The column every continuation line indents to, matching the `label:` value column above. */
const CONTINUATION_COLUMN = ' '.repeat(19);

/**
 * The fixed note under the GOLDEN line: what the capability number is, and what it is NOT.
 *
 * A constant because it never varies with the numbers. Its whole job is to stop a reader citing
 * the independent judge's pass rate as the `Verified` label, which is the self-graded number
 * printed directly below it.
 */
const GOLDEN_PASS_AT_K_NOTE: readonly string[] = [
  `${CONTINUATION_COLUMN}<== THE CAPABILITY NUMBER: decided by a testbench we did NOT write, so it`,
  `${CONTINUATION_COLUMN}answers whether the flow produced a CORRECT DESIGN. It is NOT the`,
  `${CONTINUATION_COLUMN}\`Verified\` label a student sees - that is the self-graded number below.`,
];

/**
 * The fixed note under the self-graded line: what the instrument-gated number rests on.
 *
 * The counterpart to `GOLDEN_PASS_AT_K_NOTE`, and the reason both are pinned: the two numbers
 * answer two different questions and a reader must never confuse one for the other.
 */
const SELF_GRADED_PASS_AT_K_NOTE: readonly string[] = [
  `${CONTINUATION_COLUMN}<== decided by OUR OWN generated testbench, and admitted only where the`,
  `${CONTINUATION_COLUMN}controls proved that testbench a measuring stick. This is what the`,
  `${CONTINUATION_COLUMN}\`Verified\` label a student sees rests on. It is NOT the capability number.`,
];

/** One named golden-exclusion bucket, as the block renders it. */
interface GoldenExclusionBucket {
  readonly reason: string;
  readonly count: number;
}

/**
 * The golden-exclusion buckets in the order the block names them.
 *
 * Built from the total `GoldenPassAtKReport` partition, so every sample outside the denominator
 * lands under exactly one reason and the buckets sum to the arm's excluded count (Req 2.6).
 */
function goldenExclusionBuckets(report: GoldenPassAtKReport): readonly GoldenExclusionBucket[] {
  return [
    { reason: 'no-candidate', count: report.noCandidateSamples },
    { reason: 'unjudged', count: report.unjudgedSamples },
    { reason: 'did-not-build', count: report.didNotBuildSamples },
    { reason: 'no-output', count: report.noOutputSamples },
    { reason: 'timed-out', count: report.timedOutSamples },
  ];
}

/**
 * Render the count of samples OUTSIDE the golden denominator, naming the reasons that hold at
 * least one (Req 2.7, 2.8, 2.9).
 *
 * The total is printed even at zero, because it plus the denominator size equals the arm's
 * recorded sample count and a reader must be able to see that a small denominator is not a
 * corpus-wide result. Only reasons with at least one sample are named, so a clean arm gains no
 * noise.
 */
function goldenExclusionLines(report: GoldenPassAtKReport): readonly string[] {
  const buckets = goldenExclusionBuckets(report);
  const excluded = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  if (excluded === 0) {
    return [`${CONTINUATION_COLUMN}0 recorded sample(s) are OUTSIDE this denominator`];
  }
  const named = buckets
    .filter((bucket) => bucket.count > 0)
    .map((bucket) => `${bucket.reason} ${bucket.count}`)
    .join('  ');
  return [
    `${CONTINUATION_COLUMN}${excluded} recorded sample(s) are OUTSIDE this denominator:`,
    `${CONTINUATION_COLUMN}${named}`,
  ];
}

/**
 * Render the GOLDEN pass@k block: the CAPABILITY number and everything its denominator excludes.
 *
 * PRINTED FIRST, above the self-graded line, with the exclusion tally INSIDE it, so the
 * denominator can never be read without what it leaves out. The token `GOLDEN` and the naming of
 * the independent judge as the deciding authority are pinned by a test (Req 1.3), because the
 * whole point of a two-number report is that a reader never mistakes one number for the other.
 *
 * `NOT MEASURED` for an empty denominator (Req 1.6), reusing the convention the agreement and
 * control blocks already use rather than printing a `0.000` that would read as a measured total
 * failure. The denominator size is printed beside the value in both cases (Req 1.5).
 */
function goldenPassAtKLines(summary: ArmSummary, ks: readonly number[]): readonly string[] {
  const denominator = summary.goldenReport.judgedSamples;
  const value =
    denominator === 0
      ? 'pass@k: NOT MEASURED'
      : ks.map((k) => `pass@${k}=${rate(summary.goldenPassAtK[k] ?? 0)}`).join('  ');
  return [
    `  GOLDEN ${value}  (over ${denominator} sample(s) judged by the INDEPENDENT golden testbench)`,
    ...GOLDEN_PASS_AT_K_NOTE,
    ...goldenExclusionLines(summary.goldenReport),
    ...instrumentRefusedComparabilityNote(summary),
  ];
}

/**
 * State plainly that this arm's golden pass@k carries no comparability claim, when any of its
 * samples were stopped by an Instrument_Refused outcome (Req 5.12).
 *
 * Scoped to an arm holding at least one Instrument_Refused sample, per Req 5.12's own wording
 * ("WHERE an arm holds at least one Instrument_Refused sample") - not printed unconditionally,
 * because an arm with none did not stop any sample before repair and its golden pass@k is
 * measured exactly the way a prior run's was.
 */
function instrumentRefusedComparabilityNote(summary: ArmSummary): readonly string[] {
  const refused = summary.statusCounts['instrument-refused'] ?? 0;
  if (refused === 0) {
    return [];
  }
  return [
    `${CONTINUATION_COLUMN}${refused} of these sample(s) are Instrument_Refused: judged as a`,
    `${CONTINUATION_COLUMN}FIRST candidate with NO repair iteration. This GOLDEN pass@k is`,
    `${CONTINUATION_COLUMN}reported with NO CLAIM OF COMPARABILITY to a value measured where`,
    `${CONTINUATION_COLUMN}every sample ran the full repair loop.`,
  ];
}

/** The label that opens the could-not-verify cause breakdown; sets the value column. */
const FORMAL_CAUSE_LABEL = '  formal why:      ';

/** The label that opens the Fallback_Reason breakdown; sets the value column. */
const FALLBACK_REASON_LABEL = '  fallback why:    ';

/** The label that opens the Fallback_Route breakdown; sets the value column. */
const FALLBACK_ROUTE_LABEL = '  fallback route:  ';

/**
 * The fixed caveat under the formal verdict line: what a proof is NOT (Req 10.11, 10.12).
 *
 * A constant because it never varies with the numbers, and placed directly under the verdicts
 * the way `GOLDEN_PASS_AT_K_NOTE` sits under its number, because `proved` is the count a reader
 * is most tempted to cite as "this many correct designs". The standing reason is ADR-019's
 * property-strength limit: two `JC_counter` mutants survived a TRUE invariant under UNBOUNDED
 * induction, and a property strong enough to kill them trends toward restating the RTL, so one
 * model writing both can make the two agree and both be wrong.
 */
const FORMAL_CAVEAT_NOTE: readonly string[] = [
  `${CONTINUATION_COLUMN}<== NOT A CORRECTNESS CLAIM. A formal proof of a STATED property`,
  `${CONTINUATION_COLUMN}does not establish correctness on its own: two JC_counter mutants`,
  `${CONTINUATION_COLUMN}survived a TRUE invariant under unbounded induction (ADR-019), and`,
  `${CONTINUATION_COLUMN}Property_Set_Admission does not close the correlated-failure risk of one`,
  `${CONTINUATION_COLUMN}model writing both design and properties: that is layer 3's work, the`,
  `${CONTINUATION_COLUMN}separate differential-consensus spec of ADR-018.`,
];

/**
 * Render a keyed tally, one entry per line under its label (pure).
 *
 * Only the entries the tally kept are rendered, so a breakdown with nothing in it gains no line
 * at all - matching every other conditional breakdown in this file.
 */
function tallyLines(label: string, entries: readonly (readonly [string, number])[]): string[] {
  const continuation = ' '.repeat(label.length);
  return entries.map(
    ([key, count], index) => `${index === 0 ? label : continuation}${key} x${count}`,
  );
}

/** Render a Could_Not_Verify_Cause breakdown under its label (pure). */
function causeLines(label: string, counts: readonly CouldNotVerifyCauseCount[]): readonly string[] {
  return tallyLines(
    label,
    counts.map(({ cause, count }) => [cause, count] as const),
  );
}

/** Render the Fallback_Route breakdown under its label (pure). */
function routeLines(counts: readonly FallbackRouteCount[]): readonly string[] {
  return tallyLines(
    FALLBACK_ROUTE_LABEL,
    counts.map(({ route, count }) => [route, count] as const),
  );
}

/**
 * Render the FORMAL oracle block: the verdicts under their caveat, then why the oracle could not
 * verify, what fell back, what the frontend rejected, and what the admission gate refused
 * (Req 7.10, 8.7, 10.9, 12.17).
 *
 * EVERY VERDICT PRINTS, EVEN AT ZERO, with `none-submitted` beside them, because the four
 * buckets partition the arm and a reader must be able to see that they sum to its recorded
 * sample count. The cause and Fallback_Reason entries are the opposite: only the ones holding a
 * sample print, because a wall of zeros buries the causes that fired. The headline counts below
 * them print at zero too, one spelling each, so they stay greppable across a campaign's
 * summaries whether or not any turned up - the rule `instrument-invalid` already follows. The
 * refused count is the one exception: an arm no gate ran for has no count to print at all, and
 * `propertySetRefusedLines` prints NOT MEASURED there rather than a `0` (Req 9.5, 9.6).
 */
function formalLines(summary: ArmSummary): readonly string[] {
  const { formal } = summary;
  const verdicts = FORMAL_VERDICTS.map((verdict) => `${verdict} ${formal.verdictCounts[verdict]}`);
  return [
    `  formal verdict:  ${verdicts.join('  ')}  none-submitted ${formal.noneSubmittedSamples}  ` +
      `(of ${summary.sampleCount} recorded sample(s))`,
    ...FORMAL_CAVEAT_NOTE,
    ...causeLines(FORMAL_CAUSE_LABEL, formal.causeCounts),
    `  fallback:        ${formal.fallbackSamples} sample(s) decided by the Simulation_Fallback ` +
      'on a recorded Fallback_Reason',
    ...causeLines(FALLBACK_REASON_LABEL, formal.fallbackReasonCounts),
    `  frontend-rejected: ${formal.frontendRejectedSamples} sample(s) whose candidate design the ` +
      'formal frontend rejected',
    ...propertySetRefusedLines(formal.propertySetRefusedSamples),
    // BELOW the three named counts rather than beside the Fallback_Reason rows, because the
    // routes account for ALL of them at once - the cause-decided samples, the refusal, the
    // unexpressed Property_Set, and the samples that never fell back - and sum to the arm.
    ...routeLines(formal.routeCounts),
    ...formalMutantLines(formal),
  ];
}

/**
 * Render the refused-Property_Set count, NOT MEASURED where no sample was gated (Req 9.5, 9.6).
 *
 * `null` is an arm no Property_Set_Gate gated at all, so there is no refusal count; a `0` is a
 * gate that ran and refused nothing. A renderer printing `0` for both would report a clean gate
 * where none ran, which is the distinction `formalMutantLines` already draws just below.
 *
 * THE ROW STAYS BELOW `frontend-rejected:` AND KEEPS ITS PROSE TAIL. `assertRendered` in
 * `app/test/formal-summary-aggregation.property.test.ts` scrapes every `<key> x<n>` line between
 * `fallback:` and `frontend-rejected:` into the Fallback_Reason tally, so an `x<n>`-tailed row
 * moved into that window is read as a reason it is not
 * (`chipAgent/_inbox/gotcha-a-new-tally-row-between-the-fallback-and-frontend-rejected-lines-breaks-property-28s-rendered-scraper.md`).
 */
function propertySetRefusedLines(refusedSamples: number | null): readonly string[] {
  if (refusedSamples === null) {
    return [
      '  property-set-refused: NOT MEASURED - no sample in this arm was gated, so there is no',
      `${CONTINUATION_COLUMN}refused count over them. This is NOT a gate that refused nothing.`,
    ];
  }
  return [
    `  property-set-refused: ${refusedSamples} sample(s), of the samples this arm gated, whose ` +
      'Property_Set was refused as inadmissible',
  ];
}

/**
 * Render the FORMAL mutant tally and its OWN kill rate (Req 9.4, 9.6, 9.11, 9.12).
 *
 * THE EXCLUDED COUNT IS ON THE LINE, beside the killed and survived ones, because it is the
 * number that previously existed nowhere a reader could reach: a mutant the Formal_Oracle could
 * not reason about was counted by the gate and then dropped before the report, so a kill rate of
 * 2/3 and a kill rate of 2/3-with-one-mutant-unseen were indistinguishable. The calibrated total
 * is printed too, so `killed + survived + excluded` can be checked against it on sight.
 *
 * THE DENOMINATOR IS NAMED AND SO IS WHAT IT IS NOT. This rate and the Negative_Control's kill
 * rate a few lines above are over DIFFERENT populations of the same mutant set - one excludes
 * what the formal oracle could not reason about, the other what iverilog could not build - so
 * the block says they are not comparable rather than leaving two bare rates to be averaged.
 *
 * NOT MEASURED, NEVER `0`, in both no-rate cases: an arm no gate ran for carries no tally at all
 * (Req 9.12), and a tally whose denominator is zero has nothing to rate (Req 9.11). A `0` reads
 * as a gate that killed nothing, which is a claim about a gate that ran - the exact distinction
 * `formalKillRateOf` draws by returning `null`, and the one `killRateOf` already draws on the
 * simulation side.
 */
function formalMutantLines(formal: ArmFormalReport): readonly string[] {
  const counts = formal.mutationCounts;
  if (counts === null) {
    return [
      '  formal mutants:  NOT MEASURED - no sample in this arm carries a formal mutant tally, so',
      `${CONTINUATION_COLUMN}there is no excluded count and NO formal kill rate. This is what every`,
      `${CONTINUATION_COLUMN}arm reads until a production Property_Set gate is wired, and it is NOT`,
      `${CONTINUATION_COLUMN}a gate that scored zero.`,
    ];
  }
  const killRate = formal.mutationKillRate;
  return [
    `  formal mutants:  killed ${counts.killedCount}/${counts.denominator} scored  ` +
      `survived ${counts.survivedCount}  excluded ${counts.couldNotVerifyCount}  ` +
      `of ${counts.totalCount} calibrated mutant(s)`,
    `  formal kill rate: ${killRate === null ? 'NOT MEASURED' : rate(killRate)}`,
    `${CONTINUATION_COLUMN}<== ITS OWN DENOMINATOR: the mutants the Formal_Oracle REASONED about.`,
    `${CONTINUATION_COLUMN}The excluded ones are counted and OUT of it. NOT comparable to the`,
    `${CONTINUATION_COLUMN}mutation kill rate above: the two gates exclude different mutants.`,
    ...(killRate === null
      ? [
          `${CONTINUATION_COLUMN}NOT MEASURED rather than 0, because nothing was scorable: a 0 would`,
          `${CONTINUATION_COLUMN}read as a gate that killed nothing where there was nothing to rate.`,
        ]
      : []),
  ];
}

/** Render one arm's block. */
function armLines(summary: ArmSummary, ks: readonly number[]): readonly string[] {
  const passAtKText = ks.map((k) => `pass@${k}=${rate(summary.passAtK[k] ?? 0)}`).join('  ');
  const validity = summary.passAtKValidated
    ? `over ${summary.instrument.countedSamples} instrument-valid sample(s)`
    : 'UNVALIDATED';
  const iterations = summary.meanIterationsToPass;
  return [
    `arm ${summary.armName}  [${summary.modelSignature}]`,
    ...(summary.signatureConflict
      ? ['  WARNING:         this arm name carries more than one model set; do not cite it']
      : []),
    `  samples:         ${summary.sampleCount} over ${summary.problemCount} problems` +
      (summary.deferredSamples > 0
        ? `  (${summary.deferredSamples} DEFERRED: attempted, never measured)`
        : ''),
    ...deferredLines(summary),
    // The GOLDEN block is rendered FIRST, with its exclusion tally inside it, so the capability
    // number is never read without the count of what its denominator leaves out (Req 1.3, 2.7).
    ...goldenPassAtKLines(summary, ks),
    `  ${passAtKText}  (SELF-GRADED, instrument-gated, ${validity})`,
    ...SELF_GRADED_PASS_AT_K_NOTE,
    `  verified:        ${summary.verifiedSamples}  ` +
      `first-try ${summary.firstTrySamples} (${rate(summary.firstTryRate)})  ` +
      `repaired ${summary.repairedSamples} (${rate(summary.repairedRate)})`,
    `  mean iters/pass: ${iterations === null ? 'n/a (no pass)' : iterations.toFixed(CENT_DIGITS)}`,
    ...efficiencyLines(summary),
    ...costLines(summary),
    ...agreementLines(summary),
    ...instrumentLines(summary),
    ...mutationLines(summary),
    ...formalLines(summary),
    `  statuses:        ${renderStatuses(summary)}`,
    ...noVerdictLines(summary),
  ];
}

/** Render the per-status tally in a stable order. */
function renderStatuses(summary: ArmSummary): string {
  const entries = Object.entries(summary.statusCounts).sort(([left], [right]) =>
    compareText(left, right),
  );
  return entries.length === 0 ? 'none' : entries.map(([status, n]) => `${status}=${n}`).join(' ');
}

/** The label that opens the no-verdict reason breakdown; sets the value column. */
const NO_VERDICT_LABEL = '  no-verdict why:  ';

/**
 * Render why the no-verdict samples produced no verdict, one reason per line.
 *
 * Printed only when a reason is actually known, so a clean arm gains no noise and an arm
 * whose notes are all `null` is not made to look explained.
 */
function noVerdictLines(summary: ArmSummary): readonly string[] {
  const continuation = ' '.repeat(NO_VERDICT_LABEL.length);
  return summary.noVerdictNotes.map(
    ({ note, count }, index) => `${index === 0 ? NO_VERDICT_LABEL : continuation}${note} x${count}`,
  );
}

/**
 * Announce the run's matrix hole FIRST - above the totals and above every arm.
 *
 * THE POSITION IS THE WHOLE POINT. This is the one defect this file reports that is not a
 * wrong number: every figure below is correct and covers fewer cells than the campaign
 * planned. Measured on `.eval-runs/instrument-calibration` - 24 healthy samples, then 29
 * consecutive provider failures from one rate-limit burst, then recovery - the run reported
 * itself `completed` with two thirds of its cells empty, and no line of the summary said so.
 * An operator who reads only the top of the file must still learn it.
 *
 * The CAUSES stay on the arms. A roll-up here would total two arms' outages into one number
 * and hide which arm went dark, which is the first thing to know when only one did.
 *
 * Printed only when at least one slot was deferred, so a complete matrix gains no noise.
 */
function deferredBannerLines(summary: SweepSummary): readonly string[] {
  if (summary.deferredSamples === 0) {
    return [];
  }
  return [
    `DEFERRED: ${summary.deferredSamples} slot(s) were ATTEMPTED and NEVER MEASURED`,
    '  <== THIS IS NOT A COMPLETE MATRIX. Every number below is correct over the cells that DID',
    '  complete, and there are fewer of them than the campaign planned, so no arm here may be',
    '  cited as covering its problem set. The arithmetic is not in question: a deferred slot',
    '  carries no oracle verdict, so it was never inside pass@k or any control tally - the CELLS',
    '  are what is missing. Re-run the same config to fill them; a deferred slot is left out of',
    '  the resume index, so it is taken again instead of counted as already recorded.',
  ];
}

/** The literal tag on every line that sets another run's figure beside this run's (Req 8.10). */
export const CROSS_RUN_TAG = '[cross-run]';

/**
 * The Confirmatory_Run's Control_Arm Coverage_Gap_Survivors over its Scored_Mutants (Req 8.9).
 * Recounted from `.eval-runs/grounding-confirmatory-v1/results.jsonl`, last record per slot.
 */
export const CONFIRMATORY_CONTROL_COVERAGE_GAP = Object.freeze({ survivors: 171, scored: 2249 });

/** What the reportability block needs beyond the records themselves. */
export interface ReportabilityContext {
  /** Every arm the config declares; an arm with no records still renders a 0/0 row (Req 8.8). */
  readonly declaredArms: readonly string[];
  /** The committed Pinned_Baseline total, or null when none was supplied to this summary. */
  readonly baseline: Pick<ArmReportabilityReport, 'withReport' | 'sources'> | null;
}

/** A numerator over its denominator, as one rendered table cell pair. */
interface Fraction {
  readonly numerator: number;
  readonly denominator: number;
}

/** The column widths after the label column, in render order. */
const REPORTABILITY_COLUMNS = [19, 11, 22] as const;

/** Render `n/d` and its rate; a zero denominator is `undefined`, never a zero rate (Req 8.11). */
function fractionCells(fraction: Fraction | null): readonly string[] {
  if (fraction === null) {
    return ['', ''];
  }
  const { numerator, denominator } = fraction;
  return [
    `${numerator}/${denominator}`,
    denominator === 0 ? 'undefined' : rate(numerator / denominator),
  ];
}

/** One table row: the label, then the valueless pair beside the coverage-gap pair. */
function reportabilityRow(label: string, labelWidth: number, cells: readonly string[]): string {
  const padded = cells.map((cell, index) => cell.padEnd(REPORTABILITY_COLUMNS[index] ?? 0));
  return `  ${label.padEnd(labelWidth)}${padded.join('')}`.trimEnd();
}

/** The cells of a row holding the valueless pair, the coverage-gap pair, or both. */
function pairCells(valueless: Fraction | null, gap: Fraction | null): readonly string[] {
  return [...fractionCells(valueless), ...fractionCells(gap)];
}

/** One arm's two fractions, zero over zero when the arm recorded nothing. */
function armFractions(arm: ArmSummary | undefined): readonly [Fraction, Fraction] {
  return [
    { numerator: arm?.reportability.withReport ?? 0, denominator: arm?.reportability.sources ?? 0 },
    {
      numerator: arm?.mutation.coverageGapSurvivors ?? 0,
      denominator: arm?.mutation.validMutants ?? 0,
    },
  ];
}

/**
 * Render both rates side by side, one row per declared arm, a run total, and the two cross-run
 * rows. Undeclared arms that recorded samples still get a row, so the total is the rows' sum.
 */
function reportabilityLines(summary: SweepSummary, context: ReportabilityContext): string[] {
  const byName = new Map(summary.arms.map((arm) => [arm.armName, arm]));
  const names = [...new Set([...context.declaredArms, ...byName.keys()])];
  if (names.length === 0) {
    return [];
  }
  const rows = names.map((name) => [name, ...armFractions(byName.get(name))] as const);
  const sum = (pick: (row: (typeof rows)[number]) => Fraction): Fraction => ({
    numerator: rows.reduce((total, row) => total + pick(row).numerator, 0),
    denominator: rows.reduce((total, row) => total + pick(row).denominator, 0),
  });
  const baselineLabel = `Pinned_Baseline ${CROSS_RUN_TAG}`;
  const confirmatoryLabel = `Confirmatory control ${CROSS_RUN_TAG}`;
  const width = Math.max(...names.map((name) => name.length), confirmatoryLabel.length) + 2;
  const { survivors, scored } = CONFIRMATORY_CONTROL_COVERAGE_GAP;
  const { baseline } = context;
  return [
    '',
    'reportability (Valueless_Report_Rate beside Coverage_Gap_Survivor_Rate, per declared arm)',
    reportabilityRow('arm', width, ['valueless/sources', 'rate', 'gap-survivors/scored', 'rate']),
    ...rows.map(([name, valueless, gap]) =>
      reportabilityRow(name, width, pairCells(valueless, gap)),
    ),
    reportabilityRow(
      'run total',
      width,
      pairCells(
        sum((row) => row[1]),
        sum((row) => row[2]),
      ),
    ),
    baseline === null
      ? reportabilityRow(baselineLabel, width, ['unavailable: no Pinned_Baseline was supplied'])
      : reportabilityRow(
          baselineLabel,
          width,
          pairCells({ numerator: baseline.withReport, denominator: baseline.sources }, null),
        ),
    reportabilityRow(
      confirmatoryLabel,
      width,
      pairCells(null, { numerator: survivors, denominator: scored }),
    ),
  ];
}

/**
 * Render the summary as plain text lines.
 *
 * Plain text on purpose: it is written next to the results file, printed to stdout, and
 * pasted into a report, and it must be readable in all three without a renderer. Without a
 * `context`, the declared arms are the ones recorded and no Pinned_Baseline is shown.
 */
export function renderSummary(
  summary: SweepSummary,
  context: ReportabilityContext = {
    declaredArms: summary.arms.map((arm) => arm.armName),
    baseline: null,
  },
): readonly string[] {
  const title = `eval sweep summary  (config ${summary.configHash ?? 'unfiltered'})`;
  if (summary.refusedStaleSchema) {
    return [
      title,
      `REFUSED: ${summary.staleSchemaLines} results line(s) use an older record schema`,
      ...STALE_SCHEMA_ADVICE.map((line) => `  ${line}`),
    ];
  }
  const header = [
    title,
    // Above `samples aggregated`, because that total is exactly the number a reader would
    // otherwise take for the size of the matrix.
    ...deferredBannerLines(summary),
    `samples aggregated: ${summary.totalSamples}`,
    // Beside the total, not in an arm block: a re-dispatched file has to state how many of
    // its records the oracle never judged. `0` and not NOT MEASURED, because this count is
    // taken whenever anything was aggregated - there is no population it cannot be read over.
    `no oracle verdict: ${summary.noVerdictSamples} of those ${summary.totalSamples} record(s)`,
    ...(summary.malformedLines > 0
      ? [`WARNING: ${summary.malformedLines} results line(s) could not be decoded and were skipped`]
      : []),
  ];
  if (summary.arms.length === 0) {
    return [
      ...header,
      'no samples recorded for this configuration yet',
      ...reportabilityLines(summary, context),
    ];
  }
  return [
    ...header,
    ...summary.arms.flatMap((arm) => ['', ...armLines(arm, summary.ks)]),
    ...reportabilityLines(summary, context),
  ];
}
