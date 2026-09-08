// Teach_Mode pure grounding core (Requirements 11.2-11.9).
//
// This module holds the parts of Teach_Mode that need no I/O: the per-claim
// grounding decision, the mandatory `Verified`-result presentation, the
// failing-case coaching, and the pure assembly of a whole explanation. Keeping this
// logic free of the Model_Router and Action_Recorder makes the numbered Property 25
// (teach-mode grounds each claim by its type, task 16.5) and the example tests
// (task 16.6) trivial to state directly against these functions.
//
// THE GROUNDING RULE, encoded once here (Req 11.2, 11.3, 11.6, 11.7, 11.9):
//   - a `design` claim is taught only if it references verified tool output that
//     actually resolves in the session (an oracle verdict, a recorded Trace span,
//     or a signal read from the session waveform);
//   - a `general` fact is taught only if it carries a citation that the session
//     actually retrieved (reusing the Knowledge_Retriever's Cited-vs-Unverified
//     derivation, `presentExternalFact`, as the single source of that decision);
//   - a claim lacking its appropriate grounding is labeled `Unverified` or, when
//     there is nothing to teach (an empty statement), is not taught at all.
// The two grounding types may appear together in one explanation (Req 11.8).

import {
  notApplicable,
  unverified,
  type ArtifactRef,
  type Citation,
  type NotApplicableArtifact,
  type Ulid,
  type Verdict,
} from '@app/core';
import { presentExternalFact } from '@app/knowledge';

import {
  SIMULATION_VS_SILICON_LIMIT,
  type ClaimDecision,
  type ClaimKind,
  type Explanation,
  type FailingCaseCoaching,
  type ProposedClaim,
  type ProposedDesignClaim,
  type ProposedGeneralFact,
  type TeachModeError,
  type TeachModeErrorCode,
  type TeachSession,
  type ToolOutputRef,
  type UnverifiedClaim,
  type VerifiedResultPresentation,
} from './types.js';

/** The first version number assigned to a freshly created explanation artifact. */
export const FIRST_EXPLANATION_VERSION = 1 as const;

/** Build a sanitized Teach_Mode error value. */
export function teachModeError(
  code: TeachModeErrorCode,
  message: string,
  budgetStopReason?: TeachModeError['budgetStopReason'],
): TeachModeError {
  return budgetStopReason === undefined ? { code, message } : { code, message, budgetStopReason };
}

/** The artifact reference for an explanation version (kind `explanation`). */
export function explanationArtifactRef(id: Ulid, version: number): ArtifactRef {
  return { kind: 'explanation', id, version };
}

/** The `Not_Applicable` label for an explanation artifact (pedagogy; Req 11 intro). */
export function explanationArtifactLabel(id: Ulid, version: number): NotApplicableArtifact {
  return notApplicable(explanationArtifactRef(id, version));
}

/**
 * Whether a design claim's tool-output reference resolves against the session.
 *
 * A design claim is grounded only in verified tool output that actually exists in
 * the session (Req 11.1, 11.2): the named verification result and its oracle span,
 * a recorded Trace span, or a signal present in the session waveform. Any reference
 * to an artifact the session does not have is unresolved, so it cannot ground a
 * claim - Teach_Mode cannot invent an artifact.
 */
export function toolOutputRefResolves(ref: ToolOutputRef, session: TeachSession): boolean {
  switch (ref.kind) {
    case 'oracle-verdict': {
      const verification = session.verification;
      return (
        verification !== null &&
        ref.verificationResultId === verification.id &&
        ref.oracleSpanId === verification.oracleSpanId
      );
    }
    case 'trace-span':
      return session.traceSpanIds.includes(ref.spanId);
    case 'waveform-reading': {
      const waveform = session.waveform;
      return (
        waveform !== null &&
        ref.waveformArtifactId === waveform.waveformArtifactId &&
        waveform.signals.includes(ref.signal)
      );
    }
    default: {
      const unreachable: never = ref;
      return unreachable;
    }
  }
}

/** Whether a citation matches one the session actually retrieved (Req 13.5). */
function citationAvailable(citation: Citation, session: TeachSession): boolean {
  return session.availableCitations.some(
    (available) =>
      available.sourceUrl === citation.sourceUrl && available.sourceTitle === citation.sourceTitle,
  );
}

/** Build the `Unverified` disposition for a claim that lacks appropriate grounding. */
function unverifiedClaim(
  kind: ClaimKind,
  statement: string,
  explanationRef: ArtifactRef,
): UnverifiedClaim {
  return { kind, disposition: 'unverified', statement, label: unverified(explanationRef) };
}

/** Ground one design claim in verified tool output, else label it `Unverified`. */
function groundDesignClaim(
  claim: ProposedDesignClaim,
  statement: string,
  session: TeachSession,
  explanationRef: ArtifactRef,
): ClaimDecision {
  if (claim.grounding !== null && toolOutputRefResolves(claim.grounding, session)) {
    return { kind: 'design', disposition: 'taught', statement, grounding: claim.grounding };
  }
  return unverifiedClaim('design', statement, explanationRef);
}

/** Ground one general fact in a session citation, else label it `Unverified`. */
function groundGeneralFact(
  claim: ProposedGeneralFact,
  statement: string,
  session: TeachSession,
  explanationRef: ArtifactRef,
): ClaimDecision {
  const grounded = claim.citation !== null && citationAvailable(claim.citation, session);
  const presented = presentExternalFact(
    statement,
    grounded ? (claim.citation ?? undefined) : undefined,
  );
  if (presented.presentation === 'Cited') {
    return { kind: 'general', disposition: 'taught', statement, citation: presented.citation };
  }
  return unverifiedClaim('general', statement, explanationRef);
}

/**
 * Decide the disposition of one proposed claim (Req 11.2, 11.3, 11.6, 11.9).
 *
 * An empty statement is omitted (nothing to teach). Otherwise the claim is grounded
 * by its own type - a design claim in verified tool output, a general fact in a
 * session citation - and any claim lacking that grounding is labeled `Unverified`.
 * The decision is total and pure, so Property 25 states directly over it.
 */
export function groundClaim(
  claim: ProposedClaim,
  session: TeachSession,
  explanationRef: ArtifactRef,
): ClaimDecision {
  const statement = claim.statement.trim();
  if (statement.length === 0) {
    return {
      kind: claim.kind,
      disposition: 'omitted',
      statement: claim.statement,
      reason: 'empty claim',
    };
  }
  if (claim.kind === 'design') {
    return groundDesignClaim(claim, statement, session, explanationRef);
  }
  return groundGeneralFact(claim, statement, session, explanationRef);
}

/** Ground every proposed claim, preserving order (Req 11.8: mixed types allowed). */
export function groundClaims(
  claims: readonly ProposedClaim[],
  session: TeachSession,
  explanationRef: ArtifactRef,
): readonly ClaimDecision[] {
  return claims.map((claim) => groundClaim(claim, session, explanationRef));
}

/**
 * Present the module's `Verified` result with its mandatory limit, or `null`.
 *
 * A Verified result is presented only when the module is actually labeled `Verified`
 * and a passing oracle verdict backs it (Req 8.3), so the presentation is grounded in
 * that verdict and can never be fabricated. When present it ALWAYS states the
 * simulation-vs-silicon limit (Req 11.5), which the type makes non-omittable.
 */
export function presentVerifiedResult(session: TeachSession): VerifiedResultPresentation | null {
  const label = session.moduleLabel;
  const verification = session.verification;
  if (label.tier !== 'Verified' || verification === null || verification.verdict !== 'pass') {
    return null;
  }
  return {
    verdict: 'pass',
    label,
    simulationVsSiliconLimit: SIMULATION_VS_SILICON_LIMIT,
    grounding: {
      kind: 'oracle-verdict',
      verificationResultId: verification.id,
      oracleSpanId: verification.oracleSpanId,
    },
  };
}

/** Build constructive, non-hiding guidance from a non-passing verdict (Req 11.4). */
function buildCoachingGuidance(verdict: Exclude<Verdict, 'pass'>, session: TeachSession): string {
  const failingCase = session.verification?.failingCase ?? null;
  if (verdict === 'error') {
    return (
      'Verification could not complete because of a tool or infrastructure error, so ' +
      'correctness is undetermined - this is not a functional failure of your design. ' +
      'Re-run the verification; if it recurs, inspect the recorded run for the tool error.'
    );
  }
  if (failingCase === null) {
    return (
      'The design did not pass the spec-derived testbench. Review the recorded oracle ' +
      'run to see which checks failed, then adjust the design to satisfy them.'
    );
  }
  const timing = failingCase.atSimTimeNs === null ? '' : ` at t=${failingCase.atSimTimeNs}ns`;
  return (
    `The check "${failingCase.checkName}" failed${timing}: it expected ${failingCase.expected} ` +
    `but the simulation observed ${failingCase.observed}. Focus your fix on the logic that ` +
    `drives this behavior; do not change the testbench, which is derived independently from the Spec.`
  );
}

/**
 * Coach on the failing case when verification did not pass (Req 11.4, 11.8).
 *
 * Returns `null` when the module passed or has no recorded verdict. Otherwise it
 * explains the failure constructively, grounded in the oracle verdict span, so the
 * failure is surfaced and diagnosable rather than hidden.
 */
export function coachFailingCase(session: TeachSession): FailingCaseCoaching | null {
  const verification = session.verification;
  if (verification === null || verification.verdict === 'pass') {
    return null;
  }
  const verdict: Exclude<Verdict, 'pass'> = verification.verdict;
  return {
    verdict,
    failingCase: verification.failingCase ?? null,
    guidance: buildCoachingGuidance(verdict, session),
    grounding: {
      kind: 'oracle-verdict',
      verificationResultId: verification.id,
      oracleSpanId: verification.oracleSpanId,
    },
  };
}

/**
 * Assemble a whole grounded explanation from proposed claims and the session.
 *
 * Pure and total: it grounds each claim by type, presents a `Verified` result with
 * its mandatory limit when one exists, and coaches on the failing case on a non-pass.
 * The explanation artifact is `Not_Applicable`; its claims carry their own grounding.
 */
export function assembleExplanation(
  session: TeachSession,
  proposed: readonly ProposedClaim[],
  explanationId: Ulid,
): Explanation {
  const explanationRef = explanationArtifactRef(explanationId, FIRST_EXPLANATION_VERSION);
  return {
    sessionId: session.sessionId,
    artifact: notApplicable(explanationRef),
    claims: groundClaims(proposed, session, explanationRef),
    verifiedResult: presentVerifiedResult(session),
    coaching: coachFailingCase(session),
  };
}
