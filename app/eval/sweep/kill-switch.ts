// The kill switch: the bounds that stop a sweep CLEANLY rather than letting it run
// away.
//
// A bake-off over 46 designs x k samples x a dozen arms is an overnight job against a
// hosted endpoint. Two things can make it never end: a wall clock that quietly
// consumes the whole night, and a matrix bigger than the operator realized. Both are
// bounded here, and the bound is a STOP DISPATCHING decision taken at a sample
// boundary - never a mid-sample abort. That distinction is the whole point: a sample
// killed halfway is a sample paid for and not recorded, whereas a run stopped between
// samples leaves every completed sample intact on disk and resumable.
//
// COST IS RECORDED, NOT LIMITED - AND THAT IS DELIBERATE
//   This campaign wants the numbers, so cost is measured per session, aggregated per
//   arm, and reported; it is NOT a stop condition. A cost limiter would abort the
//   matrix partway and produce arms that cannot be compared with each other, which is
//   worse than an expensive but complete answer. The per-session cost envelope the
//   harness already asserts remains the guard against a single runaway session.
//
// Pure and clock-injected: the decision is a total function of the bounds and the
// counters, so every branch is unit-tested with a fake clock and no waiting.

/** The bounds that end a sweep run early; validated at the config boundary. */
export interface KillSwitchBounds {
  /** Wall-clock ceiling for the whole run, in milliseconds. */
  readonly maxWallClockMs: number;
  /** Ceiling on samples DISPATCHED by this process (resumed skips do not count). */
  readonly maxSamples: number;
}

/** Eight hours and 10000 samples: generous for one overnight campaign, still bounded. */
export const DEFAULT_KILL_SWITCH_BOUNDS: KillSwitchBounds = Object.freeze({
  maxWallClockMs: 28_800_000,
  maxSamples: 10_000,
});

/** Why the sweep stopped dispatching new samples. */
export type SweepStopReason =
  /** Every planned sample was dispatched or already recorded; the normal ending. */
  | 'completed'
  /** The wall-clock bound was reached. */
  | 'wall-clock-exhausted'
  /** The dispatched-sample bound was reached. */
  | 'sample-limit-reached'
  /** The transport breaker reported a sustained provider outage. */
  | 'provider-outage'
  /**
   * A completed sample could not be persisted.
   *
   * Continuing would run samples whose results are lost, which is the one failure worth
   * stopping for: it spends money and produces nothing.
   */
  | 'results-log-unwritable';

/** The counters the kill switch decides against; supplied by the runner. */
export interface SweepProgress {
  /** Samples this process has dispatched to a model so far. */
  readonly dispatchedSamples: number;
  /** Whether the shared transport breaker currently reports a sustained outage. */
  readonly providerOutage: boolean;
}

/**
 * Decide whether the run may dispatch another sample (pure).
 *
 * Returns `null` to continue, or the reason to stop. The outage check comes FIRST:
 * when the provider is down, continuing would only convert wall clock into failed
 * samples, and reporting the outage is more useful than reporting a timeout.
 */
export function stopReasonFor(
  bounds: KillSwitchBounds,
  progress: SweepProgress,
  elapsedMs: number,
): SweepStopReason | null {
  if (progress.providerOutage) {
    return 'provider-outage';
  }
  if (progress.dispatchedSamples >= bounds.maxSamples) {
    return 'sample-limit-reached';
  }
  if (elapsedMs >= bounds.maxWallClockMs) {
    return 'wall-clock-exhausted';
  }
  return null;
}

/**
 * The kill switch as the runner uses it: a start time plus the bounds.
 *
 * Owns nothing but its start instant; the counters live with the runner, which is
 * their single owner, and are passed in. `shouldStop` therefore stays a thin adapter
 * over the pure decision above.
 */
export class SweepKillSwitch {
  readonly #bounds: KillSwitchBounds;
  readonly #now: () => number;
  readonly #startedAtMs: number;

  constructor(bounds: KillSwitchBounds, now: () => number) {
    this.#bounds = bounds;
    this.#now = now;
    this.#startedAtMs = now();
  }

  /** Milliseconds elapsed since the run started. */
  elapsedMs(): number {
    return this.#now() - this.#startedAtMs;
  }

  /** The reason to stop dispatching, or `null` to continue. */
  shouldStop(progress: SweepProgress): SweepStopReason | null {
    return stopReasonFor(this.#bounds, progress, this.elapsedMs());
  }
}
