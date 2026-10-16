// Feature: grounding-adoption-confirmatory, properties of the rendered Grounding block.
//
// Property 12: every declared cell is present, and a zero denominator renders as undefined.
// Property 13: every guard clause renders every quantity its requirement lists.
// Property 3:  no figure pools two Strategy_Arms, and evaluation is order-independent.
//
// Property 3's Config_Identity half is enforced one layer up, where the filter lives:
// `summarizeRecords` scopes records to the run's own `configHash`, and `summary.test.ts`
// pins that exclusion ("excludes records from another experiment when a config hash is
// supplied"). This file is handed records already scoped, so it cannot re-test the filter.
//
// Validates: Requirements 1.3, 4.7, 5.3, 6.4, 7.2, 7.5, 8.6, 10.5.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { SIMULATION_HARNESS_VERSION } from '@app/tools';

import { type MutationOperatorId } from '../mutation-control.js';
import { PRE_REGISTERED_GROUNDING_CRITERION } from './grounding-criterion.js';
import { renderGroundingReport, type GroundingReportInput } from './grounding-report.js';
import { type GroundingStrategyArm } from './grounding-table.js';
import { RESULTS_SCHEMA_VERSION, type SweepSampleRecord } from './results-log.js';

const PROPERTY_12 =
  'Feature: grounding-adoption-confirmatory, Property 12: Every declared cell is present, and a zero denominator renders as undefined';
const PROPERTY_13 =
  'Feature: grounding-adoption-confirmatory, Property 13: Every guard clause renders every quantity its requirement lists';
const PROPERTY_3 =
  'Feature: grounding-adoption-confirmatory, Property 3: No figure pools two arms, and evaluation is order-independent';

const MODEL_ARMS = ['zai.glm-5', 'deepseek.v3.2'] as const;
const PROBLEMS = ['p1', 'p2'] as const;
const OPERATORS = [
  'ARITH_PLUS_TO_MINUS',
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

function input(records: readonly SweepSampleRecord[]): GroundingReportInput {
  return {
    records,
    modelArms: MODEL_ARMS,
    problemIds: PROBLEMS,
    manifestCriterion: PRE_REGISTERED_GROUNDING_CRITERION,
    deferredSlots: 0,
    baseline: { available: false, reason: 'the baseline results file could not be read' },
    baselineRunName: 'scoreboard-ab-v1',
  };
}

const arbRecord: fc.Arbitrary<SweepSampleRecord> = fc
  .record({
    strategyArm: fc.constantFrom<GroundingStrategyArm>('control', 'grounded'),
    modelSignature: fc.constantFrom(...MODEL_ARMS),
    problemId: fc.constantFrom(...PROBLEMS),
    sampleIndex: fc.nat({ max: 2 }),
    validity: fc.constantFrom('valid', 'invalid', 'unchecked'),
    goldenVerdict: fc.constantFrom(null, 'passed', 'failed'),
    passed: fc.boolean(),
    probed: fc.boolean(),
    validCount: fc.nat({ max: 6 }),
    gaps: fc.array(fc.constantFrom(...OPERATORS), { maxLength: 2 }),
  })
  .map((drawn) =>
    record({
      strategyArm: drawn.strategyArm,
      modelSignature: drawn.modelSignature,
      problemId: drawn.problemId,
      sampleIndex: drawn.sampleIndex,
      instrumentValidity: drawn.validity,
      instrumentDefect: drawn.validity === 'invalid' ? 'TESTBENCH_FAILED_REFERENCE' : null,
      instrumentUncheckedReason: drawn.validity === 'unchecked' ? 'control-unavailable' : null,
      goldenVerdict: drawn.goldenVerdict,
      passed: drawn.passed,
      mutation: drawn.probed ? probeOf(drawn.validCount, drawn.gaps) : null,
    }),
  );

/**
 * A record set holding at most one record per slot, which is what one pass of a Results_Log
 * holds.
 *
 * Deliberately constrained: a resumed slot appends a SECOND record for the same slot, and the
 * two readers treat that differently. `slotPairs` keeps the last record per slot, matching
 * `CompletedSampleIndex`, while a cell counts both, which is why the Exploratory_Run's cell
 * denominator read 381 against 380 Slot_Pairs. Permutation invariance is therefore a claim
 * about distinct slots, which is also the only claim Requirement 4.7 makes: the Results_Log's
 * own order is stable, so two evaluations of one file agree either way.
 */
const arbSlots: fc.Arbitrary<readonly SweepSampleRecord[]> = fc.uniqueArray(arbRecord, {
  maxLength: 16,
  selector: (one) =>
    `${one.strategyArm}|${one.modelSignature}|${one.problemId}|${String(one.sampleIndex)}`,
});

/** Every declared cell key, restated here from the Model_Arm and design lists. */
const DECLARED_SCOPES: readonly string[] = [
  ...MODEL_ARMS.flatMap(() => PROBLEMS.map((problemId) => problemId)),
  ...MODEL_ARMS,
  'ALL',
];

describe(PROPERTY_12, () => {
  it('renders one cell line per declared key, however few records exist', () => {
    fc.assert(
      fc.property(arbSlots, (records) => {
        const lines = renderGroundingReport(input(records));
        const cellLines = lines.filter((line) => line.includes('instrument-valid '));

        // 2 Strategy_Arms x (2 models x 2 designs + 2 models + 1 arm total).
        expect(cellLines).toHaveLength(2 * (MODEL_ARMS.length * PROBLEMS.length + 3));
        for (const arm of ['control', 'grounded']) {
          for (const scope of new Set(DECLARED_SCOPES)) {
            expect(
              cellLines.some((line) => line.includes(`${arm} `) && line.includes(`${scope}:`)),
            ).toBe(true);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('renders undefined, never 0.000, for every rate with no denominator', () => {
    const lines = renderGroundingReport(input([]));

    expect(lines.some((line) => line.includes('instrument-valid 0/0'))).toBe(true);
    expect(lines.some((line) => line.includes('golden-agreement undefined'))).toBe(true);
    expect(lines.some((line) => line.includes('coverage-gap-survivors 0/0 undefined'))).toBe(true);
    expect(lines.some((line) => line.includes('coverage-gap control  ALL: 0/0 undefined'))).toBe(
      true,
    );
    for (const line of lines.filter((candidate) => candidate.includes('0/0'))) {
      expect(line).not.toContain('0/0 0.000');
    }
  });
});

describe(PROPERTY_13, () => {
  it('renders both arms, both rates, the difference, and the margin for every guard', () => {
    fc.assert(
      fc.property(arbSlots, (records) => {
        const lines = renderGroundingReport(input(records));
        const clause = (id: string): string =>
          lines.find((line) => line.trim().startsWith(`${id} `)) ?? '';

        for (const id of ['7.1', '8.1', '8.2']) {
          const rendered = clause(id);
          expect(rendered).toContain('control ');
          expect(rendered).toContain('grounded ');
          expect(rendered).toContain('difference ');
          expect(rendered).toContain('margin ');
          expect(rendered).toMatch(/held|NOT held|not decided/);
        }
        // Only the sample-level guards carry a floor; the per-mutant one is decided on any
        // non-zero denominator, so printing a floor of 1 beside it would mislead.
        expect(clause('8.1')).toContain('min-denominator 34');
        expect(clause('8.2')).toContain('min-denominator 34');
        expect(clause('7.1')).not.toContain('min-denominator');
        expect(clause('7.1')).toContain('margin 2pt');
        expect(clause('8.1')).toContain('margin 3pt');
      }),
      { numRuns: 100 },
    );
  });

  it('renders each guard numerator over the denominator the requirement names', () => {
    const records = [
      record({
        strategyArm: 'control',
        passed: true,
        goldenVerdict: 'failed',
        mutation: probeOf(8, [OPERATORS[0]]),
      }),
      record({
        strategyArm: 'grounded',
        passed: false,
        goldenVerdict: 'passed',
        mutation: probeOf(10, []),
      }),
    ];
    const lines = renderGroundingReport(input(records));

    // Independently: one Judged_Sample per arm, one Missed_Bug under control, one Over_Strict
    // under grounded, and 1/8 against 0/10 coverage-gap survivors per mutant.
    expect(lines.find((line) => line.trim().startsWith('8.1 '))).toContain('control 1/1 1.000');
    expect(lines.find((line) => line.trim().startsWith('8.1 '))).toContain('grounded 0/1 0.000');
    expect(lines.find((line) => line.trim().startsWith('8.2 '))).toContain('control 0/1 0.000');
    expect(lines.find((line) => line.trim().startsWith('7.1 '))).toContain('control 1/8 0.125');
    expect(lines.find((line) => line.trim().startsWith('7.1 '))).toContain('grounded 0/10 0.000');
  });
});

describe(PROPERTY_3, () => {
  it('renders the same text under any permutation of the records', () => {
    fc.assert(
      fc.property(arbSlots, (records) => {
        const shuffled = [...records].reverse();

        expect(renderGroundingReport(input(shuffled))).toEqual(
          renderGroundingReport(input(records)),
        );
      }),
      { numRuns: 100 },
    );
  });

  it("leaves one arm's cell figures untouched when the other arm gains records", () => {
    fc.assert(
      fc.property(arbSlots, arbSlots, (base, extra) => {
        const controlOnly = base.filter((one) => one.strategyArm === 'control');
        const added = extra.map((one) => ({ ...one, strategyArm: 'grounded' as const }));
        const cellsOf = (records: readonly SweepSampleRecord[]): readonly string[] =>
          renderGroundingReport(input(records)).filter(
            (line) => line.includes('instrument-valid ') && line.includes('control '),
          );

        expect(cellsOf([...controlOnly, ...added])).toEqual(cellsOf(controlOnly));
      }),
      { numRuns: 100 },
    );
  });
});
