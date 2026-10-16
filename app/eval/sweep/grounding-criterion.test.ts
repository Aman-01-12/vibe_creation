// The pre-registered Confirmatory_Criterion (grounding-adoption-confirmatory, C2, C3): the
// pinned values, the pre-registration refusals, and the behaviour at each clause's edges.
//
// The full independent oracle lives in `grounding-criterion.property.test.ts` as Property 1.
// What is here are the anchors that oracle cannot provide: a pinned binomial table, the
// literal constant, and the refusal of the Exploratory_Run's own recorded criterion.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  PRE_REGISTERED_GROUNDING_CRITERION,
  evaluateGroundingCriterion,
  isPreRegisteredGroundingCriterion,
  mcnemarUpperTailNumerator,
  type GroundingFigures,
  type GuardFigures,
  type MutantFigures,
  type SlotPairOutcome,
} from './grounding-criterion.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CRITERION = PRE_REGISTERED_GROUNDING_CRITERION;

/** The Exploratory_Run's recorded criterion: 9 fields, including one this build removed. */
const EXPLORATORY_CRITERION = {
  alphaPercent: 5,
  modelArmCount: 4,
  minModelArmsGreater: 3,
  designCount: 19,
  minDesignsGreater: 5,
  minNetDesignsGreater: 3,
  sampleCount: 5,
  tieCountsAsGreater: false,
  undefinedCountsAsNotHolding: true,
};

/** The upper tail numerator, by an independent Pascal recurrence. */
function oracleTail(b: number, n: number): bigint {
  if (n < 0 || b > n) {
    return 0n;
  }
  let row: bigint[] = [1n];
  for (let level = 1; level <= n; level += 1) {
    const next: bigint[] = [1n];
    for (let at = 1; at < level; at += 1) {
      next.push((row[at - 1] ?? 0n) + (row[at] ?? 0n));
    }
    next.push(1n);
    row = next;
  }
  let total = 0n;
  for (let k = Math.max(0, b); k <= n; k += 1) {
    total += row[k] ?? 0n;
  }
  return total;
}

const MODEL_ARMS = ['moonshotai.kimi-k2.5', 'zai.glm-5', 'zai.glm-4.7', 'deepseek.v3.2'] as const;
const DESIGNS = Array.from({ length: 19 }, (_, at) => `design-${String(at)}`);

/**
 * A full Campaign's pairs, where every group favours the Grounded_Arm.
 *
 * One Control slot and four Grounded slots valid per (Model_Arm, design), so b is 228, c is 0,
 * and all three primary clauses hold by construction rather than by luck.
 */
function favourablePairs(): readonly SlotPairOutcome[] {
  return MODEL_ARMS.flatMap((modelArm) =>
    DESIGNS.flatMap((problemId) =>
      Array.from({ length: 7 }, (_, sampleIndex) => ({
        modelArm,
        problemId,
        sampleIndex,
        controlValid: sampleIndex < 1,
        groundedValid: sampleIndex < 4,
      })),
    ),
  );
}

/** Guards and mutant figures that clear every floor and sit inside every margin. */
const PASSING: {
  readonly control: GuardFigures;
  readonly grounded: GuardFigures;
  readonly controlMutants: MutantFigures;
  readonly groundedMutants: MutantFigures;
} = {
  control: { missedBug: 2, judged: 50, agreed: 48 },
  grounded: { missedBug: 3, judged: 60, agreed: 57 },
  controlMutants: { coverageGapSurvivors: 60, scoredMutants: 1_000 },
  groundedMutants: { coverageGapSurvivors: 70, scoredMutants: 1_200 },
};

function figures(overrides: Partial<GroundingFigures> = {}): GroundingFigures {
  return { pairs: favourablePairs(), ...PASSING, ...overrides };
}

describe('the pre-registered Confirmatory_Criterion', () => {
  it('is exactly the 13 pre-registered fields', () => {
    expect(CRITERION).toEqual({
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
    });
    expect(Object.keys(CRITERION)).toHaveLength(13);
    // 34 is the smallest denominator on which one sample is under the 3-point margin.
    expect(CRITERION.minGuardDenominator).toBe(34);
    expect(100 / CRITERION.minGuardDenominator).toBeLessThan(CRITERION.missedBugMarginPercent);
  });

  it("refuses the Exploratory_Run's recorded criterion, so this build cannot re-judge it", () => {
    // Read from the run directory when it is still on disk, else from the inline copy: the
    // refusal must hold either way, because it is a fact about the field set.
    let recorded: unknown = EXPLORATORY_CRITERION;
    try {
      const manifest = JSON.parse(
        readFileSync(resolve(HERE, '../../../.eval-runs/grounding-ab-v1/manifest.json'), 'utf8'),
      ) as { readonly config?: { readonly groundingCampaign?: { successCriterion?: unknown } } };
      recorded = manifest.config?.groundingCampaign?.successCriterion ?? EXPLORATORY_CRITERION;
    } catch {
      // No run directory in this checkout; the inline copy is the same 9-field object.
    }

    expect(isPreRegisteredGroundingCriterion(recorded)).toBe(false);
    expect(isPreRegisteredGroundingCriterion(EXPLORATORY_CRITERION)).toBe(false);
  });

  it('refuses a criterion that is not the pre-registered one, and never throws', () => {
    expect(isPreRegisteredGroundingCriterion(CRITERION)).toBe(true);
    for (const bad of [
      null,
      undefined,
      [],
      'criterion',
      { ...CRITERION, minModelArmsGreater: 2 },
      { ...CRITERION, tieCountsAsGreater: true },
      { ...CRITERION, coverageGapMarginPercent: 3 },
      { ...CRITERION, minGuardDenominator: 33 },
      { ...CRITERION, extra: 1 },
    ]) {
      expect(isPreRegisteredGroundingCriterion(bad)).toBe(false);
    }
    const missing: Record<string, unknown> = { ...CRITERION };
    delete missing.alphaPercent;
    expect(isPreRegisteredGroundingCriterion(missing)).toBe(false);
  });
});

describe('mcnemarUpperTailNumerator - the exact tail, anchored', () => {
  it('matches a pinned table of upper-tail numerators for n <= 12', () => {
    // Anchors the recurrence itself: P(X >= n | n, 1/2) is one outcome, and the whole tail
    // from 0 is every outcome, so the two ends are 1 and 2^n whatever the loop does.
    for (let n = 0; n <= 12; n += 1) {
      expect(mcnemarUpperTailNumerator(0, n)).toBe(2n ** BigInt(n));
      expect(mcnemarUpperTailNumerator(n, n)).toBe(1n);
      for (let b = 0; b <= n; b += 1) {
        expect(mcnemarUpperTailNumerator(b, n)).toBe(oracleTail(b, n));
      }
    }
    // The 5% boundary this criterion turns on: 6 of 6 discordant pairs is p = 1/64 < 0.05,
    // and 5 of 6 is p = 7/64 > 0.05, so one pair is the difference between held and not.
    expect(mcnemarUpperTailNumerator(6, 6)).toBe(1n);
    expect(mcnemarUpperTailNumerator(5, 6)).toBe(7n);
  });

  it('pins the smallest Grounded_Arm-only count that clears the level at 110 pairs', () => {
    // The pre-registered `minGroundedOnlyToHold`, by the independent recurrence: 64 is over
    // the 5% level and 65 is under it, so the threshold is 65 and not 64.
    expect(100n * oracleTail(64, 110) <= 5n * 2n ** 110n).toBe(false);
    expect(100n * oracleTail(65, 110) <= 5n * 2n ** 110n).toBe(true);
  });
});

describe('evaluateGroundingCriterion - the verdict composes six clauses', () => {
  it('reports succeeded when every clause holds on a full set of pairs', () => {
    const report = evaluateGroundingCriterion(CRITERION, figures(), 0);

    expect(report.verdict).toBe('succeeded');
    expect(report.pairsExpected).toBe(532);
    expect(report.pairsObserved).toBe(532);
    expect(Object.keys(report.criteria)).toHaveLength(6);
  });

  it('decides nothing when a pair is missing, even with every clause held', () => {
    const report = evaluateGroundingCriterion(
      CRITERION,
      figures({ pairs: favourablePairs().slice(0, 531) }),
      0,
    );

    expect(report.verdict).toBe('not-decided');
    expect(report.pairsObserved).toBe(531);
  });

  it('decides nothing when a slot is still deferred', () => {
    expect(evaluateGroundingCriterion(CRITERION, figures(), 3).verdict).toBe('not-decided');
  });

  it('leaves a sample-level guard not-decided below the Minimum_Guard_Denominator', () => {
    const thin: GuardFigures = { missedBug: 0, judged: 33, agreed: 33 };
    const report = evaluateGroundingCriterion(
      CRITERION,
      figures({ control: thin, grounded: thin }),
      0,
    );

    // 33 Judged_Samples cannot carry a 3-point margin, so the clause reports no conclusion
    // and the verdict follows it rather than crediting or blaming the treatment.
    expect(report.criteria.missedBugNonInferior.outcome).toBe('not-decided');
    expect(report.criteria.agreementNonInferior.outcome).toBe('not-decided');
    expect(report.criteria.coverageGapNonInferior.outcome).toBe('held');
    expect(report.verdict).toBe('not-decided');
  });

  it('leaves the per-mutant guard not-decided when an arm scored no mutant', () => {
    const report = evaluateGroundingCriterion(
      CRITERION,
      figures({ groundedMutants: { coverageGapSurvivors: 0, scoredMutants: 0 } }),
      0,
    );

    expect(report.criteria.coverageGapNonInferior.outcome).toBe('not-decided');
    expect(report.criteria.coverageGapNonInferior.differencePoints).toBeNull();
    expect(report.verdict).toBe('not-decided');
  });

  it('fails, rather than defers, when a guard is decided and worse than its margin', () => {
    const report = evaluateGroundingCriterion(
      CRITERION,
      figures({
        groundedMutants: { coverageGapSurvivors: 120, scoredMutants: 1_200 },
      }),
      0,
    );

    // 10.0% against 6.0% is 4 points worse, past the 2-point margin.
    expect(report.criteria.coverageGapNonInferior.outcome).toBe('not-held');
    expect(report.criteria.coverageGapNonInferior.differencePoints).toBeCloseTo(4, 10);
    expect(report.verdict).toBe('failed');
  });

  it('carries each guard clause margin and floor beside its figures', () => {
    const { criteria } = evaluateGroundingCriterion(CRITERION, figures(), 0);

    expect(criteria.coverageGapNonInferior.marginPercent).toBe(2);
    expect(criteria.coverageGapNonInferior.minDenominator).toBe(1);
    expect(criteria.missedBugNonInferior.marginPercent).toBe(3);
    expect(criteria.missedBugNonInferior.minDenominator).toBe(34);
    expect(criteria.agreementNonInferior.marginPercent).toBe(3);
    expect(criteria.agreementNonInferior.minDenominator).toBe(34);
    expect(criteria.coverageGapNonInferior.control).toEqual(PASSING.controlMutants);
    expect(criteria.agreementNonInferior.grounded).toEqual(PASSING.grounded);
  });
});
