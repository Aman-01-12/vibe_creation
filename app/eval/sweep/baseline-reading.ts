// The recorded baseline, read as a REPRODUCIBILITY READING and nothing else (C10).
//
// The baseline campaign's records are schema 12. This module decodes only the fields
// Requirement 9.1 needs, into a type that is NOT a `SweepSampleRecord`, so a baseline record
// cannot reach the Campaign table, the resume index, or the Campaign_Verdict by type. It is a
// reading beside the Campaign's own Control_Arm figures, never a migration of one into the other.

import type { MutationOperatorId } from '../mutation-control.js';

/** The schema the baseline campaign's records were written at; nothing else is read. */
export const BASELINE_SCHEMA_VERSION = 12;

/**
 * The schema versions a baseline file may be read at.
 *
 * TWO, not one, because two different earlier runs are read as baselines: the stage-1 screen
 * wrote v12 records, and the Reference_Campaign wrote v15. A reader that accepted "any
 * version" would silently read a v16 record and pool a Campaign into its own baseline.
 */
export const READABLE_BASELINE_SCHEMA_VERSIONS = [12, 15] as const;
export type ReadableBaselineSchemaVersion = (typeof READABLE_BASELINE_SCHEMA_VERSIONS)[number];

/** Longest baseline file this reader accepts, in characters, matching the results reader. */
const MAX_BASELINE_CHARS = 67_108_864;

/** One baseline cell: the Requirement 9.1 figures for one (Model_Arm, design). */
export interface BaselineCell {
  readonly modelArm: string;
  readonly problemId: string;
  readonly records: number;
  readonly instrumentValid: number;
  readonly failedReference: number;
  readonly referenceUnbuildable: number;
  readonly survivedMutants: number;
  readonly missedBug: number;
  readonly overStrict: number;
  readonly coverageGapSurvivors: number;
  readonly judged: number;
  readonly agreed: number;
  readonly goldenAgreement: number | null;
}

/** A baseline reading, or the reason there is none to render. */
export type BaselineReading =
  | { readonly available: true; readonly cells: readonly BaselineCell[] }
  | { readonly available: false; readonly reason: string };

/** The one baseline line this reader understands, already narrowed. */
interface BaselineSample {
  readonly modelArm: string;
  readonly problemId: string;
  readonly passed: boolean;
  readonly goldenPassed: boolean | null;
  readonly instrumentValidity: string | null;
  readonly instrumentDefect: string | null;
  readonly coverageGapSurvivors: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** The golden outcome as a pass/not-pass, or `null` when the judge recorded nothing. */
function goldenPassedOf(value: unknown): boolean | null {
  return typeof value === 'string' ? value === 'passed' : null;
}

/** Count this line's coverage-gap operators; an unreadable block contributes none. */
function coverageGapsOf(value: unknown): number {
  const mutation = asRecord(value);
  const operators = mutation?.coverageGapOperators;
  return Array.isArray(operators) ? (operators as readonly MutationOperatorId[]).length : 0;
}

/**
 * Narrow one baseline line, or `null` to drop it.
 *
 * Strict about the two fields a figure is keyed by and about the schema and config hash;
 * lenient about the rest, because a dropped baseline line costs a reading, never a verdict.
 */
function readBaselineSample(
  raw: unknown,
  configHash: string,
  schemaVersion: ReadableBaselineSchemaVersion,
  strategyArm: string | undefined,
): BaselineSample | null {
  const record = asRecord(raw);
  if (record === null || record.schemaVersion !== schemaVersion) {
    return null;
  }
  if (record.configHash !== configHash) {
    return null;
  }
  // When an arm is named, a record carrying another arm is a different measurement.
  if (strategyArm !== undefined && record.strategyArm !== strategyArm) {
    return null;
  }
  const modelArm = nonEmptyString(record.modelSignature);
  const problemId = nonEmptyString(record.problemId);
  if (modelArm === null || problemId === null || typeof record.passed !== 'boolean') {
    return null;
  }
  return {
    modelArm,
    problemId,
    passed: record.passed,
    goldenPassed: goldenPassedOf(record.goldenVerdict),
    instrumentValidity: nonEmptyString(record.instrumentValidity),
    instrumentDefect: nonEmptyString(record.instrumentDefect),
    coverageGapSurvivors: coverageGapsOf(record.mutation),
  };
}

/** Count one (Model_Arm, design) group of baseline lines. */
function countBaselineCell(
  modelArm: string,
  problemId: string,
  samples: readonly BaselineSample[],
): BaselineCell {
  // Read over samples whose instrument is not invalid, exactly as the Campaign table reads it.
  const judged = samples.filter(
    (sample) => sample.goldenPassed !== null && sample.instrumentValidity !== 'invalid',
  );
  const agreed = judged.filter((sample) => sample.passed === sample.goldenPassed).length;
  const defect = (code: string): number =>
    samples.filter((sample) => sample.instrumentDefect === code).length;
  return {
    modelArm,
    problemId,
    records: samples.length,
    instrumentValid: samples.filter((sample) => sample.instrumentValidity === 'valid').length,
    failedReference: defect('TESTBENCH_FAILED_REFERENCE'),
    referenceUnbuildable: defect('TESTBENCH_REFERENCE_UNBUILDABLE'),
    survivedMutants: defect('TESTBENCH_SURVIVED_MUTANTS'),
    missedBug: judged.filter((sample) => sample.passed && sample.goldenPassed === false).length,
    overStrict: judged.filter((sample) => !sample.passed && sample.goldenPassed === true).length,
    coverageGapSurvivors: samples.reduce((sum, sample) => sum + sample.coverageGapSurvivors, 0),
    judged: judged.length,
    agreed,
    goldenAgreement: judged.length === 0 ? null : agreed / judged.length,
  };
}

/**
 * Read the baseline file as a reproducibility reading (Req 9.3).
 *
 * A missing file, a wrong schema, or a wrong config hash renders as unavailable with the
 * reason, because a baseline that silently read as empty would look like a measured zero.
 */
export function readBaseline(parts: {
  readonly text: string | null;
  readonly configHash: string;
  readonly modelArms: readonly string[];
  readonly problemIds: readonly string[];
  /** Which schema those records are; defaults to the stage-1 screen's v12. */
  readonly schemaVersion?: ReadableBaselineSchemaVersion;
  /** When set, only records carrying this Strategy_Arm are read. */
  readonly strategyArm?: string;
}): BaselineReading {
  const schemaVersion = parts.schemaVersion ?? BASELINE_SCHEMA_VERSION;
  if (parts.text === null) {
    return { available: false, reason: 'the baseline results file could not be read' };
  }
  if (parts.text.length > MAX_BASELINE_CHARS) {
    return { available: false, reason: 'the baseline results file is too large to read' };
  }
  const samples: BaselineSample[] = [];
  for (const line of parts.text.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      // One damaged line costs that line; the reading says how many lines it read.
      continue;
    }
    const sample = readBaselineSample(raw, parts.configHash, schemaVersion, parts.strategyArm);
    if (sample !== null) {
      samples.push(sample);
    }
  }
  if (samples.length === 0) {
    return {
      available: false,
      reason: `the baseline file holds no v${String(schemaVersion)} record for the configured baseline hash`,
    };
  }
  return {
    available: true,
    cells: parts.modelArms.flatMap((modelArm) =>
      parts.problemIds.map((problemId) =>
        countBaselineCell(
          modelArm,
          problemId,
          samples.filter(
            (sample) => sample.modelArm === modelArm && sample.problemId === problemId,
          ),
        ),
      ),
    ),
  };
}

/** The baseline block, labelled so it can never be cited as a Campaign figure (Req 9.3). */
export function renderBaselineReading(
  reading: BaselineReading,
  runName: string,
): readonly string[] {
  if (!reading.available) {
    return [`recorded baseline (${runName}): baseline unavailable: ${reading.reason}`];
  }
  return [
    `recorded baseline (${runName}), reproducibility reading only - NOT a Campaign figure`,
    ...reading.cells.map(
      (cell) =>
        `    ${cell.modelArm} ${cell.problemId}: instrument-valid ${cell.instrumentValid}/${cell.records} ` +
        `missed-bug ${cell.missedBug}/${cell.records} over-strict ${cell.overStrict}/${cell.records} ` +
        `golden-agreement ${cell.goldenAgreement === null ? 'undefined' : cell.goldenAgreement.toFixed(3)}`,
    ),
  ];
}
