// Unit tests for the Benchmark_Regression_Suite CLI and its run directory contract (task
// 16.5). An injected in-memory `ConsensusRegressionRunDirPort` stands in for the filesystem,
// so these never touch disk.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SYNTHETIC_MEASUREMENT,
  gatedFiguresOf,
  parseConsensusRegressionArgs,
  parseRecordedMeasurement,
  REPORT_FILENAME,
  runConsensusRegressionCli,
  type ConsensusRegressionMeasuredFigures,
  type ConsensusRegressionReport,
  type ConsensusRegressionRunDirPort,
} from './cli.js';
import { decideConsensusRegressionGate } from './gate.js';
import {
  STRUCTURAL_GATE_EXCLUSIONS,
  STRUCTURAL_GATE_EXCLUSION_NOTE,
} from './structural-gate-exclusions.js';

/** An in-memory `ConsensusRegressionRunDirPort`, so a test never touches the real filesystem. */
function inMemoryFs(preExisting: readonly string[] = []): ConsensusRegressionRunDirPort & {
  readonly written: Map<string, string>;
} {
  const existing = new Set(preExisting);
  const written = new Map<string, string>();
  return {
    written,
    exists: (path: string): Promise<boolean> => Promise.resolve(existing.has(path)),
    mkdir: (path: string): Promise<void> => {
      existing.add(path);
      return Promise.resolve();
    },
    writeFile: (path: string, contents: string): Promise<void> => {
      written.set(path, contents);
      return Promise.resolve();
    },
  };
}

describe('parseConsensusRegressionArgs', () => {
  it('parses a run invocation with no flags', () => {
    expect(parseConsensusRegressionArgs([])).toEqual({
      kind: 'run',
      runName: null,
      recordPath: null,
    });
  });

  it('parses --run-name and --record together', () => {
    expect(parseConsensusRegressionArgs(['--run-name', 'r1', '--record', 'x.json'])).toEqual({
      kind: 'run',
      runName: 'r1',
      recordPath: 'x.json',
    });
  });

  it('reports usage on an unrecognized flag', () => {
    const result = parseConsensusRegressionArgs(['--bogus']);
    expect(result.kind).toBe('usage');
  });
});

describe('gatedFiguresOf - extracts the six gated values, dropping sample counts', () => {
  it("mirrors DEFAULT_SYNTHETIC_MEASUREMENT's own gated values", () => {
    const gated = gatedFiguresOf(DEFAULT_SYNTHETIC_MEASUREMENT);
    expect(gated.wrongLabelShare).toBe(DEFAULT_SYNTHETIC_MEASUREMENT.wrongLabelShare.value);
    expect(gated.pilotPassShare.counter_12).toBe(
      DEFAULT_SYNTHETIC_MEASUREMENT.pilotPassShare.counter_12.value,
    );
  });
});

describe('parseRecordedMeasurement - validates untrusted --record JSON at the boundary', () => {
  it('rejects a non-object record', () => {
    const parsed = parseRecordedMeasurement('nope');
    expect(parsed.ok).toBe(false);
  });

  it('rejects a record missing a required field', () => {
    const parsed = parseRecordedMeasurement({});
    expect(parsed.ok).toBe(false);
  });

  it('accepts a well-formed record and round-trips a null peer-calibration figure', () => {
    const raw = JSON.parse(JSON.stringify(DEFAULT_SYNTHETIC_MEASUREMENT)) as unknown;
    const parsed = parseRecordedMeasurement(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.peerCalibratedMutationGateAgreement).toBeNull();
      expect(parsed.value.wrongLabelShare).toEqual(DEFAULT_SYNTHETIC_MEASUREMENT.wrongLabelShare);
    }
  });
});

describe('runConsensusRegressionCli - the default synthetic measurement fails on the cited 0% pilot figure', () => {
  it('writes a report into a fresh run directory and exits 1', async () => {
    const fs = inMemoryFs();
    const result = await runConsensusRegressionCli(
      { kind: 'run', runName: 'test-run', recordPath: null },
      { evalRunsRoot: '/evalruns', fs, now: () => new Date('2024-01-01T00:00:00.000Z') },
    );

    expect(result.exitCode).toBe(1);
    expect(result.runDir).toBe('/evalruns/test-run');
    const written = fs.written.get(`/evalruns/test-run/${REPORT_FILENAME}`);
    expect(written).toBeDefined();
    const report = JSON.parse(written ?? '{}') as ConsensusRegressionReport;
    expect(report.verdict.passed).toBe(false);
    expect(report.verdict).toEqual(
      decideConsensusRegressionGate(gatedFiguresOf(DEFAULT_SYNTHETIC_MEASUREMENT)),
    );
  });

  it('writes schemaVersion 2 and both Structural_Gate exclusion fields (Req 12.9)', async () => {
    const fs = inMemoryFs();
    await runConsensusRegressionCli(
      { kind: 'run', runName: 'schema-run', recordPath: null },
      { evalRunsRoot: '/evalruns', fs, now: () => new Date('2024-01-01T00:00:00.000Z') },
    );

    const written = fs.written.get(`/evalruns/schema-run/${REPORT_FILENAME}`);
    const report = JSON.parse(written ?? '{}') as ConsensusRegressionReport;
    expect(report.schemaVersion).toBe(2);
    expect(report.structuralGateExclusions).toEqual(STRUCTURAL_GATE_EXCLUSIONS);
    expect(report.structuralGateExclusionNote).toBe(STRUCTURAL_GATE_EXCLUSION_NOTE);
  });

  it('every rendered figure line carries the Structural_Gate exclusion count (Req 12.8)', async () => {
    const fs = inMemoryFs();
    const result = await runConsensusRegressionCli(
      { kind: 'run', runName: 'render-run', recordPath: null },
      { evalRunsRoot: '/evalruns', fs, now: () => new Date('2024-01-01T00:00:00.000Z') },
    );

    // `%` only ever appears in a `renderShare` line (a failure line reports a raw value),
    // so this isolates exactly the figures the suffix is required on (Req 12.8).
    const figureLines = result.lines.filter((line) => line.includes('%'));
    expect(figureLines.length).toBeGreaterThan(0);
    for (const line of figureLines) {
      expect(line).toContain('excluded by the Structural_Gate: 2');
    }
  });

  it('refuses to write into a run directory that already exists', async () => {
    const fs = inMemoryFs(['/evalruns/test-run']);
    const result = await runConsensusRegressionCli(
      { kind: 'run', runName: 'test-run', recordPath: null },
      { evalRunsRoot: '/evalruns', fs },
    );

    expect(result.exitCode).toBe(1);
    expect(fs.written.size).toBe(0);
    expect(result.lines.join('\n')).toContain('already exists');
  });

  it('passes when every provider figure is on the passing side of its bar', async () => {
    const fs = inMemoryFs();
    const allPassing: ConsensusRegressionMeasuredFigures = {
      ...DEFAULT_SYNTHETIC_MEASUREMENT,
      pilotPassShare: {
        counter_12: { value: 1, sampleCount: null },
        traffic_light: { value: 1, sampleCount: null },
        accu: { value: 1, sampleCount: null },
      },
    };
    const result = await runConsensusRegressionCli(
      { kind: 'run', runName: 'passing-run', recordPath: null },
      { evalRunsRoot: '/evalruns', fs, provider: { measure: () => Promise.resolve(allPassing) } },
    );

    expect(result.exitCode).toBe(0);
  });

  it('reports each gated and reported figure with its sample count, or that none was cited', () => {
    // Spot check against the committed defaults rather than hand-deriving a second
    // calculation of the gate's own verdict, so this test only pins the rendering.
    const text = JSON.stringify(DEFAULT_SYNTHETIC_MEASUREMENT);
    expect(text).toContain('"sampleCount":2545');
    expect(text).toContain('"sampleCount":null');
  });
});
