// Per-character classification of a Verilog source, offset-for-offset, so a rewrite or a
// mutation can tell code from a comment, a string literal, or a compiler directive WITHOUT a
// parser.
//
// WHY THIS EXISTS HERE
//   `begin`, `end`, and declaration-shaped text all appear inside `//` comments, `/* */`
//   comments, and string literals, and `$display("...begin...")` is common in exactly the
//   testbenches this scanner's callers process. A naive regex over raw text would fire on all
//   of that; this scan removes the failure class structurally by classifying every offset
//   before any caller looks at it.
//
// MOVED, NOT REWRITTEN
//   This was a private scanner inside `app/eval/corpus/verilog-mutation.ts`. It moved here
//   verbatim, with `export` added, because a Testbench-dialect rewrite needs the identical
//   safety claim the mutation generator already relies on: one owner, one guarantee.
//
// Pure: no clock, no I/O, no randomness. One left-to-right pass, linear, allocation-bounded.

/** What the scanner is currently inside. */
export type ScanMode = 'code' | 'line-comment' | 'block-comment' | 'string' | 'directive';

/**
 * Per-character classification of a Verilog source, offset-for-offset.
 *
 * Offsets are PRESERVED, unlike a strip-comments pass: a rewrite planned against this mask
 * can be spliced back into the original text by index.
 */
export interface SourceMask {
  /** `1` at offsets that are ordinary code; `0` inside a comment, string, or directive. */
  readonly code: Uint8Array;
  /** `[...]` nesting depth at each offset, saturating at 255; `0` outside any brackets. */
  readonly bracketDepth: Uint8Array;
  /** Offset of the first character of each line, so a site can report line and column. */
  readonly lineStarts: readonly number[];
  /**
   * The mode the scan ENDED in.
   *
   * `'code'` means every span closed; anything else means the source has an unterminated
   * comment or string literal - a lexically malformed input a caller should decline on
   * wholesale rather than rewrite under a classification it cannot trust.
   */
  readonly endMode: ScanMode;
}

/** One scanner step: the mode to continue in, how far to advance, and whether this is code. */
interface ScanStep {
  readonly mode: ScanMode;
  readonly width: number;
  readonly isCode: boolean;
}

/** Depth after an opening bracket, so the bracket itself reads as inside one. */
function openBracket(character: string, depth: number): number {
  return character === '[' ? Math.min(255, depth + 1) : depth;
}

/** Depth after a closing bracket, so the bracket itself still read as inside one. */
function closeBracket(character: string, depth: number): number {
  return character === ']' ? Math.max(0, depth - 1) : depth;
}

/** Advance from code, entering a comment, a string, or a directive when one opens. */
function advanceCode(source: string, index: number, character: string): ScanStep {
  const next = source.charAt(index + 1);
  if (character === '/' && next === '/') {
    return { mode: 'line-comment', width: 2, isCode: false };
  }
  if (character === '/' && next === '*') {
    return { mode: 'block-comment', width: 2, isCode: false };
  }
  if (character === '"') {
    return { mode: 'string', width: 1, isCode: false };
  }
  if (character === '`') {
    return { mode: 'directive', width: 1, isCode: false };
  }
  return { mode: 'code', width: 1, isCode: true };
}

/** Advance the scanner by one step from its current mode. */
function advanceScan(input: {
  readonly source: string;
  readonly index: number;
  readonly character: string;
  readonly mode: ScanMode;
}): ScanStep {
  const { source, index, character, mode } = input;
  if (mode === 'code') {
    return advanceCode(source, index, character);
  }
  if (mode === 'line-comment' || mode === 'directive') {
    return { mode: character === '\n' ? 'code' : mode, width: 1, isCode: false };
  }
  if (mode === 'block-comment') {
    const ends = character === '*' && source.charAt(index + 1) === '/';
    return { mode: ends ? 'code' : 'block-comment', width: ends ? 2 : 1, isCode: false };
  }
  if (character === '\\') {
    // A backslash escape consumes the next character, so `\"` cannot close the literal.
    return { mode: 'string', width: 2, isCode: false };
  }
  return { mode: character === '"' ? 'code' : 'string', width: 1, isCode: false };
}

/**
 * Classify every character of the source in one left-to-right pass.
 *
 * Linear and allocation-bounded. Escapes inside a string literal are honoured so a `\"` does
 * not end the string early.
 */
export function scanSource(source: string): SourceMask {
  const code = new Uint8Array(source.length);
  const bracketDepth = new Uint8Array(source.length);
  const lineStarts: number[] = [0];
  let mode: ScanMode = 'code';
  let depth = 0;
  let index = 0;
  while (index < source.length) {
    const character = source.charAt(index);
    if (character === '\n') {
      lineStarts.push(index + 1);
    }
    const step = advanceScan({ source, index, character, mode });
    mode = step.mode;
    if (step.isCode) {
      depth = openBracket(character, depth);
      code[index] = 1;
      bracketDepth[index] = depth;
      depth = closeBracket(character, depth);
    }
    index += step.width;
  }
  return { code, bracketDepth, lineStarts, endMode: mode };
}

/**
 * The offset of the nearest non-whitespace CODE character strictly BEFORE `beforeOffset`, or
 * `null` when no code character precedes it.
 *
 * A COMMENT IS WHITESPACE, which is what makes this walk `continue` rather than stop.
 * In Verilog a comment is lexically equivalent to whitespace: it is stripped before the parser
 * sees the token stream, so a comment span is TRANSPARENT to any question of the form "which
 * token is adjacent on this side". `continue`-ing past every non-code offset (comment, string,
 * directive) exactly as this walk continues past a space is therefore the only answer that
 * matches what the parser does. A scan that STOPS at a comment is answering a different
 * question, and every caller of it gets the adjacency wrong whenever a comment intervenes.
 *
 * The single owner of that walk in the backward direction: `unnamed-begin.ts`,
 * `prose-as-statement.ts`, and `sized-literal.ts` all read adjacency through this pair rather
 * than each spelling the walk again.
 */
export function precedingCodeOffset(
  source: string,
  mask: SourceMask,
  beforeOffset: number,
): number | null {
  for (let index = Math.min(beforeOffset, source.length) - 1; index >= 0; index -= 1) {
    if (mask.code[index] !== 1 || /\s/.test(source.charAt(index))) {
      continue;
    }
    return index;
  }
  return null;
}

/**
 * The offset of the nearest non-whitespace CODE character at or AFTER `fromOffset`, or `null`
 * when no code character follows it.
 *
 * The forward mirror of {@link precedingCodeOffset}, and transparent to a comment for the
 * identical reason: a comment between `begin` and `:` leaves the block NAMED, because the
 * parser never sees the comment.
 */
export function followingCodeOffset(
  source: string,
  mask: SourceMask,
  fromOffset: number,
): number | null {
  for (let index = Math.max(fromOffset, 0); index < source.length; index += 1) {
    if (mask.code[index] !== 1 || /\s/.test(source.charAt(index))) {
      continue;
    }
    return index;
  }
  return null;
}

/**
 * The text of one 1-based line of `source`, without its terminator, or `null` when
 * `lineNumber` is out of range.
 *
 * The single owner of "line N of this source": callers reporting a source line for a
 * diagnostic read it from here rather than re-splitting the source themselves.
 */
export function sourceLineAt(source: string, lineNumber: number): string | null {
  if (lineNumber < 1) {
    return null;
  }
  const { lineStarts } = scanSource(source);
  const start = lineStarts[lineNumber - 1];
  if (start === undefined) {
    return null;
  }
  const nextStart = lineStarts[lineNumber];
  const end = nextStart === undefined ? source.length : nextStart;
  const line = source.slice(start, end);
  return line.endsWith('\r\n') ? line.slice(0, -2) : line.endsWith('\n') ? line.slice(0, -1) : line;
}
