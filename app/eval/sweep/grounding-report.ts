// The Grounding Campaign's report block (testbench-spec-grounding, C16): the cells, the
// Slot_Pair figures, the deferred counts, the cross-run reading, and the verdict.
//
// Pure: the CLI reads the files and hands the values in. The verdict's criterion is the
// Sweep_Manifest's RECORDED copy, never the running config's, so a config edited after the run
// cannot move the rule the run was judged by.

import { NO_VERDICT_CAUSES, isDeferrableCause } from '../no-verdict-cause.js';
import { renderBaselineReading, type BaselineReading } from './baseline-reading.js';
import {
  PRE_REGISTERED_GROUNDING_CRITERION,
  evaluateGroundingCriterion,
  isPreRegisteredGroundingCriterion,
  type ClauseOutcome,
  type GroundingFigures,
  type GroundingVerdictReport,
  type GuardFigures,
  type MutantFigures,
  type NonInferiorityClause,
  type SlotPairOutcome,
} from './grounding-criterion.js';
import {
  GROUNDING_STRATEGY_ARMS,
  groundingCells,
  slotPairs,
  type GroundingCell,
  type GroundingStrategyArm,
} from './grounding-table.js';
import type { SweepSampleRecord } from './results-log.js';

/** The label that stops a cross-run number being read as a Campaign figure (Req 2.6). */
export const CROSS_RUN_LABEL =
  'cross-run reading across two Config_Identities - NOT a Campaign figure, and used in no Campaign_Verdict';

/** The six clauses the Campaign_Verdict is composed from, in render order (Req 1.5). */
export const CONFIRMATORY_CLAUSES = Object.freeze([
  { id: '6.1', label: 'pooled exact McNemar' },
  { id: '6.2', label: 'model arms greater' },
  { id: '6.3', label: 'designs greater' },
  { id: '7.1', label: 'coverage-gap rate non-inferior' },
  { id: '8.1', label: 'missed-bug rate non-inferior' },
  { id: '8.2', label: 'golden agreement non-inferior' },
] as const);

/** One clause id, so the report and the closeout cannot disagree on the list. */
export type ConfirmatoryClauseId = (typeof CONFIRMATORY_CLAUSES)[number]['id'];

/** Everything the Grounding block is computed from. */
export interface GroundingReportInput {
  /** The Campaign's own records, already scoped to its config hash. */
  readonly records: readonly SweepSampleRecord[];
  /** Each arm's `modelSignature`, in config order, de-duplicated. */
  readonly modelArms: readonly string[];
  readonly problemIds: readonly string[];
  /** The `groundingCampaign.successCriterion` the Sweep_Manifest recorded; untrusted. */
  readonly manifestCriterion: unknown;
  /** Slots with a deferred record and no completed one. */
  readonly deferredSlots: number;
  readonly baseline: BaselineReading;
  readonly baselineRunName: string;
}

/** Render a count beside its denominator, the form every Campaign figure is read in. */
function over(count: number, denominator: number): string {
  return `${String(count)}/${String(denominator)}`;
}

/**
 * A rate as its count over its denominator and then the quotient.
 *
 * Derived here rather than stored, so a zero denominator reads as `undefined` and never as
 * `0.000`, which would be a different and much stronger claim (Req 10.5).
 */
function rateText(count: number, denominator: number): string {
  const rate = denominator === 0 ? 'undefined' : (count / denominator).toFixed(3);
  return `${over(count, denominator)} ${rate}`;
}

/** A signed difference in percentage points, or `undefined` when a denominator is missing. */
function pointsText(points: number | null): string {
  return points === null ? 'undefined' : `${points >= 0 ? '+' : ''}${points.toFixed(2)}pt`;
}

/** The scope of a cell as one short label. */
function scopeLabel(cell: GroundingCell): string {
  if (cell.scope.kind === 'arm') {
    return 'ALL';
  }
  return cell.scope.kind === 'model' ? cell.scope.modelArm : cell.scope.problemId;
}

/** The refusal codes a cell actually saw, so a line is not 7 zeros wide. */
function refusalText(cell: GroundingCell): string {
  const seen = Object.entries(cell.parseRefusals).filter(([, count]) => count > 0);
  if (seen.length === 0) {
    return 'parse-refusals none';
  }
  const parts = seen.map(([code, count]) => `${code} ${String(count)}`);
  return `parse-refusals ${parts.join(' ')}`;
}

/** One cell as a rendered line; `undefined` for an agreement with no judged sample. */
function cellLine(cell: GroundingCell): string {
  const agreement =
    cell.goldenAgreement === null
      ? 'undefined'
      : `${cell.goldenAgreement.toFixed(3)} (${over(cell.agreed, cell.judged)})`;
  return [
    `    ${cell.strategyArm.padEnd(8)} ${scopeLabel(cell)}:`,
    `instrument-valid ${over(cell.instrumentValid, cell.records)}`,
    `positive-control-passed ${over(cell.positiveControlPassed, cell.records)}`,
    `failed-reference ${over(cell.failedReference, cell.records)}`,
    `reference-unbuildable ${over(cell.referenceUnbuildable, cell.records)}`,
    `survived-mutants ${over(cell.survivedMutants, cell.records)}`,
    `missed-bug ${over(cell.missedBug, cell.records)}`,
    `over-strict ${over(cell.overStrict, cell.records)}`,
    `known-answer-only ${over(cell.knownAnswerOnlyFailures, cell.records)}`,
    `watchdog-stops ${over(cell.watchdogStops, cell.records)}`,
    `resource-exhausted ${over(cell.resourceExhausted, cell.records)}`,
    `waveform-missing ${over(cell.waveformMissing, cell.records)}`,
    `deferred ${over(cell.deferred, cell.records)}`,
    `judged ${over(cell.judged, cell.records)}`,
    `coverage-gap-survivors ${rateText(cell.coverageGapSurvivors, cell.scoredMutants)}`,
    `golden-agreement ${agreement}`,
    refusalText(cell),
  ].join(' ');
}

/** The Slot_Pair figures of Requirement 11.5, pooled and per Model_Arm. */
function slotPairLines(
  pairs: readonly SlotPairOutcome[],
  modelArms: readonly string[],
): readonly string[] {
  const line = (label: string, scoped: readonly SlotPairOutcome[]): string => {
    const groundedOnly = scoped.filter((p) => p.groundedValid && !p.controlValid).length;
    const controlOnly = scoped.filter((p) => p.controlValid && !p.groundedValid).length;
    return (
      `  slot-pairs ${label}: pairs ${String(scoped.length)} ` +
      `grounded-only-valid ${String(groundedOnly)} control-only-valid ${String(controlOnly)}`
    );
  };
  return [
    line('pooled', pairs),
    ...modelArms.map((modelArm) =>
      line(
        modelArm,
        pairs.filter((p) => p.modelArm === modelArm),
      ),
    ),
  ];
}

/**
 * Deferred records per Strategy_Arm and Model_Arm, then per cause (Req 9.6).
 *
 * The per-cause tally is enumerated from the closed vocabulary rather than from the causes
 * seen, so a cause with no deferrals is reported at zero instead of vanishing.
 */
function deferredLines(
  cells: readonly GroundingCell[],
  modelArms: readonly string[],
  records: readonly SweepSampleRecord[],
): readonly string[] {
  const deferrable = NO_VERDICT_CAUSES.filter((cause) => isDeferrableCause(cause));
  return [
    ...GROUNDING_STRATEGY_ARMS.flatMap((strategyArm) =>
      modelArms.map((modelArm) => {
        const cell = cells.find(
          (candidate) =>
            candidate.strategyArm === strategyArm &&
            candidate.scope.kind === 'model' &&
            candidate.scope.modelArm === modelArm,
        );
        return `  deferred ${strategyArm} ${modelArm}: ${String(cell?.deferred ?? 0)}`;
      }),
    ),
    ...GROUNDING_STRATEGY_ARMS.map((strategyArm) => {
      const own = records.filter((record) => record.strategyArm === strategyArm);
      const parts = deferrable.map((cause) => {
        // Set membership, never a `Record` indexed by an untrusted value.
        const count = own.filter((record) => record.noVerdictCause === cause).length;
        return `${cause} ${String(count)}`;
      });
      return `  deferred-by-cause ${strategyArm}: ${parts.join(' ')}`;
    }),
  ];
}

/** One arm's arm-scope cell, the single place both guard projections are read from. */
function armCell(
  cells: readonly GroundingCell[],
  strategyArm: GroundingStrategyArm,
): GroundingCell | undefined {
  return cells.find(
    (candidate) => candidate.strategyArm === strategyArm && candidate.scope.kind === 'arm',
  );
}

/** The sample-level guard figures of one arm, summed over its arm-scope cell. */
function guardFiguresOf(
  cells: readonly GroundingCell[],
  strategyArm: GroundingStrategyArm,
): GuardFigures {
  const cell = armCell(cells, strategyArm);
  return {
    missedBug: cell?.missedBug ?? 0,
    judged: cell?.judged ?? 0,
    agreed: cell?.agreed ?? 0,
  };
}

/** The per-mutant figures of one arm, summed over the same arm-scope cell. */
function mutantFiguresOf(
  cells: readonly GroundingCell[],
  strategyArm: GroundingStrategyArm,
): MutantFigures {
  const cell = armCell(cells, strategyArm);
  return {
    coverageGapSurvivors: cell?.coverageGapSurvivors ?? 0,
    scoredMutants: cell?.scoredMutants ?? 0,
  };
}

/** A cell at one scope, or undefined when the Campaign declared no such cell. */
function modelCell(
  cells: readonly GroundingCell[],
  strategyArm: GroundingStrategyArm,
  modelArm: string,
): GroundingCell | undefined {
  return cells.find(
    (candidate) =>
      candidate.strategyArm === strategyArm &&
      candidate.scope.kind === 'model' &&
      candidate.scope.modelArm === modelArm,
  );
}

/**
 * The per-Model_Arm coverage-gap evidence the pooled clause 7.1 decides over (Req 10.1, 10.2).
 *
 * Reported per Strategy_Arm in total and per pair of Strategy_Arm and Model_Arm, with the
 * grounded-minus-control difference beside each Model_Arm, and labelled as evidence rather
 * than as a clause so no reader takes a per-Model_Arm difference for the decision.
 */
function coverageGapLines(
  cells: readonly GroundingCell[],
  modelArms: readonly string[],
): readonly string[] {
  const rateOf = (cell: GroundingCell | undefined): number | null =>
    cell === undefined || cell.scoredMutants === 0
      ? null
      : (100 * cell.coverageGapSurvivors) / cell.scoredMutants;
  const line = (
    strategyArm: GroundingStrategyArm,
    scope: string,
    cell: GroundingCell | undefined,
  ): string =>
    `    coverage-gap ${strategyArm.padEnd(8)} ${scope}: ` +
    rateText(cell?.coverageGapSurvivors ?? 0, cell?.scoredMutants ?? 0);
  return [
    '  coverage-gap survivors per mutant (per-Model_Arm evidence; clause 7.1 decides pooled)',
    ...GROUNDING_STRATEGY_ARMS.map((strategyArm) =>
      line(strategyArm, 'ALL', armCell(cells, strategyArm)),
    ),
    ...modelArms.flatMap((modelArm) => {
      const control = modelCell(cells, 'control', modelArm);
      const grounded = modelCell(cells, 'grounded', modelArm);
      const controlRate = rateOf(control);
      const groundedRate = rateOf(grounded);
      const difference =
        controlRate === null || groundedRate === null ? null : groundedRate - controlRate;
      return [
        line('control', modelArm, control),
        `${line('grounded', modelArm, grounded)} difference ${pointsText(difference)}`,
      ];
    }),
  ];
}

/** The operators behind the coverage gaps, per Strategy_Arm and Model_Arm (Req 10.3). */
function operatorLines(
  cells: readonly GroundingCell[],
  modelArms: readonly string[],
): readonly string[] {
  const tally = (cell: GroundingCell | undefined): string => {
    const operators = cell?.coverageGapOperators ?? [];
    return operators.length === 0
      ? 'none'
      : operators.map((entry) => `${entry.operator} ${String(entry.count)}`).join(' ');
  };
  return [
    '  coverage-gap operators (most frequent first)',
    ...GROUNDING_STRATEGY_ARMS.flatMap((strategyArm) => [
      `    operators ${strategyArm.padEnd(8)} ALL: ${tally(armCell(cells, strategyArm))}`,
      ...modelArms.map(
        (modelArm) =>
          `    operators ${strategyArm.padEnd(8)} ${modelArm}: ${tally(modelCell(cells, strategyArm, modelArm))}`,
      ),
    ]),
  ];
}

/** How one clause's outcome reads, with the third state visible rather than collapsed. */
function outcomeText(outcome: ClauseOutcome): string {
  if (outcome === 'held') {
    return 'held';
  }
  return outcome === 'not-held' ? 'NOT held' : 'not decided';
}

/** A guard clause's figures, both rates, the difference, and the margin it was judged by. */
function guardText<Figures>(
  clause: NonInferiorityClause<Figures>,
  numeratorOf: (figures: Figures) => number,
  denominatorOf: (figures: Figures) => number,
  showFloor: boolean,
): string {
  const parts = [
    `control ${rateText(numeratorOf(clause.control), denominatorOf(clause.control))}`,
    `grounded ${rateText(numeratorOf(clause.grounded), denominatorOf(clause.grounded))}`,
    `difference ${pointsText(clause.differencePoints)}`,
    `margin ${String(clause.marginPercent)}pt`,
  ];
  return showFloor
    ? [...parts, `min-denominator ${String(clause.minDenominator)}`].join(', ')
    : parts.join(', ');
}

/** The parenthetical of one clause: every quantity its requirement lists. */
function clauseDetail(
  id: ConfirmatoryClauseId,
  criteria: GroundingVerdictReport['criteria'],
): string {
  switch (id) {
    case '6.1':
      return (
        `b ${String(criteria.pooledSignTest.b)}, c ${String(criteria.pooledSignTest.c)}, ` +
        `p ${criteria.pooledSignTest.pValue.toFixed(5)}`
      );
    case '6.2':
      return (
        `observed ${String(criteria.modelArmsGreater.observed)}, ` +
        `threshold ${String(criteria.modelArmsGreater.threshold)}`
      );
    case '6.3':
      return (
        `greater ${String(criteria.designsGreater.greater)}, ` +
        `lower ${String(criteria.designsGreater.lower)}, ` +
        `min ${String(criteria.designsGreater.minGreater)}, ` +
        `net ${String(criteria.designsGreater.minNet)}`
      );
    case '7.1':
      return guardText(
        criteria.coverageGapNonInferior,
        (figures) => figures.coverageGapSurvivors,
        (figures) => figures.scoredMutants,
        false,
      );
    case '8.1':
      return guardText(
        criteria.missedBugNonInferior,
        (figures) => figures.missedBug,
        (figures) => figures.judged,
        true,
      );
    case '8.2':
      return guardText(
        criteria.agreementNonInferior,
        (figures) => figures.agreed,
        (figures) => figures.judged,
        true,
      );
  }
}

/** One clause's outcome, by id, so the list and the renderer cannot drift apart. */
function clauseOutcome(
  id: ConfirmatoryClauseId,
  criteria: GroundingVerdictReport['criteria'],
): ClauseOutcome {
  switch (id) {
    case '6.1':
      return criteria.pooledSignTest.outcome;
    case '6.2':
      return criteria.modelArmsGreater.outcome;
    case '6.3':
      return criteria.designsGreater.outcome;
    case '7.1':
      return criteria.coverageGapNonInferior.outcome;
    case '8.1':
      return criteria.missedBugNonInferior.outcome;
    case '8.2':
      return criteria.agreementNonInferior.outcome;
  }
}

/** Every clause, in order, with its outcome and the numbers it was decided on (Req 1.5). */
function criterionLines(report: GroundingVerdictReport): readonly string[] {
  return [
    ...CONFIRMATORY_CLAUSES.map(
      (clause) =>
        `    ${clause.id} ${clause.label}: ${outcomeText(clauseOutcome(clause.id, report.criteria))} ` +
        `(${clauseDetail(clause.id, report.criteria)})`,
    ),
    `    pairs observed ${String(report.pairsObserved)} of ${String(report.pairsExpected)}`,
  ];
}

/** Decide the verdict, refusing to decide under a criterion the manifest did not record. */
function decide(
  input: GroundingReportInput,
  figures: GroundingFigures,
): { readonly report: GroundingVerdictReport; readonly reason: string | null } {
  if (!isPreRegisteredGroundingCriterion(input.manifestCriterion)) {
    // Fail safe: an unreadable recorded criterion decides nothing, never `succeeded`.
    return {
      report: evaluateGroundingCriterion(PRE_REGISTERED_GROUNDING_CRITERION, figures, 1),
      reason: 'the Sweep_Manifest holds no readable pre-registered Success_Criterion',
    };
  }
  return {
    report: evaluateGroundingCriterion(input.manifestCriterion, figures, input.deferredSlots),
    reason:
      input.deferredSlots > 0 ? `${String(input.deferredSlots)} slot(s) still deferred` : null,
  };
}

/** The whole Grounding block, appended to the per-arm summary when a Campaign ran (pure). */
export function renderGroundingReport(input: GroundingReportInput): readonly string[] {
  const cells = groundingCells(input.records, input.modelArms, input.problemIds);
  const pairs = slotPairs(input.records);
  const figures: GroundingFigures = {
    pairs,
    control: guardFiguresOf(cells, 'control'),
    grounded: guardFiguresOf(cells, 'grounded'),
    controlMutants: mutantFiguresOf(cells, 'control'),
    groundedMutants: mutantFiguresOf(cells, 'grounded'),
  };
  const { report, reason } = decide(input, figures);
  return [
    '',
    'GROUNDING CAMPAIGN TABLE (no figure pools two Strategy_Arms, Model_Arms, or designs)',
    ...cells.map(cellLine),
    '',
    ...slotPairLines(pairs, input.modelArms),
    '',
    ...coverageGapLines(cells, input.modelArms),
    '',
    ...operatorLines(cells, input.modelArms),
    '',
    ...deferredLines(cells, input.modelArms, input.records),
    '',
    CROSS_RUN_LABEL,
    ...renderBaselineReading(input.baseline, input.baselineRunName),
    '',
    `GROUNDING VERDICT: ${report.verdict}${reason === null ? '' : ` (${reason})`}`,
    ...criterionLines(report),
  ];
}
