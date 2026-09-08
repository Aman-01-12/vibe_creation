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

/**
 * Which deliberate defect a mutant carries; a closed, named set.
 *
 * Each member names ONE transformation, so a survivor identifies a specific coverage gap in
 * our testbench generator rather than "mutation testing failed". These ids are persisted in
 * the results record and printed to operators, so they are enum members and never free
 * text.
 */
export type MutationOperatorId =
  /** A binary `+` became `-`: an arithmetic sign defect. */
  | 'ARITH_PLUS_TO_MINUS'
  /** A binary `-` became `+`: the mirror of the above. */
  | 'ARITH_MINUS_TO_PLUS'
  /** A bitwise/reduction `&` became `|`: a masking defect. */
  | 'BITWISE_AND_TO_OR'
  /** A bitwise/reduction `|` became `&`: the mirror of the above. */
  | 'BITWISE_OR_TO_AND'
  /** A `<` became `<=`: an inclusive/exclusive boundary defect. */
  | 'RELATIONAL_LT_TO_LE'
  /** An `==` became `!=`: an inverted comparison. */
  | 'EQUALITY_TO_INEQUALITY'
  /** A `<<` became `>>` or the reverse: a shift-direction defect. */
  | 'SHIFT_DIRECTION_SWAPPED'
  /** An `if` condition was wrapped in a logical negation: an inverted branch. */
  | 'CONDITION_NEGATED'
  /** A reset condition was forced false, so the reset branch never fires. */
  | 'RESET_BRANCH_DISABLED'
  /** A literal `0` became `1`: a wrong-constant defect. */
  | 'CONST_ZERO_TO_ONE'
  /** A decimal literal was incremented: a wrong-constant defect. */
  | 'CONST_INCREMENTED'
  /** A bracketed index or range literal moved by one: a bit-select off-by-one. */
  | 'INDEX_OFF_BY_ONE';

/**
 * Every operator, in the FIXED order that decides which mutants survive the cap.
 *
 * The order is part of the contract, not an implementation detail: it is what makes the
 * capped mutant set a deterministic function of the reference plus the config (see
 * `MutationConfig.maxMutantsPerProblem`). Adding an operator, or reordering these, changes
 * the mutant set - which is exactly why the calibration cache is keyed by a hash of the
 * config that names them.
 */
export const MUTATION_OPERATORS: readonly MutationOperatorId[] = Object.freeze([
  'ARITH_PLUS_TO_MINUS',
  'ARITH_MINUS_TO_PLUS',
  'BITWISE_AND_TO_OR',
  'BITWISE_OR_TO_AND',
  'RELATIONAL_LT_TO_LE',
  'EQUALITY_TO_INEQUALITY',
  'SHIFT_DIRECTION_SWAPPED',
  'CONDITION_NEGATED',
  'RESET_BRANCH_DISABLED',
  'CONST_ZERO_TO_ONE',
  'CONST_INCREMENTED',
  'INDEX_OFF_BY_ONE',
] as const);

/** Longest site excerpt retained, so a mutant identity cannot grow without bound. */
export const MAX_SITE_TEXT_CHARS = 48;

/**
 * WHERE a mutation fired, in the reference design's own coordinates.
 *
 * A line and a column into RTLLM's reference RTL, plus the short before/after excerpt. This
 * is what turns "a mutant survived" into "our testbench does not notice a sign flip at
 * line 62", which is the only form of the finding the Testbench_Agent can act on.
 *
 * The excerpts are third-party SOURCE text, not tool output: they carry no path, no host,
 * and no credential, and they are bounded at construction by `MAX_SITE_TEXT_CHARS`.
 */
export interface MutationSite {
  /** 1-based line in the reference RTL. */
  readonly line: number;
  /** 1-based column within that line. */
  readonly column: number;
  /** The reference text the operator replaced, bounded. */
  readonly before: string;
  /** The text it was replaced with, bounded. */
  readonly after: string;
}

/**
 * One mutant's identity: enough to diagnose a survivor, and nothing more.
 *
 * `mutantId` is derived from the operator and the site, so it is stable across runs for a
 * given reference - which is what lets the calibration cache be keyed by mutant rather than
 * by ordinal position.
 */
export interface MutantIdentity {
  /** `<operator>@<line>:<column>`; deterministic and stable for a given reference. */
  readonly mutantId: string;
  readonly operator: MutationOperatorId;
  readonly site: MutationSite;
}

/** One mutant: its identity plus the deliberately broken RTL. */
export interface Mutant extends MutantIdentity {
  /** The reference source with exactly ONE site transformed. */
  readonly rtl: string;
}

/** The stable id for a mutant, so the cache and the report agree on one spelling. */
export function mutantIdOf(operator: MutationOperatorId, site: MutationSite): string {
  return `${operator}@${site.line}:${site.column}`;
}

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

/**
 * Default wall-clock ceiling for ONE MUTANT run, in milliseconds - not a guess, a measurement.
 *
 * A mutant run must NOT inherit the student session's wall clock. The student cap exists to let
 * a real design compile and simulate under load; a mutant run is the same toolchain over the
 * same tiny design, and the only reason it would ever approach that cap is that it is HANGING.
 *
 * Measured on `rtllm/arithmetic/multi_pipe_8bit` at `limits.wallMs = 30000`, first 8 of its 24
 * mutants (golden calibration, real Icarus toolchain):
 *
 *     237ms  failed    ARITH_PLUS_TO_MINUS@69:29
 *     181ms  passed    ARITH_MINUS_TO_PLUS@17:15
 *   30005ms  error     CONDITION_NEGATED@26:10      <- the full 30s wall cap
 *     178ms  passed    RESET_BRANCH_DISABLED@26:10
 *     137ms  passed    CONST_ZERO_TO_ONE@27:33
 *     189ms  passed    CONST_INCREMENTED@2:22
 *     138ms  passed    INDEX_OFF_BY_ONE@17:16
 *     138ms  failed    ARITH_PLUS_TO_MINUS@70:29
 *
 * So a real mutant run costs 137-237ms and a HANGING one costs the whole cap. 5000ms is roughly
 * 20x the observed worst REAL run - wide enough that host load, a cold worker launch, or a
 * larger design cannot manufacture a false timeout - and 6x cheaper than 30s on a hang. The
 * hangs are structural rather than rare: RTLLM's golden testbenches commonly spin on a design
 * signal (`while (mul_en_out == 0)`), so any mutant that breaks that signal never reaches
 * `$finish`.
 *
 * It is CONFIGURABLE and part of the config identity, because it can change which mutants
 * classify as `golden-timeout`, which changes the gate set, which can move a measured number.
 */
export const DEFAULT_MUTANT_WALL_MS = 5_000;

/**
 * Floor on the mutant wall cap.
 *
 * Below the observed real-run band a cap manufactures timeouts, and a manufactured timeout is
 * now a KILL that enlarges the gate set - so too small is not merely slow, it corrupts the
 * measurement. 500ms is already more than double the slowest real run measured above, and
 * anything under it is rejected at the config boundary rather than discovered in a summary.
 */
export const MIN_MUTANT_WALL_MS = 500;

/**
 * Ceiling on the mutant wall cap.
 *
 * A mutant run has no legitimate reason to exceed a minute: past that the cap is not bounding a
 * hang any more, it is one. `mutants x samples x problems` multiplies whatever is set here, so
 * an absurd value is a config error, not a slow campaign.
 */
export const MAX_MUTANT_WALL_MS = 60_000;

/**
 * The sandbox limits ONE MUTANT run executes under (pure, total).
 *
 * Replaces the WALL CLOCK and nothing else. Every other cap - cpu, memMb, procs, diskMb - is the
 * student session's own, because a mutant runs on the SAME RAILS as the oracle: the point of the
 * negative control is that only the RTL under the testbench changed. Weakening or tightening a
 * resource cap here would leave "the mutant behaved differently because it ran under different
 * limits" as a live explanation for every survivor.
 *
 * The wall clock is the one exception, and it is an exception for a stated reason: it is not a
 * fidelity control but a HANG BOUND, and the hang it bounds costs the full cap every time (see
 * `DEFAULT_MUTANT_WALL_MS`).
 *
 * The single owner of this substitution. Both mutant paths - golden calibration and our own
 * testbench's probe - call it, so they cannot drift into judging the same mutant under two
 * different clocks.
 */
export function mutantRunLimits(limits: ResourceLimits, mutantWallMs: number): ResourceLimits {
  return { ...limits, wallMs: mutantWallMs };
}

/**
 * The knobs that decide WHICH mutants exist.
 *
 * Hashed into the calibration cache key, because a change to either changes the mutant set
 * and therefore invalidates every cached verdict. The operator list is carried explicitly
 * rather than assumed, so a future run that disables an operator is a different key.
 */
export interface MutationConfig {
  readonly maxMutantsPerProblem: number;
  readonly operators: readonly MutationOperatorId[];
}

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
 * What one per-sample negative-control probe measured.
 *
 * TWO NUMBERS WITH TWO DIFFERENT JOBS, and conflating them is the defect this shape exists to
 * prevent:
 *
 *   THE GATE reads `coverageGapSurvivors` ONLY, via `judgeCoverageGaps`. Every entry is a
 *   mutant the INDEPENDENT golden testbench killed and ours did not, so a third party has
 *   proven the bug catchable and our failing to catch it is unambiguously our defect.
 *
 *   THE SIGNAL is the kill rate over `validCount` - every mutant that compiles. Its
 *   denominator is deliberately the wider one, because scoring ourselves only on what the
 *   independent judge catches would excuse us for whatever it is blind to, and its blindness is
 *   the population that produces a false `Verified`. But that same width means the rate
 *   necessarily contains mutants killable by NO testbench, so it informs and never gates.
 *
 * THE SURVIVORS COME IN TWO BUCKETS, and both count against the kill rate while only the first
 * can decide validity:
 *   - `coverageGapSurvivors`: the golden testbench KILLED it and ours did not. A definite,
 *     actionable coverage gap - the independent judge has demonstrated the bug is catchable.
 *   - `candidateEquivalentSurvivors`: the golden testbench did not kill it either. It MAY be
 *     equivalent to the original, and it is flagged for review on that basis - never excluded
 *     from the rate, because simulation cannot decide equivalence, and never held against
 *     validity, because nobody has established it is killable at all.
 *
 * Invariant, asserted by the probe's tests: `validCount === killedCount +
 * coverageGapSurvivors.length + candidateEquivalentSurvivors.length`.
 */
export interface MutationProbeReport {
  /** Mutants that COMPILE: the KILL-RATE denominator, and the set our testbench was run on. */
  readonly validCount: number;
  /** Valid mutants OUR testbench refused to certify, by either kill kind. */
  readonly killedCount: number;
  /**
   * Kills where our testbench produced NO verdict rather than a failing check.
   *
   * A subset of `killedCount`, kept visible because a run whose kills are mostly timeouts is
   * not evidence of coverage; see `MutantKillKind`. The complement (kills from a reported
   * failure) is derived by `reportedFailureKills`.
   */
  readonly noVerdictKills: number;
  /** Survivors the INDEPENDENT judge killed: a definite coverage gap, most actionable. */
  readonly coverageGapSurvivors: readonly MutantIdentity[];
  /** Survivors the independent judge also passed: candidate-equivalent, flagged for review. */
  readonly candidateEquivalentSurvivors: readonly MutantIdentity[];
  /** Valid mutants the golden testbench killed, by EITHER kill kind; the gate's scope. */
  readonly goldenKilledCount: number;
  /**
   * Golden kills where the judge HUNG rather than reported a failure; a subset of the above.
   *
   * Kept visible for the same reason `noVerdictKills` is: a gate set built mostly out of hangs
   * is a wall-clock finding, not a demonstration that the judge detects those defect classes,
   * and the two must not read alike.
   */
  readonly goldenTimeoutCount: number;
  /** Mutants that did not BUILD at calibration, so they are not valid mutants. */
  readonly nonCompilingCount: number;
  /**
   * Mutants whose golden run produced no verdict, no diagnostics, and no timeout.
   *
   * Counted apart from `nonCompilingCount` because they did not fail to build: this is a crash
   * or an empty capture, which is an infrastructure fact about the run rather than a fact about
   * the mutant. Also out of the denominator - nothing was measured, so nothing is claimed.
   */
  readonly goldenErroredCount: number;
  /** Mutants generated from the reference before calibration. */
  readonly generatedCount: number;
  /** Wall clock this probe added to the sample, in milliseconds. */
  readonly elapsedMs: number;
}

/** Kills that came from a failing check rather than from an absent verdict (pure). */
export function reportedFailureKills(report: MutationProbeReport): number {
  return Math.max(0, report.killedCount - report.noVerdictKills);
}

/** Every mutant our testbench failed to kill, both buckets, in probe order (pure). */
export function allSurvivors(report: MutationProbeReport): readonly MutantIdentity[] {
  return [...report.coverageGapSurvivors, ...report.candidateEquivalentSurvivors];
}

/**
 * A probe's kill rate over its valid mutants, or `null` when there were none (pure).
 *
 * A REPORTED QUALITY SIGNAL, not the gate. It is the fraction of every compiling mutant our
 * testbench refused to certify, so it is the best single number for "how discriminating is this
 * instrument" - and it is unfit to be a threshold, because its denominator necessarily contains
 * mutants no testbench can kill. `judgeCoverageGaps` decides validity; this describes it.
 */
export function killRateOf(report: MutationProbeReport): number | null {
  return report.validCount === 0 ? null : report.killedCount / report.validCount;
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
type SurvivorBucket = 'coverageGapOperators' | 'candidateEquivalentOperators';

/** Tally one survivor bucket's operators, most frequent first, ties by name (pure). */
function tallySurvivedOperators(
  samples: readonly MutationSample[],
  bucket: SurvivorBucket,
): readonly SurvivedOperatorCount[] {
  const counts = new Map<MutationOperatorId, number>();
  for (const sample of samples) {
    for (const operator of sample.probe?.[bucket] ?? []) {
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
  const elapsed = probes.map((probe) => probe.elapsedMs);
  return {
    probedSamples: probes.length,
    validMutants,
    killedMutants,
    noVerdictKills: probes.reduce((sum, probe) => sum + probe.noVerdictKills, 0),
    killRate: validMutants === 0 ? null : killedMutants / validMutants,
    ...tallyCalibrationFacts(samples),
    coverageGapOperators: tallySurvivedOperators(samples, 'coverageGapOperators'),
    candidateEquivalentOperators: tallySurvivedOperators(samples, 'candidateEquivalentOperators'),
    meanElapsedMs: elapsed.reduce((sum, value) => sum + value, 0) / elapsed.length,
    maxElapsedMs: elapsed.reduce((max, value) => Math.max(max, value), 0),
  };
}
