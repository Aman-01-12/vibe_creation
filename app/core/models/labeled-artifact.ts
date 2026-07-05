// Trust labeling and citation presentation.
//
// Invariant encoded here: an oracle-provenance reference is present if and only
// if the tier is `Verified` (Req 14.8, 14.12). This is made unrepresentable at
// compile time by modelling `LabeledArtifact` as a discriminated union on `tier`:
// only the `Verified` member has `oracleSpanRef`, and it is required there. A
// `Verified` artifact without provenance, or an `Unverified`/`Not_Applicable`
// artifact carrying provenance, does not type-check. The smart constructors
// additionally reject an empty/invalid span reference at construction time.
//
// Only the Trust_Labeler (task 8.3) may derive these labels from a recorded
// oracle verdict; there is deliberately no writable `verified` boolean anywhere.

import { domainError, type DomainError } from './domain-error.js';
import type { TrustTier } from './enums.js';
import { isUlid, type Ulid } from './identifier.js';
import { err, ok, type Result } from './result.js';

/**
 * A reference to a versioned artifact whose trust is being labeled.
 *
 * `version` is significant: `Verified` is derived from a passing oracle verdict
 * for the artifact's current version, so the version travels with the reference.
 *
 * Note: the design references `ArtifactRef` without fixing its fields; this
 * minimal shape (kind, id, version) is the decision for this slice.
 */
export interface ArtifactRef {
  readonly kind: ArtifactKind;
  readonly id: Ulid;
  readonly version: number;
}

/** The kinds of artifact that can be labeled or referenced. */
export type ArtifactKind =
  | 'intent'
  | 'spec'
  | 'testbench'
  | 'module-version'
  | 'verification-result'
  | 'waveform'
  | 'schematic'
  | 'explanation';

/** A `Verified` label: carries the oracle span that proves it. */
export interface VerifiedArtifact {
  readonly artifactRef: ArtifactRef;
  readonly tier: 'Verified';
  /** Required: the passing oracle verdict span this label is bound to. */
  readonly oracleSpanRef: Ulid;
}

/** An `Unverified` label: no passing oracle verdict exists yet. */
export interface UnverifiedArtifact {
  readonly artifactRef: ArtifactRef;
  readonly tier: 'Unverified';
}

/** A `Not_Applicable` label: an input or pedagogy artifact. */
export interface NotApplicableArtifact {
  readonly artifactRef: ArtifactRef;
  readonly tier: 'Not_Applicable';
}

/**
 * An artifact tagged with its trust tier.
 *
 * Provenance is present exactly on the `Verified` arm (Req 14.8, 14.12).
 */
export type LabeledArtifact = VerifiedArtifact | UnverifiedArtifact | NotApplicableArtifact;

/**
 * Label an artifact `Verified`, binding it to a passing oracle verdict span.
 *
 * Rejects an empty or non-ULID span reference so a `Verified` label can never
 * carry unusable provenance.
 */
export function verified(
  artifactRef: ArtifactRef,
  oracleSpanRef: Ulid,
): Result<VerifiedArtifact, DomainError> {
  if (!isUlid(oracleSpanRef)) {
    return err(
      domainError(
        'VERIFIED_REQUIRES_ORACLE_SPAN_REF',
        'A Verified label requires a valid oracle span reference',
        'oracleSpanRef',
      ),
    );
  }
  return ok({ artifactRef, tier: 'Verified', oracleSpanRef });
}

/** Label an artifact `Unverified`. */
export function unverified(artifactRef: ArtifactRef): UnverifiedArtifact {
  return { artifactRef, tier: 'Unverified' };
}

/** Label an artifact `Not_Applicable`. */
export function notApplicable(artifactRef: ArtifactRef): NotApplicableArtifact {
  return { artifactRef, tier: 'Not_Applicable' };
}

/** Narrow a `TrustTier` to whether it demands oracle provenance. */
export function tierRequiresProvenance(tier: TrustTier): boolean {
  return tier === 'Verified';
}

/**
 * An external fact shown with its attributed source.
 *
 * `Cited` is a presentation treatment distinct from the `TrustTier` scale
 * (Req 13.7, 13.10): a cited fact is neither `Verified` nor `Unverified`.
 */
export interface Citation {
  readonly claim: string;
  readonly sourceUrl: string;
  readonly sourceTitle: string;
  readonly presentation: 'cited';
}
