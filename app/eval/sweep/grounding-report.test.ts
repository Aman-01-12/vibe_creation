// The Grounding report block (grounding-adoption-confirmatory, C6): deterministic, honest
// about a zero denominator, naming all three clause outcomes, and never `succeeded` on a
// criterion the manifest did not record.

import { describe, expect, it } from 'vitest';

import { SIMULATION_HARNESS_VERSION } from '@app/tools';

import { PRE_REGISTERED_GROUNDING_CRITERION } from './grounding-criterion.js';
import {
  CONFIRMATORY_CLAUSES,
  CROSS_RUN_LABEL,
  renderGroundingReport,
  type GroundingReportInput,
} from './grounding-report.js';
import { RESULTS_SCHEMA_VERSION, type SweepSampleRecord } from './results-log.js';

const MODEL_ARMS = ['zai.glm-5'] as const;
const PROBLEMS = ['p1'] as const;

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

/** A probe with `validCount` scored mutants, `gaps` of which the Golden_Judge killed. */
function probe(validCount: number, gaps: number): NonNullable<SweepSampleRecord['mutation']> {
  return {
    validCount,
    killedCount: validCount - gaps,
    noVerdictKills: 0,
    coverageGapOperators: Array.from({ length: gaps }, () => 'ARITH_PLUS_TO_MINUS' as const),
    candidateEquivalentOperators: [],
    goldenSurvivedCount: 0,
    goldenTimeoutCount: 0,
    nonCompilingCount: 0,
    goldenErroredCount: 0,
    elapsedMs: 1,
  };
}

function input(overrides: Partial<GroundingReportInput> = {}): GroundingReportInput {
  return {
    records: [
      record({ strategyArm: 'control', instrumentValidity: 'invalid' }),
      record({
        strategyArm: 'grounded',
        instrumentValidity: 'valid',
        positiveControlRun: {
          passed: true,
          watchdogStopped: false,
          waveformMissing: false,
          knownAnswerOnlyFailure: false,
        },
      }),
    ],
    modelArms: MODEL_ARMS,
    problemIds: PROBLEMS,
    manifestCriterion: PRE_REGISTERED_GROUNDING_CRITERION,
    deferredSlots: 0,
    baseline: { available: false, reason: 'the baseline results file could not be read' },
    baselineRunName: 'scoreboard-ab-v1',
    ...overrides,
  };
}

describe('renderGroundingReport', () => {
  it('renders the same text twice over the same records and manifest', () => {
    expect(renderGroundingReport(input())).toEqual(renderGroundingReport(input()));
  });

  it('labels the cross-run reading so it cannot be read as a Campaign figure', () => {
    const lines = renderGroundingReport(input());

    expect(lines).toContain(CROSS_RUN_LABEL);
    expect(lines.some((line) => line.includes('baseline unavailable:'))).toBe(true);
  });

  it('reports a zero-denominator cell with its zero and an undefined agreement', () => {
    const lines = renderGroundingReport(input({ records: [] }));

    expect(lines.some((line) => line.includes('instrument-valid 0/0'))).toBe(true);
    expect(lines.some((line) => line.includes('golden-agreement undefined'))).toBe(true);
  });

  it('reports the Slot_Pair figures pooled and per Model_Arm', () => {
    const lines = renderGroundingReport(input());

    // One pair, valid only under `grounded`: the discordance the verdict turns on.
    expect(lines).toContain(
      '  slot-pairs pooled: pairs 1 grounded-only-valid 1 control-only-valid 0',
    );
    expect(lines).toContain(
      '  slot-pairs zai.glm-5: pairs 1 grounded-only-valid 1 control-only-valid 0',
    );
  });

  it('decides nothing when the manifest holds no readable pre-registered criterion', () => {
    const lines = renderGroundingReport(input({ manifestCriterion: { minModelArmsGreater: 1 } }));

    expect(lines.some((line) => line.startsWith('GROUNDING VERDICT: not-decided'))).toBe(true);
    expect(lines.some((line) => line.includes('no readable pre-registered'))).toBe(true);
  });

  it('is not decided while a slot is deferred, and still shows every criterion', () => {
    const lines = renderGroundingReport(input({ deferredSlots: 2 }));

    expect(lines.some((line) => line.includes('GROUNDING VERDICT: not-decided'))).toBe(true);
    expect(lines.some((line) => line.includes('2 slot(s) still deferred'))).toBe(true);
    for (const clause of CONFIRMATORY_CLAUSES) {
      const rendered = lines.find((line) => line.trim().startsWith(`${clause.id} `)) ?? '';
      expect(rendered).toContain(clause.label);
      expect(rendered).toMatch(/held|NOT held|not decided/);
    }
  });

  it('names the third outcome rather than collapsing it into NOT held', () => {
    // 33 Judged_Samples cannot carry the 3-point margin, so both sample-level guards have
    // concluded nothing and the line must say so.
    const lines = renderGroundingReport(input());
    const missedBug = lines.find((line) => line.trim().startsWith('8.1 ')) ?? '';
    const agreement = lines.find((line) => line.trim().startsWith('8.2 ')) ?? '';

    expect(missedBug).toContain('not decided');
    expect(agreement).toContain('not decided');
    expect(missedBug).toContain('min-denominator 34');
    expect(missedBug).toContain('margin 3pt');
  });

  it('renders the per-mutant clause with both arms, both rates, and the difference', () => {
    const lines = renderGroundingReport(
      input({
        records: [
          record({ strategyArm: 'control', mutation: probe(4, 1) }),
          record({ strategyArm: 'grounded', mutation: probe(10, 1) }),
        ],
      }),
    );
    const clause = lines.find((line) => line.trim().startsWith('7.1 ')) ?? '';

    expect(clause).toContain('coverage-gap rate non-inferior');
    expect(clause).toContain('control 1/4 0.250');
    expect(clause).toContain('grounded 1/10 0.100');
    expect(clause).toContain('difference -15.00pt');
    expect(clause).toContain('margin 2pt');
  });

  it('reports the coverage-gap and operator blocks at every declared scope', () => {
    const lines = renderGroundingReport(
      input({
        records: [
          record({ strategyArm: 'control', mutation: probe(4, 1) }),
          record({ strategyArm: 'grounded', mutation: probe(10, 0) }),
        ],
      }),
    );

    expect(lines).toContain('    coverage-gap control  ALL: 1/4 0.250');
    expect(lines).toContain('    coverage-gap grounded ALL: 0/10 0.000');
    expect(lines).toContain('    coverage-gap control  zai.glm-5: 1/4 0.250');
    expect(
      lines.some(
        (line) =>
          line.startsWith('    coverage-gap grounded zai.glm-5:') &&
          line.includes('difference -25.00pt'),
      ),
    ).toBe(true);
    expect(lines).toContain('    operators control  ALL: ARITH_PLUS_TO_MINUS 1');
    expect(lines).toContain('    operators grounded ALL: none');
  });

  it('reports every deferrable cause, including the ones with no deferrals', () => {
    const lines = renderGroundingReport(
      input({
        records: [
          record({
            strategyArm: 'grounded',
            outcomeStatus: 'setup-failed',
            noVerdictCause: 'provider-unreachable',
          }),
        ],
      }),
    );
    const grounded = lines.find((line) => line.startsWith('  deferred-by-cause grounded:')) ?? '';

    expect(grounded).toContain('provider-unreachable 1');
    expect(grounded).toContain('harness-error 0');
    expect(grounded).toContain('provider-refused-credential 0');
    // A cause that is NOT deferrable has no place in a deferral tally.
    expect(grounded).not.toContain('budget-exhausted');
  });

  it('counts the per-cause figures the Campaign is diagnosed from', () => {
    const lines = renderGroundingReport(
      input({
        records: [
          record({
            strategyArm: 'grounded',
            testbenchParseRefusal: 'no-fence',
            outcomeStatus: 'setup-failed',
            instrumentValidity: 'unchecked',
            instrumentUncheckedReason: 'control-resource-exhausted',
            positiveControlRun: {
              passed: false,
              watchdogStopped: true,
              waveformMissing: true,
              knownAnswerOnlyFailure: true,
            },
          }),
        ],
      }),
    );

    const groundedArm = lines.find((line) => line.includes('grounded ALL:')) ?? '';
    expect(groundedArm).toContain('parse-refusals no-fence 1');
    expect(groundedArm).toContain('watchdog-stops 1/1');
    expect(groundedArm).toContain('resource-exhausted 1/1');
    expect(groundedArm).toContain('waveform-missing 1/1');
    expect(groundedArm).toContain('known-answer-only 1/1');
  });
});
