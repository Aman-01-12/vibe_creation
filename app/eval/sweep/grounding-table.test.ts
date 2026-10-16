// testbench-spec-grounding, Properties 20 and 21: the Grounding cells never pool two arms and
// match an independent count, and the Slot_Pairs match an independent pairing.
//
// Both oracles are filter-then-count functions written here. They share no helper with
// `grounding-table.ts` or `campaign-table.ts`, so a counting rule that drifts in one cannot
// drift in the other.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { TESTBENCH_PARSE_REFUSALS, type TestbenchParseRefusal } from '@app/agent';
import { SIMULATION_HARNESS_VERSION } from '@app/tools';

import { groundingCells, slotPairs, type GroundingStrategyArm } from './grounding-table.js';
import { RESULTS_SCHEMA_VERSION, type SweepSampleRecord } from './results-log.js';

const PROPERTY_20 =
  'Feature: testbench-spec-grounding, Property 20: Grounding cells never pool and match an independent count';
const PROPERTY_21 =
  'Feature: testbench-spec-grounding, Property 21: Slot_Pairs match an independent pairing';

const MODEL_ARMS = ['zai.glm-5', 'deepseek.v3.2'] as const;
const PROBLEMS = ['p1', 'p2'] as const;

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

const arbRun = fc.oneof(
  fc.constant(null),
  fc.record({
    passed: fc.boolean(),
    watchdogStopped: fc.boolean(),
    waveformMissing: fc.boolean(),
    knownAnswerOnlyFailure: fc.boolean(),
  }),
);

const arbRecord: fc.Arbitrary<SweepSampleRecord> = fc
  .record({
    strategyArm: fc.constantFrom<GroundingStrategyArm>('control', 'grounded'),
    modelSignature: fc.constantFrom(...MODEL_ARMS, 'model.undeclared'),
    problemId: fc.constantFrom(...PROBLEMS, 'p.undeclared'),
    sampleIndex: fc.nat({ max: 2 }),
    validity: fc.constantFrom('valid', 'invalid', 'unchecked'),
    exhausted: fc.boolean(),
    refusal: fc.oneof(fc.constant(null), fc.constantFrom(...TESTBENCH_PARSE_REFUSALS)),
    positiveControlRun: arbRun,
  })
  .map((drawn) =>
    record({
      strategyArm: drawn.strategyArm,
      modelSignature: drawn.modelSignature,
      problemId: drawn.problemId,
      sampleIndex: drawn.sampleIndex,
      instrumentValidity: drawn.validity,
      instrumentUncheckedReason:
        drawn.validity === 'unchecked'
          ? drawn.exhausted
            ? 'control-resource-exhausted'
            : 'control-unavailable'
          : null,
      testbenchParseRefusal: drawn.refusal,
      positiveControlRun: drawn.positiveControlRun,
    }),
  );

/** The independent per-cause oracle: filter, then count, with its own loops. */
function oracleCounts(records: readonly SweepSampleRecord[]): Record<string, number> {
  let positiveControlPassed = 0;
  let watchdogStops = 0;
  let waveformMissing = 0;
  let knownAnswerOnlyFailures = 0;
  let resourceExhausted = 0;
  const refusals: Record<string, number> = {};
  for (const refusal of TESTBENCH_PARSE_REFUSALS) {
    refusals[refusal] = 0;
  }
  for (const entry of records) {
    const run = entry.positiveControlRun;
    if (run !== null) {
      if (run.passed) positiveControlPassed += 1;
      if (run.watchdogStopped) watchdogStops += 1;
      if (run.waveformMissing) waveformMissing += 1;
      if (run.knownAnswerOnlyFailure) knownAnswerOnlyFailures += 1;
    }
    if (entry.instrumentUncheckedReason === 'control-resource-exhausted') {
      resourceExhausted += 1;
    }
    if (entry.testbenchParseRefusal !== null) {
      refusals[entry.testbenchParseRefusal] = (refusals[entry.testbenchParseRefusal] ?? 0) + 1;
    }
  }
  return {
    positiveControlPassed,
    watchdogStops,
    waveformMissing,
    knownAnswerOnlyFailures,
    resourceExhausted,
    ...Object.fromEntries(
      Object.entries(refusals).map(([code, count]) => [`refusal:${code}`, count]),
    ),
  };
}

/** The records the oracle says belong to a cell, by its own scope rule. */
function oracleRecordsOf(
  records: readonly SweepSampleRecord[],
  strategyArm: GroundingStrategyArm,
  scope: { readonly kind: string; readonly modelArm?: string; readonly problemId?: string },
): readonly SweepSampleRecord[] {
  return records.filter((entry) => {
    if (entry.strategyArm !== strategyArm) {
      return false;
    }
    if (scope.kind === 'arm') {
      return true;
    }
    if (scope.kind === 'model') {
      return entry.modelSignature === scope.modelArm;
    }
    return entry.modelSignature === scope.modelArm && entry.problemId === scope.problemId;
  });
}

describe(PROPERTY_20, () => {
  it('reports every declared cell, each counted over its own arm and scope only', () => {
    fc.assert(
      fc.property(fc.array(arbRecord, { maxLength: 30 }), (records) => {
        const cells = groundingCells(records, MODEL_ARMS, PROBLEMS);
        // Two arms x (4 design cells + 2 model cells + 1 arm cell).
        expect(cells).toHaveLength(
          2 * (MODEL_ARMS.length * PROBLEMS.length + MODEL_ARMS.length + 1),
        );
        for (const cell of cells) {
          const own = oracleRecordsOf(records, cell.strategyArm, cell.scope);
          expect(cell.records).toBe(own.length);
          expect(cell.instrumentValid).toBe(
            own.filter((entry) => entry.instrumentValidity === 'valid').length,
          );
          const expected = oracleCounts(own);
          expect({
            positiveControlPassed: cell.positiveControlPassed,
            watchdogStops: cell.watchdogStops,
            waveformMissing: cell.waveformMissing,
            knownAnswerOnlyFailures: cell.knownAnswerOnlyFailures,
            resourceExhausted: cell.resourceExhausted,
            ...Object.fromEntries(
              TESTBENCH_PARSE_REFUSALS.map((code: TestbenchParseRefusal) => [
                `refusal:${code}`,
                cell.parseRefusals[code],
              ]),
            ),
          }).toEqual(expected);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('reports a zero-denominator cell with its zero and an undefined agreement', () => {
    const cells = groundingCells([], MODEL_ARMS, PROBLEMS);

    expect(cells.every((cell) => cell.records === 0 && cell.goldenAgreement === null)).toBe(true);
    expect(cells.every((cell) => cell.parseRefusals['no-fence'] === 0)).toBe(true);
  });

  it('never counts an undeclared model or design into a declared cell', () => {
    const stray = record({ modelSignature: 'model.undeclared', problemId: 'p.undeclared' });
    const cells = groundingCells([stray], MODEL_ARMS, PROBLEMS);

    // The arm-scope cell counts it, because its scope IS every record of that arm; no
    // model-scope or design-scope cell does.
    expect(
      cells.filter((cell) => cell.scope.kind !== 'arm').every((cell) => cell.records === 0),
    ).toBe(true);
    expect(
      cells.find((cell) => cell.scope.kind === 'arm' && cell.strategyArm === 'control')?.records,
    ).toBe(1);
  });
});

describe(PROPERTY_21, () => {
  it('pairs exactly the slots with both arms present, and reads each arm validity', () => {
    fc.assert(
      fc.property(fc.array(arbRecord, { maxLength: 24 }), (records) => {
        const pairs = slotPairs(records);
        // The oracle: group by slot with its own map, then keep the slots with both arms.
        const keys = [
          ...new Set(
            records.map(
              (entry) => `${entry.modelSignature}|${entry.problemId}|${String(entry.sampleIndex)}`,
            ),
          ),
        ];
        const expected = keys.flatMap((key) => {
          const slot = records.filter(
            (entry) =>
              `${entry.modelSignature}|${entry.problemId}|${String(entry.sampleIndex)}` === key,
          );
          const control = slot.filter((entry) => entry.strategyArm === 'control').at(-1);
          const grounded = slot.filter((entry) => entry.strategyArm === 'grounded').at(-1);
          if (control === undefined || grounded === undefined) {
            return [];
          }
          return [
            {
              modelArm: control.modelSignature,
              problemId: control.problemId,
              sampleIndex: control.sampleIndex,
              controlValid: control.instrumentValidity === 'valid',
              groundedValid: grounded.instrumentValidity === 'valid',
            },
          ];
        });
        expect(
          [...pairs].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        ).toEqual([...expected].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
      }),
      { numRuns: 200 },
    );
  });

  it('never pairs a slot that has only one arm', () => {
    const control = record({ strategyArm: 'control' });

    expect(slotPairs([control])).toEqual([]);
    expect(slotPairs([control, record({ strategyArm: 'grounded' })])).toHaveLength(1);
  });
});

describe('groundingCells - the per-operator breakdown of a cell', () => {
  /** A probed negative control whose survivors the Golden_Judge killed. */
  function gaps(...operators: readonly string[]): NonNullable<SweepSampleRecord['mutation']> {
    return {
      validCount: 6,
      killedCount: 6 - operators.length,
      noVerdictKills: 0,
      coverageGapOperators: operators as NonNullable<
        SweepSampleRecord['mutation']
      >['coverageGapOperators'],
      candidateEquivalentOperators: [],
      goldenSurvivedCount: 0,
      goldenTimeoutCount: 0,
      nonCompilingCount: 0,
      goldenErroredCount: 0,
      elapsedMs: 1,
    };
  }

  it("tallies operators whose counts sum to the cell's Coverage_Gap_Survivors", () => {
    const records = [
      record({ mutation: gaps('ARITH_PLUS_TO_MINUS', 'CONST_ZERO_TO_ONE') }),
      record({ mutation: gaps('ARITH_PLUS_TO_MINUS') }),
    ];

    const cells = groundingCells(records, ['zai.glm-5'], ['p1']);
    const arm = cells.find((cell) => cell.strategyArm === 'control' && cell.scope.kind === 'arm');

    expect(arm?.coverageGapOperators).toEqual([
      { operator: 'ARITH_PLUS_TO_MINUS', count: 2 },
      { operator: 'CONST_ZERO_TO_ONE', count: 1 },
    ]);
    expect(arm?.coverageGapOperators.reduce((sum, entry) => sum + entry.count, 0)).toBe(
      arm?.coverageGapSurvivors,
    );
    expect(arm?.scoredMutants).toBe(12);
  });

  it('carries an empty tally for a cell with no coverage gap, never a missing field', () => {
    const cells = groundingCells([record({ mutation: gaps() })], ['zai.glm-5'], ['p1']);

    for (const cell of cells) {
      expect(cell.coverageGapOperators).toEqual([]);
    }
  });
});
