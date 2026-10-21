// structural-gate-toolchain, Property 1: The Lint_Result decision table (task 4.5; Req 5.1 to
// 5.5).
//
// THE ORACLE IS INDEPENDENT OF THE CODE UNDER TEST
//   `expectedResult` restates design.md's decision table directly from the draw inputs - the
//   verdict, whether the report text is `null`, and the report's own shape - without parsing
//   JSON through the adapter's own machinery or calling `interpretLintResult`. It re-derives
//   `could-not-run` / `clean` / `findings` from the raw draw, so the property is a real check of
//   `interpretLintResult` and not a restatement of its own parsing.
//
// WHAT A SAMPLED DRAW WOULD MISS, PINNED BY CONSTRUCTION (per the task's own draw list)
//   - `reachedCheck: true` with `problemCount` exactly 0: the clean/findings boundary, low side.
//   - `reachedCheck: true` with `problemCount` exactly 1: the clean/findings boundary, high side.
//   - A report with one key beyond `{reachedCheck, problemCount}`: the closed-shape refusal.
//   - `problemCount: -1` (negative) and `problemCount: 1.5` (non-integer): both well-typed
//     numbers that are not "reportable", so they must still refuse rather than report.
//
// Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Verdict } from '@app/core';
import { interpretLintResult, LINT_RESULT_REASONS, type SandboxResult } from '@app/tools';

import { propertyParameters } from './property.js';

const PROPERTY = 'structural-gate-toolchain, Property 1: The Lint_Result decision table';

const RESOURCE_USAGE = { wallMs: 20, maxMemMb: 16, cpuMs: 18 };

/** A full `SandboxResult`, defaulting every field `interpretLintResult` does not read. */
function buildResult(verdict: Verdict): SandboxResult {
  return {
    verdict,
    timedOut: false,
    exitCode: verdict === 'error' ? 1 : 0,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts: {},
    deniedOperations: [],
    resourceUsage: RESOURCE_USAGE,
  };
}

/**
 * One drawn report shape: either absent text (`null`), text that is not well-formed JSON, or a
 * well-formed-JSON document described by its own fields, independent of the adapter's parser.
 */
type ReportDraw =
  | { readonly form: 'null-text' }
  | { readonly form: 'unparseable' }
  | {
      readonly form: 'document';
      readonly reachedCheck: boolean;
      readonly problemCount: number | null;
      readonly extraKey: boolean;
    };

/** Render a `ReportDraw` to the `reportText` argument `interpretLintResult` takes. */
function renderReportText(draw: ReportDraw): string | null {
  if (draw.form === 'null-text') {
    return null;
  }
  if (draw.form === 'unparseable') {
    return '{not: json,,,';
  }
  const body: Record<string, unknown> = {
    reachedCheck: draw.reachedCheck,
    problemCount: draw.problemCount,
  };
  if (draw.extraKey) {
    body.extra = 'unexpected';
  }
  return JSON.stringify(body);
}

/** Whether a drawn document's `problemCount` is a value `interpretLintResult` will report. */
function isReportableProblemCount(value: number | null): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * design.md's own rule, restated from the draw's facts directly rather than by parsing JSON or
 * calling `interpretLintResult`: `error` or absent/unparseable text is `could-not-run`; a
 * document with an extra key, a non-boolean-shaped `reachedCheck` (not applicable here, since the
 * draw only ever produces a boolean), or `reachedCheck: false` is `could-not-run`; `reachedCheck:
 * true` with a reportable `problemCount` of 0 is `clean`, and 1 or more is `findings`.
 */
function expectedKind(verdict: Verdict, draw: ReportDraw): 'clean' | 'findings' | 'could-not-run' {
  if (verdict === 'error' || draw.form === 'null-text' || draw.form === 'unparseable') {
    return 'could-not-run';
  }
  if (draw.extraKey || !draw.reachedCheck) {
    return 'could-not-run';
  }
  if (!isReportableProblemCount(draw.problemCount)) {
    return 'could-not-run';
  }
  return draw.problemCount === 0 ? 'clean' : 'findings';
}

/** A `fc.Arbitrary` for a well-formed-shaped document draw: a `reachedCheck` and matching count. */
function arbDocumentDraw(): fc.Arbitrary<ReportDraw> {
  return fc.boolean().chain((reachedCheck) =>
    fc.record({
      form: fc.constant('document' as const),
      reachedCheck: fc.constant(reachedCheck),
      problemCount: reachedCheck
        ? fc.oneof(
            fc.nat({ max: 10_000 }),
            fc.integer({ min: -1000, max: -1 }),
            fc.double({ min: -1000, max: 1000, noNaN: true }).filter((n) => !Number.isInteger(n)),
          )
        : fc.constant(null),
      extraKey: fc.boolean(),
    }),
  );
}

/** Every drawable `ReportDraw` shape: absent text, unparseable text, or a document. */
function arbReportDraw(): fc.Arbitrary<ReportDraw> {
  return fc.oneof(
    fc.constant<ReportDraw>({ form: 'null-text' }),
    fc.constant<ReportDraw>({ form: 'unparseable' }),
    arbDocumentDraw(),
  );
}

describe(PROPERTY, () => {
  it('matches the independent oracle for any verdict and report draw', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Verdict>('pass', 'fail', 'error'),
        arbReportDraw(),
        (verdict, draw) => {
          const result = interpretLintResult(buildResult(verdict), renderReportText(draw));
          expect(result.kind).toBe(expectedKind(verdict, draw));
          expect(result.reason).toBe(LINT_RESULT_REASONS[result.kind]);
          if (result.kind === 'findings' && draw.form === 'document') {
            expect(result.problemCount).toBe(draw.problemCount);
          }
        },
      ),
      propertyParameters(),
    );
  });

  it('is clean at problemCount exactly 0 and findings at exactly 1 (the clean/findings boundary)', () => {
    const clean = interpretLintResult(
      buildResult('pass'),
      JSON.stringify({ reachedCheck: true, problemCount: 0 }),
    );
    expect(clean).toEqual({ kind: 'clean', reason: LINT_RESULT_REASONS.clean });

    const findings = interpretLintResult(
      buildResult('pass'),
      JSON.stringify({ reachedCheck: true, problemCount: 1 }),
    );
    expect(findings).toEqual({
      kind: 'findings',
      problemCount: 1,
      reason: LINT_RESULT_REASONS.findings,
    });
  });

  it('is could-not-run on a report carrying one key beyond reachedCheck and problemCount', () => {
    const text = JSON.stringify({ reachedCheck: true, problemCount: 0, extra: 'nope' });
    expect(interpretLintResult(buildResult('pass'), text).kind).toBe('could-not-run');
  });

  it('is could-not-run on a negative problemCount', () => {
    const text = JSON.stringify({ reachedCheck: true, problemCount: -1 });
    expect(interpretLintResult(buildResult('pass'), text).kind).toBe('could-not-run');
  });

  it('is could-not-run on a non-integer problemCount', () => {
    const text = JSON.stringify({ reachedCheck: true, problemCount: 1.5 });
    expect(interpretLintResult(buildResult('pass'), text).kind).toBe('could-not-run');
  });
});
