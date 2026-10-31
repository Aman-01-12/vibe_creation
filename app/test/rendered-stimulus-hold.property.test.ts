// stimulus-transaction-structure, Property 8: Two Held_Inputs are driven from disjoint bits of
// the window's mixed value (task 4.7, C3).
//
// THE ORACLE IS TEXTUAL, NOT A SIMULATOR RUN
//   `renderStimulusFunction` (consensus-harness.ts) has exactly one place a `hold`-role port's
//   value is forced: the overwrite line `v[hi:lo] = v_hold[hi:lo];`, rendered at that port's OWN
//   `packedPortSlices` slice. `packedPortSlices` lays every port out sequentially with no overlap,
//   so two Held_Inputs reading disjoint bits of `v_hold` falls out of that layout rather than
//   being computed by the hold branch itself - but the task calls for proving it, not assuming it,
//   because a renderer that read the WRONG port's slice (a copy/paste of the first held port's
//   `high`/`low` into a later one, say) would still emit a syntactically well-formed line of the
//   right WIDTH whenever the two held ports happen to share one, which is exactly the shape
//   `fc.subarray`'s width-independent draw would otherwise leave to chance. This file checks each
//   held port's line against ITS OWN slice and checks every pair of held slices for disjointness
//   directly, never inferring either from width alone.
//
// NON-VACUITY
//   The sampled population draws its Role_Declaration from only the generated interface's INPUT
//   ports, marking at least two of them `hold` and the rest `data`, so every run exercises at
//   least one disjoint pair by construction rather than leaving it to a uniform draw that could
//   land on fewer than two. A draw with fewer than two input ports is discarded via the
//   `roles: []` sentinel and `fc.pre`, the same shape `rendered-stimulus-strobe.property.test.ts`
//   uses for its own zero-eligible-port case. Two further shapes are CONSTRUCTED and EXHAUSTED as
//   their own `it` blocks rather than left to sampling, per the design's own `Property test
//   configuration` section and
//   chipAgent/_inbox/gotcha-a-closed-union-non-vacuity-row-should-be-exhausted-not-sampled.md:
//   an input bundle wider than 64 bits with a Held_Input, so the held bundle's lane loop must be
//   seen emitting more than one `ece_mix` lane assignment; and two Held_Input ports of EQUAL
//   width, the only draw where a copy/paste of one port's slice into the other is invisible to a
//   width check and must be caught by bit position instead.
//
// Validates: Requirements 4.5

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  makeTimingContract,
  type ClockingContract,
  type ModuleInterface,
  type Port,
} from '@app/core';
import {
  packedPortSlices,
  renderConsensusHarness,
  SAMPLE_BUDGET,
  type ConsensusHarnessRequest,
  type RoleDeclaration,
} from '@app/tools';
// HOLD_FRAME_PERIOD is read from its own defining module (`consensus-harness.ts`) rather than
// through the `@app/tools` barrel, the same convention
// `rendered-stimulus-strobe.property.test.ts` already follows for STROBE_PERIOD.
import { HOLD_FRAME_PERIOD } from '../tools/simulator/consensus-harness.js';

import { arbModuleInterface } from './interface-header-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'stimulus-transaction-structure, Property 8: Two Held_Inputs are driven from disjoint bits of the window\u2019s mixed value';

const COMBINATIONAL: ClockingContract = { clockName: null, resetName: null, resetActiveLow: false };

function moduleInterfaceWith(moduleName: string, ports: readonly Port[]): ModuleInterface {
  return { moduleName, ports, clocking: COMBINATIONAL, validityOutputName: null };
}

/** The exact text `renderStimulusFunction` emits for one `hold`-role port's own slice. */
function heldOverwriteLine(high: number, low: number): string {
  return heldOverwriteLineAt(high, low, high, low);
}

/** The same line shape, but with the `v` and `v_hold` slices named independently - used to spell
 * out the exact cross-port defect (a held port rendered against ANOTHER held port's slice) a
 * width-only check cannot distinguish when the two ports share a width. */
function heldOverwriteLineAt(
  vHigh: number,
  vLow: number,
  holdHigh: number,
  holdLow: number,
): string {
  return `    v[${String(vHigh)}:${String(vLow)}] = v_hold[${String(holdHigh)}:${String(holdLow)}];`;
}

/** The exact text of one lane's held-bundle assignment, keyed on the no-Strobe period here. */
function heldLaneLine(lane: number, high: number, low: number): string {
  return `    v_hold[${String(high)}:${String(low)}] = ece_mix(32'd${String(lane)}, step / ${String(HOLD_FRAME_PERIOD)});`;
}

/** A total Role_Declaration over `moduleInterface`'s own input ports, naming `holdNames`. */
function rolesFor(
  moduleInterface: ModuleInterface,
  holdNames: ReadonlySet<string>,
): RoleDeclaration {
  return moduleInterface.ports
    .filter((port) => port.direction === 'input')
    .map((port) => ({
      portName: port.name,
      role: holdNames.has(port.name) ? ('hold' as const) : ('data' as const),
    }));
}

function requestFor(
  moduleInterface: ModuleInterface,
  roles: RoleDeclaration,
): ConsensusHarnessRequest {
  const timingEntries = moduleInterface.ports
    .filter((port) => port.direction === 'output')
    .map((port) => ({ portName: port.name, timing: 'combinational' as const }));
  const timingContract = makeTimingContract(moduleInterface, timingEntries);
  if (!timingContract.ok) {
    throw new Error(`fixture defect building the Timing_Contract: ${timingContract.error.code}`);
  }
  return {
    moduleInterface,
    timingContract: timingContract.value,
    nonce: 'holdprop',
    watchdogBudgetNs: 2_000_000,
    sampleBudget: SAMPLE_BUDGET,
    roles,
  };
}

/** Every pair of `slices` occupies disjoint bit ranges - neither contains the other's `low`. */
function assertPairwiseDisjoint(
  slices: readonly { readonly name: string; readonly high: number; readonly low: number }[],
): void {
  for (let i = 0; i < slices.length; i += 1) {
    for (let j = i + 1; j < slices.length; j += 1) {
      const a = slices[i]!;
      const b = slices[j]!;
      const disjoint = a.high < b.low || b.high < a.low;
      expect(
        disjoint,
        `${a.name} [${String(a.high)}:${String(a.low)}] overlaps ${b.name} [${String(b.high)}:${String(b.low)}]`,
      ).toBe(true);
    }
  }
}

// ---------------------------------------------------------------------------
// The sampled population
// ---------------------------------------------------------------------------

/** One generated interface, paired with a total Role_Declaration marking at least two of its
 * input ports `hold` and the rest `data`. Carries an empty `roles` when the draw has fewer than
 * two input ports at all, discarded by the property's own `fc.pre`. */
function scenarioArbitrary(): fc.Arbitrary<{
  readonly moduleInterface: ModuleInterface;
  readonly roles: RoleDeclaration;
}> {
  return arbModuleInterface().chain((moduleInterface) => {
    const inputNames = moduleInterface.ports
      .filter((port) => port.direction === 'input')
      .map((port) => port.name);
    if (inputNames.length < 2) {
      return fc.constant({ moduleInterface, roles: [] });
    }
    return fc.subarray(inputNames, { minLength: 2 }).map((holdNames) => ({
      moduleInterface,
      roles: rolesFor(moduleInterface, new Set(holdNames)),
    }));
  });
}

describe(PROPERTY, () => {
  it(
    "renders every Held_Input port's overwrite line at its own slice of v_hold, and no two " +
      "Held_Input ports' slices overlap",
    () => {
      let pairsChecked = 0;

      fc.assert(
        fc.property(scenarioArbitrary(), (scenario) => {
          const { moduleInterface, roles } = scenario;
          // A draw with fewer than two input ports cannot carry a non-empty Role_Declaration here.
          fc.pre(roles.length > 0);

          const rendered = renderConsensusHarness(requestFor(moduleInterface, roles));
          // Vanishingly rare: a generated identifier that happens to equal one of the full
          // SystemVerilog keyword set this renderer refuses on, beyond what the arbitrary's own
          // `RESERVED` guard already excludes. Not the claim under test, so it is discarded.
          fc.pre(rendered.ok);
          if (!rendered.ok) {
            return;
          }
          const text = rendered.value.contents;

          const inputPorts = moduleInterface.ports.filter((port) => port.direction === 'input');
          const heldSlices = packedPortSlices(inputPorts).filter(
            (slice) => roles.find((entry) => entry.portName === slice.name)?.role === 'hold',
          );

          for (const slice of heldSlices) {
            expect(text).toContain(heldOverwriteLine(slice.high, slice.low));
          }
          assertPairwiseDisjoint(heldSlices);
          pairsChecked += (heldSlices.length * (heldSlices.length - 1)) / 2;
        }),
        propertyParameters(),
      );

      // NON-VACUITY: a disjoint pair of Held_Input ports was actually checked, not just declared
      // possible.
      expect(pairsChecked > 0, 'no pair of Held_Input ports was ever exercised').toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// The two constructed, exhausted non-vacuity fixtures
// ---------------------------------------------------------------------------

describe(`${PROPERTY} (constructed fixtures)`, () => {
  // `arbModuleInterface()` caps each PORT at 64 bits, but places no floor on how many of its 1 to
  // 6 ports are wide, so a bundle over 64 bits total is a rare draw rather than a guaranteed one;
  // a hand-built fixture is needed to force a second `v_hold` lane rather than leave it to chance.
  it('emits a v_hold lane assignment for every 64-bit lane of a bundle wider than 64 bits', () => {
    const moduleInterface = moduleInterfaceWith('wide_hold_mod', [
      { name: 'a', direction: 'input', width: 40 },
      { name: 'held_wide', direction: 'input', width: 40 },
      { name: 'q', direction: 'output', width: 8 },
    ]);
    const roles = rolesFor(moduleInterface, new Set(['held_wide']));
    const rendered = renderConsensusHarness(requestFor(moduleInterface, roles));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const text = rendered.value.contents;

    // Bundle width 80 (40 + 40): two lanes, [63:0] and [79:64].
    expect(text).toContain(heldLaneLine(0, 63, 0));
    expect(text).toContain(heldLaneLine(1, 79, 64));

    // `held_wide` occupies bits [79:40], straddling the lane boundary; its own overwrite line
    // still reads its own slice, not either lane's boundary.
    const inputPorts = moduleInterface.ports.filter((port) => port.direction === 'input');
    const heldWide = packedPortSlices(inputPorts).find((slice) => slice.name === 'held_wide');
    if (heldWide === undefined) throw new Error('fixture defect');
    expect(heldWide).toEqual({ name: 'held_wide', high: 79, low: 40 });
    expect(text).toContain(heldOverwriteLine(79, 40));
  });

  // Two Held_Input ports of EQUAL width: the only draw where a renderer that copy/pasted the
  // first held port's slice into the second would still emit a well-formed line of the right
  // width, so the check below pins the exact bit positions rather than the width alone.
  it('overwrites two equal-width Held_Input ports independently, each over its own disjoint slice', () => {
    const moduleInterface = moduleInterfaceWith('two_hold_equal_width_mod', [
      { name: 'op_a', direction: 'input', width: 8 },
      { name: 'op_b', direction: 'input', width: 8 },
      { name: 'q', direction: 'output', width: 8 },
    ]);
    const roles = rolesFor(moduleInterface, new Set(['op_a', 'op_b']));
    const rendered = renderConsensusHarness(requestFor(moduleInterface, roles));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const text = rendered.value.contents;

    const inputPorts = moduleInterface.ports.filter((port) => port.direction === 'input');
    const slices = packedPortSlices(inputPorts);
    const opA = slices.find((slice) => slice.name === 'op_a');
    const opB = slices.find((slice) => slice.name === 'op_b');
    if (opA === undefined || opB === undefined) throw new Error('fixture defect');
    expect(opA).toEqual({ name: 'op_a', high: 7, low: 0 });
    expect(opB).toEqual({ name: 'op_b', high: 15, low: 8 });
    assertPairwiseDisjoint([opA, opB]);

    expect(text).toContain(heldOverwriteLine(opA.high, opA.low));
    expect(text).toContain(heldOverwriteLine(opB.high, opB.low));
    // The exact defect a width-only check would miss: `op_b`'s `v` slice overwritten from
    // `op_a`'s `v_hold` slice (or vice versa) is a syntactically well-formed, width-8 line - the
    // two ports sharing bit positions the property under test forbids.
    expect(text).not.toContain(heldOverwriteLineAt(opB.high, opB.low, opA.high, opA.low));
    expect(text).not.toContain(heldOverwriteLineAt(opA.high, opA.low, opB.high, opB.low));
  });
});
