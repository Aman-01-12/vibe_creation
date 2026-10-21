// The committed Timing_Cross_Check artifact (task 12.7; Req 6.11): an edited or missing figure
// fails here by name, following the same committed-artifact-pin discipline
// `reportability-baseline.test.ts` uses for its own Pinned_Baseline.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { CrossCheckReport } from '../corpus/index.js';
import { TIMING_CROSS_CHECK_ARTIFACT_PATH } from './timing-cross-check-artifact.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, '../../..');

async function committedArtifact(): Promise<CrossCheckReport> {
  const text = await readFile(resolve(REPOSITORY_ROOT, TIMING_CROSS_CHECK_ARTIFACT_PATH), 'utf8');
  return JSON.parse(text) as CrossCheckReport;
}

describe('the committed Timing_Cross_Check artifact', () => {
  it('carries all six population figures alongside every count (Req 6.11)', async () => {
    const report = await committedArtifact();
    const { populations } = report;

    // The six figures `summarizeTimingPopulations` publishes (task 1.3), present in one object.
    expect(populations.sourceUniverse).toBeTypeOf('number');
    expect(populations.derivationPopulation).toBeTypeOf('number');
    expect(populations.derivedContracts).toBeTypeOf('number');
    expect(Array.isArray(populations.derivationExclusions)).toBe(true);
    expect(populations.scoringCohort).toBeTypeOf('number');
    expect(populations.timingAwareScoringCohort).toBeTypeOf('number');
    // Every count `CrossCheckReport` carries (Req 6.3, 6.4, 6.6), alongside `populations`.
    expect(report.agreeing).toBeTypeOf('number');
    expect(report.disagreeing).toBeTypeOf('number');
    expect(report.refusalCovered).toBeTypeOf('number');
    expect(report.falseRegistered).toBeTypeOf('number');
    expect(report.falseCombinational).toBeTypeOf('number');
    expect(report.clockedGroundTruthCombinational.agreeing).toBeTypeOf('number');
    expect(report.clockedGroundTruthCombinational.total).toBeTypeOf('number');
    expect(report.clockedGroundTruthRegistered.agreeing).toBeTypeOf('number');
    expect(report.clockedGroundTruthRegistered.total).toBeTypeOf('number');
    expect(Array.isArray(report.disagreements)).toBe(true);
    expect(Array.isArray(report.witnesses)).toBe(true);
  });

  it('reproduces the manifest ratchet holding: zero disagreements, alu refused', async () => {
    const report = await committedArtifact();

    expect(report.disagreements).toEqual([]);
    expect(report.refusalCovered).toBe(7);
  });
});
