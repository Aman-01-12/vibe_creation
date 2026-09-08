// Unit tests for the baseline config parser (task 19.5).
//
// These cover the unarmed default, a fully valid armed config, and every
// validation failure - especially the HONESTY invariant that an armed config must
// carry provenance proving the baseline was measured by the real oracle. A final
// regression test parses the ACTUAL committed `eval-baseline.json` and asserts it
// is unarmed, so the shipped config can never silently drift into an armed
// (fabricated) state.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseBaselineConfig } from './baseline-config.js';

/** A minimal valid armed config object, overridable per test. */
function armedRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    armed: true,
    k: 1,
    baseline: 0.6,
    tolerance: 0.05,
    floor: 0.1,
    notes: 'measured',
    provenance: {
      measuredBy: 'iverilog 12.0 + vvp',
      measuredAt: '2025-01-01T00:00:00Z',
      host: 'ci-host',
      commit: 'abc123',
      seed: 42,
      sampleCount: 4,
    },
    ...overrides,
  };
}

describe('parseBaselineConfig - unarmed', () => {
  it('resolves an unarmed config to UNARMED_GATE, ignoring null thresholds', () => {
    const parsed = parseBaselineConfig({
      armed: false,
      k: 1,
      tolerance: 0.05,
      baseline: null,
      floor: null,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.gate.armed).toBe(false);
    expect(parsed.value.k).toBe(1);
    expect(parsed.value.tolerance).toBeCloseTo(0.05, 12);
  });
});

describe('parseBaselineConfig - armed (valid)', () => {
  it('resolves a valid armed config with provenance to an armed gate', () => {
    const parsed = parseBaselineConfig(armedRaw());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.gate.armed).toBe(true);
    if (!parsed.value.gate.armed) return;
    expect(parsed.value.gate.baseline).toBeCloseTo(0.6, 12);
    expect(parsed.value.gate.floor).toBeCloseTo(0.1, 12);
    expect(parsed.value.provenance.measuredBy).toBe('iverilog 12.0 + vvp');
  });
});

describe('parseBaselineConfig - validation failures', () => {
  it('rejects a non-object', () => {
    const parsed = parseBaselineConfig(42);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe('NOT_AN_OBJECT');
  });

  it('rejects a non-boolean armed flag', () => {
    const parsed = parseBaselineConfig({ armed: 'yes', k: 1, tolerance: 0 });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe('ARMED_NOT_BOOLEAN');
  });

  it('rejects a non-positive-integer k', () => {
    const parsed = parseBaselineConfig({ armed: false, k: 0, tolerance: 0 });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe('K_NOT_POSITIVE_INTEGER');
  });

  it('rejects a negative tolerance', () => {
    const parsed = parseBaselineConfig({ armed: false, k: 1, tolerance: -0.1 });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe('TOLERANCE_INVALID');
  });

  it('rejects an armed config with a null baseline', () => {
    const parsed = parseBaselineConfig(armedRaw({ baseline: null }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe('ARMED_BASELINE_NOT_NUMBER');
  });

  it('rejects an armed config whose floor is not below the baseline (via the core gate)', () => {
    const parsed = parseBaselineConfig(armedRaw({ floor: 0.6 }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe('ARMED_GATE_INVALID');
  });

  it('rejects arming without provenance proving a real-oracle measurement (honesty)', () => {
    const parsed = parseBaselineConfig(
      armedRaw({ provenance: { measuredBy: null, measuredAt: null } }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe('ARMED_PROVENANCE_MISSING');
  });
});

describe('the committed eval-baseline.json', () => {
  it('parses and is UNARMED (no fabricated baseline is shipped)', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const configPath = resolve(here, '..', 'eval-baseline.json');
    const raw: unknown = JSON.parse(await readFile(configPath, 'utf8'));
    const parsed = parseBaselineConfig(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.gate.armed).toBe(false);
  });
});
