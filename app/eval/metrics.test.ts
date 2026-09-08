// Unit tests for the pass@k estimator and its aggregation (task 19.3, Req 15.2).
//
// These exercise the standard unbiased estimator on worked examples plus its
// degenerate boundaries, and reinforce its defining invariants over random inputs
// with fast-check. The fast-check block here is a local invariant check on the pure
// function - it is NOT one of the feature's 32 numbered correctness properties
// (pass@k reproducibility is Property 10, covered by tasks 3.6 and 19.4).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { meanPassAtK, passAtK } from './metrics.js';

describe('passAtK - worked examples', () => {
  it('computes the unbiased estimator for a partially-passing problem', () => {
    // n=4, c=2, k=1: 1 - (2/3)(3/4) = 0.5.
    expect(passAtK(4, 2, 1)).toBeCloseTo(0.5, 12);
  });

  it('is 1 when at least one pass is guaranteed in any k-subset (n - c < k)', () => {
    expect(passAtK(4, 2, 4)).toBe(1);
    expect(passAtK(3, 3, 2)).toBe(1);
    expect(passAtK(1, 1, 1)).toBe(1);
  });

  it('is 0 when no sample passed', () => {
    expect(passAtK(1, 0, 1)).toBe(0);
    expect(passAtK(4, 0, 2)).toBe(0);
  });

  it('clamps degenerate inputs rather than throwing', () => {
    expect(passAtK(0, 0, 1)).toBe(0);
    expect(passAtK(4, 2, 0)).toBe(0);
    // k larger than n is treated as n; c beyond n is clamped to n.
    expect(passAtK(4, 2, 10)).toBe(1);
    expect(passAtK(4, 9, 1)).toBe(1);
  });
});

describe('meanPassAtK', () => {
  it('averages per-problem values', () => {
    expect(meanPassAtK([0.5, 1])).toBeCloseTo(0.75, 12);
  });

  it('returns 0 for an empty set rather than NaN', () => {
    expect(meanPassAtK([])).toBe(0);
  });
});

describe('passAtK - defining invariants (local invariant check, not a numbered property)', () => {
  it('stays in [0,1], is non-decreasing in c, and is exact at the boundaries', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 1, max: 20 }),
        (n, cRaw, kRaw) => {
          const c = Math.min(cRaw, n);
          const k = Math.min(kRaw, n);
          const value = passAtK(n, c, k);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
          // Monotonic non-decreasing in the number of correct samples.
          if (c < n) {
            expect(passAtK(n, c + 1, k)).toBeGreaterThanOrEqual(value - 1e-12);
          }
          // No pass possible with zero correct; guaranteed pass when n - c < k.
          expect(passAtK(n, 0, k)).toBe(0);
          if (n - c < k) {
            expect(value).toBe(1);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
