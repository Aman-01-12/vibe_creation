// The baseline reader is a reproducibility reading: it decodes only v12 records of the
// configured hash, and reports itself unavailable rather than as a measured zero (Req 9.3).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readBaseline, renderBaselineReading, type BaselineCell } from './baseline-reading.js';

/** The four Model_Arms the Grounding Campaign runs. */
const MODEL_ARMS = ['moonshotai.kimi-k2.5', 'zai.glm-5', 'zai.glm-4.7', 'deepseek.v3.2'] as const;
const HERE = dirname(fileURLToPath(import.meta.url));

const HASH = 'e27c5b40e6e7983f';

/** One baseline line; a test overrides only what it is about. */
function line(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 12,
    configHash: HASH,
    modelSignature: 'model.a',
    problemId: 'p1',
    passed: true,
    goldenVerdict: 'failed',
    instrumentValidity: 'valid',
    instrumentDefect: null,
    mutation: { coverageGapOperators: ['ARITH_PLUS_TO_MINUS'] },
    ...overrides,
  });
}

function read(text: string | null) {
  return readBaseline({ text, configHash: HASH, modelArms: ['model.a'], problemIds: ['p1'] });
}

describe('readBaseline', () => {
  it('counts the Requirement 9.1 figures from v12 records of the configured hash only', () => {
    const text = [
      line(),
      line({
        passed: false,
        goldenVerdict: 'passed',
        instrumentValidity: 'invalid',
        instrumentDefect: 'TESTBENCH_FAILED_REFERENCE',
      }),
      line({ schemaVersion: 15 }),
      line({ configHash: 'ffffffffffffffff' }),
      'not json',
    ].join('\n');
    const reading = read(text);
    expect(reading).toEqual({
      available: true,
      cells: [
        {
          modelArm: 'model.a',
          problemId: 'p1',
          records: 2,
          instrumentValid: 1,
          failedReference: 1,
          referenceUnbuildable: 0,
          survivedMutants: 0,
          missedBug: 1,
          // The invalid instrument's disagreement is a defect, not an agreement figure.
          overStrict: 0,
          coverageGapSurvivors: 2,
          judged: 1,
          agreed: 0,
          goldenAgreement: 0,
        },
      ],
    });
  });

  it('renders unavailable, with the reason, for a missing file or no matching record', () => {
    expect(renderBaselineReading(read(null), 'base')[0]).toContain('baseline unavailable:');
    expect(renderBaselineReading(read(line({ schemaVersion: 14 })), 'base')[0]).toContain(
      'baseline unavailable:',
    );
    expect(
      renderBaselineReading(read(line({ configHash: 'ffffffffffffffff' })), 'base')[0],
    ).toContain('baseline unavailable:');
  });

  // The recorded baseline is gitignored local evidence, so this check runs where it exists.
  const runDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../.eval-runs/stage1-screen-dialect-v1',
  );
  it.runIf(existsSync(resolve(runDir, 'results.jsonl')))(
    'reads the recorded stage1-screen-dialect-v1 baseline as 495 records over 11 models and 15 designs',
    () => {
      const text = readFileSync(resolve(runDir, 'results.jsonl'), 'utf8');
      const rows = text
        .split('\n')
        .filter((row) => row.trim().length > 0)
        .map((row) => JSON.parse(row) as Record<string, string>);
      const modelArms = [...new Set(rows.map((row) => row.modelSignature ?? ''))];
      const problemIds = [...new Set(rows.map((row) => row.problemId ?? ''))];
      const reading = readBaseline({ text, configHash: HASH, modelArms, problemIds });
      if (!reading.available) {
        throw new Error(reading.reason);
      }
      expect(modelArms).toHaveLength(11);
      expect(problemIds).toHaveLength(15);
      expect(reading.cells.reduce((sum, cell) => sum + cell.records, 0)).toBe(495);
      // The recorded summary states each arm's golden figures; the reading must reproduce them.
      const summary = readFileSync(resolve(runDir, 'summary.txt'), 'utf8');
      const total = (pattern: RegExp, group = 1): number =>
        [...summary.matchAll(pattern)].reduce((sum, match) => sum + Number(match[group]), 0);
      const cells = reading.cells;
      const sum = (pick: (cell: BaselineCell) => number): number =>
        cells.reduce((acc, cell) => acc + pick(cell), 0);
      expect(sum((cell) => cell.agreed)).toBe(total(/golden judge:\s+(\d+)\/(\d+) agree/g, 1));
      expect(sum((cell) => cell.judged)).toBe(total(/golden judge:\s+(\d+)\/(\d+) agree/g, 2));
      expect(sum((cell) => cell.missedBug)).toBe(total(/MISSED BUGS:\s+(\d+)/g));
      expect(sum((cell) => cell.overStrict)).toBe(total(/over-strict:\s+(\d+) \(our/g));
    },
  );
});

describe('the Reference_Campaign as a baseline (testbench-spec-grounding, Req 11.6)', () => {
  // The Reference_Campaign's results log is gitignored local evidence of a paid run, so it is
  // absent from every clone. These two readings run where it exists; a skip is the correct
  // outcome elsewhere, and it is not a pass.
  const REFERENCE_RESULTS = resolve(HERE, '../../../.eval-runs/scoreboard-ab-v1/results.jsonl');
  const REFERENCE_RECORDED = existsSync(REFERENCE_RESULTS);

  if (!REFERENCE_RECORDED) {
    console.warn(
      '[baseline-reading] The Reference_Campaign reading was NOT exercised: .eval-runs/scoreboard-ab-v1/results.jsonl is absent.',
    );
  }

  it.runIf(REFERENCE_RECORDED)(
    'reads its v15 Control_Arm records for the 19 Campaign_Designs',
    () => {
      const config = JSON.parse(
        readFileSync(resolve(HERE, 'sweep.config.grounding-confirmatory-v1.json'), 'utf8'),
      ) as {
        readonly problems: { readonly ids: readonly string[] };
        readonly groundingCampaign: {
          readonly referenceCampaign: { readonly configHash: string; readonly schemaVersion: 15 };
        };
      };
      const reference = config.groundingCampaign.referenceCampaign;

      const reading = readBaseline({
        text: readFileSync(REFERENCE_RESULTS, 'utf8'),
        configHash: reference.configHash,
        schemaVersion: reference.schemaVersion,
        strategyArm: 'control',
        modelArms: MODEL_ARMS,
        problemIds: config.problems.ids,
      });

      expect(reading.available).toBe(true);
      if (!reading.available) {
        return;
      }
      expect(reading.cells).toHaveLength(MODEL_ARMS.length * 19);
      // Non-vacuous: the recorded run really holds Control_Arm records for these cells.
      expect(reading.cells.reduce((sum, cell) => sum + cell.records, 0)).toBeGreaterThan(0);
    },
  );

  it.runIf(REFERENCE_RECORDED)(
    'reads nothing when the arm or the schema does not match those records',
    () => {
      const parts = {
        text: readFileSync(REFERENCE_RESULTS, 'utf8'),
        configHash: '09bf541fcae9dbb9',
        modelArms: MODEL_ARMS,
        problemIds: ['rtllm/arithmetic/accu'],
      };

      // v12 is the stage-1 screen's schema, and those records are v15.
      expect(readBaseline({ ...parts, schemaVersion: 12, strategyArm: 'control' }).available).toBe(
        false,
      );
      // `grounded` records do not exist in the Reference_Campaign at all.
      expect(readBaseline({ ...parts, schemaVersion: 15, strategyArm: 'grounded' }).available).toBe(
        false,
      );
    },
  );
});
