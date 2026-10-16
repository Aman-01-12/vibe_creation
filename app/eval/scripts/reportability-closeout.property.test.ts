// Feature: testbench-failure-reportability, Property 15: The closeout writes exactly one note,
// from the summary, with its labels at the boundary (task 12.2).
//
// Oracle: a field-by-field comparison against the DRAWN summary (`summarizeRecords` called here,
// not inside `closeoutLabels`) plus the two label rules restated independently of
// `closeoutLabels`. Rates are drawn to land exactly on the Pinned_Baseline (560/1015, 0.552) and
// exactly on the Confirmatory Control_Arm's Coverage_Gap_Survivor_Rate (171/2249, 0.076), as well
// as strictly either side, so both boundaries are hit by construction rather than by luck.
//
// Credential exclusion is tested as NON-INTERFERENCE, not containment: a recorded vault gotcha
// (`chipAgent/_inbox/gotcha-a-credential-leak-property-written-as-containment-is-both-unsound-and-weak.md`)
// measured that 7 of 8 short fake tokens occur verbatim in a closeout's own unrelated prose, which
// makes `not.toContain(credential)` both unsound (false positives on that prose) and weak (passes
// by luck on random tokens that never collide). So the note is rendered twice from identical
// inputs, once with a credential-shaped env var set and once absent, and asserted byte-identical.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { SIMULATION_HARNESS_VERSION } from '@app/tools';

import {
  encodeSampleRecord,
  RESULTS_SCHEMA_VERSION,
  type SweepSampleRecord,
} from '../sweep/results-log.js';
import { CONFIRMATORY_CONTROL_COVERAGE_GAP, summarizeRecords } from '../sweep/summary.js';

import { BASELINE_FILE_PATH } from './reportability-baseline.js';
import { runReportabilityCloseout } from './reportability-closeout.js';
import type { CloseoutPorts } from './scoreboard-closeout.js';

const PROPERTY_15 =
  'Feature: testbench-failure-reportability, Property 15: The closeout writes exactly one note, ' +
  'from the summary, with its labels at the boundary';

/** Headroom for a 100-run async property on a loaded full-suite runner; nothing depends on it. */
const SLOW_PROPERTY_TIMEOUT_MS = 30_000;

const RUN = '/runs/reportability-slice-v1-property';
const INBOX = '/vault/_inbox-property';

/** The Pinned_Baseline rate, restated here rather than imported, so the test is independent. */
const PINNED_BASELINE_RATE = 560 / 1015;
/** The Confirmatory Control_Arm's Coverage_Gap_Survivor_Rate: a committed figure, not a rule. */
const CONFIRMATORY_CONTROL_SURVIVOR_RATE =
  CONFIRMATORY_CONTROL_COVERAGE_GAP.survivors / CONFIRMATORY_CONTROL_COVERAGE_GAP.scored;

const BASELINE_JSON = JSON.stringify({
  schemaVersion: 1,
  source: { runPath: '.eval-runs/grounding-confirmatory-v1', configHash: 'b99ca404f510c828' },
  detector: { literalSubstring: 'FAIL', caseSensitive: true },
  total: { withReport: 560, sources: 1015 },
  perModelArm: {},
  perStrategyArm: {},
  label: 'measured',
});

const ARM_A = 'model-a.control';
const ARM_B = 'model-b.control';
const CONFIG_HASHES: readonly string[] = [
  '0123456789abcdef',
  '89abcdef01234567',
  'fedcba9876543210',
];

/** One clean, admissible record; every field defaulted so a builder states only what it draws. */
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
    configHash: '0123456789abcdef',
    armName: ARM_A,
    modelSignature: ARM_A,
    problemId: 'rtllm/arithmetic/adder_8bit',
    sampleIndex: 0,
    seed: 1,
    passed: true,
    outcomeStatus: 'verified',
    iterations: 1,
    costCents: 0,
    costKnown: true,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    unreportedUsageCalls: 0,
    stopReason: null,
    goldenVerdict: 'passed',
    goldenFailureCount: 0,
    instrumentValidity: 'valid',
    instrumentDefect: null,
    instrumentUncheckedReason: null,
    mutation: null,
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
    durationMs: 1,
    completedAtMs: 1,
    failureNote: null,
    noVerdictCause: null,
    ...overrides,
  };
}

/** `sources` records naming the Valueless_Report_Rate denominator; `withReport` hold a report. */
function baselineGroupRecords(
  sources: number,
  withReport: number,
  configHash: string,
): readonly SweepSampleRecord[] {
  return Array.from({ length: sources }, (_, i) =>
    record({
      armName: ARM_A,
      modelSignature: ARM_A,
      configHash,
      sampleIndex: i,
      problemId: `rtllm/arithmetic/baseline-${i}`,
      valuelessFailureReports: i < withReport ? 1 : 0,
      mutation: null,
    }),
  );
}

/** `scored` records naming the Coverage_Gap_Survivor_Rate denominator; `survivors` are gaps. */
function gapGroupRecords(
  scored: number,
  survivors: number,
  configHash: string,
): readonly SweepSampleRecord[] {
  return Array.from({ length: scored }, (_, i) =>
    record({
      armName: ARM_B,
      modelSignature: ARM_B,
      configHash,
      sampleIndex: i,
      problemId: `rtllm/arithmetic/gap-${i}`,
      valuelessFailureReports: null,
      mutation: {
        validCount: 1,
        killedCount: 1,
        noVerdictKills: 0,
        coverageGapOperators: i < survivors ? ['ARITH_PLUS_TO_MINUS'] : [],
        candidateEquivalentOperators: [],
        goldenSurvivedCount: i < survivors ? 1 : 0,
        goldenTimeoutCount: 0,
        nonCompilingCount: 0,
        goldenErroredCount: 0,
        elapsedMs: 1,
      },
    }),
  );
}

/** In-memory ports; `files` doubles as both the run directory and the baseline file. */
function ports(files: ReadonlyMap<string, string>): {
  readonly ports: CloseoutPorts;
  readonly written: Map<string, string>;
} {
  const written = new Map<string, string>();
  return {
    written,
    ports: {
      readText: (path) => {
        const text = files.get(path) ?? files.get(path.replace(`${RUN}/`, ''));
        return text === undefined ? Promise.reject(new Error('absent')) : Promise.resolve(text);
      },
      writeNew: (path, text) => {
        if (written.has(path)) {
          return Promise.reject(new Error('exists'));
        }
        written.set(path, text);
        return Promise.resolve();
      },
      regenerateManifest: () => true,
      now: () => '2026-11-01T00:00:00.000Z',
    },
  };
}

function runFiles(resultsText: string, manifestText: string): ReadonlyMap<string, string> {
  return new Map([
    [`${RUN}/manifest.json`, manifestText],
    [`${RUN}/results.jsonl`, resultsText],
    [BASELINE_FILE_PATH, BASELINE_JSON],
  ]);
}

type Boundary = 'exact' | 'below' | 'above';

/** The Valueless_Report_Rate fraction for one boundary mode, exact at 560/1015 by construction. */
interface BaselineFraction {
  readonly mode: Boundary;
  readonly sources: number;
  readonly withReport: number;
}

const baselineFractionArb: fc.Arbitrary<BaselineFraction> = fc
  .constantFrom<Boundary>('exact', 'below', 'above')
  .chain((mode): fc.Arbitrary<BaselineFraction> => {
    if (mode === 'exact') {
      return fc.constant({ mode, sources: 29, withReport: 16 }); // 16/29 === 560/1015, bit exact.
    }
    const sources = 25; // 0.552 * 25 = 13.8: 13 and below sits strictly under it, 14 and up over.
    const [min, max] = mode === 'below' ? [0, 13] : [14, 25];
    return fc.integer({ min, max }).map((withReport) => ({ mode, sources, withReport }));
  });

/** The Coverage_Gap_Survivor_Rate fraction for one boundary mode, exact at 171/2249. */
interface GapFraction {
  readonly mode: Boundary;
  readonly scored: number;
  readonly survivors: number;
}

const gapFractionArb: fc.Arbitrary<GapFraction> = fc
  .constantFrom<Boundary>('exact', 'below', 'above')
  .chain((mode): fc.Arbitrary<GapFraction> => {
    if (mode === 'exact') {
      return fc.constant({ mode, scored: 2249, survivors: 171 });
    }
    const scored = 25; // 0.076 * 25 = 1.9: 1 and below sits strictly under it, 2 and up over.
    const [min, max] = mode === 'below' ? [0, 1] : [2, 25];
    return fc.integer({ min, max }).map((survivors) => ({ mode, scored, survivors }));
  });

const scenarioArb = fc.record({
  baseline: baselineFractionArb,
  gap: gapFractionArb,
  configHash: fc.constantFrom(...CONFIG_HASHES),
});

/** Build the records, the drawn summary, and the run files for one scenario (shared by both tests). */
function buildScenario(scenario: {
  readonly baseline: { readonly sources: number; readonly withReport: number };
  readonly gap: { readonly scored: number; readonly survivors: number };
  readonly configHash: string;
}): { readonly files: ReadonlyMap<string, string>; readonly totals: TotalFractions } {
  const records = [
    ...baselineGroupRecords(
      scenario.baseline.sources,
      scenario.baseline.withReport,
      scenario.configHash,
    ),
    ...gapGroupRecords(scenario.gap.scored, scenario.gap.survivors, scenario.configHash),
  ];
  const summary = summarizeRecords(records, [1], scenario.configHash, {
    malformedLines: 0,
    staleSchemaLines: 0,
  });
  const totals = runTotalsOf(summary);
  const manifestText = JSON.stringify({
    runName: 'reportability-slice-v1-property',
    configHash: scenario.configHash,
    config: { ks: [1] },
  });
  const resultsText = records.map(encodeSampleRecord).join('\n');
  return {
    files: runFiles(resultsText, manifestText),
    totals: { ...totals, configHash: scenario.configHash },
  };
}

/** One rendered fraction, independently summed from the drawn summary's own arm figures. */
interface Fraction {
  readonly n: number;
  readonly d: number;
  readonly rate: number | null;
}

interface TotalFractions {
  readonly valueless: Fraction;
  readonly gap: Fraction;
  readonly configHash: string;
  readonly arms: readonly {
    readonly armName: string;
    readonly valueless: Fraction;
    readonly gap: Fraction;
  }[];
}

/** Sum the drawn summary's per-arm figures into the run totals (independent of the closeout). */
function runTotalsOf(
  summary: ReturnType<typeof summarizeRecords>,
): Omit<TotalFractions, 'configHash'> {
  const arms = summary.arms.map((arm) => ({
    armName: arm.armName,
    valueless: {
      n: arm.reportability.withReport,
      d: arm.reportability.sources,
      rate: arm.reportability.valuelessReportRate,
    },
    gap: {
      n: arm.mutation.coverageGapSurvivors,
      d: arm.mutation.validMutants,
      rate: arm.mutation.coverageGapSurvivorRate,
    },
  }));
  const sum = (pick: (arm: (typeof arms)[number]) => Fraction): Fraction => {
    const n = arms.reduce((total, arm) => total + pick(arm).n, 0);
    const d = arms.reduce((total, arm) => total + pick(arm).d, 0);
    return { n, d, rate: d === 0 ? null : n / d };
  };
  return { valueless: sum((arm) => arm.valueless), gap: sum((arm) => arm.gap), arms };
}

const fixedPoint = (rate: number | null): string => (rate === null ? 'undefined' : rate.toFixed(3));

describe(PROPERTY_15, () => {
  it(
    'matches the drawn summary field for field and labels the two boundaries exactly',
    async () => {
      await fc.assert(
        fc.asyncProperty(scenarioArb, async (scenario) => {
          const { files, totals } = buildScenario(scenario);
          const { ports: injected, written } = ports(files);

          const result = await runReportabilityCloseout(RUN, INBOX, injected);

          expect(result.exitCode).toBe(0);
          expect(written.size).toBe(1);
          const [note] = [...written.values()];
          expect(note).toBeDefined();
          const text = note ?? '';

          // Provenance and the two run-total figures, each read independently from the summary.
          expect(text).toContain(`Config_Identity: ${totals.configHash}.`);
          expect(text).toContain(
            `Valueless_Report_Rate (run total): ${totals.valueless.n}/${totals.valueless.d} ` +
              `(${fixedPoint(totals.valueless.rate)}).`,
          );
          expect(text).toContain(
            `Coverage_Gap_Survivor_Rate (run total): ${totals.gap.n}/${totals.gap.d} ` +
              `(${fixedPoint(totals.gap.rate)}).`,
          );

          // Every per-Model_Arm pair, each read from the drawn summary's own arm entries.
          for (const arm of totals.arms) {
            expect(text).toContain(
              `${arm.armName}: valueless ${arm.valueless.n}/${arm.valueless.d} ` +
                `(${fixedPoint(arm.valueless.rate)})  coverage-gap ${arm.gap.n}/${arm.gap.d} ` +
                `(${fixedPoint(arm.gap.rate)})`,
            );
          }

          // The two label rules, restated here rather than by calling `closeoutLabels`.
          const sliceRate = totals.valueless.rate;
          const measuredNegativeExpected =
            sliceRate === null ? true : !(sliceRate < PINNED_BASELINE_RATE);
          const launderingSignatureExpected =
            sliceRate !== null &&
            sliceRate < PINNED_BASELINE_RATE &&
            totals.gap.rate !== null &&
            totals.gap.rate > CONFIRMATORY_CONTROL_SURVIVOR_RATE;

          expect(text.includes('MEASURED NEGATIVE')).toBe(measuredNegativeExpected);
          expect(text.includes('LAUNDERING SIGNATURE')).toBe(launderingSignatureExpected);
          const tagsLine = text.split('\n').find((line) => line.startsWith('tags: ')) ?? '';
          expect(tagsLine.includes('measured-negative')).toBe(measuredNegativeExpected);
          expect(tagsLine.includes('laundering-signature')).toBe(launderingSignatureExpected);
        }),
        { numRuns: 100 },
      );
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );
});

describe(`${PROPERTY_15} - credential exclusion is non-interference, not containment`, () => {
  // A short, deliberately colliding pool: several of these occur verbatim in the note's own
  // prose (the env var name itself, and words the note always prints), which is what makes this
  // a non-interference claim rather than a containment check that would pass on luck alone.
  const CREDENTIAL_SHAPED_VALUES: readonly string[] = [
    'AWS_BEARER_TOKEN_BEDROCK',
    'measured',
    'candidate',
    'baseline',
    'laundering',
    'fake-bedrock-mantle-credential-7c2e',
  ];
  const ENV_VAR = 'CLOSEOUT_PROPERTY_CREDENTIAL_CANARY';

  /** A lighter scenario than the main property: non-interference needs variety, not boundaries. */
  const lightScenarioArb = fc.record({
    baseline: fc
      .record({
        sources: fc.integer({ min: 1, max: 20 }),
        withReport: fc.integer({ min: 0, max: 20 }),
      })
      .map(({ sources, withReport }) => ({ sources, withReport: Math.min(sources, withReport) })),
    gap: fc
      .record({
        scored: fc.integer({ min: 1, max: 20 }),
        survivors: fc.integer({ min: 0, max: 20 }),
      })
      .map(({ scored, survivors }) => ({ scored, survivors: Math.min(scored, survivors) })),
    configHash: fc.constantFrom(...CONFIG_HASHES),
  });

  it(
    'renders a byte-identical note whether or not a credential-shaped env var resolves',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          lightScenarioArb,
          fc.constantFrom(...CREDENTIAL_SHAPED_VALUES),
          async (scenario, credential) => {
            const { files } = buildScenario(scenario);

            process.env[ENV_VAR] = credential;
            let withCredential: string;
            try {
              const { ports: injected, written } = ports(files);
              await runReportabilityCloseout(RUN, INBOX, injected);
              withCredential = [...written.values()][0] ?? '';
            } finally {
              delete process.env[ENV_VAR];
            }

            const { ports: injected, written } = ports(files);
            await runReportabilityCloseout(RUN, INBOX, injected);
            const withoutCredential = [...written.values()][0] ?? '';

            // The whole claim: the credential influenced nothing the note said. A containment
            // check (`not.toContain(credential)`) is deliberately NOT asserted here - several of
            // `CREDENTIAL_SHAPED_VALUES` occur verbatim in the note's own unrelated prose (see the
            // demonstration test below), which is exactly what makes containment the wrong oracle.
            expect(withCredential.length).toBeGreaterThan(0);
            expect(withCredential).toBe(withoutCredential);
          },
        ),
        { numRuns: 100 },
      );
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );

  it('generates values a naive containment check would flag, so it cannot pass by luck', async () => {
    const { files } = buildScenario({
      baseline: { sources: 10, withReport: 2 },
      gap: { scored: 10, survivors: 1 },
      configHash: CONFIG_HASHES[0] ?? '0123456789abcdef',
    });
    const { ports: injected, written } = ports(files);
    await runReportabilityCloseout(RUN, INBOX, injected);
    const text = [...written.values()][0] ?? '';

    const colliding = CREDENTIAL_SHAPED_VALUES.filter((value) => text.includes(value));

    // Several generated values occur verbatim in the note's own prose, so a containment check
    // would false-positive here with no leak - and at least one does not, so the pool is not
    // trivially all-colliding either.
    expect(colliding.length).toBeGreaterThan(1);
    expect(colliding.length).toBeLessThan(CREDENTIAL_SHAPED_VALUES.length);
  });
});

// Property 16 (task 12.3): Any single closeout port failure reports incomplete and writes
// nothing.
//
// Oracle: a recording fake that fails exactly ONE named port and logs every port call (its name
// and, for readText/writeNew, the path). The failure/success wiring is restated here rather than
// imported from reportability-closeout.test.ts's example assertions.

const PROPERTY_16 =
  'Feature: testbench-failure-reportability, Property 16: Any single closeout port failure ' +
  'reports incomplete and writes nothing';

type FailingPort =
  'manifestRead' | 'resultsRead' | 'baselineRead' | 'writeNew' | 'regenerateManifest';

const FAILING_PORTS: readonly FailingPort[] = [
  'manifestRead',
  'resultsRead',
  'baselineRead',
  'writeNew',
  'regenerateManifest',
];

/** Ports that fail exactly `failing`, recording every call made to any of the five. */
function portsFailingOne(
  files: ReadonlyMap<string, string>,
  failing: FailingPort,
): {
  readonly ports: CloseoutPorts;
  readonly calls: readonly string[];
  readonly written: ReadonlyMap<string, string>;
} {
  const calls: string[] = [];
  const written = new Map<string, string>();
  return {
    calls,
    written,
    ports: {
      readText: (path) => {
        calls.push(`readText:${path}`);
        if (failing === 'manifestRead' && path.endsWith('manifest.json')) {
          return Promise.reject(new Error('boom: manifest read'));
        }
        if (failing === 'resultsRead' && path.endsWith('results.jsonl')) {
          return Promise.reject(new Error('boom: results read'));
        }
        if (failing === 'baselineRead' && path === BASELINE_FILE_PATH) {
          return Promise.reject(new Error('boom: baseline read'));
        }
        const text = files.get(path) ?? files.get(path.replace(`${RUN}/`, ''));
        return text === undefined ? Promise.reject(new Error('absent')) : Promise.resolve(text);
      },
      writeNew: (path, text) => {
        calls.push(`writeNew:${path}`);
        if (failing === 'writeNew') {
          return Promise.reject(new Error('boom: write'));
        }
        written.set(path, text);
        return Promise.resolve();
      },
      regenerateManifest: () => {
        calls.push('regenerateManifest');
        return failing !== 'regenerateManifest';
      },
      now: () => {
        calls.push('now');
        return '2026-11-01T00:00:00.000Z';
      },
    },
  };
}

describe(PROPERTY_16, () => {
  it(
    'reports incomplete and writes nothing inside the run directory, for any single failing port',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          scenarioArb,
          fc.constantFrom(...FAILING_PORTS),
          async (scenario, failing) => {
            const { files } = buildScenario(scenario);
            const { ports: injected, calls, written } = portsFailingOne(files, failing);

            const result = await runReportabilityCloseout(RUN, INBOX, injected);

            expect(result.exitCode).toBe(1);
            const incompleteLines = result.lines.filter((line) =>
              line.includes('closeout incomplete'),
            );
            expect(incompleteLines.length).toBe(1);

            // No write ever targets the run directory itself; only the inbox is a write target.
            const writeCalls = calls.filter((call) => call.startsWith('writeNew:'));
            expect(writeCalls.every((call) => call.startsWith(`writeNew:${INBOX}`))).toBe(true);
            expect([...written.keys()].every((path) => path.startsWith(INBOX))).toBe(true);

            // Reads happen in a fixed order (manifest, results, baseline) and stop at the first
            // failure, so a read-port failure never reaches a write or the manifest regeneration.
            if (
              failing === 'manifestRead' ||
              failing === 'resultsRead' ||
              failing === 'baselineRead'
            ) {
              expect(written.size).toBe(0);
              expect(calls).not.toContain('regenerateManifest');
              expect(calls.some((call) => call.startsWith('writeNew:'))).toBe(false);
            }

            // A write failure means nothing was recorded as written, and the manifest step never
            // ran on an unwritten note.
            if (failing === 'writeNew') {
              expect(written.size).toBe(0);
              expect(calls).not.toContain('regenerateManifest');
            }

            // A manifest-regeneration failure happens strictly after one successful write to the
            // inbox; the Results_Log and Sweep_Manifest in the run directory were never touched.
            if (failing === 'regenerateManifest') {
              expect(written.size).toBe(1);
            }
          },
        ),
        { numRuns: 100 },
      );
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );
});
