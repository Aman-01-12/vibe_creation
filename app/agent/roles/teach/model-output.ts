// Boundary validation for untrusted Teach_Mode model output.
//
// The Model_Router returns provider text, which is UNTRUSTED input like any other
// external content: it may be malformed, oversized, or adversarial. This module is
// the single trust boundary that shapes that text into validated `ProposedClaim`s
// before any grounding logic runs on it. Nothing downstream re-parses model text.
//
// Shaping here NEVER grants grounding - it only validates SHAPE. A claim whose
// cited artifact reference or citation is malformed is shaped with `grounding`/
// `citation` set to `null`, so the pure grounding core (teach-claims.ts) still
// decides it is `Unverified`. The parser therefore cannot smuggle an ungrounded
// claim past the grounding rule; it can only bound and structure the input.

import { isUlid, type Citation, type Result, err, ok } from '@app/core';

import { parseJsonEnvelope } from '../model-output-envelope.js';

import type { ProposedClaim, ToolOutputRef } from './types.js';

/** Longest accepted single text field, to bound memory from untrusted output. */
const MAX_FIELD_CHARS = 4_000;

/** Most claims accepted from a single teaching turn (defensive bound). */
const MAX_CLAIMS = 40;

/** Why shaping untrusted model output into claims failed (non-sensitive). */
export interface ModelOutputParseError {
  readonly reason: string;
}

/** Build a parse error with a short, non-sensitive reason. */
function parseError(reason: string): ModelOutputParseError {
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
 * shape requirements as an unfenced one, and grounding is still decided later.
 */
function parseJson(raw: string): Result<UnknownRecord, ModelOutputParseError> {
  const envelope = parseJsonEnvelope(raw);
  if (!envelope.ok) {
    return err(parseError('model output was not valid JSON'));
  }
  if (!isRecord(envelope.value)) {
    return err(parseError('model output was not a JSON object'));
  }
  return ok(envelope.value);
}

/** Coerce a field to a trimmed, length-bounded non-empty string, or null. */
function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.slice(0, MAX_FIELD_CHARS);
}

/** Read a required ULID field, or null when it is missing or malformed. */
function cleanUlid(value: unknown): string | null {
  return typeof value === 'string' && isUlid(value) ? value : null;
}

/** Shape a tool-output reference, returning null on any malformed field. */
function readToolOutputRef(value: unknown): ToolOutputRef | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.kind === 'oracle-verdict') {
    const verificationResultId = cleanUlid(value.verificationResultId);
    const oracleSpanId = cleanUlid(value.oracleSpanId);
    if (verificationResultId === null || oracleSpanId === null) {
      return null;
    }
    return { kind: 'oracle-verdict', verificationResultId, oracleSpanId };
  }
  if (value.kind === 'trace-span') {
    const spanId = cleanUlid(value.spanId);
    return spanId === null ? null : { kind: 'trace-span', spanId };
  }
  if (value.kind === 'waveform-reading') {
    return readWaveformReadingRef(value);
  }
  return null;
}

/** Shape a waveform-reading reference, returning null on any malformed field. */
function readWaveformReadingRef(value: UnknownRecord): ToolOutputRef | null {
  const waveformArtifactId = cleanUlid(value.waveformArtifactId);
  const signal = cleanString(value.signal);
  const atSimTimeNs = value.atSimTimeNs;
  if (waveformArtifactId === null || signal === null || typeof atSimTimeNs !== 'number') {
    return null;
  }
  if (!Number.isFinite(atSimTimeNs)) {
    return null;
  }
  return { kind: 'waveform-reading', waveformArtifactId, signal, atSimTimeNs };
}

/** Shape a citation, returning null unless every attribution field is present. */
function readCitation(value: unknown): Citation | null {
  if (!isRecord(value)) {
    return null;
  }
  const claim = cleanString(value.claim);
  const sourceUrl = cleanString(value.sourceUrl);
  const sourceTitle = cleanString(value.sourceTitle);
  if (claim === null || sourceUrl === null || sourceTitle === null) {
    return null;
  }
  return { claim, sourceUrl, sourceTitle, presentation: 'cited' };
}

/** Shape one claim record; returns null for a claim with no teachable statement. */
function readClaim(value: unknown): ProposedClaim | null {
  if (!isRecord(value)) {
    return null;
  }
  const statement = cleanString(value.statement);
  if (statement === null) {
    return null;
  }
  if (value.kind === 'design') {
    return { kind: 'design', statement, grounding: readToolOutputRef(value.grounding) };
  }
  if (value.kind === 'general') {
    return { kind: 'general', statement, citation: readCitation(value.citation) };
  }
  return null;
}

/** Read and shape the bounded `claims` array, dropping malformed entries. */
function readClaims(value: unknown): readonly ProposedClaim[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const claims: ProposedClaim[] = [];
  for (const item of value) {
    const claim = readClaim(item);
    if (claim !== null) {
      claims.push(claim);
    }
    if (claims.length >= MAX_CLAIMS) {
      break;
    }
  }
  return claims;
}

/**
 * Shape untrusted teaching output into validated `ProposedClaim`s (Req 11.2).
 *
 * The model is expected to return a JSON object with a `claims` array; each claim is
 * `{ kind: "design", statement, grounding }` or `{ kind: "general", statement,
 * citation }`. Every field is bounded and re-validated; a malformed grounding or
 * citation is shaped to `null` (so the claim is later grounded as `Unverified`),
 * and a claim with no statement is dropped. The only hard failure is non-JSON or a
 * non-object payload, because then there is no claim list to proceed on.
 */
export function parseTeachClaims(
  raw: string,
): Result<readonly ProposedClaim[], ModelOutputParseError> {
  const jsonResult = parseJson(raw);
  if (!jsonResult.ok) {
    return jsonResult;
  }
  return ok(readClaims(jsonResult.value.claims));
}
