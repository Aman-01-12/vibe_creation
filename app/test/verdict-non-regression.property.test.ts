// instrument-precheck-and-attribution, Property 1: The failure cause never
// moves the verdict (task 1.5).
//
// `interpretSandboxResult` (`app/tools/simulator/adapter.ts`) gained two fields,
// `failureCause` and `attributedFiles`, computed by `classifyRunFailure`
// (`app/tools/simulator/failure-attribution.ts`). The design's own invariant is
// that `classifyVerdict` (`@app/core`) remains the SOLE owner of pass/fail/error,
// and `classifyRunFailure` explains an `error` after the fact - it is never
// consulted to produce the verdict, so adding it can never move a pass/fail
// decision (design "SimulationVerdict delta"; "THIS MODULE DECIDES NO VERDICT" in
// failure-attribution.ts).
//
// This test asserts that invariant directly, rather than trusting the source
// comment: it computes the `verdict` field via a reference path that reproduces
// `interpretSandboxResult`'s pre-attribution logic (the same branches, over the
// same `SandboxResult`) but never calls `classifyRunFailure`, and asserts the two
// agree on every generated input - spanning pass, fail, and every `error` cause
// (timeout, disk cap, truncation, build failure, and unattributed tool failure).
// If `classifyRunFailure`'s result were ever wired into the `verdict` branch
// (for example gating `pass` on `cause === 'none'`), this reference path would
// diverge from `interpretSandboxResult` and the test would fail.
//
// Validates: Requirements 2.10, 8.4

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { classifyVerdict, type InvocationOutcome, type Verdict } from '@app/core';
import { interpretSandboxResult, readCheckSignals, type SandboxResult } from '@app/tools';
import { propertyParameters } from '@app/test';

const PROPERTY =
  'instrument-precheck-and-attribution, Property 1: The failure cause never moves the verdict';

// -- Generators ---------------------------------------------------------------

/** A whitespace-free check-name token, matching the real `CHECK <name> PASS|FAIL` shape. */
const checkTokenArbitrary: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_'.split('')), {
    minLength: 1,
    maxLength: 12,
  })
  .map((chars) => chars.join(''));

/** One `CHECK <name> PASS|FAIL` signalling line the adapter's check reader parses. */
const checkLineArbitrary: fc.Arbitrary<string> = fc
  .record({ name: checkTokenArbitrary, passed: fc.boolean() })
  .map(({ name, passed }) => `CHECK ${name} ${passed ? 'PASS' : 'FAIL'}`);

/** A bare `CHECK` line with no parseable name/status, exercising the unreadable-signal path. */
const unreadableCheckLineArbitrary: fc.Arbitrary<string> = fc.constant('CHECK');

/** A non-signal diagnostic line (newlines stripped so it stays a single stdout line). */
const noiseLineArbitrary: fc.Arbitrary<string> = fc
  .string({ maxLength: 24 })
  .map((line) => line.replace(/\n/g, ' '));

/**
 * Standard output mixing readable checks, unreadable `CHECK` lines, and noise, so
 * `readCheckSignals` reaches every one of its branches (empty, all-pass,
 * some-fail, and unreadable) across the generated space.
 */
const stdoutArbitrary: fc.Arbitrary<string> = fc
  .array(
    fc.oneof(
      { arbitrary: checkLineArbitrary, weight: 4 },
      { arbitrary: unreadableCheckLineArbitrary, weight: 1 },
      { arbitrary: noiseLineArbitrary, weight: 1 },
    ),
    { maxLength: 6 },
  )
  .map((lines) => lines.join('\n'));

/**
 * A build-failure-shaped stderr line naming one of a small closed set of
 * plausible submitted-file basenames, so the generated space includes results
 * that reach `classifyRunFailure`'s `build-failed` branch as well as its
 * `tool-failed` and resource-bound branches.
 */
const stderrArbitrary: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: fc.string({ maxLength: 24 }), weight: 1 },
  {
    arbitrary: fc
      .tuple(fc.constantFrom('adder.v', 'adder_tb.v'), fc.integer({ min: 1, max: 999 }))
      .map(([name, line]) => `${name}:${line}: syntax error`),
    weight: 1,
  },
);

/**
 * The full `SandboxResult` input space: every verdict, every resource-bound and
 * truncation flag, and stdout/stderr shaped to exercise both the check reader and
 * the attribution scan. Every field `interpretSandboxResult` or
 * `classifyRunFailure` reads is generated, never pinned, so neither the verdict
 * branch nor the attribution branch is left untested by this property.
 */
const sandboxResultArbitrary: fc.Arbitrary<SandboxResult> = fc.record({
  verdict: fc.constantFrom('pass', 'fail', 'error'),
  timedOut: fc.boolean(),
  exitCode: fc.option(fc.integer(), { nil: null }),
  stdout: stdoutArbitrary,
  stderr: stderrArbitrary,
  stdoutTruncated: fc.boolean(),
  stderrTruncated: fc.boolean(),
  diskLimitExceeded: fc.boolean(),
  artifacts: fc.constant({}),
  deniedOperations: fc.constant([]),
  resourceUsage: fc.record({
    wallMs: fc.double({ min: 0, max: 60_000, noNaN: true }),
    maxMemMb: fc.double({ min: 0, max: 4096, noNaN: true }),
    cpuMs: fc.double({ min: 0, max: 60_000, noNaN: true }),
  }),
});

/**
 * The reference verdict computation: `interpretSandboxResult`'s pre-attribution
 * branches, reproduced independently of `classifyRunFailure`.
 *
 * This mirrors the adapter's own logic (a `result.verdict === 'error'` short
 * circuit, otherwise `classifyVerdict` over an `InvocationOutcome` built from the
 * parsed check signalling) without ever importing or calling
 * `classifyRunFailure`. `failureCause` and `attributedFiles` play no part in this
 * function, by construction - so if the adapter's verdict computation ever came
 * to depend on the attribution result, this reference path would diverge from
 * `interpretSandboxResult` and the property below would catch it.
 */
function referenceVerdict(result: SandboxResult): Verdict {
  if (result.verdict === 'error') {
    return 'error';
  }
  const reading = readCheckSignals(result.stdout);
  const outcome: InvocationOutcome = {
    timedOut: false,
    toolFailure: false,
    completed: true,
    checks: reading.checks,
    unreadableCheckSignals: reading.unreadableSignals,
    diskLimitExceeded: result.diskLimitExceeded,
    stdoutTruncated: result.stdoutTruncated,
  };
  return classifyVerdict(outcome);
}

// -- Property 1 -----------------------------------------------------------------

describe(PROPERTY, () => {
  it('reports the same verdict as the attribution-free reference computation, for every submittedPaths list', () => {
    fc.assert(
      fc.property(
        sandboxResultArbitrary,
        fc.array(fc.string({ minLength: 1, maxLength: 16 }), { maxLength: 4 }),
        (result, submittedPaths) => {
          const verdict = interpretSandboxResult(result, submittedPaths).verdict;

          // Adding failureCause/attributedFiles to the pipeline never changes what
          // verdict is reported, whatever submittedPaths (and therefore whatever
          // classifyRunFailure decides) is passed alongside it.
          expect(verdict).toBe(referenceVerdict(result));
        },
      ),
      propertyParameters(),
    );
  });

  it('reports the same verdict for a given SandboxResult regardless of which submittedPaths accompany it', () => {
    fc.assert(
      fc.property(
        sandboxResultArbitrary,
        fc.array(fc.string({ minLength: 1, maxLength: 16 }), { maxLength: 4 }),
        fc.array(fc.string({ minLength: 1, maxLength: 16 }), { maxLength: 4 }),
        (result, submittedPathsA, submittedPathsB) => {
          // Two different submittedPaths lists can make classifyRunFailure report
          // different attribution (or none), but the reported verdict must be
          // identical either way - the attribution result is read for its OWN
          // field, never for the verdict.
          const verdictA = interpretSandboxResult(result, submittedPathsA).verdict;
          const verdictB = interpretSandboxResult(result, submittedPathsB).verdict;

          expect(verdictA).toBe(verdictB);
        },
      ),
      propertyParameters(),
    );
  });
});
