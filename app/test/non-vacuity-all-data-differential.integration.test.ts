// Feature: stimulus-transaction-structure, Property 10: The check distinguishes a held port
// from an unheld one (task 8.11, C9). Integration tier - the figures come from the stdout of two
// real `iverilog` plus `vvp` runs, each under its own nonce, through the real sandbox.
//
// WHY THIS TEST HAS TO EXIST
//   Tasks 8.9/8.10 run a genuinely `hold`-rendered probe and read it with `roles` marking that
//   same port `hold`. If `readNonVacuity`'s hold-window logic always reported `changeCount: 0`
//   regardless of what the probe actually drove - a vacuously-passing check - those tests would
//   still pass. This file is the negative control that rules that out: it renders a SECOND probe
//   for the SAME `ModuleInterface` and the SAME Sample_Budget, with the one input port declared
//   `data` instead of `hold`, so every step draws a fresh Stimulus_Mixer value rather than one
//   held for a whole Hold_Window. Reading that run's stdout through the SAME `readNonVacuity`
//   logic - with `roles` still marking the port `hold`, exactly as Req 7.5 states it ("run over
//   the same ... Hold_Window boundaries ... with every input port named `data`") - measures what
//   the hold-reading logic sees when fed a signal that was never actually held.
//
// WHY NO CLOCK AND NO RESET
//   The fixture interface declares neither, so `hasReset` is `false` throughout `buildReport`
//   (`non-vacuity-check.ts`) and no pair is ever reset-excluded. Property 10 is stated for "any
//   Declared_Interface" with no mention of reset, so this keeps the fixture to the one thing the
//   property is actually about.
//
// WHY ONE DETERMINISTIC RUN, NOT A SAMPLED LOOP
//   The design's own tier table (`Which tier each property runs in`) places Property 10 in the
//   integration tier precisely because its figures must come from a real toolchain invocation;
//   Properties 5, 7, 9 and 10 are each read from ONE such run, with the universal quantifier
//   ("for any whole Hold_Window") checked across every window the one run covers - the same shape
//   task 8.9 takes, not a `fc.assert` over many interfaces.

import { describe, expect, it } from 'vitest';

import type { ClockingContract, ModuleInterface } from '@app/core';
import {
  readNonVacuity,
  renderNonVacuityProbe,
  type ResourceLimits,
  type RoleDeclaration,
} from '@app/tools';
// Not re-exported through the `@app/tools` barrel (simulator/index.ts); read from its own module
// directly, the same convention `non-vacuity-deviation-naming.property.test.ts` already uses.
import { HOLD_FRAME_PERIOD } from '../tools/simulator/consensus-harness.js';

import { PROBE, realOracleAdapter } from './real-oracle-harness.js';

const PROPERTY =
  'stimulus-transaction-structure, Property 10: The check distinguishes a held port from an unheld one';

if (!PROBE.available) {
  console.warn(
    `[non-vacuity-all-data-differential.integration] Real-oracle path NOT exercised: ${PROBE.reason}. ` +
      'Property 10, the one integration test proving the hold check can fail, is UNVALIDATED ' +
      'against real iverilog in this environment.',
  );
}

const REAL_LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };

/** Two real toolchain invocations, so this test's own timeout is double the single-run norm. */
const RUN_TIMEOUT = 120_000;

/** Req 7.2's floor (16 whole Hold_Windows), plus margin so the test is not pinned to the floor. */
const HOLD_WINDOW_COUNT = 20;
const SAMPLE_BUDGET = HOLD_WINDOW_COUNT * HOLD_FRAME_PERIOD;

const COMBINATIONAL: ClockingContract = { clockName: null, resetName: null, resetActiveLow: false };

const PORT_NAME = 'data_in';

/** One input port, one output port - the output is unused by the probe but keeps the fixture a
 * recognisable Declared_Interface rather than an input-only degenerate one. */
const MODULE_INTERFACE: ModuleInterface = {
  moduleName: 'nvad_dut',
  ports: [
    { name: PORT_NAME, direction: 'input', width: 8 },
    { name: 'unused_out', direction: 'output', width: 1 },
  ],
  clocking: COMBINATIONAL,
  validityOutputName: null,
};

/** The Role_Declaration the READING always uses: the port named `hold`, per Req 7.5's own text -
 * the reading logic that discharges the clean baseline (task 8.9) is reused unchanged here. */
const HOLD_READING_ROLES: RoleDeclaration = [{ portName: PORT_NAME, role: 'hold' }];

/** The Role_Declaration run B's PROBE is actually RENDERED with: every input port `data`. */
const ALL_DATA_RENDER_ROLES: RoleDeclaration = [{ portName: PORT_NAME, role: 'data' }];

describe.skipIf(!PROBE.available)(PROPERTY, () => {
  it(
    'reports a clean hold baseline for a genuinely `hold`-rendered probe, and at least one ' +
      'value change strictly inside at least one Hold_Window for the same reading run over an ' +
      'all-`data`-rendered probe',
    async () => {
      const nonceHeld = 'nvadHeld1';
      const nonceData = 'nvadData1';

      // Run A: the probe is rendered AND read with the port declared `hold` - the clean baseline,
      // the same shape task 8.9 discharges.
      const renderedHeld = renderNonVacuityProbe({
        moduleInterface: MODULE_INTERFACE,
        nonce: nonceHeld,
        roles: HOLD_READING_ROLES,
        sampleBudget: SAMPLE_BUDGET,
      });
      if (!renderedHeld.ok) {
        throw new Error(`fixture defect rendering the held probe: ${renderedHeld.error.code}`);
      }
      const verdictHeld = await realOracleAdapter().simulate([], renderedHeld.value, REAL_LIMITS);
      const readingHeld = readNonVacuity(
        verdictHeld.stdout,
        nonceHeld,
        MODULE_INTERFACE,
        HOLD_READING_ROLES,
        SAMPLE_BUDGET,
      );
      if (readingHeld.kind !== 'read') {
        throw new Error(`run A's reading came back incomplete: ${readingHeld.reason}`);
      }
      const heldPort = readingHeld.holdWindowsByPort.find((port) => port.portName === PORT_NAME);
      if (heldPort === undefined) {
        throw new Error('fixture defect: run A reading carries no entry for the held port');
      }
      expect(heldPort.windows.length).toBeGreaterThanOrEqual(16);
      expect(heldPort.windows.every((window) => window.changeCount === 0)).toBe(true);
      expect(readingHeld.demonstratesTransactionStructure).toBe(true);

      // Run B: the probe is rendered with the SAME port declared `data` - a fresh
      // Stimulus_Mixer value every step - but READ with `roles` still marking it `hold`,
      // exactly the construction Req 7.5 states.
      const renderedData = renderNonVacuityProbe({
        moduleInterface: MODULE_INTERFACE,
        nonce: nonceData,
        roles: ALL_DATA_RENDER_ROLES,
        sampleBudget: SAMPLE_BUDGET,
      });
      if (!renderedData.ok) {
        throw new Error(`fixture defect rendering the all-data probe: ${renderedData.error.code}`);
      }
      const verdictData = await realOracleAdapter().simulate([], renderedData.value, REAL_LIMITS);
      const readingData = readNonVacuity(
        verdictData.stdout,
        nonceData,
        MODULE_INTERFACE,
        HOLD_READING_ROLES,
        SAMPLE_BUDGET,
      );
      if (readingData.kind !== 'read') {
        throw new Error(`run B's reading came back incomplete: ${readingData.reason}`);
      }
      const unheldPort = readingData.holdWindowsByPort.find((port) => port.portName === PORT_NAME);
      if (unheldPort === undefined) {
        throw new Error('fixture defect: run B reading carries no entry for the held port');
      }

      // The positive claim this whole file exists for: at least one window's change count is
      // non-zero. Every `changeSteps` entry `holdWindowReadings` ever records is already, by
      // construction, strictly inside its own window (a pair's second step never leaves the
      // window its first step started in), so a non-empty entry here IS a change strictly
      // inside a Hold_Window, not merely inside the run.
      expect(unheldPort.windows.some((window) => window.changeCount > 0)).toBe(true);
      expect(readingData.demonstratesTransactionStructure).toBe(false);
    },
    RUN_TIMEOUT,
  );
});
