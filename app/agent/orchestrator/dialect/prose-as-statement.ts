// The Prose_As_Statement detector: our own check-description prose emitted as a bare
// Verilog statement, `CHECK ac1_..._produces PASS;`, rather than as the argument to a
// `$display` call (task 4.4; Req 4.13, 6.9, 6.10).
//
// WHY THIS FILE CAN NEVER PRODUCE AN EDIT
//   Synthesizing a `$display` from that prose would fabricate a check the model never
//   wrote, and a fabricated check that prints `PASS` is precisely the manufactured evidence
//   the instrument exists to prevent. `findProseAsStatements` therefore returns
//   `readonly DialectFinding[]` and has no `SpanEdit`-producing path anywhere in this
//   module - not "declines by policy", but structurally incapable of proposing a rewrite -
//   so no future change to the normalizer can start rewriting this class by threading a
//   `SpanEdit` through a function that was never built to carry one.
//
// WHY `CHECK_KEYWORD` IS IMPORTED RATHER THAN RE-SPELLED
//   `app/agent/roles/testbench/signalling.ts` already owns the `CHECK <name> PASS|FAIL`
//   grammar the oracle parses and the Testbench_Agent emits. Re-spelling the literal
//   `'CHECK'` here would give the same keyword two owners that could silently drift; this
//   detector's whole job is to recognise the SAME grammar sitting in the wrong place; that
//   requires importing the one definition of what the grammar is.
//
// THE SHAPE DETECTED
//   `CHECK <name> PASS` or `CHECK <name> FAIL`, where `<name>` is a whitespace-free token,
//   sitting where a statement is expected: the nearest preceding non-whitespace CODE
//   character is `;`, or immediately follows the keyword `begin` or `end`, or the match is
//   the first code token in the source. That is what distinguishes a bare statement from the
//   legitimate use of this exact text as a string argument to `$display` (which
//   `formatCheckLine` produces) - a string literal's contents are non-code under
//   `SourceMask`, so they can never satisfy this detector's code-span requirement.

import { CHECK_KEYWORD } from '../../roles/testbench/signalling.js';
import { isEntirelyCode, precedingCodeOffset, type SourceMask } from '@app/tools';
import type { DialectFinding } from './types.js';

export type { DialectClass, DialectDeclineCause, DialectFinding } from './types.js';

/** A code-span match of the `CHECK <name> PASS|FAIL` token sequence. */
interface CheckSignalMatch {
  /** Offset of the `CHECK` keyword's first character. */
  readonly start: number;
  /** Offset one past the last character of the `PASS`/`FAIL` token. */
  readonly end: number;
}

const CHECK_SIGNAL_PATTERN = new RegExp(`\\b${CHECK_KEYWORD}\\s+(\\S+)\\s+(PASS|FAIL)\\b`, 'g');

/** Whether `source` ends with the keyword `keyword` immediately before `offset` (exclusive). */
function endsWithKeyword(source: string, offset: number, keyword: string): boolean {
  const start = offset - keyword.length;
  if (start < 0) {
    return false;
  }
  const precededByWordChar = start > 0 && /\w/.test(source.charAt(start - 1));
  return !precededByWordChar && source.slice(start, offset) === keyword;
}

/**
 * Whether a statement is expected to begin at `start`: the nearest preceding non-whitespace
 * code character is `;`, or `start` immediately follows the keyword `begin` or `end`, or
 * `start` is the first code token in the source (Req 6.9, 6.10).
 *
 * A COMMENT IS WHITESPACE here, which is the whole reason adjacency is read through
 * `precedingCodeOffset` rather than over the raw text: a Verilog comment is stripped before
 * the parser sees the token stream, so a `// Final check` line before a bare
 * `CHECK <name> PASS;` leaves that statement exactly where a statement is expected. The
 * measured shape in `.eval-runs/stage1-screen-repair-v1` is precisely that comment (Req 4.12).
 */
function sitsWhereStatementExpected(source: string, mask: SourceMask, start: number): boolean {
  const precedingOffset = precedingCodeOffset(source, mask, start);
  if (precedingOffset === null) {
    return true;
  }
  const afterPreceding = precedingOffset + 1;
  if (source.charAt(precedingOffset) === ';') {
    return true;
  }
  return (
    endsWithKeyword(source, afterPreceding, 'begin') ||
    endsWithKeyword(source, afterPreceding, 'end')
  );
}

/** The 1-based line number containing `offset`, from {@link SourceMask.lineStarts}. */
function lineNumberAt(mask: SourceMask, offset: number): number {
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

/** Every code-span occurrence of the `CHECK <name> PASS|FAIL` token sequence. */
function findCheckSignalMatches(source: string): readonly CheckSignalMatch[] {
  const matches: CheckSignalMatch[] = [];
  for (const match of source.matchAll(CHECK_SIGNAL_PATTERN)) {
    if (match.index === undefined) {
      continue;
    }
    matches.push({ start: match.index, end: match.index + match[0].length });
  }
  return matches;
}

/**
 * Detect every `CHECK <name> PASS` or `CHECK <name> FAIL` token sequence sitting where a
 * statement is expected, rather than as a string argument to `$display` (Req 4.13, 6.9, 6.10).
 *
 * `mask` is computed once by the caller from one `scanSource` pass, so every rule in this
 * folder sees one classification of one source (Req 4.15); this detector performs no scan
 * of its own.
 *
 * Pure and total: never throws, and never returns a `SpanEdit` - see the module header for
 * why. Every finding is `action: 'declined'` with `declinedBecause: 'reported-only'`.
 */
export function findProseAsStatements(input: {
  readonly source: string;
  readonly mask: SourceMask;
}): readonly DialectFinding[] {
  const { source, mask } = input;
  const findings: DialectFinding[] = [];
  for (const match of findCheckSignalMatches(source)) {
    if (!isEntirelyCode(mask, match.start, match.end)) {
      continue;
    }
    if (!sitsWhereStatementExpected(source, mask, match.start)) {
      continue;
    }
    findings.push({
      dialectClass: 'prose-as-statement',
      line: lineNumberAt(mask, match.start),
      action: 'declined',
      declinedBecause: 'reported-only',
    });
  }
  return findings;
}
