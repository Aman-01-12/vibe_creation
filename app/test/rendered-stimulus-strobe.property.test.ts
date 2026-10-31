// stimulus-transaction-structure, Property 6: A multi-bit Strobe reads as a single level
// (task 4.6, C3).
//
// THE ORACLE IS TEXTUAL, NOT A SIMULATOR RUN
//   This file makes no simulator call. `ece_stimulus` is a pure function of `step`, and
//   `renderStimulusFunction` (consensus-harness.ts) has exactly one place a `strobe`-role port's
//   value is forced: the overwrite line `v[high:low] = {width{(step % STROBE_PERIOD) == 0}};`,
//   rendered over that port's own `packedPortSlices` slice. The replication operator broadcasts
//   ONE boolean to every bit of the slice, so that exact line is what structurally guarantees
//   criterion 3.3's "one common value at every step" - a renderer that regressed to a per-bit
//   loop or read a Stimulus_Mixer bit into any bit of the slice would not produce this line, so
//   checking for its presence (and the width-1 form's absence) is a faithful structural
//   restatement of the semantic claim, matching `rendered-stimulus-enable.property.test.ts`'s
//   own reasoning for the inverse `enable` line.
//
// NON-VACUITY
//   The sampled population draws its Role_Declaration from only the generated interface's
//   MULTI-BIT (width > 1) input ports, marking a non-empty subset `strobe` and the rest `data`,
//   so every run exercises a width > 1 Strobe by construction rather than leaving it to a uniform
//   draw that could land on an all-width-1 map. A draw with no multi-bit input port at all is
//   discarded via the `roles: []` sentinel and `fc.pre`, the same shape
//   `rendered-stimulus-enable.property.test.ts` uses for its own zero-input-port case. Two
//   further shapes are CONSTRUCTED and EXHAUSTED as their own `it` blocks rather than left to
//   sampling, per
//   chipAgent/_inbox/gotcha-a-closed-union-non-vacuity-row-should-be-exhausted-not-sampled.md:
//   a single multi-bit Strobe port, and two non-adjacent multi-bit Strobe ports separated by a
//   `data` port, so a renderer hardcoded to bit-0 slices fails the second while passing the
//   first.
//
// Validates: Requirements 3.3

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
// STROBE_PERIOD is read from its own defining module (`consensus-harness.ts`) rather than through
// the `@app/tools` barrel, the convention `rendered-stimulus-enable.property.test.ts` already
// uses for `ENABLE_FRAME_PERIOD`.
import { STROBE_PERIOD } from '../tools/simulator/consensus-harness.js';

import { arbModuleInterface } from './interface-header-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'stimulus-transaction-structure, Property 6: A multi-bit Strobe reads as a single level';

const COMBINATIONAL: ClockingContract = { clockName: null, resetName: null, resetActiveLow: false };

function moduleInterfaceWith(moduleName: string, ports: readonly Port[]): ModuleInterface {
  return { moduleName, ports, clocking: COMBINATIONAL, validityOutputName: null };
}

/** The exact text `renderStimulusFunction` emits for one `strobe`-role port's own slice. */
function strobeLevelExpression(high: number, low: number, width: number): string {
  return `v[${String(high)}:${String(low)}] = {${String(width)}{(step % ${String(STROBE_PERIOD)}) == 0}};`;
}

/** A total Role_Declaration over `moduleInterface`'s own input ports, naming `strobeNames`. */
function rolesFor(
  moduleInterface: ModuleInterface,
  strobeNames: ReadonlySet<string>,
): RoleDeclaration {
  return moduleInterface.ports
    .filter((port) => port.direction === 'input')
    .map((port) => ({
      portName: port.name,
      role: strobeNames.has(port.name) ? ('strobe' as const) : ('data' as const),
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
    nonce: 'strobeprop',
    watchdogBudgetNs: 2_000_000,
    sampleBudget: SAMPLE_BUDGET,
    roles,
  };
}

// ---------------------------------------------------------------------------
// The sampled population
// ---------------------------------------------------------------------------

/** One generated interface, paired with a total Role_Declaration marking a non-empty subset of
 * its MULTI-BIT input ports `strobe` and the rest `data`. Carries an empty `roles` when the draw
 * has no multi-bit input port at all, discarded by the property's own `fc.pre`. */
function scenarioArbitrary(): fc.Arbitrary<{
  readonly moduleInterface: ModuleInterface;
  readonly roles: RoleDeclaration;
}> {
  return arbModuleInterface().chain((moduleInterface) => {
    const multiBitInputNames = moduleInterface.ports
      .filter((port) => port.direction === 'input' && port.width > 1)
      .map((port) => port.name);
    if (multiBitInputNames.length === 0) {
      return fc.constant({ moduleInterface, roles: [] });
    }
    return fc.subarray(multiBitInputNames, { minLength: 1 }).map((strobeNames) => ({
      moduleInterface,
      roles: rolesFor(moduleInterface, new Set(strobeNames)),
    }));
  });
}

describe(PROPERTY, () => {
  it(
    "overwrites every multi-bit strobe-role port's own slice with the single-level replication " +
      'expression over its full width',
    () => {
      let strobeCases = 0;

      fc.assert(
        fc.property(scenarioArbitrary(), (scenario) => {
          const { moduleInterface, roles } = scenario;
          // A draw with no multi-bit input port cannot carry a non-empty Role_Declaration here.
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
          for (const slice of packedPortSlices(inputPorts)) {
            const role = roles.find((entry) => entry.portName === slice.name)?.role;
            if (role !== 'strobe') {
              continue;
            }
            strobeCases += 1;
            const width = slice.high - slice.low + 1;
            expect(text).toContain(strobeLevelExpression(slice.high, slice.low, width));
          }
        }),
        propertyParameters(),
      );

      // NON-VACUITY: a multi-bit Strobe port was actually exercised, not just declared possible.
      expect(strobeCases > 0, 'no multi-bit Strobe port was ever exercised').toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// The two constructed, exhausted non-vacuity fixtures
// ---------------------------------------------------------------------------

describe(`${PROPERTY} (constructed fixtures)`, () => {
  // The replication operator `{width{...}}` is only exercised above width 1: `{1{x}}` and
  // `{8{x}}` are different rendered text, and a renderer hardcoding the single-bit case passes
  // every width-1 draw while failing this one.
  it('replicates the single-level expression across every bit of a multi-bit Strobe port, not the width-1 form', () => {
    const moduleInterface = moduleInterfaceWith('multi_bit_strobe_mod', [
      { name: 'go', direction: 'input', width: 8 },
      { name: 'q', direction: 'output', width: 8 },
    ]);
    const roles = rolesFor(moduleInterface, new Set(['go']));
    const rendered = renderConsensusHarness(requestFor(moduleInterface, roles));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value.contents).toContain(strobeLevelExpression(7, 0, 8));
    expect(rendered.value.contents).not.toContain(strobeLevelExpression(7, 0, 1));
  });

  // Two non-adjacent multi-bit Strobe ports, separated by a `data` port: a renderer that only
  // ever overwrites the slice starting at bit 0 fails this case while passing the single-port
  // fixture above.
  it('overwrites two non-adjacent multi-bit Strobe ports independently, each over its own full slice', () => {
    const moduleInterface = moduleInterfaceWith('two_strobe_mod', [
      { name: 'cmd_strobe', direction: 'input', width: 8 },
      { name: 'mode', direction: 'input', width: 20 },
      { name: 'ctrl_strobe', direction: 'input', width: 4 },
      { name: 'q', direction: 'output', width: 4 },
    ]);
    const roles = rolesFor(moduleInterface, new Set(['cmd_strobe', 'ctrl_strobe']));
    const rendered = renderConsensusHarness(requestFor(moduleInterface, roles));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const slices = packedPortSlices(
      moduleInterface.ports.filter((port) => port.direction === 'input'),
    );
    const cmdStrobe = slices.find((slice) => slice.name === 'cmd_strobe');
    const ctrlStrobe = slices.find((slice) => slice.name === 'ctrl_strobe');
    if (cmdStrobe === undefined || ctrlStrobe === undefined) throw new Error('fixture defect');
    expect(cmdStrobe).toEqual({ name: 'cmd_strobe', high: 7, low: 0 });
    expect(ctrlStrobe).toEqual({ name: 'ctrl_strobe', high: 31, low: 28 });
    expect(rendered.value.contents).toContain(
      strobeLevelExpression(cmdStrobe.high, cmdStrobe.low, 8),
    );
    expect(rendered.value.contents).toContain(
      strobeLevelExpression(ctrlStrobe.high, ctrlStrobe.low, 4),
    );
  });
});
