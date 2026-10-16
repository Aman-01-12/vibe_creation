// The Grounding Campaign's PRE-REGISTERED Success_Criterion (testbench-spec-grounding, C17).
//
// Declared before a single paid slot runs and recorded in the Sweep_Manifest, so the rule the
// Campaign is judged by cannot be chosen after its figures are known. Every comparison is an
// integer or a cross-multiplication, so no float ever decides a boundary.

import type { CampaignVerdict } from './success-criterion.js';

/** The rule, in the form Requirement 12 states it. Every field is compared exactly. */
export interface GroundingSuccessCriterion {
  /** The one-sided exact McNemar level, as an integer percent (Req 12.5). */
  readonly alphaPercent: 5;
  readonly modelArmCount: 4;
  readonly minModelArmsGreater: 3;
  readonly designCount: 19;
  readonly minDesignsGreater: 5;
  readonly minNetDesignsGreater: 3;
  readonly sampleCount: 7;
  /** A tie is NOT greater, in both the per-Model_Arm and the per-design count (Req 12.6, 12.7). */
  readonly tieCountsAsGreater: false;
  /** The Coverage_Gap_Survivor rate margin, in percentage points (Req 7.1). */
  readonly coverageGapMarginPercent: 2;
  /** The Missed_Bug rate margin, in percentage points (Req 8.1). */
  readonly missedBugMarginPercent: 3;
  /** The Golden_Agreement rate margin, in percentage points (Req 8.2). */
  readonly agreementMarginPercent: 3;
  /** Below this many Judged_Samples, a sample-level guard decides nothing (Req 8.4, 8.5). */
  readonly minGuardDenominator: 34;
  /** Below this many Scored_Mutants, the per-mutant guard decides nothing (Req 7.4). */
  readonly minScoredMutantDenominator: 1;
}

/** The pre-registered values; the parser accepts a config block only if it equals this. */
export const PRE_REGISTERED_GROUNDING_CRITERION: GroundingSuccessCriterion = {
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

/** Whether an untrusted value is the pre-registered criterion, field for field (never throws). */
export function isPreRegisteredGroundingCriterion(
  value: unknown,
): value is GroundingSuccessCriterion {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const fields = value as Record<string, unknown>;
  const expected = PRE_REGISTERED_GROUNDING_CRITERION as unknown as Record<string, unknown>;
  const keys = Object.keys(expected);
  if (Object.keys(fields).length !== keys.length) {
    return false;
  }
  return keys.every((key) => fields[key] === expected[key]);
}

/**
 * What one clause of the criterion concluded.
 *
 * Three-valued, because a clause whose denominator is too small to carry the comparison has
 * concluded nothing: reporting that as `not-held` would blame the treatment for an absent
 * measurement, and reporting it as `held` would adopt on no evidence.
 */
export type ClauseOutcome = 'held' | 'not-held' | 'not-decided';

/** The closed set, so a renderer and a test enumerate the same members. */
export const CLAUSE_OUTCOMES: readonly ClauseOutcome[] = Object.freeze([
  'held',
  'not-held',
  'not-decided',
]);

/** A rate kept as a numerator over a denominator, so it is never divided before a comparison. */
export interface Fraction {
  readonly numerator: number;
  readonly denominator: number;
}

/** One arm's per-mutant figures: the Coverage_Gap_Survivors over the Scored_Mutants. */
export interface MutantFigures {
  readonly coverageGapSurvivors: number;
  readonly scoredMutants: number;
}

/** How one non-inferiority clause compares its two fractions. */
export interface NonInferiorityRule {
  /** The margin in percentage POINTS, as an integer, so no float enters the comparison. */
  readonly marginPercent: number;
  /** Which direction is the worse one for the Grounded_Arm. */
  readonly direction: 'not-higher' | 'not-lower';
  /** Below this, either denominator leaves the clause undecided rather than failed. */
  readonly minDenominator: number;
}

/**
 * Whether the Grounded_Arm's rate is non-inferior to the Control_Arm's, exactly.
 *
 * `not-higher` holds when `100*g*C <= 100*c*G + m*G*C`, `not-lower` when
 * `100*g*C >= 100*c*G - m*G*C`, in `bigint`, so a rate pair sitting exactly on the margin
 * decides by the stated inequality and not by a rounding of it.
 */
export function nonInferior(
  control: Fraction,
  grounded: Fraction,
  rule: NonInferiorityRule,
): ClauseOutcome {
  if (control.denominator < rule.minDenominator || grounded.denominator < rule.minDenominator) {
    return 'not-decided';
  }
  const scaledGrounded = 100n * BigInt(grounded.numerator) * BigInt(control.denominator);
  const scaledControl = 100n * BigInt(control.numerator) * BigInt(grounded.denominator);
  const allowance =
    BigInt(rule.marginPercent) * BigInt(grounded.denominator) * BigInt(control.denominator);
  const holds =
    rule.direction === 'not-higher'
      ? scaledGrounded <= scaledControl + allowance
      : scaledGrounded >= scaledControl - allowance;
  return holds ? 'held' : 'not-held';
}

/** What one Slot_Pair showed: whether each arm's slot was Instrument_Valid (Req 10.16). */
export interface SlotPairOutcome {
  readonly modelArm: string;
  readonly problemId: string;
  readonly sampleIndex: number;
  readonly controlValid: boolean;
  readonly groundedValid: boolean;
}

/** The two guard figures of Requirements 12.8 and 12.9, pooled over the Model_Arms. */
export interface GuardFigures {
  readonly missedBug: number;
  readonly judged: number;
  readonly agreed: number;
}

/**
 * Everything the verdict is computed from; only Campaign records reach it.
 *
 * Four per-arm fields, each read from one arm's cell, so nothing in this type can hold a
 * figure pooled across the two Strategy_Arms.
 */
export interface GroundingFigures {
  readonly pairs: readonly SlotPairOutcome[];
  readonly control: GuardFigures;
  readonly grounded: GuardFigures;
  readonly controlMutants: MutantFigures;
  readonly groundedMutants: MutantFigures;
}

/** One non-inferiority clause's outcome beside every number it was decided on. */
export interface NonInferiorityClause<Figures> {
  readonly outcome: ClauseOutcome;
  readonly control: Figures;
  readonly grounded: Figures;
  readonly marginPercent: number;
  readonly minDenominator: number;
  /** Grounded minus Control in percentage points, for reading; `null` with no denominator. */
  readonly differencePoints: number | null;
}

/** One criterion's own computed value, so a reader never has to recompute it. */
export interface GroundingCriterionResults {
  readonly pooledSignTest: {
    readonly outcome: ClauseOutcome;
    readonly b: number;
    readonly c: number;
    /** Rendered for reading only; the decision above is taken in exact integers. */
    readonly pValue: number;
  };
  readonly modelArmsGreater: {
    readonly outcome: ClauseOutcome;
    readonly observed: number;
    readonly threshold: number;
  };
  readonly designsGreater: {
    readonly outcome: ClauseOutcome;
    readonly greater: number;
    readonly lower: number;
    readonly minGreater: number;
    readonly minNet: number;
  };
  /** The PRIMARY guard: per mutant, so it is decided on thousands rather than tens. */
  readonly coverageGapNonInferior: NonInferiorityClause<MutantFigures>;
  readonly missedBugNonInferior: NonInferiorityClause<GuardFigures>;
  readonly agreementNonInferior: NonInferiorityClause<GuardFigures>;
}

/** The verdict and every criterion's computed value (Req 12.14). */
export interface GroundingVerdictReport {
  readonly verdict: CampaignVerdict;
  readonly criteria: GroundingCriterionResults;
  readonly pairsExpected: number;
  readonly pairsObserved: number;
}

/** `n` choose `k`, exactly. */
function binomial(n: number, k: number): bigint {
  let result = 1n;
  for (let step = 0n; step < BigInt(k); step += 1n) {
    result = (result * (BigInt(n) - step)) / (step + 1n);
  }
  return result;
}

/** The numerator of P(X >= b | n, 1/2) over the denominator 2^n, exactly (Req 12.5). */
export function mcnemarUpperTailNumerator(b: number, n: number): bigint {
  if (n < 0 || b > n) {
    return 0n;
  }
  let total = 0n;
  for (let k = Math.max(0, b); k <= n; k += 1) {
    total += binomial(n, k);
  }
  return total;
}

/** Discordant_Pairs, as Requirement 12.5 counts them. */
function discordant(pairs: readonly SlotPairOutcome[]): { readonly b: number; readonly c: number } {
  return {
    b: pairs.filter((pair) => pair.groundedValid && !pair.controlValid).length,
    c: pairs.filter((pair) => pair.controlValid && !pair.groundedValid).length,
  };
}

/** Group the pairs by a key, so a per-Model_Arm or per-design count never pools two keys. */
function groupBy(
  pairs: readonly SlotPairOutcome[],
  keyOf: (pair: SlotPairOutcome) => string,
): ReadonlyMap<string, readonly SlotPairOutcome[]> {
  const groups = new Map<string, SlotPairOutcome[]>();
  for (const pair of pairs) {
    const key = keyOf(pair);
    groups.set(key, [...(groups.get(key) ?? []), pair]);
  }
  return groups;
}

/** How many groups have strictly more valid Grounded slots than Control slots; a tie is not. */
function groupsGreater(groups: ReadonlyMap<string, readonly SlotPairOutcome[]>): {
  readonly greater: number;
  readonly lower: number;
} {
  let greater = 0;
  let lower = 0;
  for (const group of groups.values()) {
    const grounded = group.filter((pair) => pair.groundedValid).length;
    const control = group.filter((pair) => pair.controlValid).length;
    if (grounded > control) {
      greater += 1;
    } else if (grounded < control) {
      lower += 1;
    }
  }
  return { greater, lower };
}

/** The difference between two rates in percentage points, or `null` with no denominator. */
function differencePoints(control: Fraction, grounded: Fraction): number | null {
  if (control.denominator === 0 || grounded.denominator === 0) {
    return null;
  }
  return (
    (100 * grounded.numerator) / grounded.denominator -
    (100 * control.numerator) / control.denominator
  );
}

/** One non-inferiority clause: its outcome, its figures, and its difference for reading. */
function guardClause<Figures>(
  arms: { readonly control: Figures; readonly grounded: Figures },
  asFraction: (figures: Figures) => Fraction,
  rule: NonInferiorityRule,
): NonInferiorityClause<Figures> {
  const control = asFraction(arms.control);
  const grounded = asFraction(arms.grounded);
  return {
    outcome: nonInferior(control, grounded, rule),
    control: arms.control,
    grounded: arms.grounded,
    marginPercent: rule.marginPercent,
    minDenominator: rule.minDenominator,
    differencePoints: differencePoints(control, grounded),
  };
}

/** A sample-level guard's rate: the picked count over the Judged_Samples. */
function guardFraction(figures: GuardFigures, pick: (of: GuardFigures) => number): Fraction {
  return { numerator: pick(figures), denominator: figures.judged };
}

/** The whole verdict (pure, total): every criterion is computed under every verdict. */
export function evaluateGroundingCriterion(
  criterion: GroundingSuccessCriterion,
  figures: GroundingFigures,
  deferredSlots: number,
): GroundingVerdictReport {
  const { b, c } = discordant(figures.pairs);
  const n = b + c;
  const numerator = mcnemarUpperTailNumerator(b, n);
  const denominator = 2n ** BigInt(n);
  const signHeld = b > c && 100n * numerator <= BigInt(criterion.alphaPercent) * denominator;

  const perModel = groupsGreater(groupBy(figures.pairs, (pair) => pair.modelArm));
  const perDesign = groupsGreater(groupBy(figures.pairs, (pair) => pair.problemId));

  const criteria: GroundingCriterionResults = {
    pooledSignTest: {
      outcome: signHeld ? 'held' : 'not-held',
      b,
      c,
      pValue: n === 0 ? 1 : Number(numerator) / Number(denominator),
    },
    modelArmsGreater: {
      outcome: perModel.greater >= criterion.minModelArmsGreater ? 'held' : 'not-held',
      observed: perModel.greater,
      threshold: criterion.minModelArmsGreater,
    },
    designsGreater: {
      outcome:
        perDesign.greater >= criterion.minDesignsGreater &&
        perDesign.greater - perDesign.lower >= criterion.minNetDesignsGreater
          ? 'held'
          : 'not-held',
      greater: perDesign.greater,
      lower: perDesign.lower,
      minGreater: criterion.minDesignsGreater,
      minNet: criterion.minNetDesignsGreater,
    },
    coverageGapNonInferior: guardClause(
      { control: figures.controlMutants, grounded: figures.groundedMutants },
      (mutants) => ({
        numerator: mutants.coverageGapSurvivors,
        denominator: mutants.scoredMutants,
      }),
      {
        marginPercent: criterion.coverageGapMarginPercent,
        direction: 'not-higher',
        minDenominator: criterion.minScoredMutantDenominator,
      },
    ),
    missedBugNonInferior: guardClause(
      { control: figures.control, grounded: figures.grounded },
      (guard) => guardFraction(guard, (of) => of.missedBug),
      {
        marginPercent: criterion.missedBugMarginPercent,
        direction: 'not-higher',
        minDenominator: criterion.minGuardDenominator,
      },
    ),
    agreementNonInferior: guardClause(
      { control: figures.control, grounded: figures.grounded },
      (guard) => guardFraction(guard, (of) => of.agreed),
      {
        marginPercent: criterion.agreementMarginPercent,
        direction: 'not-lower',
        minDenominator: criterion.minGuardDenominator,
      },
    ),
  };

  const pairsExpected = criterion.modelArmCount * criterion.designCount * criterion.sampleCount;
  const pairsObserved = figures.pairs.length;
  const outcomes: readonly ClauseOutcome[] = [
    criteria.pooledSignTest.outcome,
    criteria.modelArmsGreater.outcome,
    criteria.designsGreater.outcome,
    criteria.coverageGapNonInferior.outcome,
    criteria.missedBugNonInferior.outcome,
    criteria.agreementNonInferior.outcome,
  ];
  // Deferred first, then an undecided clause, then all held: a missing measurement decides
  // nothing in either direction, which is the only fail-honest order (Req 9.4, 9.5).
  const verdict: CampaignVerdict =
    deferredSlots > 0 || pairsObserved !== pairsExpected
      ? 'not-decided'
      : outcomes.includes('not-decided')
        ? 'not-decided'
        : outcomes.every((outcome) => outcome === 'held')
          ? 'succeeded'
          : 'failed';
  return { verdict, criteria, pairsExpected, pairsObserved };
}
