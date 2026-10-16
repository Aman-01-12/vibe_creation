// The A/B Campaign's report block: the table, the deferred counts, the baseline reading, and
// the Campaign_Verdict (task 8.17). Pure: the CLI reads the files and hands the values in.
//
// The verdict's criterion is the Sweep_Manifest's recorded copy, never the running config's, so
// a config edited after the run cannot move the rule the run was judged by (Req 10.2, 10.4).

import type { StrategyArm } from '@app/agent';

import { renderBaselineReading, type BaselineReading } from './baseline-reading.js';
import { campaignCells, renderCampaignTable, type CampaignCell } from './campaign-table.js';
import type { ScoreboardCampaignConfig } from './config.js';
import type { SweepSampleRecord } from './results-log.js';
import {
  evaluateSuccessCriterion,
  isPreRegisteredCriterion,
  type CriterionResult,
  type ModelArmStreamingFigures,
  type StreamingFigures,
  type VerdictReport,
} from './success-criterion.js';

/** The scoreboard Campaign's two arms; `grounded` belongs to a different Campaign's table. */
export const SCOREBOARD_STRATEGY_ARMS: readonly StrategyArm[] = ['control', 'treatment'];

/** Everything the Campaign block is computed from. */
export interface CampaignReportInput {
  /** The Campaign's own records, already scoped to its config hash. */
  readonly records: readonly SweepSampleRecord[];
  readonly campaign: ScoreboardCampaignConfig;
  /** Each arm's `modelSignature`, in config order, de-duplicated. */
  readonly modelArms: readonly string[];
  readonly problemIds: readonly string[];
  /** The `successCriterion` the Sweep_Manifest recorded; untrusted until checked. */
  readonly manifestCriterion: unknown;
  /** Slots with a deferred record and no completed one (Req 10.9). */
  readonly deferredSlots: number;
  readonly baseline: BaselineReading;
  readonly baselineRunName: string;
}

/** The one group cell for a (Strategy_Arm, Model_Arm, Design_Group) key. */
function groupCell(
  cells: readonly CampaignCell[],
  key: { readonly strategyArm: StrategyArm; readonly modelArm: string; readonly group: string },
): CampaignCell | undefined {
  return cells.find(
    (cell) =>
      cell.strategyArm === key.strategyArm &&
      cell.modelArm === key.modelArm &&
      cell.scope.kind === 'group' &&
      cell.scope.group === key.group,
  );
}

function streamingFigures(cell: CampaignCell | undefined): StreamingFigures {
  return {
    records: cell?.records ?? 0,
    instrumentValid: cell?.instrumentValid ?? 0,
    missedBug: cell?.missedBug ?? 0,
    judged: cell?.judged ?? 0,
    agreed: cell?.agreed ?? 0,
  };
}

/** The verdict's per-Model_Arm figures, read off the Campaign cells (Req 10.12). */
export function verdictFigures(
  cells: readonly CampaignCell[],
  modelArms: readonly string[],
): readonly ModelArmStreamingFigures[] {
  const at = (strategyArm: StrategyArm, modelArm: string, group: string) =>
    groupCell(cells, { strategyArm, modelArm, group });
  return modelArms.map((modelArm) => ({
    modelArm,
    control: streamingFigures(at('control', modelArm, 'streaming')),
    treatment: streamingFigures(at('treatment', modelArm, 'streaming')),
    cycleExactInstrumentValid: {
      control: at('control', modelArm, 'cycle-exact')?.instrumentValid ?? 0,
      treatment: at('treatment', modelArm, 'cycle-exact')?.instrumentValid ?? 0,
    },
  }));
}

function criterionLine(name: string, result: CriterionResult | null): string {
  if (result === null) {
    return `    ${name}: not evaluated`;
  }
  const held = result.held ? 'held' : 'NOT held';
  return `    ${name}: ${held} (observed ${result.observed}, threshold ${result.threshold})`;
}

function figuresText(figures: StreamingFigures): string {
  const agreement = figures.judged === 0 ? 'undefined' : `${figures.agreed}/${figures.judged}`;
  return (
    `instrument-valid ${figures.instrumentValid}/${figures.records} ` +
    `missed-bug ${figures.missedBug}/${figures.records} golden-agreement ${agreement}`
  );
}

/** The verdict block: the verdict, each criterion, and every Model_Arm's figures. */
function verdictLines(report: VerdictReport, reason: string | null): readonly string[] {
  const { criteria } = report;
  return [
    `CAMPAIGN VERDICT: ${report.verdict}${reason === null ? '' : ` (${reason})`}`,
    criterionLine('10.5 streaming instrument-valid greater', criteria.instrumentValidGreater),
    criterionLine('10.6 model arms with missed-bug higher', criteria.missedBugNotHigher),
    criterionLine('10.7 model arms with golden agreement lower', criteria.agreementLowerAtMost),
    criterionLine('10.8 streaming delta over cycle-exact noise floor', criteria.beatsNoiseFloor),
    ...report.perModelArm.flatMap((arm) => [
      `  ${arm.modelArm} streaming:`,
      `    control   ${figuresText(arm.control)}`,
      `    treatment ${figuresText(arm.treatment)}`,
    ]),
  ];
}

/** Decide the verdict, refusing to decide under a criterion the manifest did not record. */
function decide(
  input: CampaignReportInput,
  figures: readonly ModelArmStreamingFigures[],
): { readonly report: VerdictReport; readonly reason: string | null } {
  if (!isPreRegisteredCriterion(input.manifestCriterion)) {
    // Fail safe: an unreadable recorded criterion decides nothing, never `succeeded`.
    return {
      report: evaluateSuccessCriterion(input.campaign.successCriterion, figures, 1),
      reason: 'the Sweep_Manifest holds no readable pre-registered Success_Criterion',
    };
  }
  return {
    report: evaluateSuccessCriterion(input.manifestCriterion, figures, input.deferredSlots),
    reason: input.deferredSlots > 0 ? `${input.deferredSlots} slot(s) still deferred` : null,
  };
}

/** Deferred records per (Strategy_Arm, Model_Arm), summed over both Design_Groups (Req 8.7). */
function deferredLines(
  cells: readonly CampaignCell[],
  modelArms: readonly string[],
): readonly string[] {
  return SCOREBOARD_STRATEGY_ARMS.flatMap((strategyArm) =>
    modelArms.map((modelArm) => {
      const deferred = cells
        .filter((cell) => cell.strategyArm === strategyArm && cell.modelArm === modelArm)
        .filter((cell) => cell.scope.kind === 'group')
        .reduce((sum, cell) => sum + cell.deferred, 0);
      return `  deferred ${strategyArm} ${modelArm}: ${deferred}`;
    }),
  );
}

/** The whole Campaign block, appended to the per-arm summary when a Campaign ran (pure). */
export function renderCampaignReport(input: CampaignReportInput): readonly string[] {
  const cells = campaignCells(
    input.records,
    SCOREBOARD_STRATEGY_ARMS,
    input.modelArms,
    input.problemIds,
  );
  const { report, reason } = decide(input, verdictFigures(cells, input.modelArms));
  return [
    '',
    ...renderCampaignTable(cells),
    '',
    ...deferredLines(cells, input.modelArms),
    '',
    ...renderBaselineReading(input.baseline, input.baselineRunName),
    '',
    ...verdictLines(report, reason),
  ];
}
