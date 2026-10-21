// Testbench repair, steered by the majority and accepted by held-out designs
// (C15, Req 11.1-11.9, 12.5).
//
// Five steps and the ORDER is the guarantee: trigger, partition before the
// attempt starts, steer from the Steering_Set only, accept against the holdout
// AND the Mutation_Strength_Gate, discard otherwise. A rejected revision leaves
// the Testbench_Pool unchanged, so a failed repair cannot degrade the pool.

import type { Ulid } from '@app/core';

import type { FaultVerdict } from './fault-attributor.js';
import type { ModelFamily } from './model-family.js';
import type { MutationGateOutcome } from './mutation-strength-gate.js';
import type { BudgetLedger } from './budget.js';
import type { RunMatrix } from './run-matrix.js';
import type { AttributionStatus } from './trust-vote.js';
import type { SampleRecord } from './signature.js';

/**
 * JUDGEMENT, not measured: 5 steering designs is the smallest Strict_Majority at
 * N = 8. The one constant in this subsystem with no measurement under it - vary
 * it over 2, 3, 4 against the Golden_Judge once repair exists, before any
 * steering-prompt tuning.
 */
export const REPAIR_HOLDOUT_SIZE = 3;

export interface RepairTarget {
  readonly digestsByTestbench: readonly { readonly testbenchId: Ulid; readonly digest: string }[];
  /** The trace the Repair_Attempt is shown, drawn from the Steering_Set only. */
  readonly trace: readonly SampleRecord[];
  readonly modelFamilyCount: number;
}

export interface RepairPartition {
  readonly steeringSet: readonly Ulid[];
  readonly heldOut: readonly Ulid[];
}

/** No field for RTL, a held-out design's signature, or a model assertion (Req 11.4). */
export interface RepairRequest {
  readonly target: RepairTarget;
}

/** Whether repair may start for one failing pair: no Trusted_Testbench, a majority, the gate. */
export interface RepairStartCondition {
  readonly hasTrustedTestbench: boolean;
  readonly majorityFamilyCount: number;
  readonly attributionStatus: AttributionStatus;
  readonly faultVerdict: FaultVerdict;
}

const MIN_MAJORITY_FAMILY_COUNT = 3;

/**
 * Whether repair starts for one failing pair (Req 11.7): no Trusted_Testbench
 * exists, a Strict_Majority spans at least 3 Model_Families, the Pool_Correctness
 * gate is actionable, and the Fault_Verdict is `TESTBENCH`. An advisory verdict
 * or an `ABSTAIN` has no path through here.
 */
export function shouldTriggerRepair(trigger: RepairStartCondition): boolean {
  return (
    !trigger.hasTrustedTestbench &&
    trigger.majorityFamilyCount >= MIN_MAJORITY_FAMILY_COUNT &&
    trigger.attributionStatus === 'actionable' &&
    trigger.faultVerdict === 'TESTBENCH'
  );
}

/**
 * Split `designIds` into a Steering_Set of `designIds.length - REPAIR_HOLDOUT_SIZE`
 * and a Held_Out_Design_Set of `REPAIR_HOLDOUT_SIZE`, fixed before any attempt
 * starts (Req 11.3). The two are a disjoint cover of `designIds`.
 */
export function partitionForRepair(designIds: readonly Ulid[]): RepairPartition {
  const steeringSize = designIds.length - REPAIR_HOLDOUT_SIZE;
  return {
    steeringSet: designIds.slice(0, steeringSize),
    heldOut: designIds.slice(steeringSize),
  };
}

/** `matrix`'s testbench ids, in matrix order, each with the digest a design produced. */
function digestsFor(
  matrix: RunMatrix,
  designId: Ulid,
): readonly { testbenchId: Ulid; digest: string }[] {
  return matrix.testbenchIds.flatMap((testbenchId) => {
    const cell = matrix.cells.find(
      (candidate) => candidate.designId === designId && candidate.testbenchId === testbenchId,
    );
    return cell?.signature === null || cell?.signature === undefined
      ? []
      : [{ testbenchId, digest: cell.signature.digest }];
  });
}

/** The minimum cardinality that is a Strict_Majority of a `steeringSet` of 5. */
function isSteeringMajority(count: number, steeringSetSize: number): boolean {
  return count > steeringSetSize / 2;
}

/**
 * Build the `RepairTarget` from the Steering_Set's own majority, or `null` when
 * the Steering_Set holds no Strict_Majority (Req 11.1, 11.7): no target means no
 * Repair_Attempt. Reads `matrix` and `families` for the Steering_Set's designs
 * ONLY - `partition.heldOut` is never consulted, so no held-out design's
 * Waveform_Signature can reach the attempt (Req 11.4).
 */
export function repairTargetOf(
  matrix: RunMatrix,
  partition: RepairPartition,
  families: ReadonlyMap<Ulid, ModelFamily>,
): RepairTarget | null {
  const keyed = new Map<
    string,
    { designIds: Ulid[]; digests: readonly { testbenchId: Ulid; digest: string }[] }
  >();
  for (const designId of partition.steeringSet) {
    const digests = digestsFor(matrix, designId);
    if (digests.length !== matrix.testbenchIds.length) {
      continue;
    }
    const key = digests.map((entry) => entry.digest).join('\u0000');
    const existing = keyed.get(key);
    if (existing === undefined) {
      keyed.set(key, { designIds: [designId], digests });
    } else {
      existing.designIds.push(designId);
    }
  }

  let majority: {
    designIds: Ulid[];
    digests: readonly { testbenchId: Ulid; digest: string }[];
  } | null = null;
  for (const cluster of keyed.values()) {
    if (isSteeringMajority(cluster.designIds.length, partition.steeringSet.length)) {
      majority = cluster;
      break;
    }
  }
  if (majority === null) {
    return null;
  }

  const familyKeys = new Set(
    majority.designIds
      .map((designId) => families.get(designId))
      .filter((family): family is ModelFamily => family !== undefined)
      .map((family) => `${family.provider}\u0000${family.lineage}`),
  );

  const trace: SampleRecord[] = matrix.testbenchIds.map((testbenchId, step) => {
    const digest = majority?.digests.find((entry) => entry.testbenchId === testbenchId)?.digest;
    return { step, values: [digest ?? null] };
  });

  return {
    digestsByTestbench: majority.digests,
    trace,
    modelFamilyCount: familyKeys.size,
  };
}

/**
 * Whether a Repair_Attempt's revision is accepted (Req 11.5, 12.5): strictly more
 * than half the Held_Out_Design_Set passes it AND the revision passes the
 * Mutation_Strength_Gate. A rejected revision is discarded by the caller; the
 * Testbench_Pool is retained unchanged (Req 11.6).
 */
export function acceptRepair(
  revisionMatrix: readonly { readonly designId: Ulid; readonly passed: boolean }[],
  heldOut: readonly Ulid[],
  mutation: MutationGateOutcome,
): boolean {
  const passingCount = heldOut.filter(
    (designId) => revisionMatrix.find((cell) => cell.designId === designId)?.passed === true,
  ).length;
  return passingCount > heldOut.length / 2 && mutation.kind === 'passed';
}

/**
 * Whether one more Repair_Attempt may be issued for a Session (Req 11.8): the
 * attempt count stays at or below `maxAttemptsForSession` AND the Session's own
 * `ledger` can still afford `estimatedTokens`. Both conjuncts are checked;
 * neither is permitted to stand in for the other.
 */
export function withinRepairAttemptBounds(
  attemptCount: number,
  maxAttemptsForSession: number,
  ledger: BudgetLedger,
  estimatedTokens: number,
): boolean {
  return attemptCount <= maxAttemptsForSession && ledger.canAfford(estimatedTokens);
}
