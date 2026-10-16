// Feature: grounding-adoption-confirmatory, Property 4: The per-mutant figures are the
// unfiltered per-arm sums.
//
// The oracle is this file's own two sums over a record set it generated, with instrument
// validity and judged state planted deliberately so a filtered implementation fails. No
// sample-level rate appears anywhere in the computation, which is the whole point of the new
// primary guard: it is decided per mutant, not per sample.
//
// Validates: Requirements 7.2, 7.3.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { SIMULATION_HARNESS_VERSION } from '@app/tools';

import { type MutationOperatorId } from '../mutation-control.js';
import { groundingCells, type GroundingStrategyArm } from './grounding-table.js';
import { RESULTS_SCHEMA_VERSION, type SweepSampleRecord } from './results-log.js';

const PROPERTY_4 =
  'Feature: grounding-adoption-confirmatory, Property 4: The per-mutant figures are the unfiltered per-arm sums';

const MODEL_ARMS = ['zai.glm-5', 'deepseek.v3.2'] as const;
const PROBLEMS = ['p1', 'p2'] as const;
const OPERATORS = [
  'ARITH_PLUS_TO_MINUS',
  'ARITH_MINUS_TO_PLUS',
  'CONST_ZERO_TO_ONE',
] as const satisfies readonly MutationOperatorId[];

/** A record with everything this file does not vary held fixed. */
function record(overrides: Partial<SweepSampleRecord> = {}): SweepSampleRecord {
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    strategyArm: 'control',
    checkingApproach: 'cycle-timed',
    designGroup: 'cycle-exact',
    testbenchPromptVersion: 6,
    simulationHarnessVersion: SIMULATION_HARNESS_VERSION,
    testbenchParseRefusal: null,
    positiveControlRun: null,
    configHash: 'cfg1',
    armName: 'arm',
    modelSignature: MODEL_ARMS[0],
    problemId: PROBLEMS[0],
    sampleIndex: 0,
    seed: 1,
    passed: false,
    outcomeStatus: 'unverified',
    iterations: 1,
    costCents: 1,
    costKnown: true,
    promptTokens: 10,
    completionTokens: 10,
    totalTokens: 20,
    unreportedUsageCalls: 0,
    stopReason: 'max-iterations',
    goldenVerdict: 'failed',
    goldenFailureCount: 1,
    instrumentValidity: 'valid',
    instrumentUncheckedReason: null,
    instrumentDefect: null,
    mutation: null,
    formal: null,
    propertySetAdmitted: 'not-gated',
    propertySetAuthored: false,
    formalMutation: null,
    failureNote: null,
    noVerdictCause: null,
    repairProvenance: { attempted: false, accepted: false, declineReason: null },
    checkNameVisibilitySignal: false,
    durationMs: 1,
    completedAtMs: 1,
    ...overrides,
  } as SweepSampleRecord;
}

/** A probe whose survivors the Golden_Judge killed, so every one is a definite coverage gap. */
function probeOf(
  validCount: number,
  gaps: readonly MutationOperatorId[],
): NonNullable<SweepSampleRecord['mutation']> {
  return {
    validCount,
    killedCount: Math.max(0, validCount - gaps.length),
    noVerdictKills: 0,
    coverageGapOperators: gaps,
    candidateEquivalentOperators: [],
    goldenSurvivedCount: 0,
    goldenTimeoutCount: 0,
    nonCompilingCount: 0,
    goldenErroredCount: 0,
    elapsedMs: 1,
  };
}

/**
 * Records whose mutation evidence is deliberately spread across every validity and judged
 * state, so any filter on either one changes a sum the oracle does not change.
 */
const arbRecord: fc.Arbitrary<SweepSampleRecord> = fc
  .record({
    strategyArm: fc.constantFrom<GroundingStrategyArm>('control', 'grounded'),
    modelSignature: fc.constantFrom(...MODEL_ARMS, 'model.undeclared'),
    problemId: fc.constantFrom(...PROBLEMS, 'p.undeclared'),
    sampleIndex: fc.nat({ max: 2 }),
    validity: fc.constantFrom('valid', 'invalid', 'unchecked'),
    goldenVerdict: fc.constantFrom(null, 'passed', 'failed', 'did-not-build'),
    outcomeStatus: fc.constantFrom('verified', 'unverified', 'setup-failed', 'runner-error'),
    probed: fc.boolean(),
    validCount: fc.nat({ max: 8 }),
    gaps: fc.array(fc.constantFrom(...OPERATORS), { maxLength: 4 }),
  })
  .map((drawn) =>
    record({
      strategyArm: drawn.strategyArm,
      modelSignature: drawn.modelSignature,
      problemId: drawn.problemId,
      sampleIndex: drawn.sampleIndex,
      instrumentValidity: drawn.validity,
      instrumentUncheckedReason: drawn.validity === 'unchecked' ? 'control-unavailable' : null,
      instrumentDefect: drawn.validity === 'invalid' ? 'TESTBENCH_FAILED_REFERENCE' : null,
      goldenVerdict: drawn.goldenVerdict,
      outcomeStatus: drawn.outcomeStatus,
      mutation: drawn.probed ? probeOf(drawn.validCount, drawn.gaps) : null,
    }),
  );

/** The records the oracle says belong to a cell, by its own scope rule. */
function oracleRecordsOf(
  cell: { readonly strategyArm: GroundingStrategyArm; readonly scope: unknown },
  records: readonly SweepSampleRecord[],
): readonly SweepSampleRecord[] {
  const scope = cell.scope as
    | { kind: 'design'; modelArm: string; problemId: string }
    | { kind: 'model'; modelArm: string }
    | { kind: 'arm' };
  return records.filter((candidate) => {
    if (candidate.strategyArm !== cell.strategyArm) {
      return false;
    }
    if (scope.kind === 'arm') {
      return true;
    }
    if (scope.kind === 'model') {
      return candidate.modelSignature === scope.modelArm;
    }
    return candidate.modelSignature === scope.modelArm && candidate.problemId === scope.problemId;
  });
}

describe(PROPERTY_4, () => {
  it('sums Scored_Mutants and Coverage_Gap_Survivors over every record of the cell', () => {
    fc.assert(
      fc.property(fc.array(arbRecord, { maxLength: 30 }), (records) => {
        for (const cell of groundingCells(records, MODEL_ARMS, PROBLEMS)) {
          const mine = oracleRecordsOf(cell, records);
          let scored = 0;
          let gaps = 0;
          for (const candidate of mine) {
            scored += candidate.mutation === null ? 0 : candidate.mutation.validCount;
            gaps +=
              candidate.mutation === null ? 0 : candidate.mutation.coverageGapOperators.length;
          }

          expect(cell.scoredMutants).toBe(scored);
          expect(cell.coverageGapSurvivors).toBe(gaps);
          expect(cell.coverageGapOperators.reduce((sum, entry) => sum + entry.count, 0)).toBe(gaps);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('counts the mutants of an invalid or unjudged sample, which a sample-level rate drops', () => {
    // The guard this denominator feeds is per mutant precisely so the evidence of a sample
    // that never became admissible still counts. A filtered sum would report 0 here.
    const records = [
      record({
        instrumentValidity: 'invalid',
        instrumentDefect: 'TESTBENCH_FAILED_REFERENCE',
        goldenVerdict: null,
        mutation: probeOf(6, [OPERATORS[0]]),
      }),
      record({
        instrumentValidity: 'unchecked',
        instrumentUncheckedReason: 'control-unavailable',
        goldenVerdict: null,
        mutation: probeOf(4, []),
      }),
    ];

    const arm = groundingCells(records, MODEL_ARMS, PROBLEMS).find(
      (cell) => cell.strategyArm === 'control' && cell.scope.kind === 'arm',
    );

    expect(arm?.scoredMutants).toBe(10);
    expect(arm?.coverageGapSurvivors).toBe(1);
    expect(arm?.judged).toBe(0);
    expect(arm?.instrumentValid).toBe(0);
  });
});

// Feature: grounding-adoption-confirmatory, Property 11: Every declared cell's figures equal an
// independent recount.
//
// The oracle below filters and counts with its own loops, written from the requirement text
// rather than by calling the table functions, over every figure a cell carries.
//
// Validates: Requirements 9.6, 10.1, 10.2, 10.3, 10.4, 10.6.

const PROPERTY_11 =
  'Feature: grounding-adoption-confirmatory, Property 11: Every declared cell is counted independently';

/** A record whose every counted field is drawn, including the ones Property 4 holds fixed. */
const arbFullRecord: fc.Arbitrary<SweepSampleRecord> = fc
  .record({
    strategyArm: fc.constantFrom<GroundingStrategyArm>('control', 'grounded'),
    modelSignature: fc.constantFrom(...MODEL_ARMS, 'model.undeclared'),
    problemId: fc.constantFrom(...PROBLEMS, 'p.undeclared'),
    sampleIndex: fc.nat({ max: 2 }),
    validity: fc.constantFrom('valid', 'invalid', 'unchecked'),
    defect: fc.constantFrom(
      'TESTBENCH_FAILED_REFERENCE',
      'TESTBENCH_REFERENCE_UNBUILDABLE',
      'TESTBENCH_SURVIVED_MUTANTS',
    ),
    exhausted: fc.boolean(),
    passed: fc.boolean(),
    goldenVerdict: fc.constantFrom(null, 'passed', 'failed', 'did-not-build'),
    outcomeStatus: fc.constantFrom('verified', 'unverified', 'setup-failed', 'runner-error'),
    noVerdictCause: fc.constantFrom(
      null,
      'provider-unreachable',
      'harness-error',
      'budget-exhausted',
    ),
    run: fc.oneof(
      fc.constant(null),
      fc.record({
        passed: fc.boolean(),
        watchdogStopped: fc.boolean(),
        waveformMissing: fc.boolean(),
        knownAnswerOnlyFailure: fc.boolean(),
      }),
    ),
    probed: fc.boolean(),
    validCount: fc.nat({ max: 6 }),
    gaps: fc.array(fc.constantFrom(...OPERATORS), { maxLength: 3 }),
  })
  .map((drawn) =>
    record({
      strategyArm: drawn.strategyArm,
      modelSignature: drawn.modelSignature,
      problemId: drawn.problemId,
      sampleIndex: drawn.sampleIndex,
      instrumentValidity: drawn.validity,
      instrumentDefect: drawn.validity === 'invalid' ? drawn.defect : null,
      instrumentUncheckedReason:
        drawn.validity === 'unchecked'
          ? drawn.exhausted
            ? 'control-resource-exhausted'
            : 'control-unavailable'
          : null,
      passed: drawn.passed,
      goldenVerdict: drawn.goldenVerdict,
      outcomeStatus: drawn.outcomeStatus,
      noVerdictCause: drawn.noVerdictCause,
      positiveControlRun: drawn.run,
      mutation: drawn.probed ? probeOf(drawn.validCount, drawn.gaps) : null,
    }),
  );

describe(PROPERTY_11, () => {
  it('matches an independent recount of every figure, at every declared scope', () => {
    fc.assert(
      fc.property(fc.array(arbFullRecord, { maxLength: 30 }), (records) => {
        for (const cell of groundingCells(records, MODEL_ARMS, PROBLEMS)) {
          const mine = oracleRecordsOf(cell, records);
          // Golden figures are read over samples whose instrument is not invalid, exactly as
          // the per-arm summary reads them.
          const judged = mine.filter(
            (one) => one.goldenVerdict !== null && one.instrumentValidity !== 'invalid',
          );
          const runs = mine
            .map((one) => one.positiveControlRun)
            .filter((run): run is NonNullable<typeof run> => run !== null);
          const invalidWith = (code: string): number =>
            mine.filter(
              (one) => one.instrumentValidity === 'invalid' && one.instrumentDefect === code,
            ).length;
          let scored = 0;
          let gaps = 0;
          const operators = new Map<string, number>();
          for (const one of mine) {
            scored += one.mutation?.validCount ?? 0;
            for (const operator of one.mutation?.coverageGapOperators ?? []) {
              gaps += 1;
              operators.set(operator, (operators.get(operator) ?? 0) + 1);
            }
          }

          expect({
            records: cell.records,
            instrumentValid: cell.instrumentValid,
            positiveControlPassed: cell.positiveControlPassed,
            judged: cell.judged,
            agreed: cell.agreed,
            missedBug: cell.missedBug,
            overStrict: cell.overStrict,
            failedReference: cell.failedReference,
            referenceUnbuildable: cell.referenceUnbuildable,
            survivedMutants: cell.survivedMutants,
            coverageGapSurvivors: cell.coverageGapSurvivors,
            scoredMutants: cell.scoredMutants,
            watchdogStops: cell.watchdogStops,
            waveformMissing: cell.waveformMissing,
            knownAnswerOnlyFailures: cell.knownAnswerOnlyFailures,
            resourceExhausted: cell.resourceExhausted,
            deferred: cell.deferred,
          }).toEqual({
            records: mine.length,
            instrumentValid: mine.filter((one) => one.instrumentValidity === 'valid').length,
            positiveControlPassed: runs.filter((run) => run.passed).length,
            judged: judged.length,
            agreed: judged.filter((one) => one.passed === (one.goldenVerdict === 'passed')).length,
            missedBug: judged.filter((one) => one.passed && one.goldenVerdict !== 'passed').length,
            overStrict: judged.filter((one) => !one.passed && one.goldenVerdict === 'passed')
              .length,
            failedReference: invalidWith('TESTBENCH_FAILED_REFERENCE'),
            referenceUnbuildable: invalidWith('TESTBENCH_REFERENCE_UNBUILDABLE'),
            survivedMutants: invalidWith('TESTBENCH_SURVIVED_MUTANTS'),
            coverageGapSurvivors: gaps,
            scoredMutants: scored,
            watchdogStops: runs.filter((run) => run.watchdogStopped).length,
            waveformMissing: runs.filter((run) => run.waveformMissing).length,
            knownAnswerOnlyFailures: runs.filter((run) => run.knownAnswerOnlyFailure).length,
            resourceExhausted: mine.filter(
              (one) => one.instrumentUncheckedReason === 'control-resource-exhausted',
            ).length,
            // A deferred slot is one the oracle re-states: no verdict, and a deferrable cause.
            deferred: mine.filter(
              (one) =>
                one.outcomeStatus !== 'verified' &&
                one.outcomeStatus !== 'unverified' &&
                (one.noVerdictCause === 'provider-unreachable' ||
                  one.noVerdictCause === 'harness-error'),
            ).length,
          });
          // The operator tally is the same multiset, and its counts sum to the survivors.
          expect(
            [...cell.coverageGapOperators].map((entry) => [entry.operator, entry.count]).sort(),
          ).toEqual([...operators.entries()].sort());
        }
      }),
      { numRuns: 200 },
    );
  });
});
