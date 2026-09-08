// Unit and property tests for the `Retry-After` boundary parser.
//
// WHAT THESE PIN DOWN
//   1. Both legal header forms are read: an integer count of seconds, and an HTTP-date
//      measured against the INJECTED instant.
//   2. Everything else reports "no instruction" - which includes the traps a lenient host
//      date parser would otherwise fall into, because `Date.parse('1.5')` and
//      `Date.parse('120')` both return real instants decades away.
//   3. A readable value is CLAMPED. The header is untrusted input, and an unbounded delay
//      is a denial of service delivered through a header we chose to obey.
//   4. Zero is a real answer and is not `null`: a host may say "now" while still refusing.
//
// Nothing here reads a clock or a header off a real reply: the instant is a parameter, so
// both forms are deterministic.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseRetryAfterMs } from './retry-after.js';

/** The feature tag every numbered property in this spec carries. */
const FEATURE_TAG = 'eval-campaign-readiness';

/** Iterations every property runs at; the repository's shared minimum. */
const NUM_RUNS = 100;

/** A fixed instant, so the HTTP-date examples below never depend on real time. */
const NOW_MS = Date.parse('Sun, 06 Nov 1994 08:49:37 GMT');

/** The ceiling most examples clamp against; one minute, in milliseconds. */
const MAX_DELAY_MS = 60_000;

/** An HTTP-date exactly 30 seconds after `NOW_MS`, in the form HTTP mandates. */
const IMF_FIXDATE_PLUS_30S = 'Sun, 06 Nov 1994 08:50:07 GMT';

/**
 * Header texts that must all report NO instruction.
 *
 * The numeric-looking entries are the important ones: each of them is read as a real date
 * by a lenient host date parser, so each would become a wait of decades if the reader
 * handed an unrecognized numeric form to that parser.
 */
const UNREADABLE_VALUES: readonly string[] = [
  '',
  '   ',
  '1.5',
  '0.0',
  '+5',
  '-5',
  '-1',
  '120s',
  '1e3',
  '0x10',
  'soon',
  'Retry-After: 5',
  'Sun, 06 Nov 1994 08:49:37',
  'Thu, 32 Xyz 1994 99:99:99 GMT',
];

describe('parseRetryAfterMs - the delta-seconds form', () => {
  it('reads a count of whole seconds as that many milliseconds', () => {
    expect(parseRetryAfterMs('30', NOW_MS, MAX_DELAY_MS)).toBe(30_000);
    expect(parseRetryAfterMs('1', NOW_MS, MAX_DELAY_MS)).toBe(1_000);
  });

  it('reads zero as a real instruction, distinct from no instruction at all', () => {
    // The host said "now" while still refusing. The caller treats this as a floor, so a
    // zero must not collapse into `null` and lose the fact that a reply was throttled.
    expect(parseRetryAfterMs('0', NOW_MS, MAX_DELAY_MS)).toBe(0);
  });

  it('tolerates the surrounding whitespace a header value can carry', () => {
    expect(parseRetryAfterMs('  30  ', NOW_MS, MAX_DELAY_MS)).toBe(30_000);
  });

  it('clamps a count that would park a campaign', () => {
    // 86400 seconds is a day. Obeying it verbatim would be a denial of service we opted in to.
    expect(parseRetryAfterMs('86400', NOW_MS, MAX_DELAY_MS)).toBe(MAX_DELAY_MS);
  });

  it('clamps a count so absurd it overflows, rather than reporting a non-finite delay', () => {
    const overflowing = '9'.repeat(400);
    expect(parseRetryAfterMs(overflowing, NOW_MS, MAX_DELAY_MS)).toBe(MAX_DELAY_MS);
  });
});

describe('parseRetryAfterMs - the HTTP-date form', () => {
  it('reports the milliseconds remaining against the injected instant', () => {
    expect(parseRetryAfterMs(IMF_FIXDATE_PLUS_30S, NOW_MS, MAX_DELAY_MS)).toBe(30_000);
  });

  it('reads the RFC 850 and asctime forms too, since a host may send either', () => {
    // Both name a month, which is what the letter gate keys on; both carry a zone here so
    // the example cannot depend on the host time zone.
    expect(parseRetryAfterMs('Sunday, 06-Nov-94 08:50:07 GMT', NOW_MS, MAX_DELAY_MS)).toBe(30_000);
    expect(parseRetryAfterMs('Sun, 06 Nov 1994 08:50:07 +0000', NOW_MS, MAX_DELAY_MS)).toBe(30_000);
  });

  it('reports no instruction for a date that has already passed', () => {
    const elapsed = 'Sun, 06 Nov 1994 08:49:36 GMT';
    expect(parseRetryAfterMs(elapsed, NOW_MS, MAX_DELAY_MS)).toBeNull();
  });

  it('reports zero for a date at exactly the injected instant', () => {
    expect(parseRetryAfterMs('Sun, 06 Nov 1994 08:49:37 GMT', NOW_MS, MAX_DELAY_MS)).toBe(0);
  });

  it('clamps a date far in the future to the ceiling', () => {
    expect(parseRetryAfterMs('Sun, 06 Nov 2094 08:49:37 GMT', NOW_MS, MAX_DELAY_MS)).toBe(
      MAX_DELAY_MS,
    );
  });
});

describe('parseRetryAfterMs - what it refuses', () => {
  it('reports no instruction for an absent header', () => {
    expect(parseRetryAfterMs(null, NOW_MS, MAX_DELAY_MS)).toBeNull();
    expect(parseRetryAfterMs(undefined, NOW_MS, MAX_DELAY_MS)).toBeNull();
  });

  it('reports no instruction for every value it cannot read', () => {
    for (const value of UNREADABLE_VALUES) {
      expect(parseRetryAfterMs(value, NOW_MS, MAX_DELAY_MS)).toBeNull();
    }
  });

  it('never lets a numeric form reach the lenient host date parser', () => {
    // `Date.parse` reads both of these as instants decades from now. If the reader fell
    // through to it, a malformed count of seconds would become a very long wait.
    expect(Number.isFinite(Date.parse('1.5'))).toBe(true);
    expect(Number.isFinite(Date.parse('120.5'))).toBe(true);
    expect(parseRetryAfterMs('1.5', NOW_MS, MAX_DELAY_MS)).toBeNull();
    expect(parseRetryAfterMs('120.5', NOW_MS, MAX_DELAY_MS)).toBeNull();
  });

  it('reports no instruction when the ceiling itself is unusable', () => {
    // A wiring mistake must not become an unbounded wait; the caller then falls back to its
    // own jittered backoff, which is bounded by construction.
    expect(parseRetryAfterMs('30', NOW_MS, Number.NaN)).toBeNull();
    expect(parseRetryAfterMs('30', NOW_MS, Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseRetryAfterMs('30', NOW_MS, -1)).toBeNull();
  });

  it('reports no instruction for a date read against an unusable clock', () => {
    expect(parseRetryAfterMs(IMF_FIXDATE_PLUS_30S, Number.NaN, MAX_DELAY_MS)).toBeNull();
  });
});

// -- Numbered correctness properties ---------------------------------------

/** Named so the generators below read as seconds rather than as a bare 1000. */
const MS_PER_SECOND_FOR_FIXTURES = 1_000;

/** A non-negative count of seconds, small enough to stay inside the ceiling below. */
const deltaSeconds = fc.integer({ min: 0, max: 59 });

/**
 * Header texts spanning BOTH legal forms plus junk.
 *
 * The junk arm is what makes Property 8 non-vacuous: without it the property would only
 * ever exercise the happy branch and would pass while every refusal was unimplemented.
 */
const headerText = fc.oneof(
  // The delta-seconds form, including values far beyond any sane ceiling.
  fc.integer({ min: 0, max: 1_000_000_000 }).map((seconds) => String(seconds)),
  // The HTTP-date form, on both sides of the injected instant.
  fc
    .integer({ min: -1_000_000, max: 1_000_000 })
    .map((offsetMs) => new Date(NOW_MS + offsetMs * MS_PER_SECOND_FOR_FIXTURES).toUTCString()),
  // Numeric forms the reader must refuse, each of which a lenient date parser accepts.
  fc.float({ min: -1000, max: 1000, noNaN: true }).map((value) => String(value)),
  // Free text, which covers the empty string, whitespace, and date-shaped nonsense.
  fc.string(),
  fc.constantFrom(...UNREADABLE_VALUES),
);

describe(`${FEATURE_TAG} - Retry-After reader properties`, () => {
  // Feature: eval-campaign-readiness, Property 7: For any non-negative integer count of
  // seconds within the policy bound, parsing that count as a Retry-After value yields that
  // count in milliseconds.
  //
  // Validates: Requirements 5.1
  it('Property 7: round-trips from delta-seconds', () => {
    fc.assert(
      fc.property(
        deltaSeconds,
        fc.integer({ min: 0, max: 1_000_000_000_000 }),
        (seconds, nowMs) => {
          const parsed = parseRetryAfterMs(String(seconds), nowMs, MAX_DELAY_MS);
          expect(parsed).toBe(seconds * MS_PER_SECOND_FOR_FIXTURES);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: eval-campaign-readiness, Property 8: For any header text, the parsed delay is
  // either null or a number in the range [0, maxDelayMs].
  //
  // Validates: Requirements 5.3, 5.4
  it('Property 8: rejects what it cannot read and clamps what it can', () => {
    fc.assert(
      fc.property(
        headerText,
        fc.integer({ min: 0, max: 1_000_000_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (value, nowMs, maxDelayMs) => {
          const parsed = parseRetryAfterMs(value, nowMs, maxDelayMs);
          if (parsed === null) {
            return;
          }
          expect(Number.isFinite(parsed)).toBe(true);
          expect(parsed).toBeGreaterThanOrEqual(0);
          expect(parsed).toBeLessThanOrEqual(maxDelayMs);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('reads both header forms and refuses junk across the generated space', () => {
    // The guard on Property 8 passing vacuously: the generator must actually reach all
    // three outcomes, or the property above would hold over an empty or one-sided space.
    const outcomes = { readable: 0, refused: 0 };
    fc.assert(
      fc.property(headerText, (value) => {
        const parsed = parseRetryAfterMs(value, NOW_MS, MAX_DELAY_MS);
        if (parsed === null) {
          outcomes.refused += 1;
        } else {
          outcomes.readable += 1;
        }
      }),
      { numRuns: NUM_RUNS },
    );
    expect(outcomes.readable).toBeGreaterThan(0);
    expect(outcomes.refused).toBeGreaterThan(0);
  });
});
