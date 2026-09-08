// Unit tests for the reproducibility configuration and per-sample seed derivation
// (task 19.3, Req 15.10).

import { describe, expect, it } from 'vitest';

import {
  makeReproducibilityConfig,
  sampleSeed,
  type ReproducibilityConfig,
} from './reproducibility.js';

function config(overrides: Partial<ReproducibilityConfig> = {}): ReproducibilityConfig {
  const built = makeReproducibilityConfig({
    seed: 7,
    temperature: 0,
    sampleCount: 4,
    ...overrides,
  });
  if (!built.ok) {
    throw new Error(built.error.message);
  }
  return built.value;
}

describe('makeReproducibilityConfig', () => {
  it('accepts an in-range config', () => {
    const built = makeReproducibilityConfig({ seed: 0, temperature: 0.7, sampleCount: 1 });
    expect(built.ok).toBe(true);
  });

  it('rejects a non-integer or out-of-range seed', () => {
    expect(makeReproducibilityConfig({ seed: -1, temperature: 0, sampleCount: 1 }).ok).toBe(false);
    expect(makeReproducibilityConfig({ seed: 1.5, temperature: 0, sampleCount: 1 }).ok).toBe(false);
  });

  it('rejects a temperature outside [0, 2]', () => {
    expect(makeReproducibilityConfig({ seed: 0, temperature: -0.1, sampleCount: 1 }).ok).toBe(
      false,
    );
    expect(makeReproducibilityConfig({ seed: 0, temperature: 2.1, sampleCount: 1 }).ok).toBe(false);
  });

  it('rejects a non-positive or non-integer sample count', () => {
    expect(makeReproducibilityConfig({ seed: 0, temperature: 0, sampleCount: 0 }).ok).toBe(false);
    expect(makeReproducibilityConfig({ seed: 0, temperature: 0, sampleCount: 2.5 }).ok).toBe(false);
  });
});

describe('sampleSeed', () => {
  it('is deterministic for the same config, problem, and sample index', () => {
    const cfg = config();
    expect(sampleSeed(cfg, 'verilogeval/adder8', 0)).toBe(sampleSeed(cfg, 'verilogeval/adder8', 0));
  });

  it('differs across sample indices, problems, and base seeds', () => {
    const cfg = config();
    const s0 = sampleSeed(cfg, 'p', 0);
    const s1 = sampleSeed(cfg, 'p', 1);
    const otherProblem = sampleSeed(cfg, 'q', 0);
    const otherSeed = sampleSeed(config({ seed: 8 }), 'p', 0);
    expect(new Set([s0, s1, otherProblem, otherSeed]).size).toBe(4);
  });

  it('returns a non-negative 32-bit integer', () => {
    const seed = sampleSeed(config(), 'p', 3);
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThanOrEqual(0xffffffff);
  });
});
