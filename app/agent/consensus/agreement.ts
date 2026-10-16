// The Agreement_Cluster grouping and the Strict_Majority rule (C10; Req 2.1,
// 2.2, 2.4, 2.6, 2.7, 11.1, 13.1).
//
// A Candidate_Design's cluster key is the tuple of its `WaveformSignature`
// digests across *every* Reference_Model_Testbench in `matrix.testbenchIds`
// order, so two designs land in the same `AgreementCluster` only when they
// agreed under all N testbenches (Req 2.1). Clustering reads only those
// digests, never Candidate_Design source, which is why `AgreementCluster`
// itself carries no source field (Req 2.6).
//
// A design with no signature against any one testbench - any incomplete run,
// per `RunCell.passed`'s own doc comment - has no complete tuple and joins no
// cluster, so an incomplete run never contributes agreement (Req 2.2, 2.7). A
// cell that is simply absent for a pair the matrix otherwise names is instead
// the same Run_Matrix defect `peersOf` (run-matrix.ts) already throws on, not a
// silent non-cluster: this module throws for that case rather than reusing it
// to under-count.

import type { Ulid } from '@app/core';

import type { RunCell, RunMatrix } from './run-matrix.js';

/** One Agreement_Cluster: the designs that agreed, and what they agreed on. */
export interface AgreementCluster {
  readonly designIds: readonly Ulid[];
  /** Per Reference_Model_Testbench, the digest every member produced. */
  readonly digestsByTestbench: readonly { readonly testbenchId: Ulid; readonly digest: string }[];
}

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

/**
 * `designId`'s digest at `testbenchId`, or `null` when its run was incomplete
 * (`signature === null`). Throws the same Run_Matrix defect error `peersOf`
 * (run-matrix.ts) throws when `cells` carries no entry at all for a pair the
 * matrix's own `designIds`/`testbenchIds` otherwise names.
 */
function digestAt(
  index: ReadonlyMap<string, RunCell>,
  designId: Ulid,
  testbenchId: Ulid,
): string | null {
  const cell = index.get(cellKey(designId, testbenchId));
  if (cell === undefined) {
    throw new Error(`Run_Matrix defect: no cell for design ${designId} x testbench ${testbenchId}`);
  }
  return cell.signature === null ? null : cell.signature.digest;
}

/** One testbench's digest, paired with the testbench it was produced against. */
interface TestbenchDigest {
  readonly testbenchId: Ulid;
  readonly digest: string;
}

/**
 * `designId`'s cluster key: its digest at each of `testbenchIds`, in that fixed
 * order, or `null` when any one of those digests is missing (Req 2.1, 2.2, 2.7).
 */
function clusterKeyOf(
  index: ReadonlyMap<string, RunCell>,
  designId: Ulid,
  testbenchIds: readonly Ulid[],
): { readonly key: string; readonly digestsByTestbench: readonly TestbenchDigest[] } | null {
  const digestsByTestbench: TestbenchDigest[] = [];
  for (const testbenchId of testbenchIds) {
    const digest = digestAt(index, designId, testbenchId);
    if (digest === null) {
      return null;
    }
    digestsByTestbench.push({ testbenchId, digest });
  }
  const key = digestsByTestbench.map((entry) => entry.digest).join('\u0000');
  return { key, digestsByTestbench };
}

/**
 * Group `matrix.designIds` into `AgreementCluster`s by exact digest-tuple
 * equality across every testbench in `matrix.testbenchIds` order (Req 2.1,
 * 2.6).
 *
 * Pure: reads only `matrix`, and throws rather than guesses when a cell the
 * matrix's own `designIds`/`testbenchIds` implies is missing from `cells` -
 * the same defect contract `peersOf` (run-matrix.ts) uses.
 */
export function agreementClusters(matrix: RunMatrix): readonly AgreementCluster[] {
  const index = indexCells(matrix.cells);
  const clustersByKey = new Map<
    string,
    { designIds: Ulid[]; digestsByTestbench: readonly TestbenchDigest[] }
  >();

  for (const designId of matrix.designIds) {
    const keyed = clusterKeyOf(index, designId, matrix.testbenchIds);
    if (keyed === null) {
      continue;
    }
    const existing = clustersByKey.get(keyed.key);
    if (existing === undefined) {
      clustersByKey.set(keyed.key, {
        designIds: [designId],
        digestsByTestbench: keyed.digestsByTestbench,
      });
    } else {
      existing.designIds.push(designId);
    }
  }

  return [...clustersByKey.values()].map((cluster) => ({
    designIds: cluster.designIds,
    digestsByTestbench: cluster.digestsByTestbench,
  }));
}

/**
 * Return the cluster whose cardinality is strictly greater than half of
 * `poolSize`, or `null` when no cluster meets that bar (Req 2.2, 2.4).
 *
 * `poolSize` is the admitted Design_Pool cardinality N, never `clusters.length`
 * or a cluster-size sum, so a provider failure that shrinks the pool makes the
 * majority easier to reach rather than changing what "majority" means. Such a
 * cluster is unique when it exists - two clusters of equal cardinality cannot
 * both exceed half of the same `poolSize` - so the equal-cardinality tie case
 * (Req 2.4) falls out of this one inequality for free, with no separate tie
 * check.
 *
 * There is deliberately no `largestCluster` export in this module, and no
 * `isLargest` or `rank` field on `AgreementCluster`: the plurality rule - the
 * largest cluster regardless of whether it clears half - measured at 4.2%
 * wrong labels against this feature's 2% bar, and the way to keep it out of a
 * later edit is for it not to exist.
 */
export function strictMajority(
  clusters: readonly AgreementCluster[],
  poolSize: number,
): AgreementCluster | null {
  for (const cluster of clusters) {
    if (cluster.designIds.length > poolSize / 2) {
      return cluster;
    }
  }
  return null;
}
