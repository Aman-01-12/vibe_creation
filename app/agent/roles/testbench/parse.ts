// Boundary validation for untrusted Testbench_Agent model output.
//
// The Model_Router returns provider text, which is UNTRUSTED like any external
// content: it may be malformed, oversized, or adversarial. This module is the
// single trust boundary that shapes that text into a bounded `TestbenchDraft`
// before any coverage validation runs on it. The model is asked to return a JSON
// object `{ "source": "<verilog testbench>" }`; parsing fails closed on non-JSON,
// a missing/empty source, or an oversized source, so the agent never proceeds on a
// guess. A provider may wrap that object in a markdown code fence, which is
// presentation and not a contract violation, so the shared envelope helper strips
// one fence before parsing - and nothing else.

import { type Result, err, ok } from '@app/core';

import { parseJsonEnvelope } from '../model-output-envelope.js';

import type { TestbenchDraft } from './types.js';

/**
 * Largest accepted testbench source, to bound memory from untrusted output.
 *
 * Generous enough for a thorough single-module testbench, small enough that an
 * adversarial or runaway reply cannot exhaust memory at this boundary.
 */
const MAX_SOURCE_CHARS = 200_000;

/** Why shaping untrusted model output into a draft failed (non-sensitive). */
export interface TestbenchParseError {
  readonly reason: string;
}

/** Build a parse error with a short, non-sensitive reason. */
function parseError(reason: string): TestbenchParseError {
  return { reason };
}

/** A record with unknown-typed values, the shape of parsed-but-unvalidated JSON. */
type UnknownRecord = Readonly<Record<string, unknown>>;

/** Whether a value is a non-array JSON object we can read fields from. */
function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse the model text as a JSON object, failing closed on any syntax error.
 *
 * The envelope helper strips at most a markdown code fence before parsing; the
 * object check below is unchanged, so a fenced reply is held to exactly the same
 * shape requirements as an unfenced one.
 */
function parseJson(raw: string): Result<UnknownRecord, TestbenchParseError> {
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
 * Shape untrusted model text into a bounded `TestbenchDraft` (Req 7.6 boundary).
 *
 * Requires a JSON object with a non-empty string `source` no longer than
 * `MAX_SOURCE_CHARS`. The source is returned verbatim (not trimmed) so the
 * downstream coverage check sees exactly what the Simulator would compile; only
 * its presence, type, and size are validated here.
 */
export function parseTestbenchDraft(raw: string): Result<TestbenchDraft, TestbenchParseError> {
  const jsonResult = parseJson(raw);
  if (!jsonResult.ok) {
    return jsonResult;
  }
  const { source } = jsonResult.value;
  if (typeof source !== 'string' || source.trim().length === 0) {
    return err(parseError('model output was missing a non-empty testbench source'));
  }
  if (source.length > MAX_SOURCE_CHARS) {
    return err(parseError('testbench source exceeded the maximum accepted size'));
  }
  return ok({ source });
}
