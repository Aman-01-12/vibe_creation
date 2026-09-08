// Boundary validation for an UNTRUSTED OpenAI-compatible Chat Completions reply.
//
// Everything a provider sends back is external input: it may be truncated, empty,
// mis-shaped, or hostile. This module is the single trust boundary that turns a raw
// reply body into a validated `ChatCompletionsReply`; no transport reads a provider
// field directly. Validation fails closed with a short, non-sensitive reason so a
// malformed reply becomes a typed `invalid-response`, never a crash and never a
// half-populated result (Req 12.6).
//
// It mirrors the shape the reference client reads: `choices[0].message.content`,
// falling back to `choices[0].message.reasoning_content` when `content` is empty
// (some reasoning models put the answer there), plus the `usage` token counts.

import { err, ok, type Result } from '@app/core';

/** Real token usage as the provider reported it for one call. */
export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

/** A validated reply: the message text, and the usage block when one was reported. */
export interface ChatCompletionsReply {
  readonly text: string;
  /**
   * Absent when the provider reported no usable `usage` block.
   *
   * Absence means UNREPORTED, never zero: a caller must not read it as a free call.
   */
  readonly usage?: TokenUsage;
}

/** Why an untrusted reply could not be validated (short, non-sensitive). */
export interface ChatReplyParseError {
  readonly reason: string;
}

/** A record with unknown-typed values: the shape of parsed-but-unvalidated JSON. */
type UnknownRecord = Readonly<Record<string, unknown>>;

/** Whether a value is a non-array JSON object we can read fields from. */
function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a value is an array, keeping its elements unknown until each is checked. */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** A string with visible content, or null for anything else (including blanks). */
function nonBlankString(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  return value;
}

/** A non-negative whole token count, or null when the field is unusable. */
function tokenCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.trunc(value);
}

/** The first choice's message object, or null when the reply has no usable choice. */
function firstChoiceMessage(reply: UnknownRecord): UnknownRecord | null {
  const choices = reply.choices;
  if (!isUnknownArray(choices)) {
    return null;
  }
  const [first] = choices;
  if (!isRecord(first)) {
    return null;
  }
  const message = first.message;
  return isRecord(message) ? message : null;
}

/**
 * The message text, with the documented `reasoning_content` fallback.
 *
 * Some reasoning models return an empty `content` and carry the answer in
 * `reasoning_content`; reading only `content` would silently lose those replies.
 */
function messageText(message: UnknownRecord): string | null {
  const content = nonBlankString(message.content);
  if (content !== null) {
    return content;
  }
  return nonBlankString(message.reasoning_content);
}

/**
 * The reported usage, or null when the block is absent or unusable.
 *
 * Metering is best-effort and the text is the contract: a reply with valid text but
 * a broken `usage` block is still a usable result, so an unusable block is reported
 * as absent rather than failing the whole call. `total_tokens` is trusted when the
 * provider sends it and derived from the parts otherwise.
 */
function readUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) {
    return null;
  }
  const promptTokens = tokenCount(value.prompt_tokens);
  const completionTokens = tokenCount(value.completion_tokens);
  if (promptTokens === null || completionTokens === null) {
    return null;
  }
  const reportedTotal = tokenCount(value.total_tokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: reportedTotal ?? promptTokens + completionTokens,
  };
}

/**
 * Validate a raw Chat Completions body into a reply, or fail closed.
 *
 * A reply that is not JSON, is not an object, carries no first-choice message, or
 * carries no text in either documented field is rejected: an empty result would
 * otherwise travel onward as a "successful" call with nothing usable in it.
 */
export function parseChatCompletionsReply(
  raw: string,
): Result<ChatCompletionsReply, ChatReplyParseError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err({ reason: 'reply was not valid JSON' });
  }
  if (!isRecord(parsed)) {
    return err({ reason: 'reply was not a JSON object' });
  }
  const message = firstChoiceMessage(parsed);
  if (message === null) {
    return err({ reason: 'reply carried no first choice message' });
  }
  const text = messageText(message);
  if (text === null) {
    return err({ reason: 'reply carried no message text' });
  }
  const usage = readUsage(parsed.usage);
  return ok({ text, ...(usage === null ? {} : { usage }) });
}
