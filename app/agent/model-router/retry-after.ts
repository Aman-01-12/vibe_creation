// The `Retry-After` boundary parser: one untrusted header value in, one bounded delay out.
//
// WHY THIS IS ITS OWN MODULE
//   A throttling host tells us how long to wait, and the honest thing is to wait that long
//   rather than a schedule we invented. But the instruction arrives as caller-uncontrolled
//   TEXT from a remote host, in two different grammars, and it decides how long a campaign
//   sits idle. That is a trust boundary, so it gets a module whose whole job is to convert
//   the text into a bounded number and refuse everything else.
//
// WHAT CROSSES THE BOUNDARY
//   Exactly one non-negative number of milliseconds, or `null` for "the host gave no
//   instruction we can read". No header text, no `Date`, no parsed intermediate. That is
//   what lets the HTTP port carry this value upward without carrying a header map, which
//   would put credential-adjacent and fingerprintable material past a boundary whose whole
//   job is to let nothing about the call escape.
//
// WHY IT IS CLAMPED
//   The value is untrusted. A hostile or misconfigured host that answered
//   `Retry-After: 86400` would otherwise park an overnight campaign for a day, which is a
//   denial of service delivered through a header we chose to obey. The caller names the
//   ceiling - a caller holding a retry policy passes that policy's maximum delay - and no
//   reported delay can exceed it.
//
// TOTAL, PURE, CLOCK-INJECTED
//   Never throws, reads no global clock, and holds no state. The HTTP-date form needs the
//   current instant to compute a remaining duration, so the instant is a parameter; that is
//   also what makes both forms testable with no real time.

/** Milliseconds in one second; the delta-seconds form's only conversion. */
const MS_PER_SECOND = 1_000;

/**
 * The delta-seconds form: a count of WHOLE seconds and nothing else.
 *
 * Anchored and digits-only on purpose. A leading sign, a decimal point, an exponent, or
 * surrounding junk is not this form, and is not quietly coerced into it.
 */
const DELTA_SECONDS = /^\d+$/;

/**
 * Any ASCII letter, which is the gate on the HTTP-date branch.
 *
 * Every legal HTTP-date form (IMF-fixdate, RFC 850, and asctime) names a month, so a date
 * always contains letters and a numeric form never does. The gate is load-bearing rather
 * than cosmetic: the host date parser is lenient enough to read `1.5` and `120` as DATES,
 * so handing it a numeric value that failed the delta-seconds test would turn a malformed
 * count of seconds into a wait of decades. Requiring a letter makes that unreachable.
 */
const CONTAINS_LETTER = /[A-Za-z]/;

/**
 * An explicit time zone at the end of an HTTP-date: the literal `GMT` or `UTC`, or a
 * numeric offset such as `+0000`.
 *
 * Required, and load-bearing. Every legal HTTP-date form (RFC 7231 IMF-fixdate and the
 * obsolete RFC 850 and asctime forms it also accepts) is expressed in GMT, so a value with
 * no zone is not a legal HTTP-date at all. It matters beyond pedantry because `Date.parse`
 * reads a zone-less date in the HOST's local time: the same header would then resolve to a
 * different instant on every machine, and on a UTC host `Sun, 06 Nov 1994 08:49:37` (no
 * zone) is a real instant the parser would otherwise obey. Refusing it keeps the reader's
 * output independent of where it runs.
 */
const ENDS_WITH_TIME_ZONE = /(?:GMT|UTC?|[+-]\d{4})$/;

/**
 * The delta-seconds value in milliseconds; `text` must already be digits-only.
 *
 * An absurd count overflows to `Infinity` rather than becoming a negative or a `NaN`, and
 * the caller's clamp turns that into the ceiling - which is the honest reading of "the host
 * asked for longer than we are willing to wait".
 */
function deltaSecondsMs(text: string): number {
  return Number(text) * MS_PER_SECOND;
}

/**
 * The milliseconds remaining until an HTTP-date, or `null` when there is no such instant.
 *
 * A duration that has already elapsed reports no instruction rather than a negative wait:
 * the host's deadline has passed, so it is our own backoff that decides from here.
 */
function httpDateMs(text: string, nowMs: number): number | null {
  if (!CONTAINS_LETTER.test(text) || !ENDS_WITH_TIME_ZONE.test(text) || !Number.isFinite(nowMs)) {
    return null;
  }
  const instantMs = Date.parse(text);
  if (!Number.isFinite(instantMs)) {
    return null;
  }
  const remainingMs = instantMs - nowMs;
  return remainingMs < 0 ? null : remainingMs;
}

/**
 * Parse a `Retry-After` header value into a bounded delay in milliseconds.
 *
 * Handles both header forms: an integer count of seconds, and an HTTP-date whose remaining
 * time is measured against `nowMs`. Reports `null` - "no instruction" - for an absent,
 * empty, non-integer, negative, unparseable, or already-elapsed value, and for a ceiling
 * that is not a usable bound. A value it can read is clamped to `maxDelayMs`.
 *
 * Zero is a REAL answer and is distinct from `null`: a host may legitimately say "now"
 * while still refusing, which is why the caller treats this as a floor rather than as an
 * override of its own backoff.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  nowMs: number,
  maxDelayMs: number,
): number | null {
  // An unusable ceiling cannot bound anything, so no instruction can be honoured under it.
  // Reporting none is the safe direction: the caller falls back to its own jittered backoff
  // rather than to an unbounded wait.
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
    return null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.trim();
  if (text.length === 0) {
    return null;
  }
  const delayMs = DELTA_SECONDS.test(text) ? deltaSecondsMs(text) : httpDateMs(text, nowMs);
  return delayMs === null ? null : Math.min(maxDelayMs, delayMs);
}
