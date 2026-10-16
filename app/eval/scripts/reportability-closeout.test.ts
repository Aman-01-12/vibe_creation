// The Measurement_Slice closeout (testbench-failure-reportability, task 12.1): the two labels
// at their exact boundary, the follow-up sentences under every outcome, and the manifest port
// invoked after the write port and never before.

import { describe, expect, it } from 'vitest';

import { SIMULATION_HARNESS_VERSION } from '@app/tools';

import {
  encodeSampleRecord,
  RESULTS_SCHEMA_VERSION,
  type SweepSampleRecord,
} from '../sweep/results-log.js';

import { closeoutLabels, runReportabilityCloseout } from './reportability-closeout.js';
import type { CloseoutPorts } from './scoreboard-closeout.js';

const RUN = '/runs/reportability-slice-v1';
const INBOX = '/vault/_inbox';
const BASELINE_PATH = 'app/eval/reportability-baseline.json';

const BASELINE = JSON.stringify({
  schemaVersion: 1,
  source: { runPath: '.eval-runs/grounding-confirmatory-v1', configHash: 'b99ca404f510c828' },
  detector: { literalSubstring: 'FAIL', caseSensitive: true },
  total: { withReport: 560, sources: 1015 },
  perModelArm: {},
  perStrategyArm: {},
  label: 'measured',
});

const MANIFEST = JSON.stringify({
  runName: 'reportability-slice-v1',
  configHash: '0123456789abcdef',
  config: { ks: [1] },
});

/** One clean, admissible record; every field defaulted so a test states only what it is about. */
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
    armName: 'model.control',
    modelSignature: 'model',
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
    mutation: {
      validCount: 1,
      killedCount: 1,
      noVerdictKills: 0,
      coverageGapOperators: [],
      candidateEquivalentOperators: [],
      goldenSurvivedCount: 0,
      goldenTimeoutCount: 0,
      nonCompilingCount: 0,
      goldenErroredCount: 0,
      elapsedMs: 1,
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
    durationMs: 1,
    completedAtMs: 1,
    failureNote: null,
    noVerdictCause: null,
    ...overrides,
  };
}

/** A results log with `totalSources` records, the given counts set at the head of the arm. */
function resultsOf(
  valuelessWithReport: number,
  totalSources: number,
  coverageGapSurvivors: number,
): string {
  const lines: string[] = [];
  for (let i = 0; i < totalSources; i += 1) {
    lines.push(
      encodeSampleRecord(
        record({
          sampleIndex: i,
          valuelessFailureReports: i < valuelessWithReport ? 1 : 0,
          mutation: {
            validCount: 1,
            killedCount: 1,
            noVerdictKills: 0,
            coverageGapOperators: i < coverageGapSurvivors ? ['ARITH_PLUS_TO_MINUS'] : [],
            candidateEquivalentOperators: [],
            goldenSurvivedCount: i < coverageGapSurvivors ? 1 : 0,
            goldenTimeoutCount: 0,
            nonCompilingCount: 0,
            goldenErroredCount: 0,
            elapsedMs: 1,
          },
        }),
      ),
    );
  }
  return lines.join('\n');
}

/** In-memory ports; `files` doubles as both the run directory and the baseline file. */
function ports(
  files: Map<string, string>,
  overrides: Partial<CloseoutPorts> = {},
): { readonly ports: CloseoutPorts; readonly written: Map<string, string> } {
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
      ...overrides,
    },
  };
}

function runFiles(
  valuelessWithReport: number,
  totalSources: number,
  coverageGapSurvivors: number,
): Map<string, string> {
  return new Map([
    [`${RUN}/manifest.json`, MANIFEST],
    [`${RUN}/results.jsonl`, resultsOf(valuelessWithReport, totalSources, coverageGapSurvivors)],
    [BASELINE_PATH, BASELINE],
  ]);
}

describe('closeoutLabels - exact at its boundary', () => {
  it('is a measured negative when the slice rate equals the baseline (equality is negative)', () => {
    const labels = closeoutLabels({
      sliceRate: 0.552,
      baselineRate: 0.552,
      sliceSurvivorRate: 0.05,
      confirmatoryControlSurvivorRate: 0.076,
    });
    expect(labels.measuredNegative).toBe(true);
    expect(labels.launderingSignature).toBe(false);
  });

  it('is not a measured negative when the slice rate is strictly lower than the baseline', () => {
    const labels = closeoutLabels({
      sliceRate: 0.551,
      baselineRate: 0.552,
      sliceSurvivorRate: 0.05,
      confirmatoryControlSurvivorRate: 0.076,
    });
    expect(labels.measuredNegative).toBe(false);
  });

  it('does not fire the laundering signature when the survivor rate equals the confirmatory rate', () => {
    const labels = closeoutLabels({
      sliceRate: 0.551,
      baselineRate: 0.552,
      sliceSurvivorRate: 0.076,
      confirmatoryControlSurvivorRate: 0.076,
    });
    expect(labels.launderingSignature).toBe(false);
  });

  it('fires the laundering signature when the survivor rate is strictly higher at that boundary', () => {
    const labels = closeoutLabels({
      sliceRate: 0.551,
      baselineRate: 0.552,
      sliceSurvivorRate: 0.0761,
      confirmatoryControlSurvivorRate: 0.076,
    });
    expect(labels.launderingSignature).toBe(true);
  });

  it('is neither label when the slice rate is null (a zero denominator)', () => {
    const labels = closeoutLabels({
      sliceRate: null,
      baselineRate: 0.552,
      sliceSurvivorRate: null,
      confirmatoryControlSurvivorRate: 0.076,
    });
    expect(labels.measuredNegative).toBe(true);
    expect(labels.launderingSignature).toBe(false);
  });
});

describe('runReportabilityCloseout - the note and the follow-up text', () => {
  it('writes a candidate note with the follow-up sentences under a measured-negative outcome', async () => {
    const files = runFiles(60, 100, 10); // 0.6 rate, worse than baseline -> measured negative
    const { ports: injected, written } = ports(files);

    const result = await runReportabilityCloseout(RUN, INBOX, injected);

    expect(result.exitCode).toBe(0);
    expect(written.size).toBe(1);
    const [note] = [...written.values()];
    expect(note).toContain('status: candidate');
    expect(note).not.toContain('status: trusted');
    expect(note).toContain('MEASURED NEGATIVE');
    expect(note).toContain('repair loop');
    expect(note).toContain('54 recorded Watchdog hangs');
    expect(note).toContain('DQ-01');
    expect(note).toContain('56.5%');
  });

  it('writes the follow-up sentences under an improving, non-laundering outcome too', async () => {
    const files = runFiles(10, 100, 0); // 0.1 rate, better than baseline, survivors stayed clean
    const { ports: injected, written } = ports(files);

    const result = await runReportabilityCloseout(RUN, INBOX, injected);

    expect(result.exitCode).toBe(0);
    const [note] = [...written.values()];
    expect(note).not.toContain('MEASURED NEGATIVE');
    expect(note).toContain('repair loop');
    expect(note).toContain('54 recorded Watchdog hangs');
    expect(note).toContain('DQ-01');
  });

  it('names both rates and both denominators when the laundering signature fires', async () => {
    // Rate improves on 0.552 (10/100 = 0.1) but survivors are worse than the confirmatory 0.076.
    const files = runFiles(10, 100, 50);
    const { ports: injected, written } = ports(files);

    const result = await runReportabilityCloseout(RUN, INBOX, injected);

    expect(result.exitCode).toBe(0);
    const [note] = [...written.values()];
    expect(note).toContain('LAUNDERING SIGNATURE');
    expect(note).toContain('10/100');
    expect(note).toContain('560/1015');
    expect(note).toContain('50/100');
    expect(note).toContain('171/2249');
    expect(note).toContain('repair loop');
    expect(note).toContain('54 recorded Watchdog hangs');
  });

  it('never carries an environment value into the note', async () => {
    const planted = 'PLANTED-SECRET-VALUE-7c2e';
    process.env.CLOSEOUT_TEST_TOKEN = planted;
    try {
      const files = runFiles(60, 100, 10);
      const { ports: injected, written } = ports(files);
      await runReportabilityCloseout(RUN, INBOX, injected);
      for (const text of written.values()) {
        expect(text).not.toContain(planted);
      }
    } finally {
      delete process.env.CLOSEOUT_TEST_TOKEN;
    }
  });

  it('invokes the vault manifest port after the write port and never before', async () => {
    const files = runFiles(60, 100, 10);
    const calls: string[] = [];
    const { ports: injected } = ports(files, {
      writeNew: (path, text) => {
        calls.push('write');
        files.set(path, text);
        return Promise.resolve();
      },
      regenerateManifest: () => {
        calls.push('manifest');
        return true;
      },
    });

    const result = await runReportabilityCloseout(RUN, INBOX, injected);

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual(['write', 'manifest']);
  });

  it('does not invoke the manifest port at all when the write fails, and writes nothing', async () => {
    const files = runFiles(60, 100, 10);
    const calls: string[] = [];
    const { ports: injected } = ports(files, {
      writeNew: () => {
        calls.push('write');
        return Promise.reject(new Error('exists'));
      },
      regenerateManifest: () => {
        calls.push('manifest');
        return true;
      },
    });

    const result = await runReportabilityCloseout(RUN, INBOX, injected);

    expect(result.exitCode).toBe(1);
    expect(result.lines[0]).toContain('closeout incomplete');
    expect(calls).toEqual(['write']);
  });

  it('reports incomplete and writes nothing when the manifest regeneration fails', async () => {
    const files = runFiles(60, 100, 10);
    const { ports: injected, written } = ports(files, { regenerateManifest: () => false });

    const result = await runReportabilityCloseout(RUN, INBOX, injected);

    expect(result.exitCode).toBe(1);
    expect(result.lines[0]).toContain('vault:manifest failed');
    // The note itself was written to the inbox before the manifest step; the Results_Log and
    // Sweep_Manifest in the run directory are what must stay untouched, and they were never
    // targeted by `writeNew` at all.
    expect([...written.keys()].every((path) => path.startsWith(INBOX))).toBe(true);
  });

  it('reports incomplete and writes nothing when the run directory has no results log', async () => {
    const files = new Map([
      [`${RUN}/manifest.json`, MANIFEST],
      [BASELINE_PATH, BASELINE],
    ]);
    const { ports: injected, written } = ports(files);

    const result = await runReportabilityCloseout(RUN, INBOX, injected);

    expect(result.exitCode).toBe(1);
    expect(written.size).toBe(0);
  });
});
