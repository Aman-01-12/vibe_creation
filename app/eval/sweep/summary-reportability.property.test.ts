// Feature: testbench-failure-reportability, properties of the per-arm reportability figures.
//
// Every oracle here recounts from the requirement text over the drawn records, never by calling
// the summarizer's internals. Property 9 lives here; Properties 10, 11, and 8 are appended later.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { SIMULATION_HARNESS_VERSION } from '@app/tools';

import { RECORDED_GOLDEN_KINDS } from '../golden-judge.js';
import type {
  InstrumentDefectCode,
  InstrumentUncheckedReason,
  InstrumentValidity,
} from '../instrument-control.js';
import { NO_VERDICT_CAUSES } from '../no-verdict-cause.js';
import type { SampleOutcomeStatus } from '../report.js';

import { RESULTS_SCHEMA_VERSION, type SweepSampleRecord } from './results-log.js';
import {
  CONFIRMATORY_CONTROL_COVERAGE_GAP,
  CROSS_RUN_TAG,
  renderSummary,
  summarizeRecords,
  type ArmReportabilityReport,
  type SweepSummary,
} from './summary.js';

const PROPERTY_9 =
  'Feature: testbench-failure-reportability, Property 9: The rate is its own numerator over its own denominator';
const PROPERTY_10 =
  'Feature: testbench-failure-reportability, Property 10: Every declared Model_Arm renders a row with both rates';

const NUM_RUNS = 100;
const KS: readonly number[] = [1];
const ARM_NAMES: readonly string[] = ['glm-5', 'kimi-k2.5', 'deepseek-v3.2'];
const MAX_RECORDS_PER_ARM = 8;
const MAX_VALUELESS_COUNT = 4;

const OUTCOME_STATUSES: readonly SampleOutcomeStatus[] = [
  'verified',
  'unverified',
  'blocked',
  'setup-failed',
  'runner-error',
  'instrument-refused',
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

/** Summarize a clean results file: no corruption, no stale-schema lines, no config filter. */
function summarize(records: readonly SweepSampleRecord[]): SweepSummary {
  return summarizeRecords(records, KS, null, { malformedLines: 0, staleSchemaLines: 0 });
}

/** One record; every field defaulted so a property states only what it draws. */
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
    promptTokens: 800,
    completionTokens: 200,
    totalTokens: 1_000,
    unreportedUsageCalls: 0,
    stopReason: 'max-iterations',
    goldenVerdict: 'failed',
    goldenFailureCount: 2,
    instrumentValidity: 'valid',
    instrumentDefect: null,
    instrumentUncheckedReason: null,
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
    ...overrides,
  };
}

/** The three fields that together are one sample's instrument verdict. */
interface InstrumentVerdict {
  readonly instrumentValidity: InstrumentValidity;
  readonly instrumentDefect: InstrumentDefectCode | null;
  readonly instrumentUncheckedReason: InstrumentUncheckedReason | null;
}

/** A well-formed verdict: a defect only when invalid, a reason only when unchecked. */
const instrumentVerdictArb: fc.Arbitrary<InstrumentVerdict> = fc.oneof(
  fc.constant<InstrumentVerdict>({
    instrumentValidity: 'valid',
    instrumentDefect: null,
    instrumentUncheckedReason: null,
  }),
  fc.constantFrom(...DEFECT_CODES).map<InstrumentVerdict>((instrumentDefect) => ({
    instrumentValidity: 'invalid',
    instrumentDefect,
    instrumentUncheckedReason: null,
  })),
  fc.constantFrom(...UNCHECKED_REASONS).map<InstrumentVerdict>((instrumentUncheckedReason) => ({
    instrumentValidity: 'unchecked',
    instrumentDefect: null,
    instrumentUncheckedReason,
  })),
);

/** A count that is `null` (no measured testbench), zero, or positive, each often. */
const valuelessCountArb: fc.Arbitrary<number | null> = fc.oneof(
  fc.constant(null),
  fc.constant(0),
  fc.integer({ min: 1, max: MAX_VALUELESS_COUNT }),
);

/** Everything a record varies on except its arm, so the arm is assigned by the set builder. */
const sampleArb: fc.Arbitrary<Partial<SweepSampleRecord>> = fc
  .record({
    verdict: instrumentVerdictArb,
    outcomeStatus: fc.constantFrom(...OUTCOME_STATUSES),
    goldenVerdict: fc.option(fc.constantFrom(...RECORDED_GOLDEN_KINDS), { nil: null }),
    noVerdictCause: fc.option(fc.constantFrom(...NO_VERDICT_CAUSES), { nil: null }),
    valuelessFailureReports: valuelessCountArb,
    problemId: fc.constantFrom('p1', 'p2', 'p3'),
  })
  .map(({ verdict, outcomeStatus, ...rest }) => ({
    ...verdict,
    ...rest,
    outcomeStatus,
    passed: outcomeStatus === 'verified',
  }));

/** A drawn results file: the declared arms and the records, some arms empty or all-`null`. */
interface RecordSet {
  readonly armNames: readonly string[];
  readonly records: readonly SweepSampleRecord[];
}

/** A permutation of `0..length-1`. */
function permutationArb(length: number): fc.Arbitrary<readonly number[]> {
  const indices = Array.from({ length }, (_, index) => index);
  return fc.shuffledSubarray(indices, { minLength: length, maxLength: length });
}

/** One arm's records; `allNull` plants the zero-denominator case instead of hoping for it. */
function armRecordsArb(armName: string): fc.Arbitrary<readonly SweepSampleRecord[]> {
  return fc
    .record({
      allNull: fc.boolean(),
      samples: fc.array(sampleArb, { maxLength: MAX_RECORDS_PER_ARM }),
    })
    .map(({ allNull, samples }) =>
      samples.map((sample, sampleIndex) =>
        record({
          ...sample,
          armName,
          modelSignature: armName,
          sampleIndex,
          ...(allNull ? { valuelessFailureReports: null } : {}),
        }),
      ),
    );
}

/** Two to three declared arms, their records interleaved by a drawn order. */
const recordSetArb: fc.Arbitrary<RecordSet> = fc
  .shuffledSubarray([...ARM_NAMES], { minLength: 2, maxLength: 3 })
  .chain((armNames) =>
    fc
      .tuple(...armNames.map(armRecordsArb))
      .map((perArm) => perArm.flat())
      .chain((records) =>
        permutationArb(records.length).map((order) => order.map((i) => records[i]!)),
      )
      .map((records) => ({ armNames, records })),
  );

/** The recount, from Req 8.7 and 8.11: a `null` count is in neither numerator nor denominator. */
function recount(records: readonly SweepSampleRecord[], armName: string): ArmReportabilityReport {
  let sources = 0;
  let withReport = 0;
  for (const sample of records) {
    if (sample.armName !== armName || sample.valuelessFailureReports === null) {
      continue;
    }
    sources += 1;
    withReport += sample.valuelessFailureReports > 0 ? 1 : 0;
  }
  return { withReport, sources, valuelessReportRate: sources === 0 ? null : withReport / sources };
}

/** Each summarized arm's reportability, keyed by arm name. */
function reportabilityByArm(summary: SweepSummary): ReadonlyMap<string, ArmReportabilityReport> {
  return new Map(summary.arms.map((arm) => [arm.armName, arm.reportability]));
}

/** The same records with their instrument verdicts redistributed by `order`. */
function permuteVerdicts(
  records: readonly SweepSampleRecord[],
  order: readonly number[],
): readonly SweepSampleRecord[] {
  return records.map((sample, index) => {
    const donor = records[order[index]!]!;
    return {
      ...sample,
      instrumentValidity: donor.instrumentValidity,
      instrumentDefect: donor.instrumentDefect,
      instrumentUncheckedReason: donor.instrumentUncheckedReason,
    };
  });
}

/** A record set with two independent permutations of its indices. */
const permutedSetArb = recordSetArb.chain((set) =>
  fc.tuple(
    fc.constant(set),
    permutationArb(set.records.length),
    permutationArb(set.records.length),
  ),
);

describe(PROPERTY_9, () => {
  // **Validates: Requirements 5.9, 6.4, 8.7, 8.11**
  it('equals the independent recount per arm, null at a zero denominator', () => {
    fc.assert(
      fc.property(recordSetArb, ({ armNames, records }) => {
        const reported = reportabilityByArm(summarize(records));
        const present = armNames.filter((name) => records.some((r) => r.armName === name));
        expect([...reported.keys()].sort()).toEqual([...present].sort());
        for (const name of present) {
          expect(reported.get(name)).toEqual(recount(records, name));
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('is unchanged by reordering the records or permuting their instrument verdicts', () => {
    fc.assert(
      fc.property(permutedSetArb, ([{ records }, reorder, verdictOrder]) => {
        const baseline = reportabilityByArm(summarize(records));
        const reordered = reorder.map((index) => records[index]!);
        expect(reportabilityByArm(summarize(reordered))).toEqual(baseline);
        expect(reportabilityByArm(summarize(permuteVerdicts(records, verdictOrder)))).toEqual(
          baseline,
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

const BLOCK_TITLE = 'reportability (Valueless_Report_Rate beside Coverage_Gap_Survivor_Rate';
const RUN_TOTAL_LABEL = 'run total';
/** Declared arms that never appear in a record, so the empty-row half is always drawn. */
const SILENT_ARM_NAMES: readonly string[] = ['silent-a', 'silent-b'];
const FRACTION_PATTERN = /^(\d+)\/(\d+)$/;
const RATE_DIGITS = 3;

/** A record set whose declared arms add one or two record-less arms, in a drawn order. */
const declaredSetArb = recordSetArb.chain(({ armNames, records }) =>
  fc
    .shuffledSubarray([...SILENT_ARM_NAMES], { minLength: 1 })
    .chain((silent) => {
      const declared = [...armNames, ...silent];
      return permutationArb(declared.length).map((order) => order.map((i) => declared[i]!));
    })
    .map((declaredArms) => ({ declaredArms, records })),
);

/** The arm rows of the reportability block: between its column header and the run total. */
function armRows(lines: readonly string[]): readonly (readonly string[])[] {
  const start = lines.findIndex((line) => line.startsWith(BLOCK_TITLE));
  expect(start).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex(
    (line, index) => index > start && line.startsWith(`  ${RUN_TOTAL_LABEL} `),
  );
  expect(end).toBeGreaterThan(start);
  return lines.slice(start + 2, end).map((line) => line.trim().split(/\s+/));
}

/** Check one `n/d rate` pair: `undefined` exactly at a zero denominator, else n/d to 3 places. */
function expectPair(fraction: string | undefined, rendered: string | undefined): void {
  const match = FRACTION_PATTERN.exec(fraction ?? '');
  expect(match).not.toBeNull();
  const numerator = Number(match?.[1]);
  const denominator = Number(match?.[2]);
  const expected = denominator === 0 ? 'undefined' : (numerator / denominator).toFixed(RATE_DIGITS);
  expect(rendered).toBe(expected);
}

describe(PROPERTY_10, () => {
  // **Validates: Requirements 8.8, 8.9**
  it('renders one row per declared arm, both pairs beside their own fractions', () => {
    fc.assert(
      fc.property(declaredSetArb, ({ declaredArms, records }) => {
        const lines = renderSummary(summarize(records), { declaredArms, baseline: null });
        const rows = armRows(lines);
        expect(rows.map((row) => row[0]).sort()).toEqual([...declaredArms].sort());
        for (const [name, valueless, valuelessRate, gap, gapRate, ...rest] of rows) {
          expect(rest).toEqual([]);
          expectPair(valueless, valuelessRate);
          expectPair(gap, gapRate);
          const { withReport, sources } = recount(records, name ?? '');
          expect(valueless).toBe(`${withReport}/${sources}`);
          if (!records.some((sample) => sample.armName === name)) {
            expect([valueless, valuelessRate, gap, gapRate]).toEqual([
              '0/0',
              'undefined',
              '0/0',
              'undefined',
            ]);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

const PROPERTY_11 =
  'Feature: testbench-failure-reportability, Property 11: A cross-run figure is never rendered unlabelled';
/** Cross-run rows are found by their row label, never by the figures they hold. */
const CROSS_RUN_ROW_LABELS: readonly RegExp[] = [/^\s+Pinned_Baseline\s/, /^\s+Confirmatory\s/];
const MAX_FREE_SOURCES = 12;

type Baseline = Pick<ArmReportabilityReport, 'withReport' | 'sources'>;

/** No baseline, one copied from a slice row's valueless figure, or an unrelated one. */
type BaselineDraw =
  | { readonly kind: 'none' }
  | { readonly kind: 'collide'; readonly pick: number }
  | { readonly kind: 'free'; readonly baseline: Baseline };

const baselineDrawArb: fc.Arbitrary<BaselineDraw> = fc.oneof(
  fc.constant<BaselineDraw>({ kind: 'none' }),
  fc.nat().map<BaselineDraw>((pick) => ({ kind: 'collide', pick })),
  fc
    .integer({ min: 0, max: MAX_FREE_SOURCES })
    .chain((sources) =>
      fc.integer({ min: 0, max: sources }).map((withReport) => ({ withReport, sources })),
    )
    .map<BaselineDraw>((baseline) => ({ kind: 'free', baseline })),
);

const crossRunSetArb = fc.record({ set: declaredSetArb, draw: baselineDrawArb });

/** Every slice row's valueless figure, recounted: one per declared arm, then the run total. */
function sliceFigures(
  declaredArms: readonly string[],
  records: readonly SweepSampleRecord[],
): Baseline[] {
  const perArm = declaredArms.map((name) => recount(records, name));
  const total = perArm.reduce(
    (sum, arm) => ({
      withReport: sum.withReport + arm.withReport,
      sources: sum.sources + arm.sources,
    }),
    { withReport: 0, sources: 0 },
  );
  return [...perArm, total];
}

function resolveBaseline(draw: BaselineDraw, targets: readonly Baseline[]): Baseline | null {
  if (draw.kind === 'none') {
    return null;
  }
  return draw.kind === 'free' ? draw.baseline : targets[draw.pick % targets.length]!;
}

const tokensOf = (line: string): readonly string[] => line.trim().split(/\s+/);

describe(PROPERTY_11, () => {
  // **Validates: Requirements 8.10**
  it('tags exactly the label-identified cross-run rows, even when their figures collide', () => {
    fc.assert(
      fc.property(crossRunSetArb, ({ set: { declaredArms, records }, draw }) => {
        const baseline = resolveBaseline(draw, sliceFigures(declaredArms, records));
        const lines = renderSummary(summarize(records), { declaredArms, baseline });
        const block = lines.slice(lines.findIndex((line) => line.startsWith(BLOCK_TITLE)));
        const crossRun = block.filter((line) => CROSS_RUN_ROW_LABELS.some((re) => re.test(line)));
        const [baselineRow, confirmatoryRow] = crossRun;
        expect(crossRun).toHaveLength(CROSS_RUN_ROW_LABELS.length);
        expect(crossRun.every((line) => tokensOf(line).includes(CROSS_RUN_TAG))).toBe(true);
        expect(block.filter((line) => line.includes(CROSS_RUN_TAG))).toEqual(crossRun);
        expect(armRows(lines).some((row) => row.includes(CROSS_RUN_TAG))).toBe(false);
        const { survivors, scored } = CONFIRMATORY_CONTROL_COVERAGE_GAP;
        expect(tokensOf(confirmatoryRow ?? '')).toContain(`${survivors}/${scored}`);
        if (baseline === null) {
          expect(baselineRow).toContain('unavailable');
          return;
        }
        const figure = `${baseline.withReport}/${baseline.sources}`;
        expect(tokensOf(baselineRow ?? '')).toContain(figure);
        // The planted collision is real: some slice row renders the very same figure.
        const sliceRows = block.filter((line) => !crossRun.includes(line));
        if (draw.kind === 'collide') {
          expect(sliceRows.some((line) => tokensOf(line).includes(figure))).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

const PROPERTY_8 =
  'Feature: testbench-failure-reportability, Property 8: A valueless report changes no decision';
/** Far above any drawn count, so a twin with it differs from every drawn record. */
const LARGE_VALUELESS_COUNT = 1_000_000;

/**
 * Instrument_Valid restated: the Positive_Control passed and `judgeCoverageGaps` said `closed`.
 * `combineInstrumentControls` persists that conjunction as the record's `instrumentValidity`.
 */
const isInstrumentValid = (sample: SweepSampleRecord): boolean =>
  sample.instrumentValidity === 'valid';

/** Every record's count replaced by `count`, a `null` (unmeasured) one included when asked. */
function withCount(
  records: readonly SweepSampleRecord[],
  count: number,
  replaceNull: boolean,
): readonly SweepSampleRecord[] {
  return records.map((sample) =>
    sample.valuelessFailureReports === null && !replaceNull
      ? sample
      : { ...sample, valuelessFailureReports: count },
  );
}

/** The summary with each arm's reportability block removed: every decision it carries. */
function decisionsOf(summary: SweepSummary): unknown {
  return {
    ...summary,
    arms: summary.arms.map((arm) =>
      Object.fromEntries(Object.entries(arm).filter(([key]) => key !== 'reportability')),
    ),
  };
}

/** The rendered lines above the reportability block, which is always rendered last. */
function linesOutsideBlock(summary: SweepSummary): readonly string[] {
  const lines = renderSummary(summary);
  const start = lines.findIndex((line) => line.startsWith(BLOCK_TITLE));
  expect(start).toBeGreaterThanOrEqual(0);
  return lines.slice(0, start);
}

describe(PROPERTY_8, () => {
  // **Validates: Requirements 5.5, 6.1, 6.2, 6.3, 9.2**
  // Scope: this proves the SUMMARY reads no decision from the count. That no dispatched phase or
  // repair decision reads it is structural: no reader exists outside the summary and closeout.
  it('leaves every non-reportability figure unchanged when the count is zeroed or inflated', () => {
    fc.assert(
      fc.property(recordSetArb, ({ records }) => {
        // linesOutsideBlock requires the reportability block to exist; an all-empty draw
        // (every arm legitimately drawing zero samples) renders no arms and no block at all.
        fc.pre(records.length > 0);
        const drawn = summarize(records);
        for (const arm of drawn.arms) {
          const own = records.filter((sample) => sample.armName === arm.armName);
          expect(own.filter(isInstrumentValid)).toHaveLength(arm.instrument.validSamples);
        }
        for (const twin of [
          withCount(records, 0, true),
          withCount(records, LARGE_VALUELESS_COUNT, false),
        ]) {
          const twinSummary = summarize(twin);
          expect(decisionsOf(twinSummary)).toEqual(decisionsOf(drawn));
          expect(linesOutsideBlock(twinSummary)).toEqual(linesOutsideBlock(drawn));
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
