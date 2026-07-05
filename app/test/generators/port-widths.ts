// Edge-case port-width generators (task 1.3).
//
// Feed the Spec-validation properties (Property 15, task 11.3/11.4): every
// interface signal must have a positive bit width, and zero or negative widths
// must be rejected. The positive generator is provided as the complementary
// "valid" input for the same tests.

import fc from 'fast-check';

/** A bit width that is invalid: zero or negative. */
export function nonPositivePortWidthArbitrary(): fc.Arbitrary<number> {
  return fc.oneof(fc.constant(0), fc.integer({ min: -4096, max: -1 }));
}

/** A bit width that is valid: strictly positive. */
export function positivePortWidthArbitrary(): fc.Arbitrary<number> {
  return fc.integer({ min: 1, max: 4096 });
}
