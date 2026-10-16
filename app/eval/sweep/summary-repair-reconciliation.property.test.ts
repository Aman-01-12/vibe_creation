// testbench-repair-loop, task 10.5: the repair decomposition reconciles with an INDEPENDENT
// recount of the records it was computed from.
//
// WHY THIS IS NOT LITERALLY THE ASSERTION tasks.md NAMES.
//   The task text asks that "valid, no repair" plus "valid, after repair" equal the arm's total
//   instrument-valid count. Against the shipped code that clause is VACUOUS: `summary.ts` computes
//   `validNoRepair = instrument.validSamples - testbenchRepairAccepted` and
//   `validAfterRepair = testbenchRepairAccepted`, so their sum is `validSamples` by construction,
//   for every input. It cannot fail and so constrains nothing. It is kept below as ONE conjunct,
//   beside the recounts that do constrain the decomposition.
//
// WHY `repairAccepted` AND `instrumentValidity` ARE DRAWN INDEPENDENTLY.
//   This spec builds TWO trigger points that both write `repairAccepted`, on different conditions.
//   The eval path (`app/eval/harness.ts` `#repairIfTriggered`) accepts on
//   `finalControl.verdict.validity === 'valid'`. The precheck path
//   (`app/agent/orchestrator/verification-loop.ts`) accepts on the repaired testbench passing its
//   PRECHECK re-check, which is a build check; that sample then proceeds to `#iterate` and can
//   still end `invalid`. So an accepted repair beside a non-valid verdict is a reachable state, and
//   a generator that ties the two together would never test the decomposition at all.
//
// Validates: Requirements 4.4, 4.5.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { SIMULATION_HARNESS_VERSION } from '@app/tools';

import { RECORDED_GOLDEN_KINDS } from '../golden-judge.js';
import type {
  InstrumentDefectCode,
  InstrumentUncheckedReason,
  InstrumentValidity,
} from '../instrument-control.js';
import type { SampleOutcomeStatus } from '../report.js';

import { RESULTS_SCHEMA_VERSION, type SweepSampleRecord } from './results-log.js';
import { summarizeRecords, type SweepSummary } from './summary.js';

const PROPERTY =
  'Feature: testbench-repair-loop, task 10.5: The repair decomposition equals an independent recount';

const NUM_RUNS = 300;
const KS: readonly number[] = [1];
const ARM = 'arm-a';
const MAX_RECORDS = 10;

type DeclineReason =
  | 'no-admissible-revision'
  | 'coverage-validation-failed'
  | 'recheck-failed'
  | 'port-threw'
  | 'port-unavailable';

const DECLINE_REASONS: readonly DeclineReason[] = [
  'no-admissible-revision',
  'coverage-validation-failed',
  'recheck-failed',
  'port-threw',
  'port-unavailable',
];

const DEFECT_CODES: readonly InstrumentDefectCode[] = [
  'TESTBENCH_FAILED_REFERENCE',
  'TESTBENCH_REFERENCE_UNBUILDABLE',
  'CONTROL_RUN_ERRORED',
  'TESTBENCH_SURVIVED_MUTANTS',
];

const UNCHECKED_REASONS: readonly InstrumentUncheckedReason[] = [
  'control-absent',
  'no-testbench',
  'no-reference',
  'control-unavailable',
];

const OUTCOME_STATUSES: readonly SampleOutcomeStatus[] = [
  'verified',
  'unverified',
  'instrument-refused',
];

/** Summarize a clean results file: no corruption, no stale lines, no config filter. */
function summarize(records: readonly SweepSampleRecord[]): SweepSummary {
  return summarizeRecords(records, KS, null, { malformedLines: 0, staleSchemaLines: 0 });
}

/** One record, every field defaulted, so a property states only what it draws. */
function record(overrides: Partial<SweepSampleRecord> = {}): SweepSampleRecord {
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    strategyArm: 'control',
    checkingApproach: 'cycle-timed',
    designGroup: 'cycle-exact',
    testbenchPromptVersion: 7,
    simulationHarnessVersion: SIMULATION_HARNESS_VERSION,
    testbenchParseRefusal: null,
    positiveControlRun: null,
    valuelessFailureReports: 0,
    configHash: 'cfg1',
    armName: ARM,
    modelSignature: 'model-a',
    problemId: 'p1',
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
    instrumentDefect: null,
    instrumentUncheckedReason: null,
    mutation: {
      validCount: 4,
      killedCount: 4,
      noVerdictKills: 0,
      coverageGapOperators: [],
      candidateEquivalentOperators: [],
      goldenSurvivedCount: 0,
      goldenTimeoutCount: 0,
      nonCompilingCount: 0,
      goldenErroredCount: 0,
      elapsedMs: 10,
    },
    repairAttempted: false,
    repairAccepted: false,
    repairDeclineReason: null,
    checkNameVisibilitySignal: false,
    formal: null,
    formalFallbackReason: null,
    formalFallbackRoute: 'not-applicable',
    formalResetContract: null,
    formalAssertionGateEmitted: false,
    formalClockPolarity: null,
    propertySetAdmitted: 'not-gated',
    propertySetAuthoredUpFront: false,
    propertySetSurvivorCount: 0,
    formalMutationCounts: null,
    durationMs: 100,
    completedAtMs: 100,
    failureNote: null,
    noVerdictCause: null,
    ...overrides,
  };
}

/** The three fields that together are one sample's instrument verdict. */
interface Verdict {
  readonly instrumentValidity: InstrumentValidity;
  readonly instrumentDefect: InstrumentDefectCode | null;
  readonly instrumentUncheckedReason: InstrumentUncheckedReason | null;
}

/** A well-formed verdict: a defect only when invalid, a reason only when unchecked. */
const verdictArb: fc.Arbitrary<Verdict> = fc.oneof(
  fc.constant<Verdict>({
    instrumentValidity: 'valid',
    instrumentDefect: null,
    instrumentUncheckedReason: null,
  }),
  fc.constantFrom(...DEFECT_CODES).map<Verdict>((instrumentDefect) => ({
    instrumentValidity: 'invalid',
    instrumentDefect,
    instrumentUncheckedReason: null,
  })),
  fc.constantFrom(...UNCHECKED_REASONS).map<Verdict>((instrumentUncheckedReason) => ({
    instrumentValidity: 'unchecked',
    instrumentDefect: null,
    instrumentUncheckedReason,
  })),
);

/** The repair provenance trio, well formed: a reason if and only if attempted and not accepted. */
const repairArb = fc
  .record({
    attempted: fc.boolean(),
    accepted: fc.boolean(),
    reason: fc.constantFrom(...DECLINE_REASONS),
  })
  .map(({ attempted, accepted, reason }) => ({
    repairAttempted: attempted,
    repairAccepted: attempted && accepted,
    repairDeclineReason: attempted && !accepted ? reason : null,
  }));

/** One arm's records. The verdict and the repair provenance are drawn independently. */
const recordsArb: fc.Arbitrary<readonly SweepSampleRecord[]> = fc
  .array(
    fc.record({
      verdict: verdictArb,
      repair: repairArb,
      status: fc.constantFrom(...OUTCOME_STATUSES),
    }),
    { maxLength: MAX_RECORDS },
  )
  .map((draws) =>
    draws.map((draw, sampleIndex) =>
      record({
        ...draw.verdict,
        ...draw.repair,
        sampleIndex,
        problemId: `p${sampleIndex}`,
        outcomeStatus: draw.status,
        passed: draw.status === 'verified',
        goldenVerdict: RECORDED_GOLDEN_KINDS[0] ?? 'failed',
      }),
    ),
  );

/** An accepted repair, recounted from the records. */
const acceptedIn = (rs: readonly SweepSampleRecord[]): readonly SweepSampleRecord[] =>
  rs.filter((r) => r.repairAttempted && r.repairAccepted);

describe(PROPERTY, () => {
  it('equals the recount on every figure, and never reports a negative count', () => {
    let sawAcceptedButNotValid = 0;
    fc.assert(
      fc.property(recordsArb, (records) => {
        const summary = summarize(records);
        const arm = summary.arms.find((one) => one.armName === ARM);
        if (records.length === 0) {
          expect(arm).toBeUndefined();
          return;
        }
        if (arm === undefined) throw new Error('a non-empty arm must be summarized');

        const valid = records.filter((r) => r.instrumentValidity === 'valid');
        const accepted = acceptedIn(records);
        const acceptedAndValid = accepted.filter((r) => r.instrumentValidity === 'valid');
        if (accepted.length > acceptedAndValid.length) sawAcceptedButNotValid += 1;

        // The premise the decomposition rests on, asserted rather than assumed.
        expect(arm.instrument.validSamples).toBe(valid.length);

        // (a) Neither count can exceed the arm's own sample count.
        expect(arm.testbenchRepairAttempted).toBeLessThanOrEqual(records.length);
        expect(arm.testbenchRepairAccepted).toBeLessThanOrEqual(records.length);
        expect(arm.testbenchRepairAccepted).toBe(accepted.length);

        // A count is never negative. This is what the shipped subtraction can violate.
        expect(arm.validAfterRepair).toBeGreaterThanOrEqual(0);
        expect(arm.validNoRepair).toBeGreaterThanOrEqual(0);

        // The decomposition is OF the instrument-valid total, so each part is a recount of it.
        expect(arm.validAfterRepair).toBe(acceptedAndValid.length);
        expect(arm.validNoRepair).toBe(valid.length - acceptedAndValid.length);

        // (b) The task's own clause, kept, now beside constraints it cannot satisfy alone.
        expect(arm.validNoRepair + arm.validAfterRepair).toBe(arm.instrument.validSamples);
      }),
      { numRuns: NUM_RUNS },
    );
    // Non-vacuity: the reachable state this property exists for was actually drawn.
    expect(sawAcceptedButNotValid).toBeGreaterThan(0);
  });
});
