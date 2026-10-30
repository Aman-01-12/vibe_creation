// Real-toolchain integration test for Property 5 (task 8.8; design.md "Property 5"): exactly
// one Strobe assertion per Strobe_Period, on the same step for every Strobe. This is the
// discharge for criteria 3.1, 3.2, 3.9, 3.10, 7.3, 7.4 - the fast-tier pre-check (task 8.6) was
// skipped as optional, so this file is the only place those criteria are exercised.
//
// EVERY FIGURE COMES FROM A REAL `iverilog` + `vvp` RUN
//   The rendered Non_Vacuity_Probe (C8) is driven through `realOracleAdapter().simulate`, the
//   SAME real-toolchain path `consensus-harness.integration.test.ts` uses, with an empty `rtl`
//   array: the probe is fully self-contained and never instantiates a Candidate_Design. The real
//   stdout is then fed to the pure reader `readNonVacuity` (C9). No stub, no stubbed renderer,
//   and no hand-written sample stream appears on this path (Req 7.6).
//
// WHY THE FIXTURE INTERFACE IS RESETLESS (COMBINATIONAL), NOT CLOCKED
//   A clocked-and-reset interface always excludes Strobe_Period 0 (it contains step 0, which is
//   always reset-asserted), and the Reset_Frame_Period (256) can additionally knock out any
//   period that spans a multiple of 256 - at STROBE_PERIOD 67 that lands inside more than one
//   period within a modest budget, so reaching 8 reset-free periods would need working out the
//   reset-period alignment rather than just adding a ninth period. A combinational interface
//   (`clockName: null, resetName: null`) has no reset step at all, so `readNonVacuity`'s
//   `hasReset` is false, every whole period is reset-free by construction, and 8 whole periods
//   (`8 * STROBE_PERIOD` steps) is exactly the floor Req 7.4 asks for. Chosen as the simpler of
//   the two options the task named.
//
// TWO STROBE PORTS, TO COVER THE CROSS-PORT HALF OF THE CLAIM
//   `renderStimulusFunction` emits the identical guard `(step % STROBE_PERIOD) == 0` for every
//   strobe-role port, so two declared Strobe ports are structurally certain to assert on the
//   same step - but that is a fact about the rendered TEXT, and this test's job is to confirm it
//   survives a real compile and run, not to re-read the text.

import { describe, expect, it } from 'vitest';

import type { ClockingContract, ModuleInterface, Port } from '@app/core';
import type { ResourceLimits } from '@app/tools';

import { STROBE_PERIOD, type RoleDeclaration } from '../tools/simulator/consensus-harness.js';
import { renderNonVacuityProbe } from '../tools/simulator/non-vacuity-probe.js';
import { readNonVacuity, type StrobePeriodReading } from '../tools/simulator/non-vacuity-check.js';
import { PROBE, realOracleAdapter } from './real-oracle-harness.js';

if (!PROBE.available) {
  console.warn(
    `[non-vacuity-strobe-period.integration] Real-oracle path NOT exercised: ${PROBE.reason}. ` +
      'Property 5 (the Strobe assertion pattern) is UNVALIDATED against real iverilog in this environment.',
  );
}

const REAL_LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };
const RUN_TIMEOUT = 60_000;

/** Req 7.4's floor: at least 8 whole reset-free Strobe_Periods. */
const MIN_RESET_FREE_PERIODS = 8;

const COMBINATIONAL: ClockingContract = { clockName: null, resetName: null, resetActiveLow: false };

/** Two Strobe ports (one single-bit, one multi-bit) and no other role, on a resetless interface. */
const STROBE_PORTS: readonly Port[] = [
  { name: 'strobe_a', direction: 'input', width: 1 },
  { name: 'strobe_b', direction: 'input', width: 3 },
  { name: 'y', direction: 'output', width: 1 },
];

const STROBE_INTERFACE: ModuleInterface = {
  moduleName: 'strobe_target',
  ports: STROBE_PORTS,
  clocking: COMBINATIONAL,
  validityOutputName: null,
};

const STROBE_ROLES: RoleDeclaration = [
  { portName: 'strobe_a', role: 'strobe' },
  { portName: 'strobe_b', role: 'strobe' },
];

/** Exactly 8 whole Strobe_Periods, all reset-free since the interface declares no reset at all. */
const SAMPLE_BUDGET = MIN_RESET_FREE_PERIODS * STROBE_PERIOD;

/** `periods` indexed by its own `periodIndex`, so two ports' readings can be compared by period. */
function byPeriodIndex(
  periods: readonly StrobePeriodReading[],
): ReadonlyMap<number, StrobePeriodReading> {
  return new Map(periods.map((period) => [period.periodIndex, period]));
}

describe.skipIf(!PROBE.available)(
  'Property 5: exactly one Strobe assertion per Strobe_Period, on the same step for every Strobe (Req 3.1, 3.2, 3.9, 3.10, 7.3, 7.4)',
  () => {
    it(
      'reads exactly one assertion per reset-free period, on the same step for both declared Strobes, from a real toolchain run',
      async () => {
        const nonce = 'strobePeriod1';
        const rendered = renderNonVacuityProbe({
          moduleInterface: STROBE_INTERFACE,
          nonce,
          roles: STROBE_ROLES,
          sampleBudget: SAMPLE_BUDGET,
        });
        expect(rendered.ok).toBe(true);
        if (!rendered.ok) return;

        // Empty `rtl`: the probe is self-contained and instantiates no Candidate_Design.
        const verdict = await realOracleAdapter().simulate([], rendered.value, REAL_LIMITS);
        // The probe emits no `CHECK` line by design, so `verdict.verdict` reads `error` (no
        // readable check) on every clean run; `failureCause` is what actually distinguishes a
        // healthy real run from a broken one here.
        expect(verdict.failureCause).toBe('none');

        const outcome = readNonVacuity(
          verdict.stdout,
          nonce,
          STROBE_INTERFACE,
          STROBE_ROLES,
          SAMPLE_BUDGET,
        );
        expect(outcome.kind).toBe('read');
        if (outcome.kind !== 'read') return;

        expect(outcome.resetFreeStrobePeriodCount).toBeGreaterThanOrEqual(MIN_RESET_FREE_PERIODS);
        expect(outcome.strobePeriod).toBe(STROBE_PERIOD);
        expect(outcome.demonstratesTransactionStructure).toBe(true);
        expect(outcome.strobePeriodsByPort).toHaveLength(2);

        for (const port of outcome.strobePeriodsByPort) {
          expect(port.periods.length).toBeGreaterThanOrEqual(MIN_RESET_FREE_PERIODS);
          for (const period of port.periods) {
            expect(period.assertedStepCount).toBe(1);
          }
        }

        // Cross-port agreement: every Strobe of this Declared_Interface asserts on the same
        // step within each period it was read for.
        const [portA, portB] = outcome.strobePeriodsByPort;
        expect(portA).toBeDefined();
        expect(portB).toBeDefined();
        if (portA === undefined || portB === undefined) return;
        const periodsB = byPeriodIndex(portB.periods);
        for (const periodA of portA.periods) {
          const periodB = periodsB.get(periodA.periodIndex);
          expect(periodB).toBeDefined();
          expect(periodB?.assertedSteps).toEqual(periodA.assertedSteps);
        }
      },
      RUN_TIMEOUT,
    );
  },
);
