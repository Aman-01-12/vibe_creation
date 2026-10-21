// Example tests for the Benchmark_Regression_Suite driver (task 16.1), driven entirely
// through injected fakes - no toolchain, no real simulator, no real Model_Router.

import { describe, expect, it } from 'vitest';

import {
  makeTimingContract,
  type ModuleInterface,
  type Spec,
  type TimingContract,
} from '@app/core';
import {
  CONSENSUS_POOL_SIZE,
  type ConsensusSessionDeps,
  type DesignGenerator,
  type GeneratedDesign,
  type GeneratedReferenceModel,
  type ModelFamily,
  type MutationStrengthGate,
  type ReferenceModelDraft,
  type ReferenceModelGenerator,
  type SessionOutcome,
  type StructuralGate,
  type StructuralGateResult,
} from '@app/agent';
import type { ResourceLimits, SimulatorAdapter, SourceFile } from '@app/tools';

import type { GoldenJudge, GoldenJudgeRequest, RecordedGoldenVerdict } from '../golden-judge.js';
import {
  CONSENSUS_REGRESSION_EXCLUDED_PROBLEM_IDS,
  consensusRegressionConfigIdentity,
  isExcludedFromConsensusRegression,
  rtlOfDeliveredDesign,
  runConsensusRegressionSample,
  runConsensusRegressionSuite,
  type ConsensusRegressionProblem,
} from './harness.js';
import { STRUCTURAL_GATE_EXCLUSION_IDS } from './structural-gate-exclusions.js';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };

function familyOf(index: number): ModelFamily {
  const providers = ['deepseek', 'gemini', 'claude'] as const;
  return { provider: providers[index % 3] as (typeof providers)[number], lineage: 'x' };
}

/** A minimal accepted draft, for fixtures that only need `GeneratedReferenceModel.draft` to exist. */
const DRAFT_FIXTURE: ReferenceModelDraft = {
  resetStateBody: '',
  nextStateBody: '',
  expectBody: '',
  roles: [],
};

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

function sessionDepsWith(overrides: Partial<ConsensusSessionDeps> = {}): ConsensusSessionDeps {
  return {
    generateDesign: new CountingDesignGenerator(),
    generateReferenceModel: new CountingReferenceModelGenerator(),
    structuralGate: ADMIT_ALL,
    simulator: FAILING_SIMULATOR,
    mutationStrengthGate: NOT_RUN_MUTATION_GATE,
    limits: LIMITS,
    ...overrides,
  };
}

/** A GoldenJudge recording every request it received, returning a fixed verdict. */
class RecordingGoldenJudge implements GoldenJudge {
  requests: GoldenJudgeRequest[] = [];
  readonly #verdict: RecordedGoldenVerdict;

  constructor(verdict: RecordedGoldenVerdict = { kind: 'passed', failureCount: 0 }) {
    this.#verdict = verdict;
  }

  judge(request: GoldenJudgeRequest): Promise<RecordedGoldenVerdict | null> {
    this.requests.push(request);
    return Promise.resolve(this.#verdict);
  }
}

describe('isExcludedFromConsensusRegression - the two Req 16.6 exclusions', () => {
  it('excludes exactly adder_pipe_64bit and asyn_fifo', () => {
    expect(CONSENSUS_REGRESSION_EXCLUDED_PROBLEM_IDS).toEqual([
      'rtllm/arithmetic/adder_pipe_64bit',
      'rtllm/memory/asyn_fifo',
    ]);
    expect(isExcludedFromConsensusRegression('rtllm/arithmetic/adder_pipe_64bit')).toBe(true);
    expect(isExcludedFromConsensusRegression('rtllm/memory/asyn_fifo')).toBe(true);
  });

  it('admits every other problem id', () => {
    expect(isExcludedFromConsensusRegression('rtllm/control/counter_12')).toBe(false);
  });
});

describe('isExcludedFromConsensusRegression - the two Structural_Gate exclusions (Req 12.7)', () => {
  it('excludes float_multi and synchronizer, the real Structural_Gate refusals', () => {
    expect(STRUCTURAL_GATE_EXCLUSION_IDS).toEqual([
      'rtllm/arithmetic/float_multi',
      'rtllm/miscellaneous/synchronizer',
    ]);
    expect(isExcludedFromConsensusRegression('rtllm/arithmetic/float_multi')).toBe(true);
    expect(isExcludedFromConsensusRegression('rtllm/miscellaneous/synchronizer')).toBe(true);
  });
});

describe("consensusRegressionConfigIdentity - folds this spec's five version constants", () => {
  it('reads every field as a positive integer', () => {
    const identity = consensusRegressionConfigIdentity();

    expect(identity.consensusPoolSize).toBe(CONSENSUS_POOL_SIZE);
    for (const value of Object.values(identity)) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });
});

describe("rtlOfDeliveredDesign - reads the delivered design's own RTL, never recomputes it", () => {
  it('returns null for an Unverified_Outcome', () => {
    const outcome: SessionOutcome = {
      kind: 'unverified',
      unmetCondition: 'strict-majority',
      checked: {
        poolSize: 0,
        distinctModelFamilyCount: 0,
        trustedTestbenchCount: 0,
        consensusRunCount: 0,
        largestClusterCardinality: 0,
        structuralGateChecks: [],
      },
      nextActions: ['request-another-attempt', 'accept-unverified'],
      record: {
        clusters: [],
        signaturesByDesign: [],
        modelFamilyByArtifact: [],
        roleDeclarations: [],
        testbenchTrust: [],
        mutantCensus: [],
        poolCorrectness: { poolCorrectness: 0, attributionStatus: 'advisory', faultVerdicts: [] },
        repairAttempts: [],
        tokensSpent: 0,
        runMatrix: { designIds: [], testbenchIds: [], cells: [] },
      },
    };

    expect(rtlOfDeliveredDesign(outcome, new Map())).toBeNull();
  });

  it("returns the delivered design's own RTL for a Verified_Outcome", () => {
    const rtl: readonly SourceFile[] = [{ path: 'd.v', contents: 'module m; endmodule\n' }];
    const outcome: SessionOutcome = {
      kind: 'verified',
      deliveredDesignIds: ['design-1'],
      cluster: { designIds: ['design-1'], digestsByTestbench: [] },
      record: {
        clusters: [],
        signaturesByDesign: [],
        modelFamilyByArtifact: [],
        roleDeclarations: [],
        testbenchTrust: [],
        mutantCensus: [],
        poolCorrectness: { poolCorrectness: 0, attributionStatus: 'advisory', faultVerdicts: [] },
        repairAttempts: [],
        tokensSpent: 0,
        runMatrix: { designIds: [], testbenchIds: [], cells: [] },
      },
    };

    expect(rtlOfDeliveredDesign(outcome, new Map([['design-1', rtl]]))).toBe(rtl);
  });
});

describe('runConsensusRegressionSample - judges only what a Session delivers', () => {
  it('never submits the DELIVERED-design verdict when every design fails the simulator', async () => {
    const goldenJudge = new RecordingGoldenJudge();
    const { sample } = await runConsensusRegressionSample(problemWith('rtllm/control/counter_12'), {
      sessionDeps: sessionDepsWith(),
      goldenJudge,
      limits: LIMITS,
      references: new Map(),
    });

    expect(sample.outcome.kind).toBe('unverified');
    expect(sample.goldenVerdict).toBeNull();
  });

  it('golden-judges every design named by a failing pair, for Attribution_Accuracy ground truth', async () => {
    const goldenJudge = new RecordingGoldenJudge();
    const { sample } = await runConsensusRegressionSample(problemWith('rtllm/control/counter_12'), {
      sessionDeps: sessionDepsWith(),
      goldenJudge,
      limits: LIMITS,
      references: new Map(),
    });

    // Every design in this fixture fails the simulator, so every one of the 8 generated
    // designs is implicated in a failing pair and gets its own golden-judge call.
    expect(sample.designGroundTruth).toHaveLength(8);
    expect(goldenJudge.requests.length).toBeGreaterThanOrEqual(8);
  });

  it('reports no testbench ground truth when the problem has no reference RTL', async () => {
    const { sample } = await runConsensusRegressionSample(problemWith('rtllm/control/counter_12'), {
      sessionDeps: sessionDepsWith(),
      goldenJudge: new RecordingGoldenJudge(),
      limits: LIMITS,
      references: new Map(),
    });

    expect(sample.testbenchGroundTruth.every((entry) => entry.wrong === null)).toBe(true);
  });

  it('records every generated Reference_Model_Testbench with its bodies and roles, no model call needed', async () => {
    const { referenceModelRecords } = await runConsensusRegressionSample(
      problemWith('rtllm/control/counter_12'),
      {
        sessionDeps: sessionDepsWith(),
        goldenJudge: new RecordingGoldenJudge(),
        limits: LIMITS,
        references: new Map(),
      },
    );

    // CONSENSUS_POOL_SIZE testbenches are generated per Session; each gets exactly one record.
    expect(referenceModelRecords).toHaveLength(CONSENSUS_POOL_SIZE);
    for (const record of referenceModelRecords) {
      expect(Object.keys(record).sort()).toEqual(
        [
          'testbenchId',
          'family',
          'referenceModelPromptVersion',
          'resetStateBody',
          'nextStateBody',
          'expectBody',
          'roles',
        ].sort(),
      );
    }
  });

  it('scores a testbench against the reference RTL, independently of the Session matrix verdict', async () => {
    // The reference-RTL run is distinguished from the Session's own matrix runs by RTL content:
    // only the reference-scoring call submits a file at REFERENCE_PATH.
    const REFERENCE_PATH = 'reference-under-test.v';
    const scriptedSimulator: SimulatorAdapter = {
      simulate(rtl) {
        const isReferenceRun = rtl.some((file) => file.path === REFERENCE_PATH);
        return Promise.resolve({
          verdict: isReferenceRun ? 'pass' : 'error',
          checks: [],
          vcd: null,
          stdout: '',
          stderr: '',
          exitCode: isReferenceRun ? 0 : 1,
          resourceUsage: { wallMs: 0, cpuMs: 0, maxMemMb: 0 },
          failureCause: isReferenceRun ? 'none' : 'build-failed',
          attributedFiles: [],
          watchdog: { stopped: false },
        });
      },
    };
    const problemId = 'rtllm/control/counter_12';
    const references = new Map([
      [
        problemId,
        { problemId, rtl: { path: REFERENCE_PATH, contents: '' }, topModuleRenamedFrom: null },
      ],
    ]);

    const { sample } = await runConsensusRegressionSample(problemWith(problemId), {
      sessionDeps: sessionDepsWith({ simulator: scriptedSimulator }),
      goldenJudge: new RecordingGoldenJudge(),
      limits: LIMITS,
      references,
    });

    // Every design fails every testbench against `scriptedSimulator` (not a reference run), so
    // all 8 testbenches are implicated; the reference-scoring run reports `pass`, so none is wrong.
    expect(sample.testbenchGroundTruth).toHaveLength(8);
    expect(sample.testbenchGroundTruth.every((entry) => entry.wrong === false)).toBe(true);
  });
});

describe('runConsensusRegressionSuite - excludes the two named problems and runs the rest in order', () => {
  it('runs every included problem and skips both excluded ones', async () => {
    const goldenJudge = new RecordingGoldenJudge();
    const problems = [
      problemWith('rtllm/arithmetic/adder_pipe_64bit'),
      problemWith('rtllm/control/counter_12'),
      problemWith('rtllm/memory/asyn_fifo'),
    ];

    const report = await runConsensusRegressionSuite(problems, {
      sessionDeps: sessionDepsWith(),
      goldenJudge,
      limits: LIMITS,
      references: new Map(),
    });

    expect(report.samples.map((sample) => sample.problemId)).toEqual(['rtllm/control/counter_12']);
    expect(report.excludedProblemIds).toEqual([
      ...CONSENSUS_REGRESSION_EXCLUDED_PROBLEM_IDS,
      ...STRUCTURAL_GATE_EXCLUSION_IDS,
    ]);
    expect(report.configIdentity).toEqual(consensusRegressionConfigIdentity());
  });
});

describe('runConsensusRegressionSuite - excludedProblemIds carries both exclusion lists', () => {
  it('contains all four excluded ids regardless of which problems were run', async () => {
    const report = await runConsensusRegressionSuite([], {
      sessionDeps: sessionDepsWith(),
      goldenJudge: new RecordingGoldenJudge(),
      limits: LIMITS,
      references: new Map(),
    });

    expect(report.excludedProblemIds).toEqual([
      'rtllm/arithmetic/adder_pipe_64bit',
      'rtllm/memory/asyn_fifo',
      'rtllm/arithmetic/float_multi',
      'rtllm/miscellaneous/synchronizer',
    ]);
  });
});
