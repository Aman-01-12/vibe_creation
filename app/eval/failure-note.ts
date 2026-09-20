// The sample failure note: the one sanitized line that says WHY a sample carries no
// oracle verdict.
//
// WHY THIS EXISTS
//   A status on its own is undiagnosable. Three hundred `setup-failed` samples read
//   identically whether the credential expired, the host refused every generation call,
//   or the independent testbench never covered the acceptance criteria - and the
//   Verification_Loop KNEW which it was. It built that reason, streamed it as a progress
//   event, and returned it on the outcome; every layer below then kept only
//   `outcome.status`, so an overnight campaign could report a wall of failures with
//   nothing an operator could act on. This module derives the note that survives.
//
// SANITIZED BY CONSTRUCTION, NOT BY FILTERING
//   A note is assembled ONLY from values this repo wrote: the loop's own
//   `VerificationSetupFailed.detail` (documented as short and non-sensitive) and the
//   generation gate's refusal discriminant, mapped through the table below. Nothing
//   derived from a thrown error, a provider payload, a path, or model output reaches it.
//   The layers holding those drop them deliberately (`EvalHarness#drive`,
//   `SweepRunner#runUnit`), and this must not reintroduce them by another door.
//
// BOUNDED, BECAUSE IT LANDS IN AN APPEND-ONLY FILE
//   The note is persisted as one field of one JSONL line that a resume and every summary
//   read back, and it is printed to an operator's terminal mid-run. So it is flattened to
//   a single line and capped: control and format characters collapse to single spaces,
//   and the result is truncated. A pathological detail costs a clause, never the
//   readability of the results file.
//
// Pure: no clock, no I/O, no randomness.

import type {
  GenerationGateRefusal,
  GenerationGateRefusalReason,
  VerificationOutcome,
} from '@app/agent';

/** Longest note a record may carry, in characters; a longer one is truncated to fit. */
export const MAX_FAILURE_NOTE_LENGTH = 300;

/**
 * Control and format characters, matched in runs so each run collapses to one space.
 *
 * `Cc` covers the newlines, tabs, and DEL that would otherwise split one record's note
 * across several printed lines; `Cf` covers the zero-width and bidi-override characters
 * that can reorder what an operator reads without changing the bytes.
 */
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]+/gu;

/**
 * What each gate refusal means for the operator; our own words, never the caller's.
 *
 * Keyed by the whole reason union, so a refusal reason added to the gate cannot ship
 * without an operator-facing note: this table is the exhaustiveness anchor.
 */
const REFUSAL_SUMMARY: Readonly<Record<GenerationGateRefusalReason, string>> = {
  'intent-unconfirmed': 'the restated intent was never confirmed, so generation was inadmissible',
  'spec-unapproved': 'the spec was never approved, so generation was inadmissible',
  'persist-failed': 'the approved spec could not be persisted as the source of truth',
};

/** The refusal reasons a note is written for; a closed set, validated on read. */
const REFUSAL_REASONS: readonly GenerationGateRefusalReason[] = [
  'intent-unconfirmed',
  'spec-unapproved',
  'persist-failed',
];

/** The note for a refusal whose discriminant is not one this build recognizes. */
const UNRECOGNIZED_REFUSAL = 'blocked: the generation gate refused admission';

/**
 * The sanitized note explaining one terminal loop outcome, or `null` when the outcome
 * has nothing to explain.
 *
 * Exhaustive over `VerificationOutcome`, and deliberately silent for the two statuses
 * whose story the record already tells in full:
 *   - `verified`: there is no failure to explain.
 *   - `unverified`: the oracle DID reach a verdict, and the record's own `stopReason`
 *     and `iterations` already say how the session ended. A note here would duplicate
 *     two fields a consumer can already read and group by.
 *
 * `instrument-refused` DOES get a note, unlike `unverified`: it carries no `stopReason`
 * and no `iterations` a consumer could read instead, so `reason` is the only place the
 * cause lives.
 */
export function failureNoteOf(outcome: VerificationOutcome): string | null {
  switch (outcome.status) {
    case 'verified':
    case 'unverified':
      return null;
    case 'setup-failed':
      return boundNote(`${outcome.reason}: ${outcome.detail}`);
    case 'blocked':
      return boundNote(describeRefusal(outcome.refusal));
    case 'instrument-refused':
      return boundNote(`instrument-refused: ${outcome.reason}`);
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

/**
 * A sanitized description of a gate refusal.
 *
 * The DISCRIMINANT is the diagnostic - `intent-unconfirmed` and `persist-failed` need
 * different fixes from an operator - so the note carries that plus this module's own
 * summary of it. The refusal's `message` field is deliberately unused: only a value from
 * the closed reason set is ever echoed, so no free-form text can ride into a record.
 */
function describeRefusal(refusal: GenerationGateRefusal): string {
  const reason = knownRefusalReason(refusal);
  return reason === null ? UNRECOGNIZED_REFUSAL : `${reason}: ${REFUSAL_SUMMARY[reason]}`;
}

/**
 * The refusal's reason when it is one this build recognizes, else `null`.
 *
 * The outcome crosses the `EvalLoopRunner` PORT, so the refusal is NARROWED rather than
 * trusted, the same way the harness narrows a candidate's `rtl`: an implementation that
 * returns `blocked` with no refusal, or with a reason from a newer gate, must degrade to
 * the generic note. Throwing here would abort a campaign with hours invested in it over a
 * diagnostic string.
 */
function knownRefusalReason(refusal: unknown): GenerationGateRefusalReason | null {
  if (typeof refusal !== 'object' || refusal === null) {
    return null;
  }
  const reason = (refusal as { readonly reason?: unknown }).reason;
  return REFUSAL_REASONS.find((known) => known === reason) ?? null;
}

/**
 * Flatten a note onto one line and cap its length.
 *
 * The leading characters carry the classification that makes a note actionable - the
 * reason, then the detail - so a truncated note is still the useful part of it.
 */
function boundNote(note: string): string {
  return note.replace(CONTROL_CHARACTERS, ' ').trim().slice(0, MAX_FAILURE_NOTE_LENGTH);
}
