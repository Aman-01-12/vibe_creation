// Verification_Loop (S7) integration test (task 14.2).
//
// This drives the WHOLE Verification_Loop - generation gate, parallel generation
// + independent testbench, the simulate -> label-or-repair iterate loop, the
// oracle-derived Trust_Labeler, and the Action_Recorder - along two trajectories
// the design and Req 8.4/8.5/8.8 demand:
//
//   1. fail -> repair -> pass: a buggy candidate fails the oracle, the loop
//      repairs it from the simulator output, and the repaired candidate passes;
//      the module ends `Verified` bound to the passing oracle span (provenance
//      present), after exactly two iterations, with both verdicts recorded.
//   2. budget exhaustion: the candidate never passes before the Session_Budget is
//      exhausted; the loop TERMINATES (Req 8.4) with a bounded iteration count and
//      presents the failing case labeled `Unverified` with a Teach_Mode handoff
//      seam (Req 8.5). Every verdict/iteration is recorded as an ordered Trace
//      span (Req 8.8).
//
// REAL ORACLE vs FAKE ORACLE
//   The design says "through the real oracle". The real Icarus toolchain
//   (`iverilog` + `vvp`) is absent in most environments, so - mirroring the task
//   3.8 / 3.9 precedent exactly - the real-oracle trajectories are gated behind
//   the shared `PROBE` and SKIP cleanly via `describe.skipIf(!PROBE.available)`
//   when the toolchain is missing, and the SAME trajectories are ALSO exercised
//   through the `FakeSandboxRuntime`-backed Simulator so this test is non-vacuous
//   (never a no-op) even when the real oracle is unavailable. When the toolchain
//   IS present the real suites run the actual counter RTL through real iverilog +
//   vvp end to end. Only the Simulator differs between the two suites; the loop,
//   labeler, recorder, budget, and assertions are identical.

import { describe, expect, it } from 'vitest';

import {
  newUlid,
  ok,
  oracleTrustLabeler,
  unverified,
  type ArtifactRef,
  type Json,
  type Result,
  type SessionBudget,
  type Spec,
  type Testbench,
  type Trace,
  type Ulid,
} from '@app/core';
import {
  FakeSandboxRuntime,
  IcarusSimulatorAdapter,
  SandboxToolRunner,
  type RawRunCapture,
  type ResourceLimits,
  type SandboxJob,
  type SimulatorAdapter,
} from '@app/tools';
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
  type RepairTestbenchRequest,
  type SessionBudgetHandle,
  type TestbenchGenerationOutcome,
} from '@app/agent';

import {
  BUGGY_COUNTER_RTL,
  COUNTER_MODULE_NAME,
  COUNTER_TESTBENCH,
  PASSING_COUNTER_RTL,
  PROBE,
  realOracleAdapter,
} from './real-oracle-harness.js';
import { timingContractFor } from '@app/test';

if (!PROBE.available) {
  console.warn(
    `[verification-loop.integration] Real-oracle trajectories NOT exercised: ${PROBE.reason}. ` +
      'The fail->repair->pass and budget-exhaustion trajectories are still driven through the ' +
      'fake Simulator in this environment; the real iverilog + vvp assertions are SKIPPED.',
  );
}

/** The Trace stage name the Verification_Loop records every oracle verdict under. */
const VERIFICATION_STAGE = 'Verification_Loop';

/** Generous real-run caps for a local process launch plus a real iverilog + vvp run. */
const LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };

/** Per-test timeout covering multiple real compile-and-simulate runs (ms). */
const REAL_TIMEOUT = 180_000;

/** The name of the single spec-derived check the counter testbench can fail. */
const FAILING_CHECK = 'counts_up';

// -- Fixtures ---------------------------------------------------------------

/** An approved single-module Spec for the 4-bit counter the harness fixtures build. */
function counterSpec(): Spec {
  return {
    timingContract: timingContractFor({
      validityOutputName: null,
      moduleName: COUNTER_MODULE_NAME,
      ports: [
        { name: 'clk', direction: 'input', width: 1 },
        { name: 'rst', direction: 'input', width: 1 },
        { name: 'count', direction: 'output', width: 4 },
      ],
      clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
    }),
    id: newUlid(),
    projectId: newUlid(),
    goal: 'A 4-bit synchronous up-counter that clears to zero on reset.',
    constraints: [],
    moduleInterface: {
      validityOutputName: null,
      moduleName: COUNTER_MODULE_NAME,
      ports: [
        { name: 'clk', direction: 'input', width: 1 },
        { name: 'rst', direction: 'input', width: 1 },
        { name: 'count', direction: 'output', width: 4 },
      ],
      clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
    },
    acceptanceCriteria: [
      {
        id: newUlid(),
        text: 'reset clears the output to zero',
        measurable: true,
        method: 'simulation',
      },
      {
        id: newUlid(),
        text: 'the count increments by one each clock',
        measurable: true,
        method: 'simulation',
      },
    ],
    architecture:
      'Single always block incrementing count on the clock edge with a synchronous reset.',
    approved: true,
    version: 1,
  };
}

/** A generated candidate carrying the given RTL and a fresh module-version ref. */
function candidate(spec: Spec, rtl: string): GeneratedCandidate {
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
    parsedInterface: { moduleName: COUNTER_MODULE_NAME, ports: [] },
    interfaceMatch: {
      matches: true,
      moduleNameMatches: true,
      expectedModuleName: COUNTER_MODULE_NAME,
      actualModuleName: COUNTER_MODULE_NAME,
      missingPorts: [],
      extraPorts: [],
      mismatchedPorts: [],
    },
    moduleVersion,
    label: unverified(artifactRef),
  };
}

/** Wrap a candidate as a produced `CandidateEval` with a clean interface. */
function evalOf(cand: GeneratedCandidate): Result<CandidateEval, CandidateFailure> {
  return ok({ candidate: cand, interfaceDiagnostics: '' });
}

/** The independent, spec-derived Testbench (the real counter testbench source). */
function testbenchFor(spec: Spec): Testbench {
  return {
    id: newUlid(),
    specId: spec.id,
    specVersion: spec.version,
    source: COUNTER_TESTBENCH,
    sourceAttribution: 'spec',
    coversCriteria: spec.acceptanceCriteria.map((criterion) => criterion.id),
  };
}

/** A confirmed generation context bound to a caller-known session id (for Trace reads). */
function confirmedContext(spec: Spec, sessionId: Ulid): ConfirmedGenerationContext {
  return {
    sessionId,
    projectId: spec.projectId,
    confirmedIntent: { summary: 'A 4-bit up-counter.', constraints: [], assumptions: [] },
    approvedSpec: spec,
  } as unknown as ConfirmedGenerationContext;
}

// -- Fakes for the collaborators the loop drives ----------------------------

/** A gate opener that always admits with the given confirmed context. */
class AdmittingGate implements GenerationContextOpener {
  readonly #context: ConfirmedGenerationContext;
  constructor(context: ConfirmedGenerationContext) {
    this.#context = context;
  }
  openGenerationContext(): Promise<Result<ConfirmedGenerationContext, GenerationGateRefusal>> {
    return Promise.resolve(ok(this.#context));
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

/** A testbench port that returns the produced Testbench, charging one budget step. */
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

// -- Fake Simulator captures (non-vacuous path) -----------------------------

/** A raw capture whose testbench emitted the counter check PASS plus a VCD. */
function passCapture(): RawRunCapture {
  return {
    timedOut: false,
    infraFailure: false,
    exitCode: 0,
    stdout: `CHECK ${FAILING_CHECK} PASS\n`,
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts: { vcd: { name: 'dump.vcd', sizeBytes: 8, sha256: 'a'.repeat(64) } },
    deniedOperations: [],
    resourceUsage: { wallMs: 12, maxMemMb: 8, cpuMs: 10 },
  };
}

/** A raw capture whose testbench emitted the counter check FAIL but still a VCD. */
function failCapture(): RawRunCapture {
  return {
    timedOut: false,
    infraFailure: false,
    exitCode: 0,
    stdout: `CHECK ${FAILING_CHECK} FAIL\n`,
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts: { vcd: { name: 'dump.vcd', sizeBytes: 8, sha256: 'b'.repeat(64) } },
    deniedOperations: [],
    resourceUsage: { wallMs: 9, maxMemMb: 8, cpuMs: 7 },
  };
}

/**
 * The Testbench_Precheck's interface-stub filename (`testbench-precheck.ts`,
 * `INTERFACE_STUB_MODULE`). The loop now runs an unconditional precheck simulate
 * call before the first iteration, submitting this stub as "RTL". A sequenced
 * fake must recognize and skip over that call so the scripted sequence still
 * advances only on real iterations.
 */
const PRECHECK_STUB_PATH = 'testbench_precheck_stub.v';

/** Whether a sandbox job is the precheck's own build check, not a real iteration. */
function isPrecheckJob(job: SandboxJob): boolean {
  return job.workspaceFiles.some((file) => file.path === PRECHECK_STUB_PATH);
}

/** A fake Simulator that plays scripted captures in sequence (last repeats). */
function fakeSimulator(sequence: readonly (() => RawRunCapture)[]): SimulatorAdapter {
  let index = 0;
  const runtime = new FakeSandboxRuntime((job) => {
    if (isPrecheckJob(job)) {
      return passCapture();
    }
    const make = sequence[Math.min(index, sequence.length - 1)];
    index += 1;
    return (make ?? failCapture)();
  });
  return new IcarusSimulatorAdapter(new SandboxToolRunner(runtime));
}

// -- Budget + loop assembly -------------------------------------------------

/** An in-memory budget handle with the given iteration cap and generous other caps. */
function budgetWithIterations(maxIterations: number): InMemorySessionBudgetHandle {
  const budget: SessionBudget = {
    sessionId: newUlid(),
    maxIterations,
    maxTokens: 1_000_000,
    maxWallClockMs: 1_000_000_000,
    maxCostCents: 1_000_000,
    consumedIterations: 0,
    consumedTokens: 0,
    consumedMs: 0,
    consumedCostCents: 0,
  };
  return new InMemorySessionBudgetHandle(budget);
}

/** Assemble a loop over the given Simulator, plus the recorder to read the Trace back. */
function makeLoop(
  simulator: SimulatorAdapter,
  generator: CandidateGenerator,
  testbench: IndependentTestbenchGenerator,
  context: ConfirmedGenerationContext,
): { loop: VerificationLoop; recorder: TraceActionRecorder } {
  const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
  const loop = new VerificationLoop({
    gate: new AdmittingGate(context),
    generator,
    testbench,
    simulator,
    recorder,
    trustLabeler: oracleTrustLabeler,
  });
  return { loop, recorder };
}

const REQUEST = {} as unknown as GenerationAdmissionRequest;

// -- Trace inspection (Req 8.8) ---------------------------------------------

/** One recorded oracle verdict span, reduced to the fields Req 8.8 requires. */
interface RecordedVerdict {
  readonly seq: number;
  readonly verdict: string;
  readonly iteration: number;
}

/** Narrow a `Json` value to its object shape, or an empty record. */
function asRecord(value: Json): Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
}

/** Extract the ordered Verification_Loop verdict spans recorded in the Trace. */
function recordedVerdicts(trace: Trace): RecordedVerdict[] {
  return trace.spans
    .filter((span) => span.stageOrTool === VERIFICATION_STAGE)
    .map((span) => {
      const outputs = asRecord(span.outputs);
      const verdict = typeof outputs.verdict === 'string' ? outputs.verdict : '';
      const iteration = typeof outputs.iteration === 'number' ? outputs.iteration : -1;
      return { seq: span.seq, verdict, iteration };
    });
}

/** Assert a recorded verdict sequence is ordered, complete, and matches expectations. */
function expectOrderedVerdicts(
  recorded: readonly RecordedVerdict[],
  verdicts: readonly string[],
): void {
  expect(recorded.map((entry) => entry.verdict)).toEqual([...verdicts]);
  // Ordered spans: strictly ascending seq and 1-based, contiguous iteration numbers.
  expect(recorded.map((entry) => entry.iteration)).toEqual(verdicts.map((_, i) => i + 1));
  for (let i = 1; i < recorded.length; i += 1) {
    expect(recorded[i]!.seq).toBeGreaterThan(recorded[i - 1]!.seq);
  }
}

// -- Shared trajectory assertions -------------------------------------------
//
// Each trajectory is expressed once and run against either the real oracle or the
// fake Simulator, so the two suites assert identically and cannot drift.

/** Drive fail -> repair -> pass and assert Verified-with-provenance + ordered Trace. */
async function assertFailRepairPass(simulator: SimulatorAdapter): Promise<void> {
  const spec = counterSpec();
  const sessionId = newUlid();
  const generator = new ScriptedGenerator(evalOf(candidate(spec, BUGGY_COUNTER_RTL)), [
    evalOf(candidate(spec, PASSING_COUNTER_RTL)),
  ]);
  const testbench = new ScriptedTestbench({
    status: 'generated',
    checkingApproach: 'cycle-timed',
    testbench: testbenchFor(spec),
    checks: [],
  });
  const { loop, recorder } = makeLoop(
    simulator,
    generator,
    testbench,
    confirmedContext(spec, sessionId),
  );

  const outcome = await loop.verify(REQUEST, budgetWithIterations(20), LIMITS);

  expect(outcome.status).toBe('verified');
  if (outcome.status !== 'verified') {
    return;
  }
  // Verified, bound to the recorded passing oracle span (provenance present).
  expect(outcome.label.tier).toBe('Verified');
  expect(outcome.label.oracleSpanRef).toBe(outcome.oracleSpanId);
  expect(outcome.result.verdict).toBe('pass');
  expect(outcome.result.oracleSpanId).toBe(outcome.oracleSpanId);
  // One failing run, then one repair, then the passing run: exactly two iterations.
  expect(outcome.iterations).toBe(2);
  expect(generator.reviseCalls).toHaveLength(1);
  expect(generator.reviseCalls[0]?.diagnostics).toContain(FAILING_CHECK);

  const recorded = recordedVerdicts(await recorder.getTrace(sessionId));
  expectOrderedVerdicts(recorded, ['fail', 'pass']);
}

/** Drive a never-passing loop and assert bounded termination + Unverified handoff. */
async function assertBudgetExhaustion(simulator: SimulatorAdapter): Promise<void> {
  const spec = counterSpec();
  const sessionId = newUlid();
  const maxIterations = 6;
  const generator = new ScriptedGenerator(evalOf(candidate(spec, BUGGY_COUNTER_RTL)), [
    evalOf(candidate(spec, BUGGY_COUNTER_RTL)),
  ]);
  const testbench = new ScriptedTestbench({
    status: 'generated',
    checkingApproach: 'cycle-timed',
    testbench: testbenchFor(spec),
    checks: [],
  });
  const { loop, recorder } = makeLoop(
    simulator,
    generator,
    testbench,
    confirmedContext(spec, sessionId),
  );

  const outcome = await loop.verify(REQUEST, budgetWithIterations(maxIterations), LIMITS);

  expect(outcome.status).toBe('unverified');
  if (outcome.status !== 'unverified') {
    return;
  }
  // Terminated (Req 8.4) with an iteration count bounded by the budget.
  expect(outcome.iterations).toBeGreaterThanOrEqual(1);
  expect(outcome.iterations).toBeLessThanOrEqual(maxIterations);
  expect(outcome.stopReason).toBe('max-iterations');
  // The failing case is presented and labeled Unverified with a Teach_Mode seam (Req 8.5).
  expect(outcome.label.tier).toBe('Unverified');
  expect(outcome.result.verdict).toBe('fail');
  expect(outcome.failingCase?.checkName).toBe(FAILING_CHECK);
  expect(outcome.teachMode.failingCase?.checkName).toBe(FAILING_CHECK);
  expect(outcome.teachMode.diagnostics).toContain(FAILING_CHECK);
  expect(outcome.teachMode.stopReason).toBe('max-iterations');

  const recorded = recordedVerdicts(await recorder.getTrace(sessionId));
  // Every iteration recorded as an ordered span; all failing since none passed (Req 8.8).
  expect(recorded).toHaveLength(outcome.iterations);
  expectOrderedVerdicts(
    recorded,
    recorded.map(() => 'fail'),
  );
}

// -- Fake-Simulator suite (always runs; keeps the test non-vacuous) ---------

describe('Verification_Loop integration - fake Simulator (non-vacuous; Req 8.4, 8.5, 8.8)', () => {
  it('fail -> repair -> pass ends Verified bound to the passing oracle span', async () => {
    await assertFailRepairPass(fakeSimulator([failCapture, passCapture]));
  });

  it('budget exhaustion terminates Unverified with a bounded iteration count and Teach_Mode handoff', async () => {
    await assertBudgetExhaustion(fakeSimulator([failCapture]));
  });
});

// -- Capability probe (always runs) -----------------------------------------

describe('Verification_Loop integration - real-oracle capability probe', () => {
  it('documents whether the real oracle path was exercised in this environment', () => {
    expect(typeof PROBE.available).toBe('boolean');
    expect(PROBE.reason.length).toBeGreaterThan(0);
  });
});

// -- Real-oracle suite (skips cleanly when iverilog/vvp are absent) ---------

describe.skipIf(!PROBE.available)(
  'Verification_Loop integration - real oracle (iverilog + vvp; Req 8.4, 8.5, 8.8)',
  () => {
    it(
      'fail -> repair -> pass ends Verified bound to the passing oracle span',
      async () => {
        await assertFailRepairPass(realOracleAdapter());
      },
      REAL_TIMEOUT,
    );

    it(
      'budget exhaustion terminates Unverified with a bounded iteration count and Teach_Mode handoff',
      async () => {
        await assertBudgetExhaustion(realOracleAdapter());
      },
      REAL_TIMEOUT,
    );
  },
);
