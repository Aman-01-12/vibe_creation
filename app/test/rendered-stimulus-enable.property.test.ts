// Feature: reference-model-rendered-stimulus, Property 4: An enable-role port is released once
// per Enable_Frame_Period and asserted otherwise (task 2.9, C5).
//
// THE ORACLE IS TEXTUAL, NOT A SIMULATOR RUN
//   This file makes no simulator call. `ece_stimulus` is a pure function of `step`, and
//   `renderStimulusFunction` (consensus-harness.ts) has exactly one place an `enable`-role port's
//   value is forced: the overwrite line `v[high:low] = {width{(step % ENABLE_FRAME_PERIOD) !=
//   0}};`, rendered over that port's own `packedPortSlices` slice. `(step % 20) != 0` is TRUE
//   (the port driven high, asserted) on every step except a multiple of 20, where it is FALSE
//   (released, zero) - so checking for the presence of that exact line, for every `enable` port,
//   and its absence for every `data` port, is a faithful structural restatement of the semantic
//   claim, matching the one example case already pinned in `consensus-harness.test.ts`'s own
//   "overwrites an enable-role port's own slice ..." test.
//
// NON-VACUITY
//   The sampled population (`arbModuleInterface()`) always carries a Role_Declaration with at
//   least one `enable` port by construction (a non-empty subset of each draw's input ports), so
//   the role is exercised on every run rather than left to a uniform draw that could land on an
//   all-`data` map - the exact gap where the measured +12.5pp and +21.8pp (multi_16bit, RAM) live.
//   Three further shapes the task names as decisive traps for a narrow renderer are CONSTRUCTED
//   and EXHAUSTED as their own `it` blocks rather than left to sampling, per
//   `chipAgent/_inbox/gotcha-a-closed-union-non-vacuity-row-should-be-exhausted-not-sampled.md`:
//   a single enable port, two enable ports at NON-ADJACENT slices (the RAM shape at bits 0 and
//   15), and a MULTI-BIT enable port (the replication operator only matters above width 1).
//
// Validates: Requirements 2.6, 2.7

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
// ENABLE_FRAME_PERIOD is read from its own defining module (`consensus-harness.ts`) rather than
// through the `@app/tools` barrel, matching the convention
// `consensus-determinism.integration.test.ts` and its siblings already use for this file.
import { ENABLE_FRAME_PERIOD } from '../tools/simulator/consensus-harness.js';

import { arbModuleInterface } from './interface-header-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'reference-model-rendered-stimulus, Property 4: An enable-role port is released once per ' +
  'Enable_Frame_Period and asserted otherwise';

const COMBINATIONAL: ClockingContract = { clockName: null, resetName: null, resetActiveLow: false };

function moduleInterfaceWith(moduleName: string, ports: readonly Port[]): ModuleInterface {
  return { moduleName, ports, clocking: COMBINATIONAL, validityOutputName: null };
}

/** The exact text `renderStimulusFunction` emits for one `enable`-role port's own slice. */
function releaseFrameExpression(high: number, low: number, width: number): string {
  return `v[${String(high)}:${String(low)}] = {${String(width)}{(step % ${String(ENABLE_FRAME_PERIOD)}) != 0}};`;
}

/** A total Role_Declaration over `moduleInterface`'s own input ports, naming `enableNames`. */
function rolesFor(
  moduleInterface: ModuleInterface,
  enableNames: ReadonlySet<string>,
): RoleDeclaration {
  return moduleInterface.ports
    .filter((port) => port.direction === 'input')
    .map((port) => ({
      portName: port.name,
      role: enableNames.has(port.name) ? ('enable' as const) : ('data' as const),
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
    nonce: 'enableprop',
    watchdogBudgetNs: 2_000_000,
    sampleBudget: SAMPLE_BUDGET,
    roles,
  };
}

// ---------------------------------------------------------------------------
// The sampled population
// ---------------------------------------------------------------------------

/** One generated interface, paired with a total Role_Declaration marking a non-empty subset of
 * its input ports `enable` and the rest `data`. Carries an empty `roles` for a zero-input-port
 * draw, discarded by the property's own `fc.pre`. */
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
    return fc.subarray(inputNames, { minLength: 1 }).map((enableNames) => ({
      moduleInterface,
      roles: rolesFor(moduleInterface, new Set(enableNames)),
    }));
  });
}

describe(PROPERTY, () => {
  it(
    "overwrites every enable-role port's own slice with the release-frame expression and never " +
      'forces a data-role port',
    () => {
      let enableCases = 0;
      let dataCases = 0;

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
            const width = slice.high - slice.low + 1;
            const expression = releaseFrameExpression(slice.high, slice.low, width);
            const role = roles.find((entry) => entry.portName === slice.name)?.role;
            if (role === 'enable') {
              enableCases += 1;
              expect(text).toContain(expression);
            } else {
              dataCases += 1;
              expect(text).not.toContain(expression);
            }
          }
        }),
        propertyParameters(),
      );

      // NON-VACUITY: both roles must have actually been exercised across the population, not just
      // declared possible.
      expect({ enableCases: enableCases > 0, dataCases: dataCases > 0 }).toEqual({
        enableCases: true,
        dataCases: true,
      });
    },
  );
});

// ---------------------------------------------------------------------------
// The three constructed, exhausted non-vacuity fixtures
// ---------------------------------------------------------------------------

describe(`${PROPERTY} (constructed fixtures)`, () => {
  it('releases a single-bit enable port, asserted otherwise', () => {
    const moduleInterface = moduleInterfaceWith('single_enable_mod', [
      { name: 'en', direction: 'input', width: 1 },
      { name: 'q', direction: 'output', width: 1 },
    ]);
    const roles = rolesFor(moduleInterface, new Set(['en']));
    const rendered = renderConsensusHarness(requestFor(moduleInterface, roles));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value.contents).toContain(releaseFrameExpression(0, 0, 1));
  });

  // The RAM shape of the design: write_en and read_en land at bits 0 and 15, non-adjacent, so a
  // renderer that only ever overwrites bit 0 (what the probe's multi_16bit expression did) fails
  // this case while passing the single-port fixture above.
  it("overwrites two non-adjacent enable-role ports independently (RAM's write_en at bit 0, read_en at bit 15)", () => {
    const moduleInterface = moduleInterfaceWith('ram_mod', [
      { name: 'write_en', direction: 'input', width: 1 },
      { name: 'write_addr', direction: 'input', width: 8 },
      { name: 'write_data', direction: 'input', width: 6 },
      { name: 'read_en', direction: 'input', width: 1 },
      { name: 'read_addr', direction: 'input', width: 8 },
      { name: 'dout', direction: 'output', width: 16 },
    ]);
    const roles = rolesFor(moduleInterface, new Set(['write_en', 'read_en']));
    const rendered = renderConsensusHarness(requestFor(moduleInterface, roles));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const slices = packedPortSlices(
      moduleInterface.ports.filter((port) => port.direction === 'input'),
    );
    const writeEn = slices.find((slice) => slice.name === 'write_en');
    const readEn = slices.find((slice) => slice.name === 'read_en');
    if (writeEn === undefined || readEn === undefined) throw new Error('fixture defect');
    expect(writeEn).toEqual({ name: 'write_en', high: 0, low: 0 });
    expect(readEn).toEqual({ name: 'read_en', high: 15, low: 15 });
    expect(rendered.value.contents).toContain(releaseFrameExpression(writeEn.high, writeEn.low, 1));
    expect(rendered.value.contents).toContain(releaseFrameExpression(readEn.high, readEn.low, 1));
  });

  // The replication operator `{width{...}}` is only exercised above width 1: `{1{x}}` and
  // `{8{x}}` are different rendered text, and a renderer hardcoding the single-bit case passes
  // every fixture above while failing this one.
  it('replicates the release-frame expression across every bit of a multi-bit enable port', () => {
    const moduleInterface = moduleInterfaceWith('multi_bit_enable_mod', [
      { name: 'mode', direction: 'input', width: 8 },
      { name: 'q', direction: 'output', width: 8 },
    ]);
    const roles = rolesFor(moduleInterface, new Set(['mode']));
    const rendered = renderConsensusHarness(requestFor(moduleInterface, roles));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value.contents).toContain(releaseFrameExpression(7, 0, 8));
    expect(rendered.value.contents).not.toContain(releaseFrameExpression(7, 0, 1));
  });
});
