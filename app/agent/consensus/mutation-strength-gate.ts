// The Mutation_Strength_Gate port and the Peer_Calibrated_Mutant_Set production
// adapter (C12; Req 12.1, 12.2, 12.3, 12.5, 12.6, 17.2).
//
// THE PROBLEM, STATED BEFORE THE RESOLUTION
//
//   The existing gate is `judgeCoverageGaps` (`@app/eval/mutation-control.ts`): a
//   Reference_Model_Testbench must kill every valid mutant RTLLM's golden
//   testbench kills, and `mutantWasGoldenKilled` reads that golden verdict
//   directly. Production holds no golden testbench, so importing either function
//   would reintroduce exactly the `@app/eval` dependency Requirement 17 criterion
//   2 forbids. Dropping the gate is ruled out too: 37.2% of the simplest
//   testbenches that pass the reference design cannot kill a planted mutant
//   (Req 12.3), so a design pool that only ran the Trust_Vote would ship
//   testbenches every Candidate_Design merely slips past together.
//
// THE RESOLUTION: THE SAME SUBSTITUTION THE TRUST_VOTE ALREADY MAKES
//
//   The gate's shape is unchanged; only its calibrator moves from the golden
//   testbench to the peer pool. A mutant enters the requirement for the
//   Reference_Model_Testbench under judgment, T, when it compiles, when its
//   unmutated parent Candidate_Design passes T, and when at least one OTHER
//   Reference_Model_Testbench of the pool killed it. T passes the gate when it
//   kills every mutant in that set.
//
//   Three properties carry over from the golden-calibrated gate unchanged:
//     - It is a zero-coverage-gap gate rather than a rate bar, so it cannot hold
//       T to killing a mutant that may be unkillable in principle.
//     - A true equivalent mutant can never enter the requirement, because no
//       peer killed it either - the same argument the golden version makes with
//       the golden judge standing in the peer's place.
//     - The kill rate over every compiled mutant is still carried as a recorded
//       quality signal and is never read by the gate itself.
//
// NO RTL CROSSES THIS SEAM
//
//   `MutationStrengthRequest` carries identities and already-decided booleans,
//   never a design's or a mutant's source text. The mutant run that produces
//   `MutantRunRecord.killedByJudged` (and the peer runs behind `killedByPeer`)
//   already happened by the time `judge` is called, under the existing
//   `mutantRunLimits` substitution task 4.1 relocated to `@app/tools` - the same
//   per-mutant wall-clock cap the golden calibrator uses, so no new limit is
//   introduced here. This file only decides; it runs nothing. That is what keeps
//   `judge` a total, synchronous decision wrapped in a `Promise` for the port's
//   shape, the same discipline `RunCell` and `FailingPairPeers` already hold to
//   (Req 17.2).
//
// `killedByPeer` EXCLUDES THE JUDGED TESTBENCH BY CONSTRUCTION
//
//   The caller computes `killedByPeer` from every Reference_Model_Testbench
//   OTHER than the one under judgment before handing it to `judge`, the same way
//   `peersOf` (run-matrix.ts) drops a pair's own cell from its row and column
//   before the Fault_Attributor ever sees it: the "other" quantifier is the
//   shape of the input, not a filter this adapter is trusted to apply.
//
// A VACUOUS PASS IS THE ONE OUTCOME THIS ADAPTER MUST NOT PRODUCE
//
//   An empty requirement set is not evidence that T is strong; it is evidence
//   that nothing was proven killable for T at all - whether because no mutant
//   compiled, because every compiling mutant's parent already fails T, or
//   because no OTHER testbench in the pool ever killed anything. `not-run` is
//   returned in every one of those cases, which is fail-safe because `not-run`
//   makes `TestbenchTrust.trusted` false (trust-vote.ts) and therefore unmets the
//   `mutation-strength` Grant_Condition (grant.ts) rather than granting on an
//   empty requirement.

import type { Ulid } from '@app/core';
import type { MutantIdentity } from '@app/tools';

/**
 * What the gate made of one Reference_Model_Testbench; a closed set (Req 12.1,
 * 12.2, 12.6).
 *
 * `trust-vote.ts`'s `MutationGateVote` names only this union's `kind`
 * discriminant, so this type stays compatible with what that file already reads
 * without either file importing the other.
 */
export type MutationGateOutcome =
  | { readonly kind: 'not-run' }
  | {
      readonly kind: 'passed';
      /** Every mutant in the requirement set, which T killed in full (Req 12.6). */
      readonly killed: readonly MutantIdentity[];
      /** The kill rate over every compiled mutant; a recorded signal, never the gate. */
      readonly killRate: number | null;
    }
  | {
      readonly kind: 'failed';
      /** Mutants in the requirement set that T did not kill (Req 12.2, 12.6). */
      readonly survivors: readonly MutantIdentity[];
    };

/**
 * One mutant's already-executed facts, exactly as the Peer_Calibrated_Mutant_Set
 * rule needs them, and nothing else.
 *
 * No field here carries RTL, a reference design, or a golden verdict: every
 * value is a boolean a caller already established by running the Design_Pool's
 * and Testbench_Pool's own simulator, never a thing this adapter runs.
 */
export interface MutantRunRecord {
  readonly mutant: MutantIdentity;
  /** Whether the mutant's RTL compiled; a mutant that did not build is never valid. */
  readonly compiled: boolean;
  /** Whether this mutant's unmutated parent Candidate_Design passes the testbench under judgment. */
  readonly parentPassedJudged: boolean;
  /** Whether a Reference_Model_Testbench OTHER than the one under judgment killed this mutant. */
  readonly killedByPeer: boolean;
  /** Whether the testbench UNDER JUDGMENT killed this mutant. */
  readonly killedByJudged: boolean;
}

/** One Mutation_Strength_Gate request: which testbench, and every mutant's run facts. */
export interface MutationStrengthRequest {
  readonly testbenchId: Ulid;
  readonly mutantRuns: readonly MutantRunRecord[];
}

/**
 * The Mutation_Strength_Gate port (design C12): judge one Reference_Model_Testbench
 * against the Peer_Calibrated_Mutant_Set.
 *
 * Callers depend on this interface, never on the concrete peer-calibrated rule a
 * production adapter applies.
 */
export interface MutationStrengthGate {
  judge(request: MutationStrengthRequest): Promise<MutationGateOutcome>;
}

/**
 * Compiled mutants whose unmutated parent passes T and that at least one OTHER
 * testbench killed: the Peer_Calibrated_Mutant_Set requirement for T (pure).
 */
function requirementOf(runs: readonly MutantRunRecord[]): readonly MutantRunRecord[] {
  return runs.filter((run) => run.compiled && run.parentPassedJudged && run.killedByPeer);
}

/**
 * The kill rate over every COMPILED mutant, or `null` when none compiled (pure).
 *
 * Deliberately the wider denominator - every valid mutant, not only the
 * requirement set - for the same reason `killRateOf` (`@app/tools`) is: scoring
 * T only on the mutants it was required to kill would hide how it fares on the
 * mutants no peer happened to kill either. Reported, never gated.
 */
function killRateOver(runs: readonly MutantRunRecord[]): number | null {
  const valid = runs.filter((run) => run.compiled);
  if (valid.length === 0) {
    return null;
  }
  const killedCount = valid.filter((run) => run.killedByJudged).length;
  return killedCount / valid.length;
}

/**
 * Apply the Peer_Calibrated_Mutant_Set rule to one request (pure, total).
 *
 * Exported directly alongside the class so the decision is testable with no
 * `Promise` indirection; `PeerCalibratedMutationStrengthGate.judge` is a thin
 * `Promise`-wrapping call to this function.
 */
export function judgeMutationStrength(request: MutationStrengthRequest): MutationGateOutcome {
  const requirement = requirementOf(request.mutantRuns);
  if (requirement.length === 0) {
    return { kind: 'not-run' };
  }

  const survivors = requirement.filter((run) => !run.killedByJudged);
  if (survivors.length > 0) {
    return { kind: 'failed', survivors: survivors.map((run) => run.mutant) };
  }

  return {
    kind: 'passed',
    killed: requirement.map((run) => run.mutant),
    killRate: killRateOver(request.mutantRuns),
  };
}

/**
 * The Peer_Calibrated_Mutant_Set production adapter for the Mutation_Strength_Gate
 * port (Req 12.1 to 12.3, 12.5, 12.6, 17.2).
 *
 * Stateless: it holds no collaborators because `judgeMutationStrength` is a pure
 * function of its request. Every accepted Repair_Attempt output is judged
 * through this same adapter and the same rule a freshly generated
 * Reference_Model_Testbench is (Req 12.5), which is one call site rather than a
 * second gate.
 */
export class PeerCalibratedMutationStrengthGate implements MutationStrengthGate {
  judge(request: MutationStrengthRequest): Promise<MutationGateOutcome> {
    return Promise.resolve(judgeMutationStrength(request));
  }
}
