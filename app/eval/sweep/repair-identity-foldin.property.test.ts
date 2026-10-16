// testbench-repair-loop, task 10.7, Property 9: The policy version changes the
// experiment identity.
//
// WHICH SEAM THIS DRIVES, AND WHY. `TESTBENCH_REPAIR_POLICY_VERSION`,
// `INSTRUMENT_POLICY_VERSION`, and `TESTBENCH_PROMPT_VERSION` are read DIRECTLY from their
// `@app/agent` imports inside `identityBearingFields` (config-identity.ts) - not taken as
// a parameter of `sweepConfigHash` or `canonicalSweepConfigJson` - by deliberate design
// (its own doc comment: "a manifest or a resume check can never pass a stale or fabricated
// version"). There is no live seam to reassign them at runtime, and fabricating one would
// contradict that design. So this file does the two things that ARE honestly testable
// against the real, unmodified functions:
//
//   1. Each constant's CURRENT value appears, verbatim, under its own reserved key in the
//      real canonical JSON `canonicalSweepConfigJson` produces - following the exact
//      pattern `config-identity.test.ts`'s own `anchor()` fixture already uses to pin the
//      whole canonical string. A key collision (two constants folded under the same key,
//      or a key typo) would be caught here because the literal substring for one
//      constant's key would then be missing or duplicated.
//   2. A STALE anchor string differing from the real one in exactly ONE constant's value
//      (holding the other two, and every other config field, fixed) hashes to something
//      DIFFERENT from the real `sweepConfigHash`. This is the honest form of "varying one
//      axis changes the hash while the others are held fixed": it varies the EXPECTED
//      value the real hash is compared against, rather than the constant itself, which is
//      the only variation available without editing source. A false positive here would
//      mean two of the twelve possible version substitutions a mutation could introduce
//      collide with the real hash - vanishingly unlikely for a cryptographic digest, and
//      exactly the failure mode this property exists to catch if it ever happened.
//
// Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5

import { createHash } from 'node:crypto';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  FORMAL_ORACLE_VERSION,
  INSTRUMENT_POLICY_VERSION,
  NORMALIZER_VERSION,
  TESTBENCH_PROMPT_VERSION,
  TESTBENCH_REPAIR_POLICY_VERSION,
} from '@app/agent';
import { SIMULATION_HARNESS_VERSION } from '@app/tools';

import { canonicalSweepConfigJson, sweepConfigHash } from './config-identity.js';
import type { SweepConfig } from './config.js';
import { parseSweepConfig } from './config-parse.js';

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

const PROPERTY =
  'testbench-repair-loop, Property 9: The policy version changes the experiment identity';

function rawConfig(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runName: 'repair-identity-anchor',
    arms: [{ name: 'only', model: 'model.a' }],
    problems: { kind: 'ids', ids: ['accu', 'adder_8bit'] },
    sampleCount: 1,
    ks: [1],
    seed: 7,
    temperature: 0,
    caps: { maxIterations: 4, maxTokens: 1_000, maxWallClockMs: 60_000, maxCostCents: 10 },
    limits: { cpu: 1, memMb: 512, procs: 64, diskMb: 64, wallMs: 30_000 },
    costEnvelopeCents: 1,
    modelHost: { region: 'us-east-1' },
    outputDir: '.eval-runs/repair-identity-anchor',
    negativeControl: { enabled: false },
  };
}

function parsedConfig(): SweepConfig {
  const result = parseSweepConfig(rawConfig());
  if (!result.ok) {
    throw new Error(`fixture config is invalid: ${result.error.message}`);
  }
  return result.value;
}

/**
 * The real canonical JSON's anchor string, with every version/boolean reserved key folded
 * in at the CURRENT constant values - the same shape `config-identity.test.ts`'s own
 * `anchor()` fixture pins, over this file's smaller config.
 */
function realAnchor(): string {
  return (
    '{"__formalGateEnabled":false,' +
    `"__formalOracleVersion":${FORMAL_ORACLE_VERSION},` +
    `"__instrumentPolicyVersion":${INSTRUMENT_POLICY_VERSION},` +
    `"__normalizerVersion":${NORMALIZER_VERSION},` +
    `"__simulationHarnessVersion":${SIMULATION_HARNESS_VERSION},` +
    `"__testbenchPromptVersion":${TESTBENCH_PROMPT_VERSION},` +
    `"__testbenchRepairPolicyVersion":${TESTBENCH_REPAIR_POLICY_VERSION},` +
    '"arms":[{"name":"only","roleModels":{"generation":"model.a","hard-planning":"model.a","orchestration":"model.a","repair":"model.a","teaching":"model.a","testbench":"model.a"}}],' +
    '"caps":{"maxCostCents":10,"maxIterations":4,"maxTokens":1000,"maxWallClockMs":60000},' +
    '"concurrency":2,"costEnvelopeCents":1,"formalGateEnabled":false,' +
    '"killSwitch":{"maxSamples":10000,"maxWallClockMs":28800000},"ks":[1],' +
    '"limits":{"cpu":1,"diskMb":64,"memMb":512,"procs":64,"wallMs":30000},' +
    '"modelHost":{"region":"us-east-1"},' +
    '"negativeControl":{"enabled":false,"maxMutantsPerProblem":24,"mutantWallMs":5000},' +
    '"outputDir":".eval-runs/repair-identity-anchor","prices":{},' +
    '"problems":{"ids":["accu","adder_8bit"],"kind":"ids"},' +
    '"reproducibility":{"sampleCount":1,"seed":7,"temperature":0},' +
    '"runName":"repair-identity-anchor","schemaVersion":1,' +
    '"transportRetry":{"baseDelayMs":1000,"breakerCooldownMs":60000,"breakerFailureThreshold":8,"breakerMaxTrips":3,"jitterRatio":0.5,"maxAttempts":4,"maxDelayMs":30000}}'
  );
}

/** The three fold-in keys this property is about, each with the real constant's value. */
const REAL_KEYS: Readonly<Record<string, number>> = {
  __testbenchRepairPolicyVersion: TESTBENCH_REPAIR_POLICY_VERSION,
  __instrumentPolicyVersion: INSTRUMENT_POLICY_VERSION,
  __testbenchPromptVersion: TESTBENCH_PROMPT_VERSION,
};

/** `realAnchor()` with exactly one of the three reserved keys' value replaced by a wrong one. */
function anchorWithWrongValue(key: keyof typeof REAL_KEYS, wrongValue: number): string {
  const real = REAL_KEYS[key];
  const needle = `"${key}":${real}`;
  const replacement = `"${key}":${wrongValue}`;
  const anchor = realAnchor();
  if (!anchor.includes(needle)) {
    throw new Error(`fixture drift: ${needle} not found in the real anchor string`);
  }
  return anchor.replace(needle, replacement);
}

describe(PROPERTY, () => {
  it('canonicalizes the real config byte-for-byte against the live constants', () => {
    expect(canonicalSweepConfigJson(parsedConfig())).toBe(realAnchor());
  });

  it('each reserved key carries exactly its own constant, under a key no other constant shares', () => {
    const canonical = canonicalSweepConfigJson(parsedConfig());
    for (const [key, value] of Object.entries(REAL_KEYS)) {
      expect(canonical).toContain(`"${key}":${value}`);
    }
    // No two of the three keys collide: three distinct substrings, three distinct keys.
    expect(new Set(Object.keys(REAL_KEYS)).size).toBe(3);
  });

  it('a stale anchor wrong in exactly one of the three version axes hashes differently from the real one', () => {
    const realHash = sweepConfigHash(parsedConfig(), sha256Hex);
    const seen = {
      testbenchRepairPolicyVersion: 0,
      instrumentPolicyVersion: 0,
      testbenchPromptVersion: 0,
    };

    fc.assert(
      fc.property(
        fc.constantFrom(
          '__testbenchRepairPolicyVersion',
          '__instrumentPolicyVersion',
          '__testbenchPromptVersion',
        ) as fc.Arbitrary<keyof typeof REAL_KEYS>,
        fc.integer({ min: 0, max: 999 }),
        (key, wrongValue) => {
          fc.pre(wrongValue !== REAL_KEYS[key]);
          if (key === '__testbenchRepairPolicyVersion') seen.testbenchRepairPolicyVersion += 1;
          else if (key === '__instrumentPolicyVersion') seen.instrumentPolicyVersion += 1;
          else seen.testbenchPromptVersion += 1;

          const staleAnchor = anchorWithWrongValue(key, wrongValue);
          const staleHash = sha256Hex(staleAnchor).slice(0, realHash.length);

          // Holding the OTHER two version axes and every other field fixed, changing
          // this one axis alone changes the hash: each axis is independently
          // load-bearing, not merely present as inert text.
          expect(staleHash).not.toBe(realHash);
        },
      ),
      { numRuns: 150 },
    );

    // Non-vacuity: all three axes - the repair policy version this spec adds, and the
    // two sibling constants it must not collide with - were actually exercised.
    expect(seen.testbenchRepairPolicyVersion).toBeGreaterThan(0);
    expect(seen.instrumentPolicyVersion).toBeGreaterThan(0);
    expect(seen.testbenchPromptVersion).toBeGreaterThan(0);
  });
});
