// Unit tests for the Display_Layer edge over the pure decision (task 15.1).
//
// These verify the two things the layer adds on top of `decideTrustTreatment`:
// the Trust_Tier is visible on every returned display model (Req 14.5), and a
// rejected `Verified` claim is emitted through the injected port exactly once
// (Req 14.15) while a clean decision emits nothing.

import { describe, expect, it } from 'vitest';

import {
  newUlid,
  treatmentForTier,
  type ArtifactRef,
  type OracleVerdictSpan,
  type Ulid,
} from '@app/core';

import { createDisplayLayer } from './display-layer.js';
import type { DiscrepancyEmitPort, ProvenanceDiscrepancy } from './discrepancy.js';

/** A capturing discrepancy port for assertions. */
function recordingPort(): { port: DiscrepancyEmitPort; emitted: ProvenanceDiscrepancy[] } {
  const emitted: ProvenanceDiscrepancy[] = [];
  return { port: { emit: (discrepancy) => emitted.push(discrepancy) }, emitted };
}

/** A module-version artifact reference at a specific version. */
function moduleRef(version = 1, id: Ulid = newUlid()): ArtifactRef {
  return { kind: 'module-version', id, version };
}

describe('createDisplayLayer.resolveTreatment (Req 14.5)', () => {
  it('makes the resolved tier and treatment visible on the display model', () => {
    const { port, emitted } = recordingPort();
    const ref = moduleRef();
    const spanId = newUlid();
    const evidence: OracleVerdictSpan[] = [{ spanId, artifactRef: ref, verdict: 'pass' }];

    const model = createDisplayLayer(port).resolveTreatment(
      { artifactRef: ref, tier: 'Verified', oracleSpanRef: spanId },
      evidence,
    );

    expect(model).toEqual({
      artifactRef: ref,
      tier: 'Verified',
      treatment: treatmentForTier('Verified'),
    });
    expect(emitted).toHaveLength(0);
  });

  it('carries the tier on a plain Unverified artifact and emits nothing', () => {
    const { port, emitted } = recordingPort();
    const ref = moduleRef();

    const model = createDisplayLayer(port).resolveTreatment(
      { artifactRef: ref, tier: 'Unverified' },
      [],
    );

    expect(model.tier).toBe('Unverified');
    expect(model.treatment).toBe(treatmentForTier('Unverified'));
    expect(emitted).toHaveLength(0);
  });
});

describe('createDisplayLayer.resolveTreatment fail-closed emission (Req 14.14, 14.15)', () => {
  it('renders Unverified and emits one discrepancy for a rejected Verified claim', () => {
    const { port, emitted } = recordingPort();
    const ref = moduleRef();
    const spanId = newUlid();

    const model = createDisplayLayer(port).resolveTreatment(
      { artifactRef: ref, tier: 'Verified', oracleSpanRef: spanId },
      [],
    );

    expect(model.tier).toBe('Unverified');
    expect(model.treatment).toBe(treatmentForTier('Unverified'));
    expect(emitted).toEqual([
      {
        kind: 'display-layer-provenance-rejected',
        artifactRef: ref,
        claimedTier: 'Verified',
        reason: 'unvalidatable-provenance',
        rejectedOracleSpanRef: spanId,
      },
    ]);
  });

  it('does not emit a discrepancy for a malformed junk label', () => {
    const { port, emitted } = recordingPort();

    const model = createDisplayLayer(port).resolveTreatment({ tier: 'whatever' }, []);

    expect(model.tier).toBe('Unverified');
    expect(model.artifactRef).toBeNull();
    expect(emitted).toHaveLength(0);
  });
});
