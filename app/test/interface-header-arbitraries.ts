// structural-gate-toolchain, task 1.5 (C7): the test-side header renderer Property 12 states
// over, plus the ModuleInterface generator it renders.
//
// WHY A TEST-SIDE RENDERER, AND WHY IT TARGETS `parseDeclaredModule` ALONE
//   `parseDeclaredModule` (`@app/tools/verilog/declared-module.ts`) is the Interface_Check's sole
//   reader of a module's ports (Req 13.7). Property 12 is the parser's own round-trip claim,
//   independent of the importer that happens to have produced 0-of-50 failures against it: render
//   a `ModuleInterface`'s ports in each header shape the parser documents support for, and the
//   parser must read back the same names, directions, and widths. `renderHeader` therefore renders
//   `moduleInterface.ports` only - never the `ClockingContract` or `validityOutputName` - because
//   those are a `ModuleInterface` abstraction `parseDeclaredModule` has no notion of; it reads bare
//   Verilog ports out of a module declaration, nothing else.
//
// THE THREE FORMS
//   `ansi` - every port carries its own direction keyword, the shape `app/agent`'s generation
//     parser also reads.
//   `non-ansi` - a Verilog-1995 header: bare port names up front, directions and widths declared
//     in the body, the shape 12 of the 17 pre-DQ-01 reference-RTL failures were.
//   `parameterized` - one `parameter` per DISTINCT width among the interface's ports, and every
//     port's range written `[NAME-1:0]` against that parameter, the shape 4 of those failures
//     were. Keying the parameter name off the width VALUE itself (`WIDTH_8`, not a per-port name)
//     is what makes "two ports sharing one parameter" fall out of the renderer rather than needing
//     separate tracking: two ports of the same width always reference the one parameter declared
//     for that width.
//
// Pure: no clock, no I/O, no model call. Every generated value comes from fast-check's seed.

import fc from 'fast-check';

import { makePort, type ModuleInterface, type Port, type PortDirection } from '@app/core';

// ---------------------------------------------------------------------------
// `renderHeader`
// ---------------------------------------------------------------------------

/** Every header shape `renderHeader` can produce; `parseDeclaredModule` must read back all three. */
export const HEADER_FORMS = ['ansi', 'non-ansi', 'parameterized'] as const;

export type HeaderForm = (typeof HEADER_FORMS)[number];

/** A `[width-1:0]` range, or no range at all for a width-1 port (the bare-port convention). */
function literalRangeFor(width: number): string {
  return width > 1 ? ` [${width - 1}:0]` : '';
}

/** The parameter name a given width is declared under in the `parameterized` form. */
function parameterNameFor(width: number): string {
  return `WIDTH_${width}`;
}

/** Every port with its own direction keyword, ranges literal; the ANSI header shape. */
function renderAnsiHeader(moduleInterface: ModuleInterface): string {
  const portLines = moduleInterface.ports.map(
    (port) => `  ${port.direction} wire${literalRangeFor(port.width)} ${port.name}`,
  );
  return [`module ${moduleInterface.moduleName} (`, portLines.join(',\n'), ');', 'endmodule'].join(
    '\n',
  );
}

/** Bare port names in the header, directions and widths declared in the body; Verilog-1995. */
function renderNonAnsiHeader(moduleInterface: ModuleInterface): string {
  const headerNames = moduleInterface.ports.map((port) => port.name).join(', ');
  const bodyDeclarations = moduleInterface.ports.map(
    (port) => `  ${port.direction}${literalRangeFor(port.width)} ${port.name};`,
  );
  return [
    `module ${moduleInterface.moduleName}(${headerNames});`,
    ...bodyDeclarations,
    'endmodule',
  ].join('\n');
}

/** One `parameter` per distinct width among the ports, every range written against it. */
function renderParameterizedHeader(moduleInterface: ModuleInterface): string {
  const distinctWidths = [...new Set(moduleInterface.ports.map((port) => port.width))];
  const parameterList = distinctWidths
    .map((width) => `parameter ${parameterNameFor(width)} = ${width}`)
    .join(', ');
  const portLines = moduleInterface.ports.map(
    (port) => `  ${port.direction} wire [${parameterNameFor(port.width)}-1:0] ${port.name}`,
  );
  return [
    `module ${moduleInterface.moduleName} #(${parameterList}) (`,
    portLines.join(',\n'),
    ');',
    'endmodule',
  ].join('\n');
}

/**
 * Render `moduleInterface.ports` as a Verilog module declaration in the given header shape.
 *
 * Only the declared ports are rendered; the `ClockingContract` and `validityOutputName` carried by
 * `ModuleInterface` are a `@app/core` abstraction `parseDeclaredModule` does not read, so a caller
 * that needs a clock or reset port round-tripped folds it into `ports` before calling this.
 */
export function renderHeader(moduleInterface: ModuleInterface, form: HeaderForm): string {
  switch (form) {
    case 'ansi':
      return renderAnsiHeader(moduleInterface);
    case 'non-ansi':
      return renderNonAnsiHeader(moduleInterface);
    case 'parameterized':
      return renderParameterizedHeader(moduleInterface);
    default: {
      // Exhaustiveness: a new HeaderForm must be given a rendering explicitly.
      const unreachable: never = form;
      return unreachable;
    }
  }
}

// ---------------------------------------------------------------------------
// The `ModuleInterface` generator
// ---------------------------------------------------------------------------

const PORT_DIRECTIONS: readonly PortDirection[] = ['input', 'output', 'inout'];

const IDENT_START: readonly string[] =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'.split('');
const IDENT_REST: readonly string[] =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('');

/**
 * Keywords `parseDeclaredModule` treats specially: a direction, a net/variable qualifier, the
 * module delimiters, or a parameter declaration. A generated name equal to one of these would be
 * silently stripped (`PORT_DIRECTIONS`/`PORT_QUALIFIERS` in `declared-module.ts`) or would corrupt
 * the module/parameter syntax this file renders, so every generated identifier avoids the set.
 */
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
  'parameter',
  'localparam',
]);

/** A well-formed Verilog identifier that is never one of the parser's own keywords. */
function identifierArbitrary(): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.constantFrom(...IDENT_START),
      fc.array(fc.constantFrom(...IDENT_REST), { minLength: 0, maxLength: 8 }),
    )
    .map(([head, tail]) => `${head}${tail.join('')}`)
    .map((name) => (RESERVED.has(name) ? `${name}_` : name));
}

/** The direction/width of one port before it is assigned a unique name. */
interface PortShape {
  readonly direction: PortDirection;
  readonly width: number;
}

/** Build a `Port` through the validating constructor, or fail the generator loudly. */
function portOrThrow(name: string, shape: PortShape): Port {
  const result = makePort({ name, direction: shape.direction, width: shape.width });
  if (!result.ok) {
    throw new Error(
      `interface-header-arbitraries generated an invalid port (${result.error.code})`,
    );
  }
  return result.value;
}

/**
 * Assemble a `ModuleInterface` with no clock, no reset, and no Validity_Output: this file's round
 * trip is a claim about `parseDeclaredModule` reading back bare ports, which carries no clocking
 * concept at all.
 */
function buildModuleInterface(
  moduleName: string,
  shapes: readonly PortShape[],
  names: readonly string[],
): ModuleInterface {
  return {
    moduleName,
    ports: shapes.map((shape, index) => portOrThrow(names[index] as string, shape)),
    clocking: { clockName: null, resetName: null, resetActiveLow: false },
    validityOutputName: null,
  };
}

/** One port's direction and width, widths spanning 1 (the bare-port case) to 64. */
function portShapeArbitrary(): fc.Arbitrary<PortShape> {
  return fc.record({
    direction: fc.constantFrom(...PORT_DIRECTIONS),
    width: fc.integer({ min: 1, max: 64 }),
  });
}

/**
 * A `ModuleInterface` with 1 to 6 uniquely-named ports of varied direction and width.
 *
 * Unique names are essential: a real module cannot declare one port name twice, and
 * `parseDeclaredModule` indexes neither by position, so a duplicated name would make the round
 * trip's own comparison ambiguous rather than exercising the parser.
 */
export function arbModuleInterface(): fc.Arbitrary<ModuleInterface> {
  return fc
    .record({
      moduleName: identifierArbitrary(),
      shapes: fc.array(portShapeArbitrary(), { minLength: 1, maxLength: 6 }),
    })
    .chain(({ moduleName, shapes }) =>
      fc
        .uniqueArray(identifierArbitrary(), { minLength: shapes.length, maxLength: shapes.length })
        .map((names) => buildModuleInterface(moduleName, shapes, names)),
    );
}

// ---------------------------------------------------------------------------
// Constructed draws (task 1.5 names these explicitly; a sampled generator can miss them)
// ---------------------------------------------------------------------------

/** Constructed draw: a single width-1 port, the bare-port case every form must still round-trip. */
export function widthOnePortInterface(): ModuleInterface {
  return buildModuleInterface('width_one_mod', [{ direction: 'input', width: 1 }], ['a']);
}

/**
 * Constructed draw: two ports sharing one width, so the `parameterized` form must declare exactly
 * ONE parameter for the pair rather than one each.
 */
export function sharedWidthInterface(): ModuleInterface {
  return buildModuleInterface(
    'shared_width_mod',
    [
      { direction: 'input', width: 8 },
      { direction: 'output', width: 8 },
    ],
    ['a', 'b'],
  );
}

/** Constructed draw: one header carrying every port direction (`input`, `output`, `inout`). */
export function everyDirectionInterface(): ModuleInterface {
  return buildModuleInterface(
    'every_direction_mod',
    [
      { direction: 'input', width: 4 },
      { direction: 'output', width: 4 },
      { direction: 'inout', width: 4 },
    ],
    ['a', 'b', 'c'],
  );
}

/** The three constructed draws, as a list so a caller can fold them into a generated sample. */
export const CONSTRUCTED_DRAWS: readonly ModuleInterface[] = [
  widthOnePortInterface(),
  sharedWidthInterface(),
  everyDirectionInterface(),
];

/**
 * `arbModuleInterface()`, biased so the three constructed draws above are drawn at a real
 * frequency rather than left to chance - a sampled generator can go a whole run without a width-1
 * port or two ports sharing a width, and the property below asserts that it did not.
 */
export function arbModuleInterfaceWithConstructedDraws(): fc.Arbitrary<ModuleInterface> {
  return fc.oneof(
    { weight: 6, arbitrary: arbModuleInterface() },
    { weight: 1, arbitrary: fc.constantFrom(...CONSTRUCTED_DRAWS) },
  );
}
