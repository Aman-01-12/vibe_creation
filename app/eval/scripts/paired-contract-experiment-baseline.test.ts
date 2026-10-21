// The committed, CITED Icarus 13.0 baseline (task 15.4; Req 8.3): an edited figure fails here
// by name, and this module cannot reach a model, a simulator, or a sandbox because it imports
// neither - mirroring the discipline `reportability-baseline.test.ts` enforces for itself.

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  PAIRED_CONTRACT_BASELINE_PATH,
  pairedContractBaselineAbsolutePath,
  type PairedContractExperimentBaseline,
} from './paired-contract-experiment-baseline.js';

async function committedBaseline(): Promise<PairedContractExperimentBaseline> {
  const text = await readFile(pairedContractBaselineAbsolutePath(), 'utf8');
  return JSON.parse(text) as PairedContractExperimentBaseline;
}

describe('the committed paired-contract-experiment baseline (Req 8.3)', () => {
  it('names the exact path inside the spec folder', () => {
    expect(PAIRED_CONTRACT_BASELINE_PATH).toBe('app/eval/paired-contract-experiment-baseline.json');
  });

  it('cites adder_8bit over 64 steps on Icarus 13.0, naming its own provenance', async () => {
    const baseline = await committedBaseline();

    expect(baseline.design).toBe('adder_8bit');
    expect(baseline.simulator).toBe('Icarus 13.0');
    expect(baseline.sampleBudget).toBe(64);
    expect(baseline.citedFrom).toBe(
      'chipAgent/_inbox/gotcha-the-timing-contract-is-fabricated-all-registered-in-three-places-so-15-of-46-combinational-designs-are-unwinnable-by-construction.md',
    );
  });

  it('carries the exact three cited figures: 94 CHECK-FAIL, 91 CHECK-FAIL, and 0 CHECK-FAIL', async () => {
    const baseline = await committedBaseline();

    expect(baseline.measurements).toEqual([
      {
        timingContract: 'registered',
        referenceModelStyle: 'registered-style',
        passed: false,
        checkFailCount: 94,
      },
      {
        timingContract: 'registered',
        referenceModelStyle: 'combinational',
        passed: false,
        checkFailCount: 91,
      },
      {
        timingContract: 'combinational',
        referenceModelStyle: 'combinational',
        passed: true,
        checkFailCount: 0,
      },
    ]);
  });

  it('imports no model router, simulator adapter, or sandbox', async () => {
    const text = await readFile(
      new URL('./paired-contract-experiment-baseline.ts', import.meta.url),
      'utf8',
    );
    const imports = [...text.matchAll(/^import[\s\S]*?from '([^']+)';$/gmu)].map((m) => m[0]);
    expect(imports.length).toBeGreaterThan(0);
    for (const statement of imports) {
      expect(statement).not.toMatch(/router|Simulator|Sandbox|Runtime|@app\/agent|@app\/tools/u);
    }
  });
});
