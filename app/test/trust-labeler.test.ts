// Example unit tests for the Trust_Labeler and tier -> treatment mapping (task 8.3).
//
// Design: "Deriving Verified solely from a recorded oracle verdict plus
// provenance" and Cross-cutting components (Trust_Labeler). Req 8.3, 14.1-14.4,
// 14.6-14.12. These are focused worked examples; the exhaustive Property 1 and
// Property 3 tests land in tasks 8.4 and 8.5.
//
// They pin the labeler outcomes (Verified iff a passing verdict at the current
// version bound to its span; version mismatch demotes to Unverified; no evidence
// is Unverified; input/pedagogy kinds are Not_Applicable; fail-closed on unusable
// provenance) across both accepted evidence forms, plus the mapping's
// injectivity and Verified exclusivity.

import { describe, expect, it } from 'vitest';

import {
  TRUST_TIERS,
  TRUST_TIER_TREATMENTS,
  VERIFIED_TREATMENT,
  isOk,
  isVerifiedTreatment,
  labelArtifact,
  makeVerificationResult,
  newUlid,
  oracleTrustLabeler,
  treatmentForArtifact,
  treatmentForTier,
  type ArtifactRef,
  type OracleEvidence,
  type OracleVerdictSpan,
  type TrustTier,
  type Verdict,
} from '@app/core';

// -- Fixtures ---------------------------------------------------------------

/** A module-version artifact reference at a given version. */
function moduleRef(id: string, version: number): ArtifactRef {
  return { kind: 'module-version', id, version };
}

/** A raw oracle verdict span for an artifact version (the lightweight form). */
function verdictSpan(
  spanId: string,
  artifactRef: ArtifactRef,
  verdict: Verdict,
): OracleVerdictSpan {
  return { spanId, artifactRef, verdict };
}

/**
 * A full oracle evidence record built through the validating
 * `makeVerificationResult` constructor, so the evidence is always well-formed.
 */
function evidenceFor(
  artifactRef: ArtifactRef,
  verdict: Verdict,
  oracleSpanId: string,
): OracleEvidence {
  const built = makeVerificationResult({
    id: newUlid(),
    moduleVersionId: newUlid(),
    testbenchId: newUlid(),
    verdict,
    allChecksPassed: verdict === 'pass',
    iterations: 1,
    costCents: 0,
    oracleSpanId,
  });
  if (!isOk(built)) {
    throw new Error(`test setup: could not build a ${verdict} VerificationResult`);
  }
  return { artifactRef, result: built.value };
}

// -- labelArtifact ----------------------------------------------------------

describe('labelArtifact (Verified iff a passing oracle verdict for the current version)', () => {
  it('labels Verified and binds to the passing span, from full evidence (Req 14.2, 14.8)', () => {
    const id = newUlid();
    const spanId = newUlid();
    const artifact = moduleRef(id, 2);

    const labeled = labelArtifact(artifact, [evidenceFor(moduleRef(id, 2), 'pass', spanId)]);

    expect(labeled.tier).toBe('Verified');
    if (labeled.tier === 'Verified') {
      expect(labeled.oracleSpanRef).toBe(spanId);
      expect(labeled.artifactRef).toEqual(artifact);
    }
  });

  it('labels Verified from a raw verdict span too, binding the span id (Req 14.2, 14.8)', () => {
    const id = newUlid();
    const spanId = newUlid();
    const artifact = moduleRef(id, 1);

    const labeled = labelArtifact(artifact, [verdictSpan(spanId, moduleRef(id, 1), 'pass')]);

    expect(labeled.tier).toBe('Verified');
    if (labeled.tier === 'Verified') {
      expect(labeled.oracleSpanRef).toBe(spanId);
    }
  });

  it('labels Unverified when a passing verdict exists only for a stale version (Req 14.3, 10.7)', () => {
    const id = newUlid();
    const stale = [evidenceFor(moduleRef(id, 2), 'pass', newUlid())];

    expect(labelArtifact(moduleRef(id, 3), stale).tier).toBe('Unverified');
  });

  it('labels Unverified when no oracle evidence exists at all (Req 14.3)', () => {
    expect(labelArtifact(moduleRef(newUlid(), 1), []).tier).toBe('Unverified');
  });

  it('labels Unverified when the only matching verdicts are fail or error (Req 14.2)', () => {
    const id = newUlid();
    const artifact = moduleRef(id, 1);
    const evidence = [
      evidenceFor(moduleRef(id, 1), 'fail', newUlid()),
      evidenceFor(moduleRef(id, 1), 'error', newUlid()),
    ];

    expect(labelArtifact(artifact, evidence).tier).toBe('Unverified');
  });

  it('does not match a different artifact at the same version (Req 14.2)', () => {
    const target = moduleRef(newUlid(), 1);
    const other = [evidenceFor(moduleRef(newUlid(), 1), 'pass', newUlid())];

    expect(labelArtifact(target, other).tier).toBe('Unverified');
  });

  it('fails closed to Unverified when a matched passing span id is not a valid ULID (Req 14.8, 14.12)', () => {
    const id = newUlid();
    const artifact = moduleRef(id, 1);

    const labeled = labelArtifact(artifact, [verdictSpan('not-a-ulid', moduleRef(id, 1), 'pass')]);

    expect(labeled.tier).toBe('Unverified');
  });

  it('labels input and pedagogy artifacts Not_Applicable regardless of evidence (Req 14.4)', () => {
    const pedagogyKinds = ['intent', 'spec', 'testbench', 'explanation'] as const;
    const strayPass = [evidenceFor(moduleRef(newUlid(), 1), 'pass', newUlid())];

    for (const kind of pedagogyKinds) {
      const ref: ArtifactRef = { kind, id: newUlid(), version: 1 };
      expect(labelArtifact(ref, strayPass).tier).toBe('Not_Applicable');
    }
  });

  it('is exposed as the injectable oracleTrustLabeler with identical behavior', () => {
    const id = newUlid();
    const artifact = moduleRef(id, 1);
    const evidence = [evidenceFor(moduleRef(id, 1), 'pass', newUlid())];

    expect(oracleTrustLabeler.label(artifact, evidence)).toEqual(labelArtifact(artifact, evidence));
  });
});

// -- Tier -> treatment mapping ----------------------------------------------

describe('tier -> visual treatment mapping (injective, Verified exclusive)', () => {
  it('maps each tier to a distinct treatment (injective) (Req 14.10)', () => {
    const treatments = TRUST_TIERS.map(treatmentForTier);
    expect(new Set(treatments).size).toBe(TRUST_TIERS.length);
  });

  it('reserves the Verified treatment exclusively for the Verified tier (Req 14.6)', () => {
    const verifiedTiers = TRUST_TIERS.filter((tier: TrustTier) =>
      isVerifiedTreatment(treatmentForTier(tier)),
    );
    expect(verifiedTiers).toEqual(['Verified']);
    expect(treatmentForTier('Verified')).toBe(VERIFIED_TREATMENT);
    expect(TRUST_TIER_TREATMENTS.Verified).toBe(VERIFIED_TREATMENT);
  });

  it('derives an artifact treatment from its own tier, so Not_Applicable stays Not_Applicable (Req 14.11)', () => {
    const pedagogy = labelArtifact({ kind: 'explanation', id: newUlid(), version: 1 }, []);

    expect(treatmentForArtifact(pedagogy)).toBe(treatmentForTier('Not_Applicable'));
    expect(isVerifiedTreatment(treatmentForArtifact(pedagogy))).toBe(false);
  });
});
