// Unit tests for the pure eval-gate run decision (task 19.5).
//
// These pin the Req 15.4 / 15.7 / 15.8 contract directly over `decideGateRun`:
// an unarmed gate never blocks (whether or not pass@k was measured); an armed gate
// runs the real ratcheting decision and blocks only on a genuine regression or a
// floor breach; a pass@k equal to the baseline never blocks; and an armed gate that
// cannot be measured fails safe by blocking rather than passing unverified.

import { describe, expect, it } from 'vitest';

import { makeArmedGate, UNARMED_GATE, type EvalGate } from '@app/core';

import { decideGateRun, type GateMeasurement } from './gate-run.js';
import type { BaselineProvenance, ParsedBaselineConfig } from './baseline-config.js';

const NO_PROVENANCE: BaselineProvenance = {
  measuredBy: null,
  measuredAt: null,
  host: null,
  commit: null,
  seed: null,
  sampleCount: null,
};

/** An unarmed parsed config, as the committed default resolves to. */
function unarmedConfig(): ParsedBaselineConfig {
  return { gate: UNARMED_GATE, k: 1, tolerance: 0.05, notes: '', provenance: NO_PROVENANCE };
}

/** An armed parsed config with the given thresholds (built through the core constructor). */
function armedConfig(baseline: number, tolerance: number, floor: number): ParsedBaselineConfig {
  const gate = makeArmedGate({ baseline, tolerance, floor });
  if (!gate.ok) {
    throw new Error(`test armed gate invalid: ${gate.error.message}`);
  }
  const armed: EvalGate = gate.value;
  return {
    gate: armed,
    k: 1,
    tolerance,
    notes: '',
    provenance: { ...NO_PROVENANCE, measuredBy: 'test', measuredAt: '2025-01-01T00:00:00Z' },
  };
}

const measured = (passAtK: number, k = 1): GateMeasurement => ({ status: 'measured', k, passAtK });
const unavailable = (reason: string): GateMeasurement => ({ status: 'unavailable', reason });

describe('decideGateRun - unarmed gate never blocks (Req 15.7)', () => {
  it('allows and reports the measured pass@k when one exists', () => {
    const result = decideGateRun(unarmedConfig(), measured(0.42));
    expect(result.exitCode).toBe(0);
    expect(result.blocked).toBe(false);
    expect(result.lines.join('\n')).toContain('42.00%');
    expect(result.lines.join('\n')).toContain('UNARMED');
  });

  it('allows and reports the reason when pass@k could not be measured', () => {
    const result = decideGateRun(unarmedConfig(), unavailable('toolchain absent'));
    expect(result.exitCode).toBe(0);
    expect(result.blocked).toBe(false);
    expect(result.lines.join('\n')).toContain('toolchain absent');
  });
});

describe('decideGateRun - armed gate ratcheting decision (Req 15.4, 15.8)', () => {
  const config = armedConfig(0.6, 0.05, 0.1);

  it('allows a pass@k equal to the baseline (never blocks at baseline)', () => {
    const result = decideGateRun(config, measured(0.6));
    expect(result.blocked).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it('allows a pass@k within tolerance below the baseline', () => {
    const result = decideGateRun(config, measured(0.56));
    expect(result.blocked).toBe(false);
  });

  it('blocks a pass@k strictly below baseline minus tolerance', () => {
    const result = decideGateRun(config, measured(0.54));
    expect(result.blocked).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('BLOCKING');
  });

  it('blocks a pass@k at or below the absolute floor regardless of baseline', () => {
    const result = decideGateRun(config, measured(0.1));
    expect(result.blocked).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it('blocks a catastrophic zero pass@k', () => {
    const result = decideGateRun(config, measured(0));
    expect(result.blocked).toBe(true);
  });
});

describe('decideGateRun - armed gate fails safe (honesty)', () => {
  it('blocks when an armed gate cannot measure pass@k', () => {
    const result = decideGateRun(armedConfig(0.6, 0.05, 0.1), unavailable('oracle missing'));
    expect(result.blocked).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('oracle missing');
  });

  it('blocks when an armed gate is handed an invalid (NaN) measurement', () => {
    const result = decideGateRun(armedConfig(0.6, 0.05, 0.1), measured(Number.NaN));
    expect(result.blocked).toBe(true);
    expect(result.exitCode).toBe(1);
  });
});
