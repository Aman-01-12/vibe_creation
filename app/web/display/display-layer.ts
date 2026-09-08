// The Display_Layer: applies the per-Trust_Tier visual treatment behind a
// fail-closed provenance check, and makes the Trust_Tier visible on every artifact
// it renders (Design: Display_Layer (web); Req 14.5, 14.13, 14.14, 14.15).
//
// This is the thin, impure edge over the pure `decideTrustTreatment` core: it runs
// the fail-closed decision and, when a `Verified` claim is rejected, forwards the
// discrepancy through the injected `DiscrepancyEmitPort` so it is recorded in the
// Trace (Req 14.15). Keeping the decision pure and separate lets Property 2 (task
// 15.2) state over the decision without a port or a render surface.
//
// It never re-derives correctness and never runs a simulator; the recorded oracle
// verdict remains the sole authority for `Verified`.

import type { ArtifactRef, TrustTier, TrustTreatment } from '@app/core';

import type { DiscrepancyEmitPort } from './discrepancy.js';
import { decideTrustTreatment } from './trust-treatment.js';

/**
 * The display model for one artifact.
 *
 * Every rendered artifact carries its resolved `tier` and matching `treatment`,
 * so the Trust_Tier is visible wherever the artifact is displayed (Req 14.5).
 * `artifactRef` is `null` only when the label was too malformed to identify.
 */
export interface ArtifactDisplayModel {
  readonly artifactRef: ArtifactRef | null;
  readonly tier: TrustTier;
  readonly treatment: TrustTreatment;
}

/**
 * The Display_Layer surface consumed by the render code.
 *
 * `resolveTreatment` takes an UNTRUSTED label from the stream plus the oracle
 * verdict evidence projected from the session Trace, and returns the display model
 * to render. Any provenance discrepancy is emitted through the injected port as a
 * side effect before the model is returned; the returned model already reflects
 * the fail-closed tier.
 */
export interface DisplayLayer {
  resolveTreatment(
    rawLabel: unknown,
    evidence: Parameters<typeof decideTrustTreatment>[1],
  ): ArtifactDisplayModel;
}

/**
 * Create a Display_Layer bound to a discrepancy-emit port.
 *
 * The port is injected (never imported upward, never a global) so the composition
 * root can wire it to the Action_Recorder while this layer stays within the
 * `web -> api` boundary.
 */
export function createDisplayLayer(discrepancyPort: DiscrepancyEmitPort): DisplayLayer {
  return {
    resolveTreatment(rawLabel, evidence): ArtifactDisplayModel {
      const decision = decideTrustTreatment(rawLabel, evidence);
      if (decision.discrepancy !== null) {
        discrepancyPort.emit(decision.discrepancy);
      }
      return {
        artifactRef: decision.artifactRef,
        tier: decision.tier,
        treatment: decision.treatment,
      };
    },
  };
}
