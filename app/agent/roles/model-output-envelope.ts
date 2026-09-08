// The JSON-envelope boundary shared by every role's untrusted model-output parser.
//
// PLACEMENT: this sits at the `roles/` level, a peer of each role directory, and
// deliberately NOT in `model-router/`. The two concerns look similar but have
// different owners: `model-router/chat-completions-reply.ts` validates the
// PROVIDER's transport envelope (`choices[0].message.content`), whereas this
// validates the envelope OUR ROLE PROMPTS asked for (`{"source": ...}`,
// `{"rtl": ...}`, `{"claims": [...]}`). That contract is defined by role prompts,
// so it belongs to the roles layer. Roles already import types from
// `model-router/`, and keeping this here avoids adding a runtime dependency from a
// role onto the transport module for something transport knows nothing about.
//
// WHY IT EXISTS: providers routinely wrap a correct JSON reply in a markdown code
// fence. That is a PRESENTATION wrapper, not a contract violation - the observed
// bedrock-mantle reply carried a well-formed, correctly escaped envelope inside
// ```json ... ```, with `finish_reason: "stop"` and no truncation. Five role
// parsers each did a strict `JSON.parse` and rejected those replies identically,
// so the unwrap lives in exactly one tested place instead of five.
//
// WHAT IT DELIBERATELY DOES NOT DO: it removes a wrapper and nothing else. It does
// not repair malformed JSON, does not accept a bare non-JSON payload (e.g. raw RTL
// with no envelope), and does not validate or relax a single field. Every caller
// keeps its own object check, field checks, size bounds, and error vocabulary
// exactly as strict as before; accepting a non-conforming reply would hide a model
// that is not honouring the contract, which is a signal we want to keep.

import { err, ok, type Result } from '@app/core';

/**
 * A markdown fence OPENING line: only optional whitespace, three or more
 * backticks, and an optional language tag.
 *
 * The tag is discarded, never matched against an allowlist, so ```json, ```JSON,
 * and ```verilog are treated identically: the tag is the provider's presentation
 * metadata and says nothing about whether the body honours the role's contract.
 * Written so no two adjacent quantifiers accept the same character, which keeps
 * matching linear over untrusted input rather than backtracking.
 */
const OPENING_FENCE_LINE = /^[ \t\r]*`{3,}[ \t\r]*(?:[A-Za-z0-9_+.-]+[ \t\r]*)?$/m;

/** A markdown fence CLOSING line: backticks alone, with no language tag. */
const CLOSING_FENCE_LINE = /^[ \t\r]*`{3,}[ \t\r]*$/m;

/** The line break that terminates the opening fence line, in LF or CRLF form. */
const LEADING_LINE_BREAK = /^\r?\n/;

/**
 * Why the text carried no JSON value at all, with or without a fence.
 *
 * There is exactly one failure mode by design, so callers map it onto their own
 * existing "was not valid JSON" wording rather than reading a reason out of it.
 * That keeps every role's error vocabulary byte-identical to before this helper.
 */
export interface JsonEnvelopeParseFailure {
  readonly kind: 'not-json';
}

/** The single failure value, shared because it carries no per-call detail. */
const NOT_JSON: JsonEnvelopeParseFailure = { kind: 'not-json' };

/**
 * A successfully parsed JSON value, boxed.
 *
 * The box is not incidental: `JSON.parse('null')` legitimately yields `null`, so a
 * bare `unknown | null` return could not tell "parsed to null" from "did not
 * parse". Conflating them would reclassify the input `"null"` from each caller's
 * "not a JSON object" error to its "not valid JSON" error - a behaviour change.
 */
interface ParsedJson {
  readonly value: unknown;
}

/** Parse text as JSON, returning null instead of throwing on a syntax error. */
function tryParseJson(text: string): ParsedJson | null {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return null;
  }
}

/**
 * The body of the first markdown code fence in the text, or null when there is no
 * opening fence or the fence is empty.
 *
 * The body is returned VERBATIM. Callers such as the testbench parser hand their
 * decoded string straight to the simulator, so this must not normalize line
 * endings or trim content: only the fence lines themselves are removed. A missing
 * closing fence (a truncated reply) unwraps to the end of the text, and a closing
 * fence is required to be backticks alone on their own line, so a second fenced
 * block with a language tag cannot be mistaken for the first block's terminator.
 *
 * Scanning is regex + substring rather than a line split, so an oversized
 * untrusted reply is not amplified into a large array of lines. The two
 * substrings allocated here are bounded by a text the caller already ran
 * `JSON.parse` over.
 */
function unwrapCodeFence(text: string): string | null {
  const opening = OPENING_FENCE_LINE.exec(text);
  if (opening === null) {
    return null;
  }
  const afterOpeningLine = text
    .slice(opening.index + opening[0].length)
    .replace(LEADING_LINE_BREAK, '');
  const closing = CLOSING_FENCE_LINE.exec(afterOpeningLine);
  const body = closing === null ? afterOpeningLine : afterOpeningLine.slice(0, closing.index);
  return body.trim().length === 0 ? null : body;
}

/**
 * Read the JSON value out of untrusted model text, tolerating one markdown fence.
 *
 * Fallback order, strict first:
 *   1. `JSON.parse` the text exactly as received. Text that parsed before this
 *      helper existed still takes this path, so behaviour for it is unchanged.
 *   2. Only when step 1 fails, strip a single markdown code fence and re-parse.
 *   3. Otherwise fail, so the caller returns the same error it always returned.
 *
 * The returned value is UNVALIDATED: it is whatever JSON the model sent. Every
 * caller must still check that it is an object and validate each field.
 */
export function parseJsonEnvelope(raw: string): Result<unknown, JsonEnvelopeParseFailure> {
  const asReceived = tryParseJson(raw);
  if (asReceived !== null) {
    return ok(asReceived.value);
  }
  const fencedBody = unwrapCodeFence(raw);
  if (fencedBody === null) {
    return err(NOT_JSON);
  }
  const unfenced = tryParseJson(fencedBody);
  return unfenced === null ? err(NOT_JSON) : ok(unfenced.value);
}
