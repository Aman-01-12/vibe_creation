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
  makeTimingContract,
  newUlid,
  ok,
  oracleTrustLabeler,
  unverified,
  type ArtifactRef,
  type BudgetStopReason,
  type ModuleInterface,
  type Result,
  type SessionBudget,
  type Spec,
  type Testbench,
  type TimingContract,
} from '@app/core';
import {
  admitProved,
  FakeSandboxRuntime,
  IcarusSimulatorAdapter,
  SandboxToolRunner,
  SIMULATION_HARNESS,
  validateExpression,
  type ArtifactBlobRef,
  type ClockPolarity,
  type CouldNotVerifyCause,
  type CounterexampleCapture,
  type FormalOraclePort,
  type FormalOutcome,
  type FormalProperty,
  type FormalProveRequest,
  type FormalProveSetRequest,
  type PropertyResult,
  type RawRunCapture,
  type ResetContract,
  type ResourceLimits,
  type SandboxJob,
} from '@app/tools';

import { InMemoryTracePersistence, TraceActionRecorder } from '../action-recorder/index.js';
import {
  InMemorySessionBudgetHandle,
  type AttemptCost,
  type SessionBudgetHandle,
} from '../model-router/index.js';
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
import { FORMAL_ORACLE_VERSION } from './formal-oracle-version.js';
import {
  NO_FORMAL_RUN,
  VerificationLoop,
  type CandidateGenerator,
  type FormalGate,
  type FormalPropertySet,
  type FormalProvenance,
  type GenerationContextOpener,
  type IndependentTestbenchGenerator,
  type PropertySetSource,
  type RecordedCounterexampleCapture,
} from './verification-loop.js';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5000 };

/** A placeholder Timing_Contract placing every output port at `registered`; nothing here reads it. */
function timingContractFor(moduleInterface: ModuleInterface): TimingContract {
  const entries = moduleInterface.ports
    .filter((port) => port.direction === 'output')
    .map((port) => ({ portName: port.name, timing: 'registered' as const }));
  const built = makeTimingContract(moduleInterface, entries);
  if (!built.ok) {
    throw new Error(`fixture built an invalid timing contract: ${built.error.message}`);
  }
  return built.value;
}

/** An approved single-module Spec with one simulation-verifiable acceptance criterion. */
function approvedSpec(): Spec {
  const moduleInterface: ModuleInterface = {
    validityOutputName: null,
    moduleName: 'byte_reg',
    ports: [
      { name: 'd', direction: 'input', width: 8 },
      { name: 'q', direction: 'output', width: 8 },
    ],
    clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
  };
  return {
    id: newUlid(),
    projectId: newUlid(),
    goal: 'A byte register that captures d on the clock edge.',
    constraints: [],
    moduleInterface,
    timingContract: timingContractFor(moduleInterface),
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
  formal?: FormalGate,
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
    ...(formal === undefined ? {} : { formal }),
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
      checkingApproach: 'cycle-timed',
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

/** A testbench port whose first draft fails the precheck build and whose ONE repair succeeds. */
class RepairingTestbench implements IndependentTestbenchGenerator {
  readonly #draft: Testbench;
  readonly #repaired: Testbench;
  constructor(draft: Testbench, repaired: Testbench) {
    this.#draft = draft;
    this.#repaired = repaired;
  }
  generateTestbench(
    _request: GenerateTestbenchRequest,
    budget: SessionBudgetHandle,
  ): Promise<TestbenchGenerationOutcome> {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve(this.#generated(this.#draft));
  }
  repairTestbench(
    _request: RepairTestbenchRequest,
    budget: SessionBudgetHandle,
  ): Promise<TestbenchGenerationOutcome> {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve(this.#generated(this.#repaired));
  }
  #generated(testbench: Testbench): TestbenchGenerationOutcome {
    return { status: 'generated', checkingApproach: 'cycle-timed', testbench, checks: [] };
  }
}

/** A precheck build diagnostic naming only the testbench file, which triggers a repair. */
function testbenchBuildFailureCapture(): RawRunCapture {
  return {
    ...passCapture(),
    exitCode: 1,
    stdout: '',
    stderr: 'byte_reg_tb.v:12: syntax error\n',
    artifacts: {},
  };
}

describe('VerificationLoop.verify - valueless failure reports after an accepted repair (Req 5.3, 5.4)', () => {
  /** A testbench holding `count` FAIL `$display` calls that print no value. */
  function withValuelessReports(spec: Spec, count: number): Testbench {
    const reports = Array.from({ length: count }, () => '  initial $display("CHECK q FAIL");\n');
    return { ...testbenchFor(spec), source: `module byte_reg_tb;\n${reports.join('')}endmodule\n` };
  }

  it('records the count of the REPAIRED source, not the first draft', async () => {
    // Given a draft with one valueless report that fails the build, repaired into one with two.
    const spec = approvedSpec();
    const draft = withValuelessReports(spec, 1);
    const repaired = withValuelessReports(spec, 2);
    const { loop } = makeLoop(
      new AdmittingGate(confirmedContext(spec)),
      new ScriptedGenerator(evalOf(candidate(spec))),
      new RepairingTestbench(draft, repaired),
      (job) => {
        const isDraft = job.workspaceFiles.some((file) => file.contents === draft.source);
        return isPrecheckJob(job) && isDraft ? testbenchBuildFailureCapture() : passCapture();
      },
    );

    // When the loop runs to a terminal outcome.
    const outcome = await loop.verify(REQUEST, budgetWithIterations(20), LIMITS);

    // Then the accepted repair's provenance carries the repaired source's count.
    expect(outcome.status).toBe('verified');
    if (outcome.status !== 'verified') return;
    expect(outcome.repairProvenance.accepted).toBe(true);
    expect(outcome.normalization.valuelessFailureReports).toBe(2);
  });
});

describe('VerificationLoop.verify - budget exhaustion (Req 8.5)', () => {
  it('presents the last failing case labeled Unverified with a Teach_Mode handoff', async () => {
    const spec = approvedSpec();
    const first = candidate(spec);
    const generator = new ScriptedGenerator(evalOf(first), [evalOf(candidate(spec))]);
    const testbench = new ScriptedTestbench({
      status: 'generated',
      checkingApproach: 'cycle-timed',
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
      checkingApproach: 'cycle-timed',
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
      checkingApproach: 'cycle-timed',
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
      checkingApproach: 'cycle-timed',
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
      checkingApproach: 'cycle-timed',
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

  it('fails setup with no repair when a scoreboard reply was refused at the fragment boundary', async () => {
    // testbench-in-order-scoreboard, Q-16 B: the scoreboard twin of an unparseable reply, so
    // it is treated identically - model output the contract refused, and no second chance.
    const spec = approvedSpec();
    const generator = new ScriptedGenerator(evalOf(candidate(spec)));
    const testbench = new ScriptedTestbench({
      status: 'fragments-refused',
      refusal: { fragment: 'expectations.q', criterion: '4.11', construct: 'q' },
      source: '{"runLength": 1}',
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
    expect(outcome.cause).toBe('model-output-unusable');
    expect(outcome.detail).toContain('expectations.q');
    expect(outcome.detail).toContain('4.11');
  });

  it('carries a grounded parse refusal onto the setup failure as model output unusable', async () => {
    // testbench-spec-grounding Req 7.9, 7.10: the closed refusal code reaches the outcome.
    const spec = approvedSpec();
    const generator = new ScriptedGenerator(evalOf(candidate(spec)));
    const testbench = new ScriptedTestbench({
      status: 'generation-failed',
      failure: {
        reason: 'unparseable-output',
        detail: 'model output contained no fenced code block',
        parseRefusal: 'no-fence',
      },
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
    expect(outcome.cause).toBe('model-output-unusable');
    expect(outcome.testbenchParseRefusal).toBe('no-fence');
  });
});

describe('VerificationLoop.run - streaming (Req 6.7, 17.6)', () => {
  it('streams setup, simulating, and verified progress before the terminal outcome', async () => {
    const spec = approvedSpec();
    const generator = new ScriptedGenerator(evalOf(candidate(spec)));
    const testbench = new ScriptedTestbench({
      status: 'generated',
      checkingApproach: 'cycle-timed',
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

  it('submits every testbench run with the Simulation_Harness and the timescale request', async () => {
    // testbench-spec-grounding C9: the precheck and the Oracle_Run are both Testbench_Runs.
    const spec = approvedSpec();
    const jobs: SandboxJob[] = [];
    const { loop } = makeLoop(
      new AdmittingGate(confirmedContext(spec)),
      new ScriptedGenerator(evalOf(candidate(spec))),
      new ScriptedTestbench({
        status: 'generated',
        checkingApproach: 'cycle-timed',
        testbench: testbenchFor(spec),
        checks: [],
      }),
      (job) => {
        jobs.push(job);
        return passCapture();
      },
    );

    const outcome = await loop.verify(REQUEST, budgetWithIterations(20), LIMITS);

    expect(outcome.status).toBe('verified');
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(job.simulate).toEqual({ defaultTimescale: '1ns/1ps' });
      expect(job.workspaceFiles.at(-1)).toEqual(SIMULATION_HARNESS);
    }
  });
});
// The FormalProvenance threading (task 8.2; Req 7.7, 7.8, 12.11, 14.27, 14.39).
//
// The FIELD's presence is compiler-enforced - it is required on all three terminal
// outcomes - so what needs a runnable check is the VALUE, which the compiler cannot
// police. Two of its fields have a wrong value that type-checks and reads plausibly:
// `clockPolarity: 'none'` in place of `null`, which would record the SUPPORTED
// no-clocked-state contract for a run that never reached the pre-pass, and
// `resetContract: { derived: false }` in place of `null`, which would record a pre-pass
// REFUSAL that never happened. Both are the exact collapses design.md forbids, and both
// pass `tsc`, so they are asserted here.
//
// EDITED BY TASK 8.7, which is the task that changed what these outcomes carry - task 8.3
// wired the oracle but reached none of these three call sites, because all three are samples
// no formal GATE was wired for. The assertions below are UNCHANGED and are now the NEGATIVE
// CONTROL for the fill: they pin the no-reading values to a sample whose pre-pass genuinely
// never ran, and `records the three run-level clocking facts off the Formal_Outcome` asserts
// the other half, that a sample whose pre-pass DID run carries real values instead. Before
// 8.7 no run could reach the second case, so these three fields were structurally always at
// the values below and the two criteria had no satisfying implementation.
function assertNoFormalRun(formal: FormalProvenance): void {
  expect(formal.results).toEqual([]);
  // No Property_Wrapper was rendered, so none is recorded - the empty list `results` pairs with.
  expect(formal.propertyWrapperSources).toEqual([]);
  // `'not-gated'`, never `'no-gate-set'`: no admission gate ran at all here, and
  // `'no-gate-set'` would record a gate that RAN and found nothing to hold the set to.
  // That is the same collapse the two assertions below forbid for the pre-pass fields.
  expect(formal.propertySetAdmitted).toBe('not-gated');
  expect(formal.propertySetAdmitted).not.toBe('no-gate-set');
  expect(formal.unexpressedCriteria).toEqual([]);
  expect(formal.fallbackReason).toBeNull();
  // `'not-applicable'`, never `'no-property-expressed'`: no gate was wired, so no
  // Property_Author was ever asked to express anything (Req 7.18).
  expect(formal.fallbackRoute).toBe('not-applicable');
  // `null`, never the refused `{ derived: false }` arm: the pre-pass was not reached.
  expect(formal.resetContract).toBeNull();
  expect(formal.assertionGateEmitted).toBe(false);
  // `null`, never `'none'`: `'none'` is a contract this run was never taken under.
  expect(formal.clockPolarity).toBeNull();
  expect(formal.clockPolarity).not.toBe('none');
  expect(formal.formalOracleVersion).toBe(FORMAL_ORACLE_VERSION);
}

describe('VerificationLoop - FormalProvenance is threaded onto every terminal outcome', () => {
  it('carries the honest no-formal-run provenance on a Verified outcome', async () => {
    const spec = approvedSpec();
    const generator = new ScriptedGenerator(evalOf(candidate(spec)));
    const testbench = new ScriptedTestbench({
      status: 'generated',
      checkingApproach: 'cycle-timed',
      testbench: testbenchFor(spec),
      checks: [],
    });
    const { loop } = makeLoop(
      new AdmittingGate(confirmedContext(spec)),
      generator,
      testbench,
      passCapture,
    );

    const outcome = await loop.verify(REQUEST, budgetWithIterations(20), LIMITS);

    expect(outcome.status).toBe('verified');
    if (outcome.status !== 'verified') return;
    assertNoFormalRun(outcome.formal);
  });

  it('carries the honest no-formal-run provenance on an Unverified outcome', async () => {
    const spec = approvedSpec();
    const generator = new ScriptedGenerator(evalOf(candidate(spec)), [evalOf(candidate(spec))]);
    const testbench = new ScriptedTestbench({
      status: 'generated',
      checkingApproach: 'cycle-timed',
      testbench: testbenchFor(spec),
      checks: [],
    });
    const { loop } = makeLoop(
      new AdmittingGate(confirmedContext(spec)),
      generator,
      testbench,
      failCapture,
    );

    const outcome = await loop.verify(REQUEST, budgetWithIterations(2), LIMITS);

    expect(outcome.status).toBe('unverified');
    if (outcome.status !== 'unverified') return;
    assertNoFormalRun(outcome.formal);
  });

  it('holds the no-run value as a frozen constant, so no site can mutate it in place', () => {
    assertNoFormalRun(NO_FORMAL_RUN);
    expect(Object.isFrozen(NO_FORMAL_RUN)).toBe(true);
  });
});

// The formal-first gate and its recorded fallback (task 8.3; Req 7.6, 7.7, 7.11, 7.12,
// 8.6, 14.35).
//
// Driven through an INJECTED test double of the `FormalOraclePort` with a scripted
// Property_Set, which is what that port exists for: no formal toolchain is present, and
// the Property_Author does not exist yet (group 9), so a scripted set is the only way to
// reach these paths at all. The three task-8.2 expectations above are UNCHANGED and still
// pass, because a loop built without a `formal` dep submits no property.
//
// Every fallback assertion below carries a positive control: the fallback outcome is
// `verified` FROM THE SIMULATION, which a sample the formal gate decided can never be -
// so an assertion that passed while the fallback never ran is not available.

/** The counterexample a refuted fixture hands back; the evidence Req 1.10 demands. */
const COUNTEREXAMPLE: ArtifactBlobRef = {
  name: 'counterexample.vcd',
  sizeBytes: 24,
  sha256: 'c'.repeat(64),
};

/** One validated combinational property naming the criterion it was derived from. */
function formalProperty(criterionRef: string): FormalProperty {
  const consequent = validateExpression('q == d');
  if (!consequent.ok) {
    throw new Error('fixture expression was rejected by the validator');
  }
  return {
    kind: 'combinational',
    id: `p-${criterionRef}`,
    criterionRef,
    consequent: consequent.value,
  };
}

/** A `proved` result built through `admitProved`, the only constructor of a proof. */
function provedResult(criterionRef: string, elapsedMs: number): PropertyResult {
  const evidence = admitProved({
    assertionCount: 2,
    presat: 'satisfiable',
    cover: { reached: 'not-applicable' },
    base: 'passed',
    induction: 'successful',
  });
  if (typeof evidence === 'string') {
    throw new Error(`fixture is not a proof: ${evidence}`);
  }
  return { verdict: 'proved', evidence, depth: 20, elapsedMs, criterionRef };
}

/** A `refuted` result carrying its counterexample. */
function refutedResult(criterionRef: string, elapsedMs: number): PropertyResult {
  return {
    verdict: 'refuted',
    counterexample: COUNTEREXAMPLE,
    conditions: {
      assertionCount: 2,
      presat: 'satisfiable',
      cover: { reached: 'not-applicable' },
      base: 'failed',
      induction: 'not-run',
    },
    depth: 20,
    elapsedMs,
    criterionRef,
  };
}

/** A `could-not-verify` result for the given cause, with no condition evaluated. */
function couldNotVerifyResult(
  cause: CouldNotVerifyCause,
  criterionRef: string,
  elapsedMs: number,
): PropertyResult {
  return {
    verdict: 'could-not-verify',
    cause,
    conditions: {
      assertionCount: 0,
      presat: 'not-run',
      cover: { reached: 'not-applicable' },
      base: 'not-run',
      induction: 'not-run',
    },
    depth: 0,
    elapsedMs,
    criterionRef,
    diagnostic: null,
    crossCheckDisagreed: false,
  };
}

/**
 * The derived Reset_Contract these doubles report, chosen so the GATE is emitted under it.
 *
 * A SYNCHRONOUS reset over a FREE initial state is the one combination `emitsAssertionGate`
 * emits the `if (!$initstate)` gate for, so this contract makes all three run-level facts
 * differ from their no-reading values at once. That is what lets the expectation below fail if
 * any of the three is hardcoded rather than read off the Formal_Outcome (Req 14.27, 14.39).
 */
const DERIVED_RESET_CONTRACT: ResetContract = {
  derived: true,
  resetName: 'rst',
  resetActiveLow: false,
  resetKind: 'sync',
  initialStateFree: true,
};

/** The Clock_Contract a real pre-pass reads for the 31-of-50 posedge class. */
const DERIVED_CLOCK_POLARITY: ClockPolarity = 'posedge';

/**
 * The Property_Wrapper source the scripted oracle reports for one property.
 *
 * Distinct per criterion, so a provenance that recorded one property's wrapper against another's
 * result, or recorded a constant, would fail the equality below rather than pass over it.
 */
function scriptedWrapper(criterionRef: string): string {
  return `module formal_property_wrapper; // ${criterionRef}\nendmodule\n`;
}

/**
 * A formal oracle double returning one scripted Formal_Outcome for the whole Property_Set.
 *
 * It reports the three RUN-level facts a real pre-pass establishes rather than the no-reading
 * values, because every scripted set below reaches the oracle on a path where the pre-pass DID
 * run, and `null` is reserved for one that never did.
 */
class ScriptedOracle implements FormalOraclePort {
  readonly requests: FormalProveSetRequest[] = [];
  readonly #results: readonly PropertyResult[];
  readonly #captures: readonly (CounterexampleCapture | null)[] | null;

  /**
   * `captures` omitted means the double resolved no artifact reference, so no property carries a
   * trace - what every case except the capture-carrying ones needs. Passing it scripts the list
   * VERBATIM, LENGTH INCLUDED, because a misaligned list is a reachable state across this port
   * and the loop's handling of one is itself under test.
   */
  constructor(
    results: readonly PropertyResult[],
    captures: readonly (CounterexampleCapture | null)[] | null = null,
  ) {
    this.#results = results;
    this.#captures = captures;
  }

  proveSet(request: FormalProveSetRequest): Promise<FormalOutcome> {
    this.requests.push(request);
    return Promise.resolve({
      results: this.#results,
      propertyWrapperSources: this.#results.map((result) => scriptedWrapper(result.criterionRef)),
      counterexampleCaptures: this.#captures ?? this.#results.map(() => null),
      resetContract: DERIVED_RESET_CONTRACT,
      assertionGateEmitted: true,
      clockPolarity: DERIVED_CLOCK_POLARITY,
    });
  }

  /** The one-element-set delegation every implementation of this port owes (design.md Component 4). */
  async prove(request: FormalProveRequest): Promise<PropertyResult> {
    const outcome = await this.proveSet({
      designSource: request.designSource,
      designInterface: request.designInterface,
      properties: [request.property],
      budgetMs: request.budgetMs,
    });
    const result = outcome.results[0];
    if (result === undefined) {
      throw new Error('the scripted oracle was given no result for this property');
    }
    return result;
  }
}

/** A formal oracle double that throws, standing in for an unavailable instrument. */
class ThrowingOracle implements FormalOraclePort {
  prove(): Promise<PropertyResult> {
    throw new Error('the formal oracle is unavailable');
  }

  proveSet(): Promise<FormalOutcome> {
    throw new Error('the formal oracle is unavailable');
  }
}

/** A property-set source returning one scripted set. */
class ScriptedPropertySet implements PropertySetSource {
  readonly specIds: string[] = [];
  readonly #set: FormalPropertySet;

  constructor(set: FormalPropertySet) {
    this.#set = set;
  }

  propertySetFor(spec: Spec): Promise<FormalPropertySet> {
    this.specIds.push(spec.id);
    return Promise.resolve(this.#set);
  }
}

/** A property-set source that throws before any property is submitted. */
class ThrowingPropertySet implements PropertySetSource {
  propertySetFor(): Promise<FormalPropertySet> {
    return Promise.reject(new Error('the property author is unavailable'));
  }
}

/** A budget handle that records every charge and delegates to a real in-memory one. */
class RecordingBudget implements SessionBudgetHandle {
  readonly charges: AttemptCost[] = [];
  readonly sessionId;
  readonly #inner: InMemorySessionBudgetHandle;

  constructor(inner: InMemorySessionBudgetHandle) {
    this.#inner = inner;
    this.sessionId = inner.sessionId;
  }

  canAfford(): boolean {
    return this.#inner.canAfford();
  }

  charge(cost: AttemptCost): BudgetStopReason | null {
    this.charges.push(cost);
    return this.#inner.charge(cost);
  }

  stopReason(): BudgetStopReason | null {
    return this.#inner.stopReason();
  }
}

/** A gate over the given properties and scripted results, with nothing else wired. */
function formalGate(
  properties: readonly FormalProperty[],
  results: readonly PropertyResult[],
  unexpressedCriteria: readonly string[] = [],
  captures: readonly (CounterexampleCapture | null)[] | null = null,
): { gate: FormalGate; oracle: ScriptedOracle } {
  const oracle = new ScriptedOracle(results, captures);
  return {
    gate: {
      oracle,
      properties: new ScriptedPropertySet({
        properties,
        unexpressedCriteria,
        propertySetAdmitted: 'not-gated',
      }),
    },
    oracle,
  };
}

/** The standard fakes every case below shares: one candidate, one produced Testbench. */
function formalFixture(): {
  spec: Spec;
  context: ConfirmedGenerationContext;
  generator: ScriptedGenerator;
  testbench: ScriptedTestbench;
} {
  const spec = approvedSpec();
  return {
    spec,
    context: confirmedContext(spec),
    generator: new ScriptedGenerator(evalOf(candidate(spec)), [evalOf(candidate(spec))]),
    testbench: new ScriptedTestbench({
      status: 'generated',
      checkingApproach: 'cycle-timed',
      testbench: testbenchFor(spec),
      checks: [],
    }),
  };
}

/** Count the sandbox runs that were real iterations rather than the precheck's build. */
function iterationCounter(capture: () => RawRunCapture): {
  captures: (job: SandboxJob) => RawRunCapture;
  count: () => number;
} {
  let runs = 0;
  return {
    captures: (job) => {
      if (!isPrecheckJob(job)) {
        runs += 1;
      }
      return capture();
    },
    count: () => runs,
  };
}

describe('VerificationLoop - formal-first (Req 7.6, 8.6)', () => {
  it('decides the sample from the formal verdict where every property is proved', async () => {
    const { context, generator, testbench } = formalFixture();
    const properties = [formalProperty('c1'), formalProperty('c2')];
    const { gate, oracle } = formalGate(properties, [
      provedResult('c1', 900),
      provedResult('c2', 1_100),
    ]);
    // A capture that would PASS: so the assertion below that no iteration ran is a claim
    // about the formal gate deciding, and not about the simulation having been unable to.
    const runs = iterationCounter(passCapture);
    const { loop, recorder } = makeLoop(
      new AdmittingGate(context),
      generator,
      testbench,
      runs.captures,
      gate,
    );

    const outcome = await loop.verify(REQUEST, budgetWithIterations(20), LIMITS);

    expect(outcome.status).toBe('verified');
    if (outcome.status !== 'verified') return;
    // ONE submission carrying the whole Property_Set, in submission order. The set-level call
    // is what gives the loop a channel to the run-level clocking facts at all (Req 14.27).
    expect(oracle.requests).toHaveLength(1);
    expect(oracle.requests[0]?.properties.map((property) => property.criterionRef)).toEqual([
      'c1',
      'c2',
    ]);
    // One result per SUBMITTED property, in submission order, all proved.
    expect(outcome.formal.results.map((result) => result.verdict)).toEqual(['proved', 'proved']);
    expect(outcome.formal.fallbackReason).toBeNull();
    // The formal verdict decided it, so no Fallback_Route was taken (Req 7.18).
    expect(outcome.formal.fallbackRoute).toBe('not-applicable');
    // No simulate iteration ran: the formal gate decided this sample.
    expect(runs.count()).toBe(0);
    expect(outcome.iterations).toBe(0);
    // The `Verified` label is bound to the FORMAL span, and that span is really recorded.
    const trace = await recorder.getTrace(context.sessionId);
    const bound = trace.spans.find((span) => span.id === outcome.oracleSpanId);
    expect(bound?.stageOrTool).toBe('Formal_Oracle');
    expect(outcome.label.oracleSpanRef).toBe(outcome.oracleSpanId);
  });

  it('decides the sample unverified where any property is refuted, carrying the counterexample', async () => {
    const { spec, context, generator, testbench } = formalFixture();
    const properties = [formalProperty('c1'), formalProperty('c2')];
    const { gate } = formalGate(properties, [provedResult('c1', 50), refutedResult('c2', 70)]);
    const runs = iterationCounter(passCapture);
    const { loop } = makeLoop(
      new AdmittingGate(context),
      generator,
      testbench,
      runs.captures,
      gate,
    );

    const outcome = await loop.verify(REQUEST, budgetWithIterations(20), LIMITS);

    expect(outcome.status).toBe('unverified');
    if (outcome.status !== 'unverified') return;
    expect(outcome.label.tier).not.toBe('Verified');
    expect(outcome.formal.results.map((result) => result.verdict)).toEqual(['proved', 'refuted']);
    // A refutation is NOT a fall back: nothing could-not-verify, so no cause caused one.
    expect(outcome.formal.fallbackReason).toBeNull();
    expect(outcome.formal.fallbackRoute).toBe('not-applicable');
    // The Counterexample reaches the Teach_Mode handoff in the FailingCase slot.
    expect(outcome.teachMode.failingCase?.checkName).toBe('c2');
    expect(outcome.failingCase?.observed).toContain('proof depth 20');
    expect(outcome.simulation.vcd).toEqual(COUNTEREXAMPLE);
    // It did not reach the simulation, which would have PASSED and mislabeled it.
    expect(runs.count()).toBe(0);
    expect(spec.acceptanceCriteria).toHaveLength(1);
  });

  // The POSITIVE half of `assertNoFormalRun`, and the runnable check that closes Req 14.27 and
  // Req 14.39: every one of the three values below is DIFFERENT from the no-reading value the
  // negative control pins, so this fails if any field is hardcoded rather than read off the
  // Formal_Outcome the port returned.
  it('records the three run-level clocking facts off the Formal_Outcome (Req 14.27, 14.39)', async () => {
    const { context, generator, testbench } = formalFixture();
    const properties = [formalProperty('c1')];
    const { gate } = formalGate(properties, [provedResult('c1', 400)]);
    const { loop } = makeLoop(new AdmittingGate(context), generator, testbench, passCapture, gate);

    const outcome = await loop.verify(REQUEST, budgetWithIterations(20), LIMITS);

    expect(outcome.status).toBe('verified');
    if (outcome.status !== 'verified') return;
    // The DERIVED contract, never `null` and never the refused `{ derived: false }` arm: the
    // pre-pass ran and derived one.
    expect(outcome.formal.resetContract).toEqual(DERIVED_RESET_CONTRACT);
    expect(outcome.formal.assertionGateEmitted).toBe(true);
    expect(outcome.formal.clockPolarity).toBe(DERIVED_CLOCK_POLARITY);
  });

  // The positive half of the empty list `assertNoFormalRun` pins (Req 12.23): the wrappers the
  // port submitted are copied off the Formal_Outcome in result order, never re-rendered and never
  // left at the no-run value.
  it('copies the submitted wrapper sources off the Formal_Outcome, one per result', async () => {
    const { context, generator, testbench } = formalFixture();
    const properties = [formalProperty('c1'), formalProperty('c2')];
    const { gate } = formalGate(properties, [provedResult('c1', 400), provedResult('c2', 500)]);
    const { loop } = makeLoop(new AdmittingGate(context), generator, testbench, passCapture, gate);

    const outcome = await loop.verify(REQUEST, budgetWithIterations(20), LIMITS);

    expect(outcome.status).toBe('verified');
    if (outcome.status !== 'verified') return;
    expect(outcome.formal.propertyWrapperSources).toEqual([
      scriptedWrapper('c1'),
      scriptedWrapper('c2'),
    ]);
  });

  it('prefers the refutation over a could-not-verify in the same set', async () => {
    const { context, generator, testbench } = formalFixture();
    const properties = [formalProperty('c1'), formalProperty('c2')];
    const { gate } = formalGate(properties, [
      couldNotVerifyResult('proof-timeout', 'c1', 150_000),
      refutedResult('c2', 70),
    ]);
    const { loop } = makeLoop(new AdmittingGate(context), generator, testbench, passCapture, gate);

    const outcome = await loop.verify(REQUEST, budgetWithIterations(20), LIMITS);

    // Falling back here would let a PASSING simulation label a design a counterexample
    // refuted as `Verified`, which is the direction this precedence exists to close.
    expect(outcome.status).toBe('unverified');
    if (outcome.status !== 'unverified') return;
    expect(outcome.formal.fallbackReason).toBeNull();
    // Req 7.17 decided this from the refutation, so no route was taken even though the set
    // also holds a `could-not-verify` that would have driven one on its own.
    expect(outcome.formal.fallbackRoute).toBe('not-applicable');
    expect(outcome.formal.results.map((result) => result.verdict)).toEqual([
      'could-not-verify',
      'refuted',
    ]);
  });
});

// A CONTROLLED SET over four reader behaviours rather than four tests, because a mutation that
// collapsed the malformed-reference marker back into `null` passes every per-case assertion
// written alone: each case on its own only has to agree with its own expectation, and `null` IS
// the expectation for the proved property in all four. What it cannot pass is the set-level claim
// that the four recorded entries for the REFUTED property are four values none of which is `null`
// - the whole distinction this marker exists for.
describe('VerificationLoop - a refutation never records as "no evidence" (Req 12.16, 12.25)', () => {
  /** The whole-trace capture a healthy refutation hands back. */
  const WHOLE_TRACE: CounterexampleCapture = {
    kind: 'trace',
    reference: COUNTEREXAMPLE,
    trace: '$date generated $end\n$enddefinitions $end\n#0\n',
  };

  /**
   * A reference that LOCATES NOTHING: its digest is not a lowercase hex SHA-256, so the rule
   * `ArtifactBlobRef` in the seam schema states refuses it and no reader could resolve a blob
   * with it. Cast because the TYPE cannot express the malformed value, which is the point - this
   * arrives across a caller-implementable port, where the type is a claim rather than a fact.
   */
  const MALFORMED_REFERENCE = {
    ...COUNTEREXAMPLE,
    sha256: 'not-a-digest',
  } as unknown as ArtifactBlobRef;

  /**
   * Run ONE two-property set - `c1` proved, `c2` refuted - under one scripted capture list and
   * return the `FormalProvenance` the loop recorded.
   *
   * The simulation capture would PASS, so no assertion below can hold because the simulation was
   * unable to decide: a sample the formal gate did not decide ends `verified` here, and this
   * helper refuses anything but `unverified`.
   */
  async function provenanceUnder(
    captures: readonly (CounterexampleCapture | null)[] | null,
  ): Promise<FormalProvenance> {
    const { context, generator, testbench } = formalFixture();
    const properties = [formalProperty('c1'), formalProperty('c2')];
    const { gate } = formalGate(
      properties,
      [provedResult('c1', 50), refutedResult('c2', 70)],
      [],
      captures,
    );
    const { loop } = makeLoop(new AdmittingGate(context), generator, testbench, passCapture, gate);
    const outcome = await loop.verify(REQUEST, budgetWithIterations(20), LIMITS);
    if (outcome.status !== 'unverified') {
      throw new Error(`the refuted set did not terminate unverified: ${outcome.status}`);
    }
    return outcome.formal;
  }

  /** The four ways the run can hand back the refuted property's capture, and what is recorded. */
  const SCRIPTS: readonly {
    readonly name: string;
    readonly captures: readonly (CounterexampleCapture | null)[] | null;
    readonly recorded: RecordedCounterexampleCapture;
  }[] = [
    { name: 'the trace, read whole', captures: [null, WHOLE_TRACE], recorded: WHOLE_TRACE },
    {
      name: 'an honest refusal naming why the bytes are gone',
      captures: [null, { kind: 'refused', reference: COUNTEREXAMPLE, refusal: 'over-cap' }],
      recorded: { kind: 'refused', reference: COUNTEREXAMPLE, refusal: 'over-cap' },
    },
    {
      name: 'a capture whose recorded reference locates nothing',
      captures: [null, { ...WHOLE_TRACE, reference: MALFORMED_REFERENCE }],
      recorded: { kind: 'malformed-reference' },
    },
    {
      // The one case `recordedCapturesOf` cannot pair at all. It contributes nothing rather than
      // pairing positionally, because a trace handed to the wrong property would coach a Student
      // from the wrong waveform - strictly worse than having none.
      name: 'a list of another length, which pairs with nothing',
      captures: [WHOLE_TRACE],
      recorded: { kind: 'malformed-reference' },
    },
  ];

  it('records a locatable capture, and the marker where the evidence cannot be located', async () => {
    const forTheRefutation: (RecordedCounterexampleCapture | null)[] = [];

    for (const script of SCRIPTS) {
      const formal = await provenanceUnder(script.captures);

      // The refutation stands in every case: nothing about reading its evidence can move a
      // verdict the Base_Check decided.
      expect(
        formal.results.map((result) => result.verdict),
        script.name,
      ).toEqual(['proved', 'refuted']);
      // One entry per result, `null` included, whatever length the run handed back.
      expect(formal.counterexampleCaptures, script.name).toHaveLength(formal.results.length);
      // `null` for the PROVED property - the ordinary shape of a result with no counterexample,
      // and in the misaligned case a capture the run offered for it is dropped rather than
      // written, because Req 12.16 persists a Counterexample for a refutation and for nothing else.
      expect(formal.counterexampleCaptures[0], script.name).toBeNull();
      expect(formal.counterexampleCaptures[1], script.name).toEqual(script.recorded);

      forTheRefutation.push(formal.counterexampleCaptures[1] ?? null);
    }

    // THE SET-LEVEL CLAIM. Four readings of one refutation, and not one of them records the
    // value a sample that was never refuted records. Before the marker, two of the four did.
    expect(forTheRefutation).toHaveLength(SCRIPTS.length);
    expect(forTheRefutation).not.toContainEqual(null);
  });

  it('records `null` for a non-refuted result even where the run offered it a capture', async () => {
    const { context, generator, testbench } = formalFixture();
    const properties = [formalProperty('c1')];
    // A lying double: a trace attached to a PROOF. Nothing in the real adapter produces this,
    // and the port is caller-implementable, so the record is where it has to be refused - a
    // capture that reached the Artifact_Sink would be written as this sample's counterexample.
    const { gate } = formalGate(properties, [provedResult('c1', 50)], [], [WHOLE_TRACE]);
    const { loop } = makeLoop(new AdmittingGate(context), generator, testbench, passCapture, gate);

    const outcome = await loop.verify(REQUEST, budgetWithIterations(20), LIMITS);

    expect(outcome.status).toBe('verified');
    if (outcome.status !== 'verified') return;
    expect(outcome.formal.results.map((result) => result.verdict)).toEqual(['proved']);
    expect(outcome.formal.counterexampleCaptures).toEqual([null]);
  });
});

describe('VerificationLoop - the recorded Simulation_Fallback (Req 7.6, 7.7, 14.35)', () => {
  // The two PRE-PASS causes arrive before any solver ran and before any Property_Wrapper
  // existed, and they are recorded by the same path every other cause takes. On
  // `clock-contract-unsupported` the fallback is MEASURED correct rather than assumed:
  // iverilog reported 0 mismatches over 40 randomised cycles on the very case the gate
  // refused, so here the fallback is the demonstrably right answer, not just the honest
  // one - which is why this row is asserted by name rather than folded into the others.
  const CAUSES: readonly CouldNotVerifyCause[] = [
    'reset-contract-unresolved',
    'clock-contract-unsupported',
    'proof-timeout',
  ];

  for (const cause of CAUSES) {
    it(`falls back to the simulation and records ${cause} as the Fallback_Reason`, async () => {
      const { context, generator, testbench } = formalFixture();
      const properties = [formalProperty('c1')];
      const { gate } = formalGate(properties, [couldNotVerifyResult(cause, 'c1', 1_200)]);
      const runs = iterationCounter(passCapture);
      const { loop, recorder } = makeLoop(
        new AdmittingGate(context),
        generator,
        testbench,
        runs.captures,
        gate,
      );

      const outcome = await loop.verify(REQUEST, budgetWithIterations(20), LIMITS);

      // The positive control: this outcome is only reachable THROUGH the simulation
      // path, so it cannot pass if the fallback never ran.
      expect(outcome.status).toBe('verified');
      if (outcome.status !== 'verified') return;
      expect(runs.count()).toBe(1);
      expect(outcome.iterations).toBe(1);
      expect(outcome.formal.fallbackReason).toBe(cause);
      // The reason is recorded EXACTLY on the `'cause'` route, which is what makes the two
      // fields unable to disagree (Req 7.19).
      expect(outcome.formal.fallbackRoute).toBe('cause');
      expect(outcome.formal.results.map((result) => result.verdict)).toEqual(['could-not-verify']);
      // The label is bound to the SIMULATION's span, never the formal run's.
      const trace = await recorder.getTrace(context.sessionId);
      const bound = trace.spans.find((span) => span.id === outcome.oracleSpanId);
      expect(bound?.stageOrTool).toBe('Verification_Loop');
      // The formal run is still on the Trace: a fall back records the run it fell back from.
      expect(trace.spans.some((span) => span.stageOrTool === 'Formal_Oracle')).toBe(true);
    });
  }

  it('applies the fallback instrument rules unchanged: an incomplete pass still fails closed', async () => {
    const { spec, context, generator } = formalFixture();
    // One REQUIRED check the testbench never reports: the simulation gate's own
    // incomplete-evidence rule must still refuse the pass after a fall back (Req 7.12).
    const testbench = new ScriptedTestbench({
      status: 'generated',
      checkingApproach: 'cycle-timed',
      testbench: testbenchFor(spec),
      checks: [
        {
          name: 'q_holds_on_reset',
          kind: 'criterion',
          description: 'q holds its value while reset is asserted',
        },
      ] satisfies readonly RequiredCheck[],
    });
    const properties = [formalProperty('c1')];
    const { gate } = formalGate(properties, [
      couldNotVerifyResult('clock-contract-unsupported', 'c1', 10),
    ]);
    const { loop } = makeLoop(new AdmittingGate(context), generator, testbench, passCapture, gate);

    const outcome = await loop.verify(REQUEST, budgetWithIterations(20), LIMITS);

    expect(outcome.status).toBe('unverified');
    if (outcome.status !== 'unverified') return;
    expect(outcome.failingCase?.description).toContain('q_holds_on_reset');
    expect(outcome.formal.fallbackReason).toBe('clock-contract-unsupported');
  });

  it('falls back with toolchain-unavailable when the oracle throws', async () => {
    const { context, generator, testbench } = formalFixture();
    const gate: FormalGate = {
      oracle: new ThrowingOracle(),
      properties: new ScriptedPropertySet({
        properties: [formalProperty('c1')],
        unexpressedCriteria: [],
        propertySetAdmitted: 'not-gated',
      }),
    };
    const { loop } = makeLoop(new AdmittingGate(context), generator, testbench, passCapture, gate);

    const outcome = await loop.verify(REQUEST, budgetWithIterations(20), LIMITS);

    expect(outcome.status).toBe('verified');
    if (outcome.status !== 'verified') return;
    expect(outcome.formal.fallbackReason).toBe('toolchain-unavailable');
    expect(outcome.formal.fallbackRoute).toBe('cause');
    // One `null` per submitted property: the port threw, so no wrapper came back, and the list
    // stays as long as `results` so the index pairing a reader relies on still holds.
    expect(outcome.formal.results).toHaveLength(1);
    expect(outcome.formal.propertyWrapperSources).toEqual([null]);
  });

  it('falls back with toolchain-unavailable when the property source throws', async () => {
    const { context, generator, testbench } = formalFixture();
    const gate: FormalGate = {
      oracle: new ScriptedOracle([]),
      properties: new ThrowingPropertySet(),
    };
    const { loop } = makeLoop(new AdmittingGate(context), generator, testbench, passCapture, gate);

    const outcome = await loop.verify(REQUEST, budgetWithIterations(20), LIMITS);

    expect(outcome.status).toBe('verified');
    if (outcome.status !== 'verified') return;
    expect(outcome.formal.fallbackReason).toBe('toolchain-unavailable');
    expect(outcome.formal.fallbackRoute).toBe('cause');
    expect(outcome.formal.results).toEqual([]);
  });
});

describe('VerificationLoop - the formal run is charged to the budget (Req 7.11)', () => {
  it('charges every formal run against the sample own budget handle', async () => {
    const { context, generator, testbench } = formalFixture();
    const properties = [formalProperty('c1'), formalProperty('c2')];
    const { gate } = formalGate(properties, [
      couldNotVerifyResult('proof-timeout', 'c1', 150_000),
      provedResult('c2', 2_500),
    ]);
    const budget = new RecordingBudget(budgetWithIterations(20));
    const { loop } = makeLoop(new AdmittingGate(context), generator, testbench, passCapture, gate);

    await loop.verify(REQUEST, budget, LIMITS);

    const formalCharges = budget.charges.filter(
      (cost) => cost.tokens === 0 && cost.costCents === 0,
    );
    expect(formalCharges.map((cost) => cost.wallClockMs)).toContain(150_000);
    expect(formalCharges.map((cost) => cost.wallClockMs)).toContain(2_500);
  });

  it('charges nothing formal when no gate is wired - the control for the claim above', async () => {
    const { context, generator, testbench } = formalFixture();
    const budget = new RecordingBudget(budgetWithIterations(20));
    const { loop } = makeLoop(new AdmittingGate(context), generator, testbench, passCapture);

    await loop.verify(REQUEST, budget, LIMITS);

    // Only the setup model calls and the one simulate charge; no 150s formal run.
    expect(budget.charges.every((cost) => cost.wallClockMs < 150_000)).toBe(true);
  });
});

describe('VerificationLoop - an absent gate and an empty set are different facts', () => {
  it('decides an empty Property_Set from the simulation, and never proves it vacuously', async () => {
    const { context, generator, testbench } = formalFixture();
    // Zero properties: "every property proved" would hold VACUOUSLY, which is exactly
    // the silent pass the five-condition gate exists to refuse.
    const { gate, oracle } = formalGate([], [], ['q captures d']);
    const runs = iterationCounter(passCapture);
    const { loop } = makeLoop(
      new AdmittingGate(context),
      generator,
      testbench,
      runs.captures,
      gate,
    );

    const outcome = await loop.verify(REQUEST, budgetWithIterations(20), LIMITS);

    expect(outcome.status).toBe('verified');
    if (outcome.status !== 'verified') return;
    expect(oracle.requests).toEqual([]);
    expect(runs.count()).toBe(1);
    expect(outcome.formal.results).toEqual([]);
    // Nothing fell back on a CAUSE: no Could_Not_Verify_Cause produced anything, so
    // recording one would invent it. The route says why in its own name instead (Req 7.20),
    // and `'no-property-expressed'` is the STUDENT-path reading: the Property_Author was
    // asked and could state nothing, which is what a student should be TOLD.
    expect(outcome.formal.fallbackReason).toBeNull();
    expect(outcome.formal.fallbackRoute).toBe('no-property-expressed');
    // What separates this from a run with NO gate wired: the criteria the author could
    // not express. An empty set over a Spec with criteria reports every one of them.
    expect(outcome.formal.unexpressedCriteria).toEqual(['q captures d']);
    expect(NO_FORMAL_RUN.unexpressedCriteria).toEqual([]);
    expect(NO_FORMAL_RUN.fallbackRoute).toBe('not-applicable');
  });

  // The third way an empty set reaches the loop, and the one the route exists to keep apart
  // from the two above: the Property_Set_Admission gate REFUSED the set, so the eval layer
  // hands the loop an empty one stamped `'refused'` (see `FormalPropertySet`). A refusal is
  // deliberately NOT a `CouldNotVerifyCause` - it says the instrument was blunt, not that the
  // Formal_Oracle returned a verdict - so without this route it persisted as an all-`null`
  // formal block indistinguishable from "the author expressed nothing" (Req 7.19).
  it('records a refused Property_Set as its own route, not as an unexpressed one', async () => {
    const { context, generator, testbench } = formalFixture();
    const oracle = new ScriptedOracle([]);
    const gate: FormalGate = {
      oracle,
      properties: new ScriptedPropertySet({
        properties: [],
        unexpressedCriteria: [],
        propertySetAdmitted: 'refused',
      }),
    };
    const { loop } = makeLoop(new AdmittingGate(context), generator, testbench, passCapture, gate);

    const outcome = await loop.verify(REQUEST, budgetWithIterations(20), LIMITS);

    // Reachable only THROUGH the simulation path, so it cannot pass if nothing fell back.
    expect(outcome.status).toBe('verified');
    if (outcome.status !== 'verified') return;
    expect(oracle.requests).toEqual([]);
    expect(outcome.formal.fallbackRoute).toBe('property-set-refused');
    expect(outcome.formal.fallbackRoute).not.toBe('no-property-expressed');
    // And the refusal never enters the Could_Not_Verify_Cause vocabulary every cause-keyed
    // count is built on.
    expect(outcome.formal.fallbackReason).toBeNull();
    expect(outcome.formal.propertySetAdmitted).toBe('refused');
  });

  // Req 10.3 as the LOOP's own guard rather than a contract the caller owes. The case above
  // passes on an emptied set, which is the only shape the eval layer happens to hand over
  // today; this one hands the loop a NON-EMPTY set stamped `'refused'` whose every property
  // would PROVE. Before the guard the loop branched on emptiness alone and read
  // `propertySetAdmitted` only to copy it onto the record, so this exact sample was submitted
  // and labelled `Verified` from the formal verdict - a refused Property_Set deciding the very
  // thing it was refused for being too blunt to decide.
  it('submits NOTHING for a NON-EMPTY refused set, and the simulation decides it', async () => {
    const { context, generator, testbench } = formalFixture();
    const oracle = new ScriptedOracle([provedResult('c1', 900), provedResult('c2', 1_100)]);
    const gate: FormalGate = {
      oracle,
      properties: new ScriptedPropertySet({
        properties: [formalProperty('c1'), formalProperty('c2')],
        unexpressedCriteria: [],
        propertySetAdmitted: 'refused',
      }),
    };
    const runs = iterationCounter(passCapture);
    const { loop } = makeLoop(
      new AdmittingGate(context),
      generator,
      testbench,
      runs.captures,
      gate,
    );

    const outcome = await loop.verify(REQUEST, budgetWithIterations(20), LIMITS);

    // Nothing was submitted, so the scripted proofs above could not have decided anything.
    expect(oracle.requests).toEqual([]);
    // The SIMULATION decided: one real iteration ran, which a formal decision would have
    // skipped entirely (see the formal-first cases, where `runs.count()` is 0).
    expect(runs.count()).toBe(1);
    expect(outcome.status).toBe('verified');
    if (outcome.status !== 'verified') return;
    expect(outcome.formal.results).toEqual([]);
    // The refusal is the route, and it never becomes a Could_Not_Verify_Cause (Req 7.19).
    expect(outcome.formal.fallbackRoute).toBe('property-set-refused');
    expect(outcome.formal.fallbackReason).toBeNull();
    expect(outcome.formal.propertySetAdmitted).toBe('refused');
    // No formal run happened at all, so there is no `Formal_Oracle` span to bind to.
    expect(outcome.formal.propertyWrapperSources).toEqual([]);
  });
});
