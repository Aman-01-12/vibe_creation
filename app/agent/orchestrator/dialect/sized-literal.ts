// Rewrites a malformed decimal sized literal into the form the toolchain accepts, preserving
// its width and value TEXTUALLY rather than arithmetically, per design.md Component 4.
//
// THE SHAPE THIS RULE READS
//   `<size> ' <signed?> <base> <digits>`, and only when `<base>` is `d` or `D`. Every other
//   base was not in the measured 8-sample population (design.md Component 4), so it is out of
//   scope here rather than guessed at.
//
// THE TWO REWRITES, AND WHY THE OUTPUT IS PARENTHESIZED
//   `16'd(-15)` -> `(-16'd15)`, and `8'd-1` -> `(-8'd1)`. The bare form the calibration table
//   recorded, `-16'd15`, is rejected: a bare unary minus binds tighter than every operator
//   except `**`, so `8'd-1 ** 2` would rewrite to `-8'd1 ** 2`, which parses as
//   `-(8'd1 ** 2)` rather than `(-8'd1) ** 2`. Parentheses are legal everywhere a primary is
//   legal, so the parenthesized form is precedence-proof. The one place `(...)` is ambiguous
//   is immediately after `#` (a parameter/delay override), so this rule declines there.
//
// TEXTUAL, NOT ARITHMETIC, PRESERVATION
//   The size token and the magnitude digits are copied as the identical character runs they
//   were in the input. Nothing here parses a literal to a number and reformats it; that would
//   make width and value preservation a claim about this code's arithmetic instead of a fact
//   about the bytes it moved.
//
// WHAT THIS RULE DECLINES, AND WHY EACH ONE IS UNDECIDABLE RATHER THAN UNHANDLED
//   `9'di`: the character after the base letter is not a digit in any base, and it is also not
//   `x`/`z`/`X`/`Z` (which ARE legal digit values and must not be declined). "Not a digit" is
//   decidable from the text; "what the model meant" is not, so this is reported and left alone.
//   `{1'b0, 64{1'b1}}`: a decimal number immediately followed by `{`, not itself preceded by
//   `{`, reads as either a missing `64{...}` replication count or a concatenation of the value
//   `64` with `{1'b1}`. Both readings are legal Verilog shapes, so the intended value is not
//   determinable from the text. This is DETECTED and REPORTED, never rewritten.
//
// SCOPE
//   Reads only code offsets from the `SourceMask`, so a literal-shaped string inside
//   `$display("got 8'd-1")` is never a site.
//
// Pure: no clock, no I/O, no randomness, no model call.

import { precedingCodeOffset, type SourceMask } from '@app/tools';
import type { SpanEdit } from './types.js';

export type { SpanEdit } from './types.js';

/** A decimal digit value, including the `x`/`z` don't-care/high-impedance digits. */
const DECIMAL_DIGIT_PATTERN = /^[0-9xXzZ]$/;

/** `<size> ' [s|S] [d|D]`, capturing the size token so it can be copied verbatim. */
const SIZE_PREFIX_PATTERN = /(\d+)'([sS]?)([dD])/g;

/** A decimal number immediately followed by `{`, the malformed-replication shape. */
const NUMBER_BEFORE_BRACE_PATTERN = /\d+(?=\{)/g;

/** The 1-based line number containing `offset`, from the mask's recorded line starts. */
function lineAt(mask: SourceMask, offset: number): number {
  let line = 1;
  for (let index = 0; index < mask.lineStarts.length; index += 1) {
    const lineStart = mask.lineStarts[index];
    if (lineStart === undefined || lineStart > offset) {
      break;
    }
    line = index + 1;
  }
  return line;
}

/**
 * The nearest preceding non-whitespace CODE character before `offset`, or `null` at start.
 *
 * The walk itself moved to `@app/tools`' `precedingCodeOffset`, which is now the single owner
 * of "a comment is whitespace, so skip past it" for every adjacency scan in this folder; this
 * is the character-valued adapter its two call sites below read.
 */
function precedingCodeCharacter(source: string, mask: SourceMask, offset: number): string | null {
  const index = precedingCodeOffset(source, mask, offset);
  return index === null ? null : source.charAt(index);
}

/** Whether every offset in `[start, end)` is classified as code by the mask. */
function isEntirelyCode(mask: SourceMask, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (mask.code[index] !== 1) {
      return false;
    }
  }
  return true;
}

/** Plan the rewrite for one `<size>'d`/`<size>'D` prefix match, or a decline finding. */
function planOneLiteral(input: {
  readonly source: string;
  readonly mask: SourceMask;
  readonly sizeToken: string;
  readonly baseToken: string;
  readonly prefixStart: number;
  readonly prefixEnd: number;
}): SpanEdit | null {
  const { source, mask, sizeToken, baseToken, prefixStart, prefixEnd } = input;
  const line = lineAt(mask, prefixStart);

  if (precedingCodeCharacter(source, mask, prefixStart) === '#') {
    // `#(...)` is ambiguous with a parameter/delay override; the only case this rule declines
    // by context rather than by the literal's own text.
    return null;
  }

  const parenthesizedNegative = /^\((-\d+)\)/.exec(source.slice(prefixEnd));
  const parenthesizedMagnitude = parenthesizedNegative?.[1];
  if (parenthesizedNegative && parenthesizedMagnitude !== undefined) {
    const magnitude = parenthesizedMagnitude.slice(1);
    const matchLength = parenthesizedNegative[0].length;
    return {
      start: prefixStart,
      end: prefixEnd + matchLength,
      replacement: `(-${sizeToken}'${baseToken}${magnitude})`,
      finding: { dialectClass: 'malformed-sized-literal', line, action: 'rewritten' },
    };
  }

  const bareNegative = /^-(\d+)/.exec(source.slice(prefixEnd));
  const bareMagnitude = bareNegative?.[1];
  if (bareNegative && bareMagnitude !== undefined) {
    const matchLength = bareNegative[0].length;
    return {
      start: prefixStart,
      end: prefixEnd + matchLength,
      replacement: `(-${sizeToken}'${baseToken}${bareMagnitude})`,
      finding: { dialectClass: 'malformed-sized-literal', line, action: 'rewritten' },
    };
  }

  const nextCharacter = source.charAt(prefixEnd);
  if (DECIMAL_DIGIT_PATTERN.test(nextCharacter)) {
    // A well-formed positive (or x/z-valued) literal; nothing to rewrite and nothing to report.
    return null;
  }

  // Not a digit, not `x`/`z`, not a recognised negative form: the value is not determinable.
  return {
    start: prefixStart,
    end: prefixEnd,
    replacement: source.slice(prefixStart, prefixEnd),
    finding: {
      dialectClass: 'malformed-sized-literal',
      line,
      action: 'declined',
      declinedBecause: 'value-not-determinable',
    },
  };
}

/** Plan the sign-normalizing rewrites for every decimal-base sized literal in `source`. */
function planLiteralRewrites(source: string, mask: SourceMask): SpanEdit[] {
  const edits: SpanEdit[] = [];
  for (const match of source.matchAll(SIZE_PREFIX_PATTERN)) {
    const sizeToken = match[1];
    const baseToken = match[3];
    if (sizeToken === undefined || baseToken === undefined) {
      // Both groups are mandatory in SIZE_PREFIX_PATTERN; a match without them cannot occur,
      // but the regex engine's type does not encode that, so this is a defensive skip.
      continue;
    }
    const prefixStart = match.index;
    const prefixEnd = prefixStart + match[0].length;
    if (!isEntirelyCode(mask, prefixStart, prefixEnd)) {
      continue;
    }
    const edit = planOneLiteral({ source, mask, sizeToken, baseToken, prefixStart, prefixEnd });
    if (edit) {
      edits.push(edit);
    }
  }
  return edits;
}

/** A decline finding, never an edit, for one `N{` malformed-replication site. */
function declineFinding(mask: SourceMask, offset: number): SpanEdit {
  return {
    start: offset,
    end: offset,
    replacement: '',
    finding: {
      dialectClass: 'malformed-sized-literal',
      line: lineAt(mask, offset),
      action: 'declined',
      declinedBecause: 'value-not-determinable',
    },
  };
}

/**
 * Detect, and only detect, the `{1'b0, 64{1'b1}}` shape: a decimal number immediately followed
 * by `{` that is not itself immediately preceded by `{`. A genuine replication (`{64{1'b1}}`)
 * is excluded by the preceding-`{` check, so only the malformed, brace-missing form is reported.
 */
function detectMissingReplicationBrace(source: string, mask: SourceMask): SpanEdit[] {
  const findings: SpanEdit[] = [];
  for (const match of source.matchAll(NUMBER_BEFORE_BRACE_PATTERN)) {
    const runStart = match.index;
    const runEnd = runStart + match[0].length;
    // Include the `{` itself in the code check: a number followed by a `{` that opens a
    // string or comment is not this shape at all.
    if (!isEntirelyCode(mask, runStart, runEnd + 1)) {
      continue;
    }
    if (precedingCodeCharacter(source, mask, runStart) === '{') {
      // A genuine replication count (`{64{1'b1}}`); not the malformed shape.
      continue;
    }
    findings.push(declineFinding(mask, runStart));
  }
  return findings;
}

/**
 * Plan the sign-normalizing rewrites, and report the literals whose intended value is not
 * determinable from their own text (Req 4.10, 4.11, 5.6, 5.7).
 *
 * Reads only code offsets from `mask`, so a literal-shaped string inside
 * `$display("got 8'd-1")` is never a site.
 */
export function planSizedLiteralRewrites(input: {
  readonly source: string;
  readonly mask: SourceMask;
}): readonly SpanEdit[] {
  const { source, mask } = input;
  return [...planLiteralRewrites(source, mask), ...detectMissingReplicationBrace(source, mask)];
}
