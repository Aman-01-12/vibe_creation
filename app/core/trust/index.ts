// Trust_Labeler and the TrustTier -> visual treatment mapping (task 8.3).
//
// The Trust_Labeler is the ONLY path to a `Verified` label, and it derives that
// label solely from recorded oracle verdict evidence (Req 14.2, 14.7, 14.8, 14.9):
//
//   - `Verified` iff a recorded passing oracle verdict exists for the artifact's
//     CURRENT version, and the label is bound to that verdict's oracle span id.
//   - `Unverified` when no such passing verdict exists for the current version -
//     including a design verified at an older version and since edited, because
//     the evidence must match the artifact's version exactly (Req 14.3, 10.7).
//   - `Not_Applicable` for input/pedagogy artifacts (intent, spec, testbench,
//     explanation), a fixed classification by artifact kind (Req 14.4).
//
// There is deliberately no writable `verified` boolean anywhere: this module
// exposes no setter and holds no mutable state. A `Verified` label can only be
// obtained through `labelArtifact` bound to a real passing span, and the union in
// `../models/labeled-artifact.ts` makes a provenance-free `Verified` value
// unrepresentable (Req 8.3, 14.12). Model output can never confer `Verified`
// because the labeler consults only recorded oracle verdicts, never a
// self-assessed signal (Req 14.9).
//
// This module is pure: the caller supplies the recorded evidence (assembled from
// the Trace / Project_Store in an outer layer), so there is no I/O in core.
// Evidence is accepted in either of two equivalent recorded forms - a lightweight
// `OracleVerdictSpan` taken straight from the Trace, or a full `OracleEvidence`
// wrapping a validated `VerificationResult` - so callers can pass whichever they
// already hold without an extra adaptation step. The formal Property 1 and
// Property 3 tests land in tasks 8.4 and 8.5; this file provides the labeler and
// the injective treatment mapping they pin down.

import type { TrustTier, Verdict } from '../models/enums.js';
import type { Ulid } from '../models/identifier.js';
import {
  notApplicable,
  unverified,
  verified,
  type ArtifactKind,
  type ArtifactRef,
  type LabeledArtifact,
} from '../models/labeled-artifact.js';
import { isOk } from '../models/result.js';
import type { VerificationResult } from '../models/verification.js';

/**
 * A recorded oracle verdict span for a specific artifact version, taken directly
 * from the session Trace.
 *
 * `artifactRef` is the exact artifact version the verdict was recorded against,
 * so a verdict for an older version never matches a query for the current version
 * (Req 14.3, 10.7). A `verdict` of `pass` denotes a recorded passing oracle
 * verdict (pass integrity is enforced upstream, in `@app/core/verdict` and
 * `makeVerificationResult`, before a `pass` span is ever recorded).
 */
export interface OracleVerdictSpan {
  /** The Trace span id that IS the ground truth for this verdict. */
  readonly spanId: Ulid;
  /** The exact artifact (kind, id, version) this verdict judged. */
  readonly artifactRef: ArtifactRef;
  /** The recorded verdict for that artifact version. */
  readonly verdict: Verdict;
}

/**
 * A recorded oracle verdict paired with the exact artifact version it judged,
 * carrying the full validated `VerificationResult`.
 *
 * Preferred when the caller already holds the `VerificationResult`: the labeler
 * re-checks the pass condition on the result itself, so a forged passing flag
 * cannot slip through.
 */
export interface OracleEvidence {
  /** The exact artifact (kind, id, version) this verdict judged. */
  readonly artifactRef: ArtifactRef;
  /** The recorded verdict for that artifact version. */
  readonly result: VerificationResult;
}

/** Recorded oracle evidence in either accepted form. */
export type LabelingEvidence = OracleVerdictSpan | OracleEvidence;

/** Every trust tier, in a stable order, for exhaustive mapping and iteration. */
export const TRUST_TIERS = [
  'Verified',
  'Unverified',
  'Not_Applicable',
] as const satisfies readonly TrustTier[];

/**
 * Artifact kinds that belong to an input or pedagogy stage and make no
 * correctness claim, so they are always `Not_Applicable` (Req 14.4).
 */
const INPUT_OR_PEDAGOGY_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  'intent',
  'spec',
  'testbench',
  'explanation',
]);

/** Whether an artifact kind is an input or pedagogy artifact (Req 14.4). */
function isInputOrPedagogyKind(kind: ArtifactKind): boolean {
  return INPUT_OR_PEDAGOGY_KINDS.has(kind);
}

/** The pass claim distilled from a piece of evidence, regardless of its form. */
interface PassClaim {
  readonly artifactRef: ArtifactRef;
  readonly oracleSpanId: Ulid;
  readonly passing: boolean;
}

/**
 * Distil a pass claim from evidence in either accepted form.
 *
 * For a full `VerificationResult` both `verdict` and `allChecksPassed` are checked
 * as defense in depth (a `pass` result is guaranteed well-formed by its
 * constructor, but a hand-built literal cannot smuggle a `pass` past this check).
 * For a raw span, a `pass` verdict is the recorded passing signal (Req 8.10, 14.2).
 */
function toPassClaim(evidence: LabelingEvidence): PassClaim {
  if ('result' in evidence) {
    const { result } = evidence;
    return {
      artifactRef: evidence.artifactRef,
      oracleSpanId: result.oracleSpanId,
      passing: result.verdict === 'pass' && result.allChecksPassed === true,
    };
  }
  return {
    artifactRef: evidence.artifactRef,
    oracleSpanId: evidence.spanId,
    passing: evidence.verdict === 'pass',
  };
}

/** Whether two artifact references denote the same artifact at the same version. */
function sameArtifactVersion(a: ArtifactRef, b: ArtifactRef): boolean {
  return a.kind === b.kind && a.id === b.id && a.version === b.version;
}

/**
 * Find the first passing oracle verdict recorded for this exact artifact version.
 *
 * Matching is by (kind, id, version) AND a passing verdict, so a verdict for an
 * older version, or a non-passing verdict, is never accepted as justification.
 */
function findPassingClaim(
  artifactRef: ArtifactRef,
  evidence: readonly LabelingEvidence[],
): PassClaim | undefined {
  return evidence
    .map(toPassClaim)
    .find((claim) => claim.passing && sameArtifactVersion(claim.artifactRef, artifactRef));
}

/**
 * Derive the trust label for an artifact from recorded oracle evidence.
 *
 * Assigns `Not_Applicable` to input/pedagogy artifacts by kind (Req 14.4);
 * otherwise assigns `Verified` if and only if a recorded passing oracle verdict
 * exists for the artifact's current version, binding the label to that verdict's
 * oracle span id (Req 14.2, 14.8), and `Unverified` when none exists (Req 14.3).
 *
 * Fails closed: if a matched passing verdict carries an unusable (non-ULID) oracle
 * span id, the artifact is labeled `Unverified` rather than `Verified` without
 * valid provenance (Req 14.8, 14.12).
 */
export function labelArtifact(
  artifactRef: ArtifactRef,
  evidence: readonly LabelingEvidence[],
): LabeledArtifact {
  if (isInputOrPedagogyKind(artifactRef.kind)) {
    return notApplicable(artifactRef);
  }

  const passing = findPassingClaim(artifactRef, evidence);
  if (passing === undefined) {
    return unverified(artifactRef);
  }

  const label = verified(artifactRef, passing.oracleSpanId);
  return isOk(label) ? label.value : unverified(artifactRef);
}

/**
 * The oracle-derived Trust_Labeler, matching the design's `TrustLabeler` port.
 *
 * Injected wherever a labeler is needed so callers depend on this interface, not
 * on the free function; its behavior is identical to `labelArtifact`.
 */
export interface TrustLabeler {
  label(artifactRef: ArtifactRef, evidence: readonly LabelingEvidence[]): LabeledArtifact;
}

/** The single oracle-derived Trust_Labeler instance. */
export const oracleTrustLabeler: TrustLabeler = {
  label: labelArtifact,
};

/**
 * The distinct visual treatment applied to each `TrustTier`.
 *
 * These are opaque treatment identifiers; the web Display_Layer (task 15.1) maps
 * them to concrete styling. They exist here so the tier -> treatment mapping is a
 * single, injective source of truth in the pure core.
 */
export type TrustTreatment =
  'verified-treatment' | 'unverified-treatment' | 'not-applicable-treatment';

/**
 * The injective `TrustTier` -> `TrustTreatment` mapping (Req 14.6, 14.10).
 *
 * Each tier maps to a distinct treatment, so `Verified`, `Unverified`, and
 * `Not_Applicable` are mutually unmistakable. The `verified-treatment` value
 * appears only for the `Verified` tier, reserving it exclusively to `Verified`
 * artifacts. Being a total `Record` over the closed `TrustTier` union, the
 * mapping is exhaustive and adding a tier without a treatment fails the type
 * check.
 */
export const TRUST_TIER_TREATMENTS: Readonly<Record<TrustTier, TrustTreatment>> = {
  Verified: 'verified-treatment',
  Unverified: 'unverified-treatment',
  Not_Applicable: 'not-applicable-treatment',
};

/** The visual treatment reserved for `Verified` artifacts (Req 14.6). */
export const VERIFIED_TREATMENT: TrustTreatment = TRUST_TIER_TREATMENTS.Verified;

/** Resolve a trust tier to its distinct visual treatment (Req 14.10). */
export function treatmentForTier(tier: TrustTier): TrustTreatment {
  return TRUST_TIER_TREATMENTS[tier];
}

/**
 * Resolve a labeled artifact to the visual treatment of its own tier.
 *
 * A `Not_Applicable` pedagogy artifact therefore keeps its own treatment even
 * when it references a `Verified` artifact, because the treatment is derived from
 * the artifact's own tier, not from anything it points at (Req 14.11).
 */
export function treatmentForArtifact(labeled: LabeledArtifact): TrustTreatment {
  return treatmentForTier(labeled.tier);
}

/**
 * Whether a treatment is the `Verified` treatment.
 *
 * Lets the Display_Layer (task 15.1) assert the exclusivity invariant - that the
 * `Verified` treatment is only ever produced for the `Verified` tier (Req 14.6).
 */
export function isVerifiedTreatment(treatment: TrustTreatment): boolean {
  return treatment === VERIFIED_TREATMENT;
}
