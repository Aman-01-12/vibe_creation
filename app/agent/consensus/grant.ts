// The five-condition Grant_Condition evaluator and the one-way formal override
// (C2; Req 1.2, 1.3, 1.4, 1.6, 1.7, 2.3, 3.3, 8.4).
//
// `evaluateGrant` is a pure total function from the recorded facts of a Session
// to the unmet Grant_Condition, or to the granted cluster. The five conditions
// are checked in the fixed order named by `GrantConditionId` and the first unmet
// one is reported, so an Unverified_Outcome always names one condition rather
// than a set (Req 14.1). The order is chosen so the named condition is the
// earliest thing that went wrong: a diversity failure is a retry and a
// no-majority failure is an escalation.
//
// TWO SHAPES ARE LOAD-BEARING
//
//   `GrantEvaluation` carries no `verified` boolean, so there is no state in
//   which a caller can read a granted label without holding the cluster that
//   justifies it (Req 1.6). There is no `largestCluster` field anywhere on
//   `SessionFacts`, and no Testbench_Pool family count either, so no clause can
//   be written against the plurality rule the holdout measured at 4.2% wrong
//   labels (Req 2.3) and `evaluateGrant` cannot accidentally read a family
//   count that is a routing target rather than a Grant_Condition (Req 3.3).
//
// WHY `trusted-testbench-exists` AND `mutation-strength` ARE BOTH NEEDED
//
//   `TestbenchTrust.trusted` (trust-vote.ts) is already the conjunction of
//   `votedTrusted` and a passing Mutation_Strength_Gate outcome. So
//   `trusted-testbench-exists` reads `trusted` directly: it asks whether a
//   fully Trusted_Testbench exists. `mutation-strength` reads `votedTrusted`
//   and `mutationOutcome` instead, over every vote-winner rather than only the
//   already-trusted ones, which is what makes the two conditions independently
//   violatable: a Session can hold one fully Trusted_Testbench (satisfying the
//   third condition) while a different vote-winner failed its Mutation_Strength
//   Gate (violating the fifth), and the fixed order reports the fourth
//   condition's own result before ever reaching that fifth check.
//
// THE FORMAL OVERRIDE IS A SEPARATE FUNCTION, NOT A SIXTH CONDITION
//
//   `applyFormalOverride` is applied by the caller after a grant, not folded
//   into `evaluateGrant`. A refutation of any member of the granted cluster
//   converts the outcome to Unverified; a formal proof of any design never
//   changes a grant in either direction, which is why this function has no
//   parameter for a proof at all. JUDGEMENT, against ADR-019's measured limits:
//   requiring a proof wherever the formal gate terminates would be strictly
//   stronger and would make the multiplier class permanently Unverified, since
//   ADR-019 measured a 16-bit multiplier not completing in 900s and 2 of 50
//   references not elaborating, which is exactly the population ADR-018 layer 3
//   exists to cover. Keeping the override a separate function is also what
//   makes it one edit to reverse into a sixth `GrantConditionId`.

import type { Ulid } from '@app/core';

import type { AgreementCluster } from './agreement.js';
import { strictMajority } from './agreement.js';
import { MIN_MODEL_FAMILIES } from './model-family.js';
import type { RunCell, RunMatrix } from './run-matrix.js';
import type { TestbenchTrust } from './trust-vote.js';

/** The five Grant_Conditions of Requirement 1 criterion 4, in their fixed evaluation order. */
export type GrantConditionId =
  | 'model-family-diversity'
  | 'strict-majority'
  | 'trusted-testbench-exists'
  | 'majority-passes-trusted'
  | 'mutation-strength';

/** The minimal witness recorded for whichever `GrantConditionId` was unmet. */
export type GrantEvidence =
  | { readonly kind: 'model-family-diversity'; readonly distinctFamilyCount: number }
  | { readonly kind: 'strict-majority'; readonly poolSize: number }
  | { readonly kind: 'trusted-testbench-exists'; readonly testbenchPoolSize: number }
  | {
      readonly kind: 'majority-passes-trusted';
      readonly designId: Ulid;
      readonly testbenchId: Ulid;
    }
  | { readonly kind: 'mutation-strength'; readonly testbenchId: Ulid };

/**
 * The recorded facts of one Session that `evaluateGrant` reads, built from the
 * already-landed C10, C11, and C8 shapes: `AgreementCluster` (agreement.ts),
 * `TestbenchTrust` (trust-vote.ts), and `RunMatrix` (run-matrix.ts).
 *
 * There is deliberately no Testbench_Pool family count field here: testbench
 * family spread is a routing target recorded elsewhere in the Session, never a
 * Grant_Condition, and the way to keep a future clause from being written
 * against it is for the field not to exist on this type.
 */
export interface SessionFacts {
  /** The admitted Design_Pool cardinality N, consumed by `strictMajority` (Req 2.5). */
  readonly poolSize: number;
  /** Distinct Model_Family count achieved by the Design_Pool only (Req 3.1, 3.3). */
  readonly designPoolDistinctFamilyCount: number;
  readonly clusters: readonly AgreementCluster[];
  readonly testbenchTrust: readonly TestbenchTrust[];
  readonly runMatrix: RunMatrix;
}

export type GrantEvaluation =
  | { readonly kind: 'granted'; readonly cluster: AgreementCluster }
  | {
      readonly kind: 'unmet';
      readonly condition: GrantConditionId;
      readonly evidence: GrantEvidence;
    };

/** The outcome of a one-way formal override: a surviving `GrantEvaluation`, or a refutation naming its cause. */
export type FormalOverrideResult =
  | GrantEvaluation
  | {
      readonly kind: 'unmet';
      readonly condition: 'formal-refutation';
      readonly refutedDesignId: Ulid;
    };

/** A stable string key for one (designId, testbenchId) cell lookup. */
function cellKey(designId: Ulid, testbenchId: Ulid): string {
  return `${designId}\u0000${testbenchId}`;
}

/** Index `cells` by their (designId, testbenchId) pair for O(1) lookup. */
function indexCells(cells: readonly RunCell[]): ReadonlyMap<string, RunCell> {
  const index = new Map<string, RunCell>();
  for (const cell of cells) {
    index.set(cellKey(cell.designId, cell.testbenchId), cell);
  }
  return index;
}

/** One (designId, testbenchId) pair that did not pass, for the fourth condition's evidence. */
interface FailingPair {
  readonly designId: Ulid;
  readonly testbenchId: Ulid;
}

/**
 * The first pair of a majority-cluster design and a Trusted_Testbench that did
 * not pass, scanning cluster designs in order and trusted testbenches in order,
 * or `null` when every one of them passed.
 *
 * Throws the same Run_Matrix defect error `peersOf` (run-matrix.ts) and
 * `digestAt` (agreement.ts) throw when `matrix.cells` carries no entry for a
 * pair this check needs, rather than reading a missing cell as a pass or fail.
 */
function firstFailingMajorityPair(
  cluster: AgreementCluster,
  trustedTestbenches: readonly TestbenchTrust[],
  matrix: RunMatrix,
): FailingPair | null {
  const index = indexCells(matrix.cells);
  for (const designId of cluster.designIds) {
    for (const testbench of trustedTestbenches) {
      const cell = index.get(cellKey(designId, testbench.testbenchId));
      if (cell === undefined) {
        throw new Error(
          `Run_Matrix defect: no cell for design ${designId} x testbench ${testbench.testbenchId}`,
        );
      }
      if (cell.passed !== true) {
        return { designId, testbenchId: testbench.testbenchId };
      }
    }
  }
  return null;
}

/**
 * The first Reference_Model_Testbench that won the Trust_Vote but did not pass
 * the Mutation_Strength_Gate, or `null` when every vote-winner passed it.
 *
 * Reads `votedTrusted` and `mutationOutcome` rather than the already-combined
 * `trusted` field, which is what makes this condition checkable independently
 * of `trusted-testbench-exists` (see the module header).
 */
function firstVotedTrustedWithoutMutationPass(
  testbenchTrust: readonly TestbenchTrust[],
): Ulid | null {
  const found = testbenchTrust.find(
    (testbench) => testbench.votedTrusted && testbench.mutationOutcome.kind !== 'passed',
  );
  return found === undefined ? null : found.testbenchId;
}

function unmet(condition: GrantConditionId, evidence: GrantEvidence): GrantEvaluation {
  return { kind: 'unmet', condition, evidence };
}

/**
 * Evaluate the five Grant_Conditions of a Session in their fixed order and
 * report the first unmet one, or the Strict_Majority cluster when all five
 * hold (Req 1.2, 1.3, 1.4).
 *
 * Pure: reads only `session`, and throws rather than guesses when the fourth
 * condition's cell lookup finds a Run_Matrix defect.
 */
export function evaluateGrant(session: SessionFacts): GrantEvaluation {
  if (session.designPoolDistinctFamilyCount < MIN_MODEL_FAMILIES) {
    return unmet('model-family-diversity', {
      kind: 'model-family-diversity',
      distinctFamilyCount: session.designPoolDistinctFamilyCount,
    });
  }

  const majority = strictMajority(session.clusters, session.poolSize);
  if (majority === null) {
    return unmet('strict-majority', { kind: 'strict-majority', poolSize: session.poolSize });
  }

  const trustedTestbenches = session.testbenchTrust.filter((testbench) => testbench.trusted);
  if (trustedTestbenches.length === 0) {
    return unmet('trusted-testbench-exists', {
      kind: 'trusted-testbench-exists',
      testbenchPoolSize: session.testbenchTrust.length,
    });
  }

  const failingPair = firstFailingMajorityPair(majority, trustedTestbenches, session.runMatrix);
  if (failingPair !== null) {
    return unmet('majority-passes-trusted', {
      kind: 'majority-passes-trusted',
      designId: failingPair.designId,
      testbenchId: failingPair.testbenchId,
    });
  }

  const unstrengthenedTestbenchId = firstVotedTrustedWithoutMutationPass(session.testbenchTrust);
  if (unstrengthenedTestbenchId !== null) {
    return unmet('mutation-strength', {
      kind: 'mutation-strength',
      testbenchId: unstrengthenedTestbenchId,
    });
  }

  return { kind: 'granted', cluster: majority };
}

/**
 * Apply the one-way formal override to a `GrantEvaluation` (Req 1.7).
 *
 * A refutation of any member of the granted cluster converts the outcome to
 * Unverified, naming that design as the cause; a refutation of a design
 * outside the granted cluster, or of any design when `evaluation` is already
 * unmet, changes nothing. There is no parameter for a formal proof, which is
 * what makes a proof of any design unable to change a grant in either
 * direction: the property that matters, that consensus never contradicts a
 * proof, is upheld entirely by this function reading refutations and nothing
 * else.
 *
 * The returned 'unmet' shape carries `condition: 'formal-refutation'` rather
 * than a `GrantConditionId`, because a formal refutation is not one of the five
 * Grant_Conditions (see the module header); it is the separate cause C17's
 * wider `SessionOutcome.unmetCondition` union already carries alongside them.
 */
export function applyFormalOverride(
  evaluation: GrantEvaluation,
  refutedDesignIds: readonly Ulid[],
): FormalOverrideResult {
  if (evaluation.kind !== 'granted') {
    return evaluation;
  }
  const refuted = new Set(refutedDesignIds);
  const refutedMember = evaluation.cluster.designIds.find((designId) => refuted.has(designId));
  if (refutedMember === undefined) {
    return evaluation;
  }
  return { kind: 'unmet', condition: 'formal-refutation', refutedDesignId: refutedMember };
}
