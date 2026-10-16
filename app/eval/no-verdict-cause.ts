// WHY a sample carries no oracle verdict, as a value - and whether that means the slot was
// MEASURED or merely ATTEMPTED.
//
// ============================================================================
// A TRANSPORT FAILURE IS NOT A MEASUREMENT. READ THIS BEFORE CHANGING ANYTHING.
// ============================================================================
//   A no-verdict sample is excluded from the pass@k denominator either way, so this
//   distinction cannot corrupt pass@k. What it decides is whether the matrix CELL is
//   finished. Measured on a real calibration pass (one arm, 46 problems, n=1): 24 healthy
//   samples, then 29 consecutive `setup-failed` samples with `ALL_PROVIDERS_FAILED`, then
//   recovery under a fresh breaker. Every one of those 29 was written to `results.jsonl`, so
//   a resume read them as "already recorded" and never ran them again. One rate-limit burst
//   permanently deleted 29 of 46 cells for that config hash, and the run reported itself
//   `completed`.
//
//   pass@k was not wrong. The MATRIX was two thirds missing and said so nowhere. That is the
//   defect this module exists to close: a cause that is infrastructure makes the sample
//   DEFERRED - recorded as evidence, excluded from the resume index, announced loudly - and a
//   cause that is a finding makes it FINAL.
//
// THE DISTINCTION MUST NEVER COME FROM A NOTE STRING
//   `SweepSampleRecord.failureNote` renders as `testbench-unavailable: ALL_PROVIDERS_FAILED`,
//   and matching that text would work today. It would also make an operator-facing message
//   load-bearing: reword the note, or truncate it at `MAX_FAILURE_NOTE_LENGTH`, and 29
//   deferred samples silently become 29 measurements again. The cause is therefore threaded
//   as a TYPED value from where it is actually known - `ModelRouterFailure.code`, through
//   `VerificationSetupFailed.cause` - and this module only maps closed unions onto each other.
//
// WHAT IS AND IS NOT DEFERRABLE, AND WHY THE LINE IS THERE
//   Deferrable means: nothing about the model or our testbench was observed, and a re-run
//   under a healthy transport would observe something. That is true of a provider that never
//   answered and of our own runner crashing. It is NOT true of a testbench that misses an
//   acceptance criterion, of a budget cap doing its job, or of an unapproved Spec - each of
//   those is reproducible and each is a finding the campaign exists to collect. Lumping the
//   two together would be the mirror defect: an infinite retry loop over a real result.
//
// Pure: no clock, no I/O, no randomness.

import type { SetupFailureCause } from '@app/agent';

import { reachedOracleVerdict } from './instrument-control.js';
import type { SampleOutcomeStatus } from './report.js';

/**
 * Why one sample reached no oracle verdict; a closed set, persisted per record.
 *
 * The first two are INFRASTRUCTURE (deferrable), the rest are FINDINGS (final). The split
 * itself lives in `DEFERRABLE_BY_CAUSE` below rather than in this comment, so there is
 * exactly one place a reader and the code can disagree - and it is a value.
 */
export type NoVerdictCause =
  /** No provider answered: the router exhausted its chain, or the breaker refused the call. */
  | 'provider-unreachable'
  /**
   * A provider ANSWERED and refused the credential. Deliberately not `provider-unreachable`:
   * the pilot's first run spent six slots on an expired key and recorded them as a network
   * failure, so a dead credential read as an outage. The remedy differs too, which is the test.
   */
  | 'provider-refused-credential'
  /** The sweep's own machinery failed: the loop runner threw, or returned no sample. */
  | 'harness-error'
  /** A configured Session_Budget cap stopped the session. The caps ARE the experiment. */
  | 'budget-exhausted'
  /** A provider answered and the answer could not be used: unparseable, or uncovered. */
  | 'model-output-unusable'
  /** The inputs could not admit a model call: unapproved Spec, no criteria, bad seed. */
  | 'inputs-inadmissible'
  /** The generation gate refused admission: intent unconfirmed, or spec unapproved. */
  | 'gate-refused'
  /**
   * The Testbench_Precheck or the Instrument_Admission port found the testbench
   * inadmissible, so the loop stopped before any iteration (Req 5.10). Kept distinct
   * from `gate-refused`: that cause is a generation-intent refusal decided before a
   * testbench exists, while this one is a deterministic build/validity refusal of the
   * testbench Loop_Setup already produced.
   */
  | 'instrument-refused';

/**
 * The causes that mean the slot was ATTEMPTED and not MEASURED.
 *
 * A `Record` over the whole union rather than a list of the `true` entries, so adding a cause
 * cannot compile until someone decides which side of the line it falls on. That decision is
 * the entire content of this module and it must never be reachable by omission.
 *
 * `harness-error` is deferrable on purpose, and it is the one entry with a real cost: a
 * DETERMINISTIC crash in our own code will be retried on every resume, spending wall clock
 * each time. The alternative is worse - our crash would permanently delete a matrix cell and
 * the run would still report itself complete - and the retry is bounded by the operator, who
 * sees the deferred count on every summary.
 */
const DEFERRABLE_BY_CAUSE: Readonly<Record<NoVerdictCause, boolean>> = Object.freeze({
  'provider-unreachable': true,
  // Deferrable: a refreshed credential makes the slot retakeable, and the per-request provider
  // means the next attempt reads the new value without a restart.
  'provider-refused-credential': true,
  'harness-error': true,
  'budget-exhausted': false,
  'model-output-unusable': false,
  'inputs-inadmissible': false,
  'gate-refused': false,
  'instrument-refused': false,
});

/**
 * What each cause means to an operator reading a summary; one sentence, no free text.
 *
 * A second total `Record` for the same reason the first one is total: a cause added to the
 * union must be GIVEN A MEANING before it compiles, rather than rendering as a bare
 * identifier a reader has to guess at. Both halves of the split are described in the same
 * vocabulary - attempted versus measured - so the two lines never argue.
 */
const DESCRIPTION_BY_CAUSE: Readonly<Record<NoVerdictCause, string>> = Object.freeze({
  'provider-unreachable': 'no provider answered, so nothing about the model was observed',
  'provider-refused-credential':
    'a provider answered and refused the configured credential, so nothing about the model was observed',
  'harness-error': 'our own sweep machinery failed before the oracle could speak',
  'budget-exhausted':
    'a configured Session_Budget cap stopped the session - the caps ARE the experiment',
  'model-output-unusable': 'a provider answered and the answer could not be used',
  'inputs-inadmissible': 'the inputs could not admit a model call',
  'gate-refused': 'the generation gate refused admission',
  'instrument-refused':
    'the testbench was refused as an instrument, so the sample was judged only by the ' +
    'independent testbench',
});

/**
 * Every cause, for validating an untrusted record; declaration order is the render order.
 *
 * DERIVED from `DEFERRABLE_BY_CAUSE`, never restated. A hand-written list is not checked for
 * totality, so widening the union would leave it behind silently - and an unlisted cause
 * decodes as `null`, which reads as NOT deferrable. That is the precise failure this module
 * exists to prevent, so the validator's alphabet is taken from the one table the compiler
 * already forces to be complete. The assertion is sound because the source is a frozen total
 * `Record` with literal keys: `Object.keys` of it is exactly this union at runtime.
 */
export const NO_VERDICT_CAUSES: readonly NoVerdictCause[] = Object.freeze(
  Object.keys(DEFERRABLE_BY_CAUSE) as NoVerdictCause[],
);

/** One operator-facing sentence for a cause (pure, total). */
export function describeNoVerdictCause(cause: NoVerdictCause): string {
  return DESCRIPTION_BY_CAUSE[cause];
}

/**
 * Whether a no-verdict sample with this cause must be RETRIED rather than treated as final.
 *
 * `null` - the record carries no cause - is NOT deferrable. It is the reading an older record
 * gets (see `SweepSampleRecord.noVerdictCause`), and re-running an unknown number of samples
 * from a campaign that has already been paid for is not a decision this predicate may take on
 * an operator's behalf. Those samples are counted and announced instead.
 */
export function isDeferrableCause(cause: NoVerdictCause | null): boolean {
  return cause === null ? false : DEFERRABLE_BY_CAUSE[cause];
}

/**
 * The terminal loop outcome this classifier reads, narrowed to what it needs.
 *
 * Structurally a subset of `VerificationOutcome` plus the harness's own `runner-error`, taken
 * as a parameter rather than importing `DriveOutcome` so this module stays pure and has no
 * dependency on the harness that calls it.
 */
export type ClassifiableOutcome =
  | { readonly status: 'verified' | 'unverified' | 'runner-error' }
  | { readonly status: 'blocked' }
  | { readonly status: 'setup-failed'; readonly cause: SetupFailureCause }
  | { readonly status: 'instrument-refused' };

/**
 * The eval-layer cause for one loop setup failure (pure, total).
 *
 * An exhaustive table rather than a switch, for the same reason `DEFERRABLE_BY_CAUSE` is one:
 * a cause added to the loop must be classified here before it compiles. The two unions are
 * deliberately separate - the loop's says why SETUP failed, this one says why the SAMPLE has
 * no verdict, and only this one has to describe a gate refusal or our own crash.
 */
const SETUP_CAUSE_TO_NO_VERDICT: Readonly<Record<SetupFailureCause, NoVerdictCause>> =
  Object.freeze({
    'provider-unreachable': 'provider-unreachable',
    'budget-exhausted': 'budget-exhausted',
    'model-output-unusable': 'model-output-unusable',
    'inputs-inadmissible': 'inputs-inadmissible',
  });

/**
 * Classify one terminal outcome, or `null` when the oracle DID reach a verdict (pure, total).
 *
 * `verified` and `unverified` both mean the oracle spoke, so there is no cause to record and
 * the slot is finished by the strongest possible evidence. Everything else names why it did
 * not.
 */
export function noVerdictCauseOf(outcome: ClassifiableOutcome): NoVerdictCause | null {
  switch (outcome.status) {
    case 'verified':
    case 'unverified':
      return null;
    case 'blocked':
      return 'gate-refused';
    case 'setup-failed':
      return SETUP_CAUSE_TO_NO_VERDICT[outcome.cause];
    case 'runner-error':
      return 'harness-error';
    case 'instrument-refused':
      return 'instrument-refused';
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

/**
 * Whether a persisted sample must be retried on resume rather than counted as recorded.
 *
 * The single rule the resume index and the summary both read, so "will be retried" and
 * "reported as deferred" cannot disagree. Both conditions are required: a cause on a sample
 * the oracle DID judge is not evidence of anything (the results file is untrusted input, and a
 * hand-edited line must not be able to make a verified sample re-run and re-charge).
 * `reachedOracleVerdict` is imported rather than restated for the same reason the pass@k
 * denominator imports it - a second copy of "the oracle spoke" could drift from the first.
 */
export function isDeferredSample(input: {
  readonly outcomeStatus: SampleOutcomeStatus;
  readonly noVerdictCause: NoVerdictCause | null;
}): boolean {
  return !reachedOracleVerdict(input.outcomeStatus) && isDeferrableCause(input.noVerdictCause);
}
