// Fast-tier unit coverage for the Non_Vacuity_Check reader (C9, task 8.2): the production
// function's own basic correctness, from hand-built `ECE_STIM`/`ECE_STIM_END` stdout text. Tasks
// 8.3-8.5 own the dedicated property tests; this file only pins the shapes those build on.

import { describe, expect, it } from 'vitest';

import type { ClockingContract, ModuleInterface, Port } from '@app/core';

import { HOLD_FRAME_PERIOD, STROBE_PERIOD, type RoleDeclaration } from './consensus-harness.js';
import { STIM_END_PREFIX, STIM_LINE_PREFIX } from './non-vacuity-probe.js';
import { readNonVacuity, type NonVacuityOutcome } from './non-vacuity-check.js';

const NONCE = 'abc123';
const CLOCKED: ClockingContract = { clockName: 'clk', resetName: 'rst', resetActiveLow: false };

function moduleInterfaceWith(ports: readonly Port[], clocking: ClockingContract): ModuleInterface {
  return { moduleName: 'dut', ports, clocking, validityOutputName: null };
}

// `strobe_in` (bit 0) then `held_in` (bits 4:1), matching `packedPortSlices`' declared-order
// layout: the first declared input port takes the lowest bits.
const HOLD_STROBE_INTERFACE = moduleInterfaceWith(
  [
    { name: 'strobe_in', direction: 'input', width: 1 },
    { name: 'held_in', direction: 'input', width: 4 },
    { name: 'q', direction: 'output', width: 4 },
  ],
  CLOCKED,
);

const ROLES: RoleDeclaration = [
  { portName: 'strobe_in', role: 'strobe' },
  { portName: 'held_in', role: 'hold' },
];

function bundleOf(strobeAsserted: boolean, heldValue: bigint): bigint {
  return (heldValue << 1n) | (strobeAsserted ? 1n : 0n);
}

/** Build hand-written `ECE_STIM`/`ECE_STIM_END` stdout for one step-indexed value sequence. */
function stimStdout(values: readonly bigint[]): string {
  const lines = values.map(
    (value, step) => `${STIM_LINE_PREFIX} ${NONCE} ${step} ${value.toString(16)}`,
  );
  lines.push(`${STIM_END_PREFIX} ${NONCE} ${String(values.length)}`);
  return lines.join('\n');
}

/** Two whole windows' worth of bundle values, from per-step strobe/hold functions. */
function twoWindowsOf(
  strobeAssertedAt: (step: number) => boolean,
  heldValueAt: (step: number) => bigint,
): bigint[] {
  const sampleBudget = 2 * STROBE_PERIOD;
  return Array.from({ length: sampleBudget }, (_, step) =>
    bundleOf(strobeAssertedAt(step), heldValueAt(step)),
  );
}

function readTwoWindows(values: readonly bigint[]): NonVacuityOutcome {
  return readNonVacuity(stimStdout(values), NONCE, HOLD_STROBE_INTERFACE, ROLES, values.length);
}

/** The naturally rendered strobe pattern: asserted on step 0 and every later multiple of P. */
function naturalStrobe(step: number): boolean {
  return step % STROBE_PERIOD === 0;
}

describe('readNonVacuity', () => {
  it('reports zero hold changes and exactly one assertion per read period on a clean run', () => {
    const heldValueAt = (step: number): bigint => (step < STROBE_PERIOD ? 3n : 5n);
    const outcome = readTwoWindows(twoWindowsOf(naturalStrobe, heldValueAt));

    expect(outcome.kind).toBe('read');
    if (outcome.kind !== 'read') return;
    expect(outcome.demonstratesTransactionStructure).toBe(true);
    expect(outcome.wholeHoldWindowCount).toBe(2);
    // Window/period 0 always contains step 0, which is always reset-asserted, so only the
    // second period is actually read for this clocked-and-reset interface.
    expect(outcome.resetFreeStrobePeriodCount).toBe(1);

    const held = outcome.holdWindowsByPort.find((port) => port.portName === 'held_in');
    expect(held?.windows.map((window) => window.changeCount)).toEqual([0, 0]);
    expect(held?.distinctHoldValueCount).toBe(2);
    expect(held?.portWidth).toBe(4);

    const strobe = outcome.strobePeriodsByPort.find((port) => port.portName === 'strobe_in');
    expect(strobe?.periods).toEqual([
      { periodIndex: 1, assertedStepCount: 1, assertedSteps: [67] },
    ]);
  });

  it('catches a Held_Input value that changes mid-window', () => {
    const heldValueAt = (step: number): bigint => {
      if (step < STROBE_PERIOD) return 3n;
      return step < 100 ? 5n : 9n;
    };
    const outcome = readTwoWindows(twoWindowsOf(naturalStrobe, heldValueAt));

    expect(outcome.kind).toBe('read');
    if (outcome.kind !== 'read') return;
    expect(outcome.demonstratesTransactionStructure).toBe(false);
    const held = outcome.holdWindowsByPort.find((port) => port.portName === 'held_in');
    expect(held?.windows[0]).toMatchObject({ changeCount: 0, changeSteps: [] });
    expect(held?.windows[1]).toMatchObject({ changeCount: 1, changeSteps: [100] });
  });

  it('catches a Strobe asserted on two steps of one period', () => {
    const heldValueAt = (step: number): bigint => (step < STROBE_PERIOD ? 3n : 5n);
    const strobeAssertedAt = (step: number): boolean => naturalStrobe(step) || step === 70;
    const outcome = readTwoWindows(twoWindowsOf(strobeAssertedAt, heldValueAt));

    expect(outcome.kind).toBe('read');
    if (outcome.kind !== 'read') return;
    expect(outcome.demonstratesTransactionStructure).toBe(false);
    const strobe = outcome.strobePeriodsByPort.find((port) => port.portName === 'strobe_in');
    expect(strobe?.periods).toEqual([
      { periodIndex: 1, assertedStepCount: 2, assertedSteps: [67, 70] },
    ]);
  });

  it('suppresses a would-be hold change at a pair touching a reset-asserted step', () => {
    // Step 0 is always reset-asserted for a clocked-and-reset interface, so the (0, 1) pair is
    // excluded even though the held value genuinely differs there - unlike the mid-window case
    // above, which has no reset-asserted step and is correctly caught.
    const heldValueAt = (step: number): bigint => {
      if (step === 0) return 7n;
      return step < STROBE_PERIOD ? 3n : 5n;
    };
    const outcome = readTwoWindows(twoWindowsOf(naturalStrobe, heldValueAt));

    expect(outcome.kind).toBe('read');
    if (outcome.kind !== 'read') return;
    expect(outcome.demonstratesTransactionStructure).toBe(true);
    const held = outcome.holdWindowsByPort.find((port) => port.portName === 'held_in');
    expect(held?.windows[0]).toMatchObject({ changeCount: 0, changeSteps: [] });
  });

  it('drops a whole Strobe_Period touching a reset-asserted step, even one that double-asserts', () => {
    // Period 0 (steps 0-66) always contains step 0, so it is never read at all - a double
    // assertion placed inside it must not surface as a deviation.
    const heldValueAt = (step: number): bigint => (step < STROBE_PERIOD ? 3n : 5n);
    const strobeAssertedAt = (step: number): boolean => naturalStrobe(step) || step === 5;
    const outcome = readTwoWindows(twoWindowsOf(strobeAssertedAt, heldValueAt));

    expect(outcome.kind).toBe('read');
    if (outcome.kind !== 'read') return;
    expect(outcome.demonstratesTransactionStructure).toBe(true);
    expect(outcome.resetFreeStrobePeriodCount).toBe(1);
    const strobe = outcome.strobePeriodsByPort.find((port) => port.portName === 'strobe_in');
    expect(strobe?.periods).toEqual([
      { periodIndex: 1, assertedStepCount: 1, assertedSteps: [67] },
    ]);
  });

  it('reports incomplete when a step line is absent', () => {
    const lines = [
      `${STIM_LINE_PREFIX} ${NONCE} 0 3`,
      `${STIM_LINE_PREFIX} ${NONCE} 1 5`,
      // step 2 missing
      `${STIM_END_PREFIX} ${NONCE} 3`,
    ];
    const outcome = readNonVacuity(lines.join('\n'), NONCE, HOLD_STROBE_INTERFACE, ROLES, 3);
    expect(outcome.kind).toBe('incomplete');
    if (outcome.kind !== 'incomplete') return;
    expect(outcome.reason).toContain('step 2');
  });

  it('reports incomplete when a step line is duplicated', () => {
    const lines = [
      `${STIM_LINE_PREFIX} ${NONCE} 0 3`,
      `${STIM_LINE_PREFIX} ${NONCE} 1 5`,
      `${STIM_LINE_PREFIX} ${NONCE} 1 7`,
      `${STIM_LINE_PREFIX} ${NONCE} 2 9`,
      `${STIM_END_PREFIX} ${NONCE} 4`,
    ];
    const outcome = readNonVacuity(lines.join('\n'), NONCE, HOLD_STROBE_INTERFACE, ROLES, 3);
    expect(outcome.kind).toBe('incomplete');
    if (outcome.kind !== 'incomplete') return;
    expect(outcome.reason).toContain('more than one');
  });

  it('reports incomplete when the end-marker count does not match the per-step line count', () => {
    const lines = [
      `${STIM_LINE_PREFIX} ${NONCE} 0 3`,
      `${STIM_LINE_PREFIX} ${NONCE} 1 5`,
      `${STIM_LINE_PREFIX} ${NONCE} 2 9`,
      `${STIM_END_PREFIX} ${NONCE} 5`,
    ];
    const outcome = readNonVacuity(lines.join('\n'), NONCE, HOLD_STROBE_INTERFACE, ROLES, 3);
    expect(outcome.kind).toBe('incomplete');
    if (outcome.kind !== 'incomplete') return;
    expect(outcome.reason).toContain('ECE_STIM_END');
  });

  it('uses the Hold_Frame_Period when no Strobe is declared', () => {
    const holdOnlyInterface = moduleInterfaceWith(
      [
        { name: 'held_in', direction: 'input', width: 2 },
        { name: 'q', direction: 'output', width: 2 },
      ],
      CLOCKED,
    );
    const holdOnlyRoles: RoleDeclaration = [{ portName: 'held_in', role: 'hold' }];
    const sampleBudget = 2 * HOLD_FRAME_PERIOD;
    const values = Array.from({ length: sampleBudget }, (_, step) =>
      step < HOLD_FRAME_PERIOD ? 1n : 2n,
    );
    const outcome = readNonVacuity(
      stimStdout(values),
      NONCE,
      holdOnlyInterface,
      holdOnlyRoles,
      sampleBudget,
    );

    expect(outcome.kind).toBe('read');
    if (outcome.kind !== 'read') return;
    expect(outcome.wholeHoldWindowCount).toBe(2);
    expect(outcome.strobePeriodsByPort).toEqual([]);
    const held = outcome.holdWindowsByPort.find((port) => port.portName === 'held_in');
    expect(held?.windows.map((window) => window.changeCount)).toEqual([0, 0]);
  });
});
