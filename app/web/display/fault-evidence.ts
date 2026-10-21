// Observational fault evidence for a student, gated on attribution availability
// (C19, Req 10.2, 13.10).
//
// Layering: `@app/web` may only depend inward on `@app/api` (and deeper); it must
// never import `@app/agent`, so the peer counts and the gate status arrive as
// plain data mirroring `FailingPairPeers`/`AttributionStatus` from
// `app/agent/consensus/{run-matrix,trust-vote}.ts`, the same pattern
// `signature-to-wavejson.ts` already uses for a Waveform_Signature sample row.
//
// This renders what was OBSERVED (how many peers agreed), never a verdict
// ("TESTBENCH") or an abstention label ("ABSTAIN"), because a `FaultVerdict` is
// 65.7%-abstaining and 99.5% accurate only where it is available at all, and a
// verdict shown to a student reads as a conclusion no matter how it is qualified.

/** Mirrors `FailingPairPeers` (`app/agent/consensus/run-matrix.ts`) field-for-field. */
export interface FaultEvidencePeers {
  readonly peerPassCount: number;
  readonly peerDesignCount: number;
  readonly peerTestbenchPassCount: number;
  readonly peerTestbenchCount: number;
}

/** Mirrors `AttributionStatus` (`app/agent/consensus/trust-vote.ts`). */
export type FaultEvidenceAttributionStatus = 'advisory' | 'actionable';

/** The peer counts and gate status for one failing (design, testbench) pair. */
export interface FaultEvidenceInput {
  readonly status: FaultEvidenceAttributionStatus;
  readonly peers: FaultEvidencePeers;
}

/**
 * Render the peer counts as an observation, or `null` below the gate.
 *
 * Only `actionable` renders: that is the same status the repair trigger reads
 * (Req 10.2), so the surface and the loop never disagree about availability. The
 * counts are read straight from `peers` with no recomputation, so there is no
 * second computation to drift from the `AttributedPair` they came from.
 */
export function renderFaultEvidence(input: FaultEvidenceInput): string | null {
  if (input.status !== 'actionable') {
    return null;
  }
  const { peerPassCount, peerDesignCount } = input.peers;
  return `${peerPassCount} of the other ${peerDesignCount} designs passed this same check.`;
}
