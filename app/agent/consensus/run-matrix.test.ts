// Example tests for `peersOf`'s row-and-column derivation (C8 data model, C13
// input). The exhaustive decision-table coverage of `attributeFault` itself is
// task 2.12's property test; this file pins the three example shapes task 2.4's
// own body names: a 1-by-1 matrix, an 8-by-8 matrix, and a cell missing from
// `cells`.

import { describe, expect, it } from 'vitest';

import type { RunCell, RunMatrix } from './run-matrix.js';
import { peersOf } from './run-matrix.js';

/** A design id, numbered for readability in test fixtures. */
function designId(n: number): string {
  return `design-${n}`;
}

/** A testbench id, numbered for readability in test fixtures. */
function testbenchId(n: number): string {
  return `testbench-${n}`;
}

/** A passing cell for the given pair; `failureCause` is irrelevant to `peersOf`. */
function passingCell(design: string, testbench: string): RunCell {
  return {
    designId: design,
    testbenchId: testbench,
    passed: true,
    signature: null,
    failureCause: 'none',
  };
}

/** An N-by-N matrix where every cell passes, for the shape-only assertions below. */
function squareAllPassingMatrix(n: number): RunMatrix {
  const designIds = Array.from({ length: n }, (_, index) => designId(index));
  const testbenchIds = Array.from({ length: n }, (_, index) => testbenchId(index));
  const cells = designIds.flatMap((design) =>
    testbenchIds.map((testbench) => passingCell(design, testbench)),
  );
  return { designIds, testbenchIds, cells };
}

describe('peersOf', () => {
  it('given a 1-by-1 matrix, yields zero peers on both sides', () => {
    const matrix = squareAllPassingMatrix(1);

    const peers = peersOf(matrix, designId(0), testbenchId(0));

    expect(peers).toEqual({
      peerPassCount: 0,
      peerDesignCount: 0,
      peerTestbenchPassCount: 0,
      peerTestbenchCount: 0,
    });
  });

  it('given an 8-by-8 matrix, yields 7 peers on each side for every cell', () => {
    const matrix = squareAllPassingMatrix(8);

    for (const design of matrix.designIds) {
      for (const testbench of matrix.testbenchIds) {
        const peers = peersOf(matrix, design, testbench);
        expect(peers.peerDesignCount).toBe(7);
        expect(peers.peerTestbenchCount).toBe(7);
      }
    }
  });

  it('excludes the pair itself from its own row and column counts', () => {
    const matrix = squareAllPassingMatrix(8);
    // Fail exactly one cell so the counted pass share is checkable.
    const failing = {
      ...matrix,
      cells: matrix.cells.map((cell) =>
        cell.designId === designId(1) && cell.testbenchId === testbenchId(0)
          ? { ...cell, passed: false as const }
          : cell,
      ),
    };

    const peers = peersOf(failing, designId(0), testbenchId(0));

    // design(1) failed testbench(0); the other 6 row peers still pass it.
    expect(peers.peerPassCount).toBe(6);
    expect(peers.peerDesignCount).toBe(7);
    // design(0) itself passes every other testbench in this fixture.
    expect(peers.peerTestbenchPassCount).toBe(7);
    expect(peers.peerTestbenchCount).toBe(7);
  });

  it('treats an incomplete run (passed: null) as failing, not as a pass', () => {
    const matrix = squareAllPassingMatrix(3);
    const incomplete = {
      ...matrix,
      cells: matrix.cells.map((cell) =>
        cell.designId === designId(1) && cell.testbenchId === testbenchId(0)
          ? { ...cell, passed: null, failureCause: 'timed-out' as const }
          : cell,
      ),
    };

    const peers = peersOf(incomplete, designId(0), testbenchId(0));

    expect(peers.peerPassCount).toBe(1);
    expect(peers.peerDesignCount).toBe(2);
  });

  it('reports a cell absent from cells as a Run_Matrix defect, never as a pass', () => {
    const matrix = squareAllPassingMatrix(2);
    const missingCell = {
      ...matrix,
      cells: matrix.cells.filter(
        (cell) => !(cell.designId === designId(1) && cell.testbenchId === testbenchId(0)),
      ),
    };

    expect(() => peersOf(missingCell, designId(0), testbenchId(0))).toThrow(/Run_Matrix defect/);
  });
});
