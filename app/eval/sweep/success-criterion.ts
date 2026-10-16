// The pre-registered Success_Criterion of the In_Order_Scoreboard A/B Campaign (C11).
//
// Pure and total: the same figures and criterion always give the same report (Req 10.4).
// Agreement is compared as an exact rational by cross-multiplication, so rounding never
// breaks a tie; every unexpected input fails safe to `not-decided`, never `succeeded`.

/** The rule fixed before the Campaign ran; every field is a literal so it cannot drift. */
export interface SuccessCriterion {
  /** Req 10.5: Model_Arms where Treatment beats Control on Streaming Instrument_Valid. */
  readonly minModelArmsGreater: 9;
  /** Req 10.7: Model_Arms whose Streaming Golden_Agreement may be lower under Treatment. */
  readonly maxModelArmsAgreementLower: 2;
  /** Req 10.5: a tie does not count as greater. */
  readonly tieCountsAsGreater: false;
  /** Req 10.13: an undefined agreement on either arm counts as lower. */
  readonly undefinedAgreementCountsAsLower: true;
  /** The Model_Arm count the figures must cover. */
  readonly modelArmCount: 11;
}

/** The only Success_Criterion this build accepts. */
export const PRE_REGISTERED_SUCCESS_CRITERION: SuccessCriterion = Object.freeze({
  minModelArmsGreater: 9,
  maxModelArmsAgreementLower: 2,
  tieCountsAsGreater: false,
  undefinedAgreementCountsAsLower: true,
  modelArmCount: 11,
});

/** Whether an untrusted value (a manifest's recorded copy) is exactly the pre-registered rule. */
export function isPreRegisteredCriterion(value: unknown): value is SuccessCriterion {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const expected = Object.entries(PRE_REGISTERED_SUCCESS_CRITERION);
  return (
    Object.keys(record).length === expected.length &&
    expected.every(([key, wanted]) => record[key] === wanted)
  );
}

/** One Strategy_Arm's Streaming_Group figures for one Model_Arm. */
export interface StreamingFigures {
  readonly records: number;
  readonly instrumentValid: number;
  readonly missedBug: number;
  /** Samples the golden judge decided; the agreement denominator. */
  readonly judged: number;
  /** Judged samples whose verdict agreed with the golden judge; the numerator. */
  readonly agreed: number;
}

/** Both arms' figures for one Model_Arm, plus its Cycle_Exact Instrument_Valid counts. */
export interface ModelArmStreamingFigures {
  readonly modelArm: string;
  readonly control: StreamingFigures;
  readonly treatment: StreamingFigures;
  readonly cycleExactInstrumentValid: { readonly control: number; readonly treatment: number };
}

export type CampaignVerdict = 'succeeded' | 'failed' | 'not-decided';

/** One criterion's outcome with the number it was decided on. */
export interface CriterionResult {
  readonly held: boolean;
  readonly observed: number;
  readonly threshold: number;
}

export interface VerdictReport {
  readonly verdict: CampaignVerdict;
  /** Every criterion is `null` when the verdict is `not-decided` (Req 10.9). */
  readonly criteria: {
    readonly instrumentValidGreater: CriterionResult | null;
    readonly missedBugNotHigher: CriterionResult | null;
    readonly agreementLowerAtMost: CriterionResult | null;
    readonly beatsNoiseFloor: CriterionResult | null;
  };
  /** Always present, so a `not-decided` report still shows its figures (Req 10.12). */
  readonly perModelArm: readonly ModelArmStreamingFigures[];
}

/** Whether Treatment's agreement is lower than Control's, or either is undefined (Req 10.13). */
export function agreementLower(control: StreamingFigures, treatment: StreamingFigures): boolean {
  if (control.judged === 0 || treatment.judged === 0) {
    return true;
  }
  return treatment.agreed * control.judged < control.agreed * treatment.judged;
}

/** The sum of one numeric projection over every Model_Arm. */
function total(
  figures: readonly ModelArmStreamingFigures[],
  pick: (arm: ModelArmStreamingFigures) => number,
): number {
  return figures.reduce((sum, arm) => sum + pick(arm), 0);
}

function notDecided(figures: readonly ModelArmStreamingFigures[]): VerdictReport {
  return {
    verdict: 'not-decided',
    criteria: {
      instrumentValidGreater: null,
      missedBugNotHigher: null,
      agreementLowerAtMost: null,
      beatsNoiseFloor: null,
    },
    perModelArm: figures,
  };
}

/**
 * Decide the Campaign against its pre-registered criterion (Req 10.4-10.13).
 * A deferred slot, or figures not covering exactly the declared Model_Arms, is `not-decided`.
 */
export function evaluateSuccessCriterion(
  criterion: SuccessCriterion,
  figures: readonly ModelArmStreamingFigures[],
  deferredSlots: number,
): VerdictReport {
  if (deferredSlots !== 0 || figures.length !== criterion.modelArmCount) {
    return notDecided(figures);
  }
  const greater = figures.filter(
    (arm) => arm.treatment.instrumentValid > arm.control.instrumentValid,
  ).length;
  const missedHigher = figures.filter(
    (arm) => arm.treatment.missedBug > arm.control.missedBug,
  ).length;
  const lower = figures.filter((arm) => agreementLower(arm.control, arm.treatment)).length;
  const streamingDelta =
    total(figures, (arm) => arm.treatment.instrumentValid) -
    total(figures, (arm) => arm.control.instrumentValid);
  const noiseFloor = Math.abs(
    total(figures, (arm) => arm.cycleExactInstrumentValid.treatment) -
      total(figures, (arm) => arm.cycleExactInstrumentValid.control),
  );
  const criteria = {
    instrumentValidGreater: {
      held: greater >= criterion.minModelArmsGreater,
      observed: greater,
      threshold: criterion.minModelArmsGreater,
    },
    missedBugNotHigher: { held: missedHigher === 0, observed: missedHigher, threshold: 0 },
    agreementLowerAtMost: {
      held: lower <= criterion.maxModelArmsAgreementLower,
      observed: lower,
      threshold: criterion.maxModelArmsAgreementLower,
    },
    beatsNoiseFloor: {
      held: streamingDelta > noiseFloor,
      observed: streamingDelta,
      threshold: noiseFloor,
    },
  };
  const held = Object.values(criteria).every((result) => result.held);
  return { verdict: held ? 'succeeded' : 'failed', criteria, perModelArm: figures };
}
