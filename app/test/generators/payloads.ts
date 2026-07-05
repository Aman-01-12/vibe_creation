// Edge-case payload-size generators (task 1.3).
//
// Feed the boundary-validation properties (Property 32, task 5.x): the gateway
// must reject empty and oversized payloads by size before schema handling. The
// oversized generator is deliberately bounded just past a configurable cap so a
// 100+ iteration property stays fast while still exceeding the limit under test.

import fc from 'fast-check';

/** The default byte length treated as "oversized" when the caller gives no cap. */
export const DEFAULT_OVERSIZED_MIN_LENGTH = 64 * 1024;

/** How far beyond the cap the oversized generator is allowed to reach. */
const OVERSIZED_SPAN = 256;

/** The empty payload. */
export function emptyPayloadArbitrary(): fc.Arbitrary<string> {
  return fc.constant('');
}

/**
 * A payload whose length is at least `minLength`, bounded to `minLength +
 * OVERSIZED_SPAN` so iteration cost stays flat. Content is filler; only the
 * size matters for the size-limit checks these cases exercise.
 */
export function oversizedPayloadArbitrary(
  minLength: number = DEFAULT_OVERSIZED_MIN_LENGTH,
): fc.Arbitrary<string> {
  return fc
    .integer({ min: minLength, max: minLength + OVERSIZED_SPAN })
    .map((length) => 'x'.repeat(length));
}

/** Either the empty payload or an oversized one. */
export function boundaryPayloadArbitrary(minOversizedLength?: number): fc.Arbitrary<string> {
  return fc.oneof(emptyPayloadArbitrary(), oversizedPayloadArbitrary(minOversizedLength));
}
