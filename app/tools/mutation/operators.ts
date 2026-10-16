// Pure mutation vocabulary, relocated from `@app/eval/mutation-control.ts` (task 4.1): what a
// mutant is, the fixed operator order, and the two pure readers of a probe report -
// `killRateOf` and `allSurvivors`.
//
// `MutationProbeReport` and `reportedFailureKills` move with them even though the design's
// relocation list did not name either: `killRateOf` and `allSurvivors` both take a
// `MutationProbeReport`, so the two functions cannot relocate without the type they read. The
// type itself is a plain record of counts and identities with no import of its own, so moving
// it keeps this file's import boundary (core-only, no `@app/eval`, no `@app/agent`) intact.
//
// GOLDEN-calibrated readers - `judgeCoverageGaps`, `mutantIsValid`, `mutantWasGoldenKilled`,
// `MutantCalibration` - stay in `@app/eval`, where the golden judge lives.
// `@app/eval/mutation-control.ts` re-exports every name below BY BINDING, so no existing call
// site in that package changes.
//
// Pure: no clock, no I/O, no randomness.

import type { ResourceLimits } from '../sandbox/index.js';

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
 * `MutationConfig.maxMutantsPerProblem` in `@app/eval/mutation-control.ts`). Adding an
 * operator, or reordering these, changes the mutant set - which is exactly why the
 * calibration cache is keyed by a hash of the config that names them.
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
 * The identity fields of a mutant, without its RTL, for a survivor record (pure, total).
 *
 * THE RUNTIME HALF OF A PROMISE THE TYPE CANNOT KEEP. `Mutant extends MutantIdentity`, so any
 * caller that hands a FULL mutant where an identity is wanted TYPE-CHECKS, and structural
 * typing then lets the mutated reference RTL ride along on an object a reader was told holds
 * identity alone. `readonly survivors: readonly MutantIdentity[]` says what a reader may rely
 * on, not what the object holds - so a survivor list that passes its elements through by
 * reference carries whatever the caller allocated. This function is the only thing that can
 * close that gap: it builds a NEW object from the three identity fields, so the RTL has no
 * path onto a record that describes the instrument rather than the mutant's source.
 *
 * It lives HERE, beside the two interfaces it projects between, because both gates need it
 * and two copies of one concept drift. The parameter is `MutantIdentity` rather than `Mutant`
 * so a caller that only ever had an identity can still re-project it defensively; `Mutant`
 * remains in range by extension.
 *
 * `site` is passed through by reference, which is deliberate and bounded: `MutationSite` is a
 * closed shape of four scalars, so nothing can be smuggled under it the way `rtl` rides on a
 * `Mutant`. A field-by-field rebuild of `site` would buy nothing and would need maintaining.
 */
export function identityOf(mutant: MutantIdentity): MutantIdentity {
  return { mutantId: mutant.mutantId, operator: mutant.operator, site: mutant.site };
}

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
 * `DEFAULT_MUTANT_WALL_MS` in `@app/eval/mutation-control.ts`).
 *
 * The single owner of this substitution. Both mutant paths - golden calibration and our own
 * testbench's probe - call it, so they cannot drift into judging the same mutant under two
 * different clocks.
 */
export function mutantRunLimits(limits: ResourceLimits, mutantWallMs: number): ResourceLimits {
  return { ...limits, wallMs: mutantWallMs };
}

/**
 * What one per-sample negative-control probe measured.
 *
 * TWO NUMBERS WITH TWO DIFFERENT JOBS, and conflating them is the defect this shape exists to
 * prevent:
 *
 *   THE GATE reads `coverageGapSurvivors` ONLY, via `judgeCoverageGaps` in
 *   `@app/eval/mutation-control.ts`. Every entry is a mutant the INDEPENDENT golden testbench
 *   killed and ours did not, so a third party has proven the bug catchable and our failing to
 *   catch it is unambiguously our defect.
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
   * not evidence of coverage; see `MutantKillKind` in `@app/eval/mutation-control.ts`. The
   * complement (kills from a reported failure) is derived by `reportedFailureKills`.
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
