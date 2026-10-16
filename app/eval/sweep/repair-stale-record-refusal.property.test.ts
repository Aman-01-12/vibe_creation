// testbench-repair-loop, task 10.2, Property 10: A stale record is refused, never
// repaired into meaning something it did not measure.
//
// DRIFT NOTE. Task 10.1 of this spec historically bumped `RESULTS_SCHEMA_VERSION` to 11;
// the constant now reads a higher value, because later specs moved it further. This file
// is written against the CURRENT constant read live from `results-log.ts`, not against
// the literal "11" the task text names, matching the precedent this spec's own
// `summary-repair-reconciliation.property.test.ts` and the sibling
// `testbench-failure-reportability` spec's drift notes already set.
//
// THIS SPEC'S OWN ANGLE. `repairAttempted`/`repairAccepted` did not exist before the
// schema bump this spec made. A record written at any OTHER version - lower (predates the
// fields) or higher (a later build's own redefinition) - must be refused WHOLE, never
// decoded with those two fields silently defaulted to `false`. `decodeSampleRecord`
// refuses on `schemaVersion !== RESULTS_SCHEMA_VERSION` before reading any other field, so
// a record missing the two repair fields ENTIRELY and a record at a stale version that
// happens to carry them are both refused identically - the version gate runs first.
//
// Validates: Requirements 7.7, 7.8, 7.9

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { SIMULATION_HARNESS_VERSION } from '@app/tools';

import {
  decodeSampleRecord,
  parseResultsLog,
  RESULTS_SCHEMA_VERSION,
  type SweepSampleRecord,
} from './results-log.js';

const PROPERTY =
  'testbench-repair-loop, Property 10: A stale record is refused, never repaired into meaning something it did not measure';

/** A complete, current-schema record; each generated case overrides only what it varies. */
function currentRecord(overrides: Partial<SweepSampleRecord> = {}): SweepSampleRecord {
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    strategyArm: 'control',
    checkingApproach: 'cycle-timed',
    designGroup: 'cycle-exact',
    testbenchPromptVersion: 4,
    simulationHarnessVersion: SIMULATION_HARNESS_VERSION,
    testbenchParseRefusal: null,
    positiveControlRun: null,
    valuelessFailureReports: 0,
    configHash: 'abc123',
    armName: 'glm-5',
    modelSignature: 'zai.glm-5',
    problemId: 'rtllm/arithmetic/adder_8bit',
    sampleIndex: 0,
    seed: 12345,
    passed: true,
    outcomeStatus: 'verified',
    iterations: 1,
    costCents: 3.5,
    costKnown: true,
    promptTokens: 1_200,
    completionTokens: 300,
    totalTokens: 1_500,
    unreportedUsageCalls: 0,
    stopReason: null,
    goldenVerdict: 'passed',
    goldenFailureCount: 0,
    instrumentValidity: 'valid',
    instrumentDefect: null,
    instrumentUncheckedReason: null,
    mutation: {
      validCount: 4,
      killedCount: 4,
      noVerdictKills: 0,
      coverageGapOperators: [],
      candidateEquivalentOperators: [],
      goldenSurvivedCount: 2,
      goldenTimeoutCount: 0,
      nonCompilingCount: 1,
      goldenErroredCount: 0,
      elapsedMs: 3_200,
    },
    repairAttempted: false,
    repairAccepted: false,
    repairDeclineReason: null,
    checkNameVisibilitySignal: false,
    formal: {
      verdict: 'proved',
      cause: null,
      conditions: {
        assertionCount: 2,
        presat: 'satisfiable',
        cover: { reached: true, step: 1 },
        base: 'passed',
        induction: 'successful',
      },
      depth: 20,
      elapsedMs: 3_350,
    },
    formalFallbackReason: null,
    formalFallbackRoute: 'not-applicable',
    formalResetContract: {
      derived: true,
      resetName: 'rst_n',
      resetActiveLow: true,
      resetKind: 'async',
      initialStateFree: false,
    },
    formalAssertionGateEmitted: false,
    formalClockPolarity: 'posedge',
    propertySetAdmitted: 'not-gated',
    propertySetAuthoredUpFront: false,
    propertySetSurvivorCount: 0,
    formalMutationCounts: null,
    durationMs: 42_000,
    completedAtMs: 1_700_000_000_000,
    failureNote: null,
    noVerdictCause: null,
    ...overrides,
  };
}

/** A version strictly below the current one, drawn from a wide range including 0. */
const olderVersionArb = fc.integer({ min: 0, max: RESULTS_SCHEMA_VERSION - 1 });
/** A version strictly above the current one, so a later build's record is covered too. */
const newerVersionArb = fc.integer({
  min: RESULTS_SCHEMA_VERSION + 1,
  max: RESULTS_SCHEMA_VERSION + 50,
});

/** A record at `version`, as JSON, with `repairAttempted`/`repairAccepted` present. */
function withRepairFields(version: number): string {
  return JSON.stringify(currentRecord({ schemaVersion: version }));
}

/** A record at `version`, as JSON, missing BOTH repair fields entirely - predating them. */
function withoutRepairFields(version: number): string {
  const full = currentRecord({ schemaVersion: version }) as unknown as Record<string, unknown>;
  const { repairAttempted, repairAccepted, ...rest } = full;
  void repairAttempted;
  void repairAccepted;
  return JSON.stringify(rest);
}

describe(PROPERTY, () => {
  it('refuses any record whose schemaVersion is not the current one, with or without the repair fields', () => {
    let sawOlderWithFields = false;
    let sawOlderMissingFields = false;
    let sawNewerWithFields = false;
    let sawNewerMissingFields = false;

    fc.assert(
      fc.property(
        fc.oneof(olderVersionArb, newerVersionArb),
        fc.boolean(),
        (version, carriesRepairFields) => {
          const isOlder = version < RESULTS_SCHEMA_VERSION;
          if (isOlder && carriesRepairFields) sawOlderWithFields = true;
          else if (isOlder) sawOlderMissingFields = true;
          else if (carriesRepairFields) sawNewerWithFields = true;
          else sawNewerMissingFields = true;

          const line = carriesRepairFields
            ? withRepairFields(version)
            : withoutRepairFields(version);
          const raw: unknown = JSON.parse(line);

          // decodeSampleRecord refuses outright: never a record carrying repairAttempted/
          // repairAccepted defaulted to false for a sample this build never measured them on.
          expect(decodeSampleRecord(raw)).toBeNull();

          // The whole-file reader counts it as stale, never as a decoded (or malformed) line.
          const parsed = parseResultsLog(line);
          expect(parsed.records).toEqual([]);
          expect(parsed.staleSchemaLines).toBe(1);
          expect(parsed.malformedLines).toBe(0);
        },
      ),
      { numRuns: 200 },
    );

    // Non-vacuity: every one of the four cells (older/newer x with/without the repair
    // fields) was actually drawn, not merely sampled by luck.
    expect(sawOlderWithFields).toBe(true);
    expect(sawOlderMissingFields).toBe(true);
    expect(sawNewerWithFields).toBe(true);
    expect(sawNewerMissingFields).toBe(true);
  });

  it('accepts the identical record at the current schema version, as the positive control', () => {
    const line = withRepairFields(RESULTS_SCHEMA_VERSION);
    const raw: unknown = JSON.parse(line);
    expect(decodeSampleRecord(raw)).not.toBeNull();
    const parsed = parseResultsLog(line);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.staleSchemaLines).toBe(0);
    expect(parsed.malformedLines).toBe(0);
  });
});
