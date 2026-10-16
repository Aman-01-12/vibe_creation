// testbench-spec-grounding, Properties 13 and 14: the Replay_Gate's arithmetic and its decision.
//
// Both oracles are written from Requirement 6's text in this file and share no helper with
// `replay-gate.ts`, so a rule that drifts in the implementation cannot drift in the oracle too.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  MAX_WATCHDOG_WALL_MS,
  REPLAY_ENDINGS,
  decideReplayGate,
  roundValueAbove,
  simulatedEndNs,
  type ReplayEnding,
  type ReplayGateReport,
  type ReplayPair,
  type ReplayRun,
} from './replay-gate.js';

const PROPERTY_13 = 'Feature: testbench-spec-grounding, Property 13: Replay_Gate arithmetic';
const PROPERTY_14 =
  'Feature: testbench-spec-grounding, Property 14: Replay_Gate decision agrees with an independent oracle';

// --- Property 13: the arithmetic --------------------------------------------

/** Every Round_Value up to the exact-integer ceiling, ascending. */
function allRoundValues(): readonly number[] {
  const values: number[] = [];
  for (let exponent = 0; exponent <= 15; exponent += 1) {
    for (const mantissa of [1, 2, 5]) {
      values.push(mantissa * 10 ** exponent);
    }
  }
  return values;
}

const UNIT_EXPONENTS: Readonly<Record<string, number>> = {
  s: 9,
  ms: 6,
  us: 3,
  ns: 0,
  ps: -3,
  fs: -6,
};

/** The expected nanosecond value of `n` ticks of `prefix<unit>`, by exponent arithmetic. */
function expectedNs(ticks: number, prefix: number, unit: string): number {
  const exponent = UNIT_EXPONENTS[unit] ?? 0;
  const scaled = BigInt(ticks) * BigInt(prefix);
  if (exponent >= 0) {
    return Number(scaled * 10n ** BigInt(exponent));
  }
  return Number(scaled / 10n ** BigInt(-exponent));
}

describe(PROPERTY_13, () => {
  it('returns the smallest Round_Value strictly above its argument', () => {
    const roundValues = allRoundValues();
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 * 10 ** 14 }), (value) => {
        const selected = roundValueAbove(value);
        expect(roundValues).toContain(selected);
        expect(selected).toBeGreaterThan(value);
        const smaller = roundValues.filter(
          (candidate) => candidate > value && candidate < selected,
        );
        expect(smaller).toEqual([]);
      }),
      // 200 runs, above the 100-iteration floor; `@app/eval` may not import the shared helper.
      { numRuns: 200 },
    );
  });

  it('reads an exact nanosecond end time back out of a noisy stdout', () => {
    const noise = fc.array(
      fc.constantFrom('CHECK a_ok PASS', 'VCD info: dumpfile dump.vcd opened', '', '  '),
      { maxLength: 4 },
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 ** 9 }),
        fc.constantFrom(1, 10, 100),
        fc.constantFrom('s', 'ms', 'us', 'ns', 'ps', 'fs'),
        noise,
        noise,
        (ticks, prefix, unit, before, after) => {
          const line = `$finish called at ${String(ticks)} (${String(prefix)}${unit})`;
          const stdout = [...before, line, ...after].join('\n');
          expect(simulatedEndNs(stdout)).toBe(expectedNs(ticks, prefix, unit));
        },
      ),
      // 200 runs, above the 100-iteration floor; `@app/eval` may not import the shared helper.
      { numRuns: 200 },
    );
  });

  it('reports no end time when stdout carries no `$finish called at` line', () => {
    fc.assert(
      fc.property(fc.string(), (stdout) => {
        fc.pre(!stdout.includes('$finish called at'));
        expect(simulatedEndNs(stdout)).toBeNull();
      }),
      // 200 runs, above the 100-iteration floor; `@app/eval` may not import the shared helper.
      { numRuns: 200 },
    );
  });
});

// --- Property 14: the decision ----------------------------------------------

const arbEnding = fc.constantFrom<ReplayEnding>(...REPLAY_ENDINGS);

const arbCheckSet = fc.oneof(
  fc.constant(null),
  fc.subarray(['a:PASS', 'a:FAIL', 'b:PASS', 'b:FAIL']).map((entries) => [...entries].sort()),
);

const arbRun: fc.Arbitrary<ReplayRun> = fc.record({
  ending: arbEnding,
  checkSet: arbCheckSet,
  simulatedEndNs: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 10 ** 12 })),
  wallMs: fc.integer({ min: 0, max: 40_000 }),
  diskCapped: fc.boolean(),
});

/** Pairs whose harness run frequently REPEATS the baseline check set, so agreement is sampled. */
const arbPair: fc.Arbitrary<ReplayPair> = fc
  .record({
    problemId: fc.constantFrom('rtllm/a/x', 'rtllm/b/y'),
    modelArm: fc.constantFrom('zai.glm-5', 'deepseek.v3.2'),
    sample: fc.integer({ min: 0, max: 4 }),
    baseline: arbRun,
    harness: arbRun,
    agree: fc.boolean(),
  })
  .map(({ problemId, modelArm, sample, baseline, harness, agree }) => ({
    key: { problemId, modelArm, sample },
    baseline,
    harness: agree ? { ...harness, checkSet: baseline.checkSet } : harness,
  }));

/** The independent oracle, written from Requirement 6.2, 6.3, 6.6, and 6.7. */
function oracle(pairs: readonly ReplayPair[], budgetNs: number): Partial<ReplayGateReport> {
  const changed = pairs.filter((pair) => {
    if (pair.baseline.checkSet === null) {
      return false;
    }
    const harness = pair.harness.checkSet;
    return harness === null || JSON.stringify(harness) !== JSON.stringify(pair.baseline.checkSet);
  });
  const buckets: Record<string, number> = {};
  for (const ending of REPLAY_ENDINGS) {
    buckets[ending] = pairs.filter(
      (pair) => pair.baseline.ending === 'resource-kill' && pair.harness.ending === ending,
    ).length;
  }
  const watchdogWalls = pairs
    .filter((pair) => pair.harness.ending === 'watchdog')
    .map((pair) => pair.harness.wallMs);
  const finishedEnds = pairs
    .filter((pair) => pair.baseline.ending === 'finished' && pair.harness.simulatedEndNs !== null)
    .map((pair) => pair.harness.simulatedEndNs ?? 0);
  const maxFinishedEndNs = finishedEnds.length === 0 ? 0 : Math.max(...finishedEnds);
  const diskCapHits = pairs.filter((pair) => pair.harness.diskCapped);
  const slow = watchdogWalls.filter((wallMs) => wallMs > MAX_WATCHDOG_WALL_MS);
  return {
    verdictChanges: changed.map((pair) => pair.key),
    resourceKillOutcomes: buckets as Record<ReplayEnding, number>,
    maxFinishedEndNs,
    maxWatchdogWallMs: watchdogWalls.length === 0 ? 0 : Math.max(...watchdogWalls),
    diskCapHits: diskCapHits.map((pair) => pair.key),
    passed:
      changed.length === 0 &&
      diskCapHits.length === 0 &&
      slow.length === 0 &&
      budgetNs === roundValueAbove(maxFinishedEndNs),
  };
}

/**
 * Pairs that CAN pass the gate: every check set agrees, nothing hit the disk cap, and every
 * Watchdog stop is inside the wall bound. Generated rather than hoped for, because a random
 * budget equal to `roundValueAbove` of a random maximum is a coincidence, not a case.
 */
const arbPassablePairs: fc.Arbitrary<readonly ReplayPair[]> = fc.array(
  fc
    .record({
      problemId: fc.constantFrom('rtllm/a/x', 'rtllm/b/y'),
      modelArm: fc.constantFrom('zai.glm-5', 'deepseek.v3.2'),
      sample: fc.integer({ min: 0, max: 4 }),
      ending: arbEnding,
      checkSet: arbCheckSet,
      endNs: fc.integer({ min: 0, max: 10 ** 6 }),
      wallMs: fc.integer({ min: 0, max: MAX_WATCHDOG_WALL_MS }),
    })
    .map(({ problemId, modelArm, sample, ending, checkSet, endNs, wallMs }) => {
      const run: ReplayRun = {
        ending,
        checkSet,
        simulatedEndNs: endNs,
        wallMs,
        diskCapped: false,
      };
      return { key: { problemId, modelArm, sample }, baseline: run, harness: run };
    }),
  { maxLength: 8 },
);

describe(PROPERTY_14, () => {
  it('reports what the oracle reports, and passes exactly when the oracle passes', () => {
    let sawPass = false;
    let sawChange = false;
    fc.assert(
      fc.property(
        fc.oneof(fc.array(arbPair, { maxLength: 12 }), arbPassablePairs),
        fc.oneof(fc.constantFrom(1, 2, 5, 20_000_000), fc.integer({ min: 1, max: 10 ** 9 })),
        (pairs, watchdogBudgetNs) => {
          const report = decideReplayGate({
            pairs,
            simulationHarnessVersion: 1,
            normalizerVersion: 5,
            watchdogBudgetNs,
            dumpLimitBytes: 16_777_216,
            iverilogVersion: 'Icarus Verilog version 13.0',
            baselineDrift: 0,
          });
          const expected = oracle(pairs, watchdogBudgetNs);
          expect(report.verdictChanges).toEqual(expected.verdictChanges);
          expect(report.resourceKillOutcomes).toEqual(expected.resourceKillOutcomes);
          expect(report.maxFinishedEndNs).toBe(expected.maxFinishedEndNs);
          expect(report.maxWatchdogWallMs).toBe(expected.maxWatchdogWallMs);
          expect(report.diskCapHits).toEqual(expected.diskCapHits);
          expect(report.selectedBudgetNs).toBe(roundValueAbove(expected.maxFinishedEndNs ?? 0));
          expect(report.replaySetSize).toBe(pairs.length);
          expect(report.passed).toBe(expected.passed);
          // The budget the gate would select is what makes a passable set actually pass.
          const atSelectedBudget = decideReplayGate({
            pairs,
            simulationHarnessVersion: 1,
            normalizerVersion: 5,
            watchdogBudgetNs: report.selectedBudgetNs,
            dumpLimitBytes: 16_777_216,
            iverilogVersion: 'Icarus Verilog version 13.0',
            baselineDrift: 0,
          });
          expect(atSelectedBudget.passed).toBe(oracle(pairs, report.selectedBudgetNs).passed);
          sawPass ||= report.passed || atSelectedBudget.passed;
          sawChange ||= report.verdictChanges.length > 0;
        },
      ),
      // 200 runs, above the 100-iteration floor; `@app/eval` may not import the shared helper.
      { numRuns: 200 },
    );
    // Non-vacuity: both outcomes were generated, so neither branch is untested.
    expect([sawPass, sawChange]).toEqual([true, true]);
  });
});
