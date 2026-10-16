// Feature: testbench-in-order-scoreboard, Property 12: Arm identity separation.
//
// An arm's strategy and the Campaign's Success_Criterion are identity-bearing, and a config
// declaring neither canonicalizes byte-for-byte as before the Campaign existed.
// Validates: Requirements 7.1, 10.3.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FORMAL_ORACLE_VERSION,
  INSTRUMENT_POLICY_VERSION,
  NORMALIZER_VERSION,
  STRATEGY_ARMS,
  TESTBENCH_PROMPT_VERSION,
  TESTBENCH_REPAIR_POLICY_VERSION,
} from '@app/agent';
import { MANIFEST_SCHEMA_VERSION } from './manifest.js';
import { RESULTS_SCHEMA_VERSION } from './results-log.js';
import { SIMULATION_HARNESS_VERSION } from '@app/tools';

import { PRE_REGISTERED_GROUNDING_POWER } from './config.js';
import { PRE_REGISTERED_GROUNDING_CRITERION } from './grounding-criterion.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { SweepConfig } from './config.js';
import { canonicalSweepConfigJson, sweepConfigHash } from './config-identity.js';
import { parseSweepConfig } from './config-parse.js';
import { PRE_REGISTERED_SUCCESS_CRITERION } from './success-criterion.js';

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');
const HERE = dirname(fileURLToPath(import.meta.url));

const IDS = ['accu', 'adder_8bit'];

function rawConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runName: 'identity-anchor',
    arms: [{ name: 'only', model: 'model.a' }],
    problems: { kind: 'ids', ids: IDS },
    sampleCount: 1,
    ks: [1],
    seed: 7,
    temperature: 0,
    caps: { maxIterations: 4, maxTokens: 1_000, maxWallClockMs: 60_000, maxCostCents: 10 },
    limits: { cpu: 1, memMb: 512, procs: 64, diskMb: 64, wallMs: 30_000 },
    costEnvelopeCents: 1,
    modelHost: { region: 'us-east-1' },
    outputDir: '.eval-runs/identity-anchor',
    negativeControl: { enabled: false },
    ...overrides,
  };
}

function parsed(raw: Record<string, unknown>): SweepConfig {
  const result = parseSweepConfig(raw);
  if (!result.ok) {
    throw new Error(`fixture config is invalid: ${result.error.message}`);
  }
  return result.value;
}

const CAMPAIGN = {
  designGroups: { accu: 'streaming', adder_8bit: 'cycle-exact' },
  streamingSupplement: ['accu'],
  successCriterion: PRE_REGISTERED_SUCCESS_CRITERION,
  baseline: { resultsPath: '.eval-runs/base/results.jsonl', configHash: '0123456789abcdef' },
  maxResumes: 2,
};

/**
 * The canonical text of `rawConfig()` before the Campaign existed. Build constants are
 * re-folded from their imports, so a later version bump does not move this anchor.
 */
function anchor(): string {
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
    '"outputDir":".eval-runs/identity-anchor","prices":{},' +
    '"problems":{"ids":["accu","adder_8bit"],"kind":"ids"},' +
    '"reproducibility":{"sampleCount":1,"seed":7,"temperature":0},' +
    '"runName":"identity-anchor","schemaVersion":1,' +
    '"transportRetry":{"baseDelayMs":1000,"breakerCooldownMs":60000,"breakerFailureThreshold":8,"breakerMaxTrips":3,"jitterRatio":0.5,"maxAttempts":4,"maxDelayMs":30000}}'
  );
}

describe('Property 12: arm identity separation', () => {
  it('a config with no strategy and no Campaign block canonicalizes exactly as before', () => {
    expect(canonicalSweepConfigJson(parsed(rawConfig()))).toBe(anchor());
  });

  it('toggling one arm strategy changes the config hash', () => {
    fc.assert(
      fc.property(fc.constantFrom(...STRATEGY_ARMS), (strategy) => {
        const without = parsed(rawConfig());
        const withStrategy = parsed(
          rawConfig({ arms: [{ name: 'only', model: 'model.a', strategy }] }),
        );
        const other = strategy === 'control' ? 'treatment' : 'control';
        const flipped = parsed(
          rawConfig({ arms: [{ name: 'only', model: 'model.a', strategy: other }] }),
        );
        const hashes = new Set(
          [without, withStrategy, flipped].map((c) => sweepConfigHash(c, sha256Hex)),
        );
        expect(hashes.size).toBe(3);
      }),
    );
  });

  it('every Success_Criterion value is identity-bearing', () => {
    const base = parsed(rawConfig({ scoreboardCampaign: CAMPAIGN }));
    const baseHash = sweepConfigHash(base, sha256Hex);
    for (const key of Object.keys(PRE_REGISTERED_SUCCESS_CRITERION)) {
      // The parser accepts only the pre-registered values, so the criterion is varied after parsing.
      const criterion = { ...base.scoreboardCampaign?.successCriterion, [key]: 'moved' };
      const moved = {
        ...base,
        scoreboardCampaign: { ...CAMPAIGN, successCriterion: criterion },
      } as unknown as SweepConfig;
      expect(sweepConfigHash(moved, sha256Hex)).not.toBe(baseHash);
    }
    expect(baseHash).not.toBe(sweepConfigHash(parsed(rawConfig()), sha256Hex));
  });
});

describe('Property 15: identity separates arms, harness versions, and criteria', () => {
  // Feature: testbench-spec-grounding, Property 15: Identity separates arms, harness versions,
  // and criteria. Validates: Requirements 9.3, 12.3.

  /** The Grounding block, with the pre-registered values the parser is the owner of. */
  const GROUNDING_BLOCK = {
    successCriterion: PRE_REGISTERED_GROUNDING_CRITERION,
    powerArithmetic: PRE_REGISTERED_GROUNDING_POWER,
    referenceCampaign: {
      resultsPath: '.eval-runs/scoreboard-ab-v1/results.jsonl',
      configHash: '09bf541fcae9dbb9',
      schemaVersion: 15,
    },
    replayGateReportPath: '.eval-runs/grounding-confirmatory-v1/replay-gate.json',
    maxResumes: 2,
  } as const;

  it('separates the three Strategy_Arms from each other', () => {
    const hashOf = (strategy: string): string =>
      sweepConfigHash(
        parsed(rawConfig({ arms: [{ name: 'only', model: 'model.a', strategy }] })),
        sha256Hex,
      );
    const hashes = new Set([...STRATEGY_ARMS].map(hashOf));

    expect(hashes.size).toBe(STRATEGY_ARMS.length);
    expect(hashes.has(sweepConfigHash(parsed(rawConfig()), sha256Hex))).toBe(false);
  });

  it('separates two builds whose SIMULATION_HARNESS_VERSION differs', () => {
    // RE-FOLDED THROUGH THE INJECTED DIGEST, never by mutating the imported constant: the
    // build constant is compiled into `dist`, so a test that reassigned it would be testing
    // its own copy (vault note: a build-constant bump is invisible to vitest until `tsc -b`).
    const config = parsed(rawConfig());
    const asBuilt = sweepConfigHash(config, sha256Hex);
    const asAnotherHarness = sweepConfigHash(config, (text) =>
      sha256Hex(
        text.replace(
          `"__simulationHarnessVersion":${SIMULATION_HARNESS_VERSION}`,
          '"__simulationHarnessVersion":99',
        ),
      ),
    );

    expect(asAnotherHarness).not.toBe(asBuilt);
  });

  it('makes every Grounding Success_Criterion value identity-bearing', () => {
    const base = parsed(rawConfig());
    const withBlock = {
      ...base,
      groundingCampaign: GROUNDING_BLOCK,
    } as unknown as SweepConfig;
    const blockHash = sweepConfigHash(withBlock, sha256Hex);

    expect(blockHash).not.toBe(sweepConfigHash(base, sha256Hex));
    for (const key of Object.keys(PRE_REGISTERED_GROUNDING_CRITERION)) {
      // Varied AFTER parsing, because the parser accepts only the pre-registered values.
      const moved = {
        ...withBlock,
        groundingCampaign: {
          ...GROUNDING_BLOCK,
          successCriterion: { ...GROUNDING_BLOCK.successCriterion, [key]: 'moved' },
        },
      } as unknown as SweepConfig;
      expect(sweepConfigHash(moved, sha256Hex)).not.toBe(blockHash);
    }
  });
});

describe('the Confirmatory Campaign identity (grounding-adoption-confirmatory, C9)', () => {
  it('differs from the Exploratory_Run, so neither can resume into the other', async () => {
    const raw = JSON.parse(
      await readFile(resolve(HERE, 'sweep.config.grounding-confirmatory-v1.json'), 'utf8'),
    ) as Record<string, unknown>;
    const parsed = parseSweepConfig(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const hash = sweepConfigHash(parsed.value, sha256Hex);

    // testbench-failure-reportability (task 9.1) moved both reserved version keys:
    // `__testbenchPromptVersion` to 7 and `__simulationHarnessVersion` to 3. The grounding
    // block itself is byte-unchanged, but a build constant folds in unconditionally, so the
    // hash moves anyway (design.md, "Config_Identity").
    expect(hash).toBe('f040455fa4cbb1f7');
    // The hash before this spec's two version bumps reached the identity.
    expect(hash).not.toBe('b99ca404f510c828');
    expect(hash).not.toBe('773b798cf6bbe129');
  });

  it('keeps every version pin this spec does not move', () => {
    // testbench-failure-reportability moved TESTBENCH_PROMPT_VERSION to 7 (the Check_Report_Rule)
    // and SIMULATION_HARNESS_VERSION to 3 (the ece_check task); the Confirmatory config's hash
    // moves with them even though its own grounding block is byte-unchanged.
    expect(TESTBENCH_PROMPT_VERSION).toBe(7);
    // testbench-failure-reportability moved the schema to 17 with one new field; no hash reads it.
    expect(RESULTS_SCHEMA_VERSION).toBe(17);
    expect(MANIFEST_SCHEMA_VERSION).toBe(3);
    expect(SIMULATION_HARNESS_VERSION).toBe(3);
    expect(NORMALIZER_VERSION).toBe(5);
    expect(INSTRUMENT_POLICY_VERSION).toBe(1);
    expect(PRE_REGISTERED_GROUNDING_POWER.exploratoryConfigHash).toBe('773b798cf6bbe129');
  });

  it('keeps the Reference_Campaign the Confirmatory config reads from', async () => {
    const raw = JSON.parse(
      await readFile(resolve(HERE, 'sweep.config.grounding-confirmatory-v1.json'), 'utf8'),
    ) as { readonly groundingCampaign: { readonly referenceCampaign: { configHash: string } } };

    expect(raw.groundingCampaign.referenceCampaign.configHash).toBe('09bf541fcae9dbb9');
  });
});
