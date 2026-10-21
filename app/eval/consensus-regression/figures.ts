// Reduces raw `ConsensusRegressionRunReport` samples to the `GatedFigures` task 18.2 fills
// (C20; Req 1.8, 1.9, 1.10, 9.8, 9.9, 9.10, 6.3, 6.4, 6.5, 9.6).
//
// Wrong_Label_Share and Verified_Correct_Share need only the delivered-design golden
// verdict, already on every sample. Attribution_Accuracy and Misattribution_Share need
// GROUND TRUTH per side of a failing pair - which design is actually wrong, which testbench
// is actually wrong - supplied by `harness.ts`'s `designGroundTruth`/`testbenchGroundTruth`,
// not derivable from the sample alone.
//
// Pilot_Pass_Share is NOT reduced here: task 18.1's pilot measures it directly over the
// Pilot_Design_Set and writes it straight into the measurement record; this function reports
// it as `null` so a caller must supply that figure rather than mistake a zero for a measurement.
//
// QUALITY_SIGNALS NEVER GATE (C9; Req 6.1-6.8)
//
//   `reduceQualitySignals` and `renderQualitySignals` below feed NOTHING into `GatedFigures`,
//   `decideConsensusRegressionGate`, or `trustVote` - that is the whole point of a Quality_
//   Signal. They exist only to print what the Introduction's own measured table already
//   showed (distinct-output-tuple count against mutation outcome, and the per-port Input_
//   Role assignments each run was rendered under), so a later run's own printed output
//   reproduces that table rather than needing a fresh ad-hoc analysis script.
//
// WHERE EACH FIGURE IS SOURCED FROM, AND WHY NOT `signaturesByDesign`
//
//   `SessionRecord.signaturesByDesign` (outcome.ts) is the field the design doc shows
//   carrying a pre-computed `distinctOutputCount` per (designId, testbenchId) pair - but
//   `runSession` does not populate that field yet (a pre-existing gap outside this task's
//   scope), so this reduction derives a per-TESTBENCH distinct-output-count directly from
//   `outcome.record.runMatrix.cells`: for each testbench, from any one of its cells that
//   carries a non-null `WaveformSignature` (a testbench behaves identically against every
//   design it runs against, since the signature is a property of the Reference_Model's own
//   rendered stimulus and state machine, not of the candidate under judgment - the FIRST
//   found signature for a testbench is as good as any other). The mutation outcome for the
//   same testbench comes from `outcome.record.testbenchTrust`, keyed by `testbenchId`. A
//   testbench is skipped from the bucket table only when NEITHER a signature nor a trust
//   entry can be found for it (never generated, or generated but excluded before any run).

import type { Ulid } from '@app/core';
import { distinctOutputCount, type WaveformSignature } from '@app/agent';
import type { RoleDeclaration } from '@app/tools';

import type { ConsensusRegressionSample, GroundTruthEntry } from './harness.js';

/** The subset of `GatedFigures` this reduction can compute from samples alone. */
export interface ReducedGatedFigures {
  readonly wrongLabelShare: number | null;
  readonly verifiedCorrectShare: number | null;
  readonly attributionAccuracyTestbench: number | null;
  readonly attributionAccuracyRtl: number | null;
  readonly misattributionShare: number | null;
}

/** `numerator / denominator`, or `null` when nothing was measured (an empty population). */
function shareOrNull(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** Wrong_Label_Share: share of Verified_Outcomes the Independent_Judge calls incorrect. */
function wrongLabelShareOf(samples: readonly ConsensusRegressionSample[]): number | null {
  const verified = samples.filter(
    (sample) => sample.outcome.kind === 'verified' && sample.goldenVerdict !== null,
  );
  const wrong = verified.filter((sample) => sample.goldenVerdict?.kind === 'failed');
  return shareOrNull(wrong.length, verified.length);
}

/** Verified_Correct_Share: share of ALL Sessions that deliver a golden-correct Verified_Outcome. */
function verifiedCorrectShareOf(samples: readonly ConsensusRegressionSample[]): number | null {
  const correct = samples.filter(
    (sample) => sample.outcome.kind === 'verified' && sample.goldenVerdict?.kind === 'passed',
  );
  return shareOrNull(correct.length, samples.length);
}

/** One side's ground-truth lookup, by id, across every sample. */
function groundTruthIndex(
  entriesBySample: readonly (readonly GroundTruthEntry[])[],
): ReadonlyMap<Ulid, boolean | null> {
  const index = new Map<Ulid, boolean | null>();
  for (const entries of entriesBySample) {
    for (const entry of entries) {
      index.set(entry.id, entry.wrong);
    }
  }
  return index;
}

/** One failing pair's ground truth, both sides resolved from their id-keyed indexes. */
interface JudgedPair {
  readonly designWrong: boolean | null;
  readonly testbenchWrong: boolean | null;
}

/** Whether exactly one side of a judged pair is at fault, per the requirements' own definition. */
function exactlyOneSideAtFault(pair: JudgedPair): boolean {
  return (
    pair.designWrong !== null &&
    pair.testbenchWrong !== null &&
    pair.designWrong !== pair.testbenchWrong
  );
}

/**
 * Attribution_Accuracy for one Fault_Verdict (Req 9.8, 9.9): the share of pairs given that
 * verdict, among pairs where exactly one side is at fault, for which the verdict names the
 * side actually at fault. `faultVerdicts` on the sample's own record names the predicted
 * side; `judgedPairsOf`'s ground truth names the real one.
 */
function attributionAccuracyOf(
  samples: readonly ConsensusRegressionSample[],
  verdictKind: 'TESTBENCH' | 'RTL',
): number | null {
  const designIndex = groundTruthIndex(samples.map((sample) => sample.designGroundTruth));
  const testbenchIndex = groundTruthIndex(samples.map((sample) => sample.testbenchGroundTruth));

  let calledCorrectCount = 0;
  let calledCount = 0;
  for (const sample of samples) {
    for (const verdict of sample.outcome.record.poolCorrectness.faultVerdicts) {
      if (verdict.verdict !== verdictKind) {
        continue;
      }
      const pair: JudgedPair = {
        designWrong: designIndex.get(verdict.designId) ?? null,
        testbenchWrong: testbenchIndex.get(verdict.testbenchId) ?? null,
      };
      if (!exactlyOneSideAtFault(pair)) {
        continue;
      }
      calledCount += 1;
      const actualFaultSide = pair.testbenchWrong === true ? 'TESTBENCH' : 'RTL';
      if (actualFaultSide === verdictKind) {
        calledCorrectCount += 1;
      }
    }
  }
  return shareOrNull(calledCorrectCount, calledCount);
}

/**
 * Misattribution_Share (Req 9.10): share of testbench-only-fault pairs given the verdict
 * `RTL` - the predictor blaming the design when only the testbench was actually wrong.
 */
function misattributionShareOf(samples: readonly ConsensusRegressionSample[]): number | null {
  const designIndex = groundTruthIndex(samples.map((sample) => sample.designGroundTruth));
  const testbenchIndex = groundTruthIndex(samples.map((sample) => sample.testbenchGroundTruth));

  let testbenchOnlyFaultCount = 0;
  let misattributedCount = 0;
  for (const sample of samples) {
    for (const verdict of sample.outcome.record.poolCorrectness.faultVerdicts) {
      const designWrong = designIndex.get(verdict.designId) ?? null;
      const testbenchWrong = testbenchIndex.get(verdict.testbenchId) ?? null;
      const isTestbenchOnlyFault = designWrong === false && testbenchWrong === true;
      if (!isTestbenchOnlyFault) {
        continue;
      }
      testbenchOnlyFaultCount += 1;
      if (verdict.verdict === 'RTL') {
        misattributedCount += 1;
      }
    }
  }
  return shareOrNull(misattributedCount, testbenchOnlyFaultCount);
}

/**
 * Reduce `samples` to the five figures measurable from a Session population alone (Req 1.8,
 * 1.9, 9.8, 9.9, 9.10). `null` on any figure means its population was empty, never a silent
 * zero - a caller must treat `null` as unmeasured, not as a passing 0%.
 */
export function reduceGatedFigures(
  samples: readonly ConsensusRegressionSample[],
): ReducedGatedFigures {
  return {
    wrongLabelShare: wrongLabelShareOf(samples),
    verifiedCorrectShare: verifiedCorrectShareOf(samples),
    attributionAccuracyTestbench: attributionAccuracyOf(samples, 'TESTBENCH'),
    attributionAccuracyRtl: attributionAccuracyOf(samples, 'RTL'),
    misattributionShare: misattributionShareOf(samples),
  };
}

// -- Quality_Signals: distinct-output-tuple count against mutation outcome, and the per-port
//    Input_Role assignments each run was rendered under (C9; Req 6.1-6.5). NEITHER feeds the
//    gate: see this file's header for why and for where each figure is sourced from. ----------

/** The five bucket rows of the Introduction's own measured table (Req 6.3, 6.4), in order. */
export const DISTINCT_OUTPUT_BUCKETS = ['1', '2', '3-4', '5-16', '>16'] as const;

export type DistinctOutputBucket = (typeof DISTINCT_OUTPUT_BUCKETS)[number];

/** One bucket's count of mutation-gate-failed and mutation-gate-passed testbenches. */
export interface DistinctOutputBucketRow {
  readonly bucket: DistinctOutputBucket;
  readonly mutationFailed: number;
  readonly mutationPassed: number;
}

/** One testbench's roles, with the problem it was generated for (Req 6.5). */
export interface RoleAssignmentRow {
  readonly problemId: string;
  readonly testbenchId: Ulid;
  readonly roles: RoleDeclaration;
}

/** The two Quality_Signal blocks (Req 6.3, 6.4, 6.5), both labelled `QUALITY SIGNAL (does not gate)`. */
export interface SweepQualitySignals {
  readonly distinctOutputByMutationOutcome: readonly DistinctOutputBucketRow[];
  readonly roleAssignments: readonly RoleAssignmentRow[];
}

/** Which of the five rows `count` falls into (Req 6.3's own table boundaries). */
function bucketOf(count: number): DistinctOutputBucket {
  if (count === 1) {
    return '1';
  }
  if (count === 2) {
    return '2';
  }
  if (count <= 4) {
    return '3-4';
  }
  if (count <= 16) {
    return '5-16';
  }
  return '>16';
}

/** The first non-null `WaveformSignature` any of `matrix.cells` carries for `testbenchId`. */
function firstSignatureFor(
  matrix: ConsensusRegressionSample['outcome']['record']['runMatrix'],
  testbenchId: Ulid,
): WaveformSignature | null {
  for (const cell of matrix.cells) {
    if (cell.testbenchId === testbenchId && cell.signature !== null) {
      return cell.signature;
    }
  }
  return null;
}

/**
 * Distinct_Output_Count against mutation outcome, over every testbench across every sample
 * (Req 6.1, 6.3, 6.4): one row per bucket, with a failed and a passed count. A testbench with
 * no signature anywhere in its own Run_Matrix row (never ran, or every run errored) contributes
 * to neither count - there is nothing to bucket, and nothing to read a mutation outcome from.
 */
function distinctOutputByMutationOutcomeOf(
  samples: readonly ConsensusRegressionSample[],
): readonly DistinctOutputBucketRow[] {
  const failedCounts = new Map<DistinctOutputBucket, number>();
  const passedCounts = new Map<DistinctOutputBucket, number>();
  for (const sample of samples) {
    const { runMatrix, testbenchTrust } = sample.outcome.record;
    for (const testbenchId of runMatrix.testbenchIds) {
      const signature = firstSignatureFor(runMatrix, testbenchId);
      if (signature === null) {
        continue;
      }
      const trust = testbenchTrust.find((entry) => entry.testbenchId === testbenchId);
      if (trust === undefined || trust.mutationOutcome.kind === 'not-run') {
        continue;
      }
      const bucket = bucketOf(distinctOutputCount(signature));
      const counts = trust.mutationOutcome.kind === 'passed' ? passedCounts : failedCounts;
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
  }
  return DISTINCT_OUTPUT_BUCKETS.map((bucket) => ({
    bucket,
    mutationFailed: failedCounts.get(bucket) ?? 0,
    mutationPassed: passedCounts.get(bucket) ?? 0,
  }));
}

/** Every testbench's rendered Role_Declaration, paired with the problem it was drafted for (Req 6.5). */
function roleAssignmentsOf(
  samples: readonly ConsensusRegressionSample[],
): readonly RoleAssignmentRow[] {
  return samples.flatMap((sample) =>
    sample.outcome.record.roleDeclarations.map((declaration) => ({
      problemId: sample.problemId,
      testbenchId: declaration.testbenchId,
      roles: declaration.roles,
    })),
  );
}

/**
 * Reduce `samples` to the two Quality_Signal blocks (Req 6.1-6.5). Pure: reads only each
 * sample's own `outcome.record`, never a filesystem or a fresh simulate call.
 */
export function reduceQualitySignals(
  samples: readonly ConsensusRegressionSample[],
): SweepQualitySignals {
  return {
    distinctOutputByMutationOutcome: distinctOutputByMutationOutcomeOf(samples),
    roleAssignments: roleAssignmentsOf(samples),
  };
}

/** The fixed label every Quality_Signal block carries (Req 6.3, 6.5): it never gates. */
export const QUALITY_SIGNAL_LABEL = 'QUALITY SIGNAL (does not gate)' as const;

/**
 * Criterion 9.6's own sentence: comparability with the 46-problem Baseline_Sweep ends at this
 * identity change (`CONSENSUS_HARNESS_VERSION` 2 -> 3), so a reader of this printed text does
 * not pool these figures with that run's.
 */
export const BASELINE_SWEEP_COMPARABILITY_SENTENCE: string =
  'Comparability with the Baseline_Sweep .eval-runs/consensus-sweep-2026-10-17T13-20-39-950Z ' +
  'ENDS at this run: CONSENSUS_HARNESS_VERSION moved, so these figures are not the same ' +
  'population and must not be pooled with that run.';

/** One line per bucket row, in the Introduction table's own column order. */
function renderDistinctOutputRows(rows: readonly DistinctOutputBucketRow[]): readonly string[] {
  return rows.map(
    (row) =>
      `  ${row.bucket.padEnd(5)} mutation gate failed: ${String(row.mutationFailed).padStart(3)}` +
      `   mutation gate passed: ${String(row.mutationPassed).padStart(3)}`,
  );
}

/** One line per testbench's rendered roles, problem and testbenchId named for traceability. */
function renderRoleAssignmentRows(rows: readonly RoleAssignmentRow[]): readonly string[] {
  return rows.map((row) => {
    const roleText = row.roles.map((role) => `${role.portName}=${role.role}`).join(', ');
    return `  ${row.problemId} ${row.testbenchId}: ${roleText}`;
  });
}

/**
 * Render both Quality_Signal blocks plus criterion 9.6's comparability sentence as plain text
 * (Req 6.3, 6.4, 6.5, 9.6), testable with no paid run: a pure function of `signals` alone.
 */
export function renderQualitySignals(signals: SweepQualitySignals): string {
  const lines: string[] = [
    `${QUALITY_SIGNAL_LABEL}: Distinct_Output_Count against mutation outcome`,
    ...renderDistinctOutputRows(signals.distinctOutputByMutationOutcome),
    '',
    `${QUALITY_SIGNAL_LABEL}: per-port Input_Role assignments`,
    ...renderRoleAssignmentRows(signals.roleAssignments),
    '',
    BASELINE_SWEEP_COMPARABILITY_SENTENCE,
  ];
  return lines.join('\n');
}
