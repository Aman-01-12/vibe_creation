// instrument-precheck-and-attribution, Property 12: The capture derives exactly
// what the outcome carries, bounded (task 7.3).
//
// WHAT THIS PINS DOWN
//   `captureSampleArtifacts` reads four fields straight off a terminal outcome that a
//   status added by this spec newly carries: the rejected testbench draft
//   (`rejectedTestbenchDraft`), the unmet required-check names (`missingCheckNames` +
//   `missingCheckNamesTruncated`), the run failure cause (`runFailureCause`), and the
//   attributed files (`attributedFiles`). Req 6.6 makes the negative space the point:
//   an outcome that does not carry one of these fields must yield an ABSENT artifact
//   field, never a blank string, an empty-but-present list standing in for "unset", or
//   a fabricated value borrowed from elsewhere on the outcome.
//
//   This property generates both directions for the two capped fields:
//     - `setup-failed` outcomes with a `rejectedTestbench` source spanning
//       `ARTIFACT_CAPS.maxRejectedDraftChars` (below, at, and above), asserting the
//       capture keeps the HEAD and flags truncation exactly when the source exceeded
//       the cap (Req 6.3).
//     - `setup-failed` outcomes with a `missingCheckNames` list spanning
//       `ARTIFACT_CAPS.maxMissingCheckNames`, and per-name text spanning
//       `ARTIFACT_CAPS.maxCheckNameChars`, asserting both caps are enforced
//       independently and the truncation flag reflects only the list-length cut
//       (Req 6.4).
//   and the absent direction (Req 6.6):
//     - a `setup-failed` outcome whose `cause` is not a coverage gap (no
//       `rejectedTestbench` / `missingCheckNames` fields at all).
//     - an `instrument-refused` outcome, which never carries a rejected draft or
//       missing check names but DOES carry `attributedFiles` and (via Req 5.4 - it is
//       reached before any oracle verdict) is read for `runFailureCause` as `null` -
//       asserting the two "carries" fields and the two "never carries" fields are
//       independent per outcome (Req 2.11).
//
// WHY THIS LIVES IN app/test, NOT app/eval
//   `captureSampleArtifacts` is `@app/eval`'s own pure function, but the shared
//   property-test harness (`propertyParameters`) lives in `@app/test`, and the
//   import-boundary gate forbids `eval` from importing `test` (see
//   chipAgent/_inbox/eval-harness-integration-needs-test-to-eval-boundary.md, which
//   already wired the test -> eval reach this file reuses).
//
// Structural precedent: `app/eval/harness.test.ts`'s `setupFailedOutcome` /
// `instrumentRefusedOutcome` (minimal literal outcomes, only the fields the function
// under test actually reads) and `app/eval/sweep/artifact-layout.test.ts`'s `artifacts`
// override-builder. `SampleResult`'s pass-through fields are irrelevant to this
// property, so `measured` is one fixed fixture throughout.
//
// Validates: Requirements 2.11, 6.3, 6.4, 6.6

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { NO_REPAIR, type VerificationOutcome } from '@app/agent';
import { ARTIFACT_CAPS, captureSampleArtifacts, type SampleResult } from '@app/eval';
import { propertyParameters } from '@app/test';

const PROPERTY =
  'instrument-precheck-and-attribution, Property 12: The capture derives exactly what the outcome carries, bounded';

/** The sample the harness already measured; its fields are copied verbatim and not under test. */
const MEASURED: SampleResult = {
  sampleIndex: 0,
  seed: 1,
  passed: false,
  outcomeStatus: 'setup-failed',
  failureNote: null,
  noVerdictCause: null,
  iterations: 0,
  costCents: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  unreportedUsageCalls: 0,
  stopReason: null,
  goldenVerdict: null,
  instrumentVerdict: { validity: 'unchecked', reason: 'no-testbench' },
  mutationProbe: null,
  repairProvenance: NO_REPAIR,
};

/** A `setup-failed` outcome whose coverage-gap fields are supplied by the caller. */
function coverageGapOutcome(
  rejectedTestbench: string,
  missingCheckNames: readonly string[],
): VerificationOutcome {
  return {
    status: 'setup-failed',
    reason: 'testbench-unavailable',
    detail: 'the draft omitted a required check',
    cause: 'model-output-unusable',
    rejectedTestbench,
    missingCheckNames,
  } as unknown as VerificationOutcome;
}

/** A `setup-failed` outcome from a cause that never carries a coverage-gap draft at all. */
function noDraftSetupFailedOutcome(): VerificationOutcome {
  return {
    status: 'setup-failed',
    reason: 'generation-unavailable',
    detail: 'no provider answered',
    cause: 'provider-unreachable',
    // Deliberately no `rejectedTestbench` / `missingCheckNames` keys - the shape a
    // non-coverage-gap setup failure actually has (see `VerificationSetupFailed`).
  } as unknown as VerificationOutcome;
}

/** An `instrument-refused` outcome: carries `attributedFiles`, never a rejected draft. */
function instrumentRefusedOutcome(attributedFiles: readonly string[]): VerificationOutcome {
  return {
    status: 'instrument-refused',
    reason: 'testbench-build-failed',
    candidate: { rtl: 'module m(input a, output y); assign y = a; endmodule' },
    testbench: { source: 'module m_tb; endmodule' },
    attributedFiles,
  } as unknown as VerificationOutcome;
}

/**
 * A check-name-shaped string, deliberately spanning the per-name cap. Built the same
 * length-driven way as `rejectedDraftArbitrary`, for the same reason: the claim is about
 * length, and a list of these is generated up to twice the list-length cap below, so a
 * cheap per-element generator matters even more here.
 */
const checkNameArbitrary: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: ARTIFACT_CAPS.maxCheckNameChars * 2 })
  .map((length) => 'c'.repeat(length));

/** A list of check names spanning `ARTIFACT_CAPS.maxMissingCheckNames`. */
const missingCheckNamesArbitrary: fc.Arbitrary<readonly string[]> = fc.array(checkNameArbitrary, {
  minLength: 0,
  maxLength: ARTIFACT_CAPS.maxMissingCheckNames * 2,
});

/**
 * A source text spanning `ARTIFACT_CAPS.maxRejectedDraftChars`, below, at, and above the
 * cap. Built by repeating a fixed character rather than generating fresh random
 * characters per position: the claim under test is about LENGTH and which END is kept,
 * not about content, and a naive `fc.string` at cap-sized lengths (tens of thousands of
 * characters) is slow enough per run to time out a 100-iteration property.
 */
const rejectedDraftArbitrary: fc.Arbitrary<string> = fc
  .integer({ min: 1, max: ARTIFACT_CAPS.maxRejectedDraftChars * 2 })
  .map((length) => 'a'.repeat(length));

/** A generated list of workspace-path-shaped attributed files. */
const attributedFilesArbitrary: fc.Arbitrary<readonly string[]> = fc.array(
  fc.constantFrom('dut.v', 'dut_tb.v', 'stub.v'),
  { maxLength: 3 },
);

describe(PROPERTY, () => {
  it('bounds the rejected testbench draft HEAD-kept, flagging truncation exactly at the cap', () => {
    fc.assert(
      fc.property(rejectedDraftArbitrary, (rejectedTestbench) => {
        const outcome = coverageGapOutcome(rejectedTestbench, []);
        const artifacts = captureSampleArtifacts({ outcome, measured: MEASURED, control: null });
        const draft = artifacts.rejectedTestbenchDraft;

        expect(draft).not.toBeNull();
        if (draft === null) {
          return;
        }
        expect(draft.keptEnd).toBe('head');
        expect(draft.originalChars).toBe(rejectedTestbench.length);

        if (rejectedTestbench.length <= ARTIFACT_CAPS.maxRejectedDraftChars) {
          expect(draft.truncated).toBe(false);
          expect(draft.text).toBe(rejectedTestbench);
        } else {
          expect(draft.truncated).toBe(true);
          expect(draft.text).toBe(rejectedTestbench.slice(0, ARTIFACT_CAPS.maxRejectedDraftChars));
          expect(draft.text.length).toBe(ARTIFACT_CAPS.maxRejectedDraftChars);
        }
      }),
      propertyParameters(),
    );
  });

  it('bounds missing check names by count and by per-name length independently', () => {
    fc.assert(
      fc.property(missingCheckNamesArbitrary, (missingCheckNames) => {
        const outcome = coverageGapOutcome('module m_tb; endmodule', missingCheckNames);
        const artifacts = captureSampleArtifacts({ outcome, measured: MEASURED, control: null });

        const expectedCount = Math.min(
          missingCheckNames.length,
          ARTIFACT_CAPS.maxMissingCheckNames,
        );
        expect(artifacts.missingCheckNames).toHaveLength(expectedCount);
        expect(artifacts.missingCheckNamesTruncated).toBe(
          missingCheckNames.length > ARTIFACT_CAPS.maxMissingCheckNames,
        );

        for (const [index, name] of artifacts.missingCheckNames.entries()) {
          const original = missingCheckNames[index];
          expect(original).toBeDefined();
          expect(name).toBe(original?.slice(0, ARTIFACT_CAPS.maxCheckNameChars));
          expect(name.length).toBeLessThanOrEqual(ARTIFACT_CAPS.maxCheckNameChars);
        }
      }),
      propertyParameters(),
    );
  });

  it('carries the run failure cause and the attributed files an instrument-refused outcome holds', () => {
    fc.assert(
      fc.property(attributedFilesArbitrary, (attributedFiles) => {
        const outcome = instrumentRefusedOutcome(attributedFiles);
        const artifacts = captureSampleArtifacts({ outcome, measured: MEASURED, control: null });

        // Req 5.4: `instrument-refused` is reached before any oracle verdict, so it never
        // carries a `SimulationVerdict` to read a run failure cause from.
        expect(artifacts.runFailureCause).toBeNull();
        expect(artifacts.attributedFiles).toEqual(attributedFiles);
        // An `instrument-refused` outcome never carries a coverage-gap draft.
        expect(artifacts.rejectedTestbenchDraft).toBeNull();
        expect(artifacts.missingCheckNames).toEqual([]);
        expect(artifacts.missingCheckNamesTruncated).toBe(false);
      }),
      propertyParameters(),
    );
  });

  it('yields an absent artifact for every field a setup-failed non-coverage-gap outcome does not carry', () => {
    const outcome = noDraftSetupFailedOutcome();
    const artifacts = captureSampleArtifacts({ outcome, measured: MEASURED, control: null });

    expect(artifacts.rejectedTestbenchDraft).toBeNull();
    expect(artifacts.missingCheckNames).toEqual([]);
    expect(artifacts.missingCheckNamesTruncated).toBe(false);
    // `setup-failed` never ran a simulation and never held an attribution list either.
    expect(artifacts.runFailureCause).toBeNull();
    expect(artifacts.attributedFiles).toEqual([]);
  });

  it('never lets an absent rejectedTestbench manifest as a present-but-blank draft', () => {
    // A defence against the specific shape Req 6.6 rules out: an outcome that carries
    // `missingCheckNames` (a coverage-gap `setup-failed`) but happens to have an empty
    // `rejectedTestbench` string must still read as ABSENT, the same as a truly missing
    // key - `captureText` already treats `''` as nothing to capture, and this pins that
    // behaviour to the rejected-draft field specifically.
    const outcome = coverageGapOutcome('', ['reset_clears_output']);
    const artifacts = captureSampleArtifacts({ outcome, measured: MEASURED, control: null });

    expect(artifacts.rejectedTestbenchDraft).toBeNull();
    expect(artifacts.missingCheckNames).toEqual(['reset_clears_output']);
  });
});
