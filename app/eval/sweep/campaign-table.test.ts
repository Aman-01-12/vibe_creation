// Feature: testbench-in-order-scoreboard, Property 17: Campaign cells never pool and match an
// independent count. The oracle below is a filter-then-count written from Requirement 9's text
// and shares no helper with `campaign-table.ts`.
// Validates: Requirements 6.6, 7.6, 8.7, 9.1, 9.2, 9.4, 9.5.

import { DESIGN_GROUPS, STRATEGY_ARMS } from '@app/agent';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { SIMULATION_HARNESS_VERSION } from '@app/tools';

import { summarizeMutationControl } from '../mutation-control.js';
import {
  campaignCells,
  campaignCounts,
  renderCampaignTable,
  type CampaignCell,
} from './campaign-table.js';
import { RESULTS_SCHEMA_VERSION, type SweepSampleRecord } from './results-log.js';

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

/** A probed negative control over `validCount` compiling mutants, every one of them killed. */
function mutationOf(validCount: number): NonNullable<SweepSampleRecord['mutation']> {
  return {
    validCount,
    killedCount: validCount,
    noVerdictKills: 0,
    coverageGapOperators: [],
    candidateEquivalentOperators: [],
    goldenSurvivedCount: 0,
    goldenTimeoutCount: 0,
    nonCompilingCount: 0,
    goldenErroredCount: 0,
    elapsedMs: 1,
  };
}

const MODEL_ARMS = ['model.a', 'model.b'] as const;
const PROBLEMS = ['p1', 'p2', 'p3'] as const;
const DEFECTS = [
  'TESTBENCH_FAILED_REFERENCE',
  'TESTBENCH_REFERENCE_UNBUILDABLE',
  'TESTBENCH_SURVIVED_MUTANTS',
] as const;

/** A record over the declared keys, with every figure the table counts drawn freely. */
const arbRecord: fc.Arbitrary<SweepSampleRecord> = fc
  .record({
    strategyArm: fc.constantFrom(...STRATEGY_ARMS),
    modelSignature: fc.constantFrom(...MODEL_ARMS, 'model.undeclared'),
    designGroup: fc.constantFrom(...DESIGN_GROUPS),
    problemId: fc.constantFrom(...PROBLEMS),
    sampleIndex: fc.nat({ max: 4 }),
    passed: fc.boolean(),
    outcomeStatus: fc.constantFrom('verified', 'unverified', 'setup-failed', 'runner-error'),
    noVerdictCause: fc.constantFrom(null, 'provider-unreachable', 'budget-exhausted'),
    goldenVerdict: fc.constantFrom(null, 'passed', 'failed', 'did-not-build'),
    validity: fc.constantFrom('valid', 'invalid', 'unchecked'),
    defect: fc.constantFrom(...DEFECTS),
    gaps: fc.nat({ max: 3 }),
  })
  .map((drawn) =>
    record({
      strategyArm: drawn.strategyArm,
      checkingApproach: drawn.strategyArm === 'control' ? 'cycle-timed' : 'in-order-scoreboard',
      modelSignature: drawn.modelSignature,
      designGroup: drawn.designGroup,
      problemId: drawn.problemId,
      sampleIndex: drawn.sampleIndex,
      passed: drawn.passed,
      outcomeStatus: drawn.outcomeStatus,
      noVerdictCause: drawn.noVerdictCause,
      goldenVerdict: drawn.goldenVerdict,
      instrumentValidity: drawn.validity,
      instrumentDefect: drawn.validity === 'invalid' ? drawn.defect : null,
      instrumentUncheckedReason: drawn.validity === 'unchecked' ? 'control-unavailable' : null,
      mutation: {
        validCount: 5,
        killedCount: 5 - drawn.gaps,
        noVerdictKills: 0,
        coverageGapOperators: Array.from(
          { length: drawn.gaps },
          () => 'ARITH_PLUS_TO_MINUS' as const,
        ),
        candidateEquivalentOperators: [],
        goldenSurvivedCount: 0,
        goldenTimeoutCount: 0,
        nonCompilingCount: 0,
        goldenErroredCount: 0,
        elapsedMs: 1,
      },
    }),
  );

/** The independent count of one cell, straight from Requirement 9's definitions. */
function oracle(records: readonly SweepSampleRecord[], cell: CampaignCell) {
  const mine = records.filter(
    (r) =>
      r.strategyArm === cell.strategyArm &&
      r.modelSignature === cell.modelArm &&
      (cell.scope.kind === 'group'
        ? r.designGroup === cell.scope.group
        : r.problemId === cell.scope.problemId),
  );
  // Golden figures are read over samples whose instrument is not invalid, as the summary reads them.
  const judged = mine.filter((r) => r.goldenVerdict !== null && r.instrumentValidity !== 'invalid');
  const agreed = judged.filter((r) => r.passed === (r.goldenVerdict === 'passed')).length;
  const invalidWith = (code: string) =>
    mine.filter((r) => r.instrumentValidity === 'invalid' && r.instrumentDefect === code).length;
  let gaps = 0;
  let scored = 0;
  for (const r of mine) {
    gaps += r.mutation === null ? 0 : r.mutation.coverageGapOperators.length;
    scored += r.mutation === null ? 0 : r.mutation.validCount;
  }
  return {
    records: mine.length,
    instrumentValid: mine.filter((r) => r.instrumentValidity === 'valid').length,
    failedReference: invalidWith('TESTBENCH_FAILED_REFERENCE'),
    referenceUnbuildable: invalidWith('TESTBENCH_REFERENCE_UNBUILDABLE'),
    survivedMutants: invalidWith('TESTBENCH_SURVIVED_MUTANTS'),
    missedBug: judged.filter((r) => r.passed && r.goldenVerdict !== 'passed').length,
    overStrict: judged.filter((r) => !r.passed && r.goldenVerdict === 'passed').length,
    coverageGapSurvivors: gaps,
    scoredMutants: scored,
    deferred: mine.filter(
      (r) =>
        r.outcomeStatus !== 'verified' &&
        r.outcomeStatus !== 'unverified' &&
        r.noVerdictCause === 'provider-unreachable',
    ).length,
    judged: judged.length,
    agreed,
    goldenAgreement: judged.length === 0 ? null : agreed / judged.length,
  };
}

describe('Property 17: Campaign cells never pool and match an independent count', () => {
  it('reports every declared cell, each equal to the independent count over its own records', () => {
    fc.assert(
      fc.property(fc.array(arbRecord, { maxLength: 40 }), (records) => {
        const cells = campaignCells(records, STRATEGY_ARMS, MODEL_ARMS, PROBLEMS);
        const expectedCells =
          STRATEGY_ARMS.length * MODEL_ARMS.length * (DESIGN_GROUPS.length + PROBLEMS.length);
        expect(cells).toHaveLength(expectedCells);
        for (const cell of cells) {
          const { strategyArm, modelArm, scope, ...counts } = cell;
          expect({ strategyArm, modelArm, scope, ...counts }).toEqual({
            strategyArm,
            modelArm,
            scope,
            ...oracle(records, cell),
          });
        }
      }),
    );
  });

  it('reports a zero-denominator cell with undefined agreement rather than omitting it', () => {
    const cells = campaignCells([], STRATEGY_ARMS, MODEL_ARMS, PROBLEMS);
    expect(cells.every((cell) => cell.records === 0 && cell.goldenAgreement === null)).toBe(true);
    expect(
      renderCampaignTable(cells).some((line) => line.includes('golden-agreement undefined')),
    ).toBe(true);
  });
});

describe('campaignCounts - the Scored_Mutant denominator is unfiltered', () => {
  it('sums mutation.validCount across records of every validity and judged state', () => {
    // The per-mutant guard is decided on all the mutation evidence a cell produced, so an
    // invalid instrument and an unjudged sample both still contribute their mutants.
    const records = [
      record({
        mutation: {
          ...mutationOf(4),
          killedCount: 3,
          coverageGapOperators: ['ARITH_PLUS_TO_MINUS'],
        },
      }),
      record({
        instrumentValidity: 'invalid',
        instrumentDefect: 'TESTBENCH_FAILED_REFERENCE',
        mutation: mutationOf(7),
      }),
      record({
        instrumentValidity: 'unchecked',
        instrumentUncheckedReason: 'control-unavailable',
        goldenVerdict: null,
        mutation: mutationOf(2),
      }),
    ];

    const counts = campaignCounts(records);

    expect(counts.scoredMutants).toBe(13);
    expect(counts.judged).toBe(1);
    expect(counts.instrumentValid).toBe(1);
    expect(counts.coverageGapSurvivors).toBe(1);
  });

  it('reports zero scored mutants when no sample was probed, never a missing field', () => {
    const counts = campaignCounts([record({ mutation: null }), record({ mutation: null })]);

    expect(counts.scoredMutants).toBe(0);
  });

  it('agrees with summarizeMutationControl on one arm, so the two tables cannot disagree', () => {
    // Req 8.9: the per-arm survivor figure and the Campaign cell reduce the same field.
    const records = [
      record({ mutation: { ...mutationOf(4), coverageGapOperators: ['ARITH_PLUS_TO_MINUS'] } }),
      record({
        problemId: 'p2',
        mutation: {
          ...mutationOf(6),
          coverageGapOperators: ['CONDITION_NEGATED', 'CONST_INCREMENTED'],
        },
      }),
      record({ problemId: 'p3', mutation: null }),
    ];

    const arm = summarizeMutationControl(
      records.map((sample) => ({ problemId: sample.problemId, probe: sample.mutation })),
    );

    expect(arm.coverageGapSurvivors).toBe(3);
    expect(arm.coverageGapSurvivors).toBe(campaignCounts(records).coverageGapSurvivors);
    expect(arm.validMutants).toBe(campaignCounts(records).scoredMutants);
  });
});
