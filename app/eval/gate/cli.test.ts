// Unit tests for the runnable gate entry wiring (task 19.5).
//
// `runEvalGate` is exercised with an explicit config path and an injected
// measurement provider (no filesystem defaults, no real oracle). These assert the
// end-to-end wiring: the committed unarmed config never blocks regardless of the
// measurement, and a missing/broken config fails safe by blocking.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runEvalGate } from './cli.js';
import type { GateMeasurement } from './gate-run.js';
import type { GateMeasurementProvider } from './measure.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The committed, unarmed baseline config at the eval package root. */
const COMMITTED_CONFIG = resolve(HERE, '..', 'eval-baseline.json');

/** A provider that yields a fixed measurement without any oracle. */
function stubProvider(measurement: GateMeasurement): GateMeasurementProvider {
  return { measure: (): Promise<GateMeasurement> => Promise.resolve(measurement) };
}

describe('runEvalGate - committed unarmed config', () => {
  it('exits 0 (never blocks) when pass@k is unavailable, per the bootstrapping contract', async () => {
    const result = await runEvalGate({
      configPath: COMMITTED_CONFIG,
      measurementProvider: stubProvider({ status: 'unavailable', reason: 'no oracle here' }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.blocked).toBe(false);
    expect(result.lines.join('\n')).toContain('UNARMED');
  });

  it('exits 0 even when a low pass@k is measured, because the gate is unarmed', async () => {
    const result = await runEvalGate({
      configPath: COMMITTED_CONFIG,
      measurementProvider: stubProvider({ status: 'measured', k: 1, passAtK: 0 }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.blocked).toBe(false);
  });
});

describe('runEvalGate - configuration failure', () => {
  it('blocks (exit 1) when the config file cannot be read', async () => {
    const result = await runEvalGate({
      configPath: resolve(HERE, 'does-not-exist.json'),
      measurementProvider: stubProvider({ status: 'unavailable', reason: 'n/a' }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.blocked).toBe(true);
    expect(result.lines.join('\n')).toContain('configuration error');
  });
});
