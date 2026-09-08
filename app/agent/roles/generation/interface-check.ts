// Deriving a module's interface from generated RTL and checking it against the
// Spec Module_Interface exactly (Req 6.1, 6.4).
//
// The exactness guarantee is derived from the RTL itself, not from a structured
// field the model also emits, so the model cannot claim one interface while its
// body declares another. A focused parser reads the ANSI-style module header this
// agent instructs the model to produce; `checkInterfaceExact` then compares the
// parsed ports against the Spec's ports plus its clock/reset contract. Property 17
// (task 13.2) states over `checkInterfaceExact`.
//
// The parser treats RTL as untrusted text: it is bounded, never evaluated, and any
// shape it does not understand yields a typed parse error rather than a throw.

import { err, ok, type ModuleInterface, type PortDirection, type Result } from '@app/core';

import { expectedInterfacePorts } from './spec-view.js';
import type { InterfaceMatch, ParsedInterface, PortMismatch, PortSignature } from './types.js';

/** Longest RTL text the parser will scan, to bound work on untrusted output. */
const MAX_RTL_CHARS = 200_000;

/** Directions a port declaration may carry, as they appear in Verilog source. */
const PORT_DIRECTIONS: ReadonlySet<string> = new Set<PortDirection>(['input', 'output', 'inout']);

/** Net/variable-type and sign keywords that are not part of a port's identity. */
const IGNORED_PORT_KEYWORDS: ReadonlySet<string> = new Set([
  'wire',
  'reg',
  'logic',
  'signed',
  'unsigned',
  'bit',
]);

/** Why parsing an interface out of RTL failed (short, non-sensitive). */
export interface InterfaceParseError {
  readonly reason: string;
}

/** Strip `//` line comments and `/* *\/` block comments so they never confuse the parser. */
function stripComments(source: string): string {
  const withoutBlock = source.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return withoutBlock.replace(/\/\/[^\n]*/g, ' ');
}

/** Compute a port width from a `[msb:lsb]` range; a bare port is width 1. */
function widthFromRange(msb: number, lsb: number): number {
  return Math.abs(msb - lsb) + 1;
}

/**
 * Extract the module name and the raw port-list text from the first module header.
 *
 * Handles an optional `#(...)` parameter list before the port list. Returns `null`
 * when no module header is present.
 */
function locateModuleHeader(source: string): { moduleName: string; portText: string } | null {
  const header = /\bmodule\s+([A-Za-z_]\w*)\s*(?:#\s*\([\s\S]*?\)\s*)?\(([\s\S]*?)\)\s*;/.exec(
    source,
  );
  if (header === null) {
    return null;
  }
  const [, moduleName, portText] = header;
  return { moduleName: moduleName as string, portText: portText as string };
}

/** Split a port list on top-level commas (port ranges use brackets, not parens). */
function splitPortEntries(portText: string): readonly string[] {
  return portText
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Read the direction keyword from a port entry, if it declares one. */
function directionOf(tokens: readonly string[]): PortDirection | null {
  const found = tokens.find((token) => PORT_DIRECTIONS.has(token));
  return found === undefined ? null : (found as PortDirection);
}

/** Whether a port entry declares an explicit `[msb:lsb]` width range. */
function hasWidthRange(entry: string): boolean {
  return /\[\s*\d+\s*:\s*\d+\s*\]/.test(entry);
}

/** Read the declared width from a port entry, defaulting to 1 when no range is present. */
function widthOf(entry: string): number {
  const range = /\[\s*(\d+)\s*:\s*(\d+)\s*\]/.exec(entry);
  if (range === null) {
    return 1;
  }
  return widthFromRange(Number(range[1]), Number(range[2]));
}

/** The trailing identifier of a port entry is its name; keywords and ranges are excluded. */
function nameOf(entry: string): string | null {
  const withoutRange = entry.replace(/\[\s*\d+\s*:\s*\d+\s*\]/g, ' ');
  const identifiers = withoutRange
    .split(/[^A-Za-z0-9_]+/)
    .filter((token) => token.length > 0)
    .filter((token) => !PORT_DIRECTIONS.has(token) && !IGNORED_PORT_KEYWORDS.has(token));
  if (identifiers.length === 0) {
    return null;
  }
  return identifiers[identifiers.length - 1] as string;
}

/** The carried direction/width context, so a bare `, b` continuation reuses the prior declaration. */
interface PortContext {
  direction: PortDirection;
  width: number;
}

/**
 * Parse one port entry into a signature, resolving direction and width against the
 * carried ANSI continuation context.
 *
 * A continuation entry (no direction keyword and no explicit range) inherits the
 * previous declaration's direction and width; otherwise the entry's own direction
 * and range (defaulting to width 1) apply. Pure: the caller owns context updates.
 */
function parsePortEntry(entry: string, context: PortContext | null): PortSignature | null {
  const tokens = entry.split(/[^A-Za-z0-9_]+/).filter((token) => token.length > 0);
  const declaredDirection = directionOf(tokens);
  const direction = declaredDirection ?? context?.direction ?? null;
  if (direction === null) {
    return null;
  }
  const isContinuation = declaredDirection === null && !hasWidthRange(entry);
  const width = isContinuation ? (context?.width ?? widthOf(entry)) : widthOf(entry);
  const name = nameOf(entry);
  if (name === null) {
    return null;
  }
  return { name, direction, width };
}

/** Parse all port entries, threading the ANSI continuation context across commas. */
function parsePorts(portText: string): readonly PortSignature[] {
  const ports: PortSignature[] = [];
  const context: PortContext = { direction: 'input', width: 1 };
  let seenDeclaration = false;
  for (const entry of splitPortEntries(portText)) {
    const carried = seenDeclaration ? context : null;
    const port = parsePortEntry(entry, carried);
    if (port !== null) {
      ports.push(port);
      context.direction = port.direction;
      context.width = port.width;
      seenDeclaration = true;
    }
  }
  return ports;
}

/**
 * Parse the module name and ANSI-style port list out of generated RTL.
 *
 * Fails closed on oversized input, a missing module header, or a header that
 * declares no readable ports, so a malformed candidate is treated as a defect to
 * revise rather than silently accepted.
 */
export function parseModuleInterface(rtl: string): Result<ParsedInterface, InterfaceParseError> {
  if (rtl.length > MAX_RTL_CHARS) {
    return err({ reason: 'generated RTL exceeded the maximum parseable size' });
  }
  const header = locateModuleHeader(stripComments(rtl));
  if (header === null) {
    return err({ reason: 'no module declaration was found in the generated RTL' });
  }
  const ports = parsePorts(header.portText);
  if (ports.length === 0) {
    return err({ reason: 'the generated module declared no readable ports' });
  }
  return ok({ moduleName: header.moduleName, ports });
}

/** Index a port list by name for set difference and per-port comparison. */
function byName(ports: readonly PortSignature[]): ReadonlyMap<string, PortSignature> {
  return new Map(ports.map((port) => [port.name, port]));
}

/** Spec ports with no matching name in the generated module (Req 6.1). */
function findMissing(
  expected: ReadonlyMap<string, PortSignature>,
  actual: ReadonlyMap<string, PortSignature>,
): readonly PortSignature[] {
  return [...expected.values()].filter((port) => !actual.has(port.name));
}

/** Generated ports with no matching name in the Spec (the forbidden extra ports, Req 6.4). */
function findExtra(
  expected: ReadonlyMap<string, PortSignature>,
  actual: ReadonlyMap<string, PortSignature>,
): readonly PortSignature[] {
  return [...actual.values()].filter((port) => !expected.has(port.name));
}

/** Shared ports whose direction or width diverges from the Spec. */
function findMismatched(
  expected: ReadonlyMap<string, PortSignature>,
  actual: ReadonlyMap<string, PortSignature>,
): readonly PortMismatch[] {
  const mismatches: PortMismatch[] = [];
  for (const [name, want] of expected) {
    const got = actual.get(name);
    if (got !== undefined && (got.direction !== want.direction || got.width !== want.width)) {
      mismatches.push({
        name,
        expected: { direction: want.direction, width: want.width },
        actual: { direction: got.direction, width: got.width },
      });
    }
  }
  return mismatches;
}

/**
 * Check a parsed module interface against the Spec Module_Interface exactly
 * (Req 6.1, 6.4).
 *
 * `matches` holds only when the module name agrees, the Spec ports (including the
 * clock/reset contract) are all present, no port outside the Spec is introduced,
 * and every shared port agrees on direction and width. Property 17 states over
 * this function.
 */
export function checkInterfaceExact(
  moduleInterface: ModuleInterface,
  parsed: ParsedInterface,
): InterfaceMatch {
  const expected = byName(expectedInterfacePorts(moduleInterface));
  const actual = byName(parsed.ports);
  const missingPorts = findMissing(expected, actual);
  const extraPorts = findExtra(expected, actual);
  const mismatchedPorts = findMismatched(expected, actual);
  const moduleNameMatches = parsed.moduleName === moduleInterface.moduleName;
  return {
    matches:
      moduleNameMatches &&
      missingPorts.length === 0 &&
      extraPorts.length === 0 &&
      mismatchedPorts.length === 0,
    moduleNameMatches,
    expectedModuleName: moduleInterface.moduleName,
    actualModuleName: parsed.moduleName,
    missingPorts,
    extraPorts,
    mismatchedPorts,
  };
}

/**
 * Render an interface mismatch into a short, non-sensitive diagnostic the repair
 * call can act on. Lists the exact deviations so the next candidate can converge.
 */
export function describeInterfaceMismatch(match: InterfaceMatch): string {
  const lines: string[] = [];
  if (!match.moduleNameMatches) {
    lines.push(
      `Module must be named "${match.expectedModuleName}" but was "${match.actualModuleName}".`,
    );
  }
  for (const port of match.missingPorts) {
    lines.push(`Missing required port "${port.name}" (${port.direction}, width ${port.width}).`);
  }
  for (const port of match.extraPorts) {
    lines.push(`Remove port "${port.name}": it is not declared in the Spec interface.`);
  }
  for (const mismatch of match.mismatchedPorts) {
    lines.push(
      `Port "${mismatch.name}" must be ${mismatch.expected.direction} width ${mismatch.expected.width}, ` +
        `not ${mismatch.actual.direction} width ${mismatch.actual.width}.`,
    );
  }
  return lines.join('\n');
}
