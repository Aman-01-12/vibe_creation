// testbench-repair-loop, task 6.6, Property 4 (precheck half): A repaired testbench is
// re-checked by the identical rule a first draft is held to.
//
// `VerificationLoop#repairPrecheckFailure` re-checks a repaired testbench by calling
// `this.#precheck.run(revisedTestbenchFile, moduleInterface, limits)` - the SAME plain
// `TestbenchPrecheck.run` a first draft is checked with (`#admitInstrument`'s own first
// call), with no parameter distinguishing "repaired" from "generated". This asserts that
// parity directly: a `TestbenchPrecheck` built over the identical fake Simulator produces
// the IDENTICAL `PrecheckOutcome` whether a source string is checked as a bare "first
// draft" or routed through the loop's repair-and-recheck path for the SAME source, over a
// generated set of sources (some that pass, some that fail the precheck).
//
// Validates: Requirements 3.1, 3.2, 3.3, 3.5, 3.6

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
  TestbenchPrecheck,
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
  type PrecheckOutcome,
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
  'testbench-repair-loop, Property 4 (precheck half): A repaired testbench is re-checked by the identical rule a first draft is held to';

const LIMITS = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5_000 } as const;
const REQUEST = {} as unknown as GenerationAdmissionRequest;

/** The precheck's interface-stub filename (`INTERFACE_STUB_MODULE` in testbench-precheck.ts). */
const PRECHECK_STUB_PATH = 'testbench_precheck_stub.v';

/** Whether a sandbox job is the precheck's own build check, not a real iteration. */
function isPrecheckJob(job: SandboxJob): boolean {
  return job.workspaceFiles.some((file) => file.path === PRECHECK_STUB_PATH);
}

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

/** A fixed-draft testbench port whose ONE repair always revises to `revisedSource`. */
class FixedRepairTestbench implements IndependentTestbenchGenerator {
  readonly #draft: Testbench;
  readonly #revised: Testbench;
  constructor(draft: Testbench, revised: Testbench) {
    this.#draft = draft;
    this.#revised = revised;
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
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve({
      status: 'generated',
      checkingApproach: 'cycle-timed',
      testbench: this.#revised,
      checks: [],
    });
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

/**
 * A generated source string: one of a legal-looking build (passes the precheck) or a
 * syntax-broken one (fails it), each shaped to also drive the precheck's build check
 * through the FakeSandboxRuntime below by whether the submitted testbench's CONTENTS
 * contain the sentinel `BROKEN`.
 */
const sourceArbitrary: fc.Arbitrary<{ readonly source: string; readonly passesPrecheck: boolean }> =
  fc.boolean().map((broken) => ({
    source: broken ? 'module byte_reg_tb; BROKEN syntax' : 'module byte_reg_tb; endmodule',
    passesPrecheck: !broken,
  }));

describe(PROPERTY, () => {
  it('agrees with a bare first-draft precheck on the identical source, over generated sources', async () => {
    let sawPassing = false;
    let sawFailing = false;
    await fc.assert(
      fc.asyncProperty(sourceArbitrary, async ({ source }) => {
        const spec = approvedSpec();

        // (A) The "first draft" height: TestbenchPrecheck.run called directly on `source`,
        // over a fake sandbox whose outcome is keyed off the BROKEN sentinel.
        const firstDraftRuntime = new FakeSandboxRuntime((job) => {
          if (!isPrecheckJob(job)) return passCapture();
          const broken = job.workspaceFiles.some((file) => file.contents.includes('BROKEN'));
          return broken ? buildFailureCapture('byte_reg_tb.v') : passCapture();
        });
        const firstDraftSimulator = new IcarusSimulatorAdapter(
          new SandboxToolRunner(firstDraftRuntime),
        );
        const firstDraftPrecheck = new TestbenchPrecheck(firstDraftSimulator);
        const firstDraftOutcome: PrecheckOutcome = await firstDraftPrecheck.run(
          { path: 'byte_reg_tb.v', contents: source },
          spec.moduleInterface,
          LIMITS,
        );

        // (B) The "repaired" height: the SAME source, reached only through the loop's
        // repair-and-recheck path. The draft is a build failure (so the repair fires at
        // all); the repair revises to `source`, the identical string.
        const draft = testbenchFor(spec, 'module byte_reg_tb; FIRST_DRAFT_ALWAYS_BROKEN');
        const revised = testbenchFor(spec, source);
        const loopRuntime = new FakeSandboxRuntime((job) => {
          if (!isPrecheckJob(job)) return passCapture();
          const broken = job.workspaceFiles.some((file) => file.contents.includes('BROKEN'));
          return broken ? buildFailureCapture('byte_reg_tb.v') : passCapture();
        });
        const loopSimulator = new IcarusSimulatorAdapter(new SandboxToolRunner(loopRuntime));
        const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
        const loop = new VerificationLoop({
          gate: new AdmittingGate(confirmedContext(spec)),
          generator: new OneShotGenerator(candidateFor(spec)),
          testbench: new FixedRepairTestbench(draft, revised),
          simulator: loopSimulator,
          recorder,
          trustLabeler: oracleTrustLabeler,
        });

        const outcome = await loop.verify(REQUEST, generousBudget(), LIMITS);

        // The loop's own re-check outcome is observable through the terminal result: a
        // `recheck-failed` decline reports `instrument-refused` with `repairProvenance:
        // { attempted: true, accepted: false }`; an accepted repair reports a verified or
        // unverified terminal outcome with `accepted: true`.
        const loopAcceptedRevision =
          outcome.status === 'instrument-refused'
            ? outcome.repairProvenance.accepted
            : (outcome.status === 'verified' || outcome.status === 'unverified') &&
              outcome.repairProvenance.accepted;

        // PARITY: the loop accepted the revision (recheck passed) if and only if the bare
        // first-draft precheck of the IDENTICAL source also did not report a build failure.
        expect(loopAcceptedRevision).toBe(firstDraftOutcome !== 'testbench-build-failed');

        if (firstDraftOutcome === 'testbench-build-failed') sawFailing = true;
        else sawPassing = true;
      }),
      propertyParameters({ numRuns: 100 }),
    );
    // Non-vacuity: both the passing and the failing shape were actually drawn.
    expect(sawPassing).toBe(true);
    expect(sawFailing).toBe(true);
  });
});
