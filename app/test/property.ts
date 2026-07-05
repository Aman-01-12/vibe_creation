// Shared property-test conventions for the hdl-creation-loop feature (task 1.3).
//
// Two things are established here so every later property-test task reuses them
// rather than re-deciding per file:
//
//   1. The tag convention `Feature: hdl-creation-loop, Property {n}: {text}`,
//      exposed as `propertyTag` and the `FEATURE_TAG` constant.
//   2. The 100+ iteration default, exposed as `DEFAULT_NUM_RUNS` and the
//      `propertyParameters` helper that threads it into `fc.assert`.
//
// The Python (Tool_Runner worker) side mirrors this with a Hypothesis settings
// profile at `max_examples = 100`; see the worker's test harness.

import fc from 'fast-check';

/** The feature slug used in every property-test tag for this spec. */
export const FEATURE_TAG = 'hdl-creation-loop';

/**
 * The default number of iterations every property runs at. The design mandates
 * a minimum of 100; callers may raise this but should not lower it.
 */
export const DEFAULT_NUM_RUNS = 100;

/**
 * Build the canonical property-test tag string.
 *
 * The returned string is placed in a comment above each property test so the
 * test is traceable back to its numbered design property.
 */
export function propertyTag(propertyNumber: number, propertyText: string): string {
  return `Feature: ${FEATURE_TAG}, Property ${propertyNumber}: ${propertyText}`;
}

/**
 * Produce fast-check parameters seeded with the shared 100+ iteration default.
 *
 * Overrides are shallow-merged last, so a caller can raise `numRuns` or set a
 * fixed `seed` for reproduction while still inheriting the default otherwise.
 */
export function propertyParameters<Ts = unknown>(overrides?: fc.Parameters<Ts>): fc.Parameters<Ts> {
  return { numRuns: DEFAULT_NUM_RUNS, ...overrides };
}
