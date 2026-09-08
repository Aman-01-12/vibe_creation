// Unit tests for the pass@k measurement seam (task 19.5).
//
// `measureViaHarness` is the real measurement path an armed gate uses; it is
// exercised here with a deterministic FAKE loop runner (no provider SDK, no real
// oracle) so the "measure pass@k from oracle-decided outcomes" path is covered.
// The default provider is asserted to be honest: with no real oracle wired it
// always returns `unavailable`, never a fabricated number.

import { describe, expect, it } from 'vitest';

import type { VerificationOutcome } from '@app/agent';
import type { ResourceLimits } from '@app/tools';

import { makeReproducibilityConfig, type ReproducibilityConfig } from '../reproducibility.js';
import { FIXED_EVAL_SUBSET } from '../subset.js';
import type { EvalHarnessDeps } from '../harness.js';
import type { EvalLoopRunner, EvalSampleRequest, StudentSessionCaps } from '../loop-runner.js';
import { createDefaultMeasurementProvider, measureViaHarness } from './measure.js';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5000 };

const CAPS: StudentSessionCaps = {
  maxIterations: 20,
  maxTokens: 1_000_000,
  maxWallClockMs: 1_000_000,
  maxCostCents: 1_000_000,
};

function config(): ReproducibilityConfig {
  const built = makeReproducibilityConfig({ seed: 42, temperature: 0, sampleCount: 4 });
  if (!built.ok) throw new Error(built.error.message);
  return built.value;
}

/** A loop runner whose every sample passes (or fails) deterministically. */
class ConstantLoopRunner implements EvalLoopRunner {
  readonly #passed: boolean;
  constructor(passed: boolean) {
    this.#passed = passed;
  }
  runSample(request: EvalSampleRequest): Promise<VerificationOutcome> {
    request.budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve({
      status: this.#passed ? 'verified' : 'unverified',
      iterations: 1,
    } as unknown as VerificationOutcome);
  }
}

function deps(loopRunner: EvalLoopRunner): EvalHarnessDeps {
  return {
    loopRunner,
    caps: CAPS,
    limits: LIMITS,
    config: config(),
    costEnvelopeCents: 5,
    ks: [1],
  };
}

describe('measureViaHarness', () => {
  it('reports pass@1 = 1 when every sample passes the oracle', async () => {
    const measurement = await measureViaHarness(
      deps(new ConstantLoopRunner(true)),
      FIXED_EVAL_SUBSET,
      1,
    );
    expect(measurement.status).toBe('measured');
    if (measurement.status !== 'measured') return;
    expect(measurement.passAtK).toBe(1);
    expect(measurement.k).toBe(1);
  });

  it('reports pass@1 = 0 when no sample passes the oracle', async () => {
    const measurement = await measureViaHarness(
      deps(new ConstantLoopRunner(false)),
      FIXED_EVAL_SUBSET,
      1,
    );
    expect(measurement.status).toBe('measured');
    if (measurement.status !== 'measured') return;
    expect(measurement.passAtK).toBe(0);
  });

  it('reports unavailable when the harness config is invalid', async () => {
    const bad = { ...deps(new ConstantLoopRunner(true)), costEnvelopeCents: -1 };
    const measurement = await measureViaHarness(bad, FIXED_EVAL_SUBSET, 1);
    expect(measurement.status).toBe('unavailable');
  });
});

describe('createDefaultMeasurementProvider', () => {
  it('never fabricates a pass@k - returns unavailable with no real oracle wired', async () => {
    const measurement = await createDefaultMeasurementProvider().measure(1);
    expect(measurement.status).toBe('unavailable');
    if (measurement.status !== 'unavailable') return;
    expect(measurement.reason).toContain('pass@1');
  });
});
