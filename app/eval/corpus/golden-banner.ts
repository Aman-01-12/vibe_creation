// Reading RTLLM's VCS-style outcome BANNERS out of a golden simulation's stdout.
//
// WHY THIS IS A SEPARATE PARSER FROM `readCheckSignals`
//   Our own spec-derived testbenches emit one machine-readable
//   `CHECK <name> PASS|FAIL` line per acceptance criterion, and
//   `@app/tools`'s `readCheckSignals` reads exactly that. RTLLM's testbenches
//   predate us and were written for Synopsys VCS: they signal the whole-design
//   outcome with a printed banner and nothing per-check. Rewriting 50 golden
//   testbenches into our CHECK format would edit the independent judge, and the
//   independence is the entire reason the judge is worth having - a judge we
//   rewrote could not falsify our own testbench. So the golden testbenches stay
//   byte-identical and this parser learns their vocabulary instead.
//
// THE BANNER GRAMMAR (as it appears at the pinned commit)
//   Every authoritative line is fenced by a run of `=` on both sides:
//       ===========Your Design Passed===========
//       ===========Error===========
//       ===========Failed===========
//       =========== Test completed with %d /100 failures ===========
//   Inner spacing varies design to design, `%d` pads with spaces, and the
//   denominator is sometimes absent or phrased differently
//   (`%0d/16 NUM_DIV cases failing`). The `=` fence is what makes a line
//   authoritative: the same testbenches also print unfenced diagnostics such as
//   `$display("Test failed: a = %b ...")`, and treating one of those as a verdict
//   would fail a design on a per-case note it prints on the way to passing.
//
// VERDICT MAPPING (a deliberate, documented translation)
//   RTLLM's `Error` banner means THE DESIGN PRODUCED WRONG RESULTS - it is on the
//   `else` branch of the testbench's own comparison. It is NOT an infrastructure
//   error. So it maps to our `failed`, not to our `error`. Our `error` is reserved
//   for a run that verified NOTHING: no banner reached stdout at all, because the
//   candidate failed to compile, crashed, or was killed. That reservation is
//   fail-safe: an unparseable run can never read as a pass.

/** RTLLM's banner-signalled outcome, in our vocabulary. */
export type GoldenVerdictKind =
  /** The golden testbench printed its pass banner and no failure/error banner. */
  | 'passed'
  /** The golden testbench reported wrong results (`Error`, `Failed`, or a failure count). */
  | 'failed'
  /** No banner was printed: the run verified nothing (compile failure, crash, timeout). */
  | 'error';

/** The independent judge's verdict on one candidate. */
export interface GoldenVerdict {
  readonly kind: GoldenVerdictKind;
  /** Failures the banner reported, or `null` when no banner carried a count. */
  readonly failureCount: number | null;
  /** The fenced banner texts observed, normalized, in printed order (diagnostics). */
  readonly banners: readonly string[];
}

/** Matches a fenced banner line and captures its inner text. */
const FENCED_BANNER = /^={3,}(.*?)={3,}$/;

/** The pass banner's inner text, normalized. */
const PASS_BANNER = 'your design passed';

/** Inner texts that state a wrong-results outcome without a count. */
const FAILURE_BANNERS: readonly string[] = Object.freeze(['error', 'failed']);

/**
 * Matches the counted failure banner and captures the count.
 *
 * `%d` right-pads within a fixed field, so arbitrary whitespace may sit between
 * `with` and the number; the denominator (`/100`, `/16 NUM_DIV cases`) is optional
 * and deliberately not captured, because it is presentation, not signal.
 */
const COUNTED_FAILURE_BANNER = /^test completed with\s+(\d+)\b/;

/** Longest stdout this parser will scan; bounds work on untrusted tool output. */
const MAX_STDOUT_CHARS = 2_000_000;

/** Most banners retained for diagnostics; a runaway testbench cannot flood the report. */
const MAX_RETAINED_BANNERS = 16;

/** Collapse whitespace and lowercase, so banner spacing variants compare equal. */
function normalizeBannerText(inner: string): string {
  return inner.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The fenced banner texts printed by a golden run, normalized and in order.
 *
 * Unfenced lines are ignored, so the testbench stays free to print per-case
 * diagnostics alongside its verdict.
 */
export function extractGoldenBanners(stdout: string): readonly string[] {
  const banners: string[] = [];
  for (const rawLine of stdout.slice(0, MAX_STDOUT_CHARS).split('\n')) {
    const match = FENCED_BANNER.exec(rawLine.trim());
    if (match === null) {
      continue;
    }
    const text = normalizeBannerText(match[1] ?? '');
    if (text.length > 0 && banners.length < MAX_RETAINED_BANNERS) {
      banners.push(text);
    }
  }
  return banners;
}

/** The count a counted-failure banner reported, or `null` when it is not one. */
function countedFailure(banner: string): number | null {
  const match = COUNTED_FAILURE_BANNER.exec(banner);
  if (match === null) {
    return null;
  }
  const parsed = Number.parseInt(match[1] ?? '', 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Whether a banner states a wrong-results outcome. */
function isFailureBanner(banner: string): boolean {
  return FAILURE_BANNERS.includes(banner) || COUNTED_FAILURE_BANNER.test(banner);
}

/** The first failure count any banner reported, or `null` when none carried one. */
function firstFailureCount(banners: readonly string[]): number | null {
  for (const banner of banners) {
    const count = countedFailure(banner);
    if (count !== null) {
      return count;
    }
  }
  return null;
}

/**
 * Parse a golden run's stdout into the independent judge's verdict.
 *
 * Precedence is fail-safe and requires positive evidence to pass:
 *   1. no fenced banner at all -> `error` (the run verified nothing);
 *   2. any failure banner (`Error`, `Failed`, or a counted-failure banner)
 *      -> `failed`, even if a pass banner also appeared, because a testbench that
 *      says both has contradicted itself and must not be read as a pass;
 *   3. the pass banner and nothing contradicting it -> `passed`;
 *   4. only banners this grammar does not recognize -> `error`, never a pass.
 */
export function parseGoldenVerdict(stdout: string): GoldenVerdict {
  const banners = extractGoldenBanners(stdout);
  if (banners.length === 0) {
    return { kind: 'error', failureCount: null, banners };
  }
  if (banners.some(isFailureBanner)) {
    return { kind: 'failed', failureCount: firstFailureCount(banners), banners };
  }
  if (banners.includes(PASS_BANNER)) {
    return { kind: 'passed', failureCount: 0, banners };
  }
  return { kind: 'error', failureCount: null, banners };
}
