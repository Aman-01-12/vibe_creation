// The Replay_Gate driver over five committed fixtures, on the REAL Icarus toolchain
// (testbench-spec-grounding, C12).
//
// The five fixtures are the endings the gate has to tell apart, and each one's BASELINE ending
// is a measured fact worth stating, because it is why the bucket counts are what they are:
//   sample-0 passes the reference and finishes at 10 ns.
//   sample-1 fails the reference and finishes; its check set is FAIL under both pipelines.
//   sample-2 waits on a signal nothing drives with no clock, so the baseline's event queue
//     empties and vvp exits with no CHECK line at all - `errored`, not a Resource_Kill. Under
//     the harness the Watchdog advances time to the budget and ends it with the sentinel.
//   sample-3 declares no `timescale` AND no dump task, so its baseline is `errored` for the
//     missing waveform - the exact Cause 3 this spec's harness removes.
//   sample-4 dumps on a 100 ns clock while hung, so its baseline IS a Resource_Kill and its
//     harness replay is the one Watchdog stop. The clock is 100 ns and not 1 ns DELIBERATELY:
//     at 1 ns this fixture needed ~25 s of wall clock to reach a 20 ms simulated budget, which
//     races the 30 s sandbox wall and made its bucket nondeterministic. The Dump_Limit itself
//     is proven in `simulation-harness.integration.test.ts`, which has no such race.
// The driver makes no model call, so this is a pure harness-vs-baseline check.

import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runReplayGate, type ReplayGateReport } from '@app/eval';
import { WATCHDOG_BUDGET_NS } from '@app/tools';

import { PROBE } from './real-oracle-harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The committed fixtures, which sit beside this file in both layouts. */
const ARTIFACTS_ROOT = join(
  HERE.endsWith('dist') ? join(HERE, '..') : HERE,
  'fixtures/replay-gate/artifacts',
);

const CORPUS_DESIGN = 'rtllm/arithmetic/adder_8bit';

if (!PROBE.available) {
  console.warn(`[replay-gate] SKIPPED - the Replay_Gate is NOT exercised here: ${PROBE.reason}`);
}

describe.skipIf(!PROBE.available)('the Replay_Gate driver over its fixtures', () => {
  it('buckets each fixture by how its harness replay ended', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ece-replay-gate-'));
    let report: ReplayGateReport | null = null;
    try {
      const reportPath = join(directory, 'replay-gate.json');
      report = await runReplayGate({
        mode: 'verify',
        artifactsRoot: ARTIFACTS_ROOT,
        reportPath,
      });
      const written: unknown = JSON.parse(await readFile(reportPath, 'utf8'));
      expect(written).toEqual(report);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }

    expect(report).not.toBeNull();
    if (report === null) {
      return;
    }
    // All five fixtures are the same Campaign_Design, so every one has a reference to replay.
    expect(report.replaySetSize).toBe(5);
    expect(report.schemaVersion).toBe(1);
    expect(report.watchdogBudgetNs).toBe(WATCHDOG_BUDGET_NS);
    expect(report.iverilogVersion).toContain('Icarus');
    // Neither finishing fixture's check set moved: the harness changes how a run ENDS, not
    // what a run that reached `$finish` decided.
    expect(report.verdictChanges).toEqual([]);
    // The one baseline Resource_Kill (sample-4) became a Watchdog stop under the harness.
    expect(report.resourceKillOutcomes).toEqual({
      finished: 0,
      watchdog: 1,
      'resource-kill': 0,
      truncated: 0,
      errored: 0,
    });
    // `$dumplimit` bounds the dumping hang, so no replay reaches the workspace disk cap.
    expect(report.diskCapHits).toEqual([]);
    // sample-0 finishes at 10 ns, so a budget was selectable from a measured end time.
    expect(report.maxFinishedEndNs).toBe(10);
    expect(report.selectedBudgetNs).toBe(20);
    // Every Watchdog stop is inside the Req 6.6 bound, so none is reported as slow.
    expect(report.slowWatchdogStops).toEqual([]);
    expect(report.maxWatchdogWallMs).toBeLessThan(15_000);
    // The gate still does NOT pass: the committed budget is the placeholder 20 ms, and the
    // measured maximum here implies 20 ns, so the Req 6.5 equality is what refuses it. Task
    // 15.1 commits the budget the real Replay_Set measures, and only then can it pass.
    expect(report.passed).toBe(false);
    expect(report.watchdogBudgetNs).not.toBe(report.selectedBudgetNs);
    // Every reported key belongs to the fixture design, never to a real Campaign sample.
    for (const key of [...report.verdictChanges, ...report.slowWatchdogStops]) {
      expect(key.problemId).toBe(CORPUS_DESIGN);
    }
  }, 300_000);
});
