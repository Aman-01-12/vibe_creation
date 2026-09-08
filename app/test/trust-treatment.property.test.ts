// Property 3 for the tier -> visual treatment mapping: treatments are mutually
// distinct and the Verified treatment is exclusive (task 8.5).
//
// This is the universal complement to the worked examples in
// `trust-labeler.test.ts` (which this file does not duplicate). Over generated
// TrustTiers and LabeledArtifacts it pins the three guarantees the design binds
// to Property 3:
//
//   - Injective + total (Req 14.10): `treatmentForTier` maps the three
//     TrustTiers to three DISTINCT treatments - no two tiers collide - and it is
//     total, always returning a known treatment for any generated tier.
//   - Verified exclusive (Req 14.6): `isVerifiedTreatment(treatmentForTier(t))`
//     is true if and only if `t === 'Verified'`, so the Verified treatment is
//     produced for no other tier.
//   - Treatment from own tier (Req 14.11): `treatmentForArtifact(labeled)` equals
//     `treatmentForTier(labeled.tier)` for any generated LabeledArtifact, so a
//     Not_Applicable pedagogy artifact keeps its own treatment even when a
//     Verified artifact is present alongside it - the treatment derives from the
//     artifact's own tier, never from anything it points at.
//
// The mapping is pure and stateless, so no fixtures or fresh instances are
// needed between runs; each run is fully independent by construction.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  TRUST_TIERS,
  TRUST_TIER_TREATMENTS,
  VERIFIED_TREATMENT,
  isOk,
  isVerifiedTreatment,
  notApplicable,
  treatmentForArtifact,
  treatmentForTier,
  unverified,
  verified,
  type ArtifactKind,
  type ArtifactRef,
  type LabeledArtifact,
  type NotApplicableArtifact,
  type Ulid,
  type VerifiedArtifact,
} from '@app/core';
import { propertyParameters, propertyTag } from '@app/test';

// --- Domain-shaped generators ------------------------------------------------

/** Crockford base32 (no I, L, O, U): the ULID alphabet. */
const CROCKFORD: readonly string[] = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.split('');

/** The full closed set of artifact kinds, including input/pedagogy kinds. */
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

/** An arbitrary string of length `[min, max]` drawn from an explicit alphabet. */
function fromChars(chars: readonly string[], min: number, max: number): fc.Arbitrary<string> {
  const [first, ...rest] = chars;
  if (first === undefined) {
    throw new Error('fromChars requires a non-empty character set');
  }
  return fc
    .array(fc.constantFrom(first, ...rest), { minLength: min, maxLength: max })
    .map((picked) => picked.join(''));
}

/**
 * A syntactically valid ULID. The leading character is constrained to `0`-`7`
 * so the encoded timestamp never overflows the 48-bit ULID time field, keeping
 * every generated span reference a real ULID the `verified` constructor accepts.
 */
function ulidArbitrary(): fc.Arbitrary<Ulid> {
  return fc
    .tuple(fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '7'), fromChars(CROCKFORD, 25, 25))
    .map(([head, rest]) => `${head}${rest}`);
}

/** An artifact reference over any kind, at any positive version. */
function artifactRefArbitrary(): fc.Arbitrary<ArtifactRef> {
  return fc.record({
    kind: fc.constantFrom(...ARTIFACT_KINDS),
    id: ulidArbitrary(),
    version: fc.integer({ min: 1, max: 100_000 }),
  });
}

/** A `Verified` artifact, built through the validating constructor. */
function verifiedArtifactArbitrary(): fc.Arbitrary<VerifiedArtifact> {
  return fc.tuple(artifactRefArbitrary(), ulidArbitrary()).map(([ref, span]) => {
    const built = verified(ref, span);
    if (!isOk(built)) {
      throw new Error('generator invariant: a ULID span must yield a Verified label');
    }
    return built.value;
  });
}

/** A `Not_Applicable` artifact over any artifact kind. */
function notApplicableArtifactArbitrary(): fc.Arbitrary<NotApplicableArtifact> {
  return artifactRefArbitrary().map(notApplicable);
}

/** A labeled artifact spanning all three tiers, with valid Verified provenance. */
function labeledArtifactArbitrary(): fc.Arbitrary<LabeledArtifact> {
  return fc.oneof(
    verifiedArtifactArbitrary(),
    artifactRefArbitrary().map(unverified),
    notApplicableArtifactArbitrary(),
  );
}

// --- The property ------------------------------------------------------------

describe('Trust-tier visual treatment mapping (Property 3)', () => {
  // Feature: hdl-creation-loop, Property 3: Trust-tier visual treatments are mutually distinct and Verified is exclusive
  it('is injective and total, reserves the Verified treatment, and derives from the own tier', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TRUST_TIERS),
        labeledArtifactArbitrary(),
        notApplicableArtifactArbitrary(),
        verifiedArtifactArbitrary(),
        (tier, labeled, pedagogy, referencedVerified) => {
          // 14.10 - injective: the three tiers map to three distinct treatments.
          const allTreatments = TRUST_TIERS.map(treatmentForTier);
          expect(new Set(allTreatments).size).toBe(TRUST_TIERS.length);

          // 14.10 - total: the generated tier resolves to a known treatment that
          // agrees with the single source-of-truth record.
          const treatment = treatmentForTier(tier);
          expect(allTreatments).toContain(treatment);
          expect(treatment).toBe(TRUST_TIER_TREATMENTS[tier]);

          // 14.6 - Verified exclusive: the Verified treatment is produced for the
          // Verified tier and for no other tier.
          expect(isVerifiedTreatment(treatment)).toBe(tier === 'Verified');
          if (isVerifiedTreatment(treatment)) {
            expect(tier).toBe('Verified');
            expect(treatment).toBe(VERIFIED_TREATMENT);
          }

          // 14.11 - treatment from the artifact's own tier, for any labeled arm.
          expect(treatmentForArtifact(labeled)).toBe(treatmentForTier(labeled.tier));

          // 14.11 - a Not_Applicable pedagogy artifact keeps its own treatment
          // even with a Verified artifact present alongside it: the treatment
          // derives from the artifact's own tier, never from what it points at.
          expect(isVerifiedTreatment(treatmentForArtifact(referencedVerified))).toBe(true);
          expect(treatmentForArtifact(pedagogy)).toBe(treatmentForTier('Not_Applicable'));
          expect(isVerifiedTreatment(treatmentForArtifact(pedagogy))).toBe(false);
          expect(treatmentForArtifact(pedagogy)).not.toBe(treatmentForArtifact(referencedVerified));
        },
      ),
      propertyParameters(),
    );
  });
});

// Referenced so the exact Property 3 tag is asserted, not merely written in a
// comment: `Feature: hdl-creation-loop, Property 3: Trust-tier visual treatments are mutually distinct and Verified is exclusive`.
describe('Property 3 tag', () => {
  it('uses the canonical feature tag', () => {
    expect(
      propertyTag(
        3,
        'Trust-tier visual treatments are mutually distinct and Verified is exclusive',
      ),
    ).toBe(
      'Feature: hdl-creation-loop, Property 3: Trust-tier visual treatments are mutually distinct and Verified is exclusive',
    );
  });
});
