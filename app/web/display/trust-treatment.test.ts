// Unit tests for the pure fail-closed trust-treatment decision (task 15.1).
//
// These cover the worked cases the Display_Layer must get right; the universal
// Property 2 statement over this same function lands in task 15.2. The decision is
// pure, so no fixtures or fresh instances are needed between cases.

import { describe, expect, it } from 'vitest';

import {
  newUlid,
  treatmentForTier,
  type ArtifactRef,
  type OracleVerdictSpan,
  type Ulid,
} from '@app/core';

import { decideTrustTreatment } from './trust-treatment.js';

/** A module-version artifact reference at a specific version. */
function moduleRef(version = 1, id: Ulid = newUlid()): ArtifactRef {
  return { kind: 'module-version', id, version };
}

/** A recorded passing oracle verdict span for the given artifact version. */
function passingSpan(spanId: Ulid, artifactRef: ArtifactRef): OracleVerdictSpan {
  return { spanId, artifactRef, verdict: 'pass' };
}

/** A well-formed `Verified` label claim, as it would arrive from the stream. */
function verifiedLabel(artifactRef: ArtifactRef, oracleSpanRef: unknown): unknown {
  return { artifactRef, tier: 'Verified', oracleSpanRef };
}

describe('decideTrustTreatment - Verified applied only with valid provenance (Req 14.13)', () => {
  it('applies the Verified treatment when a matching passing span exists', () => {
    const ref = moduleRef();
    const spanId = newUlid();
    const decision = decideTrustTreatment(verifiedLabel(ref, spanId), [passingSpan(spanId, ref)]);

    expect(decision.tier).toBe('Verified');
    expect(decision.treatment).toBe(treatmentForTier('Verified'));
    expect(decision.discrepancy).toBeNull();
    expect(decision.artifactRef).toEqual(ref);
  });

  it('passes an Unverified label through with its own treatment and no discrepancy', () => {
    const ref = moduleRef();
    const decision = decideTrustTreatment({ artifactRef: ref, tier: 'Unverified' }, []);

    expect(decision.tier).toBe('Unverified');
    expect(decision.treatment).toBe(treatmentForTier('Unverified'));
    expect(decision.discrepancy).toBeNull();
  });

  it('keeps a Not_Applicable pedagogy label at its own treatment (Req 14.11)', () => {
    const ref: ArtifactRef = { kind: 'explanation', id: newUlid(), version: 1 };
    const decision = decideTrustTreatment({ artifactRef: ref, tier: 'Not_Applicable' }, []);

    expect(decision.tier).toBe('Not_Applicable');
    expect(decision.treatment).toBe(treatmentForTier('Not_Applicable'));
    expect(decision.discrepancy).toBeNull();
  });
});

describe('decideTrustTreatment - fails closed and flags a discrepancy (Req 14.14, 14.15)', () => {
  it('rejects a Verified claim with no matching span as unvalidatable', () => {
    const ref = moduleRef();
    const spanId = newUlid();
    const decision = decideTrustTreatment(verifiedLabel(ref, spanId), []);

    expect(decision.tier).toBe('Unverified');
    expect(decision.discrepancy).toEqual({
      kind: 'display-layer-provenance-rejected',
      artifactRef: ref,
      claimedTier: 'Verified',
      reason: 'unvalidatable-provenance',
      rejectedOracleSpanRef: spanId,
    });
  });

  it('rejects a Verified claim whose span matches a different version', () => {
    const spanId = newUlid();
    const id = newUlid();
    const decision = decideTrustTreatment(verifiedLabel(moduleRef(2, id), spanId), [
      passingSpan(spanId, moduleRef(1, id)),
    ]);

    expect(decision.tier).toBe('Unverified');
    expect(decision.discrepancy?.reason).toBe('unvalidatable-provenance');
  });

  it('rejects a Verified claim whose span verdict is not a pass', () => {
    const ref = moduleRef();
    const spanId = newUlid();
    const failing: OracleVerdictSpan = { spanId, artifactRef: ref, verdict: 'fail' };
    const decision = decideTrustTreatment(verifiedLabel(ref, spanId), [failing]);

    expect(decision.tier).toBe('Unverified');
    expect(decision.discrepancy?.reason).toBe('unvalidatable-provenance');
  });

  it('rejects a Verified claim with a missing provenance reference', () => {
    const ref = moduleRef();
    const decision = decideTrustTreatment({ artifactRef: ref, tier: 'Verified' }, []);

    expect(decision.tier).toBe('Unverified');
    expect(decision.discrepancy?.reason).toBe('missing-provenance');
    expect(decision.discrepancy?.rejectedOracleSpanRef).toBeNull();
  });

  it('rejects a Verified claim with an empty-string provenance reference', () => {
    const ref = moduleRef();
    const decision = decideTrustTreatment(verifiedLabel(ref, ''), []);

    expect(decision.discrepancy?.reason).toBe('missing-provenance');
  });

  it('rejects a Verified claim with a malformed (non-ULID) provenance reference', () => {
    const ref = moduleRef();
    const decision = decideTrustTreatment(verifiedLabel(ref, 'not-a-ulid'), []);

    expect(decision.tier).toBe('Unverified');
    expect(decision.discrepancy?.reason).toBe('malformed-provenance');
    expect(decision.discrepancy?.rejectedOracleSpanRef).toBeNull();
  });

  it('never leaks a malformed reference string into the discrepancy', () => {
    const ref = moduleRef();
    const decision = decideTrustTreatment(verifiedLabel(ref, { evil: '<script>' }), []);

    expect(decision.discrepancy?.reason).toBe('malformed-provenance');
    expect(decision.discrepancy?.rejectedOracleSpanRef).toBeNull();
  });
});

describe('decideTrustTreatment - malformed labels fail closed without a discrepancy', () => {
  it('renders Unverified with no discrepancy for a non-object label', () => {
    const decision = decideTrustTreatment('not-an-object', []);

    expect(decision.tier).toBe('Unverified');
    expect(decision.artifactRef).toBeNull();
    expect(decision.discrepancy).toBeNull();
  });

  it('renders Unverified with no discrepancy for a null label', () => {
    const decision = decideTrustTreatment(null, []);

    expect(decision.tier).toBe('Unverified');
    expect(decision.discrepancy).toBeNull();
  });

  it('treats an unknown tier as junk with no discrepancy', () => {
    const decision = decideTrustTreatment({ artifactRef: moduleRef(), tier: 'Bogus' }, []);

    expect(decision.tier).toBe('Unverified');
    expect(decision.discrepancy).toBeNull();
  });

  it('treats a Verified claim with an unreadable artifactRef as junk', () => {
    const decision = decideTrustTreatment({ artifactRef: { kind: 'nope' }, tier: 'Verified' }, []);

    expect(decision.tier).toBe('Unverified');
    expect(decision.artifactRef).toBeNull();
    expect(decision.discrepancy).toBeNull();
  });

  it('rejects an artifactRef carrying a non-ULID id', () => {
    const decision = decideTrustTreatment(
      { artifactRef: { kind: 'module-version', id: 'short', version: 1 }, tier: 'Verified' },
      [],
    );

    expect(decision.artifactRef).toBeNull();
    expect(decision.discrepancy).toBeNull();
  });
});
