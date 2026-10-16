// instrument-precheck-and-attribution, Property 5: The interface stub declares
// exactly the Spec's interface (task 3.2).
//
// `buildInterfaceStub` (`app/agent/orchestrator/testbench-precheck.ts`) derives
// the Interface_Stub a generated Testbench is precheck-built against SOLELY from
// a Spec's `ModuleInterface`, by reading `expectedInterfacePorts` - the same
// flattening `buildCompileHarness` already uses, so the clocking ports the Spec
// declares separately from its port list are present here too (design.md,
// "app/agent/orchestrator/testbench-precheck.ts"). This test states over that
// derivation, generating arbitrary declared ports (name, direction, width) and
// arbitrary clock/reset presence, and asserts the produced stub:
//
//   - declares the Spec's own module name (Req 1.1);
//   - declares exactly one port for every entry of `expectedInterfacePorts` -
//     same names, same order, nothing added and nothing missing - each with
//     that entry's direction (as its net type: `reg` for `input`, `wire`
//     otherwise) and width (as its declared range) (Req 1.1, 1.2); and
//   - contains no procedural block (`initial` or `always`), so the stub asserts
//     and drives nothing (Req 1.3).
//
// Validates: Requirements 1.1, 1.2, 1.3

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { buildInterfaceStub, expectedInterfacePorts, type PortSignature } from '@app/agent';
import { makePort, type ModuleInterface, type Port, type PortDirection } from '@app/core';
import { propertyParameters } from '@app/test';

const PROPERTY =
  'instrument-precheck-and-attribution, Property 5: The interface stub declares exactly the Spec\u2019s interface';

// --- Verilog identifier generation -------------------------------------------
// Mirrors the identifier conventions already established in
// `interface-exact.property.test.ts`: a well-formed identifier that is never a
// keyword the stub's own rendering (or a real toolchain) would misparse.

const IDENT_START: readonly string[] =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'.split('');
const IDENT_REST: readonly string[] =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('');

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
  'initial',
  'always',
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

/** A positive bit width, the only width `makePort` accepts (Req 5.3, core). */
function widthArbitrary(): fc.Arbitrary<number> {
  return fc.integer({ min: 1, max: 64 });
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

/** The raw, pre-naming shape of a Spec's module interface. */
interface ModuleInterfaceShape {
  readonly moduleName: string;
  readonly directions: readonly PortDirection[];
  readonly widths: readonly number[];
  readonly hasClock: boolean;
  readonly hasReset: boolean;
  readonly resetActiveLow: boolean;
}

/** Assemble a `ModuleInterface` from a raw shape and a supply of unique names. */
function buildModuleInterface(
  shape: ModuleInterfaceShape,
  uniqueNames: readonly string[],
): ModuleInterface {
  const declaredCount = shape.directions.length;
  const declaredNames = uniqueNames.slice(0, declaredCount);
  const ports: Port[] = shape.directions.map((direction, index) =>
    makePortOrThrow({
      name: declaredNames[index] as string,
      direction,
      width: shape.widths[index] as number,
    }),
  );
  let next = declaredCount;
  const clockName = shape.hasClock ? (uniqueNames[next++] as string) : null;
  const resetName = shape.hasReset ? (uniqueNames[next++] as string) : null;
  return {
    validityOutputName: null,
    moduleName: shape.moduleName,
    ports,
    clocking: { clockName, resetName, resetActiveLow: shape.resetActiveLow },
  };
}

/**
 * A `ModuleInterface` whose declared ports, clock, and reset all carry distinct
 * names (the meaningful input space: a real module cannot declare the same name
 * twice), spanning zero-clock/zero-reset combinational interfaces through
 * clocked-and-reset ones, and zero to several declared ports of every direction
 * and a range of widths (including width 1, which the renderer must NOT suffix
 * with a bit range).
 */
function moduleInterfaceArbitrary(): fc.Arbitrary<ModuleInterface> {
  return fc
    .record<ModuleInterfaceShape>({
      moduleName: identifierArbitrary(),
      directions: fc.array(directionArbitrary(), { minLength: 0, maxLength: 8 }),
      widths: fc.array(widthArbitrary(), { minLength: 0, maxLength: 8 }),
      hasClock: fc.boolean(),
      hasReset: fc.boolean(),
      resetActiveLow: fc.boolean(),
    })
    .map((shape) => ({
      ...shape,
      // Pair each direction with a width by index; trim to the shorter length so
      // every declared port has both (fc.array lengths are independent).
      widths: shape.widths.slice(0, shape.directions.length),
      directions: shape.directions.slice(0, shape.widths.length),
    }))
    .chain((shape) => {
      const needed = shape.directions.length + (shape.hasClock ? 1 : 0) + (shape.hasReset ? 1 : 0);
      return fc
        .uniqueArray(identifierArbitrary(), { minLength: needed, maxLength: needed + 4 })
        .map((names) => buildModuleInterface(shape, names));
    });
}

// --- Stub-shape assertions ----------------------------------------------------

/** The stub's `module <name> (...)` header line, or fails the assertion if absent. */
function moduleHeaderLine(contents: string): string {
  const line = contents.split('\n').find((candidate) => candidate.startsWith('module '));
  expect(line).toBeDefined();
  return line as string;
}

/** The declared signal's expected net type: `reg` for an `input`, `wire` otherwise. */
function expectedNetType(direction: PortDirection): 'reg' | 'wire' {
  return direction === 'input' ? 'reg' : 'wire';
}

/** The expected declaration line for one port, matching `buildInterfaceStub`'s own rendering. */
function expectedDeclarationLine(port: PortSignature): string {
  const range = port.width > 1 ? ` [${port.width - 1}:0]` : '';
  return `  ${expectedNetType(port.direction)}${range} ${port.name};`;
}

describe(PROPERTY, () => {
  it('declares the Spec module name, exactly the expected ports, and no procedural block', () => {
    fc.assert(
      fc.property(moduleInterfaceArbitrary(), (moduleInterface) => {
        const expected = expectedInterfacePorts(moduleInterface);
        const stub = buildInterfaceStub(moduleInterface);

        // Req 1.1 (module name): the header names the Spec's own module.
        const header = moduleHeaderLine(stub.contents);
        expect(header.startsWith(`module ${moduleInterface.moduleName} (`)).toBe(true);

        // Req 1.1, 1.2 (port list, order, and count): the header's port list is
        // exactly `expectedInterfacePorts`, in the same order - nothing added,
        // nothing missing, regardless of how many declared or clocking ports
        // this case generated (including zero).
        const headerPortList = header
          .slice(header.indexOf('(') + 1, header.lastIndexOf(')'))
          .split(',')
          .map((token) => token.trim())
          .filter((token) => token.length > 0);
        expect(headerPortList).toEqual(expected.map((port) => port.name));

        // Req 1.1, 1.2 (direction and width): every expected port has its own
        // declaration line, with the net type and range that port's direction
        // and width require - not merely a name match.
        for (const port of expected) {
          expect(stub.contents).toContain(expectedDeclarationLine(port));
        }

        // The stub declares nothing beyond the expected ports: exactly one
        // declaration line per expected port, and no other declaration line.
        const declarationLines = stub.contents
          .split('\n')
          .filter((line) => /^\s+(reg|wire)\b/.test(line));
        expect(declarationLines).toHaveLength(expected.length);

        // Req 1.3 (no behaviour): the stub asserts and drives nothing, so it
        // must contain no procedural block of either kind.
        expect(stub.contents).not.toMatch(/\binitial\b/);
        expect(stub.contents).not.toMatch(/\balways\b/);
      }),
      propertyParameters(),
    );
  });
});
