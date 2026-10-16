// Feature: testbench-in-order-scoreboard, Property 16: Bad arm declarations refuse to start.
//
// A strategy outside the closed set, or two arms measuring the same (models, strategy) cell,
// must fail the config load naming the offending index; a failed load builds no runner, so
// zero slots dispatch. Validates: Requirements 7.11.

import { STRATEGY_ARMS } from '@app/agent';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseArms } from './config-arms.js';
import { parseSweepConfig } from './config-parse.js';

/** A minimal valid config whose arms the property replaces. */
function configWith(arms: readonly unknown[]): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runName: 'arms-property',
    arms,
    problems: { kind: 'all' },
    sampleCount: 1,
    ks: [1],
    seed: 1,
    temperature: 0,
    caps: { maxIterations: 4, maxTokens: 1_000, maxWallClockMs: 60_000, maxCostCents: 10 },
    limits: { cpu: 1, memMb: 512, procs: 64, diskMb: 64, wallMs: 30_000 },
    costEnvelopeCents: 1,
    modelHost: { region: 'us-east-1' },
    outputDir: '.eval-runs/arms-property',
  };
}

const MODELS = ['model.a', 'model.b', 'model.c'] as const;

/** Any JSON-ish value that is not a member of `STRATEGY_ARMS`, including near misses. */
const badStrategy = fc.oneof(
  fc.string().filter((text) => !(STRATEGY_ARMS as readonly string[]).includes(text)),
  fc.constantFrom('Control', 'TREATMENT', ' control', 'treatment '),
  fc.constant(['control']),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.record({ arm: fc.constant('control') }),
);

/** A list of valid arms with distinct names and (model, strategy) pairs. */
const validArms = fc
  .uniqueArray(fc.tuple(fc.constantFrom(...MODELS), fc.constantFrom(...STRATEGY_ARMS)), {
    minLength: 1,
    maxLength: 6,
    selector: ([model, strategy]) => `${model}|${strategy}`,
  })
  .map((pairs) =>
    pairs.map(([model, strategy], index) => ({ name: `arm-${index}`, model, strategy })),
  );

describe('Property 16: bad arm declarations refuse to start', () => {
  it('refuses a strategy outside the closed set, naming arms[i].strategy', () => {
    fc.assert(
      fc.property(validArms, badStrategy, fc.nat(), (arms, strategy, pick) => {
        const index = pick % arms.length;
        const bad = arms.map((arm, at) => (at === index ? { ...arm, strategy } : arm));

        const parsed = parseArms(bad);
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) {
          expect(parsed.error.code).toBe('ARM_STRATEGY_INVALID');
          expect(parsed.error.field).toBe(`arms[${index}].strategy`);
        }
        expect(parseSweepConfig(configWith(bad)).ok).toBe(false);
      }),
    );
  });

  it('refuses a repeated (models, strategy) pair, naming the second arm', () => {
    fc.assert(
      fc.property(validArms, fc.nat(), (arms, pick) => {
        const original = arms[pick % arms.length];
        if (original === undefined) {
          throw new Error('validArms is never empty');
        }
        const duplicate = { ...original, name: 'arm-duplicate' };
        const parsed = parseArms([...arms, duplicate]);

        expect(parsed.ok).toBe(false);
        if (!parsed.ok) {
          expect(parsed.error.code).toBe('ARM_STRATEGY_DUPLICATED');
          expect(parsed.error.field).toBe(`arms[${arms.length}]`);
        }
        expect(parseSweepConfig(configWith([...arms, duplicate])).ok).toBe(false);
      }),
    );
  });

  it('refuses a repeated (models, `grounded`) pair, naming the second arm', () => {
    // testbench-spec-grounding Req 9.1, 9.8: the third arm joins the closed set and the
    // duplication rule reaches it with no edit, which is what this states.
    expect([...STRATEGY_ARMS]).toContain('grounded');
    const grounded = { name: 'first-grounded', model: 'model.a', strategy: 'grounded' };
    const parsed = parseArms([
      { name: 'first-control', model: 'model.a', strategy: 'control' },
      grounded,
      { ...grounded, name: 'second-grounded' },
    ]);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('ARM_STRATEGY_DUPLICATED');
      expect(parsed.error.field).toBe('arms[2]');
    }
  });

  it('accepts distinct pairs and leaves an absent strategy off the parsed arm', () => {
    let sawGrounded = false;
    fc.assert(
      fc.property(validArms, (arms) => {
        const parsed = parseArms(arms);
        expect(parsed.ok).toBe(true);
        sawGrounded ||= arms.some((arm) => arm.strategy === 'grounded');
      }),
    );
    // Non-vacuity: the generator reached the third arm, so the rows above are not control-only.
    expect(sawGrounded).toBe(true);
    const plain = parseArms([{ name: 'plain', model: 'model.a' }]);
    expect(plain.ok && !('strategy' in (plain.value[0] ?? {}))).toBe(true);
  });

  it("keeps today's rules for strategy-free configs: two arms may share a model", () => {
    const parsed = parseArms([
      { name: 'first', model: 'model.a' },
      { name: 'second', model: 'model.a' },
    ]);
    expect(parsed.ok).toBe(true);
  });
});
