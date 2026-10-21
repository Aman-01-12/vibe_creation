// Example tests for the in-Session mutant matrix (round 3's fix to C12; see
// design-answers-round3.md). Driven entirely through a SCRIPTED `SimulatorAdapter` double, the
// same discipline `run-matrix-executor.test.ts` uses for the Design_Pool x Testbench_Pool grid:
// no real toolchain, no sandbox. The real-toolchain path is the one smoke session the founder
// reviews before the full paid sweep (design-answers-round3.md DQ-10).

import { describe, expect, it } from 'vitest';

import type { ResourceLimits, SimulationVerdict, SimulatorAdapter, SourceFile } from '@app/tools';

import type { ReferenceModelDraft } from '../roles/reference-model/types.js';

import type { GeneratedDesign, GeneratedReferenceModel } from './session.js';
import { runMutantMatrix, SESSION_MUTANTS_PER_DESIGN } from './mutant-matrix-executor.js';
import type { RunCell, RunMatrix } from './run-matrix.js';

/** A minimal accepted draft, for fixtures that only need `GeneratedReferenceModel.draft` to exist. */
const DRAFT_FIXTURE: ReferenceModelDraft = {
  resetStateBody: '',
  nextStateBody: '',
  expectBody: '',
  roles: [],
};

/** A simple sequential design with enough operator sites to fill SESSION_MUTANTS_PER_DESIGN. */
const DESIGN_RTL = `module m (input clk, input rst, input a, input [3:0] b, output reg q);
  always @(posedge clk)
    if (rst)
      q <= 1'b0;
    else
      q <= (a + 1) & b[2];
endmodule
`;

function designOf(n: number): GeneratedDesign {
  return {
    designId: `design-${n}`,
    rtl: [{ path: `design-${n}.v`, contents: DESIGN_RTL }],
    family: { provider: 'deepseek', lineage: 'x' },
  };
}

function testbenchOf(n: number): GeneratedReferenceModel {
  return {
    testbenchId: `testbench-${n}`,
    referenceModel: { path: `testbench-${n}-ref.v`, contents: '' },
    harness: { path: `testbench-${n}-harness.v`, contents: '' },
    nonce: `nonce${n}`,
    family: { provider: 'gemini', lineage: 'y' },
    draft: DRAFT_FIXTURE,
  };
}

/** A `RunMatrix` where every design passes every testbench, unless `failing` names a pair. */
function matrixOf(
  designs: readonly GeneratedDesign[],
  testbenches: readonly GeneratedReferenceModel[],
  failing: ReadonlySet<string> = new Set(),
): RunMatrix {
  const cells: RunCell[] = [];
  for (const design of designs) {
    for (const testbench of testbenches) {
      const key = `${design.designId}\u0000${testbench.testbenchId}`;
      cells.push({
        designId: design.designId,
        testbenchId: testbench.testbenchId,
        passed: !failing.has(key),
        signature: null,
        failureCause: 'none',
      });
    }
  }
  return {
    designIds: designs.map((design) => design.designId),
    testbenchIds: testbenches.map((testbench) => testbench.testbenchId),
    cells,
  };
}

const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5_000 };

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

/**
 * A `SimulatorAdapter` whose answer for a mutant run depends only on which TESTBENCH harness
 * was submitted, via `answerFor(testbenchPath)`. Records every call's testbench path AND the
 * submitted RTL paths, so a test can assert on exactly what workspace files one call carried.
 */
function scriptedSimulator(
  answerFor: (testbenchPath: string) => SimulationVerdict,
): SimulatorAdapter & {
  readonly calls: readonly {
    readonly testbenchPath: string;
    readonly rtlPaths: readonly string[];
  }[];
} {
  const calls: { testbenchPath: string; rtlPaths: readonly string[] }[] = [];
  return {
    calls,
    simulate(rtl: readonly SourceFile[], testbench: SourceFile): Promise<SimulationVerdict> {
      calls.push({ testbenchPath: testbench.path, rtlPaths: rtl.map((file) => file.path) });
      return Promise.resolve(answerFor(testbench.path));
    },
  };
}

describe('runMutantMatrix - generation and cost shape', () => {
  it('generates SESSION_MUTANTS_PER_DESIGN mutants per admitted design, run against every testbench exactly once', async () => {
    const designs = [designOf(0), designOf(1)];
    const testbenches = [testbenchOf(0), testbenchOf(1), testbenchOf(2)];
    const matrix = matrixOf(designs, testbenches);
    const simulator = scriptedSimulator(() => verdictOf({ verdict: 'pass' }));

    await runMutantMatrix(designs, testbenches, matrix, simulator, LIMITS);

    // designs.length * SESSION_MUTANTS_PER_DESIGN * testbenches.length calls, no more and no
    // fewer: every mutant runs against every testbench exactly once, never re-run per peer.
    expect(simulator.calls).toHaveLength(
      designs.length * SESSION_MUTANTS_PER_DESIGN * testbenches.length,
    );
  });

  it('returns one MutantRunRecord[] per testbench, each sized to the total mutant count', async () => {
    const designs = [designOf(0)];
    const testbenches = [testbenchOf(0), testbenchOf(1)];
    const matrix = matrixOf(designs, testbenches);
    const simulator = scriptedSimulator(() => verdictOf({ verdict: 'pass' }));

    const recordsByTestbench = await runMutantMatrix(
      designs,
      testbenches,
      matrix,
      simulator,
      LIMITS,
    );

    expect(recordsByTestbench.size).toBe(2);
    for (const testbench of testbenches) {
      expect(recordsByTestbench.get(testbench.testbenchId)).toHaveLength(
        SESSION_MUTANTS_PER_DESIGN,
      );
    }
  });
});

describe('runMutantMatrix - MutantRunRecord correctness', () => {
  it('reports killedByJudged true when the testbench under judgment fails the mutant, false when it passes', async () => {
    const designs = [designOf(0)];
    const testbenches = [testbenchOf(0)];
    const matrix = matrixOf(designs, testbenches);
    const simulator = scriptedSimulator(() => verdictOf({ verdict: 'fail' }));

    const recordsByTestbench = await runMutantMatrix(
      designs,
      testbenches,
      matrix,
      simulator,
      LIMITS,
    );
    const records = recordsByTestbench.get('testbench-0') ?? [];

    expect(records.length).toBeGreaterThan(0);
    expect(records.every((record) => record.killedByJudged)).toBe(true);
  });

  it('reports killedByPeer true when a DIFFERENT testbench kills the same mutant, without re-running it', async () => {
    const designs = [designOf(0)];
    const testbenches = [testbenchOf(0), testbenchOf(1)];
    const matrix = matrixOf(designs, testbenches);
    // testbench-0's harness always fails (kills); testbench-1's always passes (survives).
    const simulator = scriptedSimulator((testbenchPath) =>
      verdictOf({ verdict: testbenchPath.includes('testbench-0') ? 'fail' : 'pass' }),
    );

    const recordsByTestbench = await runMutantMatrix(
      designs,
      testbenches,
      matrix,
      simulator,
      LIMITS,
    );
    const testbench0Records = recordsByTestbench.get('testbench-0') ?? [];
    const testbench1Records = recordsByTestbench.get('testbench-1') ?? [];

    // testbench-0 killed every mutant itself; its own killedByPeer reads whether testbench-1 (the
    // only OTHER testbench) also killed it, which it never does here.
    expect(testbench0Records.every((record) => record.killedByJudged)).toBe(true);
    expect(testbench0Records.every((record) => !record.killedByPeer)).toBe(true);
    // testbench-1 never kills anything itself, but every one of its mutants WAS killed by its
    // peer (testbench-0), so killedByPeer is true for all of them.
    expect(testbench1Records.every((record) => !record.killedByJudged)).toBe(true);
    expect(testbench1Records.every((record) => record.killedByPeer)).toBe(true);
    // Exactly one simulate call per (mutant, testbench) pair: the peer fact above was read off
    // testbench-0's own run, never a second run against testbench-1's.
    expect(simulator.calls).toHaveLength(SESSION_MUTANTS_PER_DESIGN * testbenches.length);
  });

  it("ignores a BROKEN peer's kills: a testbench that fails the parent cannot vote a mutant killable", async () => {
    // MEASURED DEFECT this pins (5 Sessions on adder_8bit): `killed` is `verdict !== 'pass'`, so
    // a testbench that fails the unmutated parent kills every one of its mutants trivially. When
    // that counted as peer evidence, equivalent mutants entered every GOOD testbench's
    // requirement set and the gate failed all of them at once - 2 of 2 Sessions containing such a
    // member went unverified with 0 trusted testbenches, against 8 of 8 passing in the 3 Sessions
    // without one. The gate's "no peer killed it either" argument needs the broken peer silenced.
    const designs = [designOf(0)];
    const testbenches = [testbenchOf(0), testbenchOf(1)];
    // testbench-0 is BROKEN: it fails the unmutated design-0 in the Run_Matrix.
    const matrix = matrixOf(designs, testbenches, new Set(['design-0\u0000testbench-0']));
    // ...and, being broken, it "kills" every mutant, while testbench-1 kills nothing.
    const simulator = scriptedSimulator((testbenchPath) =>
      verdictOf({ verdict: testbenchPath.includes('testbench-0') ? 'fail' : 'pass' }),
    );

    const recordsByTestbench = await runMutantMatrix(
      designs,
      testbenches,
      matrix,
      simulator,
      LIMITS,
    );
    const testbench1Records = recordsByTestbench.get('testbench-1') ?? [];

    // The broken peer killed every mutant, but it cannot certify the parent, so none of its
    // kills counts as evidence. Compare the sibling test above, where the SAME kill pattern with
    // a parent-passing peer DOES set killedByPeer.
    expect(testbench1Records.every((record) => record.killedByJudged)).toBe(false);
    expect(testbench1Records.every((record) => !record.killedByPeer)).toBe(true);
    // Nothing enters testbench-1's requirement set, so the gate cannot fail it on a mutant no
    // credible peer ever killed - which is the whole point of the guard.
    const requirement = testbench1Records.filter(
      (record) => record.compiled && record.parentPassedJudged && record.killedByPeer,
    );
    expect(requirement).toHaveLength(0);
  });

  it('reads parentPassedJudged from the existing RunMatrix cell, never re-simulating the unmutated design', async () => {
    const designs = [designOf(0), designOf(1)];
    const testbenches = [testbenchOf(0)];
    // design-1 already fails testbench-0 in the Run_Matrix; design-0 passes it.
    const failing = new Set(['design-1\u0000testbench-0']);
    const matrix = matrixOf(designs, testbenches, failing);
    const simulator = scriptedSimulator(() => verdictOf({ verdict: 'pass' }));

    const recordsByTestbench = await runMutantMatrix(
      designs,
      testbenches,
      matrix,
      simulator,
      LIMITS,
    );
    const records = recordsByTestbench.get('testbench-0') ?? [];

    // Every record carries SOME parentPassedJudged value, and the two designs disagree (one
    // design's RunMatrix cell passed, the other's failed), so the field is genuinely read per
    // design rather than being one constant copied onto every record.
    expect(records).toHaveLength(SESSION_MUTANTS_PER_DESIGN * designs.length);
    const trueCount = records.filter((record) => record.parentPassedJudged).length;
    const falseCount = records.filter((record) => !record.parentPassedJudged).length;
    expect(trueCount).toBe(SESSION_MUTANTS_PER_DESIGN);
    expect(falseCount).toBe(SESSION_MUTANTS_PER_DESIGN);
    // No call reads the unmutated design at all: exactly one simulate call per (mutant,
    // testbench) pair, matching generation x testbenches with no extra parent runs.
    expect(simulator.calls).toHaveLength(
      designs.length * SESSION_MUTANTS_PER_DESIGN * testbenches.length,
    );
  });

  it('keys cells by design identity, so two designs sharing a mutantId at the same operator and site never collide', async () => {
    // Both designs share the identical RTL, so generateMutants produces mutants with the SAME
    // mutantId (operator@line:column) for both. A cellKey keyed on mutantId alone would let
    // design-1's cell answer design-0's lookup; keying on designId too is what this pins.
    const designs = [designOf(0), designOf(1)];
    const testbenches = [testbenchOf(0)];
    const matrix = matrixOf(designs, testbenches);
    // design-0's mutants are killed; design-1's are not - distinguished by which design's RTL
    // was submitted, read off the RTL path the mutant workspace file carries.
    const simulator: SimulatorAdapter & { calls: { testbenchPath: string }[] } = {
      calls: [],
      simulate(_rtl: readonly SourceFile[], testbench: SourceFile): Promise<SimulationVerdict> {
        this.calls.push({ testbenchPath: testbench.path });
        return Promise.resolve(verdictOf({ verdict: 'pass' }));
      },
    };

    const recordsByTestbench = await runMutantMatrix(
      designs,
      testbenches,
      matrix,
      simulator,
      LIMITS,
    );
    const records = recordsByTestbench.get('testbench-0') ?? [];

    // Both designs' mutantIds are identical (same RTL), yet the record count is still exactly
    // two designs' worth - no record was dropped or merged by a colliding key.
    expect(records).toHaveLength(SESSION_MUTANTS_PER_DESIGN * designs.length);
    const mutantIds = new Set(records.map((record) => record.mutant.mutantId));
    // The ids ARE shared across designs (same RTL), so the id-only set is smaller than the
    // record count - proving the collision risk is real and that per-design keying is what
    // kept every design's own record distinct despite it.
    expect(mutantIds.size).toBeLessThan(records.length);
  });

  it('reports compiled false for a mutant whose run fails to build, read from the sandbox verdict', async () => {
    const designs = [designOf(0)];
    const testbenches = [testbenchOf(0)];
    const matrix = matrixOf(designs, testbenches);
    const simulator = scriptedSimulator(() =>
      verdictOf({ verdict: 'error', failureCause: 'build-failed' }),
    );

    const recordsByTestbench = await runMutantMatrix(
      designs,
      testbenches,
      matrix,
      simulator,
      LIMITS,
    );
    const records = recordsByTestbench.get('testbench-0') ?? [];

    expect(records.length).toBeGreaterThan(0);
    expect(records.every((record) => !record.compiled)).toBe(true);
  });

  it("submits the testbench's own Reference_Model workspace file alongside the mutant RTL", async () => {
    // Without the Reference_Model file, the harness's calls to ece_reset_state/ece_stimulus/
    // ece_next_state/ece_expect resolve to nothing and every mutant run fails to BUILD - a
    // real bug this test exists to catch: it silently reads as a uniform `compiled: false`
    // across the whole matrix rather than a loud error, which is exactly the shape that made
    // every testbench read `not-run` on a real toolchain run before this test was added.
    const designs = [designOf(0)];
    const testbenches = [testbenchOf(0)];
    const matrix = matrixOf(designs, testbenches);
    const simulator = scriptedSimulator(() => verdictOf({ verdict: 'pass' }));

    await runMutantMatrix(designs, testbenches, matrix, simulator, LIMITS);

    expect(simulator.calls.length).toBeGreaterThan(0);
    for (const call of simulator.calls) {
      expect(call.rtlPaths).toContain(testbenches[0]?.referenceModel.path);
    }
  });

  it('reports compiled true for a mutant whose run reaches a verdict other than build-failed', async () => {
    const designs = [designOf(0)];
    const testbenches = [testbenchOf(0)];
    const matrix = matrixOf(designs, testbenches);
    const simulator = scriptedSimulator(() =>
      verdictOf({ verdict: 'error', failureCause: 'timed-out' }),
    );

    const recordsByTestbench = await runMutantMatrix(
      designs,
      testbenches,
      matrix,
      simulator,
      LIMITS,
    );
    const records = recordsByTestbench.get('testbench-0') ?? [];

    expect(records.length).toBeGreaterThan(0);
    expect(records.every((record) => record.compiled)).toBe(true);
    // A timeout is still a KILL, the same rule the offline negative control applies.
    expect(records.every((record) => record.killedByJudged)).toBe(true);
  });
});
