// Deriving a module's declared interface from Verilog SOURCE, for the corpus
// importer.
//
// WHY PARSE THE REFERENCE RTL RATHER THAN THE DESCRIPTION PROSE
//   RTLLM's `design_description.txt` does list ports and widths, but as English
//   ("result: 65-bit output representing the sum") whose phrasing varies design to
//   design. The reference RTL's module declaration is machine-readable, and the
//   golden testbench is written against exactly that declaration - so the reference
//   is both the more robust source and the authoritative one. A width we read from
//   prose could disagree with what the judge actually connects; a width we read
//   from the declaration cannot.
//
// WHY NOT REUSE THE GENERATION AGENT'S PARSER
//   `@app/agent`'s `parseModuleInterface` reads the ANSI-style header it INSTRUCTS
//   a model to emit, with literal decimal ranges. Third-party reference RTL is not
//   written to our instructions: it uses Verilog-1995 non-ANSI port lists
//   (`module m(a,b); input a; output [5:0] b;`), parameterized ranges
//   (`[DATA_WIDTH-1:0]`), `$clog2`, and multi-name declarations. Widening the
//   agent's parser to cope with third-party dialects would loosen the exactness
//   check it exists to enforce, so the import path gets its own parser and the
//   agent's stays strict.
//
// The source is UNTRUSTED external input: it is size-bounded, never evaluated, and
// every shape the parser does not understand returns a typed reason so the importer
// can quarantine the design instead of importing a guessed interface.

import type { PortDirection } from '@app/core';

import { evaluateIntExpression } from './int-expr.js';

/** Longest reference source the parser will scan; bounds work on untrusted input. */
const MAX_SOURCE_CHARS = 200_000;

/** The direction keywords that open a port declaration. */
const PORT_DIRECTIONS: ReadonlySet<string> = new Set<PortDirection>(['input', 'output', 'inout']);

/** Net/variable-type and sign keywords that carry no port identity. */
const PORT_QUALIFIERS: ReadonlySet<string> = new Set([
  'wire',
  'reg',
  'logic',
  'signed',
  'unsigned',
  'bit',
]);

/** One port as the reference declares it. */
export interface DeclaredPort {
  readonly name: string;
  readonly direction: PortDirection;
  /** Resolved bit width; a positive integer. */
  readonly width: number;
}

/** A module's declared interface: its name and its ports in declaration order. */
export interface DeclaredModule {
  readonly name: string;
  readonly ports: readonly DeclaredPort[];
}

/** A parse outcome: the module, or a short reason it could not be read. */
export type ModuleParseResult =
  | { readonly ok: true; readonly module: DeclaredModule }
  | { readonly ok: false; readonly reason: string };

/** Strip `//` line comments, `/* *\/` block comments, and preprocessor directives. */
export function stripVerilogNoise(source: string): string {
  const withoutBlock = source.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const withoutLine = withoutBlock.replace(/\/\/[^\n]*/g, ' ');
  // Backtick directives (`timescale, `define, `include) are not module syntax and
  // would otherwise appear as stray tokens between declarations.
  return withoutLine.replace(/^[ \t]*`[^\n]*/gm, ' ');
}

/**
 * The names of every module declared in the source, in declaration order.
 *
 * Exposed separately from port parsing because selecting WHICH module is the top,
 * and detecting a rename collision against another declared module, are decisions
 * the importer must make explicitly before any interface is derived.
 */
export function listDeclaredModuleNames(source: string): readonly string[] {
  const names: string[] = [];
  const pattern = /\bmodule\s+([A-Za-z_][A-Za-z0-9_$]*)/g;
  for (const match of stripVerilogNoise(source).matchAll(pattern)) {
    const name = match[1];
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
}

/** A balanced-parenthesis span: its inner text and the index just past its `)`. */
interface ParenSpan {
  readonly inner: string;
  readonly endIndex: number;
}

/** Read the balanced parenthesized group starting at `openIndex`, or `null`. */
function readParenSpan(source: string, openIndex: number): ParenSpan | null {
  if (source[openIndex] !== '(') {
    return null;
  }
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return { inner: source.slice(openIndex + 1, index), endIndex: index + 1 };
      }
    }
  }
  return null;
}

/** The index of the next non-whitespace character at or after `from`. */
function skipSpace(source: string, from: number): number {
  let index = from;
  while (index < source.length && /\s/.test(source[index] ?? '')) {
    index += 1;
  }
  return index;
}

/** The raw pieces of one module declaration, before any port interpretation. */
interface ModuleShape {
  readonly parameterText: string;
  readonly portListText: string;
  readonly bodyText: string;
}

/** Locate a named module and split it into parameter list, port list, and body. */
function locateModule(source: string, moduleName: string): ModuleShape | null {
  const header = new RegExp(`\\bmodule\\s+${escapeIdentifier(moduleName)}\\b`).exec(source);
  if (header === null) {
    return null;
  }
  let cursor = skipSpace(source, header.index + header[0].length);
  let parameterText = '';
  if (source[cursor] === '#') {
    const paramOpen = skipSpace(source, cursor + 1);
    const params = readParenSpan(source, paramOpen);
    if (params === null) {
      return null;
    }
    parameterText = params.inner;
    cursor = skipSpace(source, params.endIndex);
  }
  const ports = readParenSpan(source, cursor);
  if (ports === null) {
    return null;
  }
  const bodyStart = ports.endIndex;
  const bodyEnd = source.indexOf('endmodule', bodyStart);
  return {
    parameterText,
    portListText: ports.inner,
    bodyText: source.slice(bodyStart, bodyEnd === -1 ? source.length : bodyEnd),
  };
}

/** Escape an identifier for safe embedding in a RegExp. */
function escapeIdentifier(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Collect `parameter`/`localparam` values into an evaluation scope.
 *
 * Declarations are resolved in source order against the scope built so far, so a
 * parameter defined in terms of an earlier one resolves. A declaration whose value
 * cannot be evaluated is skipped rather than defaulted; any range that depends on
 * it then fails, which is the honest outcome.
 */
function collectParameters(texts: readonly string[]): Map<string, number> {
  const scope = new Map<string, number>();
  const pattern = /\b(?:parameter|localparam)\b[^;()]*?([A-Za-z_][A-Za-z0-9_$]*)\s*=\s*([^,;)]+)/g;
  for (const text of texts) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      const expression = match[2];
      if (name === undefined || expression === undefined) {
        continue;
      }
      const evaluated = evaluateIntExpression(expression, scope);
      if (evaluated.ok) {
        scope.set(name, evaluated.value);
      }
    }
  }
  return scope;
}

/** Matches a `[msb:lsb]` range, capturing both bound expressions. */
const RANGE_PATTERN = /\[([^:\]]+):([^\]]+)\]/;

/** A resolved width, or the reason the declared range could not be resolved. */
type WidthResult =
  { readonly ok: true; readonly width: number } | { readonly ok: false; readonly reason: string };

/**
 * Resolve the width a declaration text implies: `msb - lsb + 1`, or 1 with no range.
 *
 * Both bounds go through the integer-expression evaluator against the parameter
 * scope, so `[DATA_WIDTH:0]` and `[$clog2(DEPTH)-1:0]` resolve while an
 * unresolvable bound fails loudly.
 */
function resolveWidth(text: string, scope: ReadonlyMap<string, number>): WidthResult {
  const range = RANGE_PATTERN.exec(text);
  if (range === null) {
    return { ok: true, width: 1 };
  }
  const msb = evaluateIntExpression(range[1] ?? '', scope);
  if (!msb.ok) {
    return { ok: false, reason: msb.reason };
  }
  const lsb = evaluateIntExpression(range[2] ?? '', scope);
  if (!lsb.ok) {
    return { ok: false, reason: lsb.reason };
  }
  return { ok: true, width: Math.abs(msb.value - lsb.value) + 1 };
}

/** The identifiers in a declaration text that are neither keywords nor range contents. */
function declaredNames(text: string): readonly string[] {
  return text
    .replace(/\[[^\]]*\]/g, ' ')
    .split(/[^A-Za-z0-9_$]+/)
    .filter((token) => token.length > 0)
    .filter((token) => !PORT_DIRECTIONS.has(token) && !PORT_QUALIFIERS.has(token))
    .filter((token) => !/^\d/.test(token));
}

/** The direction keyword a declaration text opens with, or `null`. */
function declaredDirection(text: string): PortDirection | null {
  const first = /^[\s]*([A-Za-z_]+)/.exec(text)?.[1];
  return first !== undefined && PORT_DIRECTIONS.has(first) ? (first as PortDirection) : null;
}

/** Split a port list on top-level commas (ranges use brackets, parameters use parens). */
function splitTopLevel(text: string): readonly string[] {
  const entries: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(' || char === '[') {
      depth += 1;
    } else if (char === ')' || char === ']') {
      depth -= 1;
    }
    if (char === ',' && depth === 0) {
      entries.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  entries.push(current);
  return entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/** A parsed port set, or the reason the declaration could not be read. */
type PortsResult =
  | { readonly ok: true; readonly ports: readonly DeclaredPort[] }
  | { readonly ok: false; readonly reason: string };

/** The direction/width carried across a bare ANSI continuation entry (`, b`). */
interface CarriedDeclaration {
  readonly direction: PortDirection;
  readonly width: number;
}

/** A resolved ANSI entry declaration, or the reason it could not be resolved. */
type AnsiEntryResult =
  | { readonly ok: true; readonly declaration: CarriedDeclaration }
  | { readonly ok: false; readonly reason: string };

/** The message for a port list whose first entry declares no direction. */
const NO_LEADING_DIRECTION = 'the first port declaration carries no direction keyword';

/**
 * Resolve one ANSI entry's direction and width, inheriting from the carried
 * declaration when the entry is a bare continuation.
 *
 * An explicit range on a continuation still wins, matching Verilog's
 * `input [7:0] a, [3:0] b` form; a continuation with neither a direction nor a range
 * inherits both.
 */
function resolveAnsiEntry(
  entry: string,
  carried: CarriedDeclaration | null,
  scope: ReadonlyMap<string, number>,
): AnsiEntryResult {
  const direction = declaredDirection(entry);
  if (direction === null && !RANGE_PATTERN.test(entry)) {
    return carried === null
      ? { ok: false, reason: NO_LEADING_DIRECTION }
      : { ok: true, declaration: carried };
  }
  const resolvedDirection = direction ?? carried?.direction ?? null;
  if (resolvedDirection === null) {
    return { ok: false, reason: NO_LEADING_DIRECTION };
  }
  const width = resolveWidth(entry, scope);
  if (!width.ok) {
    return { ok: false, reason: width.reason };
  }
  return { ok: true, declaration: { direction: resolvedDirection, width: width.width } };
}

/**
 * Parse an ANSI-style port list: every entry carries its own direction, or inherits
 * the previous entry's direction and width as a bare continuation
 * (`input [7:0] a, b`).
 */
function parseAnsiPortList(portListText: string, scope: ReadonlyMap<string, number>): PortsResult {
  const ports: DeclaredPort[] = [];
  let carried: CarriedDeclaration | null = null;
  for (const entry of splitTopLevel(portListText)) {
    const resolved = resolveAnsiEntry(entry, carried, scope);
    if (!resolved.ok) {
      return resolved;
    }
    carried = resolved.declaration;
    for (const name of declaredNames(entry)) {
      ports.push({ name, direction: carried.direction, width: carried.width });
    }
  }
  return { ok: true, ports };
}

/** Split a module body into `;`-terminated statements. */
function bodyStatements(bodyText: string): readonly string[] {
  return bodyText
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Parse a Verilog-1995 non-ANSI module: the header lists bare port names and the
 * body declares their directions and widths.
 *
 * Only body declarations naming a port from the HEADER list are accepted, so a
 * `task`/`function` argument (which also uses `input`) can never be mistaken for a
 * module port. Ports are returned in header order, which is the order the design's
 * own documentation and testbench present them in.
 */
function parseNonAnsiPorts(shape: ModuleShape, scope: ReadonlyMap<string, number>): PortsResult {
  const headerNames = splitTopLevel(shape.portListText).flatMap(declaredNames);
  if (headerNames.length === 0) {
    return { ok: false, reason: 'the module header declares no ports' };
  }
  const headerSet = new Set(headerNames);
  const byName = new Map<string, DeclaredPort>();
  for (const statement of bodyStatements(shape.bodyText)) {
    const direction = declaredDirection(statement);
    if (direction === null) {
      continue;
    }
    const width = resolveWidth(statement, scope);
    if (!width.ok) {
      return { ok: false, reason: width.reason };
    }
    for (const name of declaredNames(statement)) {
      if (headerSet.has(name) && !byName.has(name)) {
        byName.set(name, { name, direction, width: width.width });
      }
    }
  }
  const ports: DeclaredPort[] = [];
  for (const name of headerNames) {
    const port = byName.get(name);
    if (port === undefined) {
      return {
        ok: false,
        reason: `port "${name}" is listed in the module header but never declared in the body`,
      };
    }
    ports.push(port);
  }
  return { ok: true, ports };
}

/** Whether a port list declares directions inline (ANSI) rather than bare names. */
function isAnsiStyle(portListText: string): boolean {
  return splitTopLevel(portListText).some((entry) => declaredDirection(entry) !== null);
}

/** Reject a port set that would violate the domain's positive-width invariant. */
function firstInvalidPort(ports: readonly DeclaredPort[]): string | null {
  for (const port of ports) {
    if (!Number.isInteger(port.width) || port.width <= 0) {
      return `port "${port.name}" resolved to a non-positive width`;
    }
  }
  return null;
}

/**
 * Parse one named module's declared interface out of Verilog source.
 *
 * Handles both ANSI and Verilog-1995 non-ANSI port styles, with parameterized and
 * `$clog2` ranges resolved against the module's own parameter defaults. Fails
 * closed with a short reason on oversized input, a missing or malformed
 * declaration, an unresolvable range, or a port set with no readable ports - the
 * importer turns any of these into a recorded quarantine rather than a guess.
 */
export function parseDeclaredModule(source: string, moduleName: string): ModuleParseResult {
  if (source.length > MAX_SOURCE_CHARS) {
    return { ok: false, reason: 'reference RTL exceeded the maximum parseable size' };
  }
  const cleaned = stripVerilogNoise(source);
  const shape = locateModule(cleaned, moduleName);
  if (shape === null) {
    return { ok: false, reason: `no parseable declaration of module "${moduleName}" was found` };
  }
  const scope = collectParameters([shape.parameterText, shape.bodyText]);
  const parsed = isAnsiStyle(shape.portListText)
    ? parseAnsiPortList(shape.portListText, scope)
    : parseNonAnsiPorts(shape, scope);
  if (!parsed.ok) {
    return parsed;
  }
  if (parsed.ports.length === 0) {
    return { ok: false, reason: `module "${moduleName}" declared no readable ports` };
  }
  const invalid = firstInvalidPort(parsed.ports);
  if (invalid !== null) {
    return { ok: false, reason: invalid };
  }
  return { ok: true, module: { name: moduleName, ports: parsed.ports } };
}
