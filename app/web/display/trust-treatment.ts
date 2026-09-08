// The Display_Layer's fail-closed trust-treatment decision (Design: Display_Layer
// fail-closed check; Req 14.13, 14.14, 14.15). This is the pure, rendering-free
// core that Property 2 (task 15.2) states over directly.
//
// Contract: the `Verified` visual treatment is applied ONLY when the label is
// `Verified` AND its oracle-provenance reference is present, well-formed, and
// validates against the Trace evidence (a matching PASSING oracle verdict for the
// artifact's CURRENT version). In every other case the artifact is rendered with
// the `Unverified` treatment - the decision fails closed toward less trust, never
// toward more (Req 14.14). A rejected `Verified` claim yields a discrepancy so the
// caller can record it in the Trace (Req 14.15).
//
// This is an integrity check on the label's EVIDENCE, not a re-derivation of
// correctness: it never runs a simulator and never inspects RTL. It only confirms
// that the recorded oracle verdict the label points at actually exists and passes
// for the exact artifact version being displayed.
//
// Security posture: the label and its provenance reference arrive from the SSE
// stream and are UNTRUSTED. `decideTrustTreatment` therefore accepts `unknown` and
// validates the shape at this boundary; malformed input can never yield the
// `Verified` treatment.

import {
  isUlid,
  treatmentForTier,
  type ArtifactKind,
  type ArtifactRef,
  type OracleVerdictSpan,
  type TrustTier,
  type TrustTreatment,
} from '@app/core';

import type { DiscrepancyReason, ProvenanceDiscrepancy } from './discrepancy.js';

/**
 * The Display_Layer's resolved decision for one artifact.
 *
 * `tier` is the tier actually rendered (never `Verified` without valid
 * provenance) and travels with the model so the Trust_Tier is visible wherever
 * the artifact is displayed (Req 14.5). `treatment` is that tier's distinct
 * visual treatment from the core injective mapping. `discrepancy` is present iff a
 * `Verified` claim was rejected and must be recorded in the Trace (Req 14.15).
 */
export interface TrustTreatmentDecision {
  readonly artifactRef: ArtifactRef | null;
  readonly tier: TrustTier;
  readonly treatment: TrustTreatment;
  readonly discrepancy: ProvenanceDiscrepancy | null;
}

/** The set of artifact kinds, used to validate an untrusted `kind` field. */
const ARTIFACT_KINDS: ReadonlySet<string> = new Set<ArtifactKind>([
  'intent',
  'spec',
  'testbench',
  'module-version',
  'verification-result',
  'waveform',
  'schematic',
  'explanation',
]);

/** A trust claim distilled from the untrusted label, once its shape is validated. */
type TrustClaim =
  | {
      readonly kind: 'verified-claim';
      readonly artifactRef: ArtifactRef;
      readonly oracleSpanRef: unknown;
    }
  | {
      readonly kind: 'plain';
      readonly artifactRef: ArtifactRef;
      readonly tier: 'Unverified' | 'Not_Applicable';
    }
  | { readonly kind: 'unreadable' };

/** Safely read a property off an unknown value without throwing. */
function readField(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

/** Validate an untrusted `artifactRef`, or return null if it is not well-formed. */
function readArtifactRef(value: unknown): ArtifactRef | null {
  const kind = readField(value, 'kind');
  const id = readField(value, 'id');
  const version = readField(value, 'version');
  if (typeof kind !== 'string' || !ARTIFACT_KINDS.has(kind)) {
    return null;
  }
  if (typeof id !== 'string' || !isUlid(id)) {
    return null;
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    return null;
  }
  return { kind: kind as ArtifactKind, id, version };
}

/**
 * Narrow the untrusted label into a `TrustClaim`.
 *
 * A claim is only actionable once its artifact identity is readable; without it
 * the label is treated as `unreadable` (junk) and fails closed with no
 * discrepancy, since no coherent `Verified` claim can be attributed to it.
 */
function readTrustClaim(rawLabel: unknown): TrustClaim {
  const artifactRef = readArtifactRef(readField(rawLabel, 'artifactRef'));
  if (artifactRef === null) {
    return { kind: 'unreadable' };
  }
  const tier = readField(rawLabel, 'tier');
  if (tier === 'Verified') {
    return {
      kind: 'verified-claim',
      artifactRef,
      oracleSpanRef: readField(rawLabel, 'oracleSpanRef'),
    };
  }
  if (tier === 'Unverified' || tier === 'Not_Applicable') {
    return { kind: 'plain', artifactRef, tier };
  }
  return { kind: 'unreadable' };
}

/** Whether two artifact references denote the same artifact at the same version. */
function sameArtifactVersion(a: ArtifactRef, b: ArtifactRef): boolean {
  return a.kind === b.kind && a.id === b.id && a.version === b.version;
}

/**
 * Whether the Trace evidence holds a passing oracle verdict recorded under this
 * span reference for this exact artifact version.
 *
 * Matching requires all three: the recorded span id equals the label's reference,
 * the recorded verdict is `pass`, and the verdict judged this exact version. A
 * verdict for an older version, or a non-passing verdict, never validates the
 * label (Req 14.3, 14.13).
 */
function hasMatchingPassingSpan(
  artifactRef: ArtifactRef,
  oracleSpanRef: string,
  evidence: readonly OracleVerdictSpan[],
): boolean {
  return evidence.some(
    (span) =>
      span.verdict === 'pass' &&
      span.spanId === oracleSpanRef &&
      sameArtifactVersion(span.artifactRef, artifactRef),
  );
}

/** Build the fail-closed `Unverified` decision, optionally carrying a discrepancy. */
function failClosed(
  artifactRef: ArtifactRef | null,
  discrepancy: ProvenanceDiscrepancy | null,
): TrustTreatmentDecision {
  return {
    artifactRef,
    tier: 'Unverified',
    treatment: treatmentForTier('Unverified'),
    discrepancy,
  };
}

/** Build a discrepancy for a rejected `Verified` claim (Req 14.15). */
function rejection(
  artifactRef: ArtifactRef,
  reason: DiscrepancyReason,
  rejectedOracleSpanRef: string | null,
): ProvenanceDiscrepancy {
  return {
    kind: 'display-layer-provenance-rejected',
    artifactRef,
    claimedTier: 'Verified',
    reason,
    rejectedOracleSpanRef,
  };
}

/** Decide a validated `Verified` claim against the Trace evidence. */
function decideVerifiedClaim(
  artifactRef: ArtifactRef,
  oracleSpanRef: unknown,
  evidence: readonly OracleVerdictSpan[],
): TrustTreatmentDecision {
  if (oracleSpanRef === undefined || oracleSpanRef === null || oracleSpanRef === '') {
    return failClosed(artifactRef, rejection(artifactRef, 'missing-provenance', null));
  }
  if (typeof oracleSpanRef !== 'string' || !isUlid(oracleSpanRef)) {
    return failClosed(artifactRef, rejection(artifactRef, 'malformed-provenance', null));
  }
  if (!hasMatchingPassingSpan(artifactRef, oracleSpanRef, evidence)) {
    return failClosed(
      artifactRef,
      rejection(artifactRef, 'unvalidatable-provenance', oracleSpanRef),
    );
  }
  return {
    artifactRef,
    tier: 'Verified',
    treatment: treatmentForTier('Verified'),
    discrepancy: null,
  };
}

/**
 * Decide the trust treatment for an untrusted label against Trace evidence.
 *
 * Pure and total: it performs no I/O and returns exactly one decision for any
 * input, so Property 2 can state over it. The caller (the Display_Layer) is
 * responsible for emitting any returned `discrepancy` into the Trace.
 *
 * @param rawLabel Untrusted label from the stream (any shape).
 * @param evidence Passing/failing oracle verdict spans projected from the Trace.
 */
export function decideTrustTreatment(
  rawLabel: unknown,
  evidence: readonly OracleVerdictSpan[],
): TrustTreatmentDecision {
  const claim = readTrustClaim(rawLabel);
  if (claim.kind === 'unreadable') {
    return failClosed(null, null);
  }
  if (claim.kind === 'plain') {
    return {
      artifactRef: claim.artifactRef,
      tier: claim.tier,
      treatment: treatmentForTier(claim.tier),
      discrepancy: null,
    };
  }
  return decideVerifiedClaim(claim.artifactRef, claim.oracleSpanRef, evidence);
}
