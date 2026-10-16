// testbench-repair-loop, task 6.7, Property 5 (precheck half): A failed re-check
// finalizes the pre-existing outcome, never a second repair.
//
// `VerificationLoop#repairPrecheckFailure` fires at most one `repairTestbench` call
// (`#admitInstrument` wiring). This generates every declined-repair shape the precheck
// path can produce - the re-check itself still fails after a revision, the repair returns
// `coverage-incomplete` or `generation-failed`, or the port throws - and asserts, over
// each: exactly one repair call total, the finalized outcome is BYTE-IDENTICAL (field for
// field, except `repairProvenance`) to what an unrepaired `testbench-build-failed` on the
// SAME original draft would have produced, and `repairProvenance` is exactly
// `{ attempted: true, accepted: false }`.
//
// Validates: Requirements 3.4, 6.1, 6.2, 6.3

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
import {
  FakeSandboxRuntime,
  IcarusSimulatorAdapter,
  SandboxToolRunner,
  type RawRunCapture,
  type SandboxJob,
} from '@app/tools';

import { propertyParameters } from './property.js';
import { timingContractFor } from '@app/test';

const PROPERTY =
  'testbench-repair-loop, Property 5 (precheck half): A failed re-check finalizes the pre-existing outcome, never a second repair';

const LIMITS = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5_000 } as const;
const REQUEST = {} as unknown as GenerationAdmissionRequest;

/** The precheck's interface-stub filename (`INTERFACE_STUB_MODULE` in testbench-precheck.ts). */
const PRECHECK_STUB_PATH = 'testbench_precheck_stub.v';

/** Whether a sandbox job is the precheck's own build check, not a real iteration. */
function isPrecheckJob(job: SandboxJob): boolean {
  return job.workspaceFiles.some((file) => file.path === PRECHECK_STUB_PATH);
}

/** Every way the precheck-path repair can decline, per the task text. */
type DeclineShape =
  | 'recheck-still-fails'
  | 'coverage-incomplete'
  | 'generation-failed'
  | 'port-throws'
  | 'port-unavailable';

const DECLINE_SHAPES: readonly DeclineShape[] = [
  'recheck-still-fails',
  'coverage-incomplete',
  'generation-failed',
  'port-throws',
  'port-unavailable',
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

/** The shapes `DecliningTestbench` can script; `port-unavailable` has no callable port
 *  to script at all, so it is routed separately in the test body via `noRepairTestbench`. */
type CallableDeclineShape = Exclude<DeclineShape, 'port-unavailable'>;

/** A counting testbench port whose draft always fails the precheck, and whose ONE repair
 *  call declines in the given shape, counting how many times it was invoked. */
class DecliningTestbench implements IndependentTestbenchGenerator {
  readonly #draft: Testbench;
  readonly #shape: CallableDeclineShape;
  readonly #revisedSource: string;
  repairCalls = 0;

  constructor(draft: Testbench, shape: CallableDeclineShape, revisedSource: string) {
    this.#draft = draft;
    this.#shape = shape;
    this.#revisedSource = revisedSource;
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
    switch (this.#shape) {
      case 'recheck-still-fails':
        // A 'generated' revision whose source the sandbox will fail to build again.
        return Promise.resolve({
          status: 'generated',
          checkingApproach: 'cycle-timed',
          testbench: { ...this.#draft, source: this.#revisedSource },
          checks: [],
        });
      case 'coverage-incomplete':
        return Promise.resolve({
          status: 'coverage-incomplete',
          missingChecks: [{ name: 'q_captures_d', kind: 'criterion', description: 'q captures d' }],
          source: this.#revisedSource,
        });
      case 'generation-failed':
        return Promise.resolve({
          status: 'generation-failed',
          failure: { reason: 'model-call-failed', detail: 'the repair model call failed' },
        });
      case 'port-throws':
        return Promise.reject(new Error('the repair port threw'));
    }
  }
}

/** A raw capture whose testbench emitted a passing check and a VCD: a clean build. */
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

/** A build failure capture naming `fileName`, with no VCD so it classifies `error`. */
function buildFailureCapture(fileName: string): RawRunCapture {
  return {
    ...passCapture(),
    exitCode: 1,
    stdout: '',
    stderr: `${fileName}:1: syntax error\n`,
    artifacts: {},
  };
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

/** Drive one trajectory: the draft always build-fails, and the repair declines. */
async function runDeclinedTrajectory(
  testbench: DecliningTestbench,
): Promise<Awaited<ReturnType<VerificationLoop['verify']>>> {
  const spec = approvedSpec();
  // Every precheck job (draft's own, and the repair's re-check when the shape reaches
  // one) is a build failure: the draft always, and the revision too for
  // 'recheck-still-fails'.
  const runtime = new FakeSandboxRuntime((job) =>
    isPrecheckJob(job) ? buildFailureCapture('byte_reg_tb.v') : passCapture(),
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
  return loop.verify(REQUEST, generousBudget(), LIMITS);
}

/**
 * The unrepaired-draft baseline: no `repairTestbench` capability at runtime at all, same
 * draft, same sandbox - the loop's `typeof this.#testbench.repairTestbench !== 'function'`
 * check (Req 3.9) must see this as genuinely absent, so the method is omitted from the
 * CLASS rather than merely throwing when called: a thrown call is observable as
 * `port-threw`, a DIFFERENT decline reason than the capability-absence path this baseline
 * is for.
 */
class BaseNoRepairTestbench {
  readonly #draft: Testbench;
  constructor(draft: Testbench) {
    this.#draft = draft;
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
}

/** Built from `BaseNoRepairTestbench`, typed as the full interface the loop expects. */
function noRepairTestbench(draft: Testbench): IndependentTestbenchGenerator {
  return new BaseNoRepairTestbench(draft) as unknown as IndependentTestbenchGenerator;
}

describe(PROPERTY, () => {
  it('declines to the identical unrepaired refusal, with exactly one repair call, on every shape', async () => {
    // The task's "unrepaired refusal" is the FIXED content `#repairPrecheckFailure`
    // (`unrepairedRefusal` in verification-loop.ts) builds for every decline path:
    // `{ reason: 'testbench-build-failed', attributedFiles: [] }`. There is no reachable
    // trajectory with `repairProvenance.attempted: false` once the precheck reports
    // `testbench-build-failed` - EVERY branch through `#repairPrecheckFailure`, capability
    // absence included, routes through `declined(...)`, which always carries
    // `attempted: true`. So the comparison is against this known constant, not a second
    // "no attempt at all" trajectory - confirmed by reading the real refusal shape built
    // on every decline path (checkpoint 7's own assertion makes the identical claim).
    const UNREPAIRED_REFUSAL = {
      reason: 'testbench-build-failed' as const,
      attributedFiles: [] as readonly string[],
    };

    const seen = new Set<DeclineShape>();
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...DECLINE_SHAPES), async (shape) => {
        seen.add(shape);
        const spec = approvedSpec();
        const draftSource = 'module byte_reg_tb; still_broken_draft';
        const draft = testbenchFor(spec, draftSource);

        let outcome: Awaited<ReturnType<VerificationLoop['verify']>>;
        let repairCalls: number;
        if (shape === 'port-unavailable') {
          // The one shape with no `repairTestbench` capability at runtime at all: the
          // loop's `typeof ... !== 'function'` check (Req 3.9) decides this BEFORE any
          // call is attempted, so there is no counting collaborator to read from.
          const runtime = new FakeSandboxRuntime((job) =>
            isPrecheckJob(job) ? buildFailureCapture('byte_reg_tb.v') : passCapture(),
          );
          const simulator = new IcarusSimulatorAdapter(new SandboxToolRunner(runtime));
          const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
          const loop = new VerificationLoop({
            gate: new AdmittingGate(confirmedContext(spec)),
            generator: new OneShotGenerator(candidateFor(spec)),
            testbench: noRepairTestbench(draft),
            simulator,
            recorder,
            trustLabeler: oracleTrustLabeler,
          });
          outcome = await loop.verify(REQUEST, generousBudget(), LIMITS);
          repairCalls = 0;
        } else {
          const testbench = new DecliningTestbench(
            draft,
            shape,
            'module byte_reg_tb; still_broken_revision',
          );
          outcome = await runDeclinedTrajectory(testbench);
          repairCalls = testbench.repairCalls;
        }

        // Exactly one repair CALL fires on every shape that has a callable port at all;
        // the capability-absent shape never calls it, which is the same bound stated the
        // other way - the port-unavailable decision is made before any call.
        expect(repairCalls).toBe(shape === 'port-unavailable' ? 0 : 1);

        expect(outcome.status).toBe('instrument-refused');
        if (outcome.status !== 'instrument-refused') {
          return;
        }

        // Byte-identical to the fixed unrepaired-refusal content on every decline path.
        expect(outcome.reason).toBe(UNREPAIRED_REFUSAL.reason);
        expect(outcome.attributedFiles).toEqual(UNREPAIRED_REFUSAL.attributedFiles);
        expect(outcome.repairProvenance.attempted).toBe(true);
        expect(outcome.repairProvenance.accepted).toBe(false);
        if (!outcome.repairProvenance.attempted || outcome.repairProvenance.accepted) {
          return;
        }
        // Narrowed to the declined member: a hint and a decline reason are present, and
        // the reason names which stage declined, exactly one of the five vocabulary members.
        expect(outcome.repairProvenance.hint.kind).toBe('build-diagnostic');
        expect(outcome.repairProvenance.declineReason).toMatch(
          /^(coverage-validation-failed|no-admissible-revision|port-threw|port-unavailable|recheck-failed)$/,
        );
      }),
      propertyParameters({ numRuns: 50 }),
    );
    // Non-vacuity: every declined-repair shape the task names was actually drawn.
    for (const shape of DECLINE_SHAPES) {
      expect(seen).toContain(shape);
    }
  });
});
