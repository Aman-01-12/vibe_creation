// structural-gate-toolchain, Property 9: The Interface_Check is header-style independent and
// width-exact (task 5.5; Req 8.3, 10.1).
//
// WHAT IS CLAIMED
//   For any Declared_Interface, `interfaceCheckPassed` passes against a module rendered from it
//   in any of the three `renderHeader` forms (`./interface-header-arbitraries.js`, task 1.5) -
//   `ansi`, `non-ansi`, and `parameterized` - and fails the moment one port's width, direction, or
//   name is changed from what was rendered. The first half is DQ-01's whole point: the relocated
//   `parseDeclaredModule` reads all three header styles, so the gate's admission does not depend
//   on which dialect the Candidate_Design happens to use. The second half is what keeps that from
//   being vacuous - a check that read every header style but compared nothing would also "pass"
//   every form.
//
// WHY THESE TWO CONSTRUCTED DRAWS BY NAME
//   `everyDirectionInterface()` and `sharedWidthInterface()` (both from task 1.5) stand in for the
//   16 measured pre-DQ-01 failures design.md's decision table records: 12 non-ANSI headers and 4
//   parameterized (`WIDTH-1:0`) widths. The exact 16 reference designs are not reproduced here -
//   design.md records only the two failure categories, not which RTLLM problems they were - so
//   these two constructed interfaces are representative fixtures of those shapes, pinned as
//   explicit examples rather than left to chance in the sampled property below.
//
// `renderHeader` already emits a complete `module ... endmodule` text (see its own header
// comment), so no wrapping is needed before handing it to `interfaceCheckPassed` as a `SourceFile`.
//
// **Validates: Requirements 8.3, 10.1**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { interfaceCheckPassed } from '@app/agent';
import type { ModuleInterface, Port, PortDirection } from '@app/core';
import type { SourceFile } from '@app/tools';

import {
  arbModuleInterfaceWithConstructedDraws,
  CONSTRUCTED_DRAWS,
  everyDirectionInterface,
  HEADER_FORMS,
  renderHeader,
  sharedWidthInterface,
  type HeaderForm,
} from './interface-header-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'structural-gate-toolchain, Property 9: The Interface_Check is header-style independent and width-exact';

/** Every direction a port can carry, for picking "some other direction" during mutation. */
const DIRECTIONS: readonly PortDirection[] = ['input', 'output', 'inout'];

/** Render one `ModuleInterface` in one header form as the single-file RTL `interfaceCheckPassed` reads. */
function rtlFor(moduleInterface: ModuleInterface, form: HeaderForm): readonly SourceFile[] {
  return [{ path: 'top.v', contents: renderHeader(moduleInterface, form) }];
}

/** A direction different from the one given; always resolves since `DIRECTIONS` has three members. */
function anotherDirection(direction: PortDirection): PortDirection {
  return DIRECTIONS.find((candidate) => candidate !== direction) as PortDirection;
}

/**
 * Apply a mutation to the interface's first port only, leaving every other port untouched.
 *
 * `arbModuleInterface` draws at least one port (task 1.5), so `ports[0]` is always present; the
 * cast documents that invariant instead of threading an `undefined` check through every caller.
 */
function withFirstPortMutated(
  moduleInterface: ModuleInterface,
  mutate: (first: Port) => Port,
): ModuleInterface {
  const [first, ...rest] = moduleInterface.ports as readonly [Port, ...Port[]];
  return { ...moduleInterface, ports: [mutate(first), ...rest] };
}

/** Widen the first port's width by one bit, leaving every other port untouched. */
function withFirstPortWidthOffByOne(moduleInterface: ModuleInterface): ModuleInterface {
  return withFirstPortMutated(moduleInterface, (first) => ({ ...first, width: first.width + 1 }));
}

/** Flip the first port's direction to one it did not have, leaving every other port untouched. */
function withFirstPortDirectionFlipped(moduleInterface: ModuleInterface): ModuleInterface {
  return withFirstPortMutated(moduleInterface, (first) => ({
    ...first,
    direction: anotherDirection(first.direction),
  }));
}

/** Rename the first port to a name the rendering never used, leaving every other port untouched. */
function withFirstPortRenamed(moduleInterface: ModuleInterface): ModuleInterface {
  return withFirstPortMutated(moduleInterface, (first) => ({
    ...first,
    name: `__renamed__${first.name}`,
  }));
}

/** The three single-port mutations Property 9 states must each break the check. */
const MUTATIONS: ReadonlyMap<string, (moduleInterface: ModuleInterface) => ModuleInterface> =
  new Map([
    ['width', withFirstPortWidthOffByOne],
    ['direction', withFirstPortDirectionFlipped],
    ['name', withFirstPortRenamed],
  ]);

describe(PROPERTY, () => {
  it('passes for every header form of a generated interface, hitting every constructed draw', () => {
    const seenForms = new Set<HeaderForm>();
    const seenDraws = new Set<ModuleInterface>();

    fc.assert(
      fc.property(
        arbModuleInterfaceWithConstructedDraws(),
        fc.constantFrom(...HEADER_FORMS),
        (moduleInterface, form) => {
          seenForms.add(form);
          if (CONSTRUCTED_DRAWS.includes(moduleInterface)) {
            seenDraws.add(moduleInterface);
          }

          expect(
            interfaceCheckPassed(moduleInterface, rtlFor(moduleInterface, form)),
            `form "${form}"`,
          ).toBe(true);
        },
      ),
      propertyParameters(),
    );

    for (const form of HEADER_FORMS) {
      expect(seenForms.has(form), `no draw exercised the "${form}" form`).toBe(true);
    }
    for (const draw of CONSTRUCTED_DRAWS) {
      expect(seenDraws.has(draw), `constructed draw "${draw.moduleName}" was never sampled`).toBe(
        true,
      );
    }
  });

  it('fails once one port is given a different width, direction, or name than what was rendered', () => {
    fc.assert(
      fc.property(
        arbModuleInterfaceWithConstructedDraws(),
        fc.constantFrom(...HEADER_FORMS),
        fc.constantFrom(...MUTATIONS.keys()),
        (moduleInterface, form, mutationName) => {
          const rtl = rtlFor(moduleInterface, form);
          const mutate = MUTATIONS.get(mutationName) as (
            moduleInterface: ModuleInterface,
          ) => ModuleInterface;

          expect(
            interfaceCheckPassed(mutate(moduleInterface), rtl),
            `form "${form}", mutation "${mutationName}"`,
          ).toBe(false);
        },
      ),
      propertyParameters(),
    );
  });

  it('passes a non-ANSI header for a multi-port, every-direction interface (the 12-of-16 measured shape)', () => {
    const moduleInterface = everyDirectionInterface();

    expect(interfaceCheckPassed(moduleInterface, rtlFor(moduleInterface, 'non-ansi'))).toBe(true);
  });

  it('passes a WIDTH-1:0 parameterized header for a shared-width interface (the 4-of-16 measured shape)', () => {
    const moduleInterface = sharedWidthInterface();
    const rtl = rtlFor(moduleInterface, 'parameterized');

    expect(rtl[0]?.contents).toMatch(/-1:0\]/);
    expect(interfaceCheckPassed(moduleInterface, rtl)).toBe(true);
  });

  it('fails a shared-width interface against a parameterized header one bit too wide (width-exactness)', () => {
    const moduleInterface = sharedWidthInterface();
    const rtl = rtlFor(moduleInterface, 'parameterized');

    expect(interfaceCheckPassed(withFirstPortWidthOffByOne(moduleInterface), rtl)).toBe(false);
  });

  it('fails an every-direction interface against a non-ANSI header with one direction flipped', () => {
    const moduleInterface = everyDirectionInterface();
    const rtl = rtlFor(moduleInterface, 'non-ansi');

    expect(interfaceCheckPassed(withFirstPortDirectionFlipped(moduleInterface), rtl)).toBe(false);
  });
});
