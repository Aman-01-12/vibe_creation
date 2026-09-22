// The Dialect_Normalizer entry point: the single owner of "what may this transform ever
// change" (design.md Component 2; Req 4.4-4.8, 4.12, 4.14, 4.15, 5.7).
//
// WHY THIS IS THE ONLY CALLER OF `scanSource`
//   Every rule in `dialect/` reads the SAME `SourceMask`, `moduleScopeNames`, and
//   `takenIdentifiers`, computed once here (Req 4.15). A second scan would not just cost
//   twice the work, it would risk two rules disagreeing about which offsets are code - the
//   exact class of bug this instrument exists to prevent in the artifact it measures.
//
// WHY EDITS ARE APPLIED RIGHT-TO-LEFT IN ONE PASS
//   Each rule proposes `SpanEdit`s over the ORIGINAL source's offsets, independently of what
//   any other rule proposed. Splicing left-to-right would shift every offset after the first
//   edit, invalidating every subsequent edit's `start`/`end`. Sorting descending by `start`
//   and slicing means each splice only ever touches text at or after its own edit, so no
//   edit's coordinates are ever invalidated by another's.
//
// WHY THIS NEVER THROWS
//   The three rules are pure functions over text and a mask; none of them can throw on any
//   string input. The two refusal checks below (`endMode !== 'code'`, too-long) are checked
//   BEFORE any rule runs, so a shape this transform cannot trust is never handed to a rule at
//   all. A shape a rule declines to rewrite is reported, not thrown - that is what "declined"
//   as a first-class outcome means. The only fail-safe direction for a rewriter of the
//   measuring instrument is to hand back exactly what it was given.
//
// WHAT THIS FILE NEVER DOES
//   No model call, no file read, no `` `include `` following, no network, no clock, no random
//   source, and no parameter shaped like a candidate RTL source (only a Testbench source
//   string in, an outcome out).
//
// Pure, total, model-free (Req 4.4, 4.6, 4.16).

import { scanSource, type SourceMask } from '@app/tools';
import { NORMALIZER_VERSION } from '../normalizer-version.js';
import { findProseAsStatements } from './prose-as-statement.js';
import { planSizedLiteralRewrites } from './sized-literal.js';
import {
  DECLARATION_KEYWORDS,
  declaredNamesAfter,
  planUnnamedBeginLabels,
} from './unnamed-begin.js';
import type { DialectFinding, SpanEdit } from './types.js';

export type { DialectClass, DialectDeclineCause, DialectFinding, SpanEdit } from './types.js';

/**
 * The upper bound on the length of a source this transform will attempt to classify.
 *
 * Mirrors `MAX_MUTATED_SOURCE_CHARS` (`app/eval/corpus/verilog-mutation.ts`): a per-character
 * scan is linear, but a pathological input should refuse cleanly rather than spend unbounded
 * time, and the refusal itself is a reported outcome (`'source-too-long'`) rather than a
 * silent truncation.
 */
export const MAX_NORMALIZED_CHARS = 200_000;

/** What the transform did to one source, under which version (Req 4.14). */
export interface NormalizerReport {
  readonly normalizerVersion: number;
  /** `true` iff the output source differs from the input source. */
  readonly changed: boolean;
  readonly findings: readonly DialectFinding[];
  /**
   * Set when the whole source was refused: lexically malformed (an unterminated comment or
   * string, `SourceMask.endMode !== 'code'`) or longer than `MAX_NORMALIZED_CHARS`. `findings`
   * is then empty and the source is returned byte-identical (Req 5.7).
   */
  readonly refusedWholeSource: 'lexically-malformed' | 'source-too-long' | null;
}

export interface NormalizerOutcome {
  /** The post-normalization source; byte-identical to the input when nothing fired. */
  readonly source: string;
  readonly report: NormalizerReport;
}

/** Block-opening keywords, depth-counted the same way `unnamed-begin.ts` does. */
const TOP_LEVEL_BLOCK_OPENERS: ReadonlySet<string> = new Set([
  'begin',
  'case',
  'casex',
  'casez',
  'fork',
  'function',
  'task',
]);

/** Block-closing keywords, one-to-one with `TOP_LEVEL_BLOCK_OPENERS` by depth. */
const TOP_LEVEL_BLOCK_CLOSERS: ReadonlySet<string> = new Set([
  'end',
  'endcase',
  'join',
  'endfunction',
  'endtask',
]);

/**
 * Every name declared by a `DECLARATION_KEYWORDS` statement sitting at block-depth zero
 * (i.e. at the top level of a module, outside any `begin`/`case`/`fork`/`function`/`task`
 * block), across the WHOLE FILE.
 *
 * `ponytail:` this over-approximates across a file declaring more than one module - the same
 * ceiling `unnamed-begin.ts`'s shadow check already documents and already accepts, since the
 * two must agree on what "module scope" means for Req 5.4 to hold. Ceiling: false declines
 * only, never false rewrites. Upgrade path: scope this per `module`/`endmodule` boundary,
 * worth doing only if a measured campaign shows declined residue dominated by cross-module
 * false positives.
 */
function moduleScopeNamesOf(source: string, mask: SourceMask): ReadonlySet<string> {
  const names = new Set<string>();
  let depth = 0;
  // A LOCALLY-CONSTRUCTED `/g` regex driven by `matchAll`, never a shared module-level one:
  // this loop calls `declaredNamesAfter` per declaration keyword, and a shared `/g` regex's
  // `lastIndex` being reset by that nested call rewound this scan to offset 0 forever.
  // A fresh instance per call has no cross-call state to corrupt.
  const tokens = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  for (const match of source.matchAll(tokens)) {
    const start = match.index;
    if (mask.code[start] !== 1) {
      continue;
    }
    const text = match[0];
    if (TOP_LEVEL_BLOCK_OPENERS.has(text)) {
      depth += 1;
    } else if (TOP_LEVEL_BLOCK_CLOSERS.has(text)) {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && DECLARATION_KEYWORDS.has(text)) {
      for (const name of declaredNamesAfter(source, mask, start + text.length)) {
        names.add(name);
      }
    }
  }
  return names;
}

/**
 * Every `[A-Za-z_$][A-Za-z0-9_$]*` token anywhere in the raw source text, code AND non-code
 * spans alike (Req 5.5): a comment or string mentioning a name still makes that name unsafe
 * to mint as a fresh block label, so this is deliberately unfiltered by `mask.code`.
 */
function takenIdentifiersOf(source: string): ReadonlySet<string> {
  const identifiers = new Set<string>();
  // Own instance, not a shared module-level `/g` regex: `matchAll` is safe on its own, but
  // sharing the object is what let one scan's `lastIndex` corrupt another's.
  const tokens = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  for (const match of source.matchAll(tokens)) {
    identifiers.add(match[0]);
  }
  return identifiers;
}

/** Whether `outer` covers strictly more source than `inner` and fully contains it. */
function enclosesStrictly(outer: SpanEdit, inner: SpanEdit): boolean {
  const covers = outer.start <= inner.start && inner.end <= outer.end;
  return covers && outer.end - outer.start > inner.end - inner.start;
}

/**
 * Drop every edit whose span is strictly enclosed by another edit's span.
 *
 * WHY THIS EXISTS
 *   Right-to-left splicing is only offset-safe while the edits do not overlap. That held by
 *   construction while the unnamed-begin rule inserted a label and nothing else, and it stopped
 *   holding when that rule began REMOVING a declaration statement: a malformed sized literal in
 *   a declaration's initializer (`reg [7:0] x = 8'd-1;`) puts a narrow rewrite INSIDE a wider
 *   removal. Splicing the narrow one first changes the text length under the wider one's
 *   recorded `end`, so the wider splice would cut the wrong bytes - a corrupting false rewrite
 *   in the transform that rewrites the measuring instrument.
 *
 * WHY THE WIDER EDIT WINS
 *   Its replacement text was copied from the ORIGINAL source and already contains the narrow
 *   span's original bytes verbatim, so dropping the narrow edit leaves a consistent source. The
 *   reverse - dropping the wider one - would leave a declaration relocated in one place and not
 *   removed from the other, i.e. declared twice.
 *
 * ponytail: O(n^2) over an edit list bounded by the finding count (tens, for a testbench), and
 * the report still names the dropped narrow edit as `rewritten`, so the ceiling is an
 * over-reported rewrite rather than a wrong source. Upgrade path: a sweep-line pass and a
 * `declined` re-stamp for the dropped edit, worth doing only if a measured campaign shows this
 * collision is common rather than exotic. Partial (non-enclosing) overlap cannot arise: every
 * span these rules propose is either one whole declaration statement or one literal inside one.
 */
function withoutEnclosedEdits(edits: readonly SpanEdit[]): readonly SpanEdit[] {
  return edits.filter(
    (edit) => !edits.some((other) => other !== edit && enclosesStrictly(other, edit)),
  );
}

/** Apply every rewritten (non-zero-width) edit in one right-to-left splice (Req 5.3). */
function applyEdits(source: string, edits: readonly SpanEdit[]): string {
  const realEdits = edits.filter((edit) => edit.finding.action === 'rewritten');
  const orderedDescending = [...withoutEnclosedEdits(realEdits)].sort((a, b) => b.start - a.start);
  let result = source;
  for (const edit of orderedDescending) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  }
  return result;
}

function refused(
  source: string,
  reason: 'lexically-malformed' | 'source-too-long',
): NormalizerOutcome {
  return {
    source,
    report: {
      normalizerVersion: NORMALIZER_VERSION,
      changed: false,
      findings: [],
      refusedWholeSource: reason,
    },
  };
}

/**
 * Desugar one generated Testbench source (pure, total, model-free; Req 4.4, 4.16).
 *
 * Never throws: a shape this transform cannot classify is DECLINED and reported, because the
 * only fail-safe direction for a rewriter of the measuring instrument is to hand back exactly
 * what it was given.
 */
export function normalizeDialect(source: string): NormalizerOutcome {
  if (source.length > MAX_NORMALIZED_CHARS) {
    return refused(source, 'source-too-long');
  }

  const mask = scanSource(source);
  if (mask.endMode !== 'code') {
    return refused(source, 'lexically-malformed');
  }

  const moduleScopeNames = moduleScopeNamesOf(source, mask);
  const takenIdentifiers = takenIdentifiersOf(source);

  const beginLabelEdits = planUnnamedBeginLabels({
    source,
    mask,
    moduleScopeNames,
    takenIdentifiers,
  });
  const sizedLiteralEdits = planSizedLiteralRewrites({ source, mask });
  const proseFindings = findProseAsStatements({ source, mask });

  const editFindings = [...beginLabelEdits, ...sizedLiteralEdits].map((edit) => edit.finding);
  const findings: readonly DialectFinding[] = [...editFindings, ...proseFindings];

  const normalizedSource = applyEdits(source, [...beginLabelEdits, ...sizedLiteralEdits]);

  return {
    source: normalizedSource,
    report: {
      normalizerVersion: NORMALIZER_VERSION,
      changed: normalizedSource !== source,
      findings,
      refusedWholeSource: null,
    },
  };
}
