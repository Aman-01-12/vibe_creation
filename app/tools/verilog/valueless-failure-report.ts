// Counts Valueless_Failure_Reports in one generated testbench source: a `$display` whose first
// argument is a `FAIL` literal and which prints no value after it. A domain question, so it
// lives beside the lexical mask it reads rather than inside it (design C3).

import { followingCodeOffset, isEntirelyCode, scanSource } from './source-mask.js';
import type { SourceMask, StringSpan } from './source-mask.js';

const DISPLAY_TOKEN = '$display';
const FAILURE_WORD = 'FAIL';
/** `$displayh` and friends are different system tasks, so the token must end here. */
const IDENTIFIER_CHARACTER = /[A-Za-z0-9_$]/;
const WHITESPACE = /\s/;

/**
 * Where the first argument starts: the first offset at or after `fromOffset` that is not
 * whitespace or a comment, or `source.length`. A comment is skipped as the parser skips it, and
 * a non-code run not opened by `/` (a directive) is the argument, so it is never skipped.
 */
function firstArgumentOffset(input: {
  readonly source: string;
  readonly mask: SourceMask;
  readonly spansByStart: ReadonlyMap<number, StringSpan>;
  readonly fromOffset: number;
}): number {
  const { source, mask, spansByStart, fromOffset } = input;
  let index = fromOffset;
  while (index < source.length && !spansByStart.has(index)) {
    const isCode = mask.code[index] === 1;
    if (isCode && !WHITESPACE.test(source.charAt(index))) {
      return index;
    }
    if (!isCode && source.charAt(index) !== '/') {
      return index;
    }
    index += 1;
    // ponytail: skips a whole non-code run, so a directive directly after a comment is skipped too.
    while (!isCode && index < source.length && mask.code[index] !== 1 && !spansByStart.has(index)) {
      index += 1;
    }
  }
  return index;
}

/** Whether the `$display` token at `tokenStart` is a valueless failure report (steps 2 to 7). */
function isValuelessFailureReport(input: {
  readonly source: string;
  readonly mask: SourceMask;
  readonly spansByStart: ReadonlyMap<number, StringSpan>;
  readonly tokenStart: number;
}): boolean {
  const { source, mask, spansByStart, tokenStart } = input;
  const tokenEnd = tokenStart + DISPLAY_TOKEN.length;
  if (!isEntirelyCode(mask, tokenStart, tokenEnd)) {
    return false;
  }
  if (IDENTIFIER_CHARACTER.test(source.charAt(tokenEnd))) {
    return false;
  }
  const openParen = followingCodeOffset(source, mask, tokenEnd);
  if (openParen === null || source.charAt(openParen) !== '(') {
    return false;
  }
  const literal = spansByStart.get(
    firstArgumentOffset({ source, mask, spansByStart, fromOffset: openParen + 1 }),
  );
  if (
    literal === undefined ||
    !source.slice(literal.start + 1, literal.end).includes(FAILURE_WORD)
  ) {
    return false;
  }
  const afterLiteral = followingCodeOffset(source, mask, literal.end + 1);
  return afterLiteral !== null && source.charAt(afterLiteral) === ')';
}

/**
 * How many Valueless_Failure_Reports one generated testbench source holds (Req 5.2).
 *
 * A `$display` whose FIRST argument is a string literal containing `FAIL` (case-sensitive,
 * DQ-01) and which passes no argument expression after it: the shape that computes both values,
 * detects the mismatch, and then prints neither.
 *
 * Deterministic and total over arbitrary text, with no refusal path and no port for a run, a
 * reference design, or a model (Req 5.1, 5.6, 5.7, 5.8). A lexically malformed source is counted
 * rather than declined; its unterminated tail is masked non-code, so it undercounts rather than
 * inventing a report in text the compiler would never reach.
 */
export function countValuelessFailureReports(source: string): number {
  const mask = scanSource(source);
  const spansByStart = new Map(mask.stringSpans.map((span) => [span.start, span]));
  let count = 0;
  let tokenStart = source.indexOf(DISPLAY_TOKEN);
  while (tokenStart !== -1) {
    if (isValuelessFailureReport({ source, mask, spansByStart, tokenStart })) {
      count += 1;
    }
    tokenStart = source.indexOf(DISPLAY_TOKEN, tokenStart + 1);
  }
  return count;
}
