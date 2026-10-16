// testbench-repair-loop, task 8.9: one end-to-end VerificationLoop run over a fake
// simulator, asserting a Testbench_Precheck build failure followed by a successful
// repair-and-recheck reaches the first iteration with the REPAIRED testbench, and never
// consults InstrumentAdmission at all.
//
// Drives the real VerificationLoop, the real TestbenchPrecheck, and the real
// #admitInstrument/#repairPrecheckFailure pair - the one repair trigger point left after
// testbench-dialect-normalization's retirement of the positive-control-path trigger
// (TESTBENCH_REPAIR_POLICY_VERSION 1 -> 2). A counting InstrumentAdmission fake proves the
// Req 8.3 claim directly: once the precheck decides a repair, the InstrumentAdmission
// consultation #admitInstrument falls through to for an undecided precheck is never
// reached at all for this sample.
//
// Validates: Requirement 8.3

import { describe, expect, it } from 'vitest';

import {
  newUlid,
  ok,
  oracleTrustLabeler,
  unverified,
  type ArtifactRef,
  type Result,
  type SessionBudget,
  type Spec,
  type Testbench,
} from '@app/core';
import {
  ConfirmedGenerationContext,
  InMemorySessionBudgetHandle,
  InMemoryTracePersistence,
  TraceActionRecorder,
  VerificationLoop,
  type CandidateEval,
  type CandidateFailure,
  type CandidateGenerator,
  type GeneratedCandidate,
  type GenerateTestbenchRequest,
  type GenerationAdmissionRequest,
  type GenerationContextOpener,
  type GenerationGateRefusal,
  type GenerationInput,
  type IndependentTestbenchGenerator,
  type InstrumentAdmission,
  type InstrumentAdmissionDecision,
  type RepairTestbenchRequest,
  type SessionBudgetHandle,
  type TestbenchGenerationOutcome,
} from '@app/agent';
import {
  FakeSandboxRuntime,
  IcarusSimulatorAdapter,
  SandboxToolRunner,
  type RawRunCapture,
  type SandboxJob,
} from '@app/tools';
import { timingContractFor } from '@app/test';

const LIMITS = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5_000 } as const;
const REQUEST = {} as unknown as GenerationAdmissionRequest;
const PRECHECK_STUB_PATH = 'testbench_precheck_stub.v';

function isPrecheckJob(job: SandboxJob): boolean {
  return job.workspaceFiles.some((file) => file.path === PRECHECK_STUB_PATH);
}

function approvedSpec(): Spec {
  return {
    timingContract: timingContractFor({
      validityOutputName: null,
      moduleName: 'byte_reg',
      ports: [
        { name: 'd', direction: 'input', width: 8 },
        { name: 'q', direction: 'output', width: 8 },
      ],
      clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
    }),
    id: newUlid(),
    projectId: newUlid(),
    goal: 'A byte register that captures d on the clock edge.',
    constraints: [],
    moduleInterface: {
      validityOutputName: null,
      moduleName: 'byte_reg',
      ports: [
        { name: 'd', direction: 'input', width: 8 },
        { name: 'q', direction: 'output', width: 8 },
      ],
      clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
    },
    acceptanceCriteria: [
      { id: newUlid(), text: 'q captures d', measurable: true, method: 'simulation' },
    ],
    architecture: 'Single always block latching d into q.',
    approved: true,
    version: 1,
  };
}

function candidateFor(spec: Spec): GeneratedCandidate {
  const id = newUlid();
  const rtl = 'module byte_reg; endmodule';
  const artifactRef: ArtifactRef = { kind: 'module-version', id, version: 1 };
  return {
    rtl,
    parsedInterface: { moduleName: 'byte_reg', ports: [] },
    interfaceMatch: {
      matches: true,
      moduleNameMatches: true,
      expectedModuleName: 'byte_reg',
      actualModuleName: 'byte_reg',
      missingPorts: [],
      extraPorts: [],
      mismatchedPorts: [],
    },
    moduleVersion: {
      id,
      projectId: spec.projectId,
      specVersion: spec.version,
      rtl,
      createdAt: new Date(0).toISOString(),
    },
    label: unverified(artifactRef),
  };
}

function testbenchFor(spec: Spec, source: string): Testbench {
  return {
    id: newUlid(),
    specId: spec.id,
    specVersion: spec.version,
    source,
    sourceAttribution: 'spec',
    coversCriteria: spec.acceptanceCriteria.map((c) => c.id),
  };
}

function confirmedContext(spec: Spec): ConfirmedGenerationContext {
  return {
    sessionId: newUlid(),
    projectId: spec.projectId,
    confirmedIntent: { summary: 'A byte register.', constraints: [], assumptions: [] },
    approvedSpec: spec,
  } as unknown as ConfirmedGenerationContext;
}

class AdmittingGate implements GenerationContextOpener {
  readonly #context: ConfirmedGenerationContext;
  constructor(context: ConfirmedGenerationContext) {
    this.#context = context;
  }
  openGenerationContext(): Promise<Result<ConfirmedGenerationContext, GenerationGateRefusal>> {
    return Promise.resolve(ok(this.#context));
  }
}

class OneShotGenerator implements CandidateGenerator {
  readonly #candidate: GeneratedCandidate;
  constructor(candidate: GeneratedCandidate) {
    this.#candidate = candidate;
  }
  generateCandidate(
    _input: GenerationInput,
    budget: SessionBudgetHandle,
  ): Promise<Result<CandidateEval, CandidateFailure>> {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve(ok({ candidate: this.#candidate, interfaceDiagnostics: '' }));
  }
  reviseFromErrors(
    _input: GenerationInput,
    _previousRtl: string,
    _diagnostics: string,
    budget: SessionBudgetHandle,
  ): Promise<Result<CandidateEval, CandidateFailure>> {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve({
      ok: false,
      error: { reason: 'model-unavailable', detail: 'this fixture scripts no revision' },
    });
  }
}

class RepairingTestbench implements IndependentTestbenchGenerator {
  readonly #draft: Testbench;
  readonly #repaired: Testbench;
  repairCalls = 0;
  constructor(draft: Testbench, repaired: Testbench) {
    this.#draft = draft;
    this.#repaired = repaired;
  }
  generateTestbench(
    _request: GenerateTestbenchRequest,
    budget: SessionBudgetHandle,
  ): Promise<TestbenchGenerationOutcome> {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve({
      status: 'generated',
      checkingApproach: 'cycle-timed',
      testbench: this.#draft,
      checks: [],
    });
  }
  repairTestbench(
    _request: RepairTestbenchRequest,
    budget: SessionBudgetHandle,
  ): Promise<TestbenchGenerationOutcome> {
    this.repairCalls += 1;
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve({
      status: 'generated',
      checkingApproach: 'cycle-timed',
      testbench: this.#repaired,
      checks: [],
    });
  }
}

class CountingInstrumentAdmission implements InstrumentAdmission {
  calls = 0;
  admit(): Promise<InstrumentAdmissionDecision> {
    this.calls += 1;
    return Promise.resolve('admissible');
  }
}

function passCapture(): RawRunCapture {
  return {
    timedOut: false,
    infraFailure: false,
    exitCode: 0,
    stdout: 'CHECK q_captures_d PASS\n',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts: { vcd: { name: 'dump.vcd', sizeBytes: 8, sha256: 'a'.repeat(64) } },
    deniedOperations: [],
    resourceUsage: { wallMs: 12, maxMemMb: 8, cpuMs: 10 },
  };
}

function draftBuildFailureCapture(): RawRunCapture {
  return {
    ...passCapture(),
    exitCode: 1,
    stdout: '',
    stderr: 'byte_reg_tb.v:1: syntax error\n',
    artifacts: {},
  };
}

function generousBudget(): InMemorySessionBudgetHandle {
  const budget: SessionBudget = {
    sessionId: newUlid(),
    maxIterations: 20,
    maxTokens: 1_000_000,
    maxWallClockMs: 1_000_000,
    maxCostCents: 1_000_000,
    consumedIterations: 0,
    consumedTokens: 0,
    consumedMs: 0,
    consumedCostCents: 0,
  };
  return new InMemorySessionBudgetHandle(budget);
}

describe('VerificationLoop end-to-end: a precheck build failure, repaired, reaches #iterate with the repaired testbench (Req 8.3)', () => {
  it('never consults InstrumentAdmission once the precheck has already decided a repair', async () => {
    const spec = approvedSpec();
    const draft = testbenchFor(spec, 'module byte_reg_tb; DRAFT_SYNTAX_ERROR');
    const repaired = testbenchFor(
      spec,
      'module byte_reg_tb; initial $display("CHECK q_captures_d PASS");',
    );
    const testbench = new RepairingTestbench(draft, repaired);
    const instrumentAdmission = new CountingInstrumentAdmission();

    const runtime = new FakeSandboxRuntime((job) => {
      if (!isPrecheckJob(job)) {
        return passCapture();
      }
      const isDraft = job.workspaceFiles.some((file) =>
        file.contents.includes('DRAFT_SYNTAX_ERROR'),
      );
      return isDraft ? draftBuildFailureCapture() : passCapture();
    });
    const simulator = new IcarusSimulatorAdapter(new SandboxToolRunner(runtime));
    const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
    const loop = new VerificationLoop({
      gate: new AdmittingGate(confirmedContext(spec)),
      generator: new OneShotGenerator(candidateFor(spec)),
      testbench,
      simulator,
      recorder,
      trustLabeler: oracleTrustLabeler,
      instrumentAdmission,
    });

    const outcome = await loop.verify(REQUEST, generousBudget(), LIMITS);

    expect(testbench.repairCalls).toBe(1);
    expect(outcome.status).toBe('verified');
    if (outcome.status !== 'verified') return;

    expect(outcome.repairProvenance.attempted).toBe(true);
    expect(outcome.repairProvenance.accepted).toBe(true);
    if (!outcome.repairProvenance.accepted) return;
    expect(outcome.repairProvenance.replacedSource).toBe(draft.source);

    expect(instrumentAdmission.calls).toBe(0);
  });
});
