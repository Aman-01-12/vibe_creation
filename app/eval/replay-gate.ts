// The Replay_Gate's pure decisions (testbench-spec-grounding, C12): whether replaying every
// recorded control testbench through the harness pipeline moves any verdict, and which
// Watchdog_Budget the measured end times imply.
//
// Pure on purpose: the driver (`scripts/replay-gate.ts`) does the file and sandbox work and
// hands the measured runs in, so the gate's rule is testable against an oracle without Icarus.

import type { SimulationVerdict } from '@app/tools';

/** How one replayed run ended; every bucket is reported, so the list is closed. */
export const REPLAY_ENDINGS = [
  'finished',
  'watchdog',
  'resource-kill',
  'truncated',
  'errored',
] as const;
export type ReplayEnding = (typeof REPLAY_ENDINGS)[number];

/** One replayed run, reduced to the facts the gate decides on. */
export interface ReplayRun {
  readonly ending: ReplayEnding;
  /** The set of (name, PASS|FAIL) pairs, or null when the run produced no per-check verdict. */
  readonly checkSet: readonly string[] | null;
  /** From the `$finish called at <n> (<unit>)` line, converted to ns; null when absent. */
  readonly simulatedEndNs: number | null;
  readonly wallMs: number;
  readonly diskCapped: boolean;
}

/** Which Replay_Set sample a reported fact belongs to. */
export interface ReplaySampleKey {
  readonly problemId: string;
  /** The Model_Arm directory the recorded control sample came from. */
  readonly modelArm: string;
  readonly sample: number;
}

/** One Replay_Set sample's two runs: today's pipeline, and this spec's. */
export interface ReplayPair {
  readonly key: ReplaySampleKey;
  readonly baseline: ReplayRun;
  readonly harness: ReplayRun;
}

/** Everything `decideReplayGate` decides from. */
export interface ReplayGateInput {
  readonly pairs: readonly ReplayPair[];
  readonly simulationHarnessVersion: number;
  readonly normalizerVersion: number;
  /** The budget committed in the build under test, compared against the measured maximum. */
  readonly watchdogBudgetNs: number;
  readonly dumpLimitBytes: number;
  readonly iverilogVersion: string;
  /** Baseline_Replays whose verdict disagrees with the recorded Reference_Campaign run. */
  readonly baselineDrift: number;
}

/** The committed report the Campaign's preflight reads and the Sweep_Manifest records. */
export interface ReplayGateReport {
  readonly schemaVersion: 1;
  readonly simulationHarnessVersion: number;
  readonly normalizerVersion: number;
  readonly watchdogBudgetNs: number;
  readonly dumpLimitBytes: number;
  readonly iverilogVersion: string;
  readonly replaySetSize: number;
  readonly verdictChanges: readonly ReplaySampleKey[];
  readonly resourceKillOutcomes: Readonly<Record<ReplayEnding, number>>;
  readonly maxFinishedEndNs: number;
  readonly maxWatchdogWallMs: number;
  readonly selectedBudgetNs: number;
  readonly diskCapHits: readonly ReplaySampleKey[];
  readonly slowWatchdogStops: readonly ReplaySampleKey[];
  /** Report-only: it measures the replay environment, not this spec's change. */
  readonly baselineDrift: number;
  readonly passed: boolean;
}

/** A Watchdog stop must be reached within half the sandbox wall clock (Req 6.6). */
export const MAX_WATCHDOG_WALL_MS = 15_000;

/** The `$finish called at <n> (<prefix><unit>)` line Icarus prints, with its time base. */
const FINISH_LINE = /\$finish called at (\d+) \((1|10|100)(s|ms|us|ns|ps|fs)\)/u;

/** Nanoseconds per one unit of each Verilog time unit, as an exact rational. */
const NS_PER_UNIT: Readonly<
  Record<string, { readonly numerator: bigint; readonly denominator: bigint }>
> = {
  s: { numerator: 1_000_000_000n, denominator: 1n },
  ms: { numerator: 1_000_000n, denominator: 1n },
  us: { numerator: 1_000n, denominator: 1n },
  ns: { numerator: 1n, denominator: 1n },
  ps: { numerator: 1n, denominator: 1_000n },
  fs: { numerator: 1n, denominator: 1_000_000n },
};

/**
 * The simulated end time in nanoseconds from a run's stdout, or null when absent.
 *
 * Multiplied in `BigInt` before reaching nanoseconds, so a `(1s)` end and a `(1ps)` end are
 * comparable without a float rounding the larger one.
 */
export function simulatedEndNs(stdout: string): number | null {
  const match = FINISH_LINE.exec(stdout);
  if (match === null) {
    return null;
  }
  const scale = NS_PER_UNIT[match[3] ?? ''];
  if (scale === undefined) {
    return null;
  }
  const ticks = BigInt(match[1] ?? '0') * BigInt(match[2] ?? '1');
  return Number((ticks * scale.numerator) / scale.denominator);
}

/** The check set as sorted, de-duplicated `name:PASS` / `name:FAIL` strings (Req 6.2). */
function checkSetOf(verdict: SimulationVerdict): readonly string[] | null {
  if (verdict.verdict === 'error' || verdict.checks.length === 0) {
    return null;
  }
  const pairs = verdict.checks.map((check) => `${check.name}:${check.passed ? 'PASS' : 'FAIL'}`);
  return [...new Set(pairs)].sort();
}

/** How a run ended, decided from the verdict's own flags and never from its checks. */
function endingOf(verdict: SimulationVerdict): ReplayEnding {
  if (verdict.watchdog.stopped) {
    return 'watchdog';
  }
  if (verdict.failureCause === 'timed-out' || verdict.failureCause === 'disk-capped') {
    return 'resource-kill';
  }
  if (verdict.failureCause === 'output-incomplete' && verdict.stdout.length > 0) {
    return 'truncated';
  }
  return verdict.verdict === 'error' ? 'errored' : 'finished';
}

/** Reduce one measured run to the facts the gate decides on. */
export function replayRunOf(verdict: SimulationVerdict): ReplayRun {
  return {
    ending: endingOf(verdict),
    checkSet: checkSetOf(verdict),
    simulatedEndNs: simulatedEndNs(verdict.stdout),
    wallMs: verdict.resourceUsage.wallMs,
    diskCapped: verdict.failureCause === 'disk-capped',
  };
}

/** The Round_Value mantissas: a budget is d x 10^k ns with d in {1, 2, 5}. */
const ROUND_VALUE_MANTISSAS = [1, 2, 5] as const;

/** The largest exponent whose Round_Values are all exact integers in a double. */
const MAX_ROUND_VALUE_EXPONENT = 15;

/** The smallest Round_Value strictly above `maxEndNs` (Req 6.5). */
export function roundValueAbove(maxEndNs: number): number {
  // Ascending by construction: 1, 2, 5, 10, 20, 50, ... so the first one above is the smallest.
  for (let exponent = 0; exponent <= MAX_ROUND_VALUE_EXPONENT; exponent += 1) {
    for (const mantissa of ROUND_VALUE_MANTISSAS) {
      const candidate = mantissa * 10 ** exponent;
      if (candidate > maxEndNs) {
        return candidate;
      }
    }
  }
  throw new RangeError(`no Round_Value within the exact-integer range exceeds ${String(maxEndNs)}`);
}

/** An all-zero bucket count, so every ending is reported even at zero. */
function emptyOutcomes(): Record<ReplayEnding, number> {
  return { finished: 0, watchdog: 0, 'resource-kill': 0, truncated: 0, errored: 0 };
}

/** The gate's whole decision over the measured pairs (pure, total). */
export function decideReplayGate(input: ReplayGateInput): ReplayGateReport {
  const verdictChanges: ReplaySampleKey[] = [];
  const diskCapHits: ReplaySampleKey[] = [];
  const slowWatchdogStops: ReplaySampleKey[] = [];
  const resourceKillOutcomes = emptyOutcomes();
  let maxFinishedEndNs = 0;
  let maxWatchdogWallMs = 0;

  for (const { key, baseline, harness } of input.pairs) {
    if (baseline.checkSet !== null && !sameCheckSet(baseline.checkSet, harness.checkSet)) {
      verdictChanges.push(key);
    }
    if (baseline.ending === 'resource-kill') {
      resourceKillOutcomes[harness.ending] += 1;
    }
    if (harness.diskCapped) {
      diskCapHits.push(key);
    }
    if (harness.ending === 'watchdog') {
      maxWatchdogWallMs = Math.max(maxWatchdogWallMs, harness.wallMs);
      if (harness.wallMs > MAX_WATCHDOG_WALL_MS) {
        slowWatchdogStops.push(key);
      }
    }
    if (baseline.ending === 'finished' && harness.simulatedEndNs !== null) {
      maxFinishedEndNs = Math.max(maxFinishedEndNs, harness.simulatedEndNs);
    }
  }

  const selectedBudgetNs = roundValueAbove(maxFinishedEndNs);
  return {
    schemaVersion: 1,
    simulationHarnessVersion: input.simulationHarnessVersion,
    normalizerVersion: input.normalizerVersion,
    watchdogBudgetNs: input.watchdogBudgetNs,
    dumpLimitBytes: input.dumpLimitBytes,
    iverilogVersion: input.iverilogVersion,
    replaySetSize: input.pairs.length,
    verdictChanges,
    resourceKillOutcomes,
    maxFinishedEndNs,
    maxWatchdogWallMs,
    selectedBudgetNs,
    diskCapHits,
    slowWatchdogStops,
    baselineDrift: input.baselineDrift,
    passed:
      verdictChanges.length === 0 &&
      diskCapHits.length === 0 &&
      slowWatchdogStops.length === 0 &&
      input.watchdogBudgetNs === selectedBudgetNs,
  };
}

/** Two check sets agree when both are present and equal element-wise. */
function sameCheckSet(baseline: readonly string[], harness: readonly string[] | null): boolean {
  if (harness === null || harness.length !== baseline.length) {
    return false;
  }
  return baseline.every((entry, index) => entry === harness[index]);
}
