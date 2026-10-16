// The A/B Campaign table: every figure of Requirement 9, per cell, pooling nothing (C9).
//
// A cell is keyed by (Strategy_Arm, Model_Arm, Design_Group) or (Strategy_Arm, Model_Arm,
// problem), and is computed from the records carrying its key and from no other record. Cells
// are enumerated from the DECLARED keys rather than from the records present, so a cell with no
// records is reported with a zero denominator instead of vanishing from the report (Req 9.5).

import { DESIGN_GROUPS, type DesignGroup, type StrategyArm } from '@app/agent';

import { summarizeAgreement } from '../golden-judge.js';
import { summarizeInstrumentControl } from '../instrument-control.js';
import { isDeferredSample } from '../no-verdict-cause.js';
import type { SweepSampleRecord } from './results-log.js';
import { agreementRecords, instrumentSamples, verdictPairs } from './summary.js';

/** What a cell's records are the records OF. */
export type CampaignScope =
  | { readonly kind: 'group'; readonly group: DesignGroup }
  | { readonly kind: 'design'; readonly problemId: string };

/** One cell of the Campaign table: every count beside the denominator it is taken over. */
export interface CampaignCell {
  readonly strategyArm: StrategyArm;
  /** The arm's `modelSignature`, which is what makes two arms the same Model_Arm. */
  readonly modelArm: string;
  readonly scope: CampaignScope;
  /** The denominator of every count below. */
  readonly records: number;
  readonly instrumentValid: number;
  readonly failedReference: number;
  readonly referenceUnbuildable: number;
  readonly survivedMutants: number;
  readonly missedBug: number;
  readonly overStrict: number;
  /** Mutants the Golden_Judge killed and ours did not, summed over the cell (Req 6.6). */
  readonly coverageGapSurvivors: number;
  /**
   * Valid (compiling) mutants scored in this cell: the Coverage_Gap_Survivor denominator.
   *
   * Summed over every record, with no filter on instrument validity and none on whether the
   * sample was judged, because the per-mutant guard is deliberately decided on all the mutation
   * evidence a cell produced rather than on the admissible subset (Req 7.2, 7.3).
   */
  readonly scoredMutants: number;
  /** Slots this cell will run again on a resume (Req 8.7). */
  readonly deferred: number;
  /** The Golden_Agreement denominator. */
  readonly judged: number;
  /** The Golden_Agreement numerator, kept so a comparison can stay an exact rational. */
  readonly agreed: number;
  /** `agreed / judged`, or `null` when nothing was judged (Req 9.5). */
  readonly goldenAgreement: number | null;
}

/** Whether a record belongs to this cell: its arm, its model, and its scope all match. */
function inCell(
  record: SweepSampleRecord,
  cell: Omit<CampaignCell, keyof CampaignCounts>,
): boolean {
  if (record.strategyArm !== cell.strategyArm || record.modelSignature !== cell.modelArm) {
    return false;
  }
  return cell.scope.kind === 'group'
    ? record.designGroup === cell.scope.group
    : record.problemId === cell.scope.problemId;
}

/** The measured half of a cell, so the key half can be typed separately from it. */
export type CampaignCounts = Pick<
  CampaignCell,
  | 'records'
  | 'instrumentValid'
  | 'failedReference'
  | 'referenceUnbuildable'
  | 'survivedMutants'
  | 'missedBug'
  | 'overStrict'
  | 'coverageGapSurvivors'
  | 'scoredMutants'
  | 'deferred'
  | 'judged'
  | 'agreed'
  | 'goldenAgreement'
>;

/** Count one cell's records; every figure reuses the reader the per-arm summary uses. */
export function campaignCounts(records: readonly SweepSampleRecord[]): CampaignCounts {
  const instrument = summarizeInstrumentControl(instrumentSamples(records));
  const agreement = summarizeAgreement(verdictPairs(agreementRecords(records)));
  return {
    records: records.length,
    instrumentValid: instrument.validSamples,
    failedReference: instrument.failedReferenceSamples,
    referenceUnbuildable: instrument.unbuildableSamples,
    survivedMutants: instrument.survivedMutantsSamples,
    missedBug: agreement.loopPassGoldenFail,
    overStrict: agreement.loopFailGoldenPass,
    coverageGapSurvivors: records.reduce(
      (sum, record) => sum + (record.mutation?.coverageGapOperators.length ?? 0),
      0,
    ),
    scoredMutants: records.reduce((sum, record) => sum + (record.mutation?.validCount ?? 0), 0),
    deferred: records.filter((record) => isDeferredSample(record)).length,
    judged: agreement.judgedSamples,
    agreed: agreement.agreeingSamples,
    goldenAgreement:
      agreement.judgedSamples === 0 ? null : agreement.agreeingSamples / agreement.judgedSamples,
  };
}

/** Every declared cell key, Design_Group cells first, then per-design cells. */
function cellKeys(
  strategyArms: readonly StrategyArm[],
  modelArms: readonly string[],
  problemIds: readonly string[],
): readonly Omit<CampaignCell, keyof CampaignCounts>[] {
  const scopes: CampaignScope[] = [
    ...DESIGN_GROUPS.map((group) => ({ kind: 'group' as const, group })),
    ...problemIds.map((problemId) => ({ kind: 'design' as const, problemId })),
  ];
  return strategyArms.flatMap((strategyArm) =>
    modelArms.flatMap((modelArm) => scopes.map((scope) => ({ strategyArm, modelArm, scope }))),
  );
}

/**
 * Every cell of the Campaign table (pure).
 *
 * Takes only Campaign records: nothing here accepts a baseline reading, so a baseline record
 * cannot reach the table by type (Req 7.7, 8.10). The arms are the Campaign's own, so a later
 * Strategy_Arm never grows an earlier Campaign's table.
 */
export function campaignCells(
  records: readonly SweepSampleRecord[],
  strategyArms: readonly StrategyArm[],
  modelArms: readonly string[],
  problemIds: readonly string[],
): readonly CampaignCell[] {
  return cellKeys(strategyArms, modelArms, problemIds).map((key) => ({
    ...key,
    ...campaignCounts(records.filter((record) => inCell(record, key))),
  }));
}

/** Render a count beside its denominator, the form every Campaign figure is read in. */
function overDenominator(count: number, denominator: number): string {
  return `${count}/${denominator}`;
}

/** One cell as a rendered line; `undefined` for an agreement with no judged sample. */
function cellLine(cell: CampaignCell): string {
  const scope = cell.scope.kind === 'group' ? cell.scope.group : cell.scope.problemId;
  const agreement =
    cell.goldenAgreement === null
      ? 'undefined'
      : `${cell.goldenAgreement.toFixed(3)} (${overDenominator(cell.agreed, cell.judged)})`;
  return [
    `    ${cell.strategyArm.padEnd(9)} ${scope}:`,
    `instrument-valid ${overDenominator(cell.instrumentValid, cell.records)}`,
    `failed-reference ${overDenominator(cell.failedReference, cell.records)}`,
    `reference-unbuildable ${overDenominator(cell.referenceUnbuildable, cell.records)}`,
    `survived-mutants ${overDenominator(cell.survivedMutants, cell.records)}`,
    `missed-bug ${overDenominator(cell.missedBug, cell.records)}`,
    `over-strict ${overDenominator(cell.overStrict, cell.records)}`,
    `coverage-gap-survivors ${cell.coverageGapSurvivors}`,
    `deferred ${overDenominator(cell.deferred, cell.records)}`,
    `golden-agreement ${agreement}`,
  ].join(' ');
}

/** The Campaign table as lines, one block per Model_Arm (Req 9.1, 9.2, 9.4, 9.5). */
export function renderCampaignTable(cells: readonly CampaignCell[]): readonly string[] {
  const modelArms = [...new Set(cells.map((cell) => cell.modelArm))];
  return [
    'A/B CAMPAIGN TABLE (no figure pools two Strategy_Arms, Model_Arms, or Design_Groups)',
    ...modelArms.flatMap((modelArm) => [
      `  model-arm ${modelArm}:`,
      ...cells.filter((cell) => cell.modelArm === modelArm).map(cellLine),
    ]),
  ];
}
