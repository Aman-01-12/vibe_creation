// Harness self-test (task 1.3).
//
// This exists only to prove the property-based testing harness actually runs a
// property using a shared generator - so `npm test` executes a property rather
// than collecting nothing. It is intentionally trivial and covers no product
// requirement; the real numbered properties land in their own tasks.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  captureStateArbitrary,
  completeCaptureStateArbitrary,
  isIncompleteCapture,
  partialCaptureStateArbitrary,
} from './generators/index.js';
import { DEFAULT_NUM_RUNS, propertyParameters, propertyTag } from './property.js';

describe('property harness self-test', () => {
  it('runs a property over a shared generator at the 100+ iteration default', () => {
    // Feature: hdl-creation-loop, Property 0: harness self-test - partial captures are always incomplete
    fc.assert(
      fc.property(partialCaptureStateArbitrary(), (state) => isIncompleteCapture(state)),
      propertyParameters(),
    );
  });

  it('classifies complete capture states as not incomplete', () => {
    fc.assert(
      fc.property(completeCaptureStateArbitrary(), (state) => !isIncompleteCapture(state)),
      propertyParameters(),
    );
  });

  it('always yields a boolean incompleteness verdict for any capture state', () => {
    fc.assert(
      fc.property(
        captureStateArbitrary(),
        (state) => typeof isIncompleteCapture(state) === 'boolean',
      ),
      propertyParameters(),
    );
  });

  it('exposes the shared tag convention and a 100+ iteration default', () => {
    expect(propertyTag(0, 'harness self-test')).toBe(
      'Feature: hdl-creation-loop, Property 0: harness self-test',
    );
    expect(DEFAULT_NUM_RUNS).toBeGreaterThanOrEqual(100);
  });

  it('actually executes the property at the 100+ iteration default', () => {
    // Proves the default is wired through `fc.assert`, not merely declared: a
    // passing property runs its predicate exactly `numRuns` times (shrinking
    // only occurs on failure), so the observed count must equal the default.
    let invocations = 0;
    fc.assert(
      fc.property(fc.integer(), () => {
        invocations += 1;
        return true;
      }),
      propertyParameters(),
    );

    expect(invocations).toBe(DEFAULT_NUM_RUNS);
    expect(invocations).toBeGreaterThanOrEqual(100);
  });
});
