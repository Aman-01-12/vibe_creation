// testbench-repair-loop, task 6.5, Property 1: A repair fires only on the closed trigger
// set, and at most once per sample.
//
// Drives the real `VerificationLoop` (its `#admitInstrument`/`#repairPrecheckFailure`
// pair) over a fake sandbox-backed Simulator, exactly as `verification-loop.test.ts`'s own
// examples do, so the trigger logic under test is the real one and not a hand-rolled
// restatement of it. The ONLY `PrecheckOutcome` member that attributes the build failure
// to the testbench itself (`testbench-build-failed`) must fire exactly one `repairTestbench`
// call; `undecided` - produced by every other sandbox capture shape, including a clean
// build, a build failure attributed to the stub alone, or a captured run with no diagnostic
// at all - must fire zero.
//
// Validates: Requirements 1.1, 1.2, 1.3, 1.4

import fc from 'fast-check';
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
  type RepairTestbenchRequest,
  type SessionBudgetHandle,
  type TestbenchGenerationOutcome,
} from '@app/agent';
import { FakeSandboxRuntime, IcarusSimulatorAdapter, SandboxToolRunner } from '@app/tools';

import { propertyParameters } from './property.js';
import { timingContractFor } from '@app/test';

const PROPERTY =
  'testbench-repair-loop, Property 1: A repair fires only on the closed trigger set, and at most once per sample';

const LIMITS = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5_000 } as const;
const REQUEST = {} as unknown as GenerationAdmissionRequest;

/** The sandbox-capture shapes exercised, chosen to hit every real `PrecheckOutcome`. */
type CaptureShape =
  /** The ONE shape that produces `testbench-build-failed`: a syntax error naming the
   *  testbench file by its own filename. */
  | 'testbench-build-failed'
  /** A build that compiles and simulates cleanly - `undecided` by the clean-build row. */
  | 'clean'
  /** A build failure naming only the stub file, never the testbench - `undecided` by the
   *  stub-attribution row (Req 1.12's sibling: the failure is not the testbench's). */
  | 'stub-only-failure'
  /** A failure cause other than a build failure (an incomplete waveform capture) -
   *  `undecided` by the "any other cause" row. */
  | 'incomplete-output';

const CAPTURE_SHAPES: readonly CaptureShape[] = [
  'testbench-build-failed',
  'clean',
  'stub-only-failure',
  'incomplete-output',
];

/** An approved single-module Spec with one simulation-verifiable acceptance criterion. */
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

/** A minimal generated candidate whose label carries a fresh module-version ref. */
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

/** A one-shot generation port: one candidate, charging the budget once. */
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

/**
 * A counting testbench port: one fixed draft, and a repair call that counts itself and
 * (when `repairs` is non-empty) returns the next scripted outcome, or a safe decline once
 * exhausted. Never throws, so a repair that fires is always observable as a count, never
 * as an unhandled rejection.
 */
class CountingTestbench implements IndependentTestbenchGenerator {
  readonly #draft: Testbench;
  readonly #repairs: readonly TestbenchGenerationOutcome[];
  repairCalls = 0;

  constructor(draft: Testbench, repairs: readonly TestbenchGenerationOutcome[] = []) {
    this.#draft = draft;
    this.#repairs = repairs;
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
    const outcome = this.#repairs[this.repairCalls];
    this.repairCalls += 1;
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve(
      outcome ?? {
        status: 'generation-failed',
        failure: { reason: 'model-call-failed', detail: 'CountingTestbench exhausted its script' },
      },
    );
  }
}

/** The precheck's interface-stub filename (`INTERFACE_STUB_MODULE` in testbench-precheck.ts). */
const PRECHECK_STUB_PATH = 'testbench_precheck_stub.v';

/** A raw capture whose testbench emitted a passing check and a VCD: a clean build. */
function passCapture() {
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

/**
 * The one precheck capture shape that produces `testbench-build-failed`.
 *
 * `artifacts: {}` clears the VCD `passCapture` carries: with it missing, the required
 * `vcd` output is absent, so the sandbox classifies the run `error` rather than `fail`
 * on exit code alone, which is what lets `classifyRunFailure` reach the stderr and
 * attribute it to a submitted file (matching `verification-loop.test.ts`'s own
 * `testbenchBuildFailureCapture`).
 */
function testbenchBuildFailureCapture() {
  return {
    ...passCapture(),
    exitCode: 1,
    stdout: '',
    stderr: 'byte_reg_tb.v:12: syntax error\n',
    artifacts: {},
  };
}

/** A build failure attributed to the stub file alone, never the testbench: `undecided`. */
function stubOnlyFailureCapture() {
  return {
    ...passCapture(),
    exitCode: 1,
    stdout: '',
    stderr: 'testbench_precheck_stub.v:3: syntax error\n',
    artifacts: {},
  };
}

/** A completed run with no CHECK line and no VCD: `output-incomplete`, so `undecided`. */
function incompleteOutputCapture() {
  return { ...passCapture(), stdout: '', artifacts: {} };
}

/** The precheck capture for a given shape; every job after it always passes. */
function captureFor(shape: CaptureShape) {
  switch (shape) {
    case 'testbench-build-failed':
      return testbenchBuildFailureCapture();
    case 'clean':
      return passCapture();
    case 'stub-only-failure':
      return stubOnlyFailureCapture();
    case 'incomplete-output':
      return incompleteOutputCapture();
  }
}

/** Whether a sandbox job is the precheck's own build check, not a real iteration. */
function isPrecheckJob(job: { workspaceFiles: readonly { path: string }[] }): boolean {
  return job.workspaceFiles.some((file) => file.path === PRECHECK_STUB_PATH);
}

/** Open an in-memory budget handle with generous caps. */
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

/** Drive one trajectory: the given precheck shape, then every later job passes clean. */
async function runTrajectory(shape: CaptureShape, testbench: CountingTestbench): Promise<void> {
  const spec = approvedSpec();
  const runtime = new FakeSandboxRuntime((job) =>
    isPrecheckJob(job) ? captureFor(shape) : passCapture(),
  );
  const simulator = new IcarusSimulatorAdapter(new SandboxToolRunner(runtime));
  const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
  const loop = new VerificationLoop({
    gate: new AdmittingGate(confirmedContext(spec)),
    generator: new OneShotGenerator(candidateFor(spec)),
    testbench,
    simulator,
    recorder,
    trustLabeler: oracleTrustLabeler,
  });
  await loop.verify(REQUEST, generousBudget(), LIMITS);
}

describe(PROPERTY, () => {
  it('fires exactly once on testbench-build-failed, and zero times on every other outcome', async () => {
    const seen = new Set<CaptureShape>();
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...CAPTURE_SHAPES), async (shape) => {
        seen.add(shape);
        const spec = approvedSpec();
        const testbench = new CountingTestbench(testbenchFor(spec), [
          {
            status: 'generated',
            checkingApproach: 'cycle-timed',
            testbench: testbenchFor(spec),
            checks: [],
          },
        ]);

        await runTrajectory(shape, testbench);

        if (shape === 'testbench-build-failed') {
          expect(testbench.repairCalls).toBe(1);
        } else {
          expect(testbench.repairCalls).toBe(0);
        }
      }),
      propertyParameters({ numRuns: 100 }),
    );
    // Non-vacuity: every real PrecheckOutcome-producing shape was actually drawn, the
    // one firing shape included - not merely sampled by luck.
    for (const shape of CAPTURE_SHAPES) {
      expect(seen).toContain(shape);
    }
  });

  it('fires at most once even when the repair itself produces another build failure', async () => {
    // A repair that is accepted on draft but still fails ITS OWN re-check must finalize
    // rather than attempt a second repair call (the sibling of Property 5), so the bound
    // under test here - "at most once" - holds even on this harder trajectory.
    const spec = approvedSpec();
    const stillBroken = { ...testbenchFor(spec), source: 'module byte_reg_tb; still_broken' };
    const testbench = new CountingTestbench(testbenchFor(spec), [
      { status: 'generated', checkingApproach: 'cycle-timed', testbench: stillBroken, checks: [] },
    ]);

    const specForRun = spec;
    const runtime = new FakeSandboxRuntime((job) => {
      if (!isPrecheckJob(job)) {
        return passCapture();
      }
      // The precheck runs twice on this trajectory: once for the draft (fails), once for
      // the repaired source (also fails, since `stillBroken` is scripted to fail too).
      return testbenchBuildFailureCapture();
    });
    const simulator = new IcarusSimulatorAdapter(new SandboxToolRunner(runtime));
    const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
    const loop = new VerificationLoop({
      gate: new AdmittingGate(confirmedContext(specForRun)),
      generator: new OneShotGenerator(candidateFor(specForRun)),
      testbench,
      simulator,
      recorder,
      trustLabeler: oracleTrustLabeler,
    });

    await loop.verify(REQUEST, generousBudget(), LIMITS);

    expect(testbench.repairCalls).toBe(1);
  });
});
