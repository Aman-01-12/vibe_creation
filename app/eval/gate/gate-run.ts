// The pure eval-gate run decision (task 19.5).
//
// Given the resolved gate configuration and a pass@k MEASUREMENT, this decides the
// CI outcome: which lines to print and whether to block the merge (exit non-zero).
// It is the honest bridge between the pure `decideEvalGate` rule (`@app/core`, task
// 19.1) and the real world where a measurement may be unavailable because the real
// oracle is absent.
//
// The contract (Req 15.4, 15.7, 15.8):
//   - UNARMED gate: NEVER blocks (exit 0). It prints the measured pass@k when a
//     measurement exists, or the reason it could not be measured otherwise. This is
//     the Req 15.7 bootstrapping guarantee - the other CI gates are the merge
//     authority while unarmed.
//   - ARMED gate + measurement: runs the REAL ratcheting decision `decideEvalGate`
//     and blocks (exit 1) iff that decision blocks.
//   - ARMED gate + NO measurement: fails safe and blocks (exit 1). An armed gate is
//     a promise that pass@k is being enforced; if it cannot be measured (e.g. the
//     oracle is missing on this host) we must not silently let a merge through, and
//     we must never fabricate a number to pass it.
//
// Pure and deterministic: no clock, no I/O, no process access. The CLI wraps this
// with file reading, measurement, printing, and the exit code.

import { decideEvalGate, makePassAtK, type EvalGate } from '@app/core';

import type { ParsedBaselineConfig } from './baseline-config.js';

/**
 * A pass@k measurement outcome handed to the gate decision.
 *
 * `measured` carries a real, oracle-decided pass@k for the reported `k`;
 * `unavailable` carries a sanitized reason it could not be measured (typically the
 * real EDA toolchain being absent). The gate treats these very differently
 * depending on whether it is armed.
 */
export type GateMeasurement =
  | { readonly status: 'measured'; readonly k: number; readonly passAtK: number }
  | { readonly status: 'unavailable'; readonly reason: string };

/** The outcome of a gate run: the exit code, whether it blocked, and report lines. */
export interface GateRunResult {
  /** 0 to allow the merge, 1 to block it. */
  readonly exitCode: 0 | 1;
  /** Whether the gate blocked the merge. */
  readonly blocked: boolean;
  /** Human-readable lines the CLI prints, in order. */
  readonly lines: readonly string[];
}

/** Format a pass@k probability as a percentage with two decimals. */
function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/** Allow the merge, carrying the report lines (exit 0). */
function allow(lines: readonly string[]): GateRunResult {
  return { exitCode: 0, blocked: false, lines };
}

/** Block the merge, carrying the report lines (exit 1). */
function block(lines: readonly string[]): GateRunResult {
  return { exitCode: 1, blocked: true, lines };
}

/** The report lines for an unarmed gate; it never blocks (Req 15.7). */
function unarmedLines(measurement: GateMeasurement): readonly string[] {
  const head = 'eval pass@k gate: UNARMED (no verified non-zero baseline recorded yet).';
  const authority =
    'While unarmed the lint/type/unit/property gates are the merge authority (Req 15.7); this gate never blocks.';
  const measured =
    measurement.status === 'measured'
      ? `measured pass@${measurement.k} = ${pct(measurement.passAtK)}`
      : `pass@k not measured: ${measurement.reason}`;
  return [head, measured, authority];
}

/** Decide an armed gate against a real measurement via the core ratcheting rule. */
function decideArmedMeasured(
  gate: Extract<EvalGate, { readonly armed: true }>,
  k: number,
  passAtKValue: number,
): GateRunResult {
  const measured = makePassAtK(passAtKValue);
  if (!measured.ok) {
    // A measurement provider must yield a probability in [0, 1]; a value outside
    // that range is a broken collaborator, so fail safe rather than mis-decide.
    return block([
      'eval pass@k gate: ARMED.',
      `measured pass@${k} is not a valid probability: ${measured.error.message}`,
      'blocking to avoid a mis-decision on an invalid measurement.',
    ]);
  }
  const decision = decideEvalGate(measured.value, gate);
  const summary =
    `eval pass@k gate: ARMED (baseline ${pct(gate.baseline)}, ` +
    `tolerance ${pct(gate.tolerance)}, floor ${pct(gate.floor)}).`;
  const observed = `measured pass@${k} = ${pct(passAtKValue)} -> ${decision.reason}`;
  if (decision.blocked) {
    return block([summary, observed, 'BLOCKING the merge (Req 15.4, 15.8).']);
  }
  return allow([summary, observed, 'within tolerance of the baseline; allowing the merge.']);
}

/**
 * Decide the CI eval-gate outcome from the resolved config and a measurement.
 *
 * See the module header for the full contract. This function is total and pure.
 */
export function decideGateRun(
  config: ParsedBaselineConfig,
  measurement: GateMeasurement,
): GateRunResult {
  if (!config.gate.armed) {
    return allow(unarmedLines(measurement));
  }
  if (measurement.status === 'unavailable') {
    return block([
      'eval pass@k gate: ARMED.',
      `pass@k could not be measured: ${measurement.reason}`,
      'an armed gate must run where the real oracle can measure pass@k; blocking rather than passing unverified.',
    ]);
  }
  return decideArmedMeasured(config.gate, measurement.k, measurement.passAtK);
}
