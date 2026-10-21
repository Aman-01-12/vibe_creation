// The NEGATIVE CONTROL's vocabulary: what a mutant is, which mutants count, and when a
// testbench has earned the right to be called a measuring stick.
//
// THE MEASURED DEFECT THIS EXISTS FOR
//   `smoke-v4-oracle` recorded `MISSED BUGS: 1`. On `rtllm/arithmetic/multi_pipe_8bit` our
//   generated testbench PASSED a candidate that RTLLM's independent golden testbench FAILS
//   (100/100 failures). Its monitor detected the disagreement - it printed roughly fourteen
//   `Time N: mul_out mismatch, expected X, got Y` lines - and then signalled:
//
//     CHECK ac1_under_simulation_multi_pipe_8bit_produce PASS
//
//   The mismatch never reached an error flag that the CHECK status reads, so THE SIGNAL
//   ITSELF SAYS PASS. No reader fix and no parser fix can catch that (see
//   [[gotcha-oracle-check-reader-fixed-unreadable-signals-now-force-non-pass]]): the oracle
//   is being told, correctly, that the check passed. This is the exact shape that ships a
//   false `Verified`.
//
// WHY THE POSITIVE CONTROL CANNOT CATCH IT
//   `./instrument-control.ts` runs our testbench against the benchmark's known-good
//   reference design and requires a pass. That falsifies a testbench that passes NOTHING. It
//   is structurally incapable of falsifying a testbench that passes EVERYTHING - and the
//   multi_pipe_8bit testbench passed its reference too, which is why it read `valid`.
//
// THE STANDARD
//   A testbench is a valid instrument only if it BOTH passes the reference design AND fails
//   deliberately broken versions of it. So the reference RTL is mutated - one small,
//   deliberate defect at a time - and our testbench is required to kill every mutant an
//   INDEPENDENT judge has already demonstrated is killable.
//
// THE GATE IS ZERO COVERAGE GAPS, AND THE KILL RATE ONLY INFORMS
//   Validity is decided by `judgeCoverageGaps`: our testbench must kill every valid mutant
//   RTLLM's independent golden testbench kills. One survivor in that set is unambiguously OUR
//   defect, because a third party has proven the bug is catchable at the ports.
//
//   The kill rate over every valid mutant is still computed, still persisted, and still
//   reported - as a QUALITY SIGNAL, never as the gate. It used to be the gate, at a 0.95 bar,
//   and that was measurably wrong in the unsound direction. On
//   `rtllm/arithmetic/multi_pipe_8bit` (6 mutants, all compiling) a demonstrably GOOD testbench
//   - one that kills two mutants the golden judge itself misses - scores 4/6 = 0.667, because
//   the two it survives are `RESET_BRANCH_DISABLED` mutants and at least one of those is very
//   likely a TRUE equivalent, unobservable at the ports. The rate gate called that instrument
//   INVALID. A rate bar therefore holds us to killing mutants that may be unkillable in
//   principle, which is the same unsoundness as excluding mutants on an undecidable equivalence
//   claim - just pointed the other way.
//
//   The zero-coverage-gap gate cannot make that mistake: a genuine equivalent can never enter
//   the requirement, because the golden judge did not kill it either.
//
// THE EQUIVALENT-MUTANT PROBLEM, AND WHY NOTHING MAY BE AUTO-EXCLUDED
//   Not every mutant is a bug. A mutant that is functionally identical to the original
//   cannot be killed by ANY testbench. But EQUIVALENCE IS NOT DECIDABLE BY SIMULATION: the
//   only evidence a simulation run yields is "this stimulus did not distinguish them",
//   which is a statement about the stimulus, not about the designs.
//
//   This layer used to treat a mutant that RTLLM's golden testbench PASSES as equivalent
//   and drop it from the denominator. That was unsound, and it was unsound in the one
//   direction that matters: it excused our testbench for exactly the bugs the golden judge
//   is blind to. We have measured that blindness - `rtllm/memory/right_shifter`'s golden
//   testbench drives 8+ shifts and then checks only the final value, so it structurally
//   cannot detect the missing `initial q = 0` that RTLLM's own spec requires - and that same
//   population, bugs the golden judge misses, is what produces the `MISSED BUGS` cell this
//   whole seam exists to close. GateTruth (arXiv 2608.12635) names an unsound
//   equivalent-mutant exclusion mechanism as one of three causes of its own incorrect
//   published results: mutants it excluded as unobservable turned out not to be equivalent.
//
//   So the KILL-RATE DENOMINATOR IS EVERY VALID MUTANT - every mutant that compiles. That
//   INCLUDES a mutant the golden testbench never terminates on: it compiled, and its failure to
//   terminate is itself an observable behavioural difference, so it is a golden KILL
//   (`golden-timeout`) rather than a discard. What leaves the denominator is a mutant that did not
//   BUILD (`non-compiling`) or whose run produced nothing at all (`golden-errored`) - two states,
//   not one, because calling a crash a build failure attributes our fault to the corpus. Both are
//   counted. The golden testbench still runs against every mutant, but its verdict now
//   CLASSIFIES our own survivors (see `MutationProbeReport`): golden-killed survivors are a
//   definite coverage gap and are what the GATE reads, golden-survived survivors are
//   candidate-equivalent and are reported for review only. Neither is auto-excluded from the
//   rate, because simulation cannot decide equivalence and the rate is not a verdict.
//
// WHAT THIS LAYER MAY NEVER DO
//   Exactly the constraints the positive control already lives under: deterministic, no
//   model call, no student-session budget, no extra sample and no extra iteration. It cannot
//   change the loop's oracle verdict and it cannot change the golden verdict. It decides
//   whether a sample's verdict is ADMISSIBLE, which is a decision about the instrument.
//
// WHY THE VOCABULARY LIVES HERE AND NOT IN `./corpus/`
//   The operator names describe HDL constructs, because HDL is the only material this
//   harness mutates. They nonetheless belong at the eval root, because the persisted record,
//   the run report, and the sweep summary all read them and none of those may depend on the
//   RTLLM adapter. The Verilog TEXT transforms - the part that is genuinely benchmark- and
//   language-specific - live in `./corpus/verilog-mutation.ts`.
//
// Pure: no clock, no I/O, no randomness.

import type { ResourceLimits } from '@app/tools';

// RELOCATED TO `@app/tools/mutation/operators.ts` (task 4.1), imported here and re-exported
// below BY BINDING: `MutationOperatorId`, `MUTATION_OPERATORS`, `MAX_SITE_TEXT_CHARS`,
// `MutationSite`, `Mutant`, `MutantIdentity`, `mutantIdOf`, `identityOf`, `mutantRunLimits`,
// `MutationProbeReport`, `reportedFailureKills`, `killRateOf`, and `allSurvivors`.
// `MutationProbeReport` and `reportedFailureKills` moved too, even though the design's
// relocation list omitted them: `killRateOf` and `allSurvivors` both read a
// `MutationProbeReport`, so neither function could relocate without the type it reads.
import {
  allSurvivors,
  DEFAULT_MUTANT_WALL_MS,
  generateMutants,
  identityOf,
  killRateOf,
  MAX_MUTANT_WALL_MS,
  MAX_MUTATED_SOURCE_CHARS,
  MAX_SITE_TEXT_CHARS,
  MIN_MUTANT_WALL_MS,
  type Mutant,
  type MutantIdentity,
  mutantIdOf,
  mutantRunLimits,
  type MutationConfig,
  MUTATION_OPERATORS,
  type MutationOperatorId,
  type MutationProbeReport,
  type MutationSite,
  reportedFailureKills,
} from '@app/tools';

// Re-exported BY BINDING, not reimplemented, so every existing `./mutation-control.js` call
// site resolves to the exact same function/const/type `@app/tools` exports.
export {
  allSurvivors,
  DEFAULT_MUTANT_WALL_MS,
  generateMutants,
  identityOf,
  killRateOf,
  MAX_MUTANT_WALL_MS,
  MAX_MUTATED_SOURCE_CHARS,
  MAX_SITE_TEXT_CHARS,
  MIN_MUTANT_WALL_MS,
  type MutationConfig,
  type Mutant,
  type MutantIdentity,
  mutantIdOf,
  mutantRunLimits,
  MUTATION_OPERATORS,
  type MutationOperatorId,
  type MutationProbeReport,
  type MutationSite,
  reportedFailureKills,
};

/**
 * How the INDEPENDENT golden testbench judged one mutant.
 *
 * This is the calibration, and our own testbench never appears in it. What it decides is
 * narrower than it used to be: it no longer decides WHICH mutants count, only how a mutant
 * OUR testbench failed to kill is reported. The first two members are both VALID mutants and
 * both sit in the denominator; only `non-compiling` leaves it.
 */
export type MutantCalibration =
  /** The golden testbench REPORTED a failure: a bug an independent judge demonstrably catches. */
  | 'golden-killed'
  /**
   * The golden testbench never TERMINATED on it: a kill, on weaker evidence, counted apart.
   *
   * A VALID mutant, and one the gate reads. The reference design plus its own golden testbench
   * completes in a couple of hundred milliseconds; a mutant that instead runs until the wall
   * clock kills it has produced an observable behavioural difference, which is the same rule
   * Stryker's mutant states apply to an infinite-loop mutant
   * (https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/).
   * It is also the rule this layer ALREADY applies to our own testbench through
   * `MutantKillKind: 'no-verdict'`, so calibration reading the same evidence differently would
   * be two rules for one fact.
   *
   * Distinct from `golden-killed` for exactly the reason `no-verdict` is distinct from
   * `reported-failure`: a hang is weaker evidence than a reported failure, so a corpus whose
   * judge mostly HANGS must not read as a judge that mostly DETECTS. Measured, not
   * hypothetical - RTLLM's golden testbenches commonly spin on a design signal
   * (`while (mul_en_out == 0)`), so a mutant that breaks that signal never reaches `$finish`.
   */
  | 'golden-timeout'
  /** The golden testbench PASSES it: candidate-equivalent, never assumed equivalent. */
  | 'golden-survived'
  /**
   * It did not BUILD: no verdict, and the toolchain wrote diagnostics instead.
   *
   * Not a usable mutant, so it leaves the denominator - counted, never silently dropped.
   */
  | 'non-compiling'
  /**
   * It produced no verdict, no diagnostics, and no timeout: a crash or an empty capture.
   *
   * Its own member rather than folded into `non-compiling`, because it did not fail to build
   * and saying that it did would misattribute an infrastructure fault to the mutant. Out of the
   * denominator, on the fail-safe side: nothing was measured, so nothing may be claimed.
   */
  | 'golden-errored';

/**
 * Whether a calibration verdict admits its mutant to the VALID set (the denominator).
 *
 * A total `Record` rather than a comparison chain, so a sixth calibration state added later is
 * a COMPILE ERROR here instead of silently defaulting into - or out of - the denominator. Both
 * default directions would be wrong: admitting an unmeasured mutant flatters nothing but
 * corrupts the rate, and excluding a measured one shrinks the gate set.
 */
const CALIBRATION_ADMITS_TO_DENOMINATOR: Readonly<Record<MutantCalibration, boolean>> =
  Object.freeze({
    'golden-killed': true,
    'golden-timeout': true,
    'golden-survived': true,
    'non-compiling': false,
    'golden-errored': false,
  });

/** Whether a calibrated mutant is VALID, so it sits in the kill-rate denominator (pure). */
export function mutantIsValid(calibration: MutantCalibration): boolean {
  return CALIBRATION_ADMITS_TO_DENOMINATOR[calibration];
}

/**
 * Whether the INDEPENDENT judge killed a calibrated mutant, by either kind of kill (pure).
 *
 * This is the GATE's scope: our testbench must kill every valid mutant the judge killed. A
 * timeout counts, deliberately - it ENLARGES the gate set, which is the intended consequence of
 * treating a non-terminating mutant as a detected one.
 */
export function mutantWasGoldenKilled(calibration: MutantCalibration): boolean {
  return calibration === 'golden-killed' || calibration === 'golden-timeout';
}

/**
 * How our testbench refused to certify a mutant; a closed set, because the two differ in
 * evidential weight.
 *
 * Both are KILLS - the Verification_Loop cannot mint `Verified` from either - but they are
 * counted apart so a suspiciously timeout-heavy result stays visible instead of reading as
 * coverage. This matches established practice: Stryker's mutant states count a mutant that
 * causes an infinite loop as detected
 * (https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/).
 */
export type MutantKillKind =
  /** Our testbench built, ran, and signalled a failing check: it DETECTED the defect. */
  | 'reported-failure'
  /**
   * Our testbench produced no verdict at all - a timeout, a crash, or an empty capture.
   *
   * A kill because the mutant produced an observable behavioural difference: the same
   * testbench reaches a verdict on the reference design, which the positive control has
   * already proven for every sample that gets this far.
   */
  | 'no-verdict';

/** Default cap on mutants per problem; the wall-clock knob (mutants x simulations). */
export const DEFAULT_MAX_MUTANTS_PER_PROBLEM = 24;

/** Hard ceiling on the cap, so a config cannot ask for an unbounded campaign. */
export const MAX_MUTANTS_PER_PROBLEM_LIMIT = 200;

/** The default mutation configuration: every operator, the default cap. */
export const DEFAULT_MUTATION_CONFIG: MutationConfig = Object.freeze({
  maxMutantsPerProblem: DEFAULT_MAX_MUTANTS_PER_PROBLEM,
  operators: MUTATION_OPERATORS,
});

/**
 * The canonical text of a mutation config, for the cache key (pure, deterministic).
 *
 * Operators are emitted in `MUTATION_OPERATORS` order rather than in the order the config
 * happens to list them, so two configs naming the same operators hash the same. The cap is
 * included because it changes which mutants survive the round-robin selection.
 */
export function canonicalMutationConfig(config: MutationConfig): string {
  const named = new Set(config.operators);
  const ordered = MUTATION_OPERATORS.filter((operator) => named.has(operator));
  return JSON.stringify({ maxMutantsPerProblem: config.maxMutantsPerProblem, operators: ordered });
}

/**
 * What the ZERO-COVERAGE-GAP gate makes of one probe; a closed set (pure, total).
 *
 * THE SINGLE OWNER of the validity rule the negative control contributes. Stated as a closed
 * union rather than a boolean because two of the four outcomes are NOT verdicts at all: they are
 * the degenerate cases where the gate has nothing to say, and a boolean would have to spell one
 * of them `false` (an accusation) or `true` (a vacuous pass). Both would be a lie.
 *
 * The order of the guards is the whole correctness argument, so it is stated:
 *
 *   1. `no-valid-mutants` FIRST. With nothing compiling there is no coverage gap by
 *      construction, so every later check passes vacuously.
 *   2. `no-golden-killed-mutants` SECOND, for the same reason one level in. If the independent
 *      judge killed nothing, the requirement "kill everything the judge kills" is empty, so an
 *      instrument that killed nothing at all would clear it. That is exactly the vacuity trap
 *      the old golden-detectable denominator fell into, and it must read as unproven.
 *   3. Only then does an empty coverage-gap list mean something: our testbench killed every
 *      mutant a third party demonstrated is killable.
 */
export type CoverageGapVerdict =
  /** Every mutant the independent judge kills, ours kills too: the gate is met. */
  | 'closed'
  /** At least one mutant the judge kills survived ours: a proven defect in our testbench. */
  | 'open'
  /** Nothing compiled, so there was nothing to kill and killing nothing proves nothing. */
  | 'no-valid-mutants'
  /**
   * The judge killed no valid mutant, so nothing was proven catchable and the gate is VACUOUS.
   *
   * Measured on this corpus, not hypothetical: `rtllm/memory/right_shifter`'s golden testbench
   * drives 8+ shifts and checks only the final value, so it is blind to defect classes RTLLM's
   * own spec requires. A problem where it is blind to ALL of them cannot speak for our
   * instrument either way, so this must never read as `valid`.
   */
  | 'no-golden-killed-mutants';

/** Apply the zero-coverage-gap gate to one probe report (pure, total). */
export function judgeCoverageGaps(report: MutationProbeReport): CoverageGapVerdict {
  if (report.validCount === 0) {
    return 'no-valid-mutants';
  }
  if (report.goldenKilledCount === 0) {
    return 'no-golden-killed-mutants';
  }
  return report.coverageGapSurvivors.length === 0 ? 'closed' : 'open';
}

/** Why the negative control could not speak; a closed set, so it is never vague. */
export type MutationUnavailableReason =
  /** No reference design is held for this problem, so nothing can be mutated. */
  | 'no-reference'
  /** The reference yielded no mutants: no operator found a site it could fire on. */
  | 'no-mutants-generated'
  /**
   * Calibration found NO mutant that compiles, so there is nothing to kill.
   *
   * The degenerate case, kept explicit: with an empty valid set "our testbench killed every
   * valid mutant" is vacuously true, so it must read as `unchecked` and never as `valid`.
   */
  | 'no-valid-mutants'
  /** The probe threw or could not run; fail-safe, never a verdict. */
  | 'probe-errored';

/**
 * What one probe produced: a measurement, or the reason there is none.
 *
 * A discriminated union rather than a nullable report, so "unavailable with no reason" and
 * "measured with no counts" are not representable.
 */
export type MutationProbeOutcome =
  | { readonly kind: 'measured'; readonly report: MutationProbeReport }
  | { readonly kind: 'unavailable'; readonly reason: MutationUnavailableReason };

/** One negative-control request: which problem, and the testbench under test. */
export interface MutationProbeRequest {
  readonly problemId: string;
  /** OUR generated testbench - the instrument under test, exactly as the oracle ran it. */
  readonly testbench: string;
  /** The same sandbox caps the loop's own oracle and the golden judge ran under. */
  readonly limits: ResourceLimits;
  /** The Required_Check names a Watchdog stop fails, so a hung mutant run is `killed` (Req 5.7). */
  readonly requiredCheckNames: readonly string[];
}

/**
 * The negative-control port.
 *
 * Implementations must be TOTAL: never throw, and never return a measurement they did not
 * make. Every path that cannot produce one returns `unavailable` with its reason, which can
 * only ever move a sample OUT of the pass@k denominator - the fail-safe direction.
 */
export interface MutationNegativeControl {
  probe(request: MutationProbeRequest): Promise<MutationProbeOutcome>;
}

/** The operator-facing sentence for one unavailable reason; single owner of this wording. */
export function describeMutationUnavailable(reason: MutationUnavailableReason): string {
  return MUTATION_UNAVAILABLE_DESCRIPTIONS[reason];
}

/** Why a probe could not speak, in operator-facing words. */
const MUTATION_UNAVAILABLE_DESCRIPTIONS: Readonly<Record<MutationUnavailableReason, string>> =
  Object.freeze({
    'no-reference': 'no reference design is available to mutate for this problem',
    'no-mutants-generated': 'no mutation operator found a site in the reference design',
    'no-valid-mutants':
      'not one generated mutant compiled, so there was nothing for our testbench to kill and ' +
      'killing nothing proves nothing',
    'probe-errored': 'the negative control could not run, so the instrument stays unproven',
  });

/** One sample's mutation facts as the aggregation reads them. */
export interface MutationSample {
  readonly problemId: string;
  /** The probe's counts, or `null` when this sample was never probed. */
  readonly probe: MutationSampleCounts | null;
}

/**
 * The persisted per-sample mutation counts.
 *
 * A narrower shape than `MutationProbeReport`: the summary is computed from the results file,
 * which records the survivors as OPERATOR IDS only (a closed set) and leaves the sites to the
 * per-sample artifacts. That split keeps the record free of source excerpts while still
 * letting a campaign tally its most-survived operators.
 *
 * The two survivor buckets are persisted SEPARATELY rather than merged and re-split later,
 * because the split is a golden-testbench fact that the results file is the only record of:
 * merged, a campaign could no longer tell a definite coverage gap from a candidate-equivalent
 * mutant, and those two are different work items.
 */
export interface MutationSampleCounts {
  /** Mutants that compiled: the denominator this sample's kill count is a fraction of. */
  readonly validCount: number;
  readonly killedCount: number;
  /** Kills where our testbench produced no verdict; a subset of `killedCount`. */
  readonly noVerdictKills: number;
  /** Operators whose survivors the INDEPENDENT judge killed: definite coverage gaps. */
  readonly coverageGapOperators: readonly MutationOperatorId[];
  /** Operators whose survivors the independent judge also passed: candidate-equivalent. */
  readonly candidateEquivalentOperators: readonly MutationOperatorId[];
  /** Valid mutants the golden testbench did NOT kill; a per-PROBLEM calibration fact. */
  readonly goldenSurvivedCount: number;
  /** Golden kills that were HANGS rather than reported failures; a per-PROBLEM fact. */
  readonly goldenTimeoutCount: number;
  /** Mutants that did not BUILD; a per-PROBLEM calibration fact. */
  readonly nonCompilingCount: number;
  /** Mutants whose golden run crashed or captured nothing; a per-PROBLEM calibration fact. */
  readonly goldenErroredCount: number;
  readonly elapsedMs: number;
}

/**
 * Project one probe report onto the persisted per-sample counts (pure, total).
 *
 * THE SINGLE OWNER of this projection. Two callers persist it - the sweep's results record and
 * the harness's own in-memory aggregation - and both are required to tally the same thing, so
 * one implementation is the only way they cannot drift. `null` in, `null` out: a sample that was
 * never probed carries no mutation evidence.
 *
 * Survivors are reduced to their OPERATOR IDS here, which is the closed-set part of the finding
 * and all a campaign tally needs. The line, column, and source excerpt stay in the per-sample
 * artifacts, which is where source-bearing text already belongs.
 */
export function recordedMutationCounts(
  probe: MutationProbeReport | null,
): MutationSampleCounts | null {
  if (probe === null) {
    return null;
  }
  return {
    validCount: probe.validCount,
    killedCount: probe.killedCount,
    noVerdictKills: probe.noVerdictKills,
    coverageGapOperators: probe.coverageGapSurvivors.map((survivor) => survivor.operator),
    candidateEquivalentOperators: probe.candidateEquivalentSurvivors.map(
      (survivor) => survivor.operator,
    ),
    goldenSurvivedCount: Math.max(0, probe.validCount - probe.goldenKilledCount),
    goldenTimeoutCount: probe.goldenTimeoutCount,
    nonCompilingCount: probe.nonCompilingCount,
    goldenErroredCount: probe.goldenErroredCount,
    elapsedMs: probe.elapsedMs,
  };
}

/** One operator and how many mutants it produced that our testbenches did not kill. */
export interface SurvivedOperatorCount {
  readonly operator: MutationOperatorId;
  readonly count: number;
}

/** What the negative control established across a run. */
export interface MutationControlReport {
  /** Samples the negative control actually probed. */
  readonly probedSamples: number;
  /** VALID mutants summed over probed samples: the denominator of `killRate`. */
  readonly validMutants: number;
  /** Valid mutants our testbenches killed, summed over probed samples. */
  readonly killedMutants: number;
  /** Kills that came from an absent verdict rather than a failing check; a subset. */
  readonly noVerdictKills: number;
  /** `killedMutants / validMutants`, or `null` when nothing was valid. */
  readonly killRate: number | null;
  /**
   * Valid mutants the golden testbench did not kill, counted ONCE PER PROBLEM.
   *
   * Calibration is a property of (reference, golden testbench, mutation config) and is
   * computed once per problem, so summing it over samples would multiply it by the sample
   * count and report a corpus fact as if it were a per-sample one.
   *
   * This is the measure of the INDEPENDENT JUDGE's own blindness, and it is reported for that
   * reason: it is no longer an exclusion, so a large number here does not shrink our
   * denominator - it tells an operator how much of the corpus the golden judge cannot speak
   * for at all.
   */
  readonly goldenSurvivedMutants: number;
  /**
   * Golden kills that were HANGS, counted ONCE PER PROBLEM, for the same reason.
   *
   * The honesty counterpart of `goldenSurvivedMutants`: it says how much of the GATE SET rests
   * on the judge failing to terminate rather than on it detecting anything. A campaign where
   * this dominates has a wall-clock finding to explain before its coverage-gap numbers may be
   * cited.
   */
  readonly goldenTimeoutMutants: number;
  /** Mutants that did not BUILD, counted ONCE PER PROBLEM, for the same reason. */
  readonly nonCompilingMutants: number;
  /** Mutants whose golden run crashed or captured nothing, counted ONCE PER PROBLEM. */
  readonly goldenErroredMutants: number;
  /**
   * Operators whose survivors the INDEPENDENT judge killed, most frequent first.
   *
   * The single most actionable signal in the whole run: each entry is a defect class the
   * independent judge has demonstrated is catchable and ours does not catch.
   */
  readonly coverageGapOperators: readonly SurvivedOperatorCount[];
  /**
   * Operators whose survivors the independent judge also passed, most frequent first.
   *
   * Candidate-equivalent, flagged for review rather than excluded: simulation cannot decide
   * equivalence, so these still count against the kill rate.
   */
  readonly candidateEquivalentOperators: readonly SurvivedOperatorCount[];
  /** Mutants the INDEPENDENT golden testbench killed and ours did not, summed over probes. */
  readonly coverageGapSurvivors: number;
  /** `coverageGapSurvivors / validMutants`, or `null` when nothing was valid (Req 8.11). */
  readonly coverageGapSurvivorRate: number | null;
  /** Mean wall clock the probe added per probed sample, in milliseconds. */
  readonly meanElapsedMs: number | null;
  /** The largest single probe's wall clock, in milliseconds. */
  readonly maxElapsedMs: number;
}

/** The empty report, for a run where the negative control never spoke. */
export const NO_MUTATION_CONTROL_MEASURED: MutationControlReport = Object.freeze({
  probedSamples: 0,
  validMutants: 0,
  killedMutants: 0,
  noVerdictKills: 0,
  killRate: null,
  goldenSurvivedMutants: 0,
  goldenTimeoutMutants: 0,
  nonCompilingMutants: 0,
  goldenErroredMutants: 0,
  coverageGapOperators: Object.freeze([]),
  candidateEquivalentOperators: Object.freeze([]),
  coverageGapSurvivors: 0,
  coverageGapSurvivorRate: null,
  meanElapsedMs: null,
  maxElapsedMs: 0,
});

/**
 * Whether the negative control probed at least one sample.
 *
 * `false` means the mutation numbers are NOT MEASURED - not that every testbench killed
 * everything. The same convention `instrumentControlMeasured` and `summarizeAgreement`
 * already use, so an operator reads one vocabulary.
 */
export function mutationControlMeasured(report: MutationControlReport): boolean {
  return report.probedSamples > 0;
}

/** Order two strings deterministically, so every rendered list is stable. */
function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** Which persisted survivor bucket a tally reads. */
export type SurvivorBucket = 'coverageGapOperators' | 'candidateEquivalentOperators';

/**
 * Tally one survivor bucket's operators, most frequent first, ties by name (pure).
 *
 * Takes the persisted counts rather than whole samples, so a Campaign cell can tally straight
 * off `record.mutation` without rebuilding a `MutationSample` it has no problem id for. An
 * unprobed entry is `null` and contributes nothing.
 */
export function tallySurvivedOperators(
  probes: readonly (MutationSampleCounts | null)[],
  bucket: SurvivorBucket,
): readonly SurvivedOperatorCount[] {
  const counts = new Map<MutationOperatorId, number>();
  for (const probe of probes) {
    for (const operator of probe?.[bucket] ?? []) {
      counts.set(operator, (counts.get(operator) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([operator, count]) => ({ operator, count }))
    .sort((left, right) => right.count - left.count || compareText(left.operator, right.operator));
}

/**
 * The per-PROBLEM calibration facts, counted once per problem (pure).
 *
 * Every probed sample of one problem carries the same calibration counts by construction, so
 * the first one seen is taken and the rest are ignored. Written as a deliberate
 * de-duplication rather than a sum, because a sum would report `goldenSurvived x sampleCount`
 * and describe the corpus as far blinder than it is.
 */
function tallyCalibrationFacts(samples: readonly MutationSample[]): Readonly<{
  goldenSurvivedMutants: number;
  goldenTimeoutMutants: number;
  nonCompilingMutants: number;
  goldenErroredMutants: number;
}> {
  const seen = new Set<string>();
  let goldenSurvivedMutants = 0;
  let goldenTimeoutMutants = 0;
  let nonCompilingMutants = 0;
  let goldenErroredMutants = 0;
  for (const sample of samples) {
    if (sample.probe === null || seen.has(sample.problemId)) {
      continue;
    }
    seen.add(sample.problemId);
    goldenSurvivedMutants += sample.probe.goldenSurvivedCount;
    goldenTimeoutMutants += sample.probe.goldenTimeoutCount;
    nonCompilingMutants += sample.probe.nonCompilingCount;
    goldenErroredMutants += sample.probe.goldenErroredCount;
  }
  return {
    goldenSurvivedMutants,
    goldenTimeoutMutants,
    nonCompilingMutants,
    goldenErroredMutants,
  };
}

/** Aggregate per-sample mutation facts into the run's negative-control report (pure). */
export function summarizeMutationControl(
  samples: readonly MutationSample[],
): MutationControlReport {
  const probes = samples
    .map((sample) => sample.probe)
    .filter((probe): probe is MutationSampleCounts => probe !== null);
  if (probes.length === 0) {
    return NO_MUTATION_CONTROL_MEASURED;
  }
  const validMutants = probes.reduce((sum, probe) => sum + probe.validCount, 0);
  const killedMutants = probes.reduce((sum, probe) => sum + probe.killedCount, 0);
  // The same per-sample field `campaignCounts` reduces, so an arm and its cells cannot disagree.
  const coverageGapSurvivors = probes.reduce(
    (sum, probe) => sum + probe.coverageGapOperators.length,
    0,
  );
  const elapsed = probes.map((probe) => probe.elapsedMs);
  return {
    probedSamples: probes.length,
    validMutants,
    killedMutants,
    noVerdictKills: probes.reduce((sum, probe) => sum + probe.noVerdictKills, 0),
    killRate: validMutants === 0 ? null : killedMutants / validMutants,
    ...tallyCalibrationFacts(samples),
    coverageGapOperators: tallySurvivedOperators(probes, 'coverageGapOperators'),
    candidateEquivalentOperators: tallySurvivedOperators(probes, 'candidateEquivalentOperators'),
    coverageGapSurvivors,
    coverageGapSurvivorRate: validMutants === 0 ? null : coverageGapSurvivors / validMutants,
    meanElapsedMs: elapsed.reduce((sum, value) => sum + value, 0) / elapsed.length,
    maxElapsedMs: elapsed.reduce((max, value) => Math.max(max, value), 0),
  };
}
