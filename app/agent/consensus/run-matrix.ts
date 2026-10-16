// The Run_Matrix data model and the peer derivation the Fault_Attributor (C13)
// consumes (C8 data model; Req 7.7, 8.3, 9.5, 9.7).
//
// `RunCell` carries a pair's outcome and nothing else: no reference design, no
// golden verdict, no model assertion, and no RTL source. That is the one type
// signature that makes the Trust_Vote (C11) and the Fault_Attributor (C13)
// shippable where `InstrumentAdmission` is not, because neither can read a thing
// this type does not carry (Req 8.3, 9.7).
//
// `peersOf` is where the Fault_Attributor's exclusion of a pair from its own
// attribution lives. It is not a rule the attributor's body happens to follow;
// it is the shape of `FailingPairPeers`, derived here from the Run_Matrix row and
// column with the pair's own cell already dropped (Req 9.5).
//
// A missing cell for a design/testbench combination the matrix otherwise names is
// a Run_Matrix defect, never a silently absent peer: `peersOf` throws rather than
// undercounting, because treating a missing cell as "not a peer" would silently
// shrink N in exactly the way the design's Error Handling forbids elsewhere.

import type { Ulid } from '@app/core';
import type { RunFailureCause } from '@app/tools';

import type { WaveformSignature } from './signature.js';

/** One Candidate_Design x Reference_Model_Testbench pair's Consensus_Run outcome. */
export interface RunCell {
  readonly designId: Ulid;
  readonly testbenchId: Ulid;
  /** `null` when the run was incomplete, which counts as failing (Req 7.7). */
  readonly passed: boolean | null;
  readonly signature: WaveformSignature | null;
  readonly failureCause: RunFailureCause;
}

/** The full Design_Pool x Testbench_Pool grid of Consensus_Run outcomes. */
export interface RunMatrix {
  readonly designIds: readonly Ulid[];
  readonly testbenchIds: readonly Ulid[];
  readonly cells: readonly RunCell[];
}

/** The four peer counts `attributeFault` (C13) decides from; see `peersOf`. */
export interface FailingPairPeers {
  /** Candidate_Designs other than this pair's that pass this pair's testbench. */
  readonly peerPassCount: number;
  readonly peerDesignCount: number;
  /** Reference_Model_Testbenches other than this pair's that this pair's design passes. */
  readonly peerTestbenchPassCount: number;
  readonly peerTestbenchCount: number;
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
 * Look up the cell at (designId, testbenchId), or throw a Run_Matrix defect error
 * naming the missing pair.
 *
 * A matrix that names a design and a testbench in `designIds`/`testbenchIds` but
 * carries no cell for their pair is malformed input, not a failing run: a failing
 * run has a cell with `passed: false` or `passed: null`. Throwing here is what
 * stops that defect from being read as an absent (and therefore uncounted) peer.
 */
function requireCell(
  index: ReadonlyMap<string, RunCell>,
  designId: Ulid,
  testbenchId: Ulid,
): RunCell {
  const cell = index.get(cellKey(designId, testbenchId));
  if (cell === undefined) {
    throw new Error(`Run_Matrix defect: no cell for design ${designId} x testbench ${testbenchId}`);
  }
  return cell;
}

/**
 * Derive the four `FailingPairPeers` counts for (designId, testbenchId) from the
 * Run_Matrix row and column, with that cell itself excluded (Req 9.5).
 *
 * The row is every other design's cell against `testbenchId`; the column is this
 * design's cell against every other testbench. `passed === true` is the only
 * value that counts as a pass; `false` and `null` both count as failing, which is
 * what makes an incomplete run (`passed: null`) fail everywhere it is read
 * (Req 7.7) rather than needing a second check at every call site.
 *
 * Pure: reads only `matrix`, and throws rather than guesses when a cell the
 * matrix's own `designIds`/`testbenchIds` implies is missing from `cells`.
 */
export function peersOf(matrix: RunMatrix, designId: Ulid, testbenchId: Ulid): FailingPairPeers {
  const index = indexCells(matrix.cells);

  let peerPassCount = 0;
  let peerDesignCount = 0;
  for (const otherDesignId of matrix.designIds) {
    if (otherDesignId === designId) {
      continue;
    }
    const cell = requireCell(index, otherDesignId, testbenchId);
    peerDesignCount += 1;
    if (cell.passed === true) {
      peerPassCount += 1;
    }
  }

  let peerTestbenchPassCount = 0;
  let peerTestbenchCount = 0;
  for (const otherTestbenchId of matrix.testbenchIds) {
    if (otherTestbenchId === testbenchId) {
      continue;
    }
    const cell = requireCell(index, designId, otherTestbenchId);
    peerTestbenchCount += 1;
    if (cell.passed === true) {
      peerTestbenchPassCount += 1;
    }
  }

  return { peerPassCount, peerDesignCount, peerTestbenchPassCount, peerTestbenchCount };
}
