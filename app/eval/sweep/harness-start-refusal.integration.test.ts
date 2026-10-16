// A config that is not a Campaign reaches the Replay_Gate start check through the top-level
// `replayGateReportPath` (testbench-failure-reportability C8, Req 3.6, 3.7). Integration tier
// because the check runs the real Default_Timescale probe on this host's Icarus first.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DUMP_LIMIT_BYTES, SIMULATION_HARNESS_VERSION, WATCHDOG_BUDGET_NS } from '@app/tools';
import { NORMALIZER_VERSION } from '@app/agent';

import { harnessStartRefusal } from './cli.js';
import { parseSweepConfig } from './config-parse.js';
import { probeToolchainAvailability } from './host-facts.js';

/** A report that clears the gate for this build. */
const PASSING = {
  schemaVersion: 1,
  simulationHarnessVersion: SIMULATION_HARNESS_VERSION,
  normalizerVersion: NORMALIZER_VERSION,
  watchdogBudgetNs: WATCHDOG_BUDGET_NS,
  dumpLimitBytes: DUMP_LIMIT_BYTES,
  verdictChanges: [],
  passed: true,
};

/** A minimal non-Campaign config naming `reportPath` at top level. */
function sliceConfig(reportPath: string) {
  const parsed = parseSweepConfig({
    schemaVersion: 1,
    runName: 'harness-start',
    arms: [{ name: 'glm-5', model: 'zai.glm-5' }],
    problems: { kind: 'all' },
    sampleCount: 1,
    ks: [1],
    seed: 42,
    temperature: 0,
    caps: { maxIterations: 1, maxTokens: 1000, maxWallClockMs: 1000, maxCostCents: 1 },
    limits: { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 },
    costEnvelopeCents: 1,
    modelHost: { region: 'us-east-1' },
    outputDir: '.eval-runs/harness-start',
    replayGateReportPath: reportPath,
  });
  if (!parsed.ok) {
    throw new Error(`expected a valid config, got ${parsed.error.code}`);
  }
  expect(parsed.value.groundingCampaign).toBeUndefined();
  return parsed.value;
}

describe('harnessStartRefusal - a non-Campaign config with a top-level report path', () => {
  let dir = '';
  let pythonBin = '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-start-'));
    const toolchain = probeToolchainAvailability();
    if (!toolchain.available) {
      throw new Error(`toolchain unavailable: ${toolchain.reason}`);
    }
    pythonBin = toolchain.pythonBin;
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('starts on a passing report and returns it for the manifest', async () => {
    const path = join(dir, 'passing.json');
    await writeFile(path, JSON.stringify(PASSING));

    const result = await harnessStartRefusal(sliceConfig(path), pythonBin);

    expect(result).toEqual(PASSING);
  });

  it('refuses a failing report, naming every observed value', async () => {
    const path = join(dir, 'failing.json');
    await writeFile(
      path,
      JSON.stringify({ ...PASSING, passed: false, verdictChanges: [{}], normalizerVersion: -1 }),
    );

    const result = await harnessStartRefusal(sliceConfig(path), pythonBin);

    expect(result).toMatchObject({ code: 'replay-gate-not-passed' });
    const problem = result !== null && 'problem' in result ? result.problem : '';
    expect(problem).toContain('does not say passed');
    expect(problem).toContain('1 verdict change(s)');
    expect(problem).toContain('normalizerVersion is -1');
  });

  it('refuses a missing report', async () => {
    const result = await harnessStartRefusal(sliceConfig(join(dir, 'absent.json')), pythonBin);

    expect(result).toMatchObject({ code: 'replay-gate-not-passed' });
  });
});
