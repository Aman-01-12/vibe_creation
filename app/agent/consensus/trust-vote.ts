// The Trust_Vote, Pool_Correctness, and the attribution status gate (C11, C14;
// Req 8.1, 8.2, 8.3, 8.6, 8.7, 10.1, 10.2, 10.3, 10.4, 10.5).
//
// `trustVote` reads only the pass and fail outcomes of the Run_Matrix (Req 8.3).
// `RunCell` carries no reference design, no golden verdict, and no model
// assertion, so there is no field those could be read from: the restriction is
// structural, not a rule this file's body happens to follow.
//
// Every Candidate_Design votes on every Reference_Model_Testbench, including the
// designs that will later be judged by it (Req 8.6). That is deliberate. The
// anti-circularity rests on a Reference_Model being generated with no access to
// any Candidate_Design (Req 5.10), so a design passing it is evidence rather than
// an echo, and excluding voters would shrink a signal the measurement already
// calls thin at 26.2% of undecided holdout sessions.
//
// THE MUTATION_STRENGTH_GATE OUTCOME ARRIVES AS DATA, NOT AS AN IMPORT
//
//   `trusted` is the conjunction of the vote with a passing Mutation_Strength_Gate
//   outcome (Req 8.2); neither conjunct alone sets it. The real `MutationGateOutcome`
//   union (with its `killed`/`survivors` detail) is defined in C12's
//   `mutation-strength-gate.ts`, built in the same parallel wave as this file. Importing
//   it here would make this file's build depend on that one existing, so the caller
//   passes the outcome in per testbench instead. `MutationGateVote` below names only the
//   `kind` discriminant both files agree on by construction; a later integration task may
//   narrow this parameter to the real union once C12 lands without changing this file's
//   logic.

import type { Ulid } from '@app/core';

import type { RunMatrix } from './run-matrix.js';

/**
 * The minimal fact `trustVote` needs from a Mutation_Strength_Gate outcome: which of
 * the three kinds it was. A testbench absent from the caller's map is treated as
 * `not-run`, which is the fail-safe reading already given to a pool where no peer
 * testbench killed anything (C12): an outcome `trustVote` has not been told about
 * cannot make a testbench trusted.
 */
export interface MutationGateVote {
  readonly kind: 'not-run' | 'passed' | 'failed';
}

/** One Reference_Model_Testbench's Trust_Vote and combined trust outcome (Req 8.7). */
export interface TestbenchTrust {
  readonly testbenchId: Ulid;
  readonly passingDesignCount: number;
  readonly votedTrusted: boolean;
  readonly mutationOutcome: MutationGateVote;
  /** Trusted iff both the vote and the Mutation_Strength_Gate outcome passed (Req 8.2). */
  readonly trusted: boolean;
}

/**
 * Vote every Reference_Model_Testbench of the Run_Matrix trusted or not (Req 8.1,
 * 8.2, 8.3, 8.6).
 *
 * A testbench is voted-trusted when strictly more than half the whole Design_Pool
 * passes it, counting every design the matrix names rather than only the ones with
 * a recorded cell, which is what makes `passed: null` (an incomplete run) fail here
 * exactly as it fails everywhere else it is read (Req 7.7). `trusted` additionally
 * requires `mutationOutcomes` to carry a `'passed'` entry for that testbench; a
 * missing entry reads as `not-run` and keeps `trusted` false.
 *
 * Pure: reads only `matrix.cells` and the supplied `mutationOutcomes`.
 */
export function trustVote(
  matrix: RunMatrix,
  mutationOutcomes: ReadonlyMap<Ulid, MutationGateVote>,
): readonly TestbenchTrust[] {
  const designPoolSize = matrix.designIds.length;

  return matrix.testbenchIds.map((testbenchId) => {
    const passingDesignCount = matrix.cells.filter(
      (cell) => cell.testbenchId === testbenchId && cell.passed === true,
    ).length;
    const votedTrusted = passingDesignCount > designPoolSize / 2;
    const mutationOutcome = mutationOutcomes.get(testbenchId) ?? { kind: 'not-run' };
    const trusted = votedTrusted && mutationOutcome.kind === 'passed';

    return { testbenchId, passingDesignCount, votedTrusted, mutationOutcome, trusted };
  });
}

/**
 * The share of the Testbench_Pool that is a Trusted_Testbench, which feeds the
 * Pool_Correctness gate of C14 (Req 10.1).
 *
 * An empty Testbench_Pool has no trusted share to report; returning 0 rather than
 * `NaN` keeps it on the advisory side of the gate below, which is the fail-safe
 * direction for a pool with nothing in it.
 */
export function poolCorrectness(trust: readonly TestbenchTrust[]): number {
  if (trust.length === 0) {
    return 0;
  }
  const trustedCount = trust.filter((testbench) => testbench.trusted).length;
  return trustedCount / trust.length;
}

/**
 * MEASURED (`.eval-runs/wave-consensus-replay-v1`): the gate sits at 50% on
 * attribution availability, not on session coverage, and the two move in
 * opposite directions near the lower figure a coverage argument would pick.
 *
 * A Fault_Verdict other than ABSTAIN is available on 2.8% of failures at 10%
 * Pool_Correctness, 6.7% at 30%, and 46.8% at 50%.
 * Session coverage, by contrast, saturates near 30%: 53.5% at 15%, 63.5% at 30%,
 * and 64.3% at 50%.
 * A coverage argument would have chosen 30% and been wrong about what this gate
 * is for (Req 10.4, 10.5).
 */
export const ATTRIBUTION_POOL_CORRECTNESS_GATE = 0.5;

/** Whether a Session's attribution may steer repair, or is recorded for review only. */
export type AttributionStatus = 'advisory' | 'actionable';

/**
 * Gate a Session's Fault_Verdicts on its Pool_Correctness (Req 10.2, 10.3).
 *
 * Below the gate every Fault_Verdict is `advisory` and starts no Repair_Attempt.
 * At the gate or above, a `TESTBENCH` verdict is `actionable` and may steer one.
 * A `FaultVerdict` is never consumed without this status: task 11.1's repair
 * trigger takes the pair and the status together, so an advisory verdict has no
 * path into a repair call.
 */
export function attributionStatus(poolCorrectness: number): AttributionStatus {
  return poolCorrectness >= ATTRIBUTION_POOL_CORRECTNESS_GATE ? 'actionable' : 'advisory';
}
