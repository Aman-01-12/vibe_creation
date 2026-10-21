// reference-model-consensus-gate, task 14.2: the existing fail-closed trust
// treatment renders a consensus Unverified_Outcome unchanged (C19).
//
// `app/web/display/trust-treatment.ts` is NOT edited by this task; these are
// assertions that the existing fail-closed path already does the right thing
// with a consensus-shaped label, which carries no oracle-provenance reference at
// all because a Session that reaches no Verified_Outcome never names an oracle
// span (Req 14.4).

import { describe, expect, it } from 'vitest';

import { newUlid, treatmentForTier, type ArtifactRef } from '@app/core';

import { decideTrustTreatment } from '@app/web';

/** A module-version artifact ref, as a Candidate_Design would be labeled. */
function moduleRef(): ArtifactRef {
  return { kind: 'module-version', id: newUlid(), version: 1 };
}

describe('decideTrustTreatment - a consensus Unverified_Outcome renders through the existing path unchanged', () => {
  it('renders Unverified for a consensus label with no oracle-provenance reference', () => {
    const ref = moduleRef();
    const decision = decideTrustTreatment({ artifactRef: ref, tier: 'Unverified' }, []);

    expect(decision.tier).toBe('Unverified');
    expect(decision.treatment).toBe(treatmentForTier('Unverified'));
    expect(decision.discrepancy).toBeNull();
  });

  it('renders Unverified, not Verified, when a consensus label claims Verified with no span', () => {
    const ref = moduleRef();
    const decision = decideTrustTreatment({ artifactRef: ref, tier: 'Verified' }, []);

    expect(decision.tier).toBe('Unverified');
  });

  it('presents each of the three tiers distinctly, so Unverified is a third state, not a pass or a fail', () => {
    const verifiedRef = moduleRef();
    const spanId = newUlid();
    const verified = decideTrustTreatment(
      { artifactRef: verifiedRef, tier: 'Verified', oracleSpanRef: spanId },
      [{ spanId, artifactRef: verifiedRef, verdict: 'pass' }],
    );
    const unverified = decideTrustTreatment({ artifactRef: moduleRef(), tier: 'Unverified' }, []);
    const notApplicable = decideTrustTreatment(
      { artifactRef: moduleRef(), tier: 'Not_Applicable' },
      [],
    );

    expect(verified.tier).toBe('Verified');
    expect(unverified.tier).toBe('Unverified');
    expect(notApplicable.tier).toBe('Not_Applicable');

    // Three tiers, three distinct treatments: Unverified is never confused with
    // either a pass (Verified) or the pedagogy-exempt state (Not_Applicable).
    const treatments = new Set([verified.treatment, unverified.treatment, notApplicable.treatment]);
    expect(treatments.size).toBe(3);
  });
});
