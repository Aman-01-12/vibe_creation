// Property 17 for the Generation_Agent: a generated module implements EXACTLY
// the Spec interface (task 13.2; Req 6.1 no missing ports, Req 6.4 no extra ports).
//
// This is the universal complement to the example-based checks co-located at
// `app/agent/roles/generation/interface-check.test.ts`. It states over
// `checkInterfaceExact` (the exactness comparator that reads the interface back
// out of the RTL via `parseModuleInterface`), driven by:
//
//   - a Spec generator producing valid, uniquely-named ports (built through
//     `makePort`) plus a clock/reset contract, and
//   - a FAITHFUL Verilog header renderer that emits the ANSI module header the
//     Generation_Agent instructs the model to produce, plus
//   - mutation operators that each introduce exactly one deviation.
//
// The property asserts the biconditional the requirement demands:
//
//   - EXACT match iff no deviation: a faithfully rendered header (correct module
//     name, exactly the Spec's ports plus the clock/reset ports, each with the
//     right direction and width, and no extra port) round-trips through
//     `parseModuleInterface` and `checkInterfaceExact` reports `matches: true`
//     with empty missing/extra/mismatched sets.
//   - Each single-deviation mutation is REJECTED with the corresponding
//     diagnostic: dropping a port -> `missingPorts` (Req 6.1); adding a port ->
//     `extraPorts` (Req 6.4); changing a width or direction -> `mismatchedPorts`;
//     renaming the module -> `moduleNameMatches: false`.
//
// Parser scope note: `parseModuleInterface` reads the ANSI-style module header
// only (its documented limit), so the renderer emits exactly that header shape
// and every port carries its own explicit direction keyword (no comma
// continuation), which is the faithful shape this agent asks the model for.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  checkInterfaceExact,
  expectedInterfacePorts,
  parseModuleInterface,
  type PortSignature,
} from '@app/agent';
import {
  makePort,
  newUlid,
  type ModuleInterface,
  type Port,
  type PortDirection,
  type Spec,
} from '@app/core';
import { propertyParameters, propertyTag } from '@app/test';

// --- Verilog identifier generation -------------------------------------------
// The parser recognizes a module/port name as `[A-Za-z_]\w*`, and derives a
// port's name from the trailing identifier after stripping direction and
// net-type keywords. So generated names must be well-formed identifiers that are
// NOT one of those keywords, or the derived name would drop the wrong token.

const IDENT_START: readonly string[] =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'.split('');
const IDENT_REST: readonly string[] =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('');

/** Keywords the parser strips from a port entry; a name must never be one of them. */
const RESERVED: ReadonlySet<string> = new Set([
  'input',
  'output',
  'inout',
  'wire',
  'reg',
  'logic',
  'signed',
  'unsigned',
  'bit',
  'module',
  'endmodule',
]);

/** An arbitrary string of length `[min, max]` from an explicit alphabet. */
function fromChars(chars: readonly string[], min: number, max: number): fc.Arbitrary<string> {
  const [first, ...rest] = chars;
  if (first === undefined) {
    throw new Error('fromChars requires a non-empty character set');
  }
  return fc
    .array(fc.constantFrom(first, ...rest), { minLength: min, maxLength: max })
    .map((picked) => picked.join(''));
}

/** A well-formed Verilog identifier that is never a reserved keyword. */
function identifierArbitrary(): fc.Arbitrary<string> {
  return fc
    .tuple(fc.constantFrom(...IDENT_START), fromChars(IDENT_REST, 0, 9))
    .map(([head, tail]) => `${head}${tail}`)
    .map((name) => (RESERVED.has(name) ? `${name}_` : name));
}

const DIRECTIONS: readonly PortDirection[] = ['input', 'output', 'inout'];

function directionArbitrary(): fc.Arbitrary<PortDirection> {
  return fc.constantFrom(...DIRECTIONS);
}

/** A positive bit width, the only width `makePort` accepts (Req 5.3). */
function widthArbitrary(): fc.Arbitrary<number> {
  return fc.integer({ min: 1, max: 64 });
}

// --- Spec generation ---------------------------------------------------------

/** The direction/width of one declared port before it is assigned a unique name. */
interface PortShape {
  readonly direction: PortDirection;
  readonly width: number;
}

/** The raw, pre-naming shape of a Spec's module interface. */
interface SpecShape {
  readonly moduleName: string;
  readonly portShapes: readonly PortShape[];
  readonly hasClock: boolean;
  readonly hasReset: boolean;
  readonly resetActiveLow: boolean;
}

/** Build a `Port` through the validating constructor, or fail the generator loudly. */
function makePortOrThrow(input: {
  readonly name: string;
  readonly direction: PortDirection;
  readonly width: number;
}): Port {
  const result = makePort(input);
  if (!result.ok) {
    throw new Error(`generator produced an invalid port: ${result.error.code}`);
  }
  return result.value;
}

/** Assemble a Spec from a raw shape and a supply of unique names. */
function buildSpec(shape: SpecShape, uniqueNames: readonly string[]): Spec {
  const declaredCount = shape.portShapes.length;
  const declaredNames = uniqueNames.slice(0, declaredCount);
  const ports: Port[] = shape.portShapes.map((portShape, index) =>
    makePortOrThrow({
      name: declaredNames[index] as string,
      direction: portShape.direction,
      width: portShape.width,
    }),
  );
  let next = declaredCount;
  const clockName = shape.hasClock ? (uniqueNames[next++] as string) : null;
  const resetName = shape.hasReset ? (uniqueNames[next++] as string) : null;
  const moduleInterface: ModuleInterface = {
    moduleName: shape.moduleName,
    ports,
    clocking: { clockName, resetName, resetActiveLow: shape.resetActiveLow },
  };
  return {
    id: newUlid(),
    projectId: newUlid(),
    goal: 'A generated single-module design under interface-exactness test.',
    constraints: [],
    moduleInterface,
    acceptanceCriteria: [],
    architecture: 'Header-only fixture for the interface-exactness property.',
    approved: true,
    version: 1,
  };
}

/**
 * A Spec whose declared ports, clock, and reset all carry distinct names.
 *
 * Distinct names are essential: `checkInterfaceExact` indexes ports by name, so
 * the meaningful input space (a real module cannot declare two ports with the
 * same name) requires uniqueness across declared ports plus the clock/reset
 * contract. At least two declared ports are generated so a drop mutation still
 * leaves a parseable header.
 */
function specArbitrary(): fc.Arbitrary<Spec> {
  return fc
    .record<SpecShape>({
      moduleName: identifierArbitrary(),
      portShapes: fc.array(
        fc.record<PortShape>({ direction: directionArbitrary(), width: widthArbitrary() }),
        { minLength: 2, maxLength: 8 },
      ),
      hasClock: fc.boolean(),
      hasReset: fc.boolean(),
      resetActiveLow: fc.boolean(),
    })
    .chain((shape) => {
      const needed = shape.portShapes.length + (shape.hasClock ? 1 : 0) + (shape.hasReset ? 1 : 0);
      return fc
        .uniqueArray(identifierArbitrary(), { minLength: needed, maxLength: needed + 4 })
        .map((names) => buildSpec(shape, names));
    });
}

// --- Faithful renderer -------------------------------------------------------

/** A module header to render: a name and the exact port set it declares. */
interface RenderTarget {
  readonly moduleName: string;
  readonly ports: readonly PortSignature[];
}

/** Render one port as an ANSI header line; a width-1 port carries no range. */
function renderPort(port: PortSignature): string {
  const range = port.width > 1 ? ` [${port.width - 1}:0]` : '';
  return `  ${port.direction} wire${range} ${port.name}`;
}

/**
 * Render a faithful ANSI-style Verilog module header for the given ports.
 *
 * Every port declares its own direction keyword (no comma continuation), which
 * is exactly the shape the Generation_Agent instructs the model to emit and the
 * shape `parseModuleInterface` documents support for.
 */
function renderModuleHeader(target: RenderTarget): string {
  const portLines = target.ports.map(renderPort).join(',\n');
  return [`module ${target.moduleName} (`, portLines, ');', '  // body omitted', 'endmodule'].join(
    '\n',
  );
}

// --- Mutation helpers --------------------------------------------------------

/** Order two port lists by name for order-independent structural comparison. */
function sortByName(ports: readonly PortSignature[]): PortSignature[] {
  return [...ports].sort((left, right) => left.name.localeCompare(right.name));
}

/** A direction guaranteed to differ from `direction`. */
function differentDirection(direction: PortDirection, seed: number): PortDirection {
  const others = DIRECTIONS.filter((candidate) => candidate !== direction);
  return others[seed % others.length] as PortDirection;
}

/** A width guaranteed to differ from `width` and to remain a positive integer. */
function differentWidth(width: number, seed: number): number {
  return seed === width ? seed + 1 : seed;
}

/** An identifier guaranteed to differ from `avoid`, still a valid identifier. */
function differentIdentifier(seed: string, avoid: string): string {
  let name = seed;
  while (name === avoid) {
    name += '_r';
  }
  return name;
}

/** An identifier guaranteed to be absent from `existing`, still valid. */
function freshName(seed: string, existing: ReadonlySet<string>): string {
  let name = seed;
  while (existing.has(name)) {
    name += '_x';
  }
  return name;
}

/** Parse a rendered header, failing the assertion if it does not parse. */
function parseOrFail(rtl: string): { moduleName: string; ports: readonly PortSignature[] } {
  const parsed = parseModuleInterface(rtl);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    throw new Error('rendered header failed to parse');
  }
  return { moduleName: parsed.value.moduleName, ports: parsed.value.ports };
}

// --- The property ------------------------------------------------------------

/** The per-scenario mutation seeds, resolved against port indices in the body. */
interface Scenario {
  readonly spec: Spec;
  readonly dropSeed: number;
  readonly widthTargetSeed: number;
  readonly widthValueSeed: number;
  readonly directionTargetSeed: number;
  readonly directionValueSeed: number;
  readonly extraNameSeed: string;
  readonly extraDirection: PortDirection;
  readonly extraWidth: number;
  readonly renameSeed: string;
}

function scenarioArbitrary(): fc.Arbitrary<Scenario> {
  return specArbitrary().chain((spec) =>
    fc.record<Scenario>({
      spec: fc.constant(spec),
      dropSeed: fc.nat(),
      widthTargetSeed: fc.nat(),
      widthValueSeed: fc.integer({ min: 1, max: 128 }),
      directionTargetSeed: fc.nat(),
      directionValueSeed: fc.nat(),
      extraNameSeed: identifierArbitrary(),
      extraDirection: directionArbitrary(),
      extraWidth: widthArbitrary(),
      renameSeed: identifierArbitrary(),
    }),
  );
}

describe('Generation_Agent interface exactness (Property 17)', () => {
  // Feature: hdl-creation-loop, Property 17: Generated module implements exactly the spec interface
  it('accepts a faithful header and rejects each single-port deviation', () => {
    fc.assert(
      fc.property(scenarioArbitrary(), (scenario) => {
        const { spec } = scenario;
        const moduleName = spec.moduleInterface.moduleName;
        const expected = expectedInterfacePorts(spec.moduleInterface);
        const existingNames = new Set(expected.map((port) => port.name));

        // 1. Faithful render -> round-trip -> EXACT match (Req 6.1, 6.4).
        const faithful = renderModuleHeader({ moduleName, ports: expected });
        const parsed = parseOrFail(faithful);
        expect(parsed.moduleName).toBe(moduleName);
        expect(sortByName(parsed.ports)).toEqual(sortByName(expected));

        const exact = checkInterfaceExact(spec.moduleInterface, parsed);
        expect(exact.matches).toBe(true);
        expect(exact.moduleNameMatches).toBe(true);
        expect(exact.missingPorts).toEqual([]);
        expect(exact.extraPorts).toEqual([]);
        expect(exact.mismatchedPorts).toEqual([]);

        // 2a. Drop one port -> missing (Req 6.1), and nothing else deviates.
        const dropIndex = scenario.dropSeed % expected.length;
        const dropped = expected[dropIndex] as PortSignature;
        const withoutPort = expected.filter((_, index) => index !== dropIndex);
        const missingMatch = checkAgainstSpec(spec, moduleName, withoutPort);
        expect(missingMatch.matches).toBe(false);
        expect(missingMatch.missingPorts.map((port) => port.name)).toEqual([dropped.name]);
        expect(missingMatch.extraPorts).toEqual([]);
        expect(missingMatch.mismatchedPorts).toEqual([]);

        // 2b. Add a port absent from the Spec -> extra (Req 6.4), nothing else.
        const extraName = freshName(scenario.extraNameSeed, existingNames);
        const extraPort: PortSignature = {
          name: extraName,
          direction: scenario.extraDirection,
          width: scenario.extraWidth,
        };
        const extraMatch = checkAgainstSpec(spec, moduleName, [...expected, extraPort]);
        expect(extraMatch.matches).toBe(false);
        expect(extraMatch.extraPorts.map((port) => port.name)).toEqual([extraName]);
        expect(extraMatch.missingPorts).toEqual([]);
        expect(extraMatch.mismatchedPorts).toEqual([]);

        // 2c. Change one port's width -> mismatch, nothing else.
        const widthIndex = scenario.widthTargetSeed % expected.length;
        const widthTarget = expected[widthIndex] as PortSignature;
        const newWidth = differentWidth(widthTarget.width, scenario.widthValueSeed);
        const widthMutated = expected.map((port, index) =>
          index === widthIndex ? { ...port, width: newWidth } : port,
        );
        const widthMatch = checkAgainstSpec(spec, moduleName, widthMutated);
        expect(widthMatch.matches).toBe(false);
        expect(widthMatch.mismatchedPorts).toHaveLength(1);
        expect(widthMatch.mismatchedPorts[0]?.name).toBe(widthTarget.name);
        expect(widthMatch.mismatchedPorts[0]?.actual.width).toBe(newWidth);
        expect(widthMatch.missingPorts).toEqual([]);
        expect(widthMatch.extraPorts).toEqual([]);

        // 2d. Change one port's direction -> mismatch, nothing else.
        const dirIndex = scenario.directionTargetSeed % expected.length;
        const dirTarget = expected[dirIndex] as PortSignature;
        const newDirection = differentDirection(dirTarget.direction, scenario.directionValueSeed);
        const dirMutated = expected.map((port, index) =>
          index === dirIndex ? { ...port, direction: newDirection } : port,
        );
        const dirMatch = checkAgainstSpec(spec, moduleName, dirMutated);
        expect(dirMatch.matches).toBe(false);
        expect(dirMatch.mismatchedPorts).toHaveLength(1);
        expect(dirMatch.mismatchedPorts[0]?.name).toBe(dirTarget.name);
        expect(dirMatch.mismatchedPorts[0]?.actual.direction).toBe(newDirection);
        expect(dirMatch.missingPorts).toEqual([]);
        expect(dirMatch.extraPorts).toEqual([]);

        // 2e. Rename the module -> module-name mismatch, ports otherwise exact.
        const wrongName = differentIdentifier(scenario.renameSeed, moduleName);
        const renameMatch = checkAgainstSpec(spec, wrongName, expected);
        expect(renameMatch.matches).toBe(false);
        expect(renameMatch.moduleNameMatches).toBe(false);
        expect(renameMatch.missingPorts).toEqual([]);
        expect(renameMatch.extraPorts).toEqual([]);
        expect(renameMatch.mismatchedPorts).toEqual([]);
      }),
      propertyParameters(),
    );
  });
});

/**
 * Render a candidate header from `moduleName` + `ports`, parse it back, and check
 * it against the Spec - the full derive-from-RTL path the property states over.
 */
function checkAgainstSpec(
  spec: Spec,
  moduleName: string,
  ports: readonly PortSignature[],
): ReturnType<typeof checkInterfaceExact> {
  const rtl = renderModuleHeader({ moduleName, ports });
  const parsed = parseOrFail(rtl);
  return checkInterfaceExact(spec.moduleInterface, parsed);
}

// Referenced so the exact Property 17 tag is asserted, not merely written in a
// comment above the property.
describe('Property 17 tag', () => {
  it('uses the canonical feature tag', () => {
    expect(propertyTag(17, 'Generated module implements exactly the spec interface')).toBe(
      'Feature: hdl-creation-loop, Property 17: Generated module implements exactly the spec interface',
    );
  });
});
