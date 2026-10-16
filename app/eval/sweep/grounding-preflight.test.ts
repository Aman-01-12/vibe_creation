// The Grounding Campaign's Replay_Gate report check (testbench-spec-grounding, C12, C15).
//
// The report is a file an earlier process wrote, so it is untrusted input: every field is
// checked, and the refusal names EVERY failing field rather than the first, because an
// operator re-running the gate wants the whole list in one pass.

import { describe, expect, it } from 'vitest';

import { DUMP_LIMIT_BYTES, SIMULATION_HARNESS_VERSION, WATCHDOG_BUDGET_NS } from '@app/tools';
import { NORMALIZER_VERSION } from '@app/agent';

import { harnessStartRefusal, replayGateReportPathOf } from './cli.js';
import { parseSweepConfig } from './config-parse.js';
import type { SweepConfig } from './config.js';
import { replayGateRefusals } from './preflight.js';

/** A minimal valid config that is not a Campaign. */
const BASE = {
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
};

/** Parse a raw config that must be valid. */
function parseOk(raw: Record<string, unknown>): SweepConfig {
  const parsed = parseSweepConfig(raw);
  if (!parsed.ok) {
    throw new Error(`expected a valid config, got ${parsed.error.code} at ${parsed.error.field}`);
  }
  return parsed.value;
}

/** The constants the running build compiles; a report must match all four. */
const BUILD = {
  simulationHarnessVersion: SIMULATION_HARNESS_VERSION,
  normalizerVersion: NORMALIZER_VERSION,
  watchdogBudgetNs: WATCHDOG_BUDGET_NS,
  dumpLimitBytes: DUMP_LIMIT_BYTES,
};

/** A report that clears the gate for this build. */
function passing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: 1, ...BUILD, verdictChanges: [], passed: true, ...overrides };
}

describe('replayGateRefusals', () => {
  it("accepts a passing report whose four constants are this build's", () => {
    expect(replayGateRefusals(passing(), BUILD)).toEqual([]);
  });

  it('refuses a report that is absent, not an object, or an array', () => {
    for (const bad of [null, undefined, 42, 'passed', []]) {
      expect(replayGateRefusals(bad, BUILD)).toEqual(['the Replay_Gate report is not an object']);
    }
  });

  it('refuses a report that did not pass, even when every constant matches', () => {
    expect(replayGateRefusals(passing({ passed: false }), BUILD)).toEqual([
      'the Replay_Gate report does not say passed',
    ]);
    // `passed` must be exactly `true`: a truthy value is not a passing gate.
    expect(replayGateRefusals(passing({ passed: 'yes' }), BUILD)).toHaveLength(1);
  });

  it('names every stale constant, not just the first', () => {
    const stale = passing({
      simulationHarnessVersion: SIMULATION_HARNESS_VERSION + 1,
      watchdogBudgetNs: 1,
      dumpLimitBytes: 2,
    });

    const reasons = replayGateRefusals(stale, BUILD);

    expect(reasons).toHaveLength(3);
    expect(reasons.join(' ')).toContain('simulationHarnessVersion');
    expect(reasons.join(' ')).toContain('watchdogBudgetNs');
    expect(reasons.join(' ')).toContain('dumpLimitBytes');
  });

  it('refuses a report taken under another normalizer, which would replay other sources', () => {
    const reasons = replayGateRefusals(
      passing({ normalizerVersion: NORMALIZER_VERSION - 1 }),
      BUILD,
    );

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('normalizerVersion');
  });

  it('refuses a report claiming passed beside a non-empty verdictChanges, naming the count', () => {
    const reasons = replayGateRefusals(passing({ verdictChanges: [{}, {}] }), BUILD);

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('2 verdict change(s)');
  });

  it('refuses a report whose verdictChanges is absent or not a list', () => {
    for (const bad of [undefined, 0, 'none']) {
      expect(replayGateRefusals(passing({ verdictChanges: bad }), BUILD)).toEqual([
        "the Replay_Gate report's verdictChanges is not a list",
      ]);
    }
  });
});

describe('harnessStartRefusal (C8)', () => {
  it('returns null without probing for a config naming no Replay_Gate report', async () => {
    const config = parseOk(BASE);

    expect(replayGateReportPathOf(config)).toBeUndefined();
    // A bogus interpreter proves nothing was spawned: the probe would have failed on it.
    expect(await harnessStartRefusal(config, '/nonexistent/python')).toBeNull();
  });

  it('reaches the check for a non-Campaign config through the top-level path', () => {
    const config = parseOk({ ...BASE, replayGateReportPath: '.eval-runs/slice/replay-gate.json' });

    expect(config.groundingCampaign).toBeUndefined();
    expect(replayGateReportPathOf(config)).toBe('.eval-runs/slice/replay-gate.json');
  });
});
