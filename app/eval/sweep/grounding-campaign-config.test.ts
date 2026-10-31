// The committed Confirmatory Grounding Campaign config (grounding-adoption-confirmatory, C7):
// its slot count, its pair order, and that every field not under test was copied from the
// Reference_Campaign.
//
// The copied fields matter as much as the new ones: a Campaign that changed a cap or a price
// while changing the prompt would not isolate the prompt.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CREDENTIAL_FILE } from '@app/agent';
import { describe, expect, it } from 'vitest';

import { parseSweepConfig } from './config-parse.js';
import { DEFAULT_NEGATIVE_CONTROL_CONFIG, PRE_REGISTERED_GROUNDING_POWER } from './config.js';
import { PRE_REGISTERED_GROUNDING_CRITERION } from './grounding-criterion.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The four models the Reference_Campaign showed can return a parseable testbench at all. */
const MODEL_ARMS = ['moonshotai.kimi-k2.5', 'zai.glm-5', 'zai.glm-4.7', 'deepseek.v3.2'] as const;

/** Every field the Campaign must carry over from the Reference_Campaign unchanged. */
const COPIED_FIELDS = [
  'schemaVersion',
  'problems',
  'ks',
  'seed',
  'temperature',
  'caps',
  'limits',
  'costEnvelopeCents',
  'modelHost',
  'captureArtifacts',
  'concurrency',
  'transportRetry',
] as const;

async function json(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(HERE, name), 'utf8')) as Record<string, unknown>;
}

const config = (): Promise<Record<string, unknown>> =>
  json('sweep.config.grounding-confirmatory-v1.json');
const reference = (): Promise<Record<string, unknown>> =>
  json('sweep.config.scoreboard-ab-v1.json');

describe('sweep.config.grounding-confirmatory-v1.json', () => {
  it('parses, and declares 8 arms in Slot_Pair order', async () => {
    const parsed = parseSweepConfig(await config());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.arms.map((arm) => arm.name)).toEqual(
      MODEL_ARMS.flatMap((model) => [`${model}.control`, `${model}.grounded`]),
    );
    expect(parsed.value.arms.map((arm) => arm.strategy)).toEqual(
      MODEL_ARMS.flatMap(() => ['control', 'grounded']),
    );
  });

  it('is 1064 slots and 532 Slot_Pairs: 4 Model_Arms x 2 arms x 19 designs x 7 samples', async () => {
    const parsed = parseSweepConfig(await config());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const { arms, problems, reproducibility } = parsed.value;
    expect(problems.kind === 'ids' ? problems.ids.length : 0).toBe(19);
    expect(reproducibility.sampleCount).toBe(7);
    expect(arms.length * 19 * reproducibility.sampleCount).toBe(1064);
    // Each slot is half a pair, and the pair count is what every primary clause is decided on.
    expect((arms.length / 2) * 19 * reproducibility.sampleCount).toBe(
      PRE_REGISTERED_GROUNDING_POWER.slotPairs,
    );
    // The kill switch leaves room for two resumes of the deferred tail, and no more.
    expect(parsed.value.killSwitch.maxSamples).toBe(1183);
    expect(parsed.value.killSwitch.maxWallClockMs).toBe(46_429_092);
  });

  it('declares one negativeControl and one limits block, shared by both Strategy_Arms', async () => {
    const campaign = await config();
    const parsed = parseSweepConfig(campaign);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    // One block at the top level and none per arm: the mutation probe and the sandbox bounds
    // must be identical across the two arms, or a validity difference could be theirs.
    expect(campaign.limits).toEqual({ cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30000 });
    expect(parsed.value.negativeControl).toEqual(DEFAULT_NEGATIVE_CONTROL_CONFIG);
    for (const arm of parsed.value.arms) {
      expect(Object.keys(arm)).not.toContain('limits');
      expect(Object.keys(arm)).not.toContain('negativeControl');
    }
  });

  it('runs the prompt-version and RTL-isolation pins before the sweep CLI', async () => {
    const manifest = JSON.parse(await readFile(resolve(HERE, '../../../package.json'), 'utf8')) as {
      readonly scripts: Record<string, string>;
    };
    const script = manifest.scripts['eval:grounding-confirmatory'] ?? '';

    // A wrong prompt version or a broken RTL isolation must exit before any paid dispatch.
    expect(script).toContain('prompt-version.test.ts');
    expect(script).toContain('testbench-rtl-isolation.property.test.ts');
    expect(script.indexOf('prompt-version.test.ts')).toBeLessThan(script.indexOf('cli.js'));
    expect(script).toContain('sweep.config.grounding-confirmatory-v1.json');
    expect(manifest.scripts['eval:grounding-ab']).toBeUndefined();
  });

  it('copies every non-prompt field from the Reference_Campaign verbatim', async () => {
    const campaign = await config();
    const baseline = await reference();

    for (const field of COPIED_FIELDS) {
      expect({ field, value: campaign[field] }).toEqual({ field, value: baseline[field] });
    }
    // The run and output names are the two that MUST differ, so the runs cannot collide.
    expect(campaign.runName).toBe('grounding-confirmatory-v1');
    expect(campaign.outputDir).toBe('.eval-runs/grounding-confirmatory-v1');
    expect(campaign.runName).not.toBe(baseline.runName);
  });

  it('carries the Reference_Campaign prices verbatim, which means none at all', async () => {
    const campaign = await config();
    const baseline = await reference();

    // MEASURED, not chosen: the Reference_Campaign declares an empty price table, so every one
    // of its samples recorded `costKnown: false`. Copying it keeps the two runs comparable on
    // cost accounting; pricing this Campaign alone would make its cost figures incomparable.
    expect(baseline.prices).toEqual({});
    expect(campaign.prices).toEqual(baseline.prices);
  });

  it('records the pre-registered criterion, power arithmetic, and Reference_Campaign', async () => {
    const parsed = parseSweepConfig(await config());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.groundingCampaign === undefined) {
      return;
    }
    const block = parsed.value.groundingCampaign;
    expect(block.successCriterion).toEqual(PRE_REGISTERED_GROUNDING_CRITERION);
    expect(block.powerArithmetic).toEqual(PRE_REGISTERED_GROUNDING_POWER);
    expect(block.referenceCampaign).toEqual({
      resultsPath: '.eval-runs/scoreboard-ab-v1/results.jsonl',
      configHash: '09bf541fcae9dbb9',
      schemaVersion: 15,
    });
    expect(block.replayGateReportPath).toBe(
      '.eval-runs/grounding-confirmatory-v1/replay-gate.json',
    );
  });

  it('reads its credential from the one gitignored file, with no fallback', async () => {
    const campaign = await config();

    // The config names no credential at all: the loader has exactly one source.
    expect(JSON.stringify(campaign)).not.toContain('credential');
    expect(JSON.stringify(campaign)).not.toContain('apiKey');
    expect(DEFAULT_CREDENTIAL_FILE).toBe('.secrets/bedrock-token');
    // Whether that file is present on this machine is developer-local state, not a property of
    // the config; `credential-file-ignored.test.ts` owns the exclusion of the path itself.
  });
});

const PROPERTY_10 =
  'Feature: grounding-adoption-confirmatory, Property 10: Every expected denominator is its observed counterpart scaled by the Sample_Count ratio';

describe(PROPERTY_10, () => {
  it('scales every observed figure by 7/5, rounded, and nothing else', () => {
    const power = PRE_REGISTERED_GROUNDING_POWER;
    // The ratio is the Sample_Count ratio, which is also exactly the Slot_Pair ratio.
    const ratio = PRE_REGISTERED_GROUNDING_CRITERION.sampleCount / 5;
    expect(power.slotPairs / power.exploratorySlotPairs).toBeCloseTo(ratio, 10);

    const scaled: readonly [number, number][] = [
      [power.exploratorySlotPairs, power.slotPairs],
      [power.exploratoryGroundedOnlyValid, power.expectedGroundedOnlyValid],
      [power.exploratoryControlOnlyValid, power.expectedControlOnlyValid],
      [power.exploratoryJudgedControl, power.expectedJudgedControl],
      [power.exploratoryJudgedGrounded, power.expectedJudgedGrounded],
      [power.exploratoryCoverageGapSurvivorsControl, power.expectedCoverageGapSurvivorsControl],
      [power.exploratoryCoverageGapSurvivorsGrounded, power.expectedCoverageGapSurvivorsGrounded],
      [power.exploratoryScoredMutantsControl, power.expectedScoredMutantsControl],
      [power.exploratoryScoredMutantsGrounded, power.expectedScoredMutantsGrounded],
    ];
    for (const [observed, expected] of scaled) {
      expect({ observed, expected }).toEqual({ observed, expected: Math.round(observed * ratio) });
    }
  });

  it('keeps the discordant total equal to the sum of its two halves', () => {
    const power = PRE_REGISTERED_GROUNDING_POWER;

    expect(power.expectedDiscordantPairs).toBe(
      power.expectedGroundedOnlyValid + power.expectedControlOnlyValid,
    );
    // The one field that is not multiplication: the exact McNemar threshold at 110 pairs.
    expect(power.minGroundedOnlyToHold).toBeGreaterThan(power.expectedDiscordantPairs / 2);
    expect(power.minGroundedOnlyToHold).toBeLessThan(power.expectedGroundedOnlyValid);
  });

  it('expects both Judged_Sample counts to clear the Minimum_Guard_Denominator', () => {
    const floor = PRE_REGISTERED_GROUNDING_CRITERION.minGuardDenominator;

    // This is the whole reason the Sample_Count moved: at 5, the Exploratory_Run's Control_Arm
    // was judged 58 times and its per-Model_Arm cells far less.
    expect(PRE_REGISTERED_GROUNDING_POWER.expectedJudgedControl).toBeGreaterThan(floor);
    expect(PRE_REGISTERED_GROUNDING_POWER.expectedJudgedGrounded).toBeGreaterThan(floor);
  });
});
