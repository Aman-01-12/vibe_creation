// The `groundingCampaign` block's parser (testbench-spec-grounding, C15): every refusal names
// the field that caused it, and the committed Campaign config parses.
//
// Each refusal row is a hand edit to a PRE-REGISTERED value. That is what the rows are for: a
// Campaign whose rule was edited after the fact is a different experiment, so the parser is
// where the pre-registration is actually enforced.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { sweepConfigHash } from './config-identity.js';
import { parseSweepConfig } from './config-parse.js';
import type { GroundingSuccessCriterion } from './grounding-criterion.js';

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

const HERE = dirname(fileURLToPath(import.meta.url));

async function campaignConfig(): Promise<Record<string, unknown>> {
  const path = resolve(HERE, 'sweep.config.grounding-confirmatory-v1.json');
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

/** The committed config with `groundingCampaign` replaced by a hand-edited copy. */
async function withBlock(edit: (block: Record<string, unknown>) => void): Promise<unknown> {
  const config = await campaignConfig();
  const block = JSON.parse(JSON.stringify(config.groundingCampaign)) as Record<string, unknown>;
  edit(block);
  return { ...config, groundingCampaign: block };
}

/** Parse and return the refused field, or `null` when the config parsed. */
function refusedField(raw: unknown): string | null {
  const parsed = parseSweepConfig(raw);
  return parsed.ok ? null : parsed.error.field;
}

describe('parseGroundingCampaign', () => {
  it('parses the committed Campaign config', async () => {
    const parsed = parseSweepConfig(await campaignConfig());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.groundingCampaign?.maxResumes).toBe(2);
    expect(parsed.value.groundingCampaign?.successCriterion.sampleCount).toBe(7);
    expect(parsed.value.scoreboardCampaign).toBeUndefined();
  });

  it('refuses a hand edit to any pre-registered criterion value, naming the field', async () => {
    expect(
      refusedField(
        await withBlock((block) => {
          const criterion = block.successCriterion as Record<string, unknown>;
          criterion.minModelArmsGreater = 2;
        }),
      ),
    ).toBe('groundingCampaign.successCriterion.minModelArmsGreater');
    expect(
      refusedField(
        await withBlock((block) => {
          const criterion = block.successCriterion as Record<string, unknown>;
          criterion.tieCountsAsGreater = true;
        }),
      ),
    ).toBe('groundingCampaign.successCriterion.tieCountsAsGreater');
  });

  it('refuses a hand edit to the power arithmetic, naming the field', async () => {
    expect(
      refusedField(
        await withBlock((block) => {
          const power = block.powerArithmetic as Record<string, unknown>;
          power.slotsPerArm = 228;
        }),
      ),
    ).toBe('groundingCampaign.powerArithmetic.slotsPerArm');
  });

  it('refuses a Reference_Campaign that is not a v15 results file', async () => {
    expect(
      refusedField(
        await withBlock((block) => {
          const reference = block.referenceCampaign as Record<string, unknown>;
          reference.schemaVersion = 16;
        }),
      ),
    ).toBe('groundingCampaign.referenceCampaign.schemaVersion');
    expect(
      refusedField(
        await withBlock((block) => {
          const reference = block.referenceCampaign as Record<string, unknown>;
          reference.resultsPath = '  ';
        }),
      ),
    ).toBe('groundingCampaign.referenceCampaign');
  });

  it('refuses a third resume, an unknown field, and a missing gate report path', async () => {
    expect(refusedField(await withBlock((block) => (block.maxResumes = 3)))).toBe(
      'groundingCampaign.maxResumes',
    );
    expect(refusedField(await withBlock((block) => (block.extra = 1)))).toBe(
      'groundingCampaign.extra',
    );
    expect(refusedField(await withBlock((block) => (block.replayGateReportPath = '')))).toBe(
      'groundingCampaign.replayGateReportPath',
    );
  });

  it('refuses a Sample_Count or design count that disagrees with the criterion', async () => {
    const config = await campaignConfig();
    expect(refusedField({ ...config, sampleCount: 3 })).toBe('reproducibility.sampleCount');
    const problems = config.problems as { readonly ids: readonly string[] };
    expect(
      refusedField({ ...config, problems: { ...problems, ids: problems.ids.slice(0, 18) } }),
    ).toBe('problems.ids');
  });

  it('refuses an arms list that is not one control and one grounded arm per model', async () => {
    const config = await campaignConfig();
    const arms = config.arms as readonly Record<string, unknown>[];
    // Seven arms: one model lost its Grounded side, so that model yields no Slot_Pair.
    expect(refusedField({ ...config, arms: arms.slice(0, 7) })).toBe('arms');
    // Eight arms, but one pair is control+control. The existing (models, strategy) duplication
    // rule catches this before the shape rule and names the exact arm, which is more precise.
    const doubled = arms.map((arm, at) => (at === 1 ? { ...arm, strategy: 'control' } : arm));
    expect(refusedField({ ...config, arms: doubled })).toBe('arms[1]');
    // Eight arms over three models: the duplication rule refuses it before the shape rule.
    const threeModels = arms.map((arm, at) => (at >= 6 ? { ...arm, model: 'zai.glm-5' } : arm));
    expect(refusedField({ ...config, arms: threeModels })).not.toBeNull();
  });

  it('refuses a config declaring both Campaign blocks', async () => {
    const grounding = await campaignConfig();
    const scoreboard = JSON.parse(
      await readFile(resolve(HERE, 'sweep.config.scoreboard-ab-v1.json'), 'utf8'),
    ) as Record<string, unknown>;

    const field = refusedField({
      ...grounding,
      scoreboardCampaign: scoreboard.scoreboardCampaign,
    });

    expect(field).toBe('groundingCampaign');
  });

  it('leaves every config that declares no block parsing exactly as before', async () => {
    const withoutBlock = { ...(await campaignConfig()) };
    delete withoutBlock.groundingCampaign;
    const parsed = parseSweepConfig(withoutBlock);

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value.groundingCampaign).toBeUndefined();
  });
});

const PROPERTY_9 =
  'Feature: grounding-adoption-confirmatory, Property 9: A hand edit to any pre-registered value is refused, and the identity moves';

/**
 * The pre-registered values, restated here as literals.
 *
 * The oracle must know the correct value without asking the parser, or an edit to the constant
 * and an edit to the config would agree with each other and the test would pass on both.
 */
const EXPECTED_CRITERION: Readonly<Record<string, number | boolean>> = {
  alphaPercent: 5,
  modelArmCount: 4,
  minModelArmsGreater: 3,
  designCount: 19,
  minDesignsGreater: 5,
  minNetDesignsGreater: 3,
  sampleCount: 7,
  tieCountsAsGreater: false,
  coverageGapMarginPercent: 2,
  missedBugMarginPercent: 3,
  agreementMarginPercent: 3,
  minGuardDenominator: 34,
  minScoredMutantDenominator: 1,
};

const EXPECTED_POWER: Readonly<Record<string, number | string>> = {
  exploratoryConfigHash: '773b798cf6bbe129',
  exploratorySlotPairs: 380,
  exploratoryGroundedOnlyValid: 56,
  exploratoryControlOnlyValid: 23,
  exploratoryJudgedControl: 58,
  exploratoryJudgedGrounded: 97,
  exploratoryCoverageGapSurvivorsControl: 87,
  exploratoryCoverageGapSurvivorsGrounded: 100,
  exploratoryScoredMutantsControl: 1_493,
  exploratoryScoredMutantsGrounded: 2_230,
  slotPairs: 532,
  expectedGroundedOnlyValid: 78,
  expectedControlOnlyValid: 32,
  expectedDiscordantPairs: 110,
  minGroundedOnlyToHold: 65,
  expectedJudgedControl: 81,
  expectedJudgedGrounded: 136,
  expectedCoverageGapSurvivorsControl: 122,
  expectedCoverageGapSurvivorsGrounded: 140,
  expectedScoredMutantsControl: 2_090,
  expectedScoredMutantsGrounded: 3_122,
};

/** A value of the same type that is NOT the expected one, so the edit is always a real edit. */
function otherValue(value: number | boolean | string): number | boolean | string {
  if (typeof value === 'boolean') {
    return !value;
  }
  return typeof value === 'number' ? value + 1 : `${value}0`;
}

describe('the pre-registered block records what this build accepts', () => {
  it('equals the restated criterion and power arithmetic, field for field', async () => {
    const parsed = parseSweepConfig(await campaignConfig());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.groundingCampaign === undefined) {
      return;
    }
    const block = parsed.value.groundingCampaign;

    expect(block.successCriterion).toEqual(EXPECTED_CRITERION);
    expect(block.powerArithmetic).toEqual(EXPECTED_POWER);
    // Both expected Judged_Sample counts clear the Minimum_Guard_Denominator, which is the
    // whole reason Sample_Count moved from 5 to 7.
    expect(EXPECTED_POWER.expectedJudgedControl).toBeGreaterThan(
      EXPECTED_CRITERION.minGuardDenominator as number,
    );
    expect(EXPECTED_POWER.expectedJudgedGrounded).toBeGreaterThan(
      EXPECTED_CRITERION.minGuardDenominator as number,
    );
  });
});

describe(PROPERTY_9, () => {
  it('refuses any single-field edit to the criterion or the power arithmetic', async () => {
    const config = await campaignConfig();
    for (const [field, value] of Object.entries(EXPECTED_CRITERION)) {
      const edited = await withBlock((block) => {
        (block.successCriterion as Record<string, unknown>)[field] = otherValue(value);
      });

      expect(refusedField(edited)).toBe(`groundingCampaign.successCriterion.${field}`);
    }
    for (const [field, value] of Object.entries(EXPECTED_POWER)) {
      const edited = await withBlock((block) => {
        (block.powerArithmetic as Record<string, unknown>)[field] = otherValue(value);
      });

      expect(refusedField(edited)).toBe(`groundingCampaign.powerArithmetic.${field}`);
    }
    // The committed config itself is the only one that parses.
    expect(refusedField(config)).toBeNull();
  });

  it('refuses an edit to the Sample_Count, the design count, the arm count, or maxResumes', async () => {
    const config = await campaignConfig();
    const arms = config.arms as readonly Record<string, unknown>[];
    const problems = config.problems as { readonly ids: readonly string[] };

    expect(refusedField({ ...config, sampleCount: 5 })).toBe('reproducibility.sampleCount');
    expect(
      refusedField({ ...config, problems: { kind: 'ids', ids: problems.ids.slice(0, 18) } }),
    ).toBe('problems.ids');
    expect(refusedField({ ...config, arms: arms.slice(0, 6) })).toBe('arms');
    expect(
      refusedField(
        await withBlock((block) => {
          block.maxResumes = 3;
        }),
      ),
    ).toBe('groundingCampaign.maxResumes');
  });

  it('refuses an edit to any arm strategy, which is what makes a Slot_Pair a pair', async () => {
    const config = await campaignConfig();
    const arms = config.arms as readonly Record<string, unknown>[];

    for (let at = 0; at < arms.length; at += 1) {
      const flipped = arms.map((arm, index) =>
        index === at
          ? { ...arm, strategy: arm.strategy === 'control' ? 'grounded' : 'control' }
          : arm,
      );

      expect(refusedField({ ...config, arms: flipped })).not.toBeNull();
    }
  });
});

describe(`${PROPERTY_9} - the identity half`, () => {
  it('gives a different Config_Identity to a config differing in one pre-registered value', async () => {
    // The refusals above stop a hand edit from running. This is the other half of Requirement
    // 4.4: were such a config somehow valid, it would be a DIFFERENT experiment, so it must
    // not be able to resume into this run's directory.
    const parsed = parseSweepConfig(await campaignConfig());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.groundingCampaign === undefined) {
      return;
    }
    const base = parsed.value;
    const campaign = parsed.value.groundingCampaign;
    const baseHash = sweepConfigHash(base, sha256Hex);
    const criterion = campaign.successCriterion;

    for (const field of Object.keys(EXPECTED_CRITERION)) {
      const successCriterion = {
        ...criterion,
        [field]: otherValue((criterion as unknown as Record<string, number | boolean>)[field] ?? 0),
      } as GroundingSuccessCriterion;

      expect(
        sweepConfigHash(
          { ...base, groundingCampaign: { ...campaign, successCriterion } },
          sha256Hex,
        ),
      ).not.toBe(baseHash);
    }
    // The Sample_Count and every arm's strategy are identity-bearing for the same reason.
    expect(
      sweepConfigHash(
        { ...base, reproducibility: { ...base.reproducibility, sampleCount: 5 } },
        sha256Hex,
      ),
    ).not.toBe(baseHash);
    expect(
      sweepConfigHash(
        {
          ...base,
          arms: base.arms.map((arm, at) =>
            at === 0 ? { ...arm, strategy: 'grounded' as const } : arm,
          ),
        },
        sha256Hex,
      ),
    ).not.toBe(baseHash);
  });
});
