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
// THE FORMAL EVIDENCE (formal-property-oracle Req 12.15, 12.16, 12.22), in the second block
//   The same capture now records three facts about the ONE Formal_Property that decided the
//   sample: its Property_Wrapper source (HEAD-kept under `maxSourceChars`, written to
//   `property-wrapper.v`), its generated SMT2 assertion count, and - for a refutation alone - its
//   Counterexample REFERENCE. They are read off `measured.formal`, the object the results
//   record's `formal` block is projected from, so the record's own `recordedFormalRun` is the
//   independent witness of which property that is. Bounded and absent-when-unreadable for the
//   same reasons as the fields above, so they live beside them.
//
// Validates: Requirements 2.11, 6.3, 6.4, 6.6 (instrument-precheck-and-attribution);
// 12.15, 12.16, 12.22 (formal-property-oracle)

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  NO_FORMAL_RUN,
  NO_REPAIR,
  type FormalProvenance,
  type VerificationOutcome,
} from '@app/agent';
import {
  ARTIFACT_CAPS,
  ARTIFACT_FILENAMES,
  captureSampleArtifacts,
  MAX_COUNTEREXAMPLE_TRACE_BYTES,
  planArtifactFiles,
  recordedFormalRun,
  type EvalSampleArtifacts,
  type SampleResult,
} from '@app/eval';
import { propertyParameters } from '@app/test';
import {
  admitProved,
  MAX_RETAINED_ARTIFACT_BYTES,
  type ArtifactBlobRef,
  type ProofConditions,
  type PropertyResult,
} from '@app/tools';

import { arbFormalProvenance } from './formal-arbitraries.js';

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
  propertySetAdmitted: 'not-gated',
  propertySetAuthoredUpFront: false,
  propertySetSurvivorCount: 0,
  formalMutationCounts: null,
  repairProvenance: NO_REPAIR,
  formal: NO_FORMAL_RUN,
  checkNameVisibilitySignal: false,
  checkingApproach: 'cycle-timed',
  testbenchParseRefusal: null,
  // A setup-failed sample measured no testbench.
  valuelessFailureReports: null,
  positiveControlRun: null,
  designGroup: 'cycle-exact',
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

/** A Counterexample reference in the shape the worker registers a base-case trace under. */
const COUNTEREXAMPLE: ArtifactBlobRef = Object.freeze({
  name: 'formal-trace-base-bitwuzla.vcd',
  sizeBytes: 2_048,
  sha256: 'e'.repeat(64),
});

/** Five Proof_Conditions that all admit, over the given assertion count. */
function admittingConditions(assertionCount: number): ProofConditions {
  return {
    assertionCount,
    presat: 'satisfiable',
    cover: { reached: 'not-applicable' },
    base: 'passed',
    induction: 'successful',
  };
}

/** A `proved` result, its evidence built by `admitProved`, the sole constructor of one. */
function provedResult(criterionRef: string, assertionCount: number): PropertyResult {
  const evidence = admitProved(admittingConditions(assertionCount));
  if (typeof evidence === 'string') {
    throw new Error(`the fixture's own conditions were refused: ${evidence}`);
  }
  return { verdict: 'proved', evidence, depth: 20, elapsedMs: 10, criterionRef };
}

/** A `refuted` result: a failed base case, carrying the reference it was reported with. */
function refutedResult(
  criterionRef: string,
  assertionCount: number,
  counterexample: ArtifactBlobRef = COUNTEREXAMPLE,
): PropertyResult {
  return {
    verdict: 'refuted',
    counterexample,
    conditions: { ...admittingConditions(assertionCount), base: 'failed', induction: 'not-run' },
    depth: 20,
    elapsedMs: 10,
    criterionRef,
  };
}

/** A `could-not-verify` result whose budget ran out, over the given count. */
function couldNotVerifyResult(criterionRef: string, assertionCount: number): PropertyResult {
  return {
    verdict: 'could-not-verify',
    cause: 'proof-timeout',
    conditions: { ...admittingConditions(assertionCount), induction: 'not-run' },
    depth: 20,
    elapsedMs: 150_000,
    criterionRef,
    diagnostic: null,
    crossCheckDisagreed: false,
  };
}

/** The wrapper source the oracle submitted for one criterion; distinct per criterion. */
function wrapperFor(criterionRef: string): string {
  return `module formal_property_wrapper(input clk);\n  // ${criterionRef}\nendmodule\n`;
}

/** A provenance over these results, each wrapper paired with its result by index. */
function provenanceOf(results: readonly PropertyResult[]): FormalProvenance {
  return {
    ...NO_FORMAL_RUN,
    results,
    propertyWrapperSources: results.map((result) => wrapperFor(result.criterionRef)),
  };
}

/**
 * Capture one sample whose measured provenance is `formal`.
 *
 * Untyped on purpose, so the unreadable shapes below can be handed in. The outcome carries the
 * same value because the harness copies it from there; the capture reads `measured.formal`.
 */
function captureFormal(formal: unknown): EvalSampleArtifacts {
  const measured = { ...MEASURED, outcomeStatus: 'unverified', formal } as unknown as SampleResult;
  const outcome = { status: 'unverified', formal } as unknown as VerificationOutcome;
  return captureSampleArtifacts({ outcome, measured, control: null });
}

/** A two-slot result list whose FIRST slot is a hole rather than a value. */
function sparseResults(result: PropertyResult): readonly unknown[] {
  const slots = new Array<unknown>(2);
  slots[1] = result;
  return slots;
}

/** A count as the capture may record one: a non-negative safe integer, or absent. */
function usableCount(value: number | undefined): number | null {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** A wrapper length spanning `maxSourceChars`, built by repetition - the claim is about length. */
const wrapperLengthArbitrary: fc.Arbitrary<number> = fc.integer({
  min: 1,
  max: ARTIFACT_CAPS.maxSourceChars * 2,
});

describe('formal-property-oracle: the capture records what the deciding formal result rested on', () => {
  it('bounds the deciding wrapper HEAD-kept under maxSourceChars and writes it to property-wrapper.v', () => {
    fc.assert(
      fc.property(wrapperLengthArbitrary, (length) => {
        const source = 'w'.repeat(length);
        const formal = {
          ...provenanceOf([refutedResult('ac-1', 2)]),
          propertyWrapperSources: [source],
        };

        const artifacts = captureFormal(formal);
        const captured = artifacts.propertyWrapperSource;

        expect(captured).not.toBeNull();
        if (captured === null) {
          return;
        }
        expect(captured.keptEnd).toBe('head');
        expect(captured.originalChars).toBe(length);
        expect(captured.truncated).toBe(length > ARTIFACT_CAPS.maxSourceChars);
        expect(captured.text).toBe(source.slice(0, ARTIFACT_CAPS.maxSourceChars));
        const file = planArtifactFiles(artifacts).find(
          (planned) => planned.filename === ARTIFACT_FILENAMES.propertyWrapper,
        );
        // Banner-prefixed when cut, so the file ends with exactly the captured text either way.
        expect(file?.contents.endsWith(captured.text)).toBe(true);
        expect(file?.truncated).toBe(captured.truncated);
      }),
      propertyParameters(),
    );
  });

  it('takes the wrapper, the count, and the reference from the ONE result that decided it', () => {
    // `refuted` beats `could-not-verify` beats `proved`, and the refutation is deliberately NOT
    // first, so a capture that read index 0 or the last result records a different property.
    const formal = provenanceOf([
      provedResult('ac-1', 5),
      couldNotVerifyResult('ac-2', 0),
      refutedResult('ac-3', 3),
    ]);

    const artifacts = captureFormal(formal);

    expect(artifacts.propertyWrapperSource?.text).toBe(wrapperFor('ac-3'));
    expect(artifacts.formalAssertionCount).toBe(3);
    expect(artifacts.formalCounterexample).toEqual(COUNTEREXAMPLE);
    // The same choice the results record's `formal` block makes, over the same object.
    expect(recordedFormalRun(formal)?.conditions.assertionCount).toBe(3);
  });

  it('reads the count off the field each verdict carries it on, and a reference only on a refutation', () => {
    // A `proved` result has no `conditions` and the other two have no `evidence`, so reading the
    // wrong holder yields `null` here rather than a plausible number. Zero is a real count - the
    // measured vacuous trap - and must be recorded as 0, never as absent.
    const cases: readonly {
      readonly result: PropertyResult;
      readonly count: number;
      readonly counterexample: ArtifactBlobRef | null;
    }[] = [
      { result: provedResult('ac-1', 7), count: 7, counterexample: null },
      { result: couldNotVerifyResult('ac-1', 0), count: 0, counterexample: null },
      { result: refutedResult('ac-1', 4), count: 4, counterexample: COUNTEREXAMPLE },
    ];

    for (const { result, count, counterexample } of cases) {
      const artifacts = captureFormal(provenanceOf([result]));

      expect(artifacts.formalAssertionCount, result.verdict).toBe(count);
      expect(artifacts.formalCounterexample, result.verdict).toEqual(counterexample);
    }
  });

  it('records a reference for exactly the samples the record calls refuted, and the record count', () => {
    fc.assert(
      fc.property(arbFormalProvenance(), (formal) => {
        const artifacts = captureFormal(formal);
        const recorded = recordedFormalRun(formal);

        expect(artifacts.formalCounterexample !== null).toBe(recorded?.verdict === 'refuted');
        expect(artifacts.formalAssertionCount).toBe(
          usableCount(recorded?.conditions.assertionCount),
        );
        // A wrapper is only ever captured from a list that pairs with the results by index.
        if (artifacts.propertyWrapperSource !== null) {
          expect(formal.propertyWrapperSources).toHaveLength(formal.results.length);
        }
      }),
      propertyParameters(),
    );
  });

  it('yields an ABSENT artifact, never a thrown error, for every field it cannot read', () => {
    const refuted = refutedResult('ac-1', 2);
    const nothing = { wrapper: false, count: null, ref: false } as const;
    const rows: readonly {
      readonly name: string;
      readonly formal: unknown;
      readonly wrapper: boolean;
      readonly count: number | null;
      readonly ref: boolean;
    }[] = [
      { name: 'no provenance at all', formal: undefined, ...nothing },
      {
        name: 'results that are not a list',
        formal: { ...NO_FORMAL_RUN, results: 'x' },
        ...nothing,
      },
      {
        name: 'a result that is not an object',
        formal: { ...provenanceOf([refuted]), results: [null, refuted] },
        ...nothing,
      },
      {
        // `every` skips a hole and `find` visits one, so a guard written with `every` alone
        // would hand `decidingResult` an `undefined` to read `verdict` off.
        name: 'a sparse result list',
        formal: { ...provenanceOf([refuted]), results: sparseResults(refuted) },
        ...nothing,
      },
      {
        name: 'a wrapper list an older double never returned',
        formal: { ...provenanceOf([refuted]), propertyWrapperSources: undefined },
        wrapper: false,
        count: 2,
        ref: true,
      },
      {
        name: 'a wrapper list that cannot be paired by index',
        formal: { ...provenanceOf([refuted]), propertyWrapperSources: ['a', 'b'] },
        wrapper: false,
        count: 2,
        ref: true,
      },
      {
        name: 'a reference whose digest is not a SHA-256',
        formal: provenanceOf([refutedResult('ac-1', 2, { ...COUNTEREXAMPLE, sha256: 'nope' })]),
        wrapper: true,
        count: 2,
        ref: false,
      },
      {
        name: 'a count that is not a count',
        formal: provenanceOf([refutedResult('ac-1', Number.NaN)]),
        wrapper: true,
        count: null,
        ref: true,
      },
      {
        // "Present for a refuted sample and for NO other" holds even for a malformed carrier: a
        // reference on a result the oracle did not refute is not a Counterexample.
        name: 'a stray reference on a result that is not a refutation',
        formal: {
          ...provenanceOf([couldNotVerifyResult('ac-1', 2)]),
          results: [{ ...couldNotVerifyResult('ac-1', 2), counterexample: COUNTEREXAMPLE }],
        },
        wrapper: true,
        count: 2,
        ref: false,
      },
    ];

    for (const row of rows) {
      const artifacts = captureFormal(row.formal);

      expect(artifacts.propertyWrapperSource !== null, row.name).toBe(row.wrapper);
      expect(artifacts.formalAssertionCount, row.name).toBe(row.count);
      expect(artifacts.formalCounterexample !== null, row.name).toBe(row.ref);
    }
  });

  it('sizes the trace cap to hold whole every trace the retention store can resolve', () => {
    // A trace is written whole or not at all, so a cap below the store's own would refuse traces
    // it kept, and no character cap here could hold a retained trace whole.
    expect(MAX_COUNTEREXAMPLE_TRACE_BYTES).toBeGreaterThanOrEqual(MAX_RETAINED_ARTIFACT_BYTES);
    expect(MAX_COUNTEREXAMPLE_TRACE_BYTES).toBeGreaterThan(ARTIFACT_CAPS.maxSourceChars);
  });
});
