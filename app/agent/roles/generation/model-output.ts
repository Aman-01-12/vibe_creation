// Boundary validation for untrusted Generation_Agent model output (Req 17.5).
//
// The Model_Router returns provider text, which is UNTRUSTED like any external
// content: it may be malformed, oversized, or adversarial. This module is the
// single trust boundary that shapes that text into a validated RTL string before
// any interface parsing or compilation runs on it. The RTL is never evaluated; it
// is only ever written into the sandbox workspace by the injected compiler. If the
// output cannot be shaped, parsing fails closed with a typed error.

import { err, ok, type Result } from '@app/core';

import { parseJsonEnvelope } from '../model-output-envelope.js';

/** Longest accepted RTL payload, to bound memory from untrusted output. */
const MAX_RTL_CHARS = 200_000;

/** Why shaping untrusted model output into RTL failed (short, non-sensitive). */
export interface RtlParseError {
  readonly reason: string;
}

/** A record with unknown-typed values, the shape of parsed-but-unvalidated JSON. */
type UnknownRecord = Readonly<Record<string, unknown>>;

/** Whether a value is a non-array JSON object we can read fields from. */
function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Shape untrusted model text into a validated RTL string.
 *
 * The model is instructed to return a JSON object `{ "rtl": "<verilog>" }`. The
 * `rtl` field must be a non-empty, length-bounded string; anything else fails
 * closed so a caller never parses or compiles unshaped output. A provider may wrap
 * that object in a markdown code fence, which is presentation and not a contract
 * violation, so the shared envelope helper strips one fence before parsing; the
 * field checks below are unchanged, and bare RTL with no envelope still fails.
 */
export function parseCandidateRtl(raw: string): Result<string, RtlParseError> {
  const envelope = parseJsonEnvelope(raw);
  if (!envelope.ok) {
    return err({ reason: 'model output was not valid JSON' });
  }
  if (!isRecord(envelope.value)) {
    return err({ reason: 'model output was not a JSON object' });
  }
  const rtl = envelope.value.rtl;
  if (typeof rtl !== 'string' || rtl.trim().length === 0) {
    return err({ reason: 'model output was missing a non-empty "rtl" string' });
  }
  if (rtl.length > MAX_RTL_CHARS) {
    return err({ reason: 'generated RTL exceeded the maximum accepted size' });
  }
  return ok(rtl);
}
