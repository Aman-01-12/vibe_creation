// **Feature: formal-gate-first-light, Property 31: Aggregating a mixed results log states what
// it aggregated**
//
// WHAT THIS FILE CLAIMS
//   Criterion 9.8 asks a results file holding records from more than one dispatch of ONE
//   configuration for two numbers at the REPORT level: the count of records aggregated, and the
//   count of those records carrying no verdict. So the window here is the report header - the
//   lines above the first arm block, where `samples aggregated:` already lives. The per-arm
//   breakdowns are a different population and are `formal-summary-aggregation.property.test.ts`'s
//   claim, not this one's.
//
// THIS PROPERTY IS RED, AND THE GAP IS REAL
//   The header states the aggregated count and NOTHING states the no-verdict count. The
//   `DEFERRED:` banner counts only the deferrable causes, so it is strictly smaller whenever a
//   finding (`gate-refused`, `instrument-refused`) carries the no-verdict record, and it is
//   absent entirely when every no-verdict record is a finding. The arm's `statuses:` row is
//   per-status and per-arm: a reader has to know which two of the six statuses bear a verdict and
//   sum the rest across arms, which is a derivation, not a stated count.
//
// THE FALSIFICATIONS IT IS BUILT TO CATCH
//   A renderer stating the latest dispatch's count rather than the file's (the generator draws
//   several dispatches over the same problems, and the stated count is checked against the whole
//   file), one stating an unscoped count (foreign-`configHash` records are drawn in and must not
//   be counted), and one omitting the no-verdict count or substituting the deferred count for it.
//
// The tag is a literal, not `propertyTag(...)`, whose feature slug is hardcoded to a different
// spec (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// **Validates: Requirements 9.8**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { SIMULATION_HARNESS_VERSION } from '@app/tools';

import {
  renderSummary,
  RESULTS_SCHEMA_VERSION,
  summarizeRecords,
  type NoVerdictCause,
  type SampleOutcomeStatus,
  type SweepSampleRecord,
} from '@app/eval';

import { propertyParameters } from './property.js';

const PROPERTY =
  'formal-gate-first-light, Property 31: Aggregating a mixed results log states what it ' +
  'aggregated';

/** The design's floor. */
const NUM_RUNS = 100;

/** The one configuration every dispatch below belongs to, and a second nothing may count. */
const CONFIG_HASH = 'cfg-mixed-dispatch-31';
const OTHER_CONFIG_HASH = 'cfg-other-experiment';

const KS: readonly number[] = [1];

/** Nothing malformed and nothing stale, so every scoped record is aggregated, not refused. */
const HEALTHY_LOG = { malformedLines: 0, staleSchemaLines: 0 } as const;

/** Enough dispatches for a re-dispatched file, and enough slots per dispatch to vary the tally. */
const MAX_DISPATCHES = 3;
const MAX_SLOTS = 3;
const MAX_FOREIGN = 2;

/** The two statuses that mean the oracle spoke; every other status carries no verdict. */
const VERDICT_BEARING: readonly SampleOutcomeStatus[] = ['verified', 'unverified'];

/**
 * The no-verdict statuses, each with the cause the harness records for it.
 *
 * Both sides of the deferrable split are here on purpose: `gate-refused` and
 * `instrument-refused` are FINDINGS, so a draw holding only those renders no `DEFERRED:` banner
 * at all, and the deferred count can never stand in for the no-verdict count.
 */
const NO_VERDICT_CAUSE_BY_STATUS: Readonly<Partial<Record<SampleOutcomeStatus, NoVerdictCause>>> = {
  blocked: 'gate-refused',
  'setup-failed': 'provider-unreachable',
  'instrument-refused': 'instrument-refused',
  'runner-error': 'harness-error',
};

/** Derived from the table above, so a status drawn here always has a cause to record. */
const NO_VERDICT_STATUSES = Object.keys(
  NO_VERDICT_CAUSE_BY_STATUS,
) as readonly SampleOutcomeStatus[];

const DRAWN_STATUSES: readonly SampleOutcomeStatus[] = [...VERDICT_BEARING, ...NO_VERDICT_STATUSES];

/** Every field no count in this file reads, at values the summary accepts. */
const BASE_RECORD: SweepSampleRecord = {
  schemaVersion: RESULTS_SCHEMA_VERSION,
  strategyArm: 'control',
  checkingApproach: 'cycle-timed',
  designGroup: 'cycle-exact',
  testbenchPromptVersion: 4,
  simulationHarnessVersion: SIMULATION_HARNESS_VERSION,
  testbenchParseRefusal: null,
  positiveControlRun: null,
  // The base sample's testbench was measured and gave every failure report a value.
  valuelessFailureReports: 0,
  configHash: CONFIG_HASH,
  armName: 'arm-0',
  modelSignature: 'zai.glm-5',
  problemId: 'problem-0',
  sampleIndex: 0,
  seed: 1,
  passed: true,
  outcomeStatus: 'verified',
  iterations: 1,
  costCents: 1,
  costKnown: true,
  promptTokens: 800,
  completionTokens: 200,
  totalTokens: 1_000,
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
  durationMs: 1_000,
  completedAtMs: 1_000,
  failureNote: null,
  noVerdictCause: null,
};

/** One drawn log: the dispatches of this configuration, and records of another nothing counts. */
interface DrawnLog {
  /** Each dispatch's outcome statuses, in dispatch order; one entry per recorded slot. */
  readonly dispatches: readonly (readonly SampleOutcomeStatus[])[];
  readonly foreignRecords: number;
}

function carriesVerdict(status: SampleOutcomeStatus): boolean {
  return VERDICT_BEARING.includes(status);
}

/**
 * One record of one dispatch.
 *
 * `problemId` is the SLOT, so a later dispatch re-dispatches the same problems and is
 * distinguished by `sampleIndex` and `completedAtMs` alone - which is what a re-dispatched file
 * looks like. The `failureNote` is unique per record, so no `no-verdict why:` row can state the
 * arm's tally by accident.
 */
function recordOf(status: SampleOutcomeStatus, dispatch: number, slot: number): SweepSampleRecord {
  const base = {
    ...BASE_RECORD,
    problemId: `problem-${slot}`,
    sampleIndex: dispatch,
    completedAtMs: (dispatch + 1) * 1_000 + slot,
    outcomeStatus: status,
    passed: status === 'verified',
  };
  if (carriesVerdict(status)) {
    return base;
  }
  return {
    ...base,
    goldenVerdict: null,
    instrumentValidity: 'unchecked',
    instrumentUncheckedReason: 'control-absent',
    mutation: null,
    noVerdictCause: NO_VERDICT_CAUSE_BY_STATUS[status] ?? null,
    failureNote: `slot ${dispatch}-${slot} reached no verdict`,
  };
}

/** A record of a DIFFERENT configuration: present in the file, outside what is aggregated. */
function foreignRecordOf(index: number): SweepSampleRecord {
  return {
    ...BASE_RECORD,
    configHash: OTHER_CONFIG_HASH,
    problemId: `other-problem-${index}`,
    sampleIndex: index,
  };
}

function logArbitrary(): fc.Arbitrary<DrawnLog> {
  return fc.record({
    dispatches: fc.array(
      fc.array(fc.constantFrom(...DRAWN_STATUSES), { minLength: 1, maxLength: MAX_SLOTS }),
      { minLength: 1, maxLength: MAX_DISPATCHES },
    ),
    foreignRecords: fc.integer({ min: 0, max: MAX_FOREIGN }),
  });
}

function recordsOf(log: DrawnLog): readonly SweepSampleRecord[] {
  return [
    ...log.dispatches.flatMap((statuses, dispatch) =>
      statuses.map((status, slot) => recordOf(status, dispatch, slot)),
    ),
    ...Array.from({ length: log.foreignRecords }, (_unused, index) => foreignRecordOf(index)),
  ];
}

/** The report-level header: every line above the first arm block. */
function headerOf(lines: readonly string[]): readonly string[] {
  const firstArm = lines.findIndex((line) => line.startsWith('arm '));
  return firstArm === -1 ? lines : lines.slice(0, firstArm);
}

/** Every integer stated on the header lines that name `subject`. */
function statedCounts(header: readonly string[], subject: RegExp): readonly number[] {
  return header
    .filter((line) => subject.test(line))
    .flatMap((line) => [...line.matchAll(/\d+/g)].map(([digits]) => Number(digits)));
}

const AGGREGATED = /aggregat/i;
const NO_VERDICT = /verdict/i;

/** One stated count, or a failure naming which half of criterion 9.8 the report left out. */
function assertStated(
  header: readonly string[],
  subject: RegExp,
  expected: number,
  claim: string,
): void {
  expect(
    statedCounts(header, subject),
    `the report states no ${claim} of ${expected}. Header lines naming it carry ` +
      `[${statedCounts(header, subject).join(', ')}]:\n${header.join('\n')}`,
  ).toContain(expected);
}

/**
 * Criterion 9.8, against a tally computed from the drawn statuses alone.
 *
 * The aggregated count is checked for every log, because that half is a statement about what the
 * report scoped in whether or not the file was re-dispatched. The no-verdict count is checked
 * under the criterion's own guard, so a counterexample is always a genuinely mixed file.
 */
function assertStatesWhatItAggregated(log: DrawnLog): void {
  const scoped = log.dispatches.flat();
  const header = headerOf(
    renderSummary(summarizeRecords(recordsOf(log), KS, CONFIG_HASH, HEALTHY_LOG)),
  );
  assertStated(header, AGGREGATED, scoped.length, 'count of records aggregated');
  if (log.dispatches.length < 2) {
    return;
  }
  assertStated(
    header,
    NO_VERDICT,
    scoped.filter((status) => !carriesVerdict(status)).length,
    'count of aggregated records carrying no verdict',
  );
}

/** What the draws have to have contained for the two claims above to mean anything. */
interface Coverage {
  multipleDispatches: boolean;
  /** A log whose last dispatch is smaller than the file: a latest-only count would be wrong. */
  latestDispatchSmallerThanFile: boolean;
  /** A log whose no-verdict records are ALL findings, so no `DEFERRED:` banner is rendered. */
  findingsOnlyNoVerdict: boolean;
  /** A log where the deferred count is strictly smaller than the no-verdict count. */
  deferredBelowNoVerdict: boolean;
  foreignRecords: boolean;
}

const DEFERRABLE_STATUSES: readonly SampleOutcomeStatus[] = ['setup-failed', 'runner-error'];

function observe(coverage: Coverage, log: DrawnLog): void {
  const scoped = log.dispatches.flat();
  const noVerdict = scoped.filter((status) => !carriesVerdict(status));
  const deferred = noVerdict.filter((status) => DEFERRABLE_STATUSES.includes(status));
  const latest = log.dispatches[log.dispatches.length - 1] ?? [];
  coverage.multipleDispatches ||= log.dispatches.length > 1;
  coverage.latestDispatchSmallerThanFile ||= latest.length < scoped.length;
  coverage.findingsOnlyNoVerdict ||= noVerdict.length > 0 && deferred.length === 0;
  coverage.deferredBelowNoVerdict ||= deferred.length < noVerdict.length;
  coverage.foreignRecords ||= log.foreignRecords > 0;
}

describe(PROPERTY, () => {
  it('states the count of records it aggregated and the count of those carrying no verdict', () => {
    const coverage: Coverage = {
      multipleDispatches: false,
      latestDispatchSmallerThanFile: false,
      findingsOnlyNoVerdict: false,
      deferredBelowNoVerdict: false,
      foreignRecords: false,
    };
    fc.assert(
      fc.property(logArbitrary(), (log) => {
        observe(coverage, log);
        assertStatesWhatItAggregated(log);
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );
    expect(Object.entries(coverage).filter(([, seen]) => !seen)).toEqual([]);
  });

  it('states a no-verdict count no per-status row states, for two dispatches of one configuration', () => {
    // Two no-verdict records under DIFFERENT statuses and different notes, so every per-status
    // and per-note row says 1 and only a file-level count can say 2.
    const log: DrawnLog = {
      dispatches: [
        ['verified', 'blocked'],
        ['unverified', 'runner-error'],
      ],
      foreignRecords: 1,
    };
    assertStatesWhatItAggregated(log);
  });
});
