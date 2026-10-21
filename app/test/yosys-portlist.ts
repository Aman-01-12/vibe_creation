// Pure parser and comparator for Yosys `portlist` text output, backing the test-only
// Interface_Cross_Check (C7, task 8.2; Req 13.2, 13.3).
//
// WHY THIS IS PURE AND SEPARATE FROM THE INTEGRATION TEST
//   `interface-parser-yosys.integration.test.ts` spawns real `yosys` and needs this module to
//   turn its `ports.txt` text into something comparable against `parseDeclaredModule`'s
//   reading. Keeping the parsing and the comparison pure and toolchain-free is what lets the
//   failure message (Req 13.3: name the design and the port) be unit-tested with no Yosys
//   installed, the same reason `declared-module.ts` keeps its own parser pure.
//
// THE EXACT TEXT SHAPE PARSED (measured against Yosys 0.69+post, this session)
//   `yosys -q -p "read_verilog -sv <file>; hierarchy -top <top>; tee -q -o ports.txt portlist <top>"`
//   writes a first line `module <name>`, then one line per port:
//   `<input|output|inout> [<msb>:<lsb>] <name>`, even for a 1-bit port (`[0:0]`). A selection
//   that matches no module (the design's own frontier case, e.g. `float_multi`'s
//   "non-synthesizable event list" refusal) never reaches this script's `tee` stage - Yosys
//   exits non-zero at `read_verilog` first - so that case is a non-zero exit for the
//   integration test to catch, not a shape this parser must read.
//
// WHAT THIS COMPARES, AND WHAT IT DELIBERATELY DOES NOT
//   Requirement 13.2 states the cross-check over "port names and port widths", not direction -
//   the Interface_Check's own exactness (`checkInterfaceExact`) already owns direction, and this
//   test-only cross-check exists to validate the RELOCATED PARSER (DQ-01) against an independent
//   reader, not to restate the production exactness rule. So `compareDeclaredToYosysPortlist`
//   reports a missing port, an extra port, and a width disagreement, and nothing else.

import type { DeclaredModule } from '@app/tools';

/** One port as a Yosys `portlist` line declares it. */
export interface YosysPort {
  readonly name: string;
  readonly msb: number;
  readonly lsb: number;
}

/** One Yosys `portlist` run's output: the selected module's name and its ports in line order. */
export interface YosysPortlist {
  readonly moduleName: string;
  readonly ports: readonly YosysPort[];
}

/** A read `portlist` output, or the reason the text could not be read. */
export type PortlistParseResult =
  | { readonly ok: true; readonly portlist: YosysPortlist }
  | { readonly ok: false; readonly reason: string };

/** Matches the first line Yosys's `portlist` command writes: `module <name>`. */
const MODULE_LINE = /^module\s+(\S+)\s*$/;

/** Matches one port line: `<direction> [<msb>:<lsb>] <name>`. The direction itself is unread. */
const PORT_LINE = /^(?:input|output|inout)\s+\[(\d+):(\d+)\]\s+(\S+)\s*$/;

/**
 * Parse one Yosys `portlist` run's text output.
 *
 * Fails closed, with a reason, on empty text, a missing or malformed `module` header line
 * (which is what a "Selection did not match any module" warning or any other unexpected text
 * produces), or a non-blank line that is not a readable port declaration - never on a guess at
 * what the line might have meant.
 */
export function parsePortlistOutput(text: string): PortlistParseResult {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const [header, ...rest] = lines;
  if (header === undefined) {
    return { ok: false, reason: 'portlist output is empty' };
  }
  const moduleMatch = MODULE_LINE.exec(header);
  if (moduleMatch === null) {
    return { ok: false, reason: `expected a "module <name>" header line, got "${header}"` };
  }
  const moduleName = moduleMatch[1] as string;
  const ports: YosysPort[] = [];
  for (const line of rest) {
    const portMatch = PORT_LINE.exec(line);
    if (portMatch === null) {
      return { ok: false, reason: `unreadable portlist line: "${line}"` };
    }
    const [, msbText, lsbText, name] = portMatch;
    ports.push({ name: name as string, msb: Number(msbText), lsb: Number(lsbText) });
  }
  return { ok: true, portlist: { moduleName, ports } };
}

/** A port's bit width, derived the same way `declared-module.ts` resolves a range. */
function widthOf(port: YosysPort): number {
  return Math.abs(port.msb - port.lsb) + 1;
}

/** One disagreement between the Interface_Parser's reading and Yosys's `portlist` reading. */
export type InterfaceMismatch =
  | { readonly kind: 'missing-port'; readonly name: string }
  | { readonly kind: 'extra-port'; readonly name: string }
  | {
      readonly kind: 'width-mismatch';
      readonly name: string;
      readonly declaredWidth: number;
      readonly yosysWidth: number;
    };

/**
 * Compare `parseDeclaredModule`'s reading of a reference against Yosys's `portlist` reading of
 * the same module (Req 13.2, 13.3): every disagreement in port names or port widths, in no
 * particular order. An empty result is agreement.
 */
export function compareDeclaredToYosysPortlist(
  declared: DeclaredModule,
  yosys: YosysPortlist,
): readonly InterfaceMismatch[] {
  const byName = new Map(yosys.ports.map((port) => [port.name, port]));
  const declaredNames = new Set(declared.ports.map((port) => port.name));
  const mismatches: InterfaceMismatch[] = [];

  for (const port of declared.ports) {
    const match = byName.get(port.name);
    if (match === undefined) {
      mismatches.push({ kind: 'missing-port', name: port.name });
      continue;
    }
    const yosysWidth = widthOf(match);
    if (yosysWidth !== port.width) {
      mismatches.push({
        kind: 'width-mismatch',
        name: port.name,
        declaredWidth: port.width,
        yosysWidth,
      });
    }
  }
  for (const port of yosys.ports) {
    if (!declaredNames.has(port.name)) {
      mismatches.push({ kind: 'extra-port', name: port.name });
    }
  }
  return mismatches;
}

/**
 * Render one mismatch into a short message naming the module and the port (Req 13.3).
 *
 * `moduleName` is threaded in by the caller rather than carried on the mismatch itself, so one
 * design's whole mismatch list can be reported under one heading without repeating the name.
 */
export function describeInterfaceMismatch(moduleName: string, mismatch: InterfaceMismatch): string {
  switch (mismatch.kind) {
    case 'missing-port':
      return `${moduleName}: port "${mismatch.name}" is declared but Yosys reports no such port`;
    case 'extra-port':
      return `${moduleName}: Yosys reports port "${mismatch.name}" which is not declared`;
    case 'width-mismatch':
      return (
        `${moduleName}: port "${mismatch.name}" is declared width ${mismatch.declaredWidth} ` +
        `but Yosys reports width ${mismatch.yosysWidth}`
      );
  }
}
