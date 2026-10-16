// The regression guard for ONE measured defect: `sanitizeDiagnostic` used to apply its three
// redactions to the WHOLE raw string and only then apply `MAX_DIAGNOSTIC_CHARS`, so an unbroken
// whitespace-free tail cost QUADRATIC time at a trust boundary
// (`chipAgent/_inbox/gotcha-sanitizediagnostic-redacts-before-bounding-so-a-long-unbroken-tail-is-quadratic.md`).
//
// WHY THIS IS A SECURITY TEST AND NOT A BENCHMARK
//   On the no-report path the sanitized text is `result.stderr`, capped by the worker at
//   `MAX_CAPTURED_STDERR_BYTES = 262_144`. Two of the three patterns are greedy ahead of a required
//   literal (`\S+` before `@`, `[A-Za-z0-9+.-]*` before `://`), which restarts at every offset on
//   text lacking that literal: a measured 813ms for ONE call at 16000 characters, which puts the
//   worker's cap at about 218 SECONDS of synchronous CPU on a single-threaded event loop, from
//   untrusted tool output. A long base64 blob, or one unbroken line echoing model-written source,
//   was enough. The fix bounds the INPUT before any regex sees it.
//
// WHAT IS ASSERTED, AND WHY EACH ASSERTION IS THE ONE THAT CATCHES THE REGRESSION
//   1. COST. One call on an unbroken stderr completes inside a budget two orders of magnitude below
//      the measured quadratic cost and two above the measured bounded one, so it fails on the
//      quadratic shape returning by ANY route and not only by the bound moving back.
//   2. SHAPE, deterministically. A wholly unbroken over-bound tail surfaces as NOTHING, because the
//      bound now lands on a whitespace boundary and there is none. Move the bound back below the
//      redactions and this same input surfaces 2000 characters instead - so this assertion pins the
//      ORDER with no clock in it at all, which is the guard a timing budget cannot be.
//   3. NOT WEAKENED. Bounding the input first must not cost a redaction. A URL positioned so the
//      bound falls INSIDE its host is the case a blind `slice(-MAX)` was measured to leak
//      (`internal.example.test<path>`, the scheme cut away so the pattern no longer matched), and
//      the host shapes the property tests plant must still be redacted whole (Req 8.5, 11.6), under
//      the bound Req 8.4 asks for.

import { describe, expect, it } from 'vitest';

import {
  interpretFormalReport,
  MAX_DIAGNOSTIC_CHARS,
  validateExpression,
  type FormalProperty,
  type FormalRunContext,
  type SandboxResult,
  type ValidatedExpression,
} from '@app/tools';

/** One accepted expression, or a loud failure: an unvalidated string cannot build a property. */
function expression(text: string): ValidatedExpression {
  const validated = validateExpression(text);
  if (!validated.ok) {
    throw new Error(`test expression rejected: ${validated.error.reason}`);
  }
  return validated.value;
}

const PROPERTY: FormalProperty = {
  kind: 'combinational',
  id: 'p1',
  criterionRef: '1.1',
  consequent: expression('out == a + b'),
};

const RUN: FormalRunContext = {
  depth: 20,
  elapsedMs: 5,
  designFileName: 'design.v',
  wrapperFileName: 'wrapper.v',
};

/**
 * The length of the unbroken run the cost is measured on.
 *
 * NOT the worker's 262_144-byte cap, deliberately. The cost is quadratic when it regresses, so the
 * cap would take the measured 218 seconds - and synchronously, which vitest's own `testTimeout`
 * cannot interrupt, so a regression would HANG the suite rather than fail it
 * (`chipAgent/_inbox/gotcha-shared-global-regex-lastindex-infinite-loop.md` is the same failure
 * mode). At 16000 the quadratic shape costs a measured 813ms: still 60x over the bounded cost, so it
 * is caught, and it fails in under a second. The real cap is 16x longer, which on that curve is 256x
 * this cost.
 */
const UNBROKEN_RUN_CHARS = 16_000;

/**
 * The budget for ONE `interpretFormalReport` call on that run, in milliseconds.
 *
 * Set from both measured costs rather than from taste. Bounded, this input surfaces nothing and
 * costs 0.01ms; the worst input the bound still admits - a whitespace followed by a 2000-character
 * run - costs a measured 13ms. Quadratic, the same input costs a measured 813ms. 250ms therefore
 * sits roughly 20x above the worst legitimate cost, which absorbs a shared or throttled runner, and
 * roughly 3x below the defect it is here to catch. The signal is a 60x margin between those two, not
 * a few percent, so a wall clock is a fair instrument for it.
 */
const COST_BUDGET_MS = 250;

/** A completed run carrying the captured stderr this case is about, and no report artifact. */
function sandboxResult(stderr: string): SandboxResult {
  return {
    verdict: 'fail',
    timedOut: false,
    exitCode: 1,
    stdout: '',
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts: {},
    deniedOperations: [],
    resourceUsage: { wallMs: 10, maxMemMb: 1, cpuMs: 10 },
  };
}

/** The surfaced diagnostic for one captured stderr, read off the no-report path (Req 11.8). */
function diagnosticFor(stderr: string): string | null {
  const result = interpretFormalReport(sandboxResult(stderr), null, PROPERTY, RUN);
  return result.verdict === 'could-not-verify' ? result.diagnostic : null;
}

/** A host name planted in a diagnostic. It is the token asserted absent, never a restated pattern. */
const PLANTED_HOST = 'internal.example.test';
const PLANTED_URL = `https://build-07.${PLANTED_HOST}/jobs/42`;

/** A realistic Yosys line, line-broken, naming no host, no path, and neither submitted file. */
const FILLER_LINE = 'ERROR: unmapped cell $check$1 in the lowered model\n';

/**
 * A diagnostic whose URL crosses the bound exactly at its HOST, which is the leak case.
 *
 * The trailing length is derived rather than written down: with this many characters after the URL,
 * a blind `slice(-MAX_DIAGNOSTIC_CHARS)` opens on the host's first character, so the surviving suffix
 * carries the whole planted host with no scheme in front of it and no pattern matches it. The
 * trailing text is LINE-BROKEN so the surfaced diagnostic is non-empty either way - a case that
 * passed only because nothing was surfaced would assert nothing.
 */
function urlStraddlingTheBound(): string {
  const afterHostStart = PLANTED_URL.length - PLANTED_URL.indexOf(PLANTED_HOST);
  const trailing = `\n${FILLER_LINE.repeat(40)}`.slice(0, MAX_DIAGNOSTIC_CHARS - afterHostStart);
  return `ERROR: lowering aborted\n${PLANTED_URL}${trailing}`;
}

describe('an untrusted diagnostic is bounded before it is redacted', () => {
  it('sanitizes an unbroken whitespace-free tail in bounded time', () => {
    const started = performance.now();
    diagnosticFor('e'.repeat(UNBROKEN_RUN_CHARS));
    expect(performance.now() - started).toBeLessThan(COST_BUDGET_MS);
  });

  it('surfaces nothing for a tail that is one unbroken run, rather than a bounded blob', () => {
    // The ORDER pin: redacting first would surface exactly MAX_DIAGNOSTIC_CHARS characters here.
    expect(diagnosticFor('e'.repeat(UNBROKEN_RUN_CHARS))).toBeNull();
    // A tail one character over the bound is the same case, and the case the bound exists for.
    expect(diagnosticFor('e'.repeat(MAX_DIAGNOSTIC_CHARS + 1))).toBeNull();
  });

  it('keeps the tail whole when it fits, so bounding costs nothing under the bound', () => {
    const fits = 'ERROR: syntax error near token endmodule in design.v:41';
    expect(diagnosticFor(fits)).toBe(fits);
  });
});

describe('bounding first costs no redaction', () => {
  it('redacts a host whose URL straddles the bound, instead of surfacing its suffix', () => {
    const surfaced = diagnosticFor(urlStraddlingTheBound()) ?? '';
    expect(surfaced).not.toContain(PLANTED_HOST);
    // Non-vacuity: the diagnostic still carries its readable tail, so the absence above is a
    // redaction rather than an empty string.
    expect(surfaced).toContain('unmapped cell');
    expect(surfaced.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CHARS);
  });

  it('still redacts the URL, user@host, and absolute-path shapes whole', () => {
    expect(diagnosticFor(`see ${PLANTED_URL} for the full log`)).toBe(
      'see <host> for the full log',
    );
    expect(diagnosticFor(`reported by runner@build-07.${PLANTED_HOST}`)).toBe('reported by <host>');
    expect(diagnosticFor('while reading /var/lib/formal-runner/ws-8f21/top.sv')).toBe(
      'while reading <path>',
    );
  });

  it('holds the bound on a path-dense window, which redaction makes LONGER', () => {
    // `/a` is two characters and `<path>` is six, so the output bound is not implied by the input
    // one. Line-broken, so the tokens survive the whitespace-aligned cut.
    const pathDense = Array.from({ length: 900 }, () => '/a').join('\n');
    const surfaced = diagnosticFor(pathDense) ?? '';
    expect(surfaced.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CHARS);
    expect(surfaced).toContain('<path>');
  });
});
