// The provenance-discrepancy event and the port the Display_Layer emits it through
// (Design: Display_Layer fail-closed check; Req 14.15).
//
// When the Display_Layer rejects a label that CLAIMS `Verified` because its oracle
// provenance is missing, malformed, or does not validate against the Trace, it
// must surface that rejection as a discrepancy in the session Trace so a
// Trust_Labeler defect is diagnosed rather than silently masked (Req 14.15).
//
// Layering: `@app/web` may only depend inward on `@app/api` (and deeper); it must
// never import `@app/agent` or the Action_Recorder that owns the Trace. So the
// discrepancy is emitted through an injected port defined here in web terms; the
// composition root wires an adapter that forwards to the Action_Recorder. This
// keeps the Display_Layer free of any upward import and of any global state.

import type { ArtifactRef } from '@app/core';

/**
 * Why a `Verified` claim failed the Display_Layer's fail-closed provenance check.
 *
 * - `missing-provenance`: the label claimed `Verified` but carried no oracle span
 *   reference (absent, null, or empty).
 * - `malformed-provenance`: a reference was present but is not a well-formed
 *   identifier, so it cannot name a Trace span.
 * - `unvalidatable-provenance`: the reference is well-formed but no matching
 *   passing oracle verdict for the artifact's current version exists in the Trace.
 */
export type DiscrepancyReason =
  'missing-provenance' | 'malformed-provenance' | 'unvalidatable-provenance';

/**
 * A recorded rejection of a `Verified` claim at the Display_Layer (Req 14.15).
 *
 * This is sanitized by construction: it carries only a fixed reason code, the
 * artifact identity, and the offending span reference ONLY when that reference is
 * a well-formed identifier (otherwise `null`), so no untrusted free-form string
 * from the stream is propagated into the Trace.
 */
export interface ProvenanceDiscrepancy {
  /** Fixed discriminator so a Trace consumer can filter these events. */
  readonly kind: 'display-layer-provenance-rejected';
  /** The artifact whose `Verified` claim was rejected. */
  readonly artifactRef: ArtifactRef;
  /** The tier the rejected label claimed; always `Verified` for a rejection. */
  readonly claimedTier: 'Verified';
  /** The classified reason the claim failed the fail-closed check. */
  readonly reason: DiscrepancyReason;
  /** The offending span reference, included only when it is a valid identifier. */
  readonly rejectedOracleSpanRef: string | null;
}

/**
 * The port the Display_Layer uses to emit a discrepancy into the session Trace.
 *
 * `emit` is fire-and-forget and MUST NOT throw or block: rendering never waits on
 * Trace persistence, and a persistence fault must not corrupt the fail-closed
 * decision (which has already been made before `emit` is called). The composition
 * root supplies an adapter that forwards to the Action_Recorder and absorbs its
 * own asynchrony and errors; this interface deliberately hides that inward
 * dependency from the web layer.
 */
export interface DiscrepancyEmitPort {
  emit(discrepancy: ProvenanceDiscrepancy): void;
}
