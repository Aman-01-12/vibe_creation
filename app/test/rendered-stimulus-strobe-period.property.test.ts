// stimulus-transaction-structure, Property 5 (pre-check only): Exactly one Strobe assertion per
// Strobe_Period, on the same step for every Strobe (task 8.6, optional).
//
// THE ORACLE IS TEXTUAL, NOT A SIMULATOR RUN
//   This is the cheap fast-tier pre-check the design names as NOT discharging criteria 3.1, 3.2,
//   3.9, 3.10 - task 8.8's integration property, run over a real `iverilog` plus `vvp` build, is
//   what discharges them. `renderStimulusFunction` (consensus-harness.ts) has exactly one place a
//   `strobe`-role port's value is forced: `v[high:low] = {width{(step % STROBE_PERIOD) ==
//   0}};`. That expression is true at exactly one step of every period (the period's own
//   multiple) and false otherwise, and every `strobe`-role port's line is built from the SAME
//   `STROBE_PERIOD` constant, so checking that exact line for every `strobe`-role port is a
//   faithful structural restatement of both halves of the claim at once: one assertion per
//   period, and the same step for every Strobe.
//
// WHY THIS IS NOT A DUPLICATE OF task 4.6's rendered-stimulus-strobe.property.test.ts
//   That file proves Property 6 (a multi-bit Strobe reads as a single LEVEL across its own bits),
//   so its population is deliberately restricted to multi-bit input ports - a width-1 Strobe is
//   never drawn there. Property 5 makes no width claim at all ("at least one Strobe" of any
//   width), so this file draws from every input port regardless of width and adds the width-1
//   fixture that restriction excludes.
//
// Validates: nothing on its own (pre-check only); Requirements 3.1, 3.2, 3.9, 3.10 are discharged
// by task 8.8's integration property.

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
// the `@app/tools` barrel, the convention `rendered-stimulus-strobe.property.test.ts` already
// uses.
import { STROBE_PERIOD } from '../tools/simulator/consensus-harness.js';

import { arbModuleInterface } from './interface-header-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'stimulus-transaction-structure, Property 5 (pre-check only): Exactly one Strobe assertion ' +
  'per Strobe_Period, on the same step for every Strobe';

const COMBINATIONAL: ClockingContract = { clockName: null, resetName: null, resetActiveLow: false };

function moduleInterfaceWith(moduleName: string, ports: readonly Port[]): ModuleInterface {
  return { moduleName, ports, clocking: COMBINATIONAL, validityOutputName: null };
}

/** The exact text `renderStimulusFunction` emits for one `strobe`-role port's own slice. */
function strobeAssertExpression(high: number, low: number, width: number): string {
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
    nonce: 'strobeperiod',
    watchdogBudgetNs: 2_000_000,
    sampleBudget: SAMPLE_BUDGET,
    roles,
  };
}

// ---------------------------------------------------------------------------
// The sampled population
// ---------------------------------------------------------------------------

/** One generated interface, paired with a total Role_Declaration marking a non-empty subset of
 * ITS INPUT PORTS OF ANY WIDTH `strobe` and the rest `data` - unlike task 4.6's population, this
 * is not restricted to multi-bit ports, because Property 5 carries no width claim. Carries an
 * empty `roles` for a zero-input-port draw, discarded by the property's own `fc.pre`. */
function scenarioArbitrary(): fc.Arbitrary<{
  readonly moduleInterface: ModuleInterface;
  readonly roles: RoleDeclaration;
}> {
  return arbModuleInterface().chain((moduleInterface) => {
    const inputNames = moduleInterface.ports
      .filter((port) => port.direction === 'input')
      .map((port) => port.name);
    if (inputNames.length === 0) {
      return fc.constant({ moduleInterface, roles: [] });
    }
    return fc.subarray(inputNames, { minLength: 1 }).map((strobeNames) => ({
      moduleInterface,
      roles: rolesFor(moduleInterface, new Set(strobeNames)),
    }));
  });
}

describe(PROPERTY, () => {
  it(
    "overwrites every strobe-role port's own slice, of any width, with the same " +
      'STROBE_PERIOD-keyed assertion expression',
    () => {
      let strobeCases = 0;

      fc.assert(
        fc.property(scenarioArbitrary(), (scenario) => {
          const { moduleInterface, roles } = scenario;
          // A zero-input-port draw cannot carry a non-empty Role_Declaration at all.
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
            // Checked against the ONE fixed expression built from the single shared
            // `STROBE_PERIOD` constant: a renderer that gave two Strobe ports different step
            // conditions would fail this for at least one of them, which is what makes this a
            // structural stand-in for "the same step for every Strobe".
            expect(text).toContain(strobeAssertExpression(slice.high, slice.low, width));
          }
        }),
        propertyParameters(),
      );

      // NON-VACUITY: a Strobe port was actually exercised, not just declared possible.
      expect(strobeCases > 0, 'no Strobe port was ever exercised').toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// The constructed, exhausted width-1 fixture task 4.6 deliberately excludes
// ---------------------------------------------------------------------------

describe(`${PROPERTY} (constructed fixture)`, () => {
  // Task 4.6's population is multi-bit-only by design (Property 6's own non-vacuity need), so a
  // width-1 Strobe is never drawn there. Two width-1 Strobes at non-adjacent bit positions is the
  // shape a renderer hardcoding a single-port offset would fail while a single-port draw would
  // still pass.
  it('asserts two non-adjacent width-1 Strobe ports on the same STROBE_PERIOD-keyed step', () => {
    const moduleInterface = moduleInterfaceWith('two_single_bit_strobe_mod', [
      { name: 'go', direction: 'input', width: 1 },
      { name: 'mode', direction: 'input', width: 8 },
      { name: 'latch', direction: 'input', width: 1 },
      { name: 'q', direction: 'output', width: 1 },
    ]);
    const roles = rolesFor(moduleInterface, new Set(['go', 'latch']));
    const rendered = renderConsensusHarness(requestFor(moduleInterface, roles));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const slices = packedPortSlices(
      moduleInterface.ports.filter((port) => port.direction === 'input'),
    );
    const go = slices.find((slice) => slice.name === 'go');
    const latch = slices.find((slice) => slice.name === 'latch');
    if (go === undefined || latch === undefined) throw new Error('fixture defect');
    expect(rendered.value.contents).toContain(strobeAssertExpression(go.high, go.low, 1));
    expect(rendered.value.contents).toContain(strobeAssertExpression(latch.high, latch.low, 1));
  });
});
