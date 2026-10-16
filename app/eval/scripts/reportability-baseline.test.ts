// The committed Pinned_Baseline (task 10.1): an edited figure fails here by name, and the
// script that wrote it cannot reach a model or a simulator because it imports neither.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_FILE_PATH,
  BASELINE_RUN_PATH,
  splitArmDir,
  tallyBaseline,
  type ReportabilityBaseline,
  type ReportabilityTally,
} from './reportability-baseline.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, '../../..');

async function committedBaseline(): Promise<ReportabilityBaseline> {
  const text = await readFile(resolve(REPOSITORY_ROOT, BASELINE_FILE_PATH), 'utf8');
  return JSON.parse(text) as ReportabilityBaseline;
}

function summed(tallies: Readonly<Record<string, ReportabilityTally>>): ReportabilityTally {
  return Object.values(tallies).reduce(
    (sum, tally) => ({
      withReport: sum.withReport + tally.withReport,
      sources: sum.sources + tally.sources,
    }),
    { withReport: 0, sources: 0 },
  );
}

describe('committed Pinned_Baseline', () => {
  it('records the DQ-01 case-sensitive recount, its source, and the measured label', async () => {
    const baseline = await committedBaseline();
    expect(baseline.source).toEqual({ runPath: BASELINE_RUN_PATH, configHash: 'b99ca404f510c828' });
    expect(baseline.detector).toEqual({ literalSubstring: 'FAIL', caseSensitive: true });
    expect(baseline.label).toBe('measured');
    expect(baseline.total).toEqual({ withReport: 560, sources: 1015 });
    expect(baseline.perModelArm).toEqual({
      'deepseek.v3.2': { withReport: 120, sources: 257 },
      'moonshotai.kimi-k2.5': { withReport: 159, sources: 251 },
      'zai.glm-4.7': { withReport: 112, sources: 247 },
      'zai.glm-5': { withReport: 169, sources: 260 },
    });
    expect(baseline.perStrategyArm).toEqual({
      control: { withReport: 296, sources: 517 },
      grounded: { withReport: 264, sources: 498 },
    });
  });

  it('has a model split and a strategy split that each sum to the total', async () => {
    const baseline = await committedBaseline();
    expect(summed(baseline.perModelArm)).toEqual(baseline.total);
    expect(summed(baseline.perStrategyArm)).toEqual(baseline.total);
  });

  it('imports no model router, simulator adapter, or sandbox', async () => {
    const text = await readFile(resolve(HERE, 'reportability-baseline.ts'), 'utf8');
    const imports = [...text.matchAll(/^import[\s\S]*?from '([^']+)';$/gm)].map((m) => m[0]);
    expect(imports.length).toBeGreaterThan(0);
    for (const statement of imports) {
      expect(statement).not.toMatch(/router|Simulator|Sandbox|Runtime|@app\/agent/);
    }
  });
});

describe('tallyBaseline', () => {
  it('counts a source once when it holds any valueless report, split at the last dot', () => {
    const valueless = 'initial begin $display("FAIL"); end';
    const valued = 'initial begin $display("FAIL got %d", y); end';
    const baseline = tallyBaseline(
      [
        { armDir: 'zai.glm-5.control', source: `${valueless}\n${valueless}` },
        { armDir: 'zai.glm-5.grounded', source: valued },
      ],
      { runPath: 'run', configHash: '0123456789abcdef' },
    );
    expect(baseline.total).toEqual({ withReport: 1, sources: 2 });
    expect(baseline.perModelArm).toEqual({ 'zai.glm-5': { withReport: 1, sources: 2 } });
    expect(baseline.perStrategyArm).toEqual({
      control: { withReport: 1, sources: 1 },
      grounded: { withReport: 0, sources: 1 },
    });
  });

  it('refuses an arm directory that is not <model>.<strategy>', () => {
    expect(() => splitArmDir('control')).toThrow(/not <model>\.<strategy>/);
  });
});
