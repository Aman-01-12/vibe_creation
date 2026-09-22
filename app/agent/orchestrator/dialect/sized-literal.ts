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
//   legal, so the parenthesized form is precedence-proof.
//
//   The signed-base marker is part of the copied text, not an incidental capture: `16'sd-1`
//   rewrites to `(-16'sd1)`, `s` intact. Dropping it is a meaning change rather than a cosmetic
//   one - measured under `vvp`, `(-16'sd1) < 0` is 1 while `(-16'd1) < 0` is 0, and the second
//   reads as 65535 - so a dropped marker can flip a check's verdict. All four spellings of
//   `[sS][dD]` were measured legal and measured signed, so the captured run is re-emitted
//   verbatim rather than canonicalised.
//
// THE `#` GUARD DECLINES WHERE A REWRITE WOULD CREATE `#(`, WHICH IS NOT THE SAME AS
// "INSIDE A PARAMETER OVERRIDE"
//   `precedingCodeCharacter` is read at the LITERAL'S start, so the guard fires on `#8'd-1`,
//   where the rewrite's output `#(-8'd1)` would CREATE a `#(` sequence the input did not have,
//   and does NOT fire on `dut #(8'd-1) u0();`, where `#(` is already present and the rewrite
//   only nests a paren inside it, giving `dut #((-8'd1)) u0();`. An earlier version of this
//   comment described the guard as declining "inside a parameter/delay override", which is a
//   different rule than the code implements and is not what was measured.
//
//   What `iverilog -g2012` (Icarus 13.0) actually says, each case compiled alone and run under
//   `vvp` where meaning rather than syntax was the question:
//     `dut #(8'd-1) u0();`   REJECTED  (`Syntax error in parameter value assignment list`)
//     `dut #((-8'd1)) u0();` compiles, parameter receives -1 - the SAME value the intended
//                            `dut #(-8'd1) u0();` delivers, so this rewrite repairs an override
//                            the toolchain rejects rather than altering a working one
//     `#8'd-1 acc = 1;`      REJECTED  (`Syntax in assignment statement l-value`)
//     `#(-8'd1) acc = 1;`    compiles, and DELAYS (simulation time 0 -> 255) - a delay control,
//                            not an override, because an override only follows a module name
//     `dut #8'd1 u0();`      REJECTED - there is no legal bare `#<sized literal>` instantiation
//     `and #8'd1 g0(...);`   REJECTED - nor a legal bare gate delay
//
//   So the guard's original justification does not survive measurement: `#(` in a statement
//   position is unambiguously a delay, and the declined input does not compile in any position
//   today, so no working meaning can be flipped by rewriting it. The guard's BEHAVIOUR is
//   retained anyway, on the conservative side of a question that is now measured but not
//   decided - removing it would change the SET OF REWRITES, which is a separate decision with
//   its own `NORMALIZER_VERSION` and config-hash consequence. What changed is that the decline
//   is now REPORTED, under `rewrite-context-not-established` rather than under a cause that
//   would claim the value was undeterminable when it is `-1` in the plainest possible text.
//
// TEXTUAL, NOT ARITHMETIC, PRESERVATION
//   The size token, the signed marker, and the magnitude digits are copied as the identical
//   character runs they were in the input. Nothing here parses a literal to a number and
//   reformats it; that would make width, signedness, and value preservation a claim about this
//   code's arithmetic instead of a fact about the bytes it moved.
//
// WHAT THIS RULE DECLINES, AND WHY EACH ONE IS DECLINED RATHER THAN UNHANDLED
//   Two different reasons, which the report keeps apart because they are not the same claim:
//   the site's own text does not carry an intended value (`value-not-determinable`), or the
//   value is plain and the ADJACENCY has not been cleared (`rewrite-context-not-established`,
//   the `#` guard above). Every one of them rides a zero-width `SpanEdit` carrying its finding,
//   because a decline that returns `null` is invisible to the report and undercounts the class.
//
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
import type { DialectDeclineCause, SpanEdit } from './types.js';

export type { SpanEdit } from './types.js';

/** A decimal digit value, including the `x`/`z` don't-care/high-impedance digits. */
const DECIMAL_DIGIT_PATTERN = /^[0-9xXzZ]$/;

/**
 * `<size> ' [s|S] [d|D]`, capturing the size token, the OPTIONAL SIGNED MARKER, and the base so
 * all three can be copied verbatim. The marker's group is re-emitted, not merely matched: see the
 * module header for the `vvp` measurement showing that dropping it flips a comparison's verdict.
 */
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

/**
 * A zero-width edit carrying one decline, for a site the rule RECOGNISED and will not rewrite.
 *
 * Zero-width with an empty replacement, so applying it leaves the source byte-identical. This is
 * the only way a decline reaches the report: `planLiteralRewrites` pushes non-null results and a
 * `DialectFinding` is only ever produced by a returned `SpanEdit`, so a rule that returns `null`
 * for a recognised site declines SILENTLY and the per-class decline count undercounts. `null` is
 * therefore reserved for "this is not a site", which is not interchangeable with "this is a site
 * I am declining" because only one of the two is counted.
 */
function declineFinding(mask: SourceMask, offset: number, cause: DialectDeclineCause): SpanEdit {
  return {
    start: offset,
    end: offset,
    replacement: '',
    finding: {
      dialectClass: 'malformed-sized-literal',
      line: lineAt(mask, offset),
      action: 'declined',
      declinedBecause: cause,
    },
  };
}

/** Plan the rewrite for one `<size>'<signed?>d`/`D` prefix match, or a decline finding. */
function planOneLiteral(input: {
  readonly source: string;
  readonly mask: SourceMask;
  readonly literalPrefix: { readonly size: string; readonly signed: string; readonly base: string };
  readonly prefixStart: number;
  readonly prefixEnd: number;
}): SpanEdit | null {
  const { source, mask, literalPrefix, prefixStart, prefixEnd } = input;
  const { size, signed, base } = literalPrefix;
  const line = lineAt(mask, prefixStart);
  // The signed marker is copied verbatim rather than canonicalised, so `16'Sd-1` stays `'Sd`.
  const prefix = `${size}'${signed}${base}`;

  if (precedingCodeCharacter(source, mask, prefixStart) === '#') {
    // The rewrite would CREATE a `#(` the input did not have. Declined on the conservative side
    // of a measured-but-undecided question, and REPORTED rather than dropped; the module header
    // records what `iverilog -g2012` actually says about both sides of this guard.
    return declineFinding(mask, prefixStart, 'rewrite-context-not-established');
  }

  const parenthesizedNegative = /^\((-\d+)\)/.exec(source.slice(prefixEnd));
  const parenthesizedMagnitude = parenthesizedNegative?.[1];
  if (parenthesizedNegative && parenthesizedMagnitude !== undefined) {
    const magnitude = parenthesizedMagnitude.slice(1);
    const matchLength = parenthesizedNegative[0].length;
    return {
      start: prefixStart,
      end: prefixEnd + matchLength,
      replacement: `(-${prefix}${magnitude})`,
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
      replacement: `(-${prefix}${bareMagnitude})`,
      finding: { dialectClass: 'malformed-sized-literal', line, action: 'rewritten' },
    };
  }

  const nextCharacter = source.charAt(prefixEnd);
  if (DECIMAL_DIGIT_PATTERN.test(nextCharacter)) {
    // A well-formed positive (or x/z-valued) literal; not a site, so `null` is correct here.
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
    const [, size, signed, base] = match;
    if (size === undefined || base === undefined) {
      // Size and base are mandatory in SIZE_PREFIX_PATTERN; a match without them cannot occur,
      // but the regex engine's type does not encode that, so this is a defensive skip.
      continue;
    }
    const prefixStart = match.index;
    const prefixEnd = prefixStart + match[0].length;
    if (!isEntirelyCode(mask, prefixStart, prefixEnd)) {
      continue;
    }
    // `signed` is the OPTIONAL `[sS]?` group, so `''` when absent - which is exactly the text to
    // re-emit in that case, and why it needs no `undefined` branch of its own.
    const literalPrefix = { size, signed: signed ?? '', base };
    const edit = planOneLiteral({ source, mask, literalPrefix, prefixStart, prefixEnd });
    if (edit) {
      edits.push(edit);
    }
  }
  return edits;
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
    findings.push(declineFinding(mask, runStart, 'value-not-determinable'));
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
