// instrument-precheck-and-attribution, Property 9: A refused outcome surrenders its
// candidate (task 7.2).
//
// WHAT THIS PINS DOWN
//   An `instrument-refused` outcome is reached BEFORE any oracle verdict (Req 5.4), so
//   the only evidence it can hand downstream is the candidate and the Testbench
//   Loop_Setup already produced (Req 5.1, 5.2). Two consumers need that candidate: the
//   Artifact_Sink (Req 5.5) and the Golden_Judge (Req 5.6). Both read it through the
//   SAME function - `harness.ts#judgeIndependently` calls `candidateRtlOf(outcome)`
//   directly to build its `GoldenJudgeRequest`, exactly as `captureSampleArtifacts`
//   does - so there is no second read path to diverge from `candidateRtlOf`'s result;
//   asserting that `candidateRtlOf` (and `testbenchSourceOf`) always echoes the
//   generated candidate's/testbench's field back, and never reports `null` for this
//   status, covers both consumers at once, and is the "never absent" claim the design
//   states directly.
//
// WHY THIS LIVES IN app/test, NOT app/eval
//   Same reach as task 7.3's Property 12 test: `candidateRtlOf`/`testbenchSourceOf` are
//   `@app/eval`'s own pure functions, but the shared property-test harness
//   (`propertyParameters`) lives in `@app/test`, and the import-boundary gate forbids
//   `eval` from importing `test` (see
//   chipAgent/_inbox/eval-harness-integration-needs-test-to-eval-boundary.md).
//
// WHY NOT propertyTag
//   `app/test/property.ts`'s `propertyTag` hardcodes its feature slug to
//   `hdl-creation-loop`'s own numbering; this spec's Property 9 has no relation to that
//   feature's Property 9. The tag below is a literal string instead (see
//   chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md).
//   `propertyParameters()` is still used, since the iteration-count convention is shared.
//
// Structural precedent: `app/test/artifact-sink-bounded-capture.property.test.ts`'s
// `instrumentRefusedOutcome` fixture builder (cast through `unknown`, only the fields
// the functions under test actually read).
//
// Validates: Requirements 5.1, 5.2, 5.5, 5.6

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { VerificationOutcome } from '@app/agent';
import { candidateRtlOf, testbenchSourceOf } from '@app/eval';
import { propertyParameters } from '@app/test';

const PROPERTY =
  'instrument-precheck-and-attribution, Property 9: A refused outcome surrenders its candidate';

/**
 * An `instrument-refused` outcome carrying the given candidate RTL and testbench
 * source. Cast through `unknown`, the same way task 7.3's fixture builder is: only the
 * fields `candidateRtlOf`/`testbenchSourceOf` actually read are supplied, because the
 * real outcome also carries a `reason`, an `Unverified` label, and `attributedFiles`
 * this test neither builds nor asserts on.
 */
function instrumentRefusedOutcome(
  candidateRtl: string,
  testbenchSource: string,
): VerificationOutcome {
  return {
    status: 'instrument-refused',
    reason: 'testbench-build-failed',
    candidate: { rtl: candidateRtl },
    testbench: { source: testbenchSource },
    attributedFiles: [],
  } as unknown as VerificationOutcome;
}

/** Non-empty RTL/testbench source text: `nonEmptyStringAt` treats `''` as absent. */
const nonEmptySourceArbitrary: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 200 })
  .filter((text) => text.length > 0);

describe(PROPERTY, () => {
  it('echoes the carried candidate RTL back, never absent, for any instrument-refused outcome', () => {
    fc.assert(
      fc.property(
        nonEmptySourceArbitrary,
        nonEmptySourceArbitrary,
        (candidateRtl, testbenchSource) => {
          const outcome = instrumentRefusedOutcome(candidateRtl, testbenchSource);

          const rtl = candidateRtlOf(outcome);
          expect(rtl).not.toBeNull();
          expect(rtl).toBe(candidateRtl);
        },
      ),
      propertyParameters(),
    );
  });

  it('echoes the carried testbench source back exactly, for any instrument-refused outcome', () => {
    fc.assert(
      fc.property(
        nonEmptySourceArbitrary,
        nonEmptySourceArbitrary,
        (candidateRtl, testbenchSource) => {
          const outcome = instrumentRefusedOutcome(candidateRtl, testbenchSource);

          expect(testbenchSourceOf(outcome)).toBe(testbenchSource);
        },
      ),
      propertyParameters(),
    );
  });

  it('agrees with itself across repeated reads, so the Artifact_Sink and the Golden_Judge can never diverge', () => {
    // The design states this as two consumers reading the "same" value. In this
    // codebase that identity is structural, not coincidental: `harness.ts`'s
    // `#judgeIndependently` (the Golden_Judge's request builder) and
    // `captureSampleArtifacts` (the Artifact_Sink) both call `candidateRtlOf(outcome)`
    // directly - there is one function, not two paths that happen to agree. This
    // pins the property that matters regardless of how many call sites exist: the
    // function is pure and total, so calling it twice on the same outcome can never
    // produce two different candidates.
    fc.assert(
      fc.property(
        nonEmptySourceArbitrary,
        nonEmptySourceArbitrary,
        (candidateRtl, testbenchSource) => {
          const outcome = instrumentRefusedOutcome(candidateRtl, testbenchSource);

          expect(candidateRtlOf(outcome)).toBe(candidateRtlOf(outcome));
          expect(testbenchSourceOf(outcome)).toBe(testbenchSourceOf(outcome));
        },
      ),
      propertyParameters(),
    );
  });
});
