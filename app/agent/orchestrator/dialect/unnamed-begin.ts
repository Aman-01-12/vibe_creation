// The unnamed-begin rule: MOVES a `begin` block's declarations to the top of that same block,
// and names the block (design.md Component 3; Req 4.9, 5.4, 5.5, 5.13, 5.14).
//
// THE LABEL WAS NEVER THE DISCRIMINATOR - POSITION IS
//   This rule shipped as a label insertion alone and was then measured at 0 of 29 fixtures
//   fixed: it FIRES on 25 of them and the first `syntax error` lands on the identical line
//   before and after. The original calibration was a confounded experiment - it compared a
//   declaration in an unnamed block against a declaration at the TOP of a NAMED block, varied
//   the label and the POSITION together, and credited the label. Measured with `iverilog
//   -g2012`, one file per row: a block-item declaration is ACCEPTED as the first item of its
//   block and REJECTED after a statement, whether or not the block carries a label. So the
//   transform is the MOVE, and the label is retained for IEEE 1364 conformance ALONE - the
//   standard requires a named block for block-item declarations where iverilog is lenient. It
//   is NOT justified by acceptance under our deterministic oracle.
//
// WHY THE MOVE STAYS INSIDE THE BLOCK, AND HOISTING STAYS FORBIDDEN
//   Both compile. Hoisting to module scope widens an identifier's scope, so it can collide
//   with an existing module-scope name, capture (or be captured by) references in sibling
//   blocks, and alias what the model intended as block-local state across every
//   `initial`/`always` in the module - a meaning change that still compiles and still prints
//   check lines. Moving a declaration to the top of its OWN block leaves scope untouched, so
//   the hazard does not arise at all, and it fixes the same measured 25 of 29.
//
// WHY A BLOCK THAT NEEDS NO MOVE IS NOT TOUCHED AT ALL
//   A declaration already ahead of its block's first statement is ACCEPTED, named or unnamed.
//   Such a block is therefore not a defect site, and it comes back byte-identical - zero
//   changed lines. The label would buy nothing from the oracle there, and this transform
//   rewrites the measuring instrument, so it edits only what it must.
//
// WHY AN INITIALIZED DECLARATION NEEDS NO DECLINE
//   `integer i = 0;` is accepted as the FIRST item of a block and rejected after a statement,
//   exactly like a bare declaration, and static initialization happens BEFORE any procedural
//   code rather than at the declaration's textual position: an `integer c = 0;` inside a `for`
//   body initialized ONCE across three iterations, and `integer i = src;` read `x` even though
//   another `initial` had already assigned `src = 9` at t=0. So relocating an initialized
//   declaration within its own block cannot change when initialization happens.
//
// WHAT TRAVELS AND WHAT DOES NOT
//   A same-line trailing comment travels with its declaration. A comment line PRECEDING a
//   declaration does not travel, and can end up describing whatever statement now follows -
//   cosmetic only, with no parse effect. Requirement 5.3's token preservation is therefore a
//   MEASURED multiset claim rather than a free consequence of insert-only editing.
//
// This module performs no scan of its own beyond its own paren depths: `mask`,
// `moduleScopeNames`, and `takenIdentifiers` are all computed once by the normalizer entry
// point from one `scanSource` pass, so every rule in this folder sees one classification of one
// source (Req 4.15).

import { followingCodeOffset, type SourceMask } from '@app/tools';
import type { DialectDeclineCause, SpanEdit } from './types.js';

/** A declaration keyword that makes an unnamed `begin` illegal in this dialect (Req 4.9). */
export const DECLARATION_KEYWORDS: ReadonlySet<string> = new Set([
  'reg',
  'integer',
  'real',
  'time',
  'realtime',
  'wire',
  'localparam',
  'parameter',
  'event',
  'genvar',
]);

/**
 * The declaration keywords that no POSITION can rescue (Req 5.7).
 *
 * `genvar` is rejected as a block-item declaration at ANY position - in a procedural block and
 * in a function body alike - so a block carrying one is DECLINED with
 * `declaration-not-relocatable` rather than rewritten, and a fixture the toolchain still
 * refuses is never reported as fixed.
 *
 * WHY `genvar` STAYS IN `DECLARATION_KEYWORDS` RATHER THAN BEING REMOVED FROM IT
 *   It IS a declaration keyword, and that set answers a DETECTION question ("does this block
 *   carry a block-item declaration") shared with `normalizer.ts`'s module-scope reader, where
 *   `genvar` is perfectly legal and must keep contributing a name to `moduleScopeNames`.
 *   Removing it would make a `genvar` block invisible to this rule - reported as nothing at all
 *   rather than declined - and would silently narrow the shadow comparison at module scope.
 *   Relocatability is a separate question from declaration-hood, so it gets a separate set.
 */
const NON_RELOCATABLE_KEYWORDS: ReadonlySet<string> = new Set(['genvar']);

/** Block-opening keywords, depth-counted against the closers below (Req 5.4, over code spans). */
const BLOCK_OPENERS: ReadonlySet<string> = new Set([
  'begin',
  'case',
  'casex',
  'casez',
  'fork',
  'function',
  'task',
]);

/** Block-closing keywords, one-to-one with `BLOCK_OPENERS` by depth (not by keyword identity). */
const BLOCK_CLOSERS: ReadonlySet<string> = new Set([
  'end',
  'endcase',
  'join',
  'endfunction',
  'endtask',
]);

/**
 * The first word-shaped token of a declaration entry, NON-GLOBAL on purpose.
 *
 * WHY NON-GLOBAL: `declaredNamesAfter` is called from INSIDE two different token scans
 * (`matchUnnamedBeginBlocks` here, and `moduleScopeNamesOf` in `normalizer.ts`), both of which
 * depend on their own regex's `lastIndex` advancing. A shared `/g` regex carries mutable
 * `lastIndex` state, and resetting it from the nested call rewound the OUTER scan to offset 0
 * on every declaration keyword - an infinite loop that hung the whole suite. Without `/g`
 * there is no `lastIndex` to corrupt, so the hazard is gone by construction rather than by
 * careful resetting. Only the FIRST identifier of each comma-separated entry is ever wanted,
 * so a stateless `exec` is also sufficient.
 */
const FIRST_WORD_TOKEN = /[A-Za-z_$][A-Za-z0-9_$]*/;

/** A word-shaped token restricted to CODE spans, used for keyword and declared-name scanning. */
const CODE_TOKEN = /[A-Za-z_$][A-Za-z0-9_$]*/g;

interface CodeToken {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Every `[A-Za-z_$][A-Za-z0-9_$]*` token whose FIRST character falls on a code offset, in
 * source order.
 *
 * Block matching and declaration scanning both read code only, so a `begin` mentioned inside a
 * comment or a `$display` string is never treated as a site (Req 4.12, 5.3).
 */
function codeTokensOf(source: string, mask: SourceMask): readonly CodeToken[] {
  const tokens: CodeToken[] = [];
  CODE_TOKEN.lastIndex = 0;
  let match = CODE_TOKEN.exec(source);
  while (match !== null) {
    const start = match.index;
    if (mask.code[start] === 1) {
      tokens.push({ text: match[0], start, end: start + match[0].length });
    }
    match = CODE_TOKEN.exec(source);
  }
  return tokens;
}

/**
 * `(`/`)` nesting depth at every offset, saturating at 255, counted over CODE characters only.
 *
 * WHY THIS IS NOT ON `SourceMask`
 *   `SourceMask.bracketDepth` covers `[...]` and is what the range-dimension reading below uses.
 *   Paren depth answers a different question needed in exactly one place - "is this declaration
 *   keyword sitting in a `for` HEADER rather than at a block's statement level" - so it is
 *   computed here rather than widening a shared type every other caller would then carry.
 *   The convention matches `scanSource`'s bracket counting exactly: an opening paren reads as
 *   already inside, and a closing paren reads as still inside.
 */
function codeParenDepths(source: string, mask: SourceMask): Uint8Array {
  const depths = new Uint8Array(source.length);
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (mask.code[index] === 1) {
      const character = source.charAt(index);
      depth = character === '(' ? Math.min(255, depth + 1) : depth;
      depths[index] = depth;
      depth = character === ')' ? Math.max(0, depth - 1) : depth;
      continue;
    }
    depths[index] = depth;
  }
  return depths;
}

/** The 1-based line containing `offset`, from `SourceMask.lineStarts` (sorted ascending). */
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

/** The offset of the first character of the line containing `offset`. */
function lineStartAt(mask: SourceMask, offset: number): number {
  return mask.lineStarts[lineAt(mask, offset) - 1] ?? 0;
}

/** The offset of the first CODE `;` at or after `from`, or `null` when the source has none. */
function statementTerminatorOffset(source: string, mask: SourceMask, from: number): number | null {
  for (let index = from; index < source.length; index += 1) {
    if (mask.code[index] === 1 && source.charAt(index) === ';') {
      return index;
    }
  }
  return null;
}

interface OpenBegin {
  /** Start offset of this `begin` token itself. */
  readonly beginStart: number;
  /** End offset of this `begin` token (its last character's offset + 1). */
  readonly beginEnd: number;
  /** Whether this `begin` is already named (a `:` follows before the next token). */
  readonly named: boolean;
}

/** One block-item declaration statement found directly inside one block. */
interface BlockDeclaration {
  readonly keyword: string;
  /** Offset of the declaration keyword's first character. */
  readonly keywordStart: number;
  /** Offset just past the declaration keyword's last character. */
  readonly keywordEnd: number;
  /** Offset just past the terminating `;`, or `null` when the statement has none. */
  readonly statementEnd: number | null;
  readonly declaredNames: readonly string[];
}

interface MatchedBlock extends OpenBegin {
  /** End offset of the matching `end` token, or `null` if the source ran out first. */
  readonly endStart: number | null;
  /** Every declaration found directly inside this block (not inside a nested block). */
  readonly declarations: readonly BlockDeclaration[];
}

/**
 * Whether the next code token after `begin` is `:`, skipping whitespace AND comments.
 *
 * A COMMENT IS WHITESPACE. In Verilog a comment is lexically equivalent to whitespace and is
 * stripped before the parser sees the token stream, so `begin // c` newline `: blk` is a NAMED
 * block - confirmed at exit 0 against Icarus 13.0 with `-g2012`, as is the block-comment
 * variant. Adjacency is therefore read through `followingCodeOffset`, which `continue`s past a
 * non-code span. A walk that STOPPED at the comment judged this block unnamed and inserted
 * ` : tbnorm_blk_N` after `begin`, turning a source iverilog accepts into one it rejects - a
 * FALSE REWRITE, which this module's "false declines only, never false rewrites" invariant and
 * Requirement 5.3's token preservation both forbid (Req 4.12).
 *
 * A named `begin` is already legal and is never a site; this reads offsets rather than the
 * token list because `:` is not `[A-Za-z_$][A-Za-z0-9_$]*` and so never appears as a token.
 */
function isAlreadyNamed(source: string, mask: SourceMask, beginEnd: number): boolean {
  const offset = followingCodeOffset(source, mask, beginEnd);
  return offset !== null && source.charAt(offset) === ':';
}

/** Read one declaration statement starting at `token`, a `DECLARATION_KEYWORDS` member. */
function declarationAt(source: string, mask: SourceMask, token: CodeToken): BlockDeclaration {
  const terminator = statementTerminatorOffset(source, mask, token.end);
  return {
    keyword: token.text,
    keywordStart: token.start,
    keywordEnd: token.end,
    statementEnd: terminator === null ? null : terminator + 1,
    declaredNames: declaredNamesAfter(source, mask, token.end),
  };
}

/**
 * Depth-match every unnamed `begin` against its `end`, and collect the block-item declarations
 * sitting directly inside each (Req 4.9, 5.4, 5.13).
 *
 * Openers (`begin`, `case`/`casex`/`casez`, `fork`, `function`/`task`) and closers (`end`,
 * `endcase`, `join`, `endfunction`/`endtask`) are depth-counted together as one nesting stack,
 * because a declaration keyword appearing between a `begin` and its own `end` is inside that
 * block regardless of what other construct nests between them.
 *
 * A declaration keyword at code-paren depth GREATER THAN ZERO is excluded: it is a `for` header
 * (`for (integer i = 0; i < 3; i = i + 1)`, LEGAL under `-g2012`) and not a block item at all,
 * so it is neither a site nor a decline. Counting it was harmless while this rule only
 * inserted, and destructive the moment it moves - lifting the `integer` out of a header
 * produced `for ( i < 86400; i = i + 1)`, a false rewrite that dropped measured effectiveness
 * from 25 of 29 to 20 of 29.
 */
function matchUnnamedBeginBlocks(source: string, mask: SourceMask): readonly MatchedBlock[] {
  const tokens = codeTokensOf(source, mask);
  const parenDepths = codeParenDepths(source, mask);
  const blocks: MatchedBlock[] = [];
  // One stack entry per open block; entries for `begin` also accumulate the declarations seen
  // while they are the innermost frame.
  const stack: Array<{ readonly begin: OpenBegin | null; declarations: BlockDeclaration[] }> = [];

  for (const token of tokens) {
    if (BLOCK_OPENERS.has(token.text)) {
      const begin =
        token.text === 'begin'
          ? {
              beginStart: token.start,
              beginEnd: token.end,
              named: isAlreadyNamed(source, mask, token.end),
            }
          : null;
      stack.push({ begin, declarations: [] });
      continue;
    }
    if (BLOCK_CLOSERS.has(token.text)) {
      const frame = stack.pop();
      if (frame?.begin !== undefined && frame?.begin !== null && !frame.begin.named) {
        blocks.push({ ...frame.begin, endStart: token.start, declarations: frame.declarations });
      }
      continue;
    }
    if (DECLARATION_KEYWORDS.has(token.text) && parenDepths[token.start] === 0) {
      const innermost = stack[stack.length - 1];
      if (innermost !== undefined) {
        innermost.declarations.push(declarationAt(source, mask, token));
      }
    }
  }

  // Anything left open on the stack ran out of source before its `end`: unbalanced.
  for (const frame of stack) {
    if (frame.begin !== null && !frame.begin.named) {
      blocks.push({ ...frame.begin, endStart: null, declarations: frame.declarations });
    }
  }

  return blocks;
}

/**
 * `source` over `[start, end)` with every character that is NOT a bare code character replaced
 * by a space.
 *
 * TWO THINGS ARE BLANKED, FOR TWO DIFFERENT REASONS.
 *
 * A COMMENT IS WHITESPACE, so blanking a comment span is the lexically faithful reading of the
 * text - and blanking rather than DELETING is what keeps it faithful: deleting the span would
 * join the tokens on either side of it, so `reg a/*x*\/b;` would read as the single identifier
 * `ab`.
 *
 * A BRACKETED SPAN IS A DIMENSION, NOT A NAME. A range or array dimension is blanked via
 * `SourceMask.bracketDepth`, because a parameterized bound IS identifier-shaped and the
 * identifier regex cannot tell it from a declared name: `reg [WIDTH-1:0] a;` read `WIDTH`,
 * `reg [ADDR_WIDTH:0] a, b;` read `ADDR_WIDTH` and `b`, and `reg [WIDTH-1:0] a = b;` read
 * `WIDTH`. That produced a FALSE `would-shadow-module-scope` decline on any testbench whose
 * range bound names a module-scope parameter - the normal way to write a parameterized
 * testbench - and the same reader builds `moduleScopeNames`, so the error sat on BOTH sides of
 * the comparison. Blanking the dimension also removes any comma inside it, which is what keeps
 * the comma split below reading declaration ENTRIES.
 *
 * Offsets are preserved by both blankings, so nothing downstream has to re-map them.
 */
function declarationBodyText(source: string, mask: SourceMask, start: number, end: number): string {
  let text = '';
  for (let index = start; index < end; index += 1) {
    const isBareCode = mask.code[index] === 1 && mask.bracketDepth[index] === 0;
    text += isBareCode ? source.charAt(index) : ' ';
  }
  return text;
}

/**
 * The identifier names declared by one declaration statement, read from just after its keyword
 * up to the statement's terminating `;`.
 *
 * THE ONE OWNER of this read. It existed in two near-duplicate copies, here and in
 * `normalizer.ts`, and it is the reader Requirement 5.4's `would-shadow-module-scope` decline
 * depends on: `normalizer.ts` builds `moduleScopeNames` with it and this module reads each
 * block's declared names with it, so the two MUST agree on what a declaration declares or the
 * shadow comparison is between two different vocabularies. `normalizer.ts` already imports
 * `DECLARATION_KEYWORDS` from here, so this module is already the owner of "what a declaration
 * is" and no new import edge or shared module is needed (`types.ts` stays types-only).
 *
 * The name is taken from bare CODE offsets only, via `declarationBodyText`; see the note above
 * that function for the comment span and the range dimension it blanks, and why reading either
 * of them as a name defeated the shadow decline (Req 4.12, 4.15, 5.4).
 *
 * Handles the comma-separated list a single declaration may introduce (`reg a, b, c;`) and
 * ignores an initializer's right-hand side by stopping name capture at `=` for each entry, so
 * `integer i = j;` reports only `i` and not `j`.
 */
export function declaredNamesAfter(source: string, mask: SourceMask, keywordEnd: number): string[] {
  const terminator = statementTerminatorOffset(source, mask, keywordEnd);
  const body = declarationBodyText(source, mask, keywordEnd, terminator ?? source.length);
  const names: string[] = [];
  for (const entry of body.split(',')) {
    const beforeAssignment = entry.split('=')[0] ?? '';
    const match = FIRST_WORD_TOKEN.exec(beforeAssignment);
    if (match !== null) {
      names.push(match[0]);
    }
  }
  return names;
}

/**
 * The next `tbnorm_blk_<n>` candidate absent from both `takenIdentifiers` (the whole input's
 * identifier set) and every name already assigned earlier in this call (Req 5.5).
 *
 * Termination is bounded: the input's identifier set is finite in the source length, so at
 * most `|takenIdentifiers| + 1` candidates are tried before one is guaranteed absent.
 */
function nextBlockLabel(
  takenIdentifiers: ReadonlySet<string>,
  alreadyAssigned: ReadonlySet<string>,
): string {
  let n = 1;
  let candidate = `tbnorm_blk_${n}`;
  while (takenIdentifiers.has(candidate) || alreadyAssigned.has(candidate)) {
    n += 1;
    candidate = `tbnorm_blk_${n}`;
  }
  return candidate;
}

/** One declaration's planned relocation: what to cut, what to re-emit, and where it came from. */
interface Relocation {
  readonly removeStart: number;
  readonly removeEnd: number;
  /** The re-emitted text, indent included, WITHOUT a leading newline. */
  readonly text: string;
  /** 1-based line the declaration was cut from. */
  readonly line: number;
}

/** The run of spaces and tabs starting at `from`, stopping at `limit`. */
function whitespaceRun(source: string, from: number, limit: number): string {
  let index = from;
  while (index < limit && (source.charAt(index) === ' ' || source.charAt(index) === '\t')) {
    index += 1;
  }
  return source.slice(from, index);
}

/**
 * The offset just past a trailing comment sitting on the declaration's OWN line, or `from` when
 * there is none.
 *
 * A same-line trailing comment travels with its declaration, because it describes that
 * declaration and leaving it behind would attach it to whatever statement the move exposes. A
 * comment that would span a newline is NOT taken: it belongs to the lines it covers.
 */
function trailingCommentEnd(source: string, from: number): number {
  const index = from + whitespaceRun(source, from, source.length).length;
  if (source.startsWith('//', index)) {
    const newline = source.indexOf('\n', index);
    return newline === -1 ? source.length : newline;
  }
  if (source.startsWith('/*', index)) {
    const close = source.indexOf('*/', index + 2);
    if (close !== -1 && !source.slice(index, close).includes('\n')) {
      return close + 2;
    }
  }
  return from;
}

/**
 * The offset just past the line terminator following `from`, or `from` when anything other than
 * whitespace-then-newline follows.
 *
 * Swallowing the terminator is what stops a relocated declaration leaving a blank line behind.
 */
function lineTerminatorEnd(source: string, from: number): number {
  const index = from + whitespaceRun(source, from, source.length).length;
  if (source.startsWith('\r\n', index)) {
    return index + 2;
  }
  return source.charAt(index) === '\n' ? index + 1 : from;
}

/**
 * Plan one declaration's relocation.
 *
 * A declaration that OWNS its line (nothing but indentation before it) is cut with that
 * indentation and its line terminator, so the line disappears rather than becoming blank, and
 * the indentation is re-emitted with the declaration so the moved text keeps its shape. A
 * declaration sharing a line with other code is cut alone, leaving that line's other statements
 * exactly where they were.
 */
function relocationOf(source: string, mask: SourceMask, declaration: BlockDeclaration): Relocation {
  const statementEnd = declaration.statementEnd ?? declaration.keywordEnd;
  const lineStart = lineStartAt(mask, declaration.keywordStart);
  const indent = whitespaceRun(source, lineStart, declaration.keywordStart);
  const ownsItsLine = lineStart + indent.length === declaration.keywordStart;
  const textEnd = trailingCommentEnd(source, statementEnd);
  return {
    removeStart: ownsItsLine ? lineStart : declaration.keywordStart,
    removeEnd: ownsItsLine ? lineTerminatorEnd(source, textEnd) : textEnd,
    text: indent + source.slice(declaration.keywordStart, textEnd),
    line: lineAt(mask, declaration.keywordStart),
  };
}

/**
 * Whether any of this block's declarations is preceded, inside this block, by a STATEMENT.
 *
 * DECIDED OVER CODE CHARACTERS, NEVER OVER TOKENS. `#10;`, `@(posedge clk);`, `->ev;` and a
 * bare `;` are all statements that carry no `[A-Za-z_$][A-Za-z0-9_$]*` token at all, so a
 * token-stream reading judged the declarations after them "already first" and left them alone;
 * deciding it over code characters raised measured effectiveness from 24 of 29 to 25 of 29. The
 * walk itself is `followingCodeOffset`, the shared owner of "skip whitespace AND comments
 * forward", rather than a fifth spelling of that loop.
 *
 * The cursor advances past each declaration's own span, so an earlier declaration of the SAME
 * block never reads as the statement that displaced a later one.
 */
function statementPrecedesADeclaration(
  source: string,
  mask: SourceMask,
  block: MatchedBlock,
): boolean {
  let cursor = block.beginEnd;
  for (const declaration of block.declarations) {
    const offset = followingCodeOffset(source, mask, cursor);
    if (offset !== null && offset < declaration.keywordStart) {
      return true;
    }
    cursor = declaration.statementEnd ?? declaration.keywordEnd;
  }
  return false;
}

/**
 * Why this block is left alone, or `null` when it may be rewritten.
 *
 * Ordered hard ceiling first, conservative guard second. `unbalanced-block` comes first because
 * a rule that cannot see a block's extent cannot know what it declares; `declaration-not-
 * relocatable` second because no position helps it; `would-shadow-module-scope` last because it
 * is an over-approximation whose ceiling is false declines only.
 *
 * The shadow check runs BEFORE the "does anything need moving" gate on purpose: a shadow hazard
 * is named even for a block that needed no move, so the gate can never silently swallow one.
 */
function declineCauseFor(
  block: MatchedBlock,
  moduleScopeNames: ReadonlySet<string>,
): DialectDeclineCause | null {
  if (block.endStart === null) {
    return 'unbalanced-block';
  }
  const unmovable = block.declarations.some(
    (declaration) =>
      NON_RELOCATABLE_KEYWORDS.has(declaration.keyword) || declaration.statementEnd === null,
  );
  if (unmovable) {
    return 'declaration-not-relocatable';
  }
  // ponytail: this over-approximates by checking against `moduleScopeNames`, which the caller
  // (normalizer.ts) builds from every module-scope declaration in the whole FILE, not just the
  // module enclosing this block. A file declaring two or more modules can therefore decline a
  // block that would in fact be safe to rewrite. The ceiling is false declines only, never
  // false rewrites: a name absent from the over-approximated set is absent from the real,
  // narrower set too. Upgrade path: track `module`/`endmodule` boundaries in the scan and scope
  // `moduleScopeNames` per module, worth doing only if a measured campaign shows the declined
  // residue is dominated by cross-module false positives.
  const names = block.declarations.flatMap((declaration) => declaration.declaredNames);
  return names.some((name) => moduleScopeNames.has(name)) ? 'would-shadow-module-scope' : null;
}

/**
 * The edits that name one block and lift its declarations to the top of it.
 *
 * ONE INSERTION PLUS ONE REMOVAL PER DECLARATION, all over the ORIGINAL offsets. The insertion
 * carries the label and every relocated declaration, in original relative source order, so
 * multi-declaration ordering is preserved by construction rather than by a sort. EVERY
 * declaration of the block is relocated, including one that already sat first: re-emitting it
 * at the same relative position is byte-neutral, and relocating only the displaced ones would
 * reorder them against the ones left behind.
 *
 * Each removal carries its own `rewritten` finding at the line it was cut from, so a block with
 * n relocated declarations reports n + 1 findings - the block, and each place text moved from.
 * That is the honest count: a finding is one thing the rule did at one place in the source.
 */
function moveEdits(input: {
  readonly mask: SourceMask;
  readonly block: MatchedBlock;
  readonly label: string;
  readonly relocations: readonly Relocation[];
}): readonly SpanEdit[] {
  const { mask, block, label, relocations } = input;
  const lifted = relocations.map((relocation) => `\n${relocation.text}`).join('');
  const insertion: SpanEdit = {
    start: block.beginEnd,
    end: block.beginEnd,
    replacement: ` : ${label}${lifted}`,
    finding: {
      dialectClass: 'unnamed-begin-declaration',
      line: lineAt(mask, block.beginStart),
      action: 'rewritten',
    },
  };
  const removals = relocations.map((relocation): SpanEdit => ({
    start: relocation.removeStart,
    end: relocation.removeEnd,
    replacement: '',
    finding: {
      dialectClass: 'unnamed-begin-declaration',
      line: relocation.line,
      action: 'rewritten',
    },
  }));
  return [insertion, ...removals];
}

/**
 * A declined site produces no text change: the empty span `[siteStart, siteStart)` with an
 * empty replacement is a true no-op wherever it is spliced, so a declined finding rides the
 * same `SpanEdit` shape as a rewrite without altering the source.
 */
function declinedFinding(siteStart: number, line: number, cause: DialectDeclineCause): SpanEdit {
  return {
    start: siteStart,
    end: siteStart,
    replacement: '',
    finding: {
      dialectClass: 'unnamed-begin-declaration',
      line,
      action: 'declined',
      declinedBecause: cause,
    },
  };
}

/**
 * Plan the label insertion and the intra-block declaration move for every unnamed `begin` block
 * whose declarations sit after a statement (Req 4.9, 5.13, 5.14), declining the three shapes
 * `declineCauseFor` names.
 *
 * `moduleScopeNames` and `takenIdentifiers` are both computed once by the caller from the same
 * mask, so this rule performs no scan of its own beyond its paren depths, and every rule in
 * this folder sees one classification of one source.
 */
export function planUnnamedBeginLabels(input: {
  readonly source: string;
  readonly mask: SourceMask;
  readonly moduleScopeNames: ReadonlySet<string>;
  readonly takenIdentifiers: ReadonlySet<string>;
}): readonly SpanEdit[] {
  const { source, mask, moduleScopeNames, takenIdentifiers } = input;
  // An unbalanced block is reported regardless of whether a declaration was found inside it:
  // the scan ran off the end of the source before reaching its `end`, so "no declaration seen"
  // and "declares nothing" are indistinguishable, and a rule that cannot see a block's extent
  // cannot know what it declares.
  const blocks = matchUnnamedBeginBlocks(source, mask).filter(
    (block) => block.endStart === null || block.declarations.length > 0,
  );

  const edits: SpanEdit[] = [];
  const assignedLabels = new Set<string>();

  for (const block of blocks) {
    const cause = declineCauseFor(block, moduleScopeNames);
    if (cause !== null) {
      edits.push(declinedFinding(block.beginStart, lineAt(mask, block.beginStart), cause));
      continue;
    }
    if (!statementPrecedesADeclaration(source, mask, block)) {
      // Not a defect site: every declaration already precedes this block's first statement,
      // which the toolchain accepts whether or not the block is named. Left byte-identical.
      continue;
    }
    const label = nextBlockLabel(takenIdentifiers, assignedLabels);
    assignedLabels.add(label);
    const relocations = block.declarations.map((declaration) =>
      relocationOf(source, mask, declaration),
    );
    edits.push(...moveEdits({ mask, block, label, relocations }));
  }

  return edits;
}
