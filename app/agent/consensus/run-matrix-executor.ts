// The Run_Matrix executor: drives the N squared Consensus_Runs of a Session through the real
// simulator, four lanes at a time (C8; Req 4.8, 8.5, 15.4, 15.6, 17.3).
//
// WHY THIS FILE, AND NOT `session.ts`
//
//   design.md places C8 in `app/agent/consensus/session.ts`. Splitting it into its own file keeps
//   the orchestrator (C1, `session.ts`) composing rather than executing, keeps both functions
//   inside the 40-line target, and lets group 13 proceed without serializing against this task.
//   Same component, same package, one file boundary.
//
// NO SEAM CHANGE
//
//   Each Consensus_Run is one existing `simulate` sandbox job through `IcarusSimulatorAdapter`,
//   carrying three workspace files: the Candidate_Design, the Reference_Model, and the rendered
//   Consensus_Harness. The harness replaces `SIMULATION_HARNESS` in the workspace file list,
//   `simulate.defaultTimescale` is set exactly as it is today, and `SIMULATE_REQUIRED_OUTPUTS` is
//   unchanged, so the run still produces a VCD and still classifies `error` if it does not. The
//   VCD bytes are never read.
//
// KEEPING THE DUMP AND NOT READING IT IS DELIBERATE OVER THREE ALTERNATIVES
//
//   Dropping the dump needs a new required-output set and a worker change for no gain. Reading it
//   on the host is measured unaffordable: a VCD reaches the 16 MB `$dumplimit`,
//   `BoundedArtifactRetention` caps one artifact at 131,072 bytes and the store at 1,048,576, 64
//   runs at 16 MB is a gigabyte per Session, and the prototype exhausted a 2 GB heap at 1,312 of
//   7,296 runs. Reducing it inside the sandbox means a second implementation of the signature
//   algebra in the worker's Python. Emitting at the Sample_Point costs none of those, because the
//   harness already knows when a Sample_Point is.
//
// FIVE INDEPENDENT BOUNDS, EACH CLOSING A DIFFERENT FAILURE
//
//   Per-run `ResourceLimits` (cpu 1, memMb 512, procs 128, diskMb 128, wallMs 30,000 - the
//   prototype's measured configuration over 14,592 runs). A Watchdog_Budget of 2,000,000 ns in
//   simulated time, reused from `simulation-harness.ts`. The computed Sample_Budget from task 7.3
//   (`sizedSampleBudget`). A run count of N squared, which this executor ASSERTS rather than
//   merely expects. And 4 concurrency lanes.
//
// ponytail: 4 lanes is the measured host figure (the prototype's own `WORKERS` value), not a
// theoretical ceiling; the upgrade path when the host changes is one constant, not a scheduler.
//
// CATCH PER CELL, NEVER PER SESSION
//
//   One bad pair records a `RunFailureCause` and cannot end a Session of 64, the same discipline
//   the prototype's `THREW` symbol already followed.
//
// NO SESSION-LEVEL WALL BUDGET, DELIBERATELY
//
//   The worst bounded case is 64 runs each hitting the 30,000 ms ceiling, which is 480 s at 4
//   lanes, and a Session in that state is producing no signatures so it reaches an
//   Unverified_Outcome on the no-Trusted_Testbench condition anyway. A session-level budget would
//   have to choose which pairs to drop, and any such choice shrinks N silently.
//
// ZERO MODEL TOKENS SPENT HERE
//
//   True by the dependency list: this module imports a simulator port and no model router.

import type { ModuleInterface, Ulid } from '@app/core';
import type { ResourceLimits, SimulatorAdapter, SourceFile } from '@app/tools';

import { reduceSignature, type WaveformSignature } from './signature.js';
import type { RunCell, RunMatrix } from './run-matrix.js';

/** The prototype's own measured host-contention figure; see the module header's `ponytail:` note. */
export const RUN_MATRIX_CONCURRENCY_LANES = 4;

/** The prototype's measured configuration over 14,592 runs; closes a hung or greedy run. */
export const RUN_CELL_RESOURCE_LIMITS: ResourceLimits = {
  cpu: 1,
  memMb: 512,
  procs: 128,
  diskMb: 128,
  wallMs: 30_000,
};

/** One Candidate_Design or Reference_Model_Testbench the executor runs against every peer. */
export interface RunMatrixDesign {
  readonly designId: Ulid;
  readonly rtl: readonly SourceFile[];
}

/** One Reference_Model_Testbench: its identity, its own source file, and the harness rendered for it. */
export interface RunMatrixTestbench {
  readonly testbenchId: Ulid;
  readonly referenceModel: SourceFile;
  readonly harness: SourceFile;
  readonly nonce: string;
  readonly moduleInterface: ModuleInterface;
}

/** One `executeRunMatrix` request: the N designs, the N testbenches, and the simulator to drive. */
export interface RunMatrixRequest {
  readonly designs: readonly RunMatrixDesign[];
  readonly testbenches: readonly RunMatrixTestbench[];
  readonly simulator: SimulatorAdapter;
}

/** Run exactly one (design, testbench) pair's Consensus_Run through the real simulator. */
async function runCell(
  design: RunMatrixDesign,
  testbench: RunMatrixTestbench,
  simulator: SimulatorAdapter,
): Promise<RunCell> {
  const rtl = [...design.rtl, testbench.referenceModel];
  const verdict = await simulator.simulate(rtl, testbench.harness, RUN_CELL_RESOURCE_LIMITS);
  const signature: WaveformSignature | null =
    verdict.verdict === 'error'
      ? null
      : reduceSignature(verdict.stdout, testbench.nonce, testbench.moduleInterface);
  return {
    designId: design.designId,
    testbenchId: testbench.testbenchId,
    passed: signature === null ? null : verdict.verdict === 'pass',
    signature,
    failureCause: verdict.failureCause,
  };
}

/**
 * Run every (design, testbench) cell of the Cartesian product through `RUN_MATRIX_CONCURRENCY_LANES`
 * concurrent lanes, catching one cell's own failure without letting it end the others (Req 8.5).
 *
 * A thrown rejection from `runCell` itself (as opposed to a `SimulationVerdict` carrying its own
 * `failureCause`) is caught here and recorded as `tool-failed`, so a cell cannot end the Session
 * of N squared the way the prototype's own `THREW` symbol existed to prevent.
 */
async function runCellSafely(
  design: RunMatrixDesign,
  testbench: RunMatrixTestbench,
  simulator: SimulatorAdapter,
): Promise<RunCell> {
  try {
    return await runCell(design, testbench, simulator);
  } catch {
    return {
      designId: design.designId,
      testbenchId: testbench.testbenchId,
      passed: null,
      signature: null,
      failureCause: 'tool-failed',
    };
  }
}

/** Run `cellTasks` through `RUN_MATRIX_CONCURRENCY_LANES` concurrent lanes, in no particular order. */
async function runInLanes(
  cellTasks: readonly (() => Promise<RunCell>)[],
): Promise<readonly RunCell[]> {
  const results: RunCell[] = [];
  let nextIndex = 0;

  async function lane(): Promise<void> {
    while (nextIndex < cellTasks.length) {
      const taskIndex = nextIndex;
      nextIndex += 1;
      const task = cellTasks[taskIndex];
      if (task === undefined) {
        continue;
      }
      results.push(await task());
    }
  }

  const lanes = Array.from(
    { length: Math.min(RUN_MATRIX_CONCURRENCY_LANES, cellTasks.length) },
    () => lane(),
  );
  await Promise.all(lanes);
  return results;
}

/**
 * Execute the full Run_Matrix for one Session: every (design, testbench) pair of the Cartesian
 * product, through the real simulator, four lanes at a time (Req 4.8, 8.5, 15.4, 17.3).
 *
 * Asserts the run count is exactly `designs.length * testbenches.length` (Req 15.4) rather than
 * merely expecting it, since a lane-scheduling defect that silently dropped a cell would shrink N
 * in exactly the way the design's Error Handling forbids elsewhere.
 */
export async function executeRunMatrix(request: RunMatrixRequest): Promise<RunMatrix> {
  const { designs, testbenches, simulator } = request;
  const cellTasks = designs.flatMap((design) =>
    testbenches.map((testbench) => () => runCellSafely(design, testbench, simulator)),
  );

  const cells = await runInLanes(cellTasks);

  const expectedCellCount = designs.length * testbenches.length;
  if (cells.length !== expectedCellCount) {
    throw new Error(
      `Run_Matrix defect: expected ${String(expectedCellCount)} cells, executed ${String(cells.length)}`,
    );
  }

  return {
    designIds: designs.map((design) => design.designId),
    testbenchIds: testbenches.map((testbench) => testbench.testbenchId),
    cells,
  };
}
