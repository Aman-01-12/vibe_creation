// structural-gate-toolchain, Property 10: The suite drives exactly the problems neither
// list excludes (task 7.3; Req 12.7).
//
// THE ORACLE IS INDEPENDENT OF THE CODE UNDER TEST
//   `expectedExcluded` restates the design's own rule - either exclusion list names the
//   id - without calling `isExcludedFromConsensusRegression`, and the suite-level property
//   restates the filter with `Array#filter` over that independent oracle rather than
//   reusing the function it is checking.
//
// WHAT A SAMPLED DRAW WOULD MISS, PINNED BY CONSTRUCTION (per the task's own draw list)
//   - a problem set carrying one id from `CONSENSUS_REGRESSION_EXCLUDED_PROBLEM_IDS` and
//     one id from `STRUCTURAL_GATE_EXCLUSION_IDS` together: neither list's membership test
//     is allowed to shadow the other.
//   - a problem set carrying an id from each list AND the synthetic ids are randomised
//     around them, so the suite's own `excludedProblemIds` report never depends on which
//     problems were actually passed in.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  makeTimingContract,
  type ModuleInterface,
  type Spec,
  type TimingContract,
} from '@app/core';
import type {
  ConsensusSessionDeps,
  DesignGenerator,
  GeneratedDesign,
  GeneratedReferenceModel,
  ModelFamily,
  MutationStrengthGate,
  ReferenceModelDraft,
  ReferenceModelGenerator,
  StructuralGate,
  StructuralGateResult,
} from '@app/agent';
import {
  CONSENSUS_REGRESSION_EXCLUDED_PROBLEM_IDS,
  isExcludedFromConsensusRegression,
  runConsensusRegressionSuite,
  STRUCTURAL_GATE_EXCLUSION_IDS,
  type ConsensusRegressionProblem,
  type GoldenJudge,
  type GoldenJudgeRequest,
  type RecordedGoldenVerdict,
} from '@app/eval';
import type { ResourceLimits, SimulatorAdapter, SourceFile } from '@app/tools';

import { propertyParameters } from './property.js';

const PROPERTY =
  'structural-gate-toolchain, Property 10: The suite drives exactly the problems neither ' +
  'list excludes';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };

const ALL_EXCLUDED_IDS: readonly string[] = [
  ...CONSENSUS_REGRESSION_EXCLUDED_PROBLEM_IDS,
  ...STRUCTURAL_GATE_EXCLUSION_IDS,
];

function familyOf(index: number): ModelFamily {
  const providers = ['deepseek', 'gemini', 'claude'] as const;
  return { provider: providers[index % 3] as (typeof providers)[number], lineage: 'x' };
}

function moduleInterfaceWith(outputPortNames: readonly string[]): ModuleInterface {
  return {
    validityOutputName: null,
    moduleName: 'm',
    ports: outputPortNames.map((name) => ({ name, direction: 'output' as const, width: 1 })),
    clocking: { clockName: null, resetName: null, resetActiveLow: false },
  };
}

function totalTimingContract(moduleInterface: ModuleInterface): TimingContract {
  const built = makeTimingContract(
    moduleInterface,
    moduleInterface.ports.map((port) => ({
      portName: port.name,
      timing: 'combinational' as const,
    })),
  );
  if (!built.ok) {
    throw new Error('fixture built an invalid timing contract');
  }
  return built.value;
}

function specWith(moduleInterface: ModuleInterface): Spec {
  return {
    id: 'spec-1',
    projectId: 'proj-1',
    goal: 'A trivial module',
    constraints: [],
    architecture: 'n/a',
    moduleInterface,
    timingContract: totalTimingContract(moduleInterface),
    acceptanceCriteria: [],
    approved: true,
    version: 1,
  };
}

function problemWith(problemId: string): ConsensusRegressionProblem {
  return { problemId, spec: specWith(moduleInterfaceWith(['q'])) };
}

/** A minimal accepted draft, for fixtures that only need `GeneratedReferenceModel.draft` to exist. */
const DRAFT_FIXTURE: ReferenceModelDraft = {
  resetStateBody: '',
  nextStateBody: '',
  expectBody: '',
  roles: [],
};

/** A design generator that always succeeds, with a fixed RTL body keyed by call count. */
class CountingDesignGenerator implements DesignGenerator {
  calls = 0;
  generate(): Promise<GeneratedDesign> {
    this.calls += 1;
    const index = this.calls;
    const rtl: SourceFile[] = [{ path: 'd.v', contents: `module m; /* ${index} */ endmodule\n` }];
    return Promise.resolve({ designId: `design-${index}`, rtl, family: familyOf(index) });
  }
}

/** A reference-model generator that always succeeds. */
class CountingReferenceModelGenerator implements ReferenceModelGenerator {
  calls = 0;
  generate(): Promise<GeneratedReferenceModel> {
    this.calls += 1;
    const index = this.calls;
    return Promise.resolve({
      testbenchId: `testbench-${index}`,
      referenceModel: { path: 'r.v', contents: '' },
      harness: { path: 'h.v', contents: '' },
      nonce: `nonce${index}`,
      family: familyOf(index),
      draft: DRAFT_FIXTURE,
    });
  }
}

/** A Structural_Gate that admits every design. */
const ADMIT_ALL: StructuralGate = {
  admit(): Promise<StructuralGateResult> {
    return Promise.resolve({ admitted: true, checks: [] });
  },
};

/** A simulator that always reports a build failure, with no toolchain involved. */
const FAILING_SIMULATOR: SimulatorAdapter = {
  simulate() {
    return Promise.resolve({
      verdict: 'error',
      checks: [],
      vcd: null,
      stdout: '',
      stderr: '',
      exitCode: 1,
      resourceUsage: { wallMs: 0, cpuMs: 0, maxMemMb: 0 },
      failureCause: 'build-failed',
      attributedFiles: [],
      watchdog: { stopped: false },
    });
  },
};

/** A Mutation_Strength_Gate that reports not-run for everything. */
const NOT_RUN_MUTATION_GATE: MutationStrengthGate = {
  judge() {
    return Promise.resolve({ kind: 'not-run' as const });
  },
};

function sessionDepsWith(): ConsensusSessionDeps {
  return {
    generateDesign: new CountingDesignGenerator(),
    generateReferenceModel: new CountingReferenceModelGenerator(),
    structuralGate: ADMIT_ALL,
    simulator: FAILING_SIMULATOR,
    mutationStrengthGate: NOT_RUN_MUTATION_GATE,
    limits: LIMITS,
  };
}

/** A GoldenJudge that never scores anything; the suite's filtering is what is under test. */
class RecordingGoldenJudge implements GoldenJudge {
  requests: GoldenJudgeRequest[] = [];
  readonly #verdict: RecordedGoldenVerdict = { kind: 'passed', failureCount: 0 };

  judge(request: GoldenJudgeRequest): Promise<RecordedGoldenVerdict | null> {
    this.requests.push(request);
    return Promise.resolve(this.#verdict);
  }
}

/** A synthetic `rtllm/<category>/<name>`-shaped id, astronomically unlikely to collide with a real one. */
function arbSyntheticProblemId(): fc.Arbitrary<string> {
  const slug = fc.stringMatching(/^[a-z][a-z0-9_]{0,19}$/).filter((value) => value.length > 0);
  return fc.tuple(slug, slug).map(([category, name]) => `rtllm/${category}/${name}`);
}

/** Any problem id: mostly synthetic, occasionally one of the four real excluded ids. */
function arbProblemId(): fc.Arbitrary<string> {
  return fc.oneof(
    { weight: 3, arbitrary: arbSyntheticProblemId() },
    { weight: 1, arbitrary: fc.constantFrom(...ALL_EXCLUDED_IDS) },
  );
}

/** design.md's rule, restated independently of `isExcludedFromConsensusRegression`. */
function expectedExcluded(problemId: string): boolean {
  return (
    CONSENSUS_REGRESSION_EXCLUDED_PROBLEM_IDS.includes(problemId) ||
    STRUCTURAL_GATE_EXCLUSION_IDS.includes(problemId)
  );
}

describe(PROPERTY, () => {
  it('isExcludedFromConsensusRegression matches the independent two-list oracle for any id', () => {
    fc.assert(
      fc.property(arbProblemId(), (problemId) => {
        expect(isExcludedFromConsensusRegression(problemId)).toBe(expectedExcluded(problemId));
      }),
      propertyParameters(),
    );
  });

  it('runConsensusRegressionSuite drives exactly the non-excluded ids, in input order', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(arbProblemId(), { maxLength: 12 }), async (problemIds) => {
        const problems = problemIds.map(problemWith);
        const report = await runConsensusRegressionSuite(problems, {
          sessionDeps: sessionDepsWith(),
          goldenJudge: new RecordingGoldenJudge(),
          limits: LIMITS,
          references: new Map(),
        });

        expect(report.samples.map((sample) => sample.problemId)).toEqual(
          problemIds.filter((id) => !expectedExcluded(id)),
        );
        expect(report.excludedProblemIds).toEqual(ALL_EXCLUDED_IDS);
      }),
      propertyParameters(),
    );
  });

  it('excludes an input carrying one id from each list, run alongside an ordinary id', async () => {
    const fromRegressionList = CONSENSUS_REGRESSION_EXCLUDED_PROBLEM_IDS[0] as string;
    const fromStructuralGateList = STRUCTURAL_GATE_EXCLUSION_IDS[0] as string;
    const problems = [
      problemWith(fromRegressionList),
      problemWith('rtllm/control/counter_12'),
      problemWith(fromStructuralGateList),
    ];

    const report = await runConsensusRegressionSuite(problems, {
      sessionDeps: sessionDepsWith(),
      goldenJudge: new RecordingGoldenJudge(),
      limits: LIMITS,
      references: new Map(),
    });

    expect(report.samples.map((sample) => sample.problemId)).toEqual(['rtllm/control/counter_12']);
    expect(report.excludedProblemIds).toEqual(ALL_EXCLUDED_IDS);
  });

  it('reports both full lists as excluded even when the input covers every id on both', async () => {
    const problems = ALL_EXCLUDED_IDS.map(problemWith);

    const report = await runConsensusRegressionSuite(problems, {
      sessionDeps: sessionDepsWith(),
      goldenJudge: new RecordingGoldenJudge(),
      limits: LIMITS,
      references: new Map(),
    });

    expect(report.samples).toEqual([]);
    expect(report.excludedProblemIds).toEqual(ALL_EXCLUDED_IDS);
  });
});
