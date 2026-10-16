// Boundary validation for untrusted Property_Author model output.
//
// The Model_Router returns provider text, which is UNTRUSTED like any external content:
// it may be malformed, oversized, or adversarial. This module is the single trust
// boundary that shapes that text into bounded `PropertyDraft`s before anything reads
// them. It deliberately performs NO dialect checking: `validateExpression` in
// `@app/tools` is the single owner of the Property_Dialect, and a second, weaker copy of
// that rule here is how the two would drift. So the expressions below leave this module
// as plain `string`s, which cannot reach a `FormalProperty` - every expression field of
// one is a `ValidatedExpression`, and only the validator mints that brand (Req 6.8).
//
// FAIL CLOSED ON THE ENVELOPE, DROP A MALFORMED ENTRY. The two are different kinds of
// failure and are treated differently on purpose. A broken ENVELOPE (not JSON, not an
// object, `properties` not an array, more entries than the cap) means the model did not
// honour the contract at all, so nothing is salvaged and the caller reports every
// criterion unexpressed. A single malformed ENTRY is one per-criterion claim we cannot
// read; dropping it leaves that criterion with no draft of its own, so the caller
// reports it unexpressed, which is precisely the required behaviour (Req 6.17) and loses
// nothing - never a weaker property built from a half-readable entry.
//
// ORDER IS PART OF THE CONTRACT, because the caller's rule is a FIRST-draft rule.
// `derivePropertySet` considers only the first draft the model emitted for a criterion
// and reports that criterion unexpressed where the validator rejects it, rather than
// trying the next draft (Req 6.17, execution question E10) - that retry is the path by
// which a weaker fallback property slips in. So the drafts below are returned in the
// model's OWN emission order: never sorted, never reordered, never grouped by criterion,
// and duplicates never merged. Anything that reorders them here would silently change
// which draft the Property_Validator sees, with nothing in this module looking wrong.
//
// ONE RESIDUAL, recorded rather than decided here: where a criterion's FIRST entry is
// malformed and a LATER entry for the same criterion is readable, the later one becomes
// the first draft the caller sees, because an unreadable entry carries no draft to hold
// the slot. No requirement decides that case - Req 6.17's rule is worded over the
// validator's rejection - and deciding it inside this module would pin a behaviour the
// spec has not ratified, so it is left as the question it is.
//
// PRESENTATION IS TOLERATED, CONTENT IS NOT. A provider may wrap the object in a
// markdown code fence, so the shared envelope helper strips one fence before parsing -
// and nothing else. An ABSENT `antecedent` key is read as `null` for the same reason: a
// model omitting a null field is presentation, whereas a combinational entry carrying an
// antecedent is a CONTENT violation and is refused, because neither honouring nor
// discarding that antecedent would be what the model wrote.

import { type Result, err, ok } from '@app/core';

import { parseJsonEnvelope } from '../model-output-envelope.js';

/**
 * Largest accepted number of drafts in one reply, to bound memory from untrusted output.
 *
 * Far above any plausible Spec's criteria count (the corpus references carry a handful
 * each), and small enough that an adversarial reply cannot make the caller walk an
 * unbounded array. Exceeding it fails the ENVELOPE rather than truncating, because a
 * silent truncation would drop criteria without recording that it had.
 */
const MAX_PROPERTY_DRAFTS = 100;

/** Which of the two accepted property forms a draft claims to be (Req 6.1, 6.2). */
export type PropertyDraftKind = 'clocked' | 'combinational';

/**
 * One untrusted property claim the model emitted: shaped, bounded, and NOT yet
 * dialect-checked.
 *
 * `criterionId` is whatever the model copied back; membership in the Spec's own criteria
 * is decided by the caller, which is also what keeps the id's length bounded in practice.
 * There is no `clock` field: a clocked property's clock comes from the Spec's
 * `ClockingContract`, never from model text.
 */
export interface PropertyDraft {
  readonly criterionId: string;
  readonly kind: PropertyDraftKind;
  /** The gating condition of a clocked property; `null` when unconditional. */
  readonly antecedent: string | null;
  readonly consequent: string;
}

/** Why shaping untrusted model output into drafts failed (non-sensitive). */
export interface PropertyParseError {
  readonly reason: string;
}

/** Build a parse error with a short, non-sensitive reason. */
function parseError(reason: string): PropertyParseError {
  return { reason };
}

/** A record with unknown-typed values, the shape of parsed-but-unvalidated JSON. */
type UnknownRecord = Readonly<Record<string, unknown>>;

/** Whether a value is a non-array JSON object we can read fields from. */
function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a value is a non-blank string. */
function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Parse the model text as a JSON object, failing closed on any syntax error.
 *
 * The envelope helper strips at most a markdown code fence before parsing; the object
 * check below is unchanged, so a fenced reply is held to exactly the same shape
 * requirements as an unfenced one.
 */
function parseJson(raw: string): Result<UnknownRecord, PropertyParseError> {
  const envelope = parseJsonEnvelope(raw);
  if (!envelope.ok) {
    return err(parseError('model output was not valid JSON'));
  }
  if (!isRecord(envelope.value)) {
    return err(parseError('model output was not a JSON object'));
  }
  return ok(envelope.value);
}

/**
 * Read one entry's antecedent, treating an absent key as `null`.
 *
 * Returns `undefined` for a present-but-unreadable value, which the caller drops. The
 * three cases are genuinely distinct: absent is presentation, `null` is "unconditional",
 * and a non-string is a contract violation.
 */
function readAntecedent(entry: UnknownRecord): string | null | undefined {
  const { antecedent } = entry;
  if (antecedent === undefined || antecedent === null) {
    return null;
  }
  return isNonBlankString(antecedent) ? antecedent : undefined;
}

/**
 * Shape one untrusted entry into a draft, or `null` when it cannot be read.
 *
 * A combinational entry carrying an antecedent is refused rather than silently stripped:
 * dropping the antecedent would STRENGTHEN the property into one the model did not
 * write, which can refute a correct design, and honouring it is not a form the dialect
 * has. Refusing leaves the criterion unexpressed, which is the honest outcome.
 */
function shapeDraft(value: unknown): PropertyDraft | null {
  if (!isRecord(value)) {
    return null;
  }
  const { criterionId, kind, consequent } = value;
  if (!isNonBlankString(criterionId) || !isNonBlankString(consequent)) {
    return null;
  }
  if (kind !== 'clocked' && kind !== 'combinational') {
    return null;
  }
  const antecedent = readAntecedent(value);
  if (antecedent === undefined) {
    return null;
  }
  if (kind === 'combinational' && antecedent !== null) {
    return null;
  }
  return { criterionId, kind, antecedent, consequent };
}

/**
 * Shape untrusted model text into bounded `PropertyDraft`s (Req 6.8 boundary).
 *
 * Requires a JSON object whose `properties` field is an array of at most
 * `MAX_PROPERTY_DRAFTS` entries. Well-shaped entries are returned in the model's own
 * EMISSION ORDER, which the caller's first-draft rule depends on (Req 6.17); unreadable
 * ones are dropped, leaving their criteria to be reported unexpressed by the caller.
 * Expressions are returned VERBATIM - no trim, no normalization, no repair - so the
 * validator sees exactly what the model wrote (Req 6.10).
 */
export function parsePropertyDrafts(
  raw: string,
): Result<readonly PropertyDraft[], PropertyParseError> {
  const jsonResult = parseJson(raw);
  if (!jsonResult.ok) {
    return jsonResult;
  }
  const { properties } = jsonResult.value;
  if (!Array.isArray(properties)) {
    return err(parseError('model output was missing a "properties" array'));
  }
  if (properties.length > MAX_PROPERTY_DRAFTS) {
    return err(parseError('model output exceeded the maximum accepted property count'));
  }
  const drafts: PropertyDraft[] = [];
  for (const entry of properties) {
    const draft = shapeDraft(entry);
    if (draft !== null) {
      drafts.push(draft);
    }
  }
  return ok(drafts);
}
