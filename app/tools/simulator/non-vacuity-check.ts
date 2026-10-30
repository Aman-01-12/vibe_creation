// The Non_Vacuity_Check reader (C9; Req 4.11, 6.1, 7.1, 7.2, 7.3, 7.4, 7.5, 7.7, 7.8, 7.9): a pure
// function from a Non_Vacuity_Probe run's stdout to a report, with no simulator call of its own.
// The toolchain invocation that produces `stdout` belongs to the caller (tasks 8.8-8.11), so a
// reading stays replayable from retained stdout with nothing re-simulated.
//
// TWO EXCLUSION RULES, DELIBERATELY NOT UNIFIED
//
//   The hold reading excludes one PAIR of consecutive steps when either step of that pair is
//   reset-asserted (Req 4.11): a per-pair exclusion. The strobe reading excludes the WHOLE
//   period when it contains any reset-asserted step at all (Req 7.3): a per-period exclusion. A
//   shared "excluded steps" helper would blur this difference, so each reading applies its own
//   rule over the one shared `isResetAsserted` step predicate instead.
//
// THE INCOMPLETE ARM IS A UNION, NOT A NULLABLE FIELD
//
//   `NonVacuityOutcome` is `NonVacuityReport | { kind: 'incomplete'; reason }` (Req 7.8), the same
//   shape `reduceSignature` already uses for a truncated Consensus_Run, so a caller that forgets
//   to check `kind` cannot read a truncated run as a demonstrated hold.

import type { ModuleInterface } from '@app/core';

import {
  HOLD_FRAME_PERIOD,
  packedPortSlices,
  RESET_FRAME_PERIOD,
  STROBE_PERIOD,
  type InputRole,
  type RoleDeclaration,
} from './consensus-harness.js';
import { STIM_END_PREFIX, STIM_LINE_PREFIX } from './non-vacuity-probe.js';

/** One whole Hold_Window's change-count reading for one Held_Input port (Req 7.1, 7.2, 7.9). */
export interface HoldWindowReading {
  readonly windowIndex: number;
  readonly firstStep: number;
  /** Pairs of consecutive in-window steps whose driven value for this port differs. */
  readonly changeCount: number;
  readonly changeSteps: readonly number[];
}

/** One whole, reset-free Strobe_Period's assertion-count reading for one Strobe port (Req 7.3,
 * 7.4, 7.9). A period containing a reset-asserted step has no `StrobePeriodReading` at all. */
export interface StrobePeriodReading {
  readonly periodIndex: number;
  readonly assertedStepCount: number;
  readonly assertedSteps: readonly number[];
}

/** A complete reading of one Non_Vacuity_Probe run. */
export interface NonVacuityReport {
  readonly kind: 'read';
  readonly holdWindowsByPort: readonly {
    readonly portName: string;
    readonly windows: readonly HoldWindowReading[];
    readonly distinctHoldValueCount: number;
    readonly portWidth: number;
  }[];
  readonly strobePeriodsByPort: readonly {
    readonly portName: string;
    readonly periods: readonly StrobePeriodReading[];
  }[];
  readonly wholeHoldWindowCount: number;
  readonly resetFreeStrobePeriodCount: number;
  readonly strobePeriod: number;
  readonly holdFramePeriod: number;
  readonly demonstratesTransactionStructure: boolean;
}

/** Req 7.8: no change count, no assertion count, no Distinct_Hold_Value_Count on this arm. */
export interface IncompleteNonVacuityReading {
  readonly kind: 'incomplete';
  readonly reason: string;
}

export type NonVacuityOutcome = NonVacuityReport | IncompleteNonVacuityReading;

/** One kept `ECE_STIM` line: a step and its hex-encoded whole input bundle. */
interface StimLine {
  readonly step: number;
  readonly hex: string;
}

const HEX_VALUE_PATTERN = /^[0-9a-fA-F]+$/u;

/**
 * Parse one `ECE_STIM <nonce> <step> <hex>` line, or `null` when it is not a kept line for this
 * run. Tokenized by whitespace split rather than a regex built from `nonce`, the same way
 * `parseSampleLine` (`app/agent/consensus/signature.ts`) avoids needing to escape a nonce.
 */
function parseStimLine(line: string, nonce: string): StimLine | null {
  const tokens = line.trim().split(/\s+/u);
  const hex = tokens[3];
  if (
    tokens.length !== 4 ||
    tokens[0] !== STIM_LINE_PREFIX ||
    tokens[1] !== nonce ||
    hex === undefined
  ) {
    return null;
  }
  const step = Number(tokens[2]);
  if (!Number.isInteger(step) || step < 0 || !HEX_VALUE_PATTERN.test(hex)) {
    return null;
  }
  return { step, hex };
}

/** Parse one `ECE_STIM_END <nonce> <count>` line's count, or `null` when it is not a kept line. */
function parseStimEndLine(line: string, nonce: string): number | null {
  const tokens = line.trim().split(/\s+/u);
  if (tokens.length !== 3 || tokens[0] !== STIM_END_PREFIX || tokens[1] !== nonce) {
    return null;
  }
  const count = Number(tokens[2]);
  return Number.isInteger(count) && count >= 0 ? count : null;
}

/**
 * The first of Req 7.8's three causes that holds, checked in that order (absent, duplicated,
 * end-marker mismatch), or `null` for a complete reading.
 */
function incompleteReason(
  stepCounts: ReadonlyMap<number, number>,
  perStepLineCount: number,
  endMarkersSeen: number,
  declaredEndCount: number | null,
  sampleBudget: number,
): string | null {
  for (let step = 0; step < sampleBudget; step += 1) {
    if (!stepCounts.has(step)) {
      return `no ECE_STIM line for step ${String(step)}`;
    }
  }
  const stepsSeen = Array.from(stepCounts.keys()).sort((a, b) => a - b);
  for (const step of stepsSeen) {
    if ((stepCounts.get(step) ?? 0) > 1) {
      return `more than one ECE_STIM line for step ${String(step)}`;
    }
  }
  if (endMarkersSeen !== 1 || declaredEndCount !== perStepLineCount) {
    return 'ECE_STIM_END count does not match the number of ECE_STIM lines read';
  }
  return null;
}

/** `bundle`'s bits `[low, high]` - the one slice layout `packedPortSlices` already computed. */
function sliceValue(bundle: bigint, high: number, low: number): bigint {
  const mask = (1n << BigInt(high - low + 1)) - 1n;
  return (bundle >> BigInt(low)) & mask;
}

/**
 * Whether the Consensus_Harness asserts reset on `step` (Req 4.11): mirrors the
 * `(step % ECE_RESET_FRAME) == 0` check `renderConsensusHarness` renders, true only for a
 * Declared_Interface declaring both a clock and a reset - the other branch asserts none.
 */
function isResetAsserted(step: number, hasReset: boolean): boolean {
  return hasReset && step % RESET_FRAME_PERIOD === 0;
}

/** Whether any step of the period starting at `firstStep` is reset-asserted. */
function periodContainsReset(firstStep: number, period: number, hasReset: boolean): boolean {
  if (!hasReset) {
    return false;
  }
  for (let step = firstStep; step < firstStep + period; step += 1) {
    if (isResetAsserted(step, hasReset)) {
      return true;
    }
  }
  return false;
}

/**
 * One Held_Input port's per-whole-window change-count reading (Req 7.1, 7.2, 7.9, 4.11): the
 * count of consecutive in-window pairs whose value differs, with any pair either of whose steps
 * is reset-asserted excluded - a PAIR-LEVEL exclusion, not the strobe reading's period-level one.
 */
function holdWindowReadings(
  values: readonly bigint[],
  wholeWindowCount: number,
  period: number,
  hasReset: boolean,
): HoldWindowReading[] {
  const windows: HoldWindowReading[] = [];
  for (let windowIndex = 0; windowIndex < wholeWindowCount; windowIndex += 1) {
    const firstStep = windowIndex * period;
    const changeSteps: number[] = [];
    for (let step = firstStep; step < firstStep + period - 1; step += 1) {
      const nextStep = step + 1;
      if (isResetAsserted(step, hasReset) || isResetAsserted(nextStep, hasReset)) {
        continue;
      }
      if (values[step] !== values[nextStep]) {
        changeSteps.push(nextStep);
      }
    }
    windows.push({ windowIndex, firstStep, changeCount: changeSteps.length, changeSteps });
  }
  return windows;
}

/**
 * One Strobe port's per-whole-period assertion-count reading (Req 7.3, 7.4, 7.9): the count of
 * steps on which every bit of the Strobe is asserted, over periods containing NO reset-asserted
 * step at all - a WHOLE-PERIOD exclusion, dropping the period rather than one step of it.
 */
function strobePeriodReadings(
  values: readonly bigint[],
  wholeWindowCount: number,
  period: number,
  width: number,
  hasReset: boolean,
): StrobePeriodReading[] {
  const assertedValue = (1n << BigInt(width)) - 1n;
  const periods: StrobePeriodReading[] = [];
  for (let periodIndex = 0; periodIndex < wholeWindowCount; periodIndex += 1) {
    const firstStep = periodIndex * period;
    if (periodContainsReset(firstStep, period, hasReset)) {
      continue;
    }
    const assertedSteps: number[] = [];
    for (let step = firstStep; step < firstStep + period; step += 1) {
      if (values[step] === assertedValue) {
        assertedSteps.push(step);
      }
    }
    periods.push({ periodIndex, assertedStepCount: assertedSteps.length, assertedSteps });
  }
  return periods;
}

/** `roles`'s role for `portName`; mirrors `consensus-harness.ts`'s own unexported `roleOf`. */
function roleOf(roles: RoleDeclaration, portName: string): InputRole {
  return roles.find((entry) => entry.portName === portName)?.role ?? 'data';
}

/**
 * Read `stdout` for a step not already confirmed present by `incompleteReason`.
 *
 * Unreachable in practice: `readNonVacuity` only calls this after `incompleteReason` has
 * returned `null` for the same `stepHex`/`sampleBudget` pair, which is exactly when every step
 * in range is guaranteed present.
 */
function requireHex(stepHex: ReadonlyMap<number, string>, step: number): string {
  const hex = stepHex.get(step);
  if (hex === undefined) {
    throw new Error(`internal error: no retained ECE_STIM line for step ${String(step)}`);
  }
  return hex;
}

/** The raw tally one pass over `stdout` collects, before completeness is judged. */
interface StimLineTally {
  readonly stepHex: ReadonlyMap<number, string>;
  readonly stepCounts: ReadonlyMap<number, number>;
  readonly perStepLineCount: number;
  readonly endMarkersSeen: number;
  readonly declaredEndCount: number | null;
}

/** One pass over `stdout`, keeping only lines whose nonce matches. */
function tallyStimLines(stdout: string, nonce: string): StimLineTally {
  const stepHex = new Map<number, string>();
  const stepCounts = new Map<number, number>();
  let perStepLineCount = 0;
  let endMarkersSeen = 0;
  let declaredEndCount: number | null = null;

  for (const line of stdout.split(/\r?\n/u)) {
    const stim = parseStimLine(line, nonce);
    if (stim !== null) {
      perStepLineCount += 1;
      stepCounts.set(stim.step, (stepCounts.get(stim.step) ?? 0) + 1);
      if (!stepHex.has(stim.step)) {
        stepHex.set(stim.step, stim.hex);
      }
      continue;
    }
    const endCount = parseStimEndLine(line, nonce);
    if (endCount !== null) {
      endMarkersSeen += 1;
      declaredEndCount = endCount;
    }
  }

  return { stepHex, stepCounts, perStepLineCount, endMarkersSeen, declaredEndCount };
}

/** Decode steps `0` through `sampleBudget - 1` into the whole input bundle at each step. */
function decodeStepValues(stepHex: ReadonlyMap<number, string>, sampleBudget: number): bigint[] {
  const stepValues: bigint[] = [];
  for (let step = 0; step < sampleBudget; step += 1) {
    stepValues.push(BigInt(`0x${requireHex(stepHex, step)}`));
  }
  return stepValues;
}

/** Build the complete `NonVacuityReport` from a fully decoded, complete reading. */
function buildReport(
  stepValues: readonly bigint[],
  moduleInterface: ModuleInterface,
  roles: RoleDeclaration,
  sampleBudget: number,
): NonVacuityReport {
  const inputPorts = moduleInterface.ports.filter((port) => port.direction === 'input');
  const portSlices = packedPortSlices(inputPorts).map((slice) => ({
    ...slice,
    role: roleOf(roles, slice.name),
  }));
  const holdPortSlices = portSlices.filter((slice) => slice.role === 'hold');
  const strobePortSlices = portSlices.filter((slice) => slice.role === 'strobe');
  // Req 4.2, 4.3, 4.7: one Transaction is one Hold_Window when a Strobe is declared too, which
  // is the same branch `renderStimulusFunction` takes to size its own `v_hold` cadence.
  const windowPeriod = strobePortSlices.length > 0 ? STROBE_PERIOD : HOLD_FRAME_PERIOD;
  const wholeWindowCount = Math.floor(sampleBudget / windowPeriod);
  const hasReset =
    moduleInterface.clocking.clockName !== null && moduleInterface.clocking.resetName !== null;
  const windowSpan = wholeWindowCount * windowPeriod;

  const holdWindowsByPort = holdPortSlices.map((slice) => {
    const values = stepValues.map((bundle) => sliceValue(bundle, slice.high, slice.low));
    return {
      portName: slice.name,
      windows: holdWindowReadings(values, wholeWindowCount, windowPeriod, hasReset),
      // Req 6.1, 7.7: counted over the same whole Hold_Windows the change-count reading covers.
      distinctHoldValueCount: new Set(values.slice(0, windowSpan)).size,
      portWidth: slice.high - slice.low + 1,
    };
  });

  const strobePeriodsByPort = strobePortSlices.map((slice) => {
    const values = stepValues.map((bundle) => sliceValue(bundle, slice.high, slice.low));
    const width = slice.high - slice.low + 1;
    return {
      portName: slice.name,
      periods: strobePeriodReadings(values, wholeWindowCount, windowPeriod, width, hasReset),
    };
  });

  let resetFreeStrobePeriodCount = 0;
  for (let index = 0; index < wholeWindowCount; index += 1) {
    if (!periodContainsReset(index * windowPeriod, windowPeriod, hasReset)) {
      resetFreeStrobePeriodCount += 1;
    }
  }

  // Req 7.2, 7.4, 7.9: a hold demonstrated only when every read window/period came back clean.
  const demonstratesTransactionStructure =
    holdWindowsByPort.every((port) => port.windows.every((window) => window.changeCount === 0)) &&
    strobePeriodsByPort.every((port) =>
      port.periods.every((period) => period.assertedStepCount === 1),
    );

  return {
    kind: 'read',
    holdWindowsByPort,
    strobePeriodsByPort,
    wholeHoldWindowCount: wholeWindowCount,
    resetFreeStrobePeriodCount,
    strobePeriod: STROBE_PERIOD,
    holdFramePeriod: HOLD_FRAME_PERIOD,
    demonstratesTransactionStructure,
  };
}

/**
 * Read a Non_Vacuity_Probe run's `stdout` into a `NonVacuityOutcome` (C9; Req 4.11, 6.1, 7.1,
 * 7.2, 7.3, 7.4, 7.5, 7.7, 7.8, 7.9).
 *
 * Pure: no simulator call, no clock, no filesystem - every figure in the returned report is
 * derived from `stdout`, `moduleInterface`, `roles`, and `sampleBudget` alone, so two calls with
 * the same arguments produce the same reading.
 */
export function readNonVacuity(
  stdout: string,
  nonce: string,
  moduleInterface: ModuleInterface,
  roles: RoleDeclaration,
  sampleBudget: number,
): NonVacuityOutcome {
  const tally = tallyStimLines(stdout, nonce);
  const reason = incompleteReason(
    tally.stepCounts,
    tally.perStepLineCount,
    tally.endMarkersSeen,
    tally.declaredEndCount,
    sampleBudget,
  );
  if (reason !== null) {
    return { kind: 'incomplete', reason };
  }

  const stepValues = decodeStepValues(tally.stepHex, sampleBudget);
  return buildReport(stepValues, moduleInterface, roles, sampleBudget);
}
