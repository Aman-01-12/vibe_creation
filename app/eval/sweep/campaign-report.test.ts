// The Campaign block of the summary (task 8.17): deterministic over the same records and
// manifest, decided only under the manifest's recorded criterion. Requirements 8.7, 9.1, 9.3,
// 10.4, 10.12.

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { SIMULATION_HARNESS_VERSION } from '@app/tools';

import { renderCampaignReport, type CampaignReportInput } from './campaign-report.js';
import { RESULTS_SCHEMA_VERSION, type SweepSampleRecord } from './results-log.js';
import { PRE_REGISTERED_SUCCESS_CRITERION } from './success-criterion.js';

/** One record; every field defaulted so a test states only what it is about. */
function record(overrides: Partial<SweepSampleRecord> = {}): SweepSampleRecord {
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    strategyArm: 'control',
    checkingApproach: 'cycle-timed',
    designGroup: 'cycle-exact',
    testbenchPromptVersion: 4,
    simulationHarnessVersion: SIMULATION_HARNESS_VERSION,
    testbenchParseRefusal: null,
    positiveControlRun: null,
    // The default testbench was measured and gave every failure report a value.
    valuelessFailureReports: 0,
    configHash: 'cfg1',
    armName: 'glm-5',
    modelSignature: 'zai.glm-5',
    problemId: 'p1',
    sampleIndex: 0,
    seed: 1,
    passed: false,
    outcomeStatus: 'unverified',
    iterations: 3,
    costCents: 1,
    costKnown: true,
    // The default reports a COMPLETE usage picture, so a test that says nothing about
    // tokens still exercises the measured path rather than the floor path.
    promptTokens: 800,
    completionTokens: 200,
    totalTokens: 1_000,
    unreportedUsageCalls: 0,
    stopReason: 'max-iterations',
    goldenVerdict: 'failed',
    goldenFailureCount: 2,
    // The default is a CHECKED, valid instrument, so a test that says nothing about the
    // positive control still exercises the normal path: the sample is admissible and pass@k
    // is a validated number.
    instrumentValidity: 'valid',
    instrumentDefect: null,
    // The default is a CHECKED instrument, so there is no unchecked reason to carry. A test
    // about `unchecked` sets `instrumentValidity` and this field together.
    instrumentUncheckedReason: null,
    // The default carries a PROBED negative control that killed every VALID mutant, so a test
    // which says nothing about mutation still exercises the current, full standard: the sample
    // is admissible because BOTH controls passed.
    mutation: {
      validCount: 5,
      killedCount: 5,
      noVerdictKills: 0,
      coverageGapOperators: [],
      candidateEquivalentOperators: [],
      goldenSurvivedCount: 3,
      goldenTimeoutCount: 0,
      nonCompilingCount: 2,
      goldenErroredCount: 0,
      elapsedMs: 4_000,
    },
    // The default sample's testbench passed on the first draft, so there is no repair to
    // report. A test about the repair fields sets both explicitly.
    repairAttempted: false,
    repairAccepted: false,
    // No repair was attempted, so there is no decline stage to name.
    repairDeclineReason: null,
    // The default sample's testbench was unchanged by normalization, so there is no
    // visibility gap to report.
    checkNameVisibilitySignal: false,
    // No formal gate was wired for the default sample, which is the pre-formal shape every
    // existing assertion in this file was written against: no property was submitted, no
    // pre-pass was read, and no admission gate ran. The formal numbers are task 12.5's
    // subject, and a test about them sets these explicitly.
    formal: null,
    formalFallbackReason: null,
    // Nothing fell back, because no formal gate ran at all.
    formalFallbackRoute: 'not-applicable',
    formalResetContract: null,
    formalAssertionGateEmitted: false,
    formalClockPolarity: null,
    propertySetAdmitted: 'not-gated',
    propertySetAuthoredUpFront: false,
    propertySetSurvivorCount: 0,
    // No gate ran for the default record, so there is no mutant tally - "not measured". A
    // test about the formal counts sets a real tally explicitly.
    formalMutationCounts: null,
    durationMs: 1_000,
    completedAtMs: 1_000,
    failureNote: null,
    // The default sample has an oracle verdict, so it carries no cause. A test about the
    // deferred announcement sets this, because there the cause IS the subject.
    noVerdictCause: null,
    ...overrides,
  };
}

const MODEL_ARMS = Array.from({ length: 11 }, (_, index) => `model.${index}`);

/**
 * Every Model_Arm has one streaming sample per arm, each agreeing with the golden judge; only
 * Treatment's instrument is proven valid, so Treatment wins 10.5 and loses nothing on 10.7.
 */
function records(): readonly SweepSampleRecord[] {
  const agreeing = {
    designGroup: 'streaming',
    problemId: 'accu',
    passed: true,
    goldenVerdict: 'passed',
  } as const;
  return MODEL_ARMS.flatMap((modelSignature) => [
    record({
      ...agreeing,
      modelSignature,
      instrumentValidity: 'unchecked',
      instrumentUncheckedReason: 'control-unavailable',
    }),
    record({
      ...agreeing,
      modelSignature,
      strategyArm: 'treatment',
      checkingApproach: 'in-order-scoreboard',
    }),
  ]);
}

function input(overrides: Partial<CampaignReportInput> = {}): CampaignReportInput {
  return {
    records: records(),
    campaign: {
      designGroups: { accu: 'streaming' },
      streamingSupplement: [],
      successCriterion: PRE_REGISTERED_SUCCESS_CRITERION,
      baseline: { resultsPath: 'base/results.jsonl', configHash: '0123456789abcdef' },
      maxResumes: 2,
    },
    modelArms: MODEL_ARMS,
    problemIds: ['accu'],
    manifestCriterion: { ...PRE_REGISTERED_SUCCESS_CRITERION },
    deferredSlots: 0,
    baseline: { available: false, reason: 'the baseline results file could not be read' },
    baselineRunName: 'base',
    ...overrides,
  };
}

const verdictOf = (lines: readonly string[]) =>
  lines.find((line) => line.startsWith('CAMPAIGN VERDICT'));

describe('renderCampaignReport', () => {
  it('renders the same verdict text twice over the same records and manifest', () => {
    expect(renderCampaignReport(input())).toEqual(renderCampaignReport(input()));
    expect(verdictOf(renderCampaignReport(input()))).toBe('CAMPAIGN VERDICT: succeeded');
  });

  it('decides nothing when the manifest holds no readable pre-registered criterion', () => {
    const lines = renderCampaignReport(input({ manifestCriterion: { minModelArmsGreater: 1 } }));
    expect(verdictOf(lines)).toContain('not-decided');
  });

  it('is not decided while a slot is deferred, and still shows every Model_Arm figure', () => {
    const lines = renderCampaignReport(input({ deferredSlots: 2 }));
    expect(verdictOf(lines)).toContain('not-decided');
    expect(lines.filter((line) => /^ {2}model\.\d+ streaming:$/.test(line))).toHaveLength(11);
  });

  it('renders byte-identically to the two-arm build, so `grounded` never grows its cells', () => {
    // Recorded from the build whose STRATEGY_ARMS held only control and treatment.
    const digest = (lines: readonly string[]) =>
      createHash('sha256').update(lines.join('\n')).digest('hex');
    expect(digest(renderCampaignReport(input()))).toBe(
      '8643bc8d3c7e054904ac0400eefe5e4c044f206f1245262917636190ffea0df6',
    );
    expect(digest(renderCampaignReport(input({ deferredSlots: 2 })))).toBe(
      'bc76201560e52f2fd3a5083e344f2b9dac7ce77351d42008f0b1946f9e981703',
    );
  });

  it('labels an unavailable baseline instead of reading it as zero', () => {
    expect(
      renderCampaignReport(input()).some((line) => line.includes('baseline unavailable:')),
    ).toBe(true);
  });
});
