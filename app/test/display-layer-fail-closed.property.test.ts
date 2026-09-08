// Property 2: the Display_Layer fails closed on Verified labels (task 15.2).
//
// This is the universal complement to the worked examples in
// `app/web/display/trust-treatment.test.ts` and
// `app/web/display/display-layer.test.ts` (which this file does not duplicate).
// It states the fail-closed contract over BOTH the pure decision
// (`decideTrustTreatment`) AND the impure edge
// (`createDisplayLayer(...).resolveTreatment`), across an adversarial input space
// (Design: Display_Layer fail-closed check; Req 14.13, 14.14, 14.15):
//
//   - Verified is EARNED, never claimed: the `Verified` visual treatment is
//     applied if and only if the label claims `Verified` AND its oracle-provenance
//     reference is a present, well-formed ULID AND a matching PASSING oracle span
//     for the EXACT artifact kind/id/version exists in the Trace evidence
//     (Req 14.13). A stale-version, wrong-id, wrong-kind, or non-passing span
//     never earns it.
//   - Fail closed toward less trust: a label that is missing, malformed, or whose
//     provenance cannot be validated renders `Unverified`, never `Verified`
//     (Req 14.14). A plain `Unverified`/`Not_Applicable` label keeps its own tier;
//     unreadable junk collapses to `Unverified`.
//   - Discrepancy only on a rejected Verified CLAIM: a discrepancy is recorded in
//     the Trace exactly when a label CLAIMING `Verified` is rejected (Req 14.15).
//     A plain non-Verified label or unreadable junk fails closed silently.
//
// UNTRUSTED input: the streamed label and its provenance are treated as hostile.
// The generators forge malformed refs, non-ULID / non-string / absent provenance,
// spans for the wrong artifact or verdict, and outright junk.
//
// INDEPENDENT oracle: every case is built from a labelled generation plan, and the
// expected outcome is derived from that plan's identity - never by calling the
// production decision under test - so the test cannot tautologically agree with a
// buggy implementation.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  isUlid,
  isVerifiedTreatment,
  treatmentForTier,
  type ArtifactKind,
  type ArtifactRef,
  type OracleVerdictSpan,
  type TrustTier,
  type Verdict,
} from '@app/core';
import {
  createDisplayLayer,
  decideTrustTreatment,
  type DiscrepancyEmitPort,
  type DiscrepancyReason,
  type ProvenanceDiscrepancy,
} from '@app/web';
import { propertyParameters, propertyTag } from '@app/test';

const PROPERTY = propertyTag(2, 'Display_Layer fails closed on Verified labels');

// --- Domain generators -------------------------------------------------------

/** Crockford base32 (excludes I, L, O, U): the ULID alphabet. */
const CROCKFORD: readonly string[] = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.split('');

/** Every artifact kind the Display_Layer may render. */
const ARTIFACT_KINDS = [
  'intent',
  'spec',
  'testbench',
  'module-version',
  'verification-result',
  'waveform',
  'schematic',
  'explanation',
] as const satisfies readonly ArtifactKind[];

/** The three legitimate tier strings, used to keep junk tiers genuinely unknown. */
const VALID_TIERS: ReadonlySet<unknown> = new Set(['Verified', 'Unverified', 'Not_Applicable']);

/** An arbitrary string of length `[min, max]` drawn from an explicit alphabet. */
function fromChars(chars: readonly string[], min: number, max: number): fc.Arbitrary<string> {
  const [first, ...rest] = chars;
  if (first === undefined) {
    throw new Error('fromChars requires a non-empty character set');
  }
  return fc
    .array(fc.constantFrom(first, ...rest), { minLength: min, maxLength: max })
    .map((c) => c.join(''));
}

/**
 * A syntactically valid ULID. The leading character is constrained to `0`-`7` so
 * the encoded 48-bit timestamp never overflows, matching `ulidx`'s validity regex.
 */
function ulidArbitrary(): fc.Arbitrary<string> {
  return fc
    .tuple(fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '7'), fromChars(CROCKFORD, 25, 25))
    .map(([head, rest]) => `${head}${rest}`);
}

/** A valid ULID guaranteed to differ from `base` (rotates its final character). */
function differentUlid(base: string): string {
  const lastIndex = base.length - 1;
  const current = CROCKFORD.indexOf(base.charAt(lastIndex));
  const replacement = CROCKFORD[(current + 1) % CROCKFORD.length] as string;
  return `${base.slice(0, lastIndex)}${replacement}`;
}

/** A well-formed artifact reference over any kind and any non-negative version. */
function artifactRefArbitrary(): fc.Arbitrary<ArtifactRef> {
  return fc.record({
    kind: fc.constantFrom(...ARTIFACT_KINDS),
    id: ulidArbitrary(),
    version: fc.integer({ min: 0, max: 1000 }),
  });
}

/**
 * A noise oracle span that can NEVER validate the claim under test: it always
 * references a different artifact id, so no `some`-match on (spanId, ref, pass)
 * can succeed regardless of its verdict.
 */
function noiseSpanArbitrary(targetId: string): fc.Arbitrary<OracleVerdictSpan> {
  return fc
    .record({
      spanId: ulidArbitrary(),
      kind: fc.constantFrom(...ARTIFACT_KINDS),
      version: fc.integer({ min: 0, max: 1000 }),
      verdict: fc.constantFrom<Verdict>('pass', 'fail', 'error'),
    })
    .map(({ spanId, kind, version, verdict }) => ({
      spanId,
      artifactRef: { kind, id: differentUlid(targetId), version },
      verdict,
    }));
}

/** Wrap core spans in leading and trailing noise, so match logic must be specific. */
function evidenceWithNoise(
  targetId: string,
  core: readonly OracleVerdictSpan[],
): fc.Arbitrary<OracleVerdictSpan[]> {
  return fc
    .tuple(
      fc.array(noiseSpanArbitrary(targetId), { maxLength: 3 }),
      fc.array(noiseSpanArbitrary(targetId), { maxLength: 3 }),
    )
    .map(([lead, trail]) => [...lead, ...core, ...trail]);
}

// --- Untrusted provenance generators -----------------------------------------

/** A non-empty string that is NOT a valid ULID (a malformed provenance reference). */
const invalidUlidString: fc.Arbitrary<string> = fc
  .string({ unit: 'grapheme', minLength: 1 })
  .filter((s) => !isUlid(s));

/**
 * A malformed provenance reference: present and non-empty, but not a valid ULID.
 * Spans non-string shapes (number, boolean, object, array) and non-ULID strings,
 * all of which the Display_Layer must classify `malformed-provenance`.
 */
const malformedProvenance: fc.Arbitrary<unknown> = fc.oneof(
  invalidUlidString,
  fc.integer(),
  fc.boolean(),
  fc.record({ nested: fc.string({ unit: 'grapheme' }) }),
  fc.array(fc.string({ unit: 'grapheme' })),
);

/** An absent provenance reference: omitted, null, or empty - all `missing-provenance`. */
const missingProvenanceForm = fc.constantFrom<'omit' | 'null' | 'empty'>('omit', 'null', 'empty');

// --- Case model + independent expectation ------------------------------------

/** The Trace-recorded discrepancy the spec requires for a rejected Verified claim. */
interface ExpectedDiscrepancy {
  readonly reason: DiscrepancyReason;
  readonly rejectedOracleSpanRef: string | null;
  readonly artifactRef: ArtifactRef;
}

/** The outcome an independent reading of the spec predicts for a case. */
interface Expected {
  readonly tier: TrustTier;
  readonly artifactRef: ArtifactRef | null;
  readonly discrepancy: ExpectedDiscrepancy | null;
}

/** One generated scenario: an untrusted label, Trace evidence, and the oracle. */
interface Case {
  readonly rawLabel: unknown;
  readonly evidence: readonly OracleVerdictSpan[];
  readonly expected: Expected;
}

/** Build a well-formed `Verified` label claim, as it would arrive from the stream. */
function verifiedLabel(artifactRef: ArtifactRef, oracleSpanRef: unknown): unknown {
  return { artifactRef, tier: 'Verified', oracleSpanRef };
}

/** The rejection discrepancy an independent reading predicts for a Verified claim. */
function rejection(
  artifactRef: ArtifactRef,
  reason: DiscrepancyReason,
  rejectedOracleSpanRef: string | null,
): ExpectedDiscrepancy {
  return { reason, rejectedOracleSpanRef, artifactRef };
}

// --- Case arms (each derives its own expectation, independent of production) --

/** A Verified claim with a matching passing span for the exact version: earns Verified. */
function verifiedEarned(): fc.Arbitrary<Case> {
  return fc.tuple(artifactRefArbitrary(), ulidArbitrary()).chain(([target, spanRef]) =>
    evidenceWithNoise(target.id, [{ spanId: spanRef, artifactRef: target, verdict: 'pass' }]).map(
      (evidence) => ({
        rawLabel: verifiedLabel(target, spanRef),
        evidence,
        expected: { tier: 'Verified', artifactRef: target, discrepancy: null },
      }),
    ),
  );
}

/** A Verified claim whose only matching span is non-passing: unvalidatable. */
function verifiedWrongVerdict(): fc.Arbitrary<Case> {
  return fc
    .tuple(artifactRefArbitrary(), ulidArbitrary(), fc.constantFrom<Verdict>('fail', 'error'))
    .chain(([target, spanRef, verdict]) =>
      evidenceWithNoise(target.id, [{ spanId: spanRef, artifactRef: target, verdict }]).map(
        (evidence) => ({
          rawLabel: verifiedLabel(target, spanRef),
          evidence,
          expected: {
            tier: 'Unverified',
            artifactRef: target,
            discrepancy: rejection(target, 'unvalidatable-provenance', spanRef),
          },
        }),
      ),
    );
}

/** A Verified claim whose passing span is for a DIFFERENT version: unvalidatable (Req 14.3). */
function verifiedStaleVersion(): fc.Arbitrary<Case> {
  return fc
    .tuple(artifactRefArbitrary(), ulidArbitrary(), fc.integer({ min: 1, max: 5 }))
    .chain(([target, spanRef, delta]) => {
      const staleRef: ArtifactRef = {
        kind: target.kind,
        id: target.id,
        version: target.version + delta,
      };
      return evidenceWithNoise(target.id, [
        { spanId: spanRef, artifactRef: staleRef, verdict: 'pass' },
      ]).map((evidence) => ({
        rawLabel: verifiedLabel(target, spanRef),
        evidence,
        expected: {
          tier: 'Unverified',
          artifactRef: target,
          discrepancy: rejection(target, 'unvalidatable-provenance', spanRef),
        },
      }));
    });
}

/** A Verified claim with no matching span at all (only noise): unvalidatable. */
function verifiedNoSpan(): fc.Arbitrary<Case> {
  return fc.tuple(artifactRefArbitrary(), ulidArbitrary()).chain(([target, spanRef]) =>
    evidenceWithNoise(target.id, []).map((evidence) => ({
      rawLabel: verifiedLabel(target, spanRef),
      evidence,
      expected: {
        tier: 'Unverified',
        artifactRef: target,
        discrepancy: rejection(target, 'unvalidatable-provenance', spanRef),
      },
    })),
  );
}

/** A Verified claim with absent provenance (omitted/null/empty): missing-provenance. */
function verifiedMissingProvenance(): fc.Arbitrary<Case> {
  return fc.tuple(artifactRefArbitrary(), missingProvenanceForm).chain(([target, form]) => {
    const rawLabel =
      form === 'omit'
        ? { artifactRef: target, tier: 'Verified' }
        : verifiedLabel(target, form === 'null' ? null : '');
    return evidenceWithNoise(target.id, []).map((evidence) => ({
      rawLabel,
      evidence,
      expected: {
        tier: 'Unverified',
        artifactRef: target,
        discrepancy: rejection(target, 'missing-provenance', null),
      },
    }));
  });
}

/** A Verified claim with a malformed (non-ULID / non-string) reference: malformed-provenance. */
function verifiedMalformedProvenance(): fc.Arbitrary<Case> {
  return fc.tuple(artifactRefArbitrary(), malformedProvenance).chain(([target, badRef]) =>
    evidenceWithNoise(target.id, []).map((evidence) => ({
      rawLabel: verifiedLabel(target, badRef),
      evidence,
      expected: {
        tier: 'Unverified',
        artifactRef: target,
        discrepancy: rejection(target, 'malformed-provenance', null),
      },
    })),
  );
}

/** A corrupted `artifactRef` shape that can never parse to a valid reference. */
const corruptedRef: fc.Arbitrary<unknown> = fc.oneof(
  fc.record({ kind: fc.constant('bogus-kind'), id: ulidArbitrary(), version: fc.constant(1) }),
  fc.record({
    kind: fc.constantFrom(...ARTIFACT_KINDS),
    id: fc.constant('too-short'),
    version: fc.constant(1),
  }),
  fc.record({
    kind: fc.constantFrom(...ARTIFACT_KINDS),
    id: ulidArbitrary(),
    version: fc.constant(-1),
  }),
  fc.record({
    kind: fc.constantFrom(...ARTIFACT_KINDS),
    id: ulidArbitrary(),
    version: fc.constant(1.5),
  }),
  fc.integer(),
  fc.constant(null),
);

/**
 * A Verified claim whose artifact identity is unreadable: it collapses to junk, so
 * the Display_Layer fails closed to `Unverified` with a null ref and NO
 * discrepancy - no coherent Verified claim can be attributed to it.
 */
function verifiedUnreadableRef(): fc.Arbitrary<Case> {
  return fc
    .tuple(corruptedRef, fc.oneof(ulidArbitrary(), fc.constant(undefined)))
    .map(([artifactRef, spanRef]) => ({
      rawLabel: { artifactRef, tier: 'Verified', oracleSpanRef: spanRef },
      evidence: [],
      expected: { tier: 'Unverified', artifactRef: null, discrepancy: null },
    }));
}

/** A plain `Unverified` label: kept as-is, ref preserved, no discrepancy. */
function plainUnverified(): fc.Arbitrary<Case> {
  return artifactRefArbitrary().map((target) => ({
    rawLabel: { artifactRef: target, tier: 'Unverified' },
    evidence: [],
    expected: { tier: 'Unverified', artifactRef: target, discrepancy: null },
  }));
}

/** A plain `Not_Applicable` label: kept at its own tier, never forced to Unverified. */
function plainNotApplicable(): fc.Arbitrary<Case> {
  return artifactRefArbitrary().map((target) => ({
    rawLabel: { artifactRef: target, tier: 'Not_Applicable' },
    evidence: [],
    expected: { tier: 'Not_Applicable', artifactRef: target, discrepancy: null },
  }));
}

/** A readable ref but an unknown/absent tier: unreadable junk, fails closed silently. */
function junkUnknownTier(): fc.Arbitrary<Case> {
  const invalidTier = fc.oneof(
    fc.string({ unit: 'grapheme' }).filter((s) => !VALID_TIERS.has(s)),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.constant(undefined),
  );
  return fc.tuple(artifactRefArbitrary(), invalidTier).map(([target, tier]) => ({
    rawLabel: { artifactRef: target, tier },
    evidence: [],
    expected: { tier: 'Unverified', artifactRef: null, discrepancy: null },
  }));
}

/** A non-object / structurally empty label: unreadable junk, fails closed silently. */
function junkNonObject(): fc.Arbitrary<Case> {
  const label = fc.oneof(
    fc.string({ unit: 'grapheme' }),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.array(fc.integer()),
    fc.record({ unrelated: fc.string({ unit: 'grapheme' }) }),
  );
  return label.map((rawLabel) => ({
    rawLabel,
    evidence: [],
    expected: { tier: 'Unverified', artifactRef: null, discrepancy: null },
  }));
}

/** The full adversarial case space, weighted evenly across every arm. */
const caseArbitrary: fc.Arbitrary<Case> = fc.oneof(
  verifiedEarned(),
  verifiedWrongVerdict(),
  verifiedStaleVersion(),
  verifiedNoSpan(),
  verifiedMissingProvenance(),
  verifiedMalformedProvenance(),
  verifiedUnreadableRef(),
  plainUnverified(),
  plainNotApplicable(),
  junkUnknownTier(),
  junkNonObject(),
);

// --- Shared expectation checks -----------------------------------------------

/** The full `ProvenanceDiscrepancy` the spec requires, or null when none is due. */
function expectedProvenanceDiscrepancy(expected: Expected): ProvenanceDiscrepancy | null {
  if (expected.discrepancy === null) {
    return null;
  }
  return {
    kind: 'display-layer-provenance-rejected',
    artifactRef: expected.discrepancy.artifactRef,
    claimedTier: 'Verified',
    reason: expected.discrepancy.reason,
    rejectedOracleSpanRef: expected.discrepancy.rejectedOracleSpanRef,
  };
}

/** A capturing discrepancy port for observing what the layer records in the Trace. */
function recordingPort(): { port: DiscrepancyEmitPort; emitted: ProvenanceDiscrepancy[] } {
  const emitted: ProvenanceDiscrepancy[] = [];
  return { port: { emit: (discrepancy) => emitted.push(discrepancy) }, emitted };
}

// --- Property 2 --------------------------------------------------------------

describe(PROPERTY, () => {
  it('applies Verified iff earned, fails closed otherwise, and flags only rejected Verified claims', () => {
    fc.assert(
      fc.property(caseArbitrary, ({ rawLabel, evidence, expected }) => {
        const decision = decideTrustTreatment(rawLabel, evidence);

        // Fail-closed tier and its distinct treatment (Req 14.13, 14.14).
        expect(decision.tier).toBe(expected.tier);
        expect(decision.treatment).toBe(treatmentForTier(expected.tier));

        // The Verified treatment is produced only when Verified was genuinely
        // earned - never for a forged, stale, or unreadable claim (Req 14.13).
        expect(isVerifiedTreatment(decision.treatment)).toBe(expected.tier === 'Verified');

        // Identity survives only for a coherent claim; junk yields a null ref.
        expect(decision.artifactRef).toEqual(expected.artifactRef);

        // A discrepancy is recorded exactly when a Verified CLAIM is rejected,
        // and never for a plain label or unreadable junk (Req 14.15).
        expect(decision.discrepancy).toEqual(expectedProvenanceDiscrepancy(expected));
      }),
      propertyParameters(),
    );
  });

  it('emits the discrepancy through the Trace port iff a Verified claim is rejected', () => {
    fc.assert(
      fc.property(caseArbitrary, ({ rawLabel, evidence, expected }) => {
        const { port, emitted } = recordingPort();

        const model = createDisplayLayer(port).resolveTreatment(rawLabel, evidence);

        // The rendered model carries the same fail-closed tier + treatment.
        expect(model.tier).toBe(expected.tier);
        expect(model.treatment).toBe(treatmentForTier(expected.tier));
        expect(model.artifactRef).toEqual(expected.artifactRef);

        // Exactly one discrepancy reaches the Trace for a rejected Verified claim,
        // and nothing at all otherwise (Req 14.15).
        const expectedDiscrepancy = expectedProvenanceDiscrepancy(expected);
        if (expectedDiscrepancy === null) {
          expect(emitted).toHaveLength(0);
        } else {
          expect(emitted).toEqual([expectedDiscrepancy]);
        }
      }),
      propertyParameters(),
    );
  });
});

// Referenced so the exact Property 2 tag is asserted, not merely written in a
// comment: `Feature: hdl-creation-loop, Property 2: Display_Layer fails closed on Verified labels`.
describe('Property 2 tag', () => {
  it('uses the canonical feature tag', () => {
    expect(PROPERTY).toBe(
      'Feature: hdl-creation-loop, Property 2: Display_Layer fails closed on Verified labels',
    );
  });
});
