// Example tests for the Run_Matrix executor (C8; Req 4.8, 8.5, 15.4, 15.6, 17.3).
//
// Driven entirely through a SCRIPTED `SimulatorAdapter` double: no real toolchain, no sandbox.
// The real-toolchain integration path (compiling and running the rendered harness end to end) is
// task 8.3's integration test; this file checks the executor's own scheduling, bounds, and
// cell-failure isolation against a simulator whose answers are fixed in advance.
//
// SCRIPTING BY TESTBENCH ID ALONE, MATCHING PRODUCTION
//   In production one Reference_Model_Testbench's rendered harness and nonce are fixed and
//   reused across every design it runs against; the Candidate_Design is what varies per cell.
//   So the scripted simulator below answers per `testbenchId` (read off the submitted testbench
//   `SourceFile`'s own path), and a test that needs two DIFFERENT answers for the same testbench
//   id runs it against two DISTINCT testbenches instead of inventing a per-cell path scheme that
//   does not exist in the real architecture.

import { describe, expect, it } from 'vitest';

import type { ModuleInterface } from '@app/core';
import type { ResourceLimits, SimulationVerdict, SimulatorAdapter, SourceFile } from '@app/tools';

import {
  executeRunMatrix,
  RUN_CELL_RESOURCE_LIMITS,
  RUN_MATRIX_CONCURRENCY_LANES,
  type RunMatrixDesign,
  type RunMatrixRequest,
  type RunMatrixTestbench,
} from './run-matrix-executor.js';

/** A combinational interface with one output port, named `y`. */
const SINGLE_OUTPUT_INTERFACE: ModuleInterface = {
  moduleName: 'dut',
  ports: [{ name: 'y', direction: 'output', width: 1 }],
  clocking: { clockName: null, resetName: null, resetActiveLow: false },
  validityOutputName: null,
};

/** A fixed `SimulationVerdict`, with every unused diagnostic field filled to a harmless default. */
function verdictOf(overrides: Partial<SimulationVerdict>): SimulationVerdict {
  return {
    verdict: 'pass',
    checks: [],
    vcd: null,
    stdout: '',
    stderr: '',
    exitCode: 0,
    resourceUsage: { cpuMs: 0, maxMemMb: 0, wallMs: 0 },
    failureCause: 'none',
    attributedFiles: [],
    watchdog: { stopped: false },
    ...overrides,
  };
}

/** A nonce-matched `ECE_SAMPLE`/`ECE_SAMPLE_END` stream `reduceSignature` can read as complete. */
function sampleStdout(nonce: string, value: string): string {
  return [`ECE_SAMPLE ${nonce} 0 ${value}`, `ECE_SAMPLE_END ${nonce} 1`].join('\n');
}

type ScriptedAnswer = SimulationVerdict | (() => Promise<SimulationVerdict>);

/**
 * A `SimulatorAdapter` whose `simulate` answers are drawn from `script`, keyed by the submitted
 * testbench's own `path`. Records every call's RTL paths, testbench path, and resource limits
 * for assertion. Throws loudly on a call for a testbench path the test did not script, so a
 * scheduling defect that calls an unscripted pair fails rather than silently reusing a default.
 */
function scriptedSimulator(script: ReadonlyMap<string, ScriptedAnswer>): SimulatorAdapter & {
  readonly calls: readonly {
    readonly rtlPaths: readonly string[];
    readonly testbenchPath: string;
    readonly limits: ResourceLimits;
  }[];
} {
  const calls: { rtlPaths: readonly string[]; testbenchPath: string; limits: ResourceLimits }[] =
    [];
  return {
    calls,
    async simulate(
      rtl: readonly SourceFile[],
      testbench: SourceFile,
      limits: ResourceLimits,
    ): Promise<SimulationVerdict> {
      calls.push({ rtlPaths: rtl.map((file) => file.path), testbenchPath: testbench.path, limits });
      const scripted = script.get(testbench.path);
      if (scripted === undefined) {
        throw new Error(
          `scriptedSimulator: no script entry for unscripted path "${testbench.path}"`,
        );
      }
      return typeof scripted === 'function' ? scripted() : scripted;
    },
  };
}

function designOf(n: number): RunMatrixDesign {
  return { designId: `design-${n}`, rtl: [{ path: `design-${n}.v`, contents: '' }] };
}

function testbenchOf(n: number, nonce: string): RunMatrixTestbench {
  return {
    testbenchId: `testbench-${n}`,
    referenceModel: { path: `testbench-${n}-ref.v`, contents: '' },
    harness: { path: `testbench-${n}-harness.v`, contents: '' },
    nonce,
    moduleInterface: SINGLE_OUTPUT_INTERFACE,
  };
}

describe('executeRunMatrix', () => {
  it('runs every (design, testbench) pair exactly once, asserting the count is N squared', async () => {
    const designs = [designOf(0), designOf(1)];
    const testbenches = [testbenchOf(0, 'nonceA'), testbenchOf(1, 'nonceB')];
    const script = new Map<string, ScriptedAnswer>([
      [testbenches[0]?.harness.path as string, verdictOf({ stdout: sampleStdout('nonceA', '1') })],
      [testbenches[1]?.harness.path as string, verdictOf({ stdout: sampleStdout('nonceB', '0') })],
    ]);
    const simulator = scriptedSimulator(script);

    const request: RunMatrixRequest = { designs, testbenches, simulator };
    const matrix = await executeRunMatrix(request);

    // N = 2 designs, 2 testbenches: 4 cells, 4 simulate calls, one per Cartesian pair.
    expect(matrix.cells).toHaveLength(designs.length * testbenches.length);
    expect(simulator.calls).toHaveLength(designs.length * testbenches.length);
    expect(matrix.designIds).toEqual(designs.map((design) => design.designId));
    expect(matrix.testbenchIds).toEqual(testbenches.map((testbench) => testbench.testbenchId));
  });

  it("isolates one cell's thrown rejection from the rest of the matrix, recording tool-failed", async () => {
    const designs = [designOf(0), designOf(1)];
    const throwingTestbench = testbenchOf(0, 'nonceA');
    const script = new Map<string, ScriptedAnswer>([
      [
        throwingTestbench.harness.path,
        () => {
          throw new Error('simulated infrastructure failure');
        },
      ],
    ]);
    const simulator = scriptedSimulator(script);

    const matrix = await executeRunMatrix({ designs, testbenches: [throwingTestbench], simulator });

    // Both designs' cells against the one throwing testbench are present and isolated: neither
    // the thrown rejection nor the Promise.all scheduling drops the OTHER design's own cell.
    expect(matrix.cells).toHaveLength(2);
    for (const cell of matrix.cells) {
      expect(cell).toMatchObject({ passed: null, signature: null, failureCause: 'tool-failed' });
    }
  });

  it("reduces a passing cell's real stdout into a signature and passed: true", async () => {
    const design = designOf(0);
    const testbench = testbenchOf(0, 'nonceX');
    const script = new Map<string, ScriptedAnswer>([
      [testbench.harness.path, verdictOf({ verdict: 'pass', stdout: sampleStdout('nonceX', '1') })],
    ]);
    const simulator = scriptedSimulator(script);

    const matrix = await executeRunMatrix({
      designs: [design],
      testbenches: [testbench],
      simulator,
    });

    expect(matrix.cells[0]?.passed).toBe(true);
    expect(matrix.cells[0]?.signature).not.toBeNull();
    expect(matrix.cells[0]?.failureCause).toBe('none');
  });

  it('records passed: null and no signature when the simulator verdict is error', async () => {
    const design = designOf(0);
    const testbench = testbenchOf(0, 'nonceY');
    const script = new Map<string, ScriptedAnswer>([
      [
        testbench.harness.path,
        verdictOf({ verdict: 'error', failureCause: 'timed-out', stdout: '' }),
      ],
    ]);
    const simulator = scriptedSimulator(script);

    const matrix = await executeRunMatrix({
      designs: [design],
      testbenches: [testbench],
      simulator,
    });

    expect(matrix.cells[0]).toMatchObject({
      passed: null,
      signature: null,
      failureCause: 'timed-out',
    });
  });

  it("submits every cell under RUN_CELL_RESOURCE_LIMITS, the prototype's measured configuration", async () => {
    const design = designOf(0);
    const testbench = testbenchOf(0, 'nonceZ');
    const script = new Map<string, ScriptedAnswer>([
      [testbench.harness.path, verdictOf({ stdout: sampleStdout('nonceZ', '1') })],
    ]);
    const simulator = scriptedSimulator(script);

    await executeRunMatrix({ designs: [design], testbenches: [testbench], simulator });

    expect(simulator.calls[0]?.limits).toEqual(RUN_CELL_RESOURCE_LIMITS);
  });

  it('submits the Reference_Model workspace file alongside the Candidate_Design RTL', async () => {
    const design = designOf(0);
    const testbench = testbenchOf(0, 'nonceW');
    const script = new Map<string, ScriptedAnswer>([
      [testbench.harness.path, verdictOf({ stdout: sampleStdout('nonceW', '1') })],
    ]);
    const simulator = scriptedSimulator(script);

    await executeRunMatrix({ designs: [design], testbenches: [testbench], simulator });

    const expectedPath = design.rtl[0]?.path;
    expect(simulator.calls[0]?.rtlPaths).toEqual([expectedPath, testbench.referenceModel.path]);
  });

  it('exposes the measured 4-lane concurrency figure as a named, overridable constant', () => {
    expect(RUN_MATRIX_CONCURRENCY_LANES).toBe(4);
  });

  it('runs a realistic 8x8 Design_Pool x Testbench_Pool matrix (N squared = 64 cells)', async () => {
    const designs = Array.from({ length: 8 }, (_, index) => designOf(index));
    const testbenches = Array.from({ length: 8 }, (_, index) =>
      testbenchOf(index, `nonce${String(index)}`),
    );
    const script = new Map<string, ScriptedAnswer>(
      testbenches.map((testbench) => [
        testbench.harness.path,
        verdictOf({ stdout: sampleStdout(testbench.nonce, '1') }),
      ]),
    );
    const simulator = scriptedSimulator(script);

    const matrix = await executeRunMatrix({ designs, testbenches, simulator });

    expect(matrix.cells).toHaveLength(64);
    expect(simulator.calls).toHaveLength(64);
    expect(matrix.cells.every((cell) => cell.passed === true)).toBe(true);
  });
});
