// The Fault_Attributor (C13): the measured, model-free predictor that assigns
// one Fault_Verdict to a failing Candidate_Design x Reference_Model_Testbench
// pair (Req 9.1 to 9.7, 9.11).
//
// Four numbers in, one of three values out. There is no parameter for RTL
// source, for a reference design, or for a golden verdict, so the restriction
// on what this function can read is structural rather than a rule its body
// happens to follow (Req 9.7). The pair itself is excluded from both shares by
// the shape of `FailingPairPeers`: the caller derives it from the Run_Matrix
// row and column with the pair's own cell dropped (`peersOf` in
// `./run-matrix.js`), so a pair cannot contribute to its own attribution
// (Req 9.5).
//
// The Peer_Floor is checked before either share comparison, which is what
// keeps the measured accuracies inside the condition they were measured
// under: a small pool can never reach the share comparisons at all (Req 9.6).
// At N = 8 a pair always has 7 peers on each side, so the floor binds only
// once provider failures shrink a pool.
//
// Both share comparisons are strict, so a share of exactly one half returns
// `ABSTAIN` under both clauses. That is the conservative direction and is the
// measured failure mode: the predictor abstains on 65.7% of failures, calls
// TESTBENCH on 27.7% and is right on 99.5% of those, and calls RTL on 6.6% and
// is right on 90.4%. `ABSTAIN` is a first-class union member rather than a
// null verdict, which is what makes that 65.7% abstention rate a reportable
// outcome instead of missing data. Req 9.11 forbids editing anything from an
// `ABSTAIN`; C15 enforces that downstream by taking only a `TESTBENCH` verdict
// as its repair trigger.

import type { FailingPairPeers } from './run-matrix.js';

export type { FailingPairPeers };

/** The closed set a failing pair's attribution is drawn from (Req 9.1). */
export type FaultVerdict = 'RTL' | 'TESTBENCH' | 'ABSTAIN';

/** MEASURED: the floor the 99.5% and 90.4% accuracies were measured under, so scaling it with N has nothing behind it. */
export const PEER_FLOOR = 3;

/**
 * Attribute a failing pair's fault from its peer counts alone (Req 9.1 to 9.6).
 *
 * Pure and total: every finite `FailingPairPeers` maps to exactly one
 * `FaultVerdict`, with `ABSTAIN` as the result whenever the Peer_Floor is not
 * met on both sides or neither share clears strictly past half.
 */
export function attributeFault(peers: FailingPairPeers): FaultVerdict {
  if (peers.peerDesignCount < PEER_FLOOR || peers.peerTestbenchCount < PEER_FLOOR) {
    return 'ABSTAIN';
  }

  const peerPassShare = peers.peerPassCount / peers.peerDesignCount;
  const peerTestbenchShare = peers.peerTestbenchPassCount / peers.peerTestbenchCount;

  if (peerPassShare > 0.5 && peerTestbenchShare < 0.5) {
    return 'RTL';
  }
  if (peerPassShare < 0.5 && peerTestbenchShare > 0.5) {
    return 'TESTBENCH';
  }
  return 'ABSTAIN';
}
