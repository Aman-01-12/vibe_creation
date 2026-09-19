// Property tests for the throttle governor: the backoff multiplier and the recommended
// concurrency, both derived from the same observation window.
//
// Both properties below generate a SEQUENCE of instants at which `recordThrottle()` is
// called against a controllable fake clock, rather than calling it a fixed number of
// times at one instant. A sequence generator is what lets a run cross the window
// boundary - advance the clock past `windowMs` after a burst - which is required for
// Property 11's recovery clause to execute at all instead of passing vacuously.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { THROTTLE_GOVERNOR_LIMITS, ThrottleGovernor } from './throttle-governor.js';

/** A mutable clock closure; nothing here waits on a real timer. */
function fakeClock(startMs = 0): { readonly now: () => number; advance: (ms: number) => void } {
  let clock = startMs;
  return {
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/** Replay a sequence of inter-observation gaps against a governor, advancing the clock by each gap before recording. */
function replay(
  governor: ThrottleGovernor,
  clock: ReturnType<typeof fakeClock>,
  gapsMs: readonly number[],
): void {
  for (const gapMs of gapsMs) {
    clock.advance(gapMs);
    governor.recordThrottle();
  }
}

describe('backoff multiplier - Property 10', () => {
  // Feature: eval-campaign-readiness, Property 10: The backoff multiplier is monotone
  // in observed throttling and bounded.
  //
  // Validates: Requirements 6.2, 6.3, 6.4

  it('is 1 while the window holds no observation', () => {
    const clock = fakeClock();
    const governor = new ThrottleGovernor(4, clock.now);
    expect(governor.backoffMultiplier()).toBe(1);
  });

  it('never decreases as more observations land inside the window, and stays within [1, maxMultiplier]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 16 }),
        // Gaps small enough that the whole sequence stays inside one window, so every
        // recorded observation is still present at the end and the count only grows.
        fc.array(fc.integer({ min: 0, max: 500 }), { minLength: 1, maxLength: 40 }),
        (configuredConcurrency, gapsMs) => {
          const clock = fakeClock();
          const governor = new ThrottleGovernor(configuredConcurrency, clock.now);

          let previousMultiplier = governor.backoffMultiplier();
          expect(previousMultiplier).toBe(1);

          for (const gapMs of gapsMs) {
            clock.advance(gapMs);
            governor.recordThrottle();
            const multiplier = governor.backoffMultiplier();

            expect(multiplier).toBeGreaterThanOrEqual(previousMultiplier);
            expect(multiplier).toBeGreaterThanOrEqual(1);
            expect(multiplier).toBeLessThanOrEqual(THROTTLE_GOVERNOR_LIMITS.maxMultiplier);

            previousMultiplier = multiplier;
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('reaches the cap and never exceeds it under a burst far beyond the cap step count', () => {
    const clock = fakeClock();
    const governor = new ThrottleGovernor(4, clock.now);
    const observationsToSaturate =
      THROTTLE_GOVERNOR_LIMITS.observationsPerStep * (THROTTLE_GOVERNOR_LIMITS.maxMultiplier + 5);

    for (let i = 0; i < observationsToSaturate; i += 1) {
      governor.recordThrottle();
    }

    expect(governor.backoffMultiplier()).toBe(THROTTLE_GOVERNOR_LIMITS.maxMultiplier);
  });
});

describe('recommended concurrency - Property 11', () => {
  // Feature: eval-campaign-readiness, Property 11: The recommended concurrency is
  // monotone, bounded, and recovers.
  //
  // Validates: Requirements 6.2, 6.3, 6.4, 6.6, 7.1, 7.2, 7.3

  it('is the configured value while the window holds no observation', () => {
    const clock = fakeClock();
    const governor = new ThrottleGovernor(6, clock.now);
    expect(governor.recommendedConcurrency()).toBe(6);
  });

  it('never increases as observations accumulate, and stays within [1, configuredConcurrency]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 16 }),
        fc.array(fc.integer({ min: 0, max: 500 }), { minLength: 1, maxLength: 40 }),
        (configuredConcurrency, gapsMs) => {
          const clock = fakeClock();
          const governor = new ThrottleGovernor(configuredConcurrency, clock.now);

          let previousRecommendation = governor.recommendedConcurrency();
          expect(previousRecommendation).toBe(configuredConcurrency);

          for (const gapMs of gapsMs) {
            clock.advance(gapMs);
            governor.recordThrottle();
            const recommendation = governor.recommendedConcurrency();

            expect(recommendation).toBeLessThanOrEqual(previousRecommendation);
            expect(recommendation).toBeGreaterThanOrEqual(1);
            expect(recommendation).toBeLessThanOrEqual(configuredConcurrency);

            previousRecommendation = recommendation;
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // The property that would pass vacuously without a sequence spanning the window
  // boundary: a burst is recorded, the clock is advanced PAST `windowMs`, and the
  // recommendation is asserted to have walked all the way back to the configured value
  // with no separate recovery step - because there is none to call.
  it('recovers to the configured value once every observation has aged out past windowMs', () => {
    fc.assert(
      fc.property(
        // A floor of 2, not 1: at `configuredConcurrency === 1` the recommendation is
        // already floored before any observation lands, so there is nothing a burst
        // could withdraw and "recover FROM" would be checking a no-op withdrawal.
        fc.integer({ min: 2, max: 16 }),
        // A burst sized to withdraw at least one step, so there is something to recover
        // FROM: enough observations to guarantee `steps() >= 1` before the window ages out.
        fc.integer({
          min: THROTTLE_GOVERNOR_LIMITS.observationsPerStep,
          max:
            THROTTLE_GOVERNOR_LIMITS.observationsPerStep *
            THROTTLE_GOVERNOR_LIMITS.maxMultiplier *
            2,
        }),
        (configuredConcurrency, burstSize) => {
          const clock = fakeClock();
          const governor = new ThrottleGovernor(configuredConcurrency, clock.now);

          for (let i = 0; i < burstSize; i += 1) {
            governor.recordThrottle();
          }
          expect(governor.recommendedConcurrency()).toBeLessThan(configuredConcurrency);

          // Cross the window boundary: every observation above is now older than windowMs.
          clock.advance(THROTTLE_GOVERNOR_LIMITS.windowMs + 1);

          expect(governor.recommendedConcurrency()).toBe(configuredConcurrency);
          expect(governor.backoffMultiplier()).toBe(1);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('partially recovers as only the aged-out portion of a burst leaves the window', () => {
    // A two-phase burst, spaced apart, so advancing the clock once ages out the first
    // phase while the second is still inside the window - the case a single-burst
    // generator can never reach, and the one that actually distinguishes "derived from
    // the window" from "derived from a running total".
    const configuredConcurrency = 8;
    const clock = fakeClock();
    const governor = new ThrottleGovernor(configuredConcurrency, clock.now);

    replay(governor, clock, Array(THROTTLE_GOVERNOR_LIMITS.observationsPerStep).fill(0));
    const afterFirstPhase = governor.recommendedConcurrency();
    expect(afterFirstPhase).toBeLessThan(configuredConcurrency);

    clock.advance(THROTTLE_GOVERNOR_LIMITS.windowMs - 1);
    replay(governor, clock, Array(THROTTLE_GOVERNOR_LIMITS.observationsPerStep).fill(0));
    const afterSecondPhase = governor.recommendedConcurrency();
    expect(afterSecondPhase).toBeLessThanOrEqual(afterFirstPhase);

    // Age out the first phase only; the second phase is still inside the window.
    clock.advance(2);
    expect(governor.recommendedConcurrency()).toBeGreaterThan(afterSecondPhase);
    expect(governor.recommendedConcurrency()).toBeLessThan(configuredConcurrency);

    // Age out the rest; full recovery with no separate recovery step.
    clock.advance(THROTTLE_GOVERNOR_LIMITS.windowMs);
    expect(governor.recommendedConcurrency()).toBe(configuredConcurrency);
  });
});
