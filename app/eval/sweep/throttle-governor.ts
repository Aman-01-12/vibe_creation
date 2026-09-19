// The throttle governor: the run-wide observer that decides how hard the host is
// currently pushing back, and answers by asking for LESS.
//
// ============================================================================
// THE GOVERNOR SLOWS THE RUN. THE CIRCUIT BREAKER ENDS IT.
// ============================================================================
//   `TransportCircuitBreaker` in ./transport-retry.ts answers one question - "is this
//   endpoint still there?" - and its answer is terminal: at the trip limit it reports a
//   sustained outage and the runner stops dispatching. That is the right response to an
//   endpoint that is DOWN and the wrong response to one that is merely busy, because a
//   rate-limit burst is not an outage and stopping the campaign over one would throw
//   away a night of paid samples.
//
//   This module answers the other question - "are we asking for too much right now?" -
//   and its answer is always a slowdown, never a stop. It is a sibling of the breaker,
//   not a layer above or below it: same construction, same injected clock, same
//   single-owner-of-its-own-state shape, and the two never consult each other.
//
// WHY THE CONFIGURED CONCURRENCY IS A CEILING THE GOVERNOR CAN ONLY MOVE DOWN FROM
//   Measured on the machine that runs these campaigns: concurrency 4 drove load average
//   to 41 on an 8-core box, while concurrency 2 held at about 3.5. The configured value
//   is therefore a real bound that someone chose against real hardware, and a governor
//   that could raise it would be free to reproduce that 41 on its own initiative. So
//   `recommendedConcurrency()` is clamped into `[1, configured]`: the governor may
//   withdraw capacity and hand it back, and it may never invent any.
//
// WHY BOTH REPORTED VALUES ARE DERIVED, AND WHY THERE IS NO RECOVERY TIMER
//   The multiplier and the recommendation are pure functions of the observations still
//   inside the window. Nothing else is stored, so recovery needs no timer and no
//   separate "we have calmed down" event: observations age out of the window, the count
//   falls, the multiplier walks back to 1 and the recommendation back to the configured
//   value, all as a consequence of the clock advancing.
//
//   A recovery timer would be a SECOND source of truth. It could fire while the window
//   still held throttles, or fail to fire while the window was quiet, and then the two
//   reported values would disagree - the run waiting longer between attempts while also
//   restoring concurrency, or the reverse. Deriving both from one list makes that class
//   of bug unrepresentable rather than merely untested.
//
// WHY THERE IS NO CONFIG FIELD FOR ANY OF THIS
//   Every bound here is a build constant. A throttle knob in the sweep config would
//   enter the Config_Identity, change the experiment hash, and orphan every sample
//   already paid for. It would also let two operators with different settings pool
//   samples that are not comparable, and let one of them turn the protection off.
//   Throttle response is a safety property of the harness, not a parameter of the
//   experiment.

/**
 * The bounds on the throttle response; build constants, deliberately NOT config fields.
 *
 * Sized against the one burst that cost 29 of 46 cells in `.eval-runs/instrument-calibration`
 * (the sequence is recorded in `../no-verdict-cause.ts`, which is the citable count):
 * a window long enough that a burst is still visible while we are recovering from it,
 * and steps coarse enough that a single stray 429 - which any busy host emits - does not
 * halve the throughput of an overnight run.
 */
export const THROTTLE_GOVERNOR_LIMITS = Object.freeze({
  /** How long a throttle observation stays inside the window, in milliseconds. */
  windowMs: 60_000,
  /** Throttle observations inside the window that raise the multiplier by one step. */
  observationsPerStep: 4,
  /** The largest backoff multiplier the governor will report. */
  maxMultiplier: 8,
  /** Concurrency removed per step, floored at 1. */
  concurrencyStep: 1,
});

/** The quiet-window multiplier: wait exactly what the retry policy computed. */
const NO_THROTTLING_MULTIPLIER = 1;

/**
 * A run-wide observer of provider throttling, reporting a backoff multiplier and a
 * recommended concurrency.
 *
 * Sole owner of its observation list, mutated only through `recordThrottle`.
 * `backoffMultiplier()` and `recommendedConcurrency()` are DERIVED from the
 * observations still inside the window rather than stored alongside it, so the two can
 * never disagree and recovery is automatic (see the module header).
 *
 * Total: no method throws, and the only clock read is the injected one.
 */
export class ThrottleGovernor {
  readonly #configuredConcurrency: number;
  readonly #now: () => number;
  /** Instants of the throttle replies still inside the window; nothing else is kept. */
  #observations: number[] = [];

  constructor(configuredConcurrency: number, now: () => number) {
    // Normalized rather than trusted, because the failure mode is asymmetric: a
    // recommendation of 0 or NaN would withhold every worker forever and deadlock a run
    // that the governor exists to keep alive. The config boundary already validates this
    // value; a governor constructed from anywhere else still cannot stall the pool.
    this.#configuredConcurrency = Number.isFinite(configuredConcurrency)
      ? Math.max(1, Math.floor(configuredConcurrency))
      : 1;
    this.#now = now;
  }

  /**
   * Record one retryable throttle reply at the current instant.
   *
   * Called for a 429 only - the one status that means "you are asking for too much"
   * rather than "the server is unwell". A 5xx is the breaker's business.
   */
  recordThrottle(): void {
    this.#observations.push(this.#now());
    this.#pruneExpired();
  }

  /**
   * The multiplier to apply to a computed backoff; 1 when the window is quiet.
   *
   * Non-decreasing in the observation count and capped at `maxMultiplier`, so a
   * sustained burst is met with a longer wait than a single transient failure while the
   * wait itself stays bounded.
   */
  backoffMultiplier(): number {
    return Math.min(
      THROTTLE_GOVERNOR_LIMITS.maxMultiplier,
      NO_THROTTLING_MULTIPLIER + this.#steps(),
    );
  }

  /**
   * In-flight samples to allow now; the configured value when the window is quiet.
   *
   * Non-increasing in the observation count and floored at 1. The configured ceiling
   * needs no clamp of its own: the only operation here is SUBTRACTING a non-negative
   * withdrawal from it, which is structurally why the governor can never hand out
   * capacity the operator did not configure. The floor is what makes a reduction a
   * slowdown and never a deadlock.
   */
  recommendedConcurrency(): number {
    const withdrawn = this.#steps() * THROTTLE_GOVERNOR_LIMITS.concurrencyStep;
    return Math.max(1, this.#configuredConcurrency - withdrawn);
  }

  /** How many full steps of throttling the window currently holds. */
  #steps(): number {
    this.#pruneExpired();
    return Math.floor(this.#observations.length / THROTTLE_GOVERNOR_LIMITS.observationsPerStep);
  }

  /**
   * Drop the observations that have aged out of the window.
   *
   * Compaction only: an expired observation can never re-enter the window, so removing
   * it changes no reported value and bounds the list by what arrived during one window.
   * Filtered rather than trimmed from the front because the injected clock is wall time
   * in production and may step backwards, which would leave the list unsorted.
   */
  #pruneExpired(): void {
    const cutoff = this.#now() - THROTTLE_GOVERNOR_LIMITS.windowMs;
    this.#observations = this.#observations.filter((observedAtMs) => observedAtMs > cutoff);
  }
}
