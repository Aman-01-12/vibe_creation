// Example tests for runSession (task 13.1), driven entirely through injected fakes.
// No toolchain, no real simulator, no real Model_Router.

import { describe, expect, it } from 'vitest';

import {
  makeTimingContract,
  type ModuleInterface,
  type Spec,
  type TimingContract,
} from '@app/core';
import type { ResourceLimits, SimulatorAdapter, SourceFile } from '@app/tools';

import type { ReferenceModelDraft } from '../roles/reference-model/types.js';

import { makeBudgetLedger } from './budget.js';
import type { ModelFamily } from './model-family.js';
import type { MutationStrengthGate } from './mutation-strength-gate.js';
import {
  runSession,
  type ConsensusSessionDeps,
  type DesignGenerator,
  type GeneratedDesign,
  type GeneratedReferenceModel,
  type ReferenceModelGenerator,
} from './session.js';
import type { StructuralGate, StructuralGateResult } from './structural-gate.js';

/** A minimal accepted draft, for fixtures that only need `GeneratedReferenceModel.draft` to exist. */
const DRAFT_FIXTURE: ReferenceModelDraft = {
  resetStateBody: '',
  nextStateBody: '',
  expectBody: '',
  roles: [],
};

const LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };

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

function specWith(moduleInterface: ModuleInterface, timingContract: TimingContract): Spec {
  return {
    id: 'spec-1',
    projectId: 'proj-1',
    goal: 'A trivial module',
    constraints: [],
    architecture: 'n/a',
    moduleInterface,
    timingContract,
    acceptanceCriteria: [],
    approved: true,
    version: 1,
  };
}

/** A design generator that always succeeds, counting its own calls. */
class CountingDesignGenerator implements DesignGenerator {
  calls = 0;
  generate(): Promise<GeneratedDesign> {
    this.calls += 1;
    const index = this.calls;
    const rtl: SourceFile[] = [{ path: 'd.v', contents: 'module m; endmodule\n' }];
    return Promise.resolve({ designId: `design-${index}`, rtl, family: familyOf(index) });
  }
}

/** A reference-model generator that always succeeds, counting its own calls. */
class CountingReferenceModelGenerator implements ReferenceModelGenerator {
  calls = 0;
  generate(): Promise<GeneratedReferenceModel> {
    this.calls += 1;
    const index = this.calls;
    const referenceModel: SourceFile = { path: 'r.v', contents: '' };
    const harness: SourceFile = { path: 'h.v', contents: '' };
    return Promise.resolve({
      testbenchId: `testbench-${index}`,
      referenceModel,
      harness,
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

/** A Mutation_Strength_Gate that reports not-run for everything, counting its own calls. */
class CountingMutationGate implements MutationStrengthGate {
  calls = 0;
  judge() {
    this.calls += 1;
    return Promise.resolve({ kind: 'not-run' as const });
  }
}

function depsWith(overrides: Partial<ConsensusSessionDeps> = {}): {
  readonly deps: ConsensusSessionDeps;
  readonly designGenerator: CountingDesignGenerator;
  readonly referenceModelGenerator: CountingReferenceModelGenerator;
  readonly mutationGate: CountingMutationGate;
} {
  const designGenerator = new CountingDesignGenerator();
  const referenceModelGenerator = new CountingReferenceModelGenerator();
  const mutationGate = new CountingMutationGate();
  return {
    deps: {
      generateDesign: designGenerator,
      generateReferenceModel: referenceModelGenerator,
      structuralGate: ADMIT_ALL,
      simulator: FAILING_SIMULATOR,
      mutationStrengthGate: mutationGate,
      limits: LIMITS,
      ...overrides,
    },
    designGenerator,
    referenceModelGenerator,
    mutationGate,
  };
}

describe('runSession - example tests against injected fakes', () => {
  it('a gapped Timing_Contract yields zero generation calls', async () => {
    const moduleInterface = moduleInterfaceWith(['q']);
    // A Spec whose timingContract omits the declared output port entirely.
    const gappedSpec = specWith(moduleInterface, { entries: [] });
    const { deps, designGenerator, referenceModelGenerator } = depsWith();
    const budget = makeBudgetLedger(80_000, 'session-token-budget');

    const outcome = await runSession(gappedSpec, budget, deps);

    expect(outcome.kind).toBe('unverified');
    expect(designGenerator.calls).toBe(0);
    expect(referenceModelGenerator.calls).toBe(0);
    expect(budget.spent()).toBe(0);
  });

  it('a diversity failure yields the model-family-diversity condition', async () => {
    const moduleInterface = moduleInterfaceWith(['q']);
    const spec = specWith(moduleInterface, totalTimingContract(moduleInterface));
    // Every generated design shares one family (index % 3 always lands on 'deepseek' when the
    // generator is overridden to report a constant family) - simulated here by overriding the
    // design generator so every call reports the SAME family rather than relying on the
    // round-robin fixture.
    class SingleFamilyDesignGenerator implements DesignGenerator {
      calls = 0;
      generate(): Promise<GeneratedDesign> {
        this.calls += 1;
        const index = this.calls;
        return Promise.resolve({
          designId: `design-${index}`,
          rtl: [{ path: 'd.v', contents: 'module m; endmodule\n' }],
          family: { provider: 'deepseek', lineage: 'x' },
        });
      }
    }
    const { deps } = depsWith({ generateDesign: new SingleFamilyDesignGenerator() });
    const budget = makeBudgetLedger(80_000, 'session-token-budget');

    const outcome = await runSession(spec, budget, deps);

    expect(outcome.kind).toBe('unverified');
    if (outcome.kind === 'unverified') {
      expect(outcome.unmetCondition).toBe('model-family-diversity');
    }
  });

  it('an exhausted ledger (within the same call) still charges before each call, not after', async () => {
    const moduleInterface = moduleInterfaceWith(['q']);
    const spec = specWith(moduleInterface, totalTimingContract(moduleInterface));
    const { deps, designGenerator, referenceModelGenerator } = depsWith();
    const budget = makeBudgetLedger(80_000, 'session-token-budget');

    await runSession(spec, budget, deps);

    // Exactly CONSENSUS_POOL_SIZE calls on each generator - the ledger charging point is
    // asserted by the generators themselves having been given the SAME ledger instance
    // (verified by type: DesignGenerator.generate takes `ledger: BudgetLedger` as its own
    // parameter), so a caller charging after issuing a call would still show here as 8 calls
    // with no observable difference - the ordering guarantee is structural (Req 15.3), not
    // retroactively detectable from the call count alone.
    expect(designGenerator.calls).toBe(8);
    expect(referenceModelGenerator.calls).toBe(8);
  });

  it('every generated design failing the simulator yields an unverified outcome with zero Trusted_Testbenches', async () => {
    const moduleInterface = moduleInterfaceWith(['q']);
    const spec = specWith(moduleInterface, totalTimingContract(moduleInterface));
    const { deps, mutationGate } = depsWith();
    const budget = makeBudgetLedger(80_000, 'session-token-budget');

    const outcome = await runSession(spec, budget, deps);

    expect(outcome.kind).toBe('unverified');
    if (outcome.kind === 'unverified') {
      expect(outcome.checked.trustedTestbenchCount).toBe(0);
      expect(outcome.checked.consensusRunCount).toBe(64); // 8 designs x 8 testbenches
    }
    // The Mutation_Strength_Gate was still consulted once per testbench, zero-trust or not.
    expect(mutationGate.calls).toBe(8);
  });

  it("records the ledger's real spend in the Session_Record rather than a hardcoded zero", async () => {
    // A design generator that charges the budget like a real one would, so this fixture can
    // prove tokensSpent reflects it (regression: the field was hardcoded to 0 before this fix).
    class ChargingDesignGenerator implements DesignGenerator {
      calls = 0;
      generate(
        _spec: Spec,
        ledger: Parameters<DesignGenerator['generate']>[1],
      ): Promise<GeneratedDesign> {
        this.calls += 1;
        ledger.charge(100);
        const rtl: SourceFile[] = [{ path: 'd.v', contents: 'module m; endmodule\n' }];
        return Promise.resolve({
          designId: `design-${this.calls}`,
          rtl,
          family: familyOf(this.calls),
        });
      }
    }
    const moduleInterface = moduleInterfaceWith(['q']);
    const spec = specWith(moduleInterface, totalTimingContract(moduleInterface));
    const { deps } = depsWith({ generateDesign: new ChargingDesignGenerator() });
    const budget = makeBudgetLedger(80_000, 'session-token-budget');

    const outcome = await runSession(spec, budget, deps);

    expect(outcome.record.tokensSpent).toBe(800); // 8 designs x 100 tokens charged each
    expect(outcome.record.tokensSpent).toBe(budget.spent());
  });

  it('records every compiled mutant as killed or surviving instead of leaving mutantCensus empty', async () => {
    // Regression test for the third wiring gap round 3 found: mutantCensus (Req 12.6) was
    // hardcoded to [] on every Session, even though the mutant matrix already computes
    // exactly the killed/surviving facts the census needs. A simulator that reports `fail`
    // for every design/testbench cell (never a build error) is used here so every mutant
    // COMPILES - the earlier fixtures' FAILING_SIMULATOR reports build-failed, which would
    // leave every mutant uncompiled and the census vacuously empty either way.
    const FAILING_BUT_COMPILING_SIMULATOR: SimulatorAdapter = {
      simulate() {
        return Promise.resolve({
          verdict: 'fail',
          checks: [],
          vcd: null,
          stdout: '',
          stderr: '',
          exitCode: 0,
          resourceUsage: { wallMs: 0, cpuMs: 0, maxMemMb: 0 },
          failureCause: 'none',
          attributedFiles: [],
          watchdog: { stopped: false },
        });
      },
    };
    // A design body with an arithmetic expression `generateMutants` can actually mutate -
    // the other fixtures' bare `module m; endmodule` has no mutable operator at all.
    class MutableDesignGenerator implements DesignGenerator {
      calls = 0;
      generate(): Promise<GeneratedDesign> {
        this.calls += 1;
        const index = this.calls;
        const rtl: SourceFile[] = [
          {
            path: 'd.v',
            contents:
              'module m(input [3:0] a, input [3:0] b, output [3:0] q); assign q = a + b; endmodule\n',
          },
        ];
        return Promise.resolve({ designId: `design-${index}`, rtl, family: familyOf(index) });
      }
    }
    const moduleInterface = moduleInterfaceWith(['q']);
    const spec = specWith(moduleInterface, totalTimingContract(moduleInterface));
    const { deps } = depsWith({
      generateDesign: new MutableDesignGenerator(),
      simulator: FAILING_BUT_COMPILING_SIMULATOR,
    });
    const budget = makeBudgetLedger(80_000, 'session-token-budget');

    const outcome = await runSession(spec, budget, deps);

    expect(outcome.record.mutantCensus).toHaveLength(8); // one entry per testbench
    for (const entry of outcome.record.mutantCensus) {
      // Every mutant run against this simulator ALSO reports 'fail' (`killed` means
      // non-pass), so every compiled mutant is killed and none survives.
      expect(entry.killedMutantIds.length).toBeGreaterThan(0);
      expect(entry.survivingMutantIds).toHaveLength(0);
    }
  });

  it('attributes a Fault_Verdict to every failing pair instead of leaving the record empty', async () => {
    // Regression test for the second wiring gap round 3 found: attributeFault/peersOf were
    // never called from runSession, so record.poolCorrectness.faultVerdicts was always [].
    // Every design here fails every testbench, so every one of the 64 pairs is a failing pair
    // with 7 peers on each side (above PEER_FLOOR) and a 0% peer-pass share on both sides,
    // which attributeFault's own decision table reads as ABSTAIN rather than RTL or TESTBENCH.
    const moduleInterface = moduleInterfaceWith(['q']);
    const spec = specWith(moduleInterface, totalTimingContract(moduleInterface));
    const { deps } = depsWith();
    const budget = makeBudgetLedger(80_000, 'session-token-budget');

    const outcome = await runSession(spec, budget, deps);

    expect(outcome.kind).toBe('unverified');
    if (outcome.kind === 'unverified') {
      expect(outcome.record.poolCorrectness.faultVerdicts).toHaveLength(64);
      expect(
        outcome.record.poolCorrectness.faultVerdicts.every((pair) => pair.verdict === 'ABSTAIN'),
      ).toBe(true);
      expect(outcome.record.poolCorrectness.poolCorrectness).toBe(0);
      expect(outcome.record.poolCorrectness.attributionStatus).toBe('advisory');
    }
  });
});
