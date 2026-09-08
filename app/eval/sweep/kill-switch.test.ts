// Unit tests for the kill switch.
//
// The bounds must be exact: an off-by-one on the sample cap wastes money, and a wall-clock
// bound that never fires wastes the night. The decision is pure and the clock is injected,
// so every branch is asserted without waiting.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_KILL_SWITCH_BOUNDS,
  stopReasonFor,
  SweepKillSwitch,
  type KillSwitchBounds,
} from './kill-switch.js';

const BOUNDS: KillSwitchBounds = { maxWallClockMs: 10_000, maxSamples: 5 };

/** No outage and the given dispatched count. */
function progress(dispatchedSamples: number, providerOutage = false) {
  return { dispatchedSamples, providerOutage };
}

describe('stopReasonFor', () => {
  it('continues while every bound has room', () => {
    expect(stopReasonFor(BOUNDS, progress(0), 0)).toBeNull();
    expect(stopReasonFor(BOUNDS, progress(4), 9_999)).toBeNull();
  });

  it('stops at exactly the sample cap, not one sample past it', () => {
    expect(stopReasonFor(BOUNDS, progress(4), 0)).toBeNull();
    expect(stopReasonFor(BOUNDS, progress(5), 0)).toBe('sample-limit-reached');
  });

  it('stops at exactly the wall-clock bound', () => {
    expect(stopReasonFor(BOUNDS, progress(0), 9_999)).toBeNull();
    expect(stopReasonFor(BOUNDS, progress(0), 10_000)).toBe('wall-clock-exhausted');
  });

  it('reports a provider outage FIRST, because it is the more useful diagnosis', () => {
    expect(stopReasonFor(BOUNDS, progress(99, true), 999_999)).toBe('provider-outage');
  });

  it('treats an outage as a stop even when nothing else is exhausted', () => {
    expect(stopReasonFor(BOUNDS, progress(0, true), 0)).toBe('provider-outage');
  });
});

describe('SweepKillSwitch', () => {
  it('measures elapsed time from construction', () => {
    let clock = 1_000;
    const killSwitch = new SweepKillSwitch(BOUNDS, () => clock);
    clock = 3_500;
    expect(killSwitch.elapsedMs()).toBe(2_500);
  });

  it('does not stop before a bound is reached', () => {
    let clock = 0;
    const killSwitch = new SweepKillSwitch(BOUNDS, () => clock);
    clock = 5_000;
    expect(killSwitch.shouldStop(progress(2))).toBeNull();
  });

  it('stops once the injected clock passes the wall-clock bound', () => {
    let clock = 0;
    const killSwitch = new SweepKillSwitch(BOUNDS, () => clock);
    clock = 10_001;
    expect(killSwitch.shouldStop(progress(0))).toBe('wall-clock-exhausted');
  });
});

describe('the shipped defaults', () => {
  it('bound one overnight campaign without being a cost limiter', () => {
    expect(DEFAULT_KILL_SWITCH_BOUNDS.maxWallClockMs).toBe(28_800_000);
    expect(DEFAULT_KILL_SWITCH_BOUNDS.maxSamples).toBeGreaterThan(0);
  });
});
