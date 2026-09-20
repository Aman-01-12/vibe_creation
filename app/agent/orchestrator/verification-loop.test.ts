// Unit tests for the Verification_Loop (S7, task 14.1).
//
// Driven through a FAKE gate opener, FAKE generation/testbench ports, a real
// Simulator adapter backed by the FakeSandboxRuntime, the real oracle Trust_Labeler,
// and an in-memory Action_Recorder, these examples exercise the behaviors Req
// 8.1-8.6 and 8.9 demand: a fail -> repair -> pass trajectory that ends `Verified`
// bound to the passing oracle span; a budget-exhaustion trajectory that ends
// `Unverified` with a Teach_Mode handoff; a pass discovered on the last affordable
// run still labeled `Verified` (Req 8.9); a gate refusal that blocks; and a missing
// independent testbench that fails setup safely. The numbered property/integration
// coverage is task 14.2, not here.

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
  FakeSandboxRuntime,
  IcarusSimulatorAdapter,
  SandboxToolRunner,
  type RawRunCapture,
  type ResourceLimits,
  type SandboxJob,
} from '@app/tools';

import { InMemoryTracePersistence, TraceActionRecorder } from '../action-recorder/index.js';
import { InMemorySessionBudgetHandle, type SessionBudgetHandle } from '../model-router/index.js';
import type {
  CandidateEval,
  CandidateFailure,
  GeneratedCandidate,
  GenerationInput,
} from '../roles/generation/index.js';
import type {
  GenerateTestbenchRequest,
  RepairTestbenchRequest,
  RequiredCheck,
  TestbenchGenerationOutcome,
} from '../roles/testbench/index.js';

import {
  ConfirmedGenerationContext,
  type GenerationAdmissionRequest,
  type GenerationGateRefusal,
} from './generation-gate.js';
import {
  VerificationLoop,
  type CandidateGenerator,
  type GenerationContextOpener,
  type IndependentTestbenchGenerator,
} from './verification-loop.js';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5000 };

/** An approved single-module Spec with one simulation-verifiable acceptance criterion. */
function approvedSpec(): Spec {
  return {
    id: newUlid(),
    projectId: newUlid(),
    goal: 'A byte register that captures d on the clock edge.',
    constraints: [],
    moduleInterface: {
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

/** A minimal generated candidate whose label carries a fresh module-version ref. */
function candidate(spec: Spec, rtl = 'module byte_reg; endmodule'): GeneratedCandidate {
  const id = newUlid();
  const moduleVersion = {
    id,
    projectId: spec.projectId,
    specVersion: spec.version,
    rtl,
    createdAt: new Date(0).toISOString(),
  };
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
    moduleVersion,
    label: unverified(artifactRef),
  };
}

/** A produced Testbench derived from the Spec, attributed to the Spec version. */
function testbenchFor(spec: Spec): Testbench {
  return {
    id: newUlid(),
    specId: spec.id,
    specVersion: spec.version,
    source: 'module byte_reg_tb; endmodule',
    sourceAttribution: 'spec',
    coversCriteria: spec.acceptanceCriteria.map((c) => c.id),
  };
}

/** A confirmed generation context standing in for a successful gate admission. */
function confirmedContext(spec: Spec): ConfirmedGenerationContext {
  return {
    sessionId: newUlid(),
    projectId: spec.projectId,
    confirmedIntent: { summary: 'A byte register.', constraints: [], assumptions: [] },
    approvedSpec: spec,
  } as unknown as ConfirmedGenerationContext;
}

/** A gate opener that always admits with the given context. */
class AdmittingGate implements GenerationContextOpener {
  readonly #context: ConfirmedGenerationContext;
  constructor(context: ConfirmedGenerationContext) {
    this.#context = context;
  }
  openGenerationContext(): Promise<Result<ConfirmedGenerationContext, GenerationGateRefusal>> {
    return Promise.resolve(ok(this.#context));
  }
}

/** A gate opener that always refuses admission with the given refusal. */
class RefusingGate implements GenerationContextOpener {
  readonly #refusal: GenerationGateRefusal;
  constructor(refusal: GenerationGateRefusal) {
    this.#refusal = refusal;
  }
  openGenerationContext(): Promise<Result<ConfirmedGenerationContext, GenerationGateRefusal>> {
    return Promise.resolve({ ok: false, error: this.#refusal });
  }
}

/** A generation port that yields a first candidate then scripted revisions, charging budget. */
class ScriptedGenerator implements CandidateGenerator {
  readonly reviseCalls: { previousRtl: string; diagnostics: string }[] = [];
  readonly #first: Result<CandidateEval, CandidateFailure>;
  readonly #revisions: readonly Result<CandidateEval, CandidateFailure>[];
  #index = 0;

  constructor(
    first: Result<CandidateEval, CandidateFailure>,
    revisions: readonly Result<CandidateEval, CandidateFailure>[] = [],
  ) {
    this.#first = first;
    this.#revisions = revisions;
  }

  generateCandidate(
    _input: GenerationInput,
    budget: SessionBudgetHandle,
  ): Promise<Result<CandidateEval, CandidateFailure>> {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve(this.#first);
  }

  reviseFromErrors(
    _input: GenerationInput,
    previousRtl: string,
    diagnostics: string,
    budget: SessionBudgetHandle,
  ): Promise<Result<CandidateEval, CandidateFailure>> {
    this.reviseCalls.push({ previousRtl, diagnostics });
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    const revision = this.#revisions[Math.min(this.#index, this.#revisions.length - 1)];
    this.#index += 1;
    return Promise.resolve(
      revision ?? {
        ok: false,
        error: { reason: 'model-unavailable', detail: 'no more revisions' },
      },
    );
  }
}

/** A testbench port that returns a scripted outcome. Never repairs (task 6.4). */
class ScriptedTestbench implements IndependentTestbenchGenerator {
  readonly #outcome: TestbenchGenerationOutcome;
  constructor(outcome: TestbenchGenerationOutcome) {
    this.#outcome = outcome;
  }
  generateTestbench(
    _request: GenerateTestbenchRequest,
    budget: SessionBudgetHandle,
  ): Promise<TestbenchGenerationOutcome> {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve(this.#outcome);
  }
  repairTestbench(
    _request: RepairTestbenchRequest,
    budget: SessionBudgetHandle,
  ): Promise<TestbenchGenerationOutcome> {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve({
      status: 'generation-failed',
      failure: { reason: 'model-call-failed', detail: 'ScriptedTestbench never repairs' },
    });
  }
}

/**
 * The Testbench_Precheck's interface-stub filename (`testbench-precheck.ts`,
 * `INTERFACE_STUB_MODULE`). The loop now runs an unconditional precheck simulate
 * call before the first iteration, submitting this stub as "RTL"; fakes that
 * script the Simulator by call order must recognize and skip over that call so
 * the scripted SEQUENCE still lines up with real iterations only.
 */
const PRECHECK_STUB_PATH = 'testbench_precheck_stub.v';

/** Whether a sandbox job is the precheck's own build check, not a real iteration. */
function isPrecheckJob(job: SandboxJob): boolean {
  return job.workspaceFiles.some((file) => file.path === PRECHECK_STUB_PATH);
}

/** A raw capture whose testbench emitted a passing check and a VCD. */
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

/** A raw capture whose testbench emitted a failing check but still produced a VCD. */
function failCapture(): RawRunCapture {
  return {
    timedOut: false,
    infraFailure: false,
    exitCode: 0,
    stdout: 'CHECK q_captures_d FAIL\n',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts: { vcd: { name: 'dump.vcd', sizeBytes: 8, sha256: 'b'.repeat(64) } },
    deniedOperations: [],
    resourceUsage: { wallMs: 9, maxMemMb: 8, cpuMs: 7 },
  };
}

/** Open an in-memory budget handle with the given iteration cap and generous other caps. */
function budgetWithIterations(maxIterations: number): InMemorySessionBudgetHandle {
  const budget: SessionBudget = {
    sessionId: newUlid(),
    maxIterations,
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

/** Assemble a loop over the given fakes, a real sandbox-backed Simulator, and recorder. */
function makeLoop(
  gate: GenerationContextOpener,
  generator: CandidateGenerator,
  testbench: IndependentTestbenchGenerator,
  captures: (job: SandboxJob) => RawRunCapture,
): { loop: VerificationLoop; recorder: TraceActionRecorder } {
  const runtime = new FakeSandboxRuntime((job) => captures(job));
  const simulator = new IcarusSimulatorAdapter(new SandboxToolRunner(runtime));
  const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
  const loop = new VerificationLoop({
    gate,
    generator,
    testbench,
    simulator,
    recorder,
    trustLabeler: oracleTrustLabeler,
  });
  return { loop, recorder };
}

/** Wrap a candidate as a produced CandidateEval with a clean interface. */
function evalOf(cand: GeneratedCandidate): Result<CandidateEval, CandidateFailure> {
  return ok({ candidate: cand, interfaceDiagnostics: '' });
}

const REQUEST = {} as unknown as GenerationAdmissionRequest;

describe('VerificationLoop.verify - fail then repair then pass (Req 8.1-8.4)', () => {
  it('iterates generate-simulate-fix and ends Verified bound to the passing oracle span', async () => {
    const spec = approvedSpec();
    const first = candidate(spec, 'module byte_reg; // v1');
    const fixed = candidate(spec, 'module byte_reg; // v2');
    const generator = new ScriptedGenerator(evalOf(first), [evalOf(fixed)]);
    const testbench = new ScriptedTestbench({
      status: 'generated',
      testbench: testbenchFor(spec),
      checks: [],
    });
    let iterationRuns = 0;
    const { loop } = makeLoop(
      new AdmittingGate(confirmedContext(spec)),
      generator,
      testbench,
      (job) => {
        if (isPrecheckJob(job)) {
          return passCapture();
        }
        return iterationRuns++ === 0 ? failCapture() : passCapture();
      },
    );

    const outcome = await loop.verify(REQUEST, budgetWithIterations(20), LIMITS);

    expect(outcome.status).toBe('verified');
    if (outcome.status !== 'verified') return;
    expect(outcome.label.tier).toBe('Verified');
    expect(outcome.label.oracleSpanRef).toBe(outcome.oracleSpanId);
    expect(outcome.result.verdict).toBe('pass');
    expect(outcome.iterations).toBe(2);
    expect(generator.reviseCalls).toHaveLength(1);
    expect(generator.reviseCalls[0]?.diagnostics).toContain('q_captures_d');
  });
});

describe('VerificationLoop.verify - budget exhaustion (Req 8.5)', () => {
  it('presents the last failing case labeled Unverified with a Teach_Mode handoff', async () => {
    const spec = approvedSpec();
    const first = candidate(spec);
    const generator = new ScriptedGenerator(evalOf(first), [evalOf(candidate(spec))]);
    const testbench = new ScriptedTestbench({
      status: 'generated',
      testbench: testbenchFor(spec),
      checks: [],
    });
    const { loop } = makeLoop(
      new AdmittingGate(confirmedContext(spec)),
      generator,
      testbench,
      failCapture,
    );

    // maxIterations 2: setup generation + testbench consume it, so no repair is affordable.
    const outcome = await loop.verify(REQUEST, budgetWithIterations(2), LIMITS);

    expect(outcome.status).toBe('unverified');
    if (outcome.status !== 'unverified') return;
    expect(outcome.label.tier).toBe('Unverified');
    expect(outcome.failingCase?.checkName).toBe('q_captures_d');
    expect(outcome.teachMode.failingCase?.checkName).toBe('q_captures_d');
    expect(outcome.teachMode.diagnostics).toContain('q_captures_d');
    expect(outcome.result.verdict).toBe('fail');
  });
});

describe('VerificationLoop.verify - pass at the end of budget still Verified (Req 8.9)', () => {
  it('labels Verified from the recorded verdict regardless of exhausted budget', async () => {
    const spec = approvedSpec();
    const generator = new ScriptedGenerator(evalOf(candidate(spec)));
    const testbench = new ScriptedTestbench({
      status: 'generated',
      testbench: testbenchFor(spec),
      checks: [],
    });
    const { loop } = makeLoop(
      new AdmittingGate(confirmedContext(spec)),
      generator,
      testbench,
      passCapture,
    );

    // Tight cap: generation + testbench exhaust the budget before the first simulate,
    // yet the candidate is still simulated and its pass still yields Verified.
    const outcome = await loop.verify(REQUEST, budgetWithIterations(2), LIMITS);

    expect(outcome.status).toBe('verified');
    if (outcome.status !== 'verified') return;
    expect(outcome.label.tier).toBe('Verified');
    expect(outcome.iterations).toBe(1);
  });
});

describe('VerificationLoop.verify - an oracle pass on INCOMPLETE evidence fails closed', () => {
  /** The two checks the Spec requires of the Testbench for these cases. */
  const REQUIRED: readonly RequiredCheck[] = [
    { name: 'q_captures_d', kind: 'criterion', description: 'q captures d' },
    { name: 'reset_clears_q', kind: 'criterion', description: 'reset clears q' },
  ];

  /** A capture whose stdout is exactly the given signalling, with a VCD. */
  function captureWithStdout(stdout: string): RawRunCapture {
    return { ...passCapture(), stdout };
  }

  /** Run the loop with the two required checks and the given simulation stdout. */
  function runWith(stdout: string): ReturnType<VerificationLoop['verify']> {
    const spec = approvedSpec();
    const generator = new ScriptedGenerator(evalOf(candidate(spec)));
    const testbench = new ScriptedTestbench({
      status: 'generated',
      testbench: testbenchFor(spec),
      checks: REQUIRED,
    });
    const { loop } = makeLoop(new AdmittingGate(confirmedContext(spec)), generator, testbench, () =>
      captureWithStdout(stdout),
    );
    return loop.verify(REQUEST, budgetWithIterations(20), LIMITS);
  }

  it('given a required check that printed NO line when the rest pass then it is not Verified', async () => {
    // The oracle can only judge what the run printed, so on its own this reads as a
    // clean pass. The loop holds the required set and refuses the incomplete evidence.
    const outcome = await runWith('CHECK q_captures_d PASS\n');

    expect(outcome.status).toBe('unverified');
    if (outcome.status !== 'unverified') return;
    expect(outcome.label.tier).toBe('Unverified');
    expect(outcome.result.verdict).toBe('error');
    expect(outcome.failingCase?.checkName).toBe('reset_clears_q');
    expect(outcome.teachMode.diagnostics).toContain('reset_clears_q');
    // The oracle itself is not rewritten: it still reported what it saw.
    expect(outcome.simulation.verdict).toBe('pass');
  });

  it('given an UNKNOWN check name passing in place of a required one then it is not Verified', async () => {
    // A name outside the required set cannot stand in for a required check, so it
    // cannot manufacture a pass no matter how many of them are printed.
    const outcome = await runWith(
      'CHECK q_captures_d PASS\nCHECK not_a_required_check PASS\nCHECK also_invented PASS\n',
    );

    expect(outcome.status).toBe('unverified');
    if (outcome.status !== 'unverified') return;
    expect(outcome.failingCase?.checkName).toBe('reset_clears_q');
  });

  it('given every required check reported and passing then it IS Verified', async () => {
    // Non-vacuity: the guard above must not be a blanket refusal.
    const outcome = await runWith('CHECK q_captures_d PASS\nCHECK reset_clears_q PASS\n');

    expect(outcome.status).toBe('verified');
    if (outcome.status !== 'verified') return;
    expect(outcome.label.tier).toBe('Verified');
  });

  it('given every required check reported plus an unknown PASS then it IS still Verified', async () => {
    // An extra name neither creates nor destroys a pass; the required set decides.
    const outcome = await runWith(
      'CHECK q_captures_d PASS\nCHECK reset_clears_q PASS\nCHECK extra_diagnostic PASS\n',
    );

    expect(outcome.status).toBe('verified');
  });

  it('given an unknown check name FAILING then the run is a functional fail, not a pass', async () => {
    const spec = approvedSpec();
    const generator = new ScriptedGenerator(evalOf(candidate(spec)));
    const tb = new ScriptedTestbench({
      status: 'generated',
      testbench: testbenchFor(spec),
      checks: REQUIRED,
    });
    const { loop } = makeLoop(new AdmittingGate(confirmedContext(spec)), generator, tb, () =>
      captureWithStdout(
        'CHECK q_captures_d PASS\nCHECK reset_clears_q PASS\nCHECK invented FAIL\n',
      ),
    );

    // maxIterations 2 so the loop stops at the first verdict rather than repairing.
    const outcome = await loop.verify(REQUEST, budgetWithIterations(2), LIMITS);

    expect(outcome.status).toBe('unverified');
    if (outcome.status !== 'unverified') return;
    expect(outcome.simulation.verdict).toBe('fail');
  });
});

describe('VerificationLoop.verify - gate and setup guards (fail safe)', () => {
  it('returns blocked when the generation gate refuses admission', async () => {
    const spec = approvedSpec();
    const refusal: GenerationGateRefusal = { reason: 'spec-unapproved', message: 'blocked' };
    const generator = new ScriptedGenerator(evalOf(candidate(spec)));
    const testbench = new ScriptedTestbench({
      status: 'generated',
      testbench: testbenchFor(spec),
      checks: [],
    });
    const { loop } = makeLoop(new RefusingGate(refusal), generator, testbench, passCapture);

    const outcome = await loop.verify(REQUEST, budgetWithIterations(20), LIMITS);

    expect(outcome.status).toBe('blocked');
    if (outcome.status !== 'blocked') return;
    expect(outcome.refusal.reason).toBe('spec-unapproved');
  });

  it('fails setup safely when the independent testbench could not be produced', async () => {
    const spec = approvedSpec();
    const generator = new ScriptedGenerator(evalOf(candidate(spec)));
    const testbench = new ScriptedTestbench({
      status: 'generation-failed',
      failure: { reason: 'no-simulation-criteria', detail: 'no simulation criteria' },
    });
    const { loop } = makeLoop(
      new AdmittingGate(confirmedContext(spec)),
      generator,
      testbench,
      passCapture,
    );

    const outcome = await loop.verify(REQUEST, budgetWithIterations(20), LIMITS);

    expect(outcome.status).toBe('setup-failed');
    if (outcome.status !== 'setup-failed') return;
    expect(outcome.reason).toBe('testbench-unavailable');
  });
});

describe('VerificationLoop.run - streaming (Req 6.7, 17.6)', () => {
  it('streams setup, simulating, and verified progress before the terminal outcome', async () => {
    const spec = approvedSpec();
    const generator = new ScriptedGenerator(evalOf(candidate(spec)));
    const testbench = new ScriptedTestbench({
      status: 'generated',
      testbench: testbenchFor(spec),
      checks: [],
    });
    const { loop } = makeLoop(
      new AdmittingGate(confirmedContext(spec)),
      generator,
      testbench,
      passCapture,
    );

    const iterator = loop.run(REQUEST, budgetWithIterations(20), LIMITS);
    const phases: string[] = [];
    let step = await iterator.next();
    while (!step.done) {
      phases.push(step.value.phase);
      step = await iterator.next();
    }

    expect(phases).toContain('setup');
    expect(phases).toContain('simulating');
    expect(phases).toContain('verified');
    expect(step.value.status).toBe('verified');
  });
});
