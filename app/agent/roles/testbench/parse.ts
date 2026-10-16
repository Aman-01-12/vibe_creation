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

import { extractSingleFencedBlock, parseJsonEnvelope } from '../model-output-envelope.js';

import type { TestbenchDraft } from './types.js';

/**
 * Largest accepted testbench source, to bound memory from untrusted output.
 *
 * Generous enough for a thorough single-module testbench, small enough that an
 * adversarial or runaway reply cannot exhaust memory at this boundary.
 */
const MAX_SOURCE_CHARS = 200_000;

/** Every way the parsers refuse a reply; the first four are the JSON parser's (Req 7.8). */
export const TESTBENCH_PARSE_REFUSALS = [
  'not-json',
  'not-object',
  'empty-source',
  'oversize-source',
  'no-fence',
  'multiple-fences',
  'unterminated-fence',
] as const;
export type TestbenchParseRefusal = (typeof TESTBENCH_PARSE_REFUSALS)[number];

/** The fixed sentence for each refusal; never model text, so it is safe to log and record. */
const PARSE_REFUSAL_REASONS: Readonly<Record<TestbenchParseRefusal, string>> = {
  'not-json': 'model output was not valid JSON',
  'not-object': 'model output was not a JSON object',
  'empty-source': 'model output was missing a non-empty testbench source',
  'oversize-source': 'testbench source exceeded the maximum accepted size',
  'no-fence': 'model output contained no fenced code block',
  'multiple-fences': 'model output contained more than one fenced code block',
  'unterminated-fence': 'model output contained an unterminated fenced code block',
};

/** Why shaping untrusted model output into a draft failed (non-sensitive). */
export interface TestbenchParseError {
  readonly refusal: TestbenchParseRefusal;
  /** The fixed sentence for `refusal`. */
  readonly reason: string;
}

/** Build a parse error from its closed code. */
function parseError(refusal: TestbenchParseRefusal): TestbenchParseError {
  return { refusal, reason: PARSE_REFUSAL_REASONS[refusal] };
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
    return err(parseError('not-json'));
  }
  if (!isRecord(envelope.value)) {
    return err(parseError('not-object'));
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
  if (typeof source !== 'string') {
    return err(parseError('empty-source'));
  }
  return boundedDraft(source);
}

/** The empty-after-trim rule, then the size bound, over an extracted source. */
function boundedDraft(source: string): Result<TestbenchDraft, TestbenchParseError> {
  if (source.trim().length === 0) {
    return err(parseError('empty-source'));
  }
  if (source.length > MAX_SOURCE_CHARS) {
    return err(parseError('oversize-source'));
  }
  return ok({ source });
}

/**
 * The Grounded_Arm parser: exactly one complete fenced block, taken verbatim (Req 7.2-7.7).
 * Prose around the block is accepted; zero, two, or an unclosed block is refused.
 */
export function parseFencedTestbenchDraft(
  raw: string,
): Result<TestbenchDraft, TestbenchParseError> {
  const block = extractSingleFencedBlock(raw);
  if (!block.ok) {
    return err(parseError(block.error));
  }
  return boundedDraft(block.value);
}
