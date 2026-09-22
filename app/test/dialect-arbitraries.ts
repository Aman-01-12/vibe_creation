// testbench-dialect-normalization, task group 7 and task 15.6: the one STRUCTURED Verilog
// generator, and the lexical readers, that every meaning-preservation property in this spec
// shares.
//
// WHY A STRUCTURED GENERATOR AND NOT RANDOM TEXT
//   Task 7.3 states the reason directly: a character-level generator spends its whole budget on
//   inputs the normalizer refuses wholesale (`refusedWholeSource`) or finds no site in, so every
//   meaning property passes VACUOUSLY. The generator below emits a module header, module-scope
//   declarations, `initial` procedural blocks, nested `begin`/`end`, `case`, `fork`, and
//   `$display` with string arguments - and, on purpose, the shapes the group-15 measurement
//   showed the rule turns on: a declaration AFTER a statement, a preceding statement carrying no
//   word token, a block with more than one declaration, a nested block, a `for`-header
//   declaration, a `genvar`, and a block whose declarations are already first.
//
//   Every property that consumes this generator asserts NON-VACUITY explicitly: a counted
//   fraction of its generated cases must actually trigger a rewrite, and the test FAILS if none
//   does. A structured generator is what makes that achievable; the counted guard is what makes
//   it true rather than hoped for.
//
// WHY EVERY BLOCK AND EVERY ITEM IS UNIQUELY NAMED
//   Property 27 ("a relocated declaration stays in its own block, ahead of that block's first
//   statement, in its original relative order") is a claim about POSITIONS in the output. Naming
//   every declaration (`d3`) and every statement (`"S7"`) uniquely is what lets a test locate
//   them in the output without writing a Verilog parser, and what separates "in its own block"
//   from "in the enclosing block" - the distinction 3 of the 26 measured blocks turn on.
//
// WHAT THE READERS BELOW ARE FOR, AND THE TRAP THEY AVOID
//   The dialect fixture suite already cost three red tests to ONE root cause: two grammars for
//   one question, graded against each other
//   (`chipAgent/_inbox/verification-recipe-dialect-fixtures-parse-alone-through-simulatoradapter-pins-0-of-29.md`).
//   So the readers here are single-owner: ONE tokenizer backs the code-token multiset, the
//   comment multiset, the statement-order comparison, and the block-extent matching, so a
//   disagreement between two of them surfaces as a test defect rather than as a false claim about
//   the transform.
//
// WHY A COMMENT IS EXCLUDED FROM THE STATEMENT COMPARISON AND A STRING IS NOT
//   A comment is lexically WHITESPACE in Verilog, and the transform is documented to let a
//   same-line trailing comment TRAVEL with its declaration while a preceding comment line stays
//   put (task 15.5). So comment position is not part of a statement's identity and is asserted as
//   a multiset instead. A string literal IS a token the parser sees, so it stays in the statement
//   comparison - which is also what makes each `$display("S7")` marker distinguishable.
//
// NO SHARED `/g` REGEX. Every regex below is constructed per call. A module-level `/g` object
// carries mutable `lastIndex`, and sharing one across nested scans hung this whole suite once
// (`chipAgent/_inbox/gotcha-shared-global-regex-lastindex-infinite-loop.md`).
//
// Pure: no clock, no I/O, no model call. Every generated value comes from fast-check's seed.

import fc from 'fast-check';

import { scanSource } from '@app/tools';

// ---------------------------------------------------------------------------
// The one tokenizer
// ---------------------------------------------------------------------------

/**
 * The declaration keywords the generator emits, mirroring `DECLARATION_KEYWORDS` in
 * `app/agent/orchestrator/dialect/unnamed-begin.ts`.
 *
 * Restated rather than imported because the production set is module-private to the rule and is
 * not on `@app/agent`'s public surface. The restatement is safe in one direction only: this list
 * is used solely to PARTITION generated statements into "declaration" and "executable", and the
 * generator emits declarations only from this list. A production set that grew a member this list
 * lacks could at worst make the partition too coarse; it can never weaken a multiset claim,
 * because those read every token regardless of which partition it falls in.
 */
const DECLARATION_KEYWORDS: ReadonlySet<string> = new Set([
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

/** Keywords that OPEN a block, depth-counted exactly as `matchUnnamedBeginBlocks` counts them. */
const BLOCK_OPENERS: ReadonlySet<string> = new Set([
  'begin',
  'case',
  'casex',
  'casez',
  'fork',
  'function',
  'task',
]);

/** Keywords that CLOSE a block, one-to-one with the openers by depth, not by identity. */
const BLOCK_CLOSERS: ReadonlySet<string> = new Set([
  'end',
  'endcase',
  'join',
  'endfunction',
  'endtask',
]);

/** What one token is. */
type TokenKind = 'word' | 'punct' | 'string' | 'comment' | 'directive';

/** One token of a Verilog source: a code token, or one whole non-code span. */
interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  /** Offset of the token's first character in the source. */
  readonly start: number;
}

/**
 * Every token of `source`, in source order: code words, single code punctuation characters, and
 * each non-code span whole.
 *
 * The single owner of "what a token is" for every reader below. Code classification comes from
 * the production `SourceMask`, so a `begin` inside a comment or a `$display` string is a
 * `comment`/`string` token rather than a `word` - never a site, by the same mechanism the rules
 * themselves use.
 */
function tokensOf(source: string): readonly Token[] {
  const mask = scanSource(source);
  const tokens: Token[] = [];
  // Constructed per call, non-global: a shared `/g` object's `lastIndex` is the hazard.
  const word = /^[A-Za-z_$][A-Za-z0-9_$]*/;
  let index = 0;
  while (index < source.length) {
    if (mask.code[index] !== 1) {
      const span = spanAt(source, index);
      if (span === null) {
        // A non-code offset that opens nothing: a line comment's own terminating newline, which
        // belongs to no span.
        index += 1;
        continue;
      }
      tokens.push({ kind: span.kind, text: source.slice(index, span.end), start: index });
      index = span.end;
      continue;
    }
    const character = source.charAt(index);
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    const match = word.exec(source.slice(index));
    if (match !== null) {
      tokens.push({ kind: 'word', text: match[0], start: index });
      index += match[0].length;
      continue;
    }
    tokens.push({ kind: 'punct', text: character, start: index });
    index += 1;
  }
  return tokens;
}

/** The kind and exclusive end offset of the non-code span opening at `start`, or `null`. */
function spanAt(
  source: string,
  start: number,
): { readonly kind: TokenKind; readonly end: number } | null {
  if (source.startsWith('//', start)) {
    return { kind: 'comment', end: endOfLine(source, start) };
  }
  if (source.startsWith('/*', start)) {
    const close = source.indexOf('*/', start + 2);
    return { kind: 'comment', end: close === -1 ? source.length : close + 2 };
  }
  if (source.charAt(start) === '"') {
    return { kind: 'string', end: endOfStringLiteral(source, start) };
  }
  if (source.charAt(start) === '`') {
    return { kind: 'directive', end: endOfLine(source, start) };
  }
  return null;
}

/** The offset of the newline ending the line containing `start`, or the source's end. */
function endOfLine(source: string, start: number): number {
  const newline = source.indexOf('\n', start);
  return newline === -1 ? source.length : newline;
}

/** The offset just past the closing quote of the string literal opening at `start`. */
function endOfStringLiteral(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    const character = source.charAt(index);
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === '"') {
      return index + 1;
    }
    index += 1;
  }
  return source.length;
}

// ---------------------------------------------------------------------------
// Lexical readers, all built on `tokensOf`
// ---------------------------------------------------------------------------

/**
 * The CODE word tokens of `source`, in source order.
 *
 * The multiset of this list is Property 2's first claim. Word-shaped only, matching
 * `takenIdentifiersOf`'s grammar in `normalizer.ts`, which is what makes "the sole addition is
 * the inserted labels" the exact claim: a label IS a word token; the ` : ` introducing it is not.
 */
export function codeWordTokens(source: string): readonly string[] {
  return tokensOf(source)
    .filter((token) => token.kind === 'word')
    .map((token) => token.text);
}

/** Every comment span's text, in source order, each span whole. */
export function commentSpans(source: string): readonly string[] {
  return tokensOf(source)
    .filter((token) => token.kind === 'comment')
    .map((token) => token.text);
}

/** Every string-literal span's text, in source order, quotes included. */
export function stringSpans(source: string): readonly string[] {
  return tokensOf(source)
    .filter((token) => token.kind === 'string')
    .map((token) => token.text);
}

/**
 * Every identifier-shaped token anywhere in the RAW text, code and non-code spans alike.
 *
 * Deliberately unfiltered by the mask, mirroring `takenIdentifiersOf` in `normalizer.ts`: a name
 * mentioned in a comment or a string still makes that name unsafe to mint as a fresh block label,
 * so Requirement 5.5's "collides with nothing in the input" is a claim over the raw text.
 */
export function allIdentifierTokens(source: string): readonly string[] {
  const tokens = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  return [...source.matchAll(tokens)].map((match) => match[0]);
}

/** One `begin ... end` extent, as the offsets of its two keyword tokens. */
export interface BlockExtent {
  readonly beginStart: number;
  readonly endStart: number;
}

/**
 * Every `begin ... end` extent in `source`, depth-matched over code tokens.
 *
 * `case`/`fork`/`function`/`task` are counted into the same nesting stack as `begin`, exactly as
 * `matchUnnamedBeginBlocks` does, because a declaration between a `begin` and its own `end` is
 * inside that block regardless of what else nests between them.
 */
export function beginEndExtents(source: string): readonly BlockExtent[] {
  const extents: BlockExtent[] = [];
  const stack: (number | null)[] = [];
  for (const token of tokensOf(source)) {
    if (token.kind !== 'word') {
      continue;
    }
    if (BLOCK_OPENERS.has(token.text)) {
      stack.push(token.text === 'begin' ? token.start : null);
      continue;
    }
    if (BLOCK_CLOSERS.has(token.text)) {
      const beginStart = stack.pop();
      if (beginStart !== undefined && beginStart !== null) {
        extents.push({ beginStart, endStart: token.start });
      }
    }
  }
  return extents;
}

/**
 * The innermost `begin ... end` extent strictly containing `offset`, or `null`.
 *
 * "Innermost" is what separates Property 27's "inside the same extent it was declared in" from
 * "somewhere in an enclosing block": a declaration hoisted one level out would still sit inside
 * the outer extent, and only the innermost reading catches it.
 */
export function innermostExtentContaining(source: string, offset: number): BlockExtent | null {
  const containing = beginEndExtents(source).filter(
    (extent) => extent.beginStart < offset && offset < extent.endStart,
  );
  const first = containing[0];
  if (first === undefined) {
    return null;
  }
  return containing.reduce(
    (narrowest, extent) =>
      extent.endStart - extent.beginStart < narrowest.endStart - narrowest.beginStart
        ? extent
        : narrowest,
    first,
  );
}

/**
 * The `;`-and-block-keyword delimited statements of `source` that are NOT declarations.
 *
 * Property 2's "the subsequence of EXECUTABLE statements is identical in order before and after"
 * is asserted over this list. Three decisions make it faithful:
 *
 *   - A block keyword SEPARATES. `begin` carries no `;`, so without this the first item of a
 *     block would share a fragment with the `initial` that opened it, and a label insertion or a
 *     relocated declaration would change that fragment's text - failing for the very difference
 *     Property 2 permits.
 *   - A `;` inside parens does NOT separate, so a `for (integer i = 0; ...)` header stays one
 *     statement. That is what makes group 15's paren-depth exclusion observable here instead of
 *     hidden.
 *   - Comments and directives are excluded, string literals are kept; see the module header.
 *
 * Empty fragments are RETAINED: the transform neither creates nor destroys a `;` or a block
 * keyword, so dropping empties would hide a reordering that involved only bare `;` statements.
 */
export function executableStatements(source: string): readonly string[] {
  const fragments: Token[][] = [];
  let current: Token[] = [];
  let parenDepth = 0;
  for (const token of tokensOf(source)) {
    if (token.kind === 'comment' || token.kind === 'directive') {
      continue;
    }
    if (token.kind === 'word' && (BLOCK_OPENERS.has(token.text) || BLOCK_CLOSERS.has(token.text))) {
      fragments.push(current);
      current = [];
      continue;
    }
    if (token.text === '(') {
      parenDepth += 1;
    } else if (token.text === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
    }
    if (token.text === ';' && parenDepth === 0) {
      fragments.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  fragments.push(current);
  return fragments
    .filter((fragment) => !isDeclarationFragment(fragment))
    .map((fragment) => fragment.map((token) => token.text).join(' '));
}

/** Whether a fragment's first WORD token is a declaration keyword. */
function isDeclarationFragment(fragment: readonly Token[]): boolean {
  const firstWord = fragment.find((token) => token.kind === 'word');
  return firstWord !== undefined && DECLARATION_KEYWORDS.has(firstWord.text);
}

/**
 * Every `tbnorm_blk_<n>` OCCURRENCE present in `output` and absent from `input`, in output order.
 *
 * Occurrences, not a deduplicated set: Property 2's multiset arithmetic needs the exact bag of
 * added tokens, and a label accidentally inserted twice must show up as two additions rather than
 * being silently collapsed into one. Property 6's pairwise-distinctness claim is asserted over
 * this list separately, which is only meaningful because nothing here deduplicates.
 */
export function insertedBlockLabels(input: string, output: string): readonly string[] {
  const inputTokens = new Set(allIdentifierTokens(input));
  return allIdentifierTokens(output).filter(
    (token) => /^tbnorm_blk_\d+$/.test(token) && !inputTokens.has(token),
  );
}

/**
 * `output` with each inserted ` : <label>` removed.
 *
 * The label insertion is the one addition Property 2 already accounts for in its multiset half,
 * so removing it lets the statement-order half compare like with like. The rule emits exactly
 * ` : ${label}` immediately after `begin`, so the literal is removed rather than loosely matched.
 */
export function withoutInsertedLabels(output: string, labels: readonly string[]): string {
  return [...new Set(labels)].reduce((text, label) => text.split(` : ${label}`).join(''), output);
}

// ---------------------------------------------------------------------------
// The structured Verilog generator
// ---------------------------------------------------------------------------

/** One block-item declaration the generator emitted. */
export interface DeclarationPlan {
  /** The declared name, unique across the whole generated source. */
  readonly name: string;
  /** The rendered statement, e.g. `integer d3;` or `reg [7:0] d4;`, trailing comment included. */
  readonly text: string;
}

/** One executable statement the generator emitted. */
export interface StatementPlan {
  /** The rendered statement, e.g. `$display("S7");` or `#10;`. */
  readonly text: string;
  /**
   * The unique marker a `$display` statement carries, or `null` for a statement that carries no
   * assignable word token (`#10;`, `->ev;`, a bare `;`, `@(posedge clk);`).
   */
  readonly marker: string | null;
}

/** One generated procedural block. */
export interface BlockPlan {
  /** The block's declarations, in the relative order they were emitted. */
  readonly declarations: readonly DeclarationPlan[];
  /**
   * The block's executable statements, in emitted order; always non-empty, and the FIRST one
   * always carries a marker, so "ahead of that block's first executable statement" is a position
   * a test can locate in the output without a parser.
   */
  readonly statements: readonly StatementPlan[];
  /** When `true`, every declaration is emitted before every statement, so no move is needed. */
  readonly declarationsFirst: boolean;
  /** A statement carrying no assignable word token, emitted immediately before the declarations. */
  readonly wordlessBefore: StatementPlan | null;
  /** A block nested directly inside this one, or `null`. */
  readonly nested: BlockPlan | null;
}

/** A whole generated source, with the metadata a position claim needs. */
export interface GeneratedVerilog {
  readonly text: string;
  /** Every procedural block, outermost first, in source order. */
  readonly blocks: readonly BlockPlan[];
  /** The check names emitted as `$display("CHECK <name> PASS")` arguments. */
  readonly checkNames: readonly string[];
  /** Names declared at module scope. */
  readonly moduleScopeNames: readonly string[];
}

/** What the generator may include beyond its always-on core. */
export interface VerilogShapeOptions {
  /** Emit a `for (integer <n> = 0; ...)` header declaration inside its own block. */
  readonly forHeaderDeclaration: boolean;
  /** Emit a `case ... endcase`. */
  readonly caseBlock: boolean;
  /** Emit a `fork ... join`. */
  readonly forkBlock: boolean;
  /** Emit a SEPARATE block whose only block-item declaration is a `genvar`. */
  readonly genvarBlock: boolean;
}

/** Names declared at module scope by every generated source. */
const MODULE_SCOPE_NAMES: readonly string[] = Object.freeze(['clk', 'sel', 'ev', 'acc']);

/** The module-scope preamble every generated source shares. */
const MODULE_PREAMBLE: readonly string[] = Object.freeze([
  'module tbnorm_generated_tb;',
  '  reg clk;',
  '  reg [1:0] sel;',
  '  event ev;',
  '  integer acc;',
]);

/** Statements a token-stream reading of "is a statement before this declaration" misjudges. */
const WORDLESS_STATEMENT_TEXTS: readonly string[] = Object.freeze([
  '#10;',
  '->ev;',
  ';',
  // `@(posedge clk);` DOES carry two word tokens, unlike the three above. It is generated anyway
  // because it is the fourth shape task 15.3 names: a statement whose word tokens are neither a
  // declaration keyword nor an assignment target, which a token-stream reading also misjudges.
  '@(posedge clk);',
]);

/** The declaration forms the generator emits; `%s` stands for the unique name. */
const DECLARATION_FORMS: readonly string[] = Object.freeze([
  'integer %s;',
  'reg [7:0] %s;',
  'integer %s = 0;',
  'reg %s, %s_b;',
  'time %s;',
  'real %s; // declares %s',
]);

/** A counter handing out globally unique suffixes within one generated source. */
class NameMinter {
  #next = 0;
  take(prefix: string): string {
    this.#next += 1;
    return `${prefix}${this.#next}`;
  }
}

/** Build one declaration from a form index and a freshly minted name. */
function declarationOf(minter: NameMinter, formIndex: number): DeclarationPlan {
  const name = minter.take('d');
  const form = DECLARATION_FORMS[formIndex % DECLARATION_FORMS.length] ?? 'integer %s;';
  return { name, text: form.split('%s').join(name) };
}

/** Build one uniquely-marked `$display` statement. */
function displayStatementOf(minter: NameMinter): StatementPlan {
  const marker = minter.take('S');
  return { text: `$display("${marker}");`, marker };
}

/** Build one statement carrying no assignable word token. */
function wordlessStatementOf(index: number): StatementPlan {
  const text = WORDLESS_STATEMENT_TEXTS[index % WORDLESS_STATEMENT_TEXTS.length] ?? ';';
  return { text, marker: null };
}

/** The per-block generated shape, before names are minted. */
interface BlockSpec {
  readonly declarationCount: number;
  readonly declarationFormIndex: number;
  readonly statementCount: number;
  readonly declarationsFirst: boolean;
  readonly wordlessIndex: number | null;
  readonly nested: BlockSpec | null;
}

/** Recursive block-shape arbitrary, bounded to two levels so a source stays shrinkable. */
function blockSpecArbitrary(depth: number): fc.Arbitrary<BlockSpec> {
  const nested: fc.Arbitrary<BlockSpec | null> =
    depth === 0 ? fc.constant(null) : fc.option(blockSpecArbitrary(depth - 1), { nil: null });
  return fc.record({
    declarationCount: fc.integer({ min: 0, max: 3 }),
    declarationFormIndex: fc.integer({ min: 0, max: DECLARATION_FORMS.length - 1 }),
    statementCount: fc.integer({ min: 1, max: 3 }),
    declarationsFirst: fc.boolean(),
    wordlessIndex: fc.option(fc.integer({ min: 0, max: WORDLESS_STATEMENT_TEXTS.length - 1 }), {
      nil: null,
    }),
    nested,
  });
}

/** Materialize one block spec into a plan, minting every unique name it needs. */
function planBlock(minter: NameMinter, spec: BlockSpec): BlockPlan {
  const declarations = Array.from({ length: spec.declarationCount }, (_unused, index) =>
    declarationOf(minter, spec.declarationFormIndex + index),
  );
  const statements = Array.from({ length: spec.statementCount }, () => displayStatementOf(minter));
  return {
    declarations,
    statements,
    declarationsFirst: spec.declarationsFirst,
    wordlessBefore: spec.wordlessIndex === null ? null : wordlessStatementOf(spec.wordlessIndex),
    nested: spec.nested === null ? null : planBlock(minter, spec.nested),
  };
}

/** Every block in one plan tree, outermost first. */
function flattenBlocks(block: BlockPlan): readonly BlockPlan[] {
  return block.nested === null ? [block] : [block, ...flattenBlocks(block.nested)];
}

/**
 * Render one block, its declarations either first or displaced by the block's leading statement.
 *
 * When `declarationsFirst` is false the block's FIRST statement is emitted before the
 * declarations, which is precisely the defect shape: measured with `iverilog -g2012`, a block-item
 * declaration is accepted as the first item of its block and rejected after a statement. The
 * optional wordless statement sits immediately before the declarations, so group 15's
 * character-based "is a statement before this declaration" reading is exercised.
 */
function renderBlock(block: BlockPlan, indent: string): readonly string[] {
  const inner = `${indent}  `;
  const declarations = block.declarations.map((declaration) => `${inner}${declaration.text}`);
  const statements = block.statements.map((statement) => `${inner}${statement.text}`);
  const wordless = block.wordlessBefore === null ? [] : [`${inner}${block.wordlessBefore.text}`];
  const nested = block.nested === null ? [] : renderBlock(block.nested, inner);
  const [firstStatement, ...restStatements] = statements;
  const leading = firstStatement === undefined ? [] : [firstStatement];
  const body = block.declarationsFirst
    ? [...declarations, ...wordless, ...statements]
    : [...leading, ...wordless, ...declarations, ...restStatements];
  return [`${indent}begin`, ...body, ...nested, `${indent}end`];
}

/** The `case`/`fork`/`for`-header/`genvar` extras, each in its own top-level construct. */
function renderExtras(options: VerilogShapeOptions, minter: NameMinter): readonly string[] {
  const lines: string[] = [];
  if (options.caseBlock) {
    lines.push(
      '  initial',
      '    case (sel)',
      `      2'b00: $display("${minter.take('S')}");`,
      `      default: $display("${minter.take('S')}");`,
      '    endcase',
    );
  }
  if (options.forkBlock) {
    lines.push('  initial', '    fork', `      $display("${minter.take('S')}");`, '    join');
  }
  if (options.forHeaderDeclaration) {
    const loop = minter.take('k');
    lines.push(
      '  initial begin',
      `    $display("${minter.take('S')}");`,
      `    for (integer ${loop} = 0; ${loop} < 3; ${loop} = ${loop} + 1) acc = acc + ${loop};`,
      '  end',
    );
  }
  if (options.genvarBlock) {
    lines.push(
      '  initial begin',
      `    $display("${minter.take('S')}");`,
      `    genvar ${minter.take('g')};`,
      '  end',
    );
  }
  return lines;
}

/**
 * Splice `plantedLines` in as the LAST items of a rendered block, just before its `end`.
 *
 * The tail position is deliberate: planting BEFORE a block's declarations could turn a block whose
 * declarations were already first into a defect site, so the planted content would be changing
 * what the transform reports and the property would no longer be isolating the plants. Planting at
 * the tail cannot create or destroy a site, which is what lets the planted and unplanted sources
 * be compared finding-for-finding.
 */
function withPlantedTail(
  rendered: readonly string[],
  plantedLines: readonly string[],
  indent: string,
): readonly string[] {
  if (plantedLines.length === 0) {
    return rendered;
  }
  const closing = rendered[rendered.length - 1];
  if (closing === undefined) {
    return rendered;
  }
  return [...rendered.slice(0, -1), ...plantedLines.map((line) => `${indent}  ${line}`), closing];
}

/** Assemble a whole generated source from its block specs, extras, and check names. */
function assemble(input: {
  readonly specs: readonly BlockSpec[];
  readonly options: VerilogShapeOptions;
  readonly checkNames: readonly string[];
  /** Lines spliced into the FIRST block's tail; the non-code plants Property 1 is stated over. */
  readonly plantedLines?: readonly string[];
}): GeneratedVerilog {
  const minter = new NameMinter();
  const blocks = input.specs.map((spec) => planBlock(minter, spec));
  const blockLines = blocks.flatMap((block, index) => [
    '  initial',
    ...(index === 0
      ? withPlantedTail(renderBlock(block, '  '), input.plantedLines ?? [], '  ')
      : renderBlock(block, '  ')),
  ]);
  const text = [
    ...MODULE_PREAMBLE,
    ...blockLines,
    ...renderExtras(input.options, minter),
    // A NAMED block, so the check emissions are never themselves a site and the check-name set
    // is preserved for a reason no rewrite can be credited with.
    '  initial begin : reporting',
    ...input.checkNames.map((name) => `    $display("CHECK ${name} PASS");`),
    '  end',
    'endmodule',
    '',
  ].join('\n');
  return {
    text,
    blocks: blocks.flatMap(flattenBlocks),
    checkNames: input.checkNames,
    moduleScopeNames: MODULE_SCOPE_NAMES,
  };
}

/** A whitespace-free check name, matching the oracle's `CHECK <name> PASS|FAIL` grammar. */
export function checkNameArbitrary(): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.constantFrom('ac1', 'ac2', 'ac3'),
      fc.constantFrom('holds', 'captures_d', 'resets_low', 'counts_up'),
    )
    .map(([prefix, suffix]) => `${prefix}_${suffix}`);
}

/**
 * The shared structured Verilog arbitrary (task 7.3).
 *
 * `specs` is 1..3 blocks so a source stays small enough to shrink usefully while still offering
 * more than one candidate site per case.
 */
export function generatedVerilogArbitrary(): fc.Arbitrary<GeneratedVerilog> {
  return fc
    .record({
      specs: fc.array(blockSpecArbitrary(1), { minLength: 1, maxLength: 3 }),
      options: fc.record({
        forHeaderDeclaration: fc.boolean(),
        caseBlock: fc.boolean(),
        forkBlock: fc.boolean(),
        genvarBlock: fc.boolean(),
      }),
      checkNames: fc.uniqueArray(checkNameArbitrary(), { minLength: 1, maxLength: 3 }),
    })
    .map(assemble);
}

/**
 * The same generator restricted to sources whose declarations are ALWAYS first, carrying none of
 * the extras.
 *
 * Such a source has no defect site at all - measured, a block-item declaration is accepted as the
 * first item of its block whether or not the block is named - so `normalizeDialect` must return it
 * byte-identical. That is Property 27's "a block whose declarations already precede its first
 * statement comes back byte-identical" half, asserted over a whole source, which is the only form
 * in which byte-identity is checkable.
 */
export function alreadyFirstVerilogArbitrary(): fc.Arbitrary<GeneratedVerilog> {
  return fc
    .record({
      specs: fc.array(blockSpecArbitrary(1).map(forceDeclarationsFirst), {
        minLength: 1,
        maxLength: 3,
      }),
      checkNames: fc.uniqueArray(checkNameArbitrary(), { minLength: 1, maxLength: 2 }),
    })
    .map(({ specs, checkNames }) =>
      assemble({
        specs,
        options: {
          forHeaderDeclaration: false,
          caseBlock: false,
          forkBlock: false,
          genvarBlock: false,
        },
        checkNames,
      }),
    );
}

/** One generated source and its twin carrying the planted non-code content. */
export interface PlantedPair {
  /** The source with NO planted content: the control the planted one is compared against. */
  readonly plain: GeneratedVerilog;
  /** The byte-for-byte same source with the three plants spliced into its first block's tail. */
  readonly planted: GeneratedVerilog;
  /** The planted texts, each of which must survive the transform verbatim. */
  readonly plants: readonly string[];
  /** The check name planted inside every plant, which no rewrite may turn into a real check. */
  readonly plantedCheckName: string;
}

/**
 * The Property 1 arbitrary: one source, twice, differing only in planted NON-CODE content.
 *
 * Task 7.2 states the plant list, and the reason: `begin`, `end`, `integer i;`, and a full
 * `CHECK <name> PASS;` all appear inside a line comment, inside a block comment, AND inside a
 * `$display` string in the SAME source, so the property holds even when the input LOOKS exactly
 * like the thing being forbidden. Every one of those is a site-triggering shape in code, and none
 * of them may be one here.
 */
export function plantedNonCodeArbitrary(): fc.Arbitrary<PlantedPair> {
  return fc
    .record({
      specs: fc.array(blockSpecArbitrary(1), { minLength: 1, maxLength: 3 }),
      options: fc.record({
        forHeaderDeclaration: fc.boolean(),
        caseBlock: fc.boolean(),
        forkBlock: fc.boolean(),
        genvarBlock: fc.boolean(),
      }),
      checkNames: fc.uniqueArray(checkNameArbitrary(), { minLength: 1, maxLength: 2 }),
      plantedCheckName: fc.constantFrom('planted_ac1', 'planted_ac2', 'planted_ac3'),
    })
    .map(({ specs, options, checkNames, plantedCheckName }) => {
      const payload = `begin end integer i; CHECK ${plantedCheckName} PASS;`;
      const plants: readonly string[] = [
        `// ${payload}`,
        `/* ${payload} */`,
        `$display("${payload}");`,
      ];
      return {
        plain: assemble({ specs, options, checkNames }),
        planted: assemble({ specs, options, checkNames, plantedLines: plants }),
        plants,
        plantedCheckName,
      };
    });
}

/** Force `declarationsFirst` on a spec and every spec nested inside it. */
function forceDeclarationsFirst(spec: BlockSpec): BlockSpec {
  return {
    ...spec,
    declarationsFirst: true,
    nested: spec.nested === null ? null : forceDeclarationsFirst(spec.nested),
  };
}

/** Wrap one statement in the smallest module that makes it a plausible testbench. */
export function wrapStatement(statement: string): string {
  return [
    'module tbnorm_expr_tb;',
    '  integer acc;',
    '  initial begin : body',
    `    ${statement}`,
    '  end',
    'endmodule',
    '',
  ].join('\n');
}
