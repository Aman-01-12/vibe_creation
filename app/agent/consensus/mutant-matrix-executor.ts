// The in-Session mutant matrix: generates mutants from each admitted Candidate_Design's own
// RTL and runs each one against every Reference_Model_Testbench, so the Mutation_Strength_Gate
// (C12) is fed a real `MutantRunRecord[]` instead of the hardcoded empty array that made every
// Session fail `trusted-testbench-exists` unconditionally (reference-model-consensus-gate,
// design-questions-round3.md, design-answers-round3.md DQ-8/DQ-9).
//
// WHY THIS FILE, AND NOT `session.ts`
//
//   Same rationale `run-matrix-executor.ts` already states for C8: keeps the orchestrator
//   composing rather than executing, keeps the exported function inside the 40-line target,
//   and lets this step be tested in isolation against a scripted simulator.
//
// NO GOLDEN REFERENCE, BECAUSE PRODUCTION HAS NONE
//
//   `@app/eval`'s mutation vocabulary mutates a corpus's golden reference RTL. Production
//   never holds a golden reference, so the mutant source here is each ADMITTED Candidate_Design's
//   own RTL (`GeneratedDesign.rtl`), joined to one string the same way `interfaceCheckPassed`
//   already joins a design's workspace files before reading it.
//
// EXACT, NOT SAMPLED: ONE PASS PER MUTANT BUILDS EVERY TESTBENCH'S ANSWER AT ONCE
//
//   `judge()` is called once per testbench by `session.ts`'s own loop, and each call needs its
//   own exact `killedByJudged`/`killedByPeer` per mutant. Checking "did some OTHER testbench
//   kill it" independently per testbench-under-judgment would re-run the same (mutant,
//   testbench) pair up to once per OTHER testbench in the pool - redundant work, not savings.
//   So this executor runs every (mutant, testbench) pair exactly ONCE, builds one complete
//   kill map, and `recordsFor` projects each testbench's own `MutantRunRecord[]` from that one
//   map by simple lookup - no mutant is ever re-run.
//
// `parentPassedJudged` IS FREE: IT IS THE EXISTING RUN_MATRIX'S OWN CELL
//
//   Whether a mutant's unmutated parent design passes testbench T is exactly `RunCell.passed`
//   for that (design, testbench) pair, which `executeRunMatrix` (C8) already computed. This
//   executor reads it rather than re-simulating the unmutated design, which is why its own
//   request type carries the already-run `RunMatrix` rather than re-deriving it.
//
// SESSION_MUTANTS_PER_DESIGN IS ITS OWN CONSTANT, NOT THE OFFLINE CALIBRATION CAP
//
//   `DEFAULT_MAX_MUTANTS_PER_PROBLEM` (24, `@app/tools`) was sized for a one-time, cached,
//   per-problem offline campaign. This step pays its cost on every Session, so it has its own,
//   smaller cap (design-answers-round3.md DQ-8): large enough to sample a meaningful slice of
//   the 12 operator classes via the existing round-robin selection, small enough that the
//   combined (designs x mutants x testbenches) cost per Session stays bounded.
//
// REUSES THE RUN_MATRIX EXECUTOR'S OWN LANE AND WALL-CLOCK DISCIPLINE
//
//   `RUN_MATRIX_CONCURRENCY_LANES` and `mutantRunLimits` are the same constants C8 already
//   uses, so this step's sandbox load shares the one measured concurrency figure rather than
//   inventing a second one, and a mutant run's wall-clock substitution is the single owner
//   `mutantRunLimits` already is for the offline negative control.
//
// ZERO MODEL TOKENS SPENT HERE
//
//   True by the dependency list: this module imports a simulator port and no model router,
//   exactly like `run-matrix-executor.ts`.

import type { Ulid } from '@app/core';
import {
  generateMutants,
  DEFAULT_MUTANT_WALL_MS,
  mutantRunLimits,
  type Mutant,
  type MutationConfig,
  MUTATION_OPERATORS,
} from '@app/tools';
import type { ResourceLimits, SimulatorAdapter, SourceFile } from '@app/tools';

import type { GeneratedDesign, GeneratedReferenceModel } from './session.js';
import type { MutantRunRecord } from './mutation-strength-gate.js';
import { RUN_MATRIX_CONCURRENCY_LANES } from './run-matrix-executor.js';
import type { RunMatrix } from './run-matrix.js';

/**
 * Mutants generated per admitted Candidate_Design, for THIS in-Session step only.
 *
 * Deliberately smaller than `DEFAULT_MAX_MUTANTS_PER_PROBLEM` (24): that cap was sized for a
 * cached, one-time, per-problem offline campaign, and this step pays its cost on every
 * Session. 6 samples a meaningful slice of the 12 operator classes through the existing
 * round-robin selection while keeping the per-Session mutant count an order of magnitude below
 * the offline campaign's (design-answers-round3.md DQ-8).
 */
export const SESSION_MUTANTS_PER_DESIGN = 6;

/** The mutation config THIS step generates under: every operator, the Session-scoped cap. */
const SESSION_MUTATION_CONFIG: MutationConfig = Object.freeze({
  maxMutantsPerProblem: SESSION_MUTANTS_PER_DESIGN,
  operators: MUTATION_OPERATORS,
});

/** One admitted design's own RTL as a single Verilog source, the way `generateMutants` reads it. */
function joinedRtl(design: GeneratedDesign): string {
  return design.rtl.map((file) => file.contents).join('\n');
}

/** One generated mutant, tagged with the design it was mutated from. */
interface DesignMutant {
  readonly designId: Ulid;
  readonly mutant: Mutant;
}

/** Generate `SESSION_MUTANTS_PER_DESIGN` mutants from each admitted design's own RTL. */
function generateDesignMutants(designs: readonly GeneratedDesign[]): readonly DesignMutant[] {
  return designs.flatMap((design) =>
    generateMutants(joinedRtl(design), SESSION_MUTATION_CONFIG).map((mutant) => ({
      designId: design.designId,
      mutant,
    })),
  );
}

/** Whether a mutant's own RTL compiled, read from the sandbox verdict rather than guessed. */
function compiledFrom(verdict: { readonly failureCause: string }): boolean {
  return verdict.failureCause !== 'build-failed';
}

/** One (mutant, testbench) cell's own kill fact: did that testbench kill it. */
interface MutantCell {
  readonly designId: Ulid;
  readonly mutant: Mutant;
  readonly testbenchId: Ulid;
  readonly compiled: boolean;
  readonly killed: boolean;
}

/**
 * Run one mutant against one testbench, through the real simulator, under the mutant wall cap.
 *
 * Submits the mutant RTL PLUS the testbench's own Reference_Model file, the same two-file
 * workspace `run-matrix-executor.ts`'s `runCell` submits for an unmutated design
 * (`[...design.rtl, testbench.referenceModel]`). The harness calls `ece_reset_state` /
 * `ece_stimulus` / `ece_next_state` / `ece_expect` as compilation-unit-scope functions that
 * live in that separate Reference_Model file; omitting it is a build failure on every mutant,
 * which silently reads as `compiled: false` for the whole matrix rather than a loud error.
 */
async function runMutantCell(
  mutant: DesignMutant,
  testbench: GeneratedReferenceModel,
  simulator: SimulatorAdapter,
  limits: ResourceLimits,
): Promise<MutantCell> {
  const rtl: readonly SourceFile[] = [
    { path: 'mutant.v', contents: mutant.mutant.rtl },
    testbench.referenceModel,
  ];
  const verdict = await simulator.simulate(
    rtl,
    testbench.harness,
    mutantRunLimits(limits, DEFAULT_MUTANT_WALL_MS),
  );
  return {
    designId: mutant.designId,
    mutant: mutant.mutant,
    testbenchId: testbench.testbenchId,
    compiled: compiledFrom(verdict),
    // Any non-pass is a kill, the same rule the offline negative control applies: a testbench's
    // job on a broken design is to refuse to certify it, and the Verification_Loop can mint
    // `Verified` from neither `fail` nor `error`.
    killed: verdict.verdict !== 'pass',
  };
}

/** Run `cellTasks` through `RUN_MATRIX_CONCURRENCY_LANES` concurrent lanes, in no particular order. */
async function runInLanes<T>(cellTasks: readonly (() => Promise<T>)[]): Promise<readonly T[]> {
  const results: T[] = [];
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
 * A stable string key for one (design id, mutant id, testbench id) cell lookup.
 *
 * Keyed by design id as well as mutant id: `mutantId` is `operator@line:column` alone, with
 * no design identity in it, so two different Candidate_Designs implementing the same Spec can
 * easily produce a mutant at the same operator and the same line/column. Dropping the design
 * id from this key would let one design's cell silently answer another's lookup.
 */
function cellKey(designId: Ulid, mutantId: string, testbenchId: Ulid): string {
  return `${designId}\u0000${mutantId}\u0000${testbenchId}`;
}

/** Whether `RunMatrix` names a `passed: true` cell for (designId, testbenchId). */
function parentPassed(matrix: RunMatrix, designId: Ulid, testbenchId: Ulid): boolean {
  return matrix.cells.some(
    (cell) =>
      cell.designId === designId && cell.testbenchId === testbenchId && cell.passed === true,
  );
}

/**
 * Build one testbench's `MutantRunRecord[]` by projecting the already-run cell map - no
 * mutant is re-run. `killedByPeer` is true iff some OTHER testbench's cell for this mutant
 * killed it, read directly off the same map rather than by a second simulate pass.
 */
function recordsFor(
  testbenchId: Ulid,
  mutants: readonly DesignMutant[],
  cellsByKey: ReadonlyMap<string, MutantCell>,
  testbenchIds: readonly Ulid[],
  matrix: RunMatrix,
): readonly MutantRunRecord[] {
  return mutants.map(({ designId, mutant }) => {
    const ownCell = cellsByKey.get(cellKey(designId, mutant.mutantId, testbenchId));
    const killedByPeer = testbenchIds.some((otherId) => {
      if (otherId === testbenchId) {
        return false;
      }
      return cellsByKey.get(cellKey(designId, mutant.mutantId, otherId))?.killed === true;
    });
    return {
      mutant,
      compiled: ownCell?.compiled ?? false,
      parentPassedJudged: parentPassed(matrix, designId, testbenchId),
      killedByPeer,
      killedByJudged: ownCell?.killed ?? false,
    };
  });
}

/**
 * Generate mutants from every admitted design's own RTL and run each one against every
 * Reference_Model_Testbench, returning each testbench's own `MutantRunRecord[]` for
 * `MutationStrengthGate.judge` (C12).
 *
 * Exactly one `simulate` call per (mutant, testbench) pair - `designs.length *
 * SESSION_MUTANTS_PER_DESIGN * testbenches.length` calls - run through
 * `RUN_MATRIX_CONCURRENCY_LANES` concurrent lanes, the same discipline `executeRunMatrix` (C8)
 * already applies to the Design_Pool x Testbench_Pool grid.
 */
export async function runMutantMatrix(
  designs: readonly GeneratedDesign[],
  testbenches: readonly GeneratedReferenceModel[],
  matrix: RunMatrix,
  simulator: SimulatorAdapter,
  limits: ResourceLimits,
): Promise<ReadonlyMap<Ulid, readonly MutantRunRecord[]>> {
  const mutants = generateDesignMutants(designs);
  const cellTasks = mutants.flatMap((mutant) =>
    testbenches.map((testbench) => () => runMutantCell(mutant, testbench, simulator, limits)),
  );
  const cells = await runInLanes(cellTasks);
  const cellsByKey = new Map(
    cells.map((cell) => [cellKey(cell.designId, cell.mutant.mutantId, cell.testbenchId), cell]),
  );
  const testbenchIds = testbenches.map((testbench) => testbench.testbenchId);

  return new Map(
    testbenches.map((testbench) => [
      testbench.testbenchId,
      recordsFor(testbench.testbenchId, mutants, cellsByKey, testbenchIds, matrix),
    ]),
  );
}
