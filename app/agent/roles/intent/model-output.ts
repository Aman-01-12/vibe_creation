// Boundary validation for untrusted Intent_Agent model output.
//
// The Model_Router returns provider text, which is UNTRUSTED input like any other
// external content: it may be malformed, oversized, or adversarial. This module is
// the single trust boundary that shapes that text into a validated `IntentAnalysis`
// before any decision logic runs on it. Nothing downstream re-parses model text;
// if the output cannot be shaped into a well-formed analysis, parsing fails closed
// with a typed error and the agent surfaces `INVALID_MODEL_OUTPUT` rather than
// proceeding on a guess.
//
// The Intent stage output is `Not_Applicable` (Req 4.7): this parser makes no
// correctness claim about the design, it only validates the SHAPE of the model's
// restatement and questions so the interaction can proceed safely.

import { type Result, err, ok } from '@app/core';

import { parseJsonEnvelope } from '../model-output-envelope.js';

import {
  MAX_QUESTIONS_PER_ROUND,
  type ClarifyingQuestion,
  type IntentAnalysis,
  type RestatedIntent,
  type ScopeAssessment,
} from './intent-state.js';

/** Longest accepted single text field, to bound memory from untrusted output. */
const MAX_FIELD_CHARS = 4_000;

/** Longest accepted list of constraints or assumptions from untrusted output. */
const MAX_LIST_ITEMS = 20;

/** Why shaping untrusted model output into an analysis failed (non-sensitive). */
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
 * shape requirements as an unfenced one.
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

/** Coerce a field to a bounded list of clean strings, dropping malformed entries. */
function cleanStringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const cleaned: string[] = [];
  for (const item of value) {
    const text = cleanString(item);
    if (text !== null) {
      cleaned.push(text);
    }
    if (cleaned.length >= MAX_LIST_ITEMS) {
      break;
    }
  }
  return cleaned;
}

/** Read and validate the required `summary` and its constraint/assumption lists. */
function readRestatement(record: UnknownRecord): Result<RestatedIntent, ModelOutputParseError> {
  const summary = cleanString(record.summary);
  if (summary === null) {
    return err(parseError('model output was missing a non-empty summary'));
  }
  return ok({
    summary,
    constraints: cleanStringList(record.constraints),
    assumptions: cleanStringList(record.assumptions),
  });
}

/** Interpret the `scope` field, treating anything but the exceed marker as in-scope. */
function readScope(value: unknown): ScopeAssessment {
  return value === 'exceeds-single-module' ? 'exceeds-single-module' : 'single-module';
}

/** Build the bounded list of clarifying questions, assigning each a stable id. */
function readQuestions(value: unknown, newId: () => string): readonly ClarifyingQuestion[] {
  const prompts = cleanStringList(value).slice(0, MAX_QUESTIONS_PER_ROUND);
  return prompts.map((prompt) => ({ id: newId(), prompt }));
}

/**
 * Shape untrusted model text into a validated `IntentAnalysis` (Req 4.1, 4.2, 4.4).
 *
 * The model is expected to return a JSON object with `summary` (required),
 * optional `constraints`/`assumptions` string lists, an optional `scope` marker,
 * optional `clarifyingQuestions`, and an optional `proposedReduction`. Every field
 * is bounded and re-validated here; the only hard failure is a missing summary or
 * non-JSON output, because without a restatement there is nothing to proceed on.
 * Question ids are minted with the injected `newId` so identity is owned by the
 * caller, not taken from untrusted output.
 */
export function parseIntentAnalysis(
  raw: string,
  newId: () => string,
): Result<IntentAnalysis, ModelOutputParseError> {
  const jsonResult = parseJson(raw);
  if (!jsonResult.ok) {
    return jsonResult;
  }
  const record = jsonResult.value;

  const restatementResult = readRestatement(record);
  if (!restatementResult.ok) {
    return restatementResult;
  }

  return ok({
    restatement: restatementResult.value,
    scope: readScope(record.scope),
    clarifyingQuestions: readQuestions(record.clarifyingQuestions, newId),
    proposedReduction: cleanString(record.proposedReduction),
  });
}
