// Example tests for runStudentRun (task 13.2), driven entirely through injected fakes.

import { describe, expect, it } from 'vitest';

import {
  makeTimingContract,
  type ModuleInterface,
  type Spec,
  type TimingContract,
} from '@app/core';
import type { ResourceLimits, SimulatorAdapter } from '@app/tools';

import type { ReferenceModelDraft } from '../roles/reference-model/types.js';

import { makeBudgetLedger } from './budget.js';
import type { ModelFamily } from './model-family.js';
import type { MutationStrengthGate } from './mutation-strength-gate.js';
import type {
  ConsensusSessionDeps,
  DesignGenerator,
  GeneratedDesign,
  GeneratedReferenceModel,
  ReferenceModelGenerator,
} from './session.js';
import { MAX_STUDENT_RUN_ATTEMPTS, runStudentRun } from './student-run.js';
import type { StructuralGate, StructuralGateResult } from './structural-gate.js';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };

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

/** A design generator that always succeeds, counting its own calls across every attempt. */
class CountingDesignGenerator implements DesignGenerator {
  calls = 0;
  generate(): Promise<GeneratedDesign> {
    this.calls += 1;
    const index = this.calls;
    const providers = ['deepseek', 'gemini', 'claude'] as const;
    const family: ModelFamily = {
      provider: providers[index % 3] as (typeof providers)[number],
      lineage: 'x',
    };
    return Promise.resolve({
      designId: `design-${index}`,
      rtl: [{ path: 'd.v', contents: 'module m; endmodule\n' }],
      family,
    });
  }
}

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
      family: { provider: 'deepseek', lineage: 'x' },
      draft: DRAFT_FIXTURE,
    });
  }
}

const ADMIT_ALL: StructuralGate = {
  admit(): Promise<StructuralGateResult> {
    return Promise.resolve({ admitted: true, checks: [] });
  },
};

/** A simulator that always errors out, so no Session can ever reach a Verified_Outcome. */
const FAILING_SIMULATOR: SimulatorAdapter = {
  simulate() {
    return Promise.resolve({
      verdict: 'error' as const,
      checks: [],
      vcd: null,
      stdout: '',
      stderr: '',
      exitCode: 1,
      resourceUsage: { wallMs: 0, cpuMs: 0, maxMemMb: 0 },
      failureCause: 'build-failed' as const,
      attributedFiles: [],
      watchdog: { stopped: false },
    });
  },
};

const NOT_RUN_MUTATION_GATE: MutationStrengthGate = {
  judge() {
    return Promise.resolve({ kind: 'not-run' as const });
  },
};

function depsFor(
  designGenerator: DesignGenerator,
  referenceModelGenerator: ReferenceModelGenerator,
): ConsensusSessionDeps {
  return {
    generateDesign: designGenerator,
    generateReferenceModel: referenceModelGenerator,
    structuralGate: ADMIT_ALL,
    simulator: FAILING_SIMULATOR,
    mutationStrengthGate: NOT_RUN_MUTATION_GATE,
    limits: LIMITS,
  };
}

describe('runStudentRun - example tests against injected fakes', () => {
  it('runs up to MAX_STUDENT_RUN_ATTEMPTS Sessions, each generating a fresh pool', async () => {
    const designGenerator = new CountingDesignGenerator();
    const referenceModelGenerator = new CountingReferenceModelGenerator();
    const spec = specWith(moduleInterfaceWith(['q']));

    const result = await runStudentRun(spec, depsFor(designGenerator, referenceModelGenerator));

    expect(result.attempts).toBe(MAX_STUDENT_RUN_ATTEMPTS);
    expect(result.outcome.kind).toBe('unverified');
    // Every attempt regenerates a fresh pool: 8 designs/testbenches per attempt, 3 attempts.
    expect(designGenerator.calls).toBe(8 * MAX_STUDENT_RUN_ATTEMPTS);
    expect(referenceModelGenerator.calls).toBe(8 * MAX_STUDENT_RUN_ATTEMPTS);
  });

  it('stops early with run-token-budget as the cause when the Run ledger cannot afford another attempt', async () => {
    const designGenerator = new CountingDesignGenerator();
    const referenceModelGenerator = new CountingReferenceModelGenerator();
    const spec = specWith(moduleInterfaceWith(['q']));
    // A Run ledger that is already exhausted before the first attempt.
    const exhaustedRunLedger = makeBudgetLedger(1, 'run-token-budget');
    exhaustedRunLedger.charge(1);

    const result = await runStudentRun(
      spec,
      depsFor(designGenerator, referenceModelGenerator),
      exhaustedRunLedger,
    );

    expect(result.attempts).toBe(0);
    expect(result.outcome.kind).toBe('unverified');
    if (result.outcome.kind === 'unverified') {
      expect(result.outcome.unmetCondition).toBe('run-token-budget');
    }
    expect(designGenerator.calls).toBe(0);
  });
});
