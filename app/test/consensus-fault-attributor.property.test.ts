// reference-model-consensus-gate, Property 18: The Fault_Attributor decision table, with the
// Peer_Floor checked first (task 2.12, C13).
//
// THE ORACLE
//   `expectedVerdict` below restates the decision table from Requirement 9 criteria 2 to 6
//   independently of `attributeFault`'s own branch order: it computes both share comparisons as
//   cross-multiplications (`peerPassCount * 2 > peerDesignCount`) rather than division, and
//   evaluates both before combining them, so a reordered or inverted implementation disagrees
//   with this oracle rather than being mirrored by it.
//
// WHY THE PEER_FLOOR BOUNDARY IS ENUMERATED, NOT SAMPLED
//   The floor is a single point (`PEER_FLOOR` at 3) on an otherwise unbounded count, so a count
//   drawn from a plausible range lands below it rarely. The second test below exhausts every
//   count in [0, 4] on each side, crossed with every pass count that count admits, rather than
//   leaving the boundary to chance.
//
// WHY THE HALF-SHARE BOUNDARY IS CONSTRUCTED, NOT SAMPLED
//   Both share comparisons in `attributeFault` are strict, so a share of exactly one half must
//   abstain under both the `RTL` and the `TESTBENCH` clause. A uniformly random pass count lands
//   on that exact boundary about as rarely as the floor does, so the third test below constructs
//   it directly: one side at exactly half, the other side unambiguous; the mirror; and both sides
//   at exactly half together; each at several even peer counts.
//
// WHY THE ROW/COLUMN DERIVATION HAS ITS OWN GENERATOR
//   `peersOf` (C8 data model) is what the Fault_Attributor is fed through in production, so the
//   fourth test below checks it directly: for a generated Run_Matrix and a cell forced failing,
//   the four counts match the row and column with that cell excluded, computed here by filtering
//   `matrix.cells` directly rather than by calling `peersOf` a second time.
//
// Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.6

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  attributeFault,
  PEER_FLOOR,
  type FailingPairPeers,
  type FaultVerdict,
} from '../agent/consensus/fault-attributor.js';
import { peersOf, type RunCell, type RunMatrix } from '../agent/consensus/run-matrix.js';

import { propertyParameters } from './property.js';

const PROPERTY =
  'reference-model-consensus-gate, Property 18: The Fault_Attributor decision table, with the Peer_Floor checked first';

/** The closed set `attributeFault` returns into (Req 9.1). */
const FAULT_VERDICTS: readonly FaultVerdict[] = ['RTL', 'TESTBENCH', 'ABSTAIN'];

/**
 * The decision table restated independently of `attributeFault`'s own branch order (Req 9.2 to
 * 9.6). Both share comparisons are cross-multiplications rather than division, which is a
 * genuinely different computation from the implementation's `peerPassCount / peerDesignCount`,
 * and both are evaluated before either is used, so neither this oracle nor the implementation can
 * drift into agreeing by sharing a branch order.
 */
function expectedVerdict(peers: FailingPairPeers): FaultVerdict {
  const floorMet = peers.peerDesignCount >= PEER_FLOOR && peers.peerTestbenchCount >= PEER_FLOOR;

  const designShareAboveHalf = peers.peerPassCount * 2 > peers.peerDesignCount;
  const designShareBelowHalf = peers.peerPassCount * 2 < peers.peerDesignCount;
  const testbenchShareAboveHalf = peers.peerTestbenchPassCount * 2 > peers.peerTestbenchCount;
  const testbenchShareBelowHalf = peers.peerTestbenchPassCount * 2 < peers.peerTestbenchCount;

  if (!floorMet) {
    return 'ABSTAIN';
  }
  if (designShareAboveHalf && testbenchShareBelowHalf) {
    return 'RTL';
  }
  if (designShareBelowHalf && testbenchShareAboveHalf) {
    return 'TESTBENCH';
  }
  return 'ABSTAIN';
}

/** A `FailingPairPeers` with each pass count independently drawn from [0, its own peer count]. */
function peersArbitrary(maxPeerCount: number): fc.Arbitrary<FailingPairPeers> {
  return fc
    .record({
      peerDesignCount: fc.integer({ min: 0, max: maxPeerCount }),
      peerTestbenchCount: fc.integer({ min: 0, max: maxPeerCount }),
    })
    .chain(({ peerDesignCount, peerTestbenchCount }) =>
      fc.record<FailingPairPeers>({
        peerDesignCount: fc.constant(peerDesignCount),
        peerPassCount: fc.integer({ min: 0, max: peerDesignCount }),
        peerTestbenchCount: fc.constant(peerTestbenchCount),
        peerTestbenchPassCount: fc.integer({ min: 0, max: peerTestbenchCount }),
      }),
    );
}

describe(PROPERTY, () => {
  it(
    'matches the independently restated decision table over a wide space of peer counts and ' +
      'shares, reaching every verdict and never throwing',
    () => {
      let rtlCases = 0;
      let testbenchCases = 0;
      let abstainCases = 0;

      fc.assert(
        fc.property(peersArbitrary(15), (peers) => {
          const actual = attributeFault(peers);

          // Totality: the result is always a member of the closed three-value set.
          expect(FAULT_VERDICTS).toContain(actual);
          expect(actual).toBe(expectedVerdict(peers));

          if (actual === 'RTL') {
            rtlCases += 1;
          } else if (actual === 'TESTBENCH') {
            testbenchCases += 1;
          } else {
            abstainCases += 1;
          }
        }),
        propertyParameters(),
      );

      // NON-VACUITY: the generated space must actually reach all three verdicts.
      expect({
        rtlCases: rtlCases > 0,
        testbenchCases: testbenchCases > 0,
        abstainCases: abstainCases > 0,
      }).toEqual({ rtlCases: true, testbenchCases: true, abstainCases: true });
    },
  );

  it(
    'exhausts every peer-count combination at and around the Peer_Floor, with every reachable ' +
      'pass count, and abstains below the floor regardless of either share',
    () => {
      const boundaryPeerCounts: readonly number[] = [0, 1, 2, 3, 4];

      for (const peerDesignCount of boundaryPeerCounts) {
        for (const peerTestbenchCount of boundaryPeerCounts) {
          for (let peerPassCount = 0; peerPassCount <= peerDesignCount; peerPassCount += 1) {
            for (
              let peerTestbenchPassCount = 0;
              peerTestbenchPassCount <= peerTestbenchCount;
              peerTestbenchPassCount += 1
            ) {
              const peers: FailingPairPeers = {
                peerDesignCount,
                peerPassCount,
                peerTestbenchCount,
                peerTestbenchPassCount,
              };

              const actual = attributeFault(peers);

              expect(FAULT_VERDICTS).toContain(actual);
              expect(actual).toBe(expectedVerdict(peers));

              if (peerDesignCount < PEER_FLOOR || peerTestbenchCount < PEER_FLOOR) {
                // Req 9.6: below the floor on either side, the shares never get a say.
                expect(actual).toBe('ABSTAIN');
              }
            }
          }
        }
      }
    },
  );

  it(
    'abstains when a share lands exactly on the half boundary, on one side, the other side, ' +
      'or both at once, at several even peer counts',
    () => {
      const evenPeerCounts: readonly number[] = [4, 6, 8, 10];

      for (const count of evenPeerCounts) {
        const half = count / 2;

        // Design side exactly half; testbench side unambiguous (every peer passes), so only the
        // design-side boundary is under test.
        const designHalfOnly: FailingPairPeers = {
          peerDesignCount: count,
          peerPassCount: half,
          peerTestbenchCount: count,
          peerTestbenchPassCount: count,
        };
        expect(expectedVerdict(designHalfOnly)).toBe('ABSTAIN');
        expect(attributeFault(designHalfOnly)).toBe('ABSTAIN');

        // Testbench side exactly half; design side unambiguous (every peer passes), the mirror.
        const testbenchHalfOnly: FailingPairPeers = {
          peerDesignCount: count,
          peerPassCount: count,
          peerTestbenchCount: count,
          peerTestbenchPassCount: half,
        };
        expect(expectedVerdict(testbenchHalfOnly)).toBe('ABSTAIN');
        expect(attributeFault(testbenchHalfOnly)).toBe('ABSTAIN');

        // Both sides exactly half at once.
        const bothHalf: FailingPairPeers = {
          peerDesignCount: count,
          peerPassCount: half,
          peerTestbenchCount: count,
          peerTestbenchPassCount: half,
        };
        expect(expectedVerdict(bothHalf)).toBe('ABSTAIN');
        expect(attributeFault(bothHalf)).toBe('ABSTAIN');
      }
    },
  );
});

// --- Property 18's second half: the row/column derivation `peersOf` feeds the attributor -----

interface MatrixScenario {
  readonly matrix: RunMatrix;
  readonly targetDesignId: string;
  readonly targetTestbenchId: string;
}

/**
 * An N-by-M Run_Matrix with every cell's `passed` drawn independently, except the one target
 * cell, which is forced failing (`false` or incomplete `null`) to match the "any failing cell"
 * premise of the property.
 */
function matrixScenarioArbitrary(): fc.Arbitrary<MatrixScenario> {
  return fc
    .record({
      designCount: fc.integer({ min: 1, max: 6 }),
      testbenchCount: fc.integer({ min: 1, max: 6 }),
    })
    .chain(({ designCount, testbenchCount }) => {
      const cellCount = designCount * testbenchCount;
      return fc.record({
        designCount: fc.constant(designCount),
        testbenchCount: fc.constant(testbenchCount),
        passedGrid: fc.array(fc.constantFrom<boolean | null>(true, false, null), {
          minLength: cellCount,
          maxLength: cellCount,
        }),
        targetDesignIndex: fc.nat({ max: designCount - 1 }),
        targetTestbenchIndex: fc.nat({ max: testbenchCount - 1 }),
        targetFailureIsIncomplete: fc.boolean(),
      });
    })
    .map(
      ({
        designCount,
        testbenchCount,
        passedGrid,
        targetDesignIndex,
        targetTestbenchIndex,
        targetFailureIsIncomplete,
      }) => {
        const designIds = Array.from({ length: designCount }, (_, index) => `design-${index}`);
        const testbenchIds = Array.from(
          { length: testbenchCount },
          (_, index) => `testbench-${index}`,
        );
        const cells: RunCell[] = designIds.flatMap((designId, designIndex) =>
          testbenchIds.map((testbenchId, testbenchIndex) => {
            const isTarget =
              designIndex === targetDesignIndex && testbenchIndex === targetTestbenchIndex;
            const passed = isTarget
              ? targetFailureIsIncomplete
                ? null
                : false
              : (passedGrid[designIndex * testbenchCount + testbenchIndex] ?? null);
            return { designId, testbenchId, passed, signature: null, failureCause: 'none' };
          }),
        );
        return {
          matrix: { designIds, testbenchIds, cells },
          targetDesignId: designIds[targetDesignIndex] as string,
          targetTestbenchId: testbenchIds[targetTestbenchIndex] as string,
        };
      },
    );
}

/**
 * The row and column peer counts for (targetDesignId, targetTestbenchId), computed directly from
 * `matrix.cells` rather than through `peersOf`, so this is an independent check of the derivation
 * and not a restatement of it.
 */
function manualPeersFor(
  matrix: RunMatrix,
  targetDesignId: string,
  targetTestbenchId: string,
): FailingPairPeers {
  const rowPeers = matrix.cells.filter(
    (cell) => cell.testbenchId === targetTestbenchId && cell.designId !== targetDesignId,
  );
  const columnPeers = matrix.cells.filter(
    (cell) => cell.designId === targetDesignId && cell.testbenchId !== targetTestbenchId,
  );
  return {
    peerDesignCount: rowPeers.length,
    peerPassCount: rowPeers.filter((cell) => cell.passed === true).length,
    peerTestbenchCount: columnPeers.length,
    peerTestbenchPassCount: columnPeers.filter((cell) => cell.passed === true).length,
  };
}

describe(PROPERTY, () => {
  it(
    "derives peersOf's four counts from the Run_Matrix row and column with the pair's own cell " +
      'excluded, for any failing cell',
    () => {
      fc.assert(
        fc.property(matrixScenarioArbitrary(), ({ matrix, targetDesignId, targetTestbenchId }) => {
          const targetCell = matrix.cells.find(
            (cell) => cell.designId === targetDesignId && cell.testbenchId === targetTestbenchId,
          );
          if (targetCell === undefined) {
            throw new Error('generator invariant: the target cell must exist in the matrix');
          }
          expect(targetCell.passed).not.toBe(true); // the "any failing cell" premise

          const actual = peersOf(matrix, targetDesignId, targetTestbenchId);
          const expected = manualPeersFor(matrix, targetDesignId, targetTestbenchId);

          expect(actual).toEqual(expected);
        }),
        propertyParameters(),
      );
    },
  );
});
