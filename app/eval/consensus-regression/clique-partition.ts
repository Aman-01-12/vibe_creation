// The Clique_Partition reducer (C14; Req 10.6, 10.11): reads the Design_Pool partition the
// matrix already computed rather than recomputing it, derives the Testbench_Pool partition from
// which Candidate_Designs passed each testbench, and reports the CHECK count each clique's
// members actually agreed over.
//
// COMPUTE, NEVER RE-SIMULATE
//
//   `record.clusters` IS the Design_Pool partition: `agreementClusters(record.runMatrix)` already
//   grouped designs by exact digest-tuple equality across every testbench, and the Session
//   already carried that result. Recomputing it here would be a second, driftable copy of the
//   same grouping, so this reducer reads the field instead.
//   The CHECK count is the one derivation this record needed: the renderer emits one CHECK line
//   per output port per step, except a masked port's CHECK sits inside the Validity_Output guard
//   that is exactly why `maskedTrace` leaves that port's value non-null. So the CHECK lines one
//   cell's run emitted equals the non-null entries in that cell's own retained trace - no
//   simulator call, no new field.
//
// WHY EACH MEMBER'S OWN COUNT, NOT THE FIRST MEMBER'S
//
//   A clique's members share a digest, so they share a trace up to a hash collision. Reporting
//   only the first member's count would hide exactly the case worth surfacing: two designs the
//   matrix called "agreed" whose retained traces actually differ. This reducer computes every
//   member's own count and sets `digestCollisionSuspected` when any two disagree, so a reader
//   sees the flag rather than a silently chosen number.
//
// NO TRUST LABEL, NO VERDICT, NO Clique_Precision (Req 10.11)
//
//   `CliquePartition` and its two entry types carry nothing of that kind, and that is enforced by
//   the type itself: there is no field here a caller could read a verdict from, and no field a
//   later edit could repurpose into one without changing this type. This reducer produces the
//   clique-partition data criterion 10.6 asks for; no task in this feature acts on it, because the
//   decision-rule question it feeds is a stated non-goal.

import type { Ulid } from '@app/core';
import type {
  AgreementCluster,
  RunCell,
  RunMatrix,
  SessionRecord,
  WaveformSignature,
} from '@app/agent';

/** One Design_Pool clique: the designs that agreed, and how much behaviour they agreed over. */
export interface DesignClique {
  readonly designIds: readonly Ulid[];
  /** Per Reference_Model_Testbench, the CHECK lines every member of this clique agreed over. */
  readonly checkCountsByTestbench: readonly {
    readonly testbenchId: Ulid;
    readonly checkCount: number;
  }[];
  readonly totalCheckCount: number;
  /** True when two members' retained traces disagree on the count their shared digest implies. */
  readonly digestCollisionSuspected: boolean;
}

/** One Testbench_Pool group: testbenches passed by exactly the same Candidate_Designs. */
export interface TestbenchPartitionEntry {
  readonly testbenchIds: readonly Ulid[];
  /** The Candidate_Designs that passed every testbench in this group, and no others did. */
  readonly passingDesignIds: readonly Ulid[];
}

/** The two partitions criterion 10.6 asks for; see this file's header for criterion 10.11. */
export interface CliquePartition {
  readonly designCliques: readonly DesignClique[];
  readonly testbenchPartition: readonly TestbenchPartitionEntry[];
}

/**
 * `matrix`'s own cell for (designId, testbenchId), or a thrown Run_Matrix defect when the matrix's
 * own `designIds`/`testbenchIds` name a pair `cells` carries no entry for - the same defect
 * contract `peersOf` and `agreementClusters` (`@app/agent`) already use, so a malformed matrix
 * fails loudly here too rather than silently under-counting.
 */
function requireCell(matrix: RunMatrix, designId: Ulid, testbenchId: Ulid): RunCell {
  const cell = matrix.cells.find(
    (candidate) => candidate.designId === designId && candidate.testbenchId === testbenchId,
  );
  if (cell === undefined) {
    throw new Error(`Run_Matrix defect: no cell for design ${designId} x testbench ${testbenchId}`);
  }
  return cell;
}

/** The CHECK lines one retained, masked trace emitted: the non-null entries across every sample. */
function checkCountOf(signature: WaveformSignature): number {
  let count = 0;
  for (const sample of signature.trace) {
    for (const value of sample.values) {
      if (value !== null) {
        count += 1;
      }
    }
  }
  return count;
}

/**
 * One clique's CHECK counts, one per testbench in matrix order, plus whether any two members
 * disagreed on the count their shared digest implied they'd match.
 *
 * Every member of `cluster` carries a non-null signature for every testbench - that is what
 * `agreementClusters` already required before admitting it to a cluster - so `requireCell` here
 * only ever catches a genuinely malformed matrix, never a normal incomplete run.
 */
function checkCountsOf(
  matrix: RunMatrix,
  cluster: AgreementCluster,
): {
  readonly checkCountsByTestbench: DesignClique['checkCountsByTestbench'];
  readonly digestCollisionSuspected: boolean;
} {
  let digestCollisionSuspected = false;
  const checkCountsByTestbench = matrix.testbenchIds.map((testbenchId) => {
    const memberCounts = cluster.designIds.map((designId) => {
      const cell = requireCell(matrix, designId, testbenchId);
      if (cell.signature === null) {
        throw new Error(
          `Run_Matrix defect: clique member ${designId} has no signature against ${testbenchId}`,
        );
      }
      return checkCountOf(cell.signature);
    });
    const [ownCount = 0, ...otherCounts] = memberCounts;
    if (otherCounts.some((count) => count !== ownCount)) {
      digestCollisionSuspected = true;
    }
    return { testbenchId, checkCount: ownCount };
  });
  return { checkCountsByTestbench, digestCollisionSuspected };
}

/** `record.clusters` turned into `DesignClique`s, each paired with its own CHECK counts. */
function designCliquesOf(record: SessionRecord): readonly DesignClique[] {
  return record.clusters.map((cluster) => {
    const { checkCountsByTestbench, digestCollisionSuspected } = checkCountsOf(
      record.runMatrix,
      cluster,
    );
    return {
      designIds: cluster.designIds,
      checkCountsByTestbench,
      totalCheckCount: checkCountsByTestbench.reduce((sum, entry) => sum + entry.checkCount, 0),
      digestCollisionSuspected,
    };
  });
}

/** `testbenchId`'s own passing Candidate_Design set, in `matrix.designIds` order. */
function passingDesignIdsOf(matrix: RunMatrix, testbenchId: Ulid): readonly Ulid[] {
  return matrix.designIds.filter(
    (designId) => requireCell(matrix, designId, testbenchId).passed === true,
  );
}

/**
 * Group `matrix.testbenchIds` by the exact set of designs that passed each one: two testbenches
 * land in one group iff the same Candidate_Designs passed them, in order of first appearance.
 * `passingDesignIdsOf` always walks `matrix.designIds` in the same order, so the join below is a
 * stable key for "the same set" with no sorting needed.
 */
function testbenchPartitionOf(matrix: RunMatrix): readonly TestbenchPartitionEntry[] {
  const groupsByKey = new Map<
    string,
    { readonly testbenchIds: Ulid[]; readonly passingDesignIds: readonly Ulid[] }
  >();
  for (const testbenchId of matrix.testbenchIds) {
    const passingDesignIds = passingDesignIdsOf(matrix, testbenchId);
    const key = passingDesignIds.join('\u0000');
    const existing = groupsByKey.get(key);
    if (existing === undefined) {
      groupsByKey.set(key, { testbenchIds: [testbenchId], passingDesignIds });
    } else {
      existing.testbenchIds.push(testbenchId);
    }
  }
  return [...groupsByKey.values()];
}

/**
 * Reduce `record` to the Clique_Partition (Req 10.6): the Design_Pool partition read straight
 * from `record.clusters`, and the Testbench_Pool partition derived from `record.runMatrix`. Pure:
 * no simulation, no second data source, no field anywhere a trust label, a correctness verdict,
 * or a Clique_Precision value could sit in (Req 10.11).
 */
export function cliquePartitionOf(record: SessionRecord): CliquePartition {
  return {
    designCliques: designCliquesOf(record),
    testbenchPartition: testbenchPartitionOf(record.runMatrix),
  };
}
