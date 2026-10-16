// The closed admit-list Verilog tokenizer, shared by every validator that splices untrusted text
// into Verilog: the formal Property_Validator and the testbench Model_Fragment validator.
//
// Extracted from `property.ts` unchanged (testbench-in-order-scoreboard, DQ-02), so one owner
// decides what a literal, an operator, and a non-code span are. The three checks stay separate
// exports because each caller interleaves its own checks between them, and the first failing
// check is the one reported.

import { err, ok, type Result } from '@app/core';

import { scanSource, type SourceMask } from './source-mask.js';

/** A construct name surfaced in a diagnostic is bounded, because untrusted text produced it. */
export const MAX_CONSTRUCT_CHARS = 32;

/** What one validator admits. Everything not named here is refused at the token. */
export interface AdmitList {
  /** `$`-prefixed names admitted as calls, for example `$past`. */
  readonly systemNames: ReadonlySet<string>;
  /** Identifier-shaped words refused because they are keywords, not signal names. */
  readonly reservedWords: ReadonlySet<string>;
  /** Admitted operators and punctuation, LONGEST FIRST, because the first match wins. */
  readonly operators: readonly string[];
}

/** One admitted token, with its start offset in the original text. */
export interface LexToken {
  readonly kind: 'word' | 'system' | 'number' | 'operator';
  readonly text: string;
  readonly start: number;
}

/** Why text was refused. The construct is printable ASCII and at most `MAX_CONSTRUCT_CHARS`. */
export type LexRefusal =
  | { readonly reason: 'unaccepted-construct'; readonly construct: string }
  | { readonly reason: 'unbalanced-expression' };

/** The closer each opener requires, so `([)]` is unbalanced rather than merely even. */
const CLOSER_FOR: ReadonlyMap<string, string> = new Map([
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
]);

/** The kind of non-code span each opening character starts, for the refusal's name. */
const FOREIGN_SPAN_NAMES: ReadonlyMap<string, string> = new Map([
  ['/', 'comment'],
  ['"', 'string-literal'],
  ['`', 'compiler-directive'],
]);

/** One tokenizer step: an admitted token, or why the text was refused. */
type TokenStep =
  | { readonly end: number; readonly kind: LexToken['kind'] | 'space' }
  | { readonly refusal: LexRefusal };

/** Verilog's whitespace set, spelled out rather than `\s` so the admit-list stays closed. */
function isWhitespace(character: string): boolean {
  return /^[ \t\r\n\f]$/.test(character);
}

function isDigit(character: string): boolean {
  return character >= '0' && character <= '9';
}

function isDigitOrUnderscore(character: string): boolean {
  return isDigit(character) || character === '_';
}

function isWordStart(character: string): boolean {
  return /^[A-Za-z_]$/.test(character);
}

function isWordPart(character: string): boolean {
  return /^[A-Za-z0-9_$]$/.test(character);
}

/** Any digit of any Verilog base, including the `x`, `z`, and `?` don't-care markers. */
function isBaseDigit(character: string): boolean {
  return /^[0-9a-fA-FxXzZ?_]$/.test(character);
}

/**
 * A construct name safe to surface: printable ASCII only, bounded in length.
 *
 * Iterating by code point keeps a lone surrogate one unit that the printable filter then drops.
 */
export function constructName(raw: string): string {
  const printable = [...raw.slice(0, MAX_CONSTRUCT_CHARS)]
    .filter((character) => character >= ' ' && character <= '~')
    .join('');
  return printable.length > 0 ? printable : 'non-printable-character';
}

function refuse(raw: string): TokenStep {
  return { refusal: { reason: 'unaccepted-construct', construct: constructName(raw) } };
}

/**
 * The first non-code span in the text, named by its kind, or `null` when every offset is code.
 *
 * `scanSource` marks a span's OPENING characters non-code, so the first non-code offset is
 * always an opener and the character there names the kind. This also refuses an unterminated
 * comment or string, because an unterminated span is still a non-code span.
 */
export function foreignSpanRefusal(text: string): LexRefusal | null {
  const mask: SourceMask = scanSource(text);
  for (let index = 0; index < text.length; index += 1) {
    if (mask.code[index] === 1) {
      continue;
    }
    const character = text.charAt(index);
    return {
      reason: 'unaccepted-construct',
      construct: FOREIGN_SPAN_NAMES.get(character) ?? constructName(character),
    };
  }
  return null;
}

/**
 * The end of the sized or unsized literal starting at `index`, or `null` when it is malformed.
 *
 * Accepts `15`, `8'd15`, `8'shFF`, `1'b0`, and `'b1`.
 */
function numberEnd(text: string, index: number): number | null {
  let cursor = index;
  while (cursor < text.length && isDigitOrUnderscore(text.charAt(cursor))) {
    cursor += 1;
  }
  if (text.charAt(cursor) !== "'") {
    return cursor > index ? cursor : null;
  }
  cursor += 1;
  if (/^[sS]$/.test(text.charAt(cursor))) {
    cursor += 1;
  }
  if (!/^[bBoOdDhH]$/.test(text.charAt(cursor))) {
    return null;
  }
  cursor += 1;
  const digitsStart = cursor;
  while (cursor < text.length && isBaseDigit(text.charAt(cursor))) {
    cursor += 1;
  }
  return cursor > digitsStart ? cursor : null;
}

/** The end of the identifier-shaped word starting at `index`. */
function wordEnd(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && isWordPart(text.charAt(cursor))) {
    cursor += 1;
  }
  return cursor;
}

/** Classify one token at `index` against the admit-list. */
function stepToken(text: string, index: number, admit: AdmitList): TokenStep {
  const character = text.charAt(index);
  if (isWhitespace(character)) {
    return { end: index + 1, kind: 'space' };
  }
  if (character === '$') {
    const end = wordEnd(text, index + 1);
    const name = text.slice(index, end);
    return end === index + 1 || !admit.systemNames.has(name)
      ? refuse(name)
      : { end, kind: 'system' };
  }
  if (isDigit(character) || character === "'") {
    const end = numberEnd(text, index);
    return end === null ? refuse(text.slice(index)) : { end, kind: 'number' };
  }
  if (isWordStart(character)) {
    const end = wordEnd(text, index);
    const word = text.slice(index, end);
    return admit.reservedWords.has(word) ? refuse(word) : { end, kind: 'word' };
  }
  const operator = admit.operators.find((candidate) => text.startsWith(candidate, index));
  return operator === undefined
    ? refuse(character)
    : { end: index + operator.length, kind: 'operator' };
}

/**
 * Tokenize against the admit-list, or name the first token it refuses. Pure, total, never throws.
 *
 * Whitespace is dropped from the result. Every accepted step advances at least one character;
 * `max` makes that structural, because a non-advancing step would hang a caller.
 */
export function lexAdmitted(
  text: string,
  admit: AdmitList,
): Result<readonly LexToken[], LexRefusal> {
  const tokens: LexToken[] = [];
  let index = 0;
  while (index < text.length) {
    const step = stepToken(text, index, admit);
    if ('refusal' in step) {
      return err(step.refusal);
    }
    const end = Math.max(step.end, index + 1);
    if (step.kind !== 'space') {
      tokens.push({ kind: step.kind, text: text.slice(index, end), start: index });
    }
    index = end;
  }
  return ok(tokens);
}

/** Whether every bracket, brace, and paren closes with its own kind, in order. */
export function balanceRefusal(text: string): LexRefusal | null {
  const unbalanced: LexRefusal = { reason: 'unbalanced-expression' };
  const expected: string[] = [];
  for (const character of text) {
    const closer = CLOSER_FOR.get(character);
    if (closer !== undefined) {
      expected.push(closer);
      continue;
    }
    if (character !== ')' && character !== ']' && character !== '}') {
      continue;
    }
    if (expected.pop() !== character) {
      return unbalanced;
    }
  }
  return expected.length === 0 ? null : unbalanced;
}
