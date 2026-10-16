// The Grounding Campaign's table (testbench-spec-grounding, C16): every figure of
// Requirement 11, per cell, pooling nothing.
//
// A cell is keyed by (Strategy_Arm, scope) at design, model, and arm scope, and is computed
// only from the records carrying its key. Cells are enumerated from the DECLARED keys rather
// than from the records present, so a cell with no records reports a zero denominator instead
// of vanishing (Req 11.1, 11.7).

import { TESTBENCH_PARSE_REFUSALS, type TestbenchParseRefusal } from '@app/agent';

import { tallySurvivedOperators, type SurvivedOperatorCount } from '../mutation-control.js';
import { campaignCounts, type CampaignCounts } from './campaign-table.js';
import type { SlotPairOutcome } from './grounding-criterion.js';
import type { SweepSampleRecord } from './results-log.js';

/** The Grounding Campaign's two arms. */
export type GroundingStrategyArm = 'control' | 'grounded';

/** The two arms, in the order every block renders them. */
export const GROUNDING_STRATEGY_ARMS: readonly GroundingStrategyArm[] = ['control', 'grounded'];

/** What a cell's records are the records OF. */
export type GroundingScope =
  | { readonly kind: 'design'; readonly modelArm: string; readonly problemId: string }
  | { readonly kind: 'model'; readonly modelArm: string }
  | { readonly kind: 'arm' };

/** One cell: the shared Campaign counts plus this spec's per-cause counts. */
export interface GroundingCell extends CampaignCounts {
  readonly strategyArm: GroundingStrategyArm;
  readonly scope: GroundingScope;
  readonly positiveControlPassed: number;
  readonly watchdogStops: number;
  readonly resourceExhausted: number;
  readonly waveformMissing: number;
  readonly knownAnswerOnlyFailures: number;
  readonly parseRefusals: Readonly<Record<TestbenchParseRefusal, number>>;
  /**
   * The operators behind this cell's Coverage_Gap_Survivors, most frequent first.
   *
   * Tallied over exactly this cell's records, so the counts sum to `coverageGapSurvivors` and
   * a cell with no coverage gap carries an empty tally rather than a missing field.
   */
  readonly coverageGapOperators: readonly SurvivedOperatorCount[];
}

/** Whether a record belongs in a scope; the arm is matched separately. */
function inScope(record: SweepSampleRecord, scope: GroundingScope): boolean {
  if (scope.kind === 'arm') {
    return true;
  }
  if (scope.kind === 'model') {
    return record.modelSignature === scope.modelArm;
  }
  return record.modelSignature === scope.modelArm && record.problemId === scope.problemId;
}

/** An all-zero refusal tally, so every code is reported even at zero. */
function emptyRefusals(): Record<TestbenchParseRefusal, number> {
  const tally = {} as Record<TestbenchParseRefusal, number>;
  for (const refusal of TESTBENCH_PARSE_REFUSALS) {
    tally[refusal] = 0;
  }
  return tally;
}

/** The per-cause counts of Requirements 11.2 to 11.4, over one cell's records. */
function perCauseCounts(
  records: readonly SweepSampleRecord[],
): Omit<GroundingCell, keyof CampaignCounts | 'strategyArm' | 'scope'> {
  const parseRefusals = emptyRefusals();
  for (const record of records) {
    if (record.testbenchParseRefusal !== null) {
      parseRefusals[record.testbenchParseRefusal] += 1;
    }
  }
  const runs = records
    .map((record) => record.positiveControlRun)
    .filter((run): run is NonNullable<typeof run> => run !== null);
  return {
    positiveControlPassed: runs.filter((run) => run.passed).length,
    watchdogStops: runs.filter((run) => run.watchdogStopped).length,
    resourceExhausted: records.filter(
      (record) => record.instrumentUncheckedReason === 'control-resource-exhausted',
    ).length,
    waveformMissing: runs.filter((run) => run.waveformMissing).length,
    knownAnswerOnlyFailures: runs.filter((run) => run.knownAnswerOnlyFailure).length,
    parseRefusals,
    coverageGapOperators: tallySurvivedOperators(
      records.map((record) => record.mutation),
      'coverageGapOperators',
    ),
  };
}

/** Every declared cell key: per design, then per Model_Arm, then per arm in total. */
function cellKeys(
  modelArms: readonly string[],
  problemIds: readonly string[],
): readonly { readonly strategyArm: GroundingStrategyArm; readonly scope: GroundingScope }[] {
  const scopes: GroundingScope[] = [
    ...modelArms.flatMap((modelArm) =>
      problemIds.map((problemId) => ({ kind: 'design' as const, modelArm, problemId })),
    ),
    ...modelArms.map((modelArm) => ({ kind: 'model' as const, modelArm })),
    { kind: 'arm' as const },
  ];
  return GROUNDING_STRATEGY_ARMS.flatMap((strategyArm) =>
    scopes.map((scope) => ({ strategyArm, scope })),
  );
}

/**
 * Every cell of the Grounding table (pure).
 *
 * Takes only Campaign records: a `BaselineCell` is a different type, so a Reference_Campaign
 * record cannot reach a cell by construction (Req 9.7).
 */
export function groundingCells(
  records: readonly SweepSampleRecord[],
  modelArms: readonly string[],
  problemIds: readonly string[],
): readonly GroundingCell[] {
  return cellKeys(modelArms, problemIds).map((key) => {
    const own = records.filter(
      (record) => record.strategyArm === key.strategyArm && inScope(record, key.scope),
    );
    return { ...key, ...campaignCounts(own), ...perCauseCounts(own) };
  });
}

/** A slot's key, so the two arms' records of one slot find each other. */
function slotKey(record: SweepSampleRecord): string {
  return `${record.modelSignature}|${record.problemId}|${String(record.sampleIndex)}`;
}

/**
 * Every Slot_Pair with both records present, in first-seen order (Req 11.5).
 *
 * A slot with only one arm's record is NOT a pair: the comparison this Campaign is decided by
 * is within a pair, so half a pair is no evidence either way.
 */
export function slotPairs(records: readonly SweepSampleRecord[]): readonly SlotPairOutcome[] {
  const bySlot = new Map<string, { control?: SweepSampleRecord; grounded?: SweepSampleRecord }>();
  const order: string[] = [];
  for (const record of records) {
    if (record.strategyArm !== 'control' && record.strategyArm !== 'grounded') {
      continue;
    }
    const key = slotKey(record);
    if (!bySlot.has(key)) {
      bySlot.set(key, {});
      order.push(key);
    }
    const slot = bySlot.get(key);
    if (slot !== undefined) {
      slot[record.strategyArm] = record;
    }
  }
  const pairs: SlotPairOutcome[] = [];
  for (const key of order) {
    const slot = bySlot.get(key);
    const control = slot?.control;
    const grounded = slot?.grounded;
    if (control === undefined || grounded === undefined) {
      continue;
    }
    pairs.push({
      modelArm: control.modelSignature,
      problemId: control.problemId,
      sampleIndex: control.sampleIndex,
      controlValid: control.instrumentValidity === 'valid',
      groundedValid: grounded.instrumentValidity === 'valid',
    });
  }
  return pairs;
}
