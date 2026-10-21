// structural-gate-toolchain, Property 12: every Header_Rendering of an interface reads back
// identically (task 1.5, C7).
//
// WHAT IS CLAIMED
//   For any generated `ModuleInterface` and for each of the `ansi`, `non-ansi`, and
//   `parameterized` forms `renderHeader` can produce (`./interface-header-arbitraries.js`),
//   `parseDeclaredModule` reads the rendered text back to the SAME set of port names, with each
//   port's direction and width equal to the generated ones (Req 13.1). The three constructed
//   draws task 1.5 names - a width-1 port, two ports sharing one parameter, and one header
//   carrying every direction - are exhausted directly in their own test rather than left to
//   fast-check sampling, because a closed, frozen list can be exhausted outright instead of
//   drawn at a frequency a shrunk or re-weighted generator could still miss.
//
// WHY NAME-KEYED COMPARISON, NOT POSITIONAL
//   The `non-ansi` form's header lists bare names; `parseDeclaredModule` itself returns ports in
//   HEADER order for that shape, which this file's renderer also emits in generation order, so
//   position happens to agree too. The comparison is keyed by name regardless, because that is
//   the one invariant all three forms share and is what Property 9 (task 5.5) reuses this very
//   renderer to state the Interface_Check against.
//
// The tag is a literal, following every other property test in this repo's roughly thirty
// specs: `propertyTag()` in `@app/test` hardcodes a different spec's feature slug
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// **Validates: Requirements 13.1**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ModuleInterface, Port } from '@app/core';
import { parseDeclaredModule, type DeclaredPort } from '@app/tools';

import {
  arbModuleInterface,
  CONSTRUCTED_DRAWS,
  HEADER_FORMS,
  renderHeader,
  type HeaderForm,
} from './interface-header-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'structural-gate-toolchain, Property 12: Every Header_Rendering reads back identically';

/** Order a port list by name, so set comparison does not depend on declaration order. */
function sortByName<T extends { readonly name: string }>(ports: readonly T[]): T[] {
  return [...ports].sort((left, right) => left.name.localeCompare(right.name));
}

/** The direction/width signature `parseDeclaredModule` must read back for one port. */
function signatureOf(port: { readonly direction: string; readonly width: number }): string {
  return `${port.direction}:${port.width}`;
}

/**
 * Assert that `parseDeclaredModule` reads `rendered` back to exactly `expected`'s ports: the same
 * names, and for each name the same direction and width.
 */
function assertRoundTrips(
  rendered: string,
  moduleName: string,
  expected: readonly Port[],
  context: string,
): void {
  const parsed = parseDeclaredModule(rendered, moduleName);
  expect(parsed.ok, `${context}: ${parsed.ok ? '' : parsed.reason}\n${rendered}`).toBe(true);
  if (!parsed.ok) {
    return;
  }

  const actualPorts: readonly DeclaredPort[] = parsed.module.ports;
  expect(
    sortByName(actualPorts).map((port) => port.name),
    context,
  ).toEqual(sortByName(expected).map((port) => port.name));

  const expectedByName = new Map(expected.map((port) => [port.name, port]));
  for (const actual of actualPorts) {
    const want = expectedByName.get(actual.name);
    expect(want, `${context}: ${actual.name} unexpectedly present`).toBeDefined();
    if (want !== undefined) {
      expect(signatureOf(actual), `${context}: port "${actual.name}"`).toBe(signatureOf(want));
    }
  }
}

describe(PROPERTY, () => {
  it('round-trips every header form for a generated interface', () => {
    const seenForms = new Set<HeaderForm>();

    fc.assert(
      fc.property(
        arbModuleInterface(),
        fc.constantFrom(...HEADER_FORMS),
        (moduleInterface, form) => {
          seenForms.add(form);
          const rendered = renderHeader(moduleInterface, form);
          assertRoundTrips(
            rendered,
            moduleInterface.moduleName,
            moduleInterface.ports,
            `form "${form}"`,
          );
        },
      ),
      propertyParameters(),
    );

    for (const form of HEADER_FORMS) {
      expect(seenForms.has(form), `no draw exercised the "${form}" form`).toBe(true);
    }
  });

  // The three constructed draws (task 1.5) are a CLOSED, frozen list, so they are exhausted
  // directly rather than left to fast-check sampling - a weighted draw over an open generator
  // can go a whole run without hitting one (chipAgent gotcha-a-closed-union-non-vacuity...).
  it('round-trips every constructed draw, in every header form', () => {
    for (const moduleInterface of CONSTRUCTED_DRAWS) {
      for (const form of HEADER_FORMS) {
        const rendered = renderHeader(moduleInterface, form);
        assertRoundTrips(
          rendered,
          moduleInterface.moduleName,
          moduleInterface.ports,
          `${moduleInterface.moduleName}, form "${form}"`,
        );
      }
    }
  });

  it('renders a width-1 port with no bit range, in every form (the bare-port convention)', () => {
    const widthOne: ModuleInterface = {
      moduleName: 'width_one_mod',
      ports: [{ name: 'a', direction: 'input', width: 1 }],
      clocking: { clockName: null, resetName: null, resetActiveLow: false },
      validityOutputName: null,
    };

    for (const form of HEADER_FORMS) {
      const rendered = renderHeader(widthOne, form);
      expect(rendered, `form "${form}" named a width for a width-1 port`).not.toMatch(/\[0:0\]/);
      assertRoundTrips(rendered, widthOne.moduleName, widthOne.ports, `form "${form}"`);
    }
  });

  it('declares exactly one parameter for two ports sharing a width', () => {
    const shared: ModuleInterface = {
      moduleName: 'shared_width_mod',
      ports: [
        { name: 'a', direction: 'input', width: 8 },
        { name: 'b', direction: 'output', width: 8 },
      ],
      clocking: { clockName: null, resetName: null, resetActiveLow: false },
      validityOutputName: null,
    };

    const rendered = renderHeader(shared, 'parameterized');
    const parameterDeclarations = rendered.match(/\bparameter\s+\S+\s*=/g) ?? [];
    expect(parameterDeclarations).toHaveLength(1);
    assertRoundTrips(rendered, shared.moduleName, shared.ports, 'shared-width parameterized form');
  });

  it('round-trips a header carrying every port direction', () => {
    const everyDirection: ModuleInterface = {
      moduleName: 'every_direction_mod',
      ports: [
        { name: 'a', direction: 'input', width: 4 },
        { name: 'b', direction: 'output', width: 4 },
        { name: 'c', direction: 'inout', width: 4 },
      ],
      clocking: { clockName: null, resetName: null, resetActiveLow: false },
      validityOutputName: null,
    };

    for (const form of HEADER_FORMS) {
      const rendered = renderHeader(everyDirection, form);
      assertRoundTrips(rendered, everyDirection.moduleName, everyDirection.ports, `form "${form}"`);
    }
  });
});
