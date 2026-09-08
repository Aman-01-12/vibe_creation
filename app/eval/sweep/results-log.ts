// The append-only results log: one JSON line per completed sample, and the resume
// index built from it.
//
// WHY JSONL AND WHY APPEND-ONLY
//   A bake-off runs for hours. Buffering the matrix in memory and writing one report at
//   the end means a crash at hour six loses six hours of PAID samples. So each sample
//   is appended as it completes, and the file is never rewritten: an append either
//   lands whole or does not land, so a kill mid-write costs at most the line in flight,
//   and every line before it stays readable. That is also what makes the summary
//   runnable standalone over an old file with no re-run.
//
// THE RESULTS FILE IS UNTRUSTED INPUT
//   It is read back on resume and by the summarizer, and by then it may have been
//   hand-edited, truncated by a full disk, concatenated with another run's file, or
//   half-written when the process died. So every line is narrowed field by field and a
//   line that does not validate is COUNTED and SKIPPED, never partially trusted and
//   never fatal. A malformed tail must not stop a resume; it must be visible.
//
// RESUME IS SCOPED BY CONFIG IDENTITY
//   The index only admits records whose `configHash` matches the current config, so
//   resuming a DIFFERENT experiment cannot reuse this one's samples (see
//   `./config-identity.ts`). Records for arms the current config no longer declares are
//   simply never looked up.
//
// A SCHEMA BUMP IS A REFUSAL, NEVER A MIGRATION
//   When a field's MEANING changes - as it did when pass@k started depending on the
//   positive control's instrument verdict - an old record cannot be upgraded, because the
//   missing field is precisely the thing the new number depends on. Filling it in with a
//   default would produce a number that looks measured and is not. So an older-version line
//   is counted separately from corruption and the summary refuses to aggregate the file at
//   all, telling the operator to re-run into a fresh directory.
//
// NO SECRETS, NO PATHS, NO STACK TRACES
//   A record carries a verdict, counters, and sanitized classifications only. It is
//   the artifact a number is cited from, so it is safe to attach to a report.

import type { BudgetStopReason } from '@app/core';

import { RECORDED_GOLDEN_KINDS, type RecordedGoldenKind } from '../golden-judge.js';
import type {
  InstrumentDefectCode,
  InstrumentValidity,
  RecordedInstrumentVerdict,
} from '../instrument-control.js';
import {
  MUTATION_OPERATORS,
  type MutationOperatorId,
  type MutationSampleCounts,
} from '../mutation-control.js';
import { isDeferredSample, NO_VERDICT_CAUSES, type NoVerdictCause } from '../no-verdict-cause.js';
import type { SampleOutcomeStatus } from '../report.js';

/**
 * The record schema version, bumped only when a field's MEANING changes.
 *
 * v1 -> v2 (the positive control). pass@k started depending on `instrumentValidity`: a sample
 * counts in the denominator only if the loop reached an oracle verdict AND the control
 * proved its testbench valid. A v1 record has no such field, so aggregating one as if its
 * instrument had been validated would silently mix `unchecked` with `valid`.
 *
 * v2 -> v3 (the NEGATIVE control). `instrumentValidity: valid` now means BOTH controls
 * passed: the reference design is accepted AND the mutants the independent golden testbench
 * kills are also killed by our testbench. A v2 `valid` was decided by the positive control
 * alone, and the defect that motivated v3 is precisely a testbench that satisfies the
 * positive control and nothing else (`multi_pipe_8bit`, smoke-v4-oracle). So a v2 record's
 * `valid` is not the current `valid`, and blending the two would report testbenches that
 * pass everything as sound instruments.
 *
 * v3 -> v4 (the mutant DENOMINATOR). The negative control used to score our testbench only over
 * the mutants RTLLM's golden testbench kills, excluding the rest as likely-equivalent. That
 * excused our testbench for exactly the bugs the golden judge is blind to, so the denominator is
 * now every mutant that COMPILES and the threshold moved with it. A v3 `valid` therefore means
 * "killed all of a smaller, judge-shaped set"; a v4 `valid` means "killed at least 95% of
 * every valid mutant". The `mutation` block's fields changed with it, so a v3 record cannot even
 * describe the current measurement.
 *
 * v4 -> v5 (the GATE). The 95%-of-valid-mutants bar was itself unsound, in the opposite
 * direction: its denominator necessarily contains genuinely equivalent mutants, so it held an
 * instrument to killing mutants that may be unkillable in principle. Measured on
 * `rtllm/arithmetic/multi_pipe_8bit`, a testbench that kills two mutants the golden judge itself
 * misses scored 4/6 and was marked INVALID - a false negative on a demonstrably good instrument.
 * Validity is now ZERO COVERAGE-GAP SURVIVORS: our testbench must kill every valid mutant the
 * INDEPENDENT golden testbench killed, and nothing more. A v4 `valid` is a rate claim over a set
 * containing unkillable mutants; a v5 `valid` is "no independently-proven-catchable bug was
 * missed". The two are not the same population and one is not a relaxation of the other, so
 * pooling them would report both a false negative and a false positive as the same word.
 *
 * v5 -> v6 (MEASURED cost). The arm's efficiency figure used to be denominated in DOLLARS, and
 * dollars are not measured: no endpoint returns money, so `costCents` is `costKnown` tokens
 * multiplied by an external rate card, and an unpriced campaign had no efficiency number at all.
 * The primary figure is now tokens and wall clock per verified artifact, both of which the
 * endpoint and the clock actually report, so a record carries `promptTokens`,
 * `completionTokens`, `totalTokens`, and `unreportedUsageCalls`. A v5 record has none of them
 * and there is no way to recover them - they were metered per sample and discarded - so reading
 * one would put a 0 in the numerator of the headline number and report a campaign that spent
 * millions of tokens as infinitely efficient.
 *
 * v6 -> v7 (a TIMEOUT is a KILL). `instrumentValidity: valid` changed population again, and this
 * time the gate set GREW. A mutant the independent golden testbench never terminated on used to
 * classify `non-compiling`, which removed it from the valid set and therefore from the gate set -
 * so our testbench was never asked to catch a defect that demonstrably changes observable
 * behaviour. It is now a golden KILL, so a v7 `valid` requires strictly more than a v6 `valid`
 * did, and a v6 record can carry `valid` for a testbench that v7 would reject. Pooling them
 * would report the weaker claim under the stronger word.
 *
 * The `mutation` block also changed shape: `nonCompilingCount` narrowed to genuine build failures
 * only, and two counts joined it - `goldenTimeoutCount` (golden kills that were hangs, the
 * honesty counterpart of the enlarged gate set) and `goldenErroredCount` (a golden run that
 * crashed with nothing to show, which is an infrastructure fact rather than a broken mutant). A
 * v6 `nonCompilingCount` is the sum of all three with no way to recover the split.
 *
 * v7 -> v8 (a TRANSPORT FAILURE IS NOT A MEASUREMENT). The RESUME rule changed meaning, which is
 * the first time a bump has been about the matrix rather than about a number. A no-verdict record
 * used to be unconditionally final: it was in the file, so `CompletedSampleIndex` read the slot as
 * done and never ran it again. Measured on `.eval-runs/instrument-calibration` (one arm, 46
 * problems, n=1): 24 healthy samples, then an unbroken run of `setup-failed` records carrying
 * `ALL_PROVIDERS_FAILED`, then recovery under a fresh breaker. Two thirds of the matrix was
 * deleted by one rate-limit burst and the run reported itself `completed`. A record now carries
 * `noVerdictCause`, and an INFRASTRUCTURE cause makes the slot DEFERRED - kept as evidence,
 * excluded from the resume index, announced by the summary - while a FINDING stays final.
 *
 * There is no migration for it, and the reason is not that the field cannot be defaulted: `null`
 * decodes as not-deferrable, so a v7 file WOULD load. That default is precisely the false claim.
 * It asserts that every no-verdict sample in the file was a measurement, and in the only such
 * file that exists that assertion is wrong for 31 of 40 no-verdict records. A build that
 * announces it distinguishes outages from findings must not silently read an outage as a finding.
 *
 * v8 -> v9 (the GOLDEN OUTCOME VOCABULARY WIDENED). `goldenVerdict` used to be the independent
 * judge's BANNER grammar - `passed | failed | error` - and it is now the RECORDED vocabulary,
 * which splits that `error` into `did-not-build`, `no-output`, and `timed-out`. The reason is a
 * new number: pass@k is now ALSO reported over the golden denominator, the samples the
 * independent judge returned a verdict on the candidate's BEHAVIOUR for, and the three causes
 * behind an `error` are excluded from it for three different reasons that an operator has to be
 * able to tell apart. A v8 `error` is the sum of all three with no way to recover the split, so a
 * golden denominator computed over v8 records would report an exclusion bucket nobody can act on
 * - and, worse, the same total under a different composition run to run.
 *
 * As at every previous bump there is no default that would be honest. Reading a v8 `error` as any
 * one of the three asserts a cause that was never measured, and dropping it from the exclusion
 * tally would break the partition the golden block prints - the denominator plus its exclusions
 * equalling the arm's recorded samples is exactly what stops a shrunken denominator being cited
 * alone.
 *
 * There is therefore no migration and no default at any bump: the reader REFUSES to aggregate a
 * file containing older records and tells the operator to re-run into a fresh output directory
 * (see `STALE_SCHEMA_ADVICE`).
 */
export const RESULTS_SCHEMA_VERSION = 9;

/**
 * What an operator must do about a results file written before the schema bump.
 *
 * States the cost explicitly rather than leaving it to be guessed, so the operator can decide
 * rather than wonder what a re-run is worth.
 */
export const STALE_SCHEMA_ADVICE: readonly string[] = Object.freeze([
  `this results file holds records from an older schema (current v${RESULTS_SCHEMA_VERSION}) and`,
  'CANNOT be aggregated, for three independent reasons.',
  '(1) Those records carry NO token counts. The primary efficiency figure is now tokens and',
  'wall clock per verified artifact - the things the endpoint and the clock actually report -',
  'and a token count that was metered per sample and then discarded cannot be recovered from',
  'the record. Defaulting it to 0 would report a campaign that burned millions of tokens as',
  'infinitely efficient. Dollars are the optional secondary figure and still need',
  'prices.<modelId>.',
  '(2) `instrumentValidity: valid` means something DIFFERENT now than it did',
  'in the oldest of those records. It used to mean "our testbench passes the reference design',
  'AND kills at least 95% of every mutant that compiles"; it now means "AND kills EVERY mutant',
  'the independent golden testbench killed" - zero coverage gaps, with no rate bar at all. The',
  'rate bar was unsound because its denominator necessarily contains mutants no testbench can',
  'kill, so it failed instruments that were measurably good; the new gate only ever demands',
  'kills a third party has already demonstrated are possible. The kill rate is still recorded,',
  'as a quality signal rather than as the gate. The gated set then GREW again: a mutant the',
  'golden testbench never TERMINATED on used to be discarded as non-compiling, and is now a',
  'golden kill our testbench is required to catch, so a v7 `valid` demands strictly more than',
  'an older one did.',
  '(3) Those records cannot say whether a no-verdict sample was MEASURED or merely ATTEMPTED.',
  'A sample now records WHY it reached no oracle verdict, and an infrastructure cause - no',
  'provider answered - marks the slot DEFERRED so a resume runs it again instead of counting',
  'it as done. Older records have no such field, so reading one would repeat the defect this',
  'schema closes: a rate-limit burst was recorded as a wall of finished samples, the resume',
  'skipped every one of them, and the run reported a two-thirds-empty matrix as complete.',
  'Defaulting the field is not a migration, it is that same claim written down.',
  '(4) The GOLDEN OUTCOME VOCABULARY WIDENED, so `goldenVerdict` in those records means less',
  'than it does now. It used to be the independent judge\'s banner grammar - "passed",',
  '"failed", or a single "error" - and it is now the recorded vocabulary, which splits that',
  'error into "did-not-build", "no-output", and "timed-out". pass@k is now ALSO reported over',
  'the GOLDEN DENOMINATOR - the samples the independent judge returned a verdict on the',
  "candidate's behaviour for - and those three causes are excluded from it for three",
  'different reasons an operator has to be able to tell apart: a candidate the judge could',
  'not elaborate, our own infrastructure producing nothing, and a resource cap we imposed',
  'doing its job. An older record collapses all three, and no default recovers the split:',
  'picking one asserts a cause nobody measured, and dropping it would break the partition',
  'the golden block prints, which is the only thing stopping a shrunken denominator from',
  'being cited on its own.',
  'Fix: re-run the campaign into a FRESH outputDir. The only records ever written at an older',
  'schema were throwaway smoke samples and one diagnostic calibration run.',
]);

/** The results log filename inside a run's output directory. */
export const RESULTS_LOG_FILENAME = 'results.jsonl';

/** Longest results file this reader will accept, in bytes (~64 MiB). */
export const MAX_RESULTS_FILE_BYTES = 67_108_864;

/** The outcome statuses a record may carry; a closed set, validated on read. */
const OUTCOME_STATUSES: readonly SampleOutcomeStatus[] = [
  'verified',
  'unverified',
  'blocked',
  'setup-failed',
  'runner-error',
];

/** The budget stop reasons a record may carry; a closed set, validated on read. */
const STOP_REASONS: readonly BudgetStopReason[] = [
  'max-iterations',
  'max-tokens',
  'max-wall-clock',
  'max-cost',
];

/**
 * The golden outcome kinds a record may carry; a closed set, validated on read.
 *
 * The RECORDED vocabulary from `../golden-judge.js`, read from its single owner rather than
 * restated, so the persisted set and the set the golden denominator is decided over cannot
 * drift. Deliberately NOT the banner grammar in `../corpus/golden-banner.js`: a v8 record's
 * single `error` is the sum of three causes, and the decoder must refuse it rather than pick
 * one (see `RESULTS_SCHEMA_VERSION`).
 */
const GOLDEN_KINDS: readonly RecordedGoldenKind[] = RECORDED_GOLDEN_KINDS;

/** The instrument validities a record may carry; a closed set, validated on read. */
const INSTRUMENT_VALIDITIES: readonly InstrumentValidity[] = ['valid', 'invalid', 'unchecked'];

/** The instrument defect codes a record may carry; a closed set, validated on read. */
const INSTRUMENT_DEFECTS: readonly InstrumentDefectCode[] = [
  'TESTBENCH_FAILED_REFERENCE',
  'TESTBENCH_REFERENCE_UNBUILDABLE',
  'CONTROL_RUN_ERRORED',
  'TESTBENCH_SURVIVED_MUTANTS',
];

/**
 * Most survived operator ids one record may carry.
 *
 * The mutant cap is well below this, so the bound is never reached by our own writer; it
 * exists because the results file is untrusted on read and a hand-edited line must not be
 * able to allocate without limit.
 */
export const MAX_RECORDED_SURVIVORS = 64;

/** One completed sample of one arm: the unit of work, of resume, and of aggregation. */
export interface SweepSampleRecord {
  readonly schemaVersion: number;
  /** The experiment this sample belongs to; resume ignores any other. */
  readonly configHash: string;
  readonly armName: string;
  /**
   * The arm's model ids, rendered stably.
   *
   * Persisted so the file is self-describing: a row states which model produced it
   * without the reader holding the config. The summary also uses it to detect an arm
   * name reused for two different model sets in one file.
   */
  readonly modelSignature: string;
  readonly problemId: string;
  readonly sampleIndex: number;
  /** The deterministic seed this sample was drawn with. */
  readonly seed: number;
  /** Whether the loop's own Simulator oracle passed it - the sole pass authority. */
  readonly passed: boolean;
  readonly outcomeStatus: SampleOutcomeStatus;
  /** Loop iterations; 1 on a pass means the first candidate passed (first-try). */
  readonly iterations: number;
  /**
   * Cents this session consumed against its student caps - the SECONDARY cost figure.
   *
   * Secondary because it is not measured: the endpoint returns tokens, never money, so
   * this is a token count multiplied by an external rate card. Meaningless unless
   * `costKnown` is true. The measured figures are the token counts and `durationMs`.
   */
  readonly costCents: number;
  /**
   * Whether every model this arm used had a configured price.
   *
   * `false` means `costCents` is a FLOOR of unknown tightness, not a measurement, so
   * the summary reports the arm's cost in DOLLARS as UNKNOWN rather than printing a
   * misleading number. It says nothing about the token counts below, which are measured
   * whether or not a price was configured. Persisted per record so a standalone
   * summarize needs no config.
   */
  readonly costKnown: boolean;
  /**
   * Prompt tokens the providers reported for this session (MEASURED).
   *
   * Persisted flat beside `costCents`, not nested, because tokens are metered on every
   * sample - there is no "not measured" case for the tally to hold together as one
   * decision, which is why `mutation` below is nested and this is not.
   */
  readonly promptTokens: number;
  /** Completion tokens the providers reported for this session (MEASURED). */
  readonly completionTokens: number;
  /**
   * Total tokens the session's budget accounted (MEASURED).
   *
   * The provider's own total, kept rather than derived from the two counts above, because
   * a host may report a `total_tokens` that is not their sum.
   */
  readonly totalTokens: number;
  /**
   * Model calls whose provider reported no usable `usage` block.
   *
   * The honesty channel for the three counts above: non-zero means they are floors, so a
   * per-artifact rate computed from them understates real consumption. A session that made
   * no model call has 0 here AND 0 tokens, and that pair is a genuine measurement - which
   * is the distinction this field exists to preserve.
   */
  readonly unreportedUsageCalls: number;
  readonly stopReason: BudgetStopReason | null;
  /**
   * The INDEPENDENT golden judge's outcome, or null when the sample was unjudgeable.
   *
   * THE FIELD THE GOLDEN pass@k DENOMINATOR DEPENDS ON, which is why widening it bumped the
   * schema version. `passed` and `failed` are a verdict on the candidate's BEHAVIOUR and put
   * the sample INSIDE that denominator; the other three each say the judge reported no such
   * verdict, and each is excluded and counted under its own reason (see
   * `countsInGoldenPassAtK`). The narrower banner grammar collapsed all three into one
   * `error`, which is a bucket nobody can act on.
   */
  readonly goldenVerdict: RecordedGoldenKind | null;
  /** Failures the golden testbench reported, or null when it printed no count. */
  readonly goldenFailureCount: number | null;
  /**
   * Whether the POSITIVE CONTROL proved this sample's own testbench a usable instrument.
   *
   * The field pass@k's denominator depends on, which is why its introduction bumped the
   * schema version. `invalid` means the known-good reference design does not pass our
   * testbench, so `passed` above says nothing about the model and the sample is EXCLUDED
   * from the denominator while still being reported.
   */
  readonly instrumentValidity: InstrumentValidity;
  /**
   * How an invalid instrument failed, or null when it is not invalid.
   *
   * Recorded because "our testbench did not build with the reference" and "our testbench
   * built and rejected the reference" point at different defects. The reason an `unchecked`
   * instrument is unchecked is NOT persisted here - `outcomeStatus` already explains the
   * common case (no testbench was produced) and the per-sample artifacts carry the rest,
   * which keeps this record narrow.
   */
  readonly instrumentDefect: InstrumentDefectCode | null;
  /**
   * What the NEGATIVE control measured for this sample, or `null` when it measured nothing.
   *
   * Nested as ONE object rather than a spread of sibling nullable columns, so "probed" and
   * "not probed" is a single decision that cannot half-hold: a record cannot carry a kill
   * count without the VALID count it is a fraction of.
   *
   * Survivors are persisted as OPERATOR IDS only - a closed set, no free text - and in TWO
   * lists, because the split between "the independent judge killed this and we did not" and
   * "neither of us killed it" is a golden-testbench fact the results file is the only record
   * of. The line, column, and source excerpt of each survivor live in the per-sample
   * artifacts, which is where source-bearing text already belongs.
   */
  readonly mutation: MutationSampleCounts | null;
  /**
   * Wall clock this whole sample took, measured by the sweep runner (MEASURED).
   *
   * The numerator of wall-clock per verified artifact. It covers EVERYTHING the slot did -
   * the loop's model calls and simulations, the independent golden judge, and both
   * instrument controls - because that is the elapsed time the sample actually cost an
   * operator. It is deliberately NOT the budget's charged wall clock, which counts only
   * the loop; one measured wall clock that a summary can name is worth more than two an
   * operator has to choose between.
   */
  readonly durationMs: number;
  readonly completedAtMs: number;
  /**
   * A short sanitized classification when the sweep itself could not obtain a verdict
   * (for example the harness threw), else null. Never a stack trace, host, or path.
   */
  readonly failureNote: string | null;
  /**
   * The TYPED reason this sample reached no oracle verdict, or null when it reached one.
   *
   * THE FIELD RESUME DEPENDS ON, which is why introducing it bumped the schema version.
   * `failureNote` above is the same fact as prose for an operator; this is the same fact as a
   * value, and it is the ONLY thing that separates a slot the campaign finished from a slot a
   * provider outage prevented it from starting. An infrastructure cause makes the record
   * DEFERRED: it stays in the file as evidence, `CompletedSampleIndex` leaves it out, and the
   * summary announces it. A finding - a testbench that misses a criterion, a budget cap doing
   * its job - stays final and is never re-run.
   *
   * Deliberately not derived from `failureNote`: the note renders as
   * `testbench-unavailable: ALL_PROVIDERS_FAILED` and matching that text would work today,
   * but it would make an operator-facing sentence load-bearing, so a reword or a truncation
   * at `MAX_FAILURE_NOTE_LENGTH` would silently turn deferred samples back into
   * measurements. See `../no-verdict-cause.ts`.
   */
  readonly noVerdictCause: NoVerdictCause | null;
}

/** The key identifying one sample slot within one experiment. */
export function sampleKey(armName: string, problemId: string, sampleIndex: number): string {
  return `${armName}\u0000${problemId}\u0000${sampleIndex}`;
}

/** Serialize one record as a single JSONL line (no trailing newline). */
export function encodeSampleRecord(record: SweepSampleRecord): string {
  return JSON.stringify(record);
}

/** Narrow an unknown to a plain object record, or null. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A non-empty string, or null. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A non-negative finite number, or null. */
function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** A non-negative integer, or null. */
function nonNegativeInt(value: unknown): number | null {
  const numeric = nonNegative(value);
  return numeric !== null && Number.isInteger(numeric) ? numeric : null;
}

/** A member of a closed string set, or null (absent and invalid are the same). */
function member<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : null;
}

/** An optional member of a closed string set: null for absent, invalid, or explicit null. */
function optionalMember<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return value === null || value === undefined ? null : member(value, allowed);
}

/** The identity fields of a record, validated together. */
interface RecordIdentity {
  readonly configHash: string;
  readonly armName: string;
  readonly modelSignature: string;
  readonly problemId: string;
  readonly sampleIndex: number;
}

/** Validate the identity fields; every one is required for the record to be keyable. */
function decodeIdentity(raw: Record<string, unknown>): RecordIdentity | null {
  const configHash = str(raw.configHash);
  const armName = str(raw.armName);
  const problemId = str(raw.problemId);
  const sampleIndex = nonNegativeInt(raw.sampleIndex);
  if (configHash === null || armName === null || problemId === null || sampleIndex === null) {
    return null;
  }
  // A record written by an older build may lack the signature; treat it as unknown
  // rather than discarding an otherwise valid, already-paid-for sample.
  const modelSignature = str(raw.modelSignature) ?? 'unknown';
  return { configHash, armName, modelSignature, problemId, sampleIndex };
}

/** The measurement fields of a record, validated together. */
interface RecordMeasurement {
  readonly seed: number;
  readonly iterations: number;
  readonly costCents: number;
  readonly durationMs: number;
  readonly completedAtMs: number;
}

/** Validate the numeric measurement fields; all are required and non-negative. */
function decodeMeasurement(raw: Record<string, unknown>): RecordMeasurement | null {
  const seed = nonNegativeInt(raw.seed);
  const iterations = nonNegativeInt(raw.iterations);
  const costCents = nonNegative(raw.costCents);
  const durationMs = nonNegative(raw.durationMs);
  const completedAtMs = nonNegative(raw.completedAtMs);
  if (
    seed === null ||
    iterations === null ||
    costCents === null ||
    durationMs === null ||
    completedAtMs === null
  ) {
    return null;
  }
  return { seed, iterations, costCents, durationMs, completedAtMs };
}

/** The measured token fields of a record, validated together. */
interface RecordTokens {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly unreportedUsageCalls: number;
}

/**
 * Validate the token counts; ALL are required, so a missing one drops the record.
 *
 * Required rather than defaulted for the same reason `instrumentValidity` is: a default of
 * 0 is not a neutral placeholder here, it is the numerator of the campaign's headline
 * efficiency figure, and a zero would report the sample as having been produced for free.
 * `unreportedUsageCalls` is required for the mirror reason - without it a reader cannot
 * tell whether the counts beside it are complete or floors.
 *
 * Split out of `decodeMeasurement` rather than folded into it so each validator stays one
 * readable guard, matching `decodeMutationNumbers`.
 */
function decodeTokenCounts(raw: Record<string, unknown>): RecordTokens | null {
  const promptTokens = nonNegativeInt(raw.promptTokens);
  const completionTokens = nonNegativeInt(raw.completionTokens);
  const totalTokens = nonNegativeInt(raw.totalTokens);
  const unreportedUsageCalls = nonNegativeInt(raw.unreportedUsageCalls);
  if (
    promptTokens === null ||
    completionTokens === null ||
    totalTokens === null ||
    unreportedUsageCalls === null
  ) {
    return null;
  }
  return { promptTokens, completionTokens, totalTokens, unreportedUsageCalls };
}

/** A survivor-operator list from an untrusted record: bounded, closed-set, order kept. */
function decodeSurvivedOperators(raw: unknown): readonly MutationOperatorId[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const operators: MutationOperatorId[] = [];
  for (const entry of raw.slice(0, MAX_RECORDED_SURVIVORS)) {
    const operator = member(entry, MUTATION_OPERATORS);
    if (operator === null) {
      return null;
    }
    operators.push(operator);
  }
  return operators;
}

/** The numeric fields of a persisted mutation block, split out to keep the decoder small. */
type MutationCountNumbers = Omit<
  MutationSampleCounts,
  'coverageGapOperators' | 'candidateEquivalentOperators'
>;

/** The nested block's numeric fields, or `null` when any one of them is unreadable. */
function decodeMutationNumbers(record: Record<string, unknown>): MutationCountNumbers | null {
  const validCount = nonNegativeInt(record.validCount);
  const killedCount = nonNegativeInt(record.killedCount);
  const noVerdictKills = nonNegativeInt(record.noVerdictKills);
  const goldenSurvivedCount = nonNegativeInt(record.goldenSurvivedCount);
  const goldenTimeoutCount = nonNegativeInt(record.goldenTimeoutCount);
  const nonCompilingCount = nonNegativeInt(record.nonCompilingCount);
  const goldenErroredCount = nonNegativeInt(record.goldenErroredCount);
  const elapsedMs = nonNegative(record.elapsedMs);
  if (
    validCount === null ||
    killedCount === null ||
    noVerdictKills === null ||
    goldenSurvivedCount === null ||
    goldenTimeoutCount === null ||
    nonCompilingCount === null ||
    goldenErroredCount === null ||
    elapsedMs === null
  ) {
    return null;
  }
  return {
    validCount,
    killedCount,
    noVerdictKills,
    goldenSurvivedCount,
    goldenTimeoutCount,
    nonCompilingCount,
    goldenErroredCount,
    elapsedMs,
  };
}

/**
 * Decode the nested mutation counts, or `null` when the sample was not probed.
 *
 * Strict in the same way the rest of the record is: a partially readable block is dropped
 * whole rather than repaired, because a kill count without the VALID count it is a fraction of
 * would enter the summary as a kill rate that is not a fraction of anything real. `null` (not
 * probed) and unreadable therefore land in the same place - "no mutation evidence" - which is
 * the fail-safe direction, since the summary reports absent evidence as NOT MEASURED.
 *
 * The three internal-consistency checks are refusals, not repairs. More kills than valid
 * mutants, more no-verdict kills than kills, or more golden survivors than valid mutants each
 * mean the block did not come from a real probe, and inventing a plausible reading of it would
 * put a fabricated kill rate in a cited number.
 */
function decodeMutationCounts(raw: unknown): MutationSampleCounts | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const numbers = decodeMutationNumbers(record);
  const coverageGapOperators = decodeSurvivedOperators(record.coverageGapOperators);
  const candidateEquivalentOperators = decodeSurvivedOperators(record.candidateEquivalentOperators);
  if (numbers === null || coverageGapOperators === null || candidateEquivalentOperators === null) {
    return null;
  }
  if (
    numbers.killedCount > numbers.validCount ||
    numbers.noVerdictKills > numbers.killedCount ||
    numbers.goldenSurvivedCount > numbers.validCount
  ) {
    return null;
  }
  return { ...numbers, coverageGapOperators, candidateEquivalentOperators };
}

/**
 * Whether an untrusted golden-outcome value is READABLE at all.
 *
 * Absent and explicit `null` are readable and mean "this sample was never judged", which is a
 * real state the harness records. Anything else must be one of the five recorded kinds, and a
 * value outside them DROPS the whole record rather than degrading to `null`.
 *
 * That is deliberately stricter than `stopReason` and `instrumentDefect`, which do degrade.
 * `null` is not a neutral placeholder here: it asserts nobody judged the sample, so it would
 * move a judged sample from the golden denominator into the `unjudged` exclusion bucket and
 * quietly change both the numerator's divisor and the reason an operator is shown for it. The
 * value that most needs refusing is `error`, the banner-grammar kind older records carry: its
 * three causes are exactly what the widened vocabulary exists to distinguish, and there is no
 * reading of it that is not an invented cause.
 */
function readsAsGoldenKind(value: unknown): boolean {
  return value === null || value === undefined || member(value, GOLDEN_KINDS) !== null;
}

/**
 * Decode one untrusted record, or `null` when it is not a complete, valid record.
 *
 * Strict on purpose: a half-written or hand-edited line is DROPPED rather than
 * repaired, because a record with a plausible-looking default would enter the resume
 * index and the pass@k aggregation as if it were a real measured sample. `instrumentValidity`
 * is required for exactly that reason - defaulting it would invent a validated instrument,
 * and `goldenVerdict` is refused for the mirror reason (see `readsAsGoldenKind`).
 */
export function decodeSampleRecord(raw: unknown): SweepSampleRecord | null {
  const record = asRecord(raw);
  if (record === null || record.schemaVersion !== RESULTS_SCHEMA_VERSION) {
    return null;
  }
  const identity = decodeIdentity(record);
  const measurement = decodeMeasurement(record);
  const tokens = decodeTokenCounts(record);
  const outcomeStatus = member(record.outcomeStatus, OUTCOME_STATUSES);
  const instrumentValidity = member(record.instrumentValidity, INSTRUMENT_VALIDITIES);
  if (
    identity === null ||
    measurement === null ||
    tokens === null ||
    outcomeStatus === null ||
    instrumentValidity === null ||
    !readsAsGoldenKind(record.goldenVerdict)
  ) {
    return null;
  }
  if (typeof record.passed !== 'boolean' || typeof record.costKnown !== 'boolean') {
    return null;
  }
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    ...identity,
    ...measurement,
    ...tokens,
    passed: record.passed,
    outcomeStatus,
    costKnown: record.costKnown,
    stopReason: optionalMember(record.stopReason, STOP_REASONS),
    goldenVerdict: optionalMember(record.goldenVerdict, GOLDEN_KINDS),
    goldenFailureCount: nonNegativeInt(record.goldenFailureCount),
    instrumentValidity,
    instrumentDefect: optionalMember(record.instrumentDefect, INSTRUMENT_DEFECTS),
    mutation: decodeMutationCounts(record.mutation),
    failureNote: str(record.failureNote),
    // Read leniently, unlike `instrumentValidity`, and the asymmetry is deliberate. An
    // unreadable cause resolves to `null`, which is NOT deferrable, so the slot reads as
    // final - the same reading it had before this field existed. The alternative, dropping
    // the whole record, would push a VERIFIED sample out of the index and re-charge for a
    // measurement that is already on disk. Being wrong towards "final" costs a re-run the
    // operator can ask for; being wrong towards "retry" spends money on its own.
    noVerdictCause: optionalMember(record.noVerdictCause, NO_VERDICT_CAUSES),
  };
}

/**
 * Rebuild the instrument verdict union from a record's flat fields.
 *
 * A record's `instrumentDefect` is untrusted, so an `invalid` record with no readable defect
 * resolves to `CONTROL_RUN_ERRORED` - still invalid, which is the fail-safe direction: the
 * sample stays out of the pass@k denominator. An `unchecked` record's reason is not
 * persisted (see `SweepSampleRecord.instrumentDefect`), so it reads back as
 * `control-unavailable`: "the control did not speak for this sample", which is the only
 * claim the record supports.
 */
export function instrumentVerdictOf(record: SweepSampleRecord): RecordedInstrumentVerdict {
  if (record.instrumentValidity === 'valid') {
    return { validity: 'valid' };
  }
  if (record.instrumentValidity === 'invalid') {
    return { validity: 'invalid', defect: record.instrumentDefect ?? 'CONTROL_RUN_ERRORED' };
  }
  return { validity: 'unchecked', reason: 'control-unavailable' };
}

/** How healthy the results file a summary was computed from is. */
export interface ResultsLogHealth {
  /** Non-blank lines that did not decode; surfaced so corruption is visible. */
  readonly malformedLines: number;
  /**
   * Lines that ARE records but were written at an older schema version.
   *
   * Counted separately from `malformedLines` because they are not corruption and the
   * remedy is different: corruption costs the affected lines, whereas a stale schema means
   * the whole file must not be aggregated at all (see `STALE_SCHEMA_ADVICE`).
   */
  readonly staleSchemaLines: number;
}

/** What reading a results log produced, including how much of it was unusable. */
export interface ParsedResultsLog extends ResultsLogHealth {
  readonly records: readonly SweepSampleRecord[];
}

/** How one line of a results log classified. */
type LineOutcome =
  | { readonly kind: 'record'; readonly record: SweepSampleRecord }
  | { readonly kind: 'stale' }
  | { readonly kind: 'malformed' };

/**
 * Parse a whole results log.
 *
 * Blank lines are ignored; every other line is a record, a stale-schema record, or
 * malformed. Never throws, so a corrupt file degrades a resume into extra work rather than
 * into a crash - and a stale file degrades into a loud refusal rather than a wrong number.
 */
export function parseResultsLog(text: string): ParsedResultsLog {
  const records: SweepSampleRecord[] = [];
  let malformedLines = 0;
  let staleSchemaLines = 0;
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    const outcome = decodeLine(line);
    if (outcome.kind === 'record') {
      records.push(outcome.record);
    } else if (outcome.kind === 'stale') {
      staleSchemaLines += 1;
    } else {
      malformedLines += 1;
    }
  }
  return { records, malformedLines, staleSchemaLines };
}

/** Decode one line's JSON then its shape, classifying a stale schema separately. */
function decodeLine(line: string): LineOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    // A non-JSON line is corruption, not an error to propagate: the caller counts it.
    return { kind: 'malformed' };
  }
  const record = decodeSampleRecord(raw);
  if (record !== null) {
    return { kind: 'record', record };
  }
  return readsAsOlderSchema(raw) ? { kind: 'stale' } : { kind: 'malformed' };
}

/**
 * Whether a line looks like a real record written at an EARLIER schema version.
 *
 * Deliberately narrow: it must be an object carrying an integer `schemaVersion` below the
 * current one. A line with a garbage or future version is corruption, not history, and is
 * counted as malformed so the stale-schema refusal cannot be triggered by noise.
 */
function readsAsOlderSchema(raw: unknown): boolean {
  const record = asRecord(raw);
  const version = record?.schemaVersion;
  return (
    typeof version === 'number' && Number.isInteger(version) && version < RESULTS_SCHEMA_VERSION
  );
}

/**
 * The set of sample slots already completed for one experiment.
 *
 * Built ONLY from records whose `configHash` matches, so a results file that also
 * holds another experiment's records cannot leak them into this run's resume decision.
 *
 * A DEFERRED record does not complete its slot. That is the whole content of this class
 * beyond the config scoping: a record whose `noVerdictCause` is infrastructure describes an
 * attempt, not a measurement, so the slot stays outstanding and the next run takes it again.
 *
 * WHY THE DECISION IS DERIVED HERE AND NOT REMEMBERED SOMEWHERE
 *   The alternative was to keep a side list of slots to retry. That list would have to
 *   survive `kill -9` between the moment a sample is deferred and the moment the list is
 *   written, and a resume is frequently a DIFFERENT PROCESS - which is exactly how the
 *   original defect was measured. Instead the index is rebuilt from the file on every start
 *   and `isDeferredSample` is a pure function of one persisted line, so any process reading
 *   the file reaches the same conclusion, and there is no window in which a crash can lose
 *   the deferral. The record write is one atomic append; nothing else has to happen.
 */
export class CompletedSampleIndex {
  readonly #keys: ReadonlySet<string>;
  readonly #deferredKeys: ReadonlySet<string>;

  private constructor(keys: ReadonlySet<string>, deferredKeys: ReadonlySet<string>) {
    this.#keys = keys;
    this.#deferredKeys = deferredKeys;
  }

  /**
   * Build the index for `configHash` from already-parsed records.
   *
   * ORDER-INDEPENDENT by construction: completed keys are only ever ADDED, and a deferred
   * record adds nothing. A slot that was deferred and later retried successfully therefore
   * resolves to complete no matter which of its two lines the file holds first - which
   * matters because samples finish out of order under concurrency.
   */
  static fromRecords(
    records: readonly SweepSampleRecord[],
    configHash: string,
  ): CompletedSampleIndex {
    const keys = new Set<string>();
    const deferred = new Set<string>();
    for (const record of records) {
      if (record.configHash !== configHash) {
        continue;
      }
      const key = sampleKey(record.armName, record.problemId, record.sampleIndex);
      if (isDeferredSample(record)) {
        deferred.add(key);
        continue;
      }
      keys.add(key);
    }
    for (const key of keys) {
      deferred.delete(key);
    }
    return new CompletedSampleIndex(keys, deferred);
  }

  /** How many sample slots are already complete for this experiment. */
  size(): number {
    return this.#keys.size;
  }

  /**
   * How many slots this file ATTEMPTED and did not measure, and will run again.
   *
   * Slots with a deferred record and no completed one. Surfaced so a resume can say out
   * loud that part of its work is re-running an outage rather than extending the matrix.
   */
  deferredSize(): number {
    return this.#deferredKeys.size;
  }

  /**
   * Whether this sample slot is already recorded and must be SKIPPED.
   *
   * The single resume decision in the sweep: `true` means no model call, no sandbox
   * run, and no second record for a sample that was already paid for.
   */
  isComplete(armName: string, problemId: string, sampleIndex: number): boolean {
    return this.#keys.has(sampleKey(armName, problemId, sampleIndex));
  }
}

/** The append-only sink and source the sweep persists its samples through. */
export interface ResultsLogPort {
  /** Append one line durably enough that a later crash cannot lose it. */
  appendLine(line: string): Promise<void>;
  /** The whole log's text, or `''` when it does not exist yet. */
  readAll(): Promise<string>;
}
