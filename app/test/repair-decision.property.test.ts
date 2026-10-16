// instrument-precheck-and-attribution, Property 4: A testbench-only build
// failure never asks for an RTL repair (task 4.5).
//
// `VerificationLoop.#iterate` (`app/agent/orchestrator/verification-loop.ts`)
// calls the private `refusedByTestbenchBuild` predicate on every non-passing
// iteration verdict, AFTER the pass-check and the incomplete-evidence check
// but BEFORE the repair-budget check and before `reviseFromErrors` is ever
// invoked. When the predicate is true - `failureCause === 'build-failed'` AND
// `attributedFiles` holds the testbench path AND holds no RTL path - the loop
// returns `instrument-refused` instead of asking the generator to repair.
// `refusedByTestbenchBuild` itself is a private module-level function with no
// export, so this property drives it the only way a caller can: through
// `VerificationLoop.verify`, exactly as `verification-loop.test.ts` does.
//
// This lives in `app/test/`, not beside `verification-loop.ts` in
// `app/agent/orchestrator/`: `@app/agent` may import only `core`, `knowledge`,
// and `tools` (Req 9.6, 9.7), so a test that needs `@app/test`'s
// `propertyParameters` cannot live inside `app/agent` without an import-
// boundary violation in the wrong direction.
//
// This test states the property over the WHOLE iteration-verdict space, not
// just the refusing row: for any `build-failed` verdict attributing the
// testbench and no RTL, the loop refuses and never calls `reviseFromErrors`;
// and for any OTHER cause (including a `build-failed` verdict that also names
// the RTL path - a genuine RTL build failure, Req 2.8), the loop proceeds
// exactly as it did before this spec, which for a first-iteration failure
// means calling `reviseFromErrors` exactly once. Asserting that non-refusing
// branch too keeps the "never asks for an RTL repair" claim non-vacuous by
// construction - the same discipline `testbench-precheck-decision-table
// .property.test.ts` (Property 6) already applies to its own decision table
// (see `gotcha-golden-denominator-property-test-was-vacuous-for-new-status.md`).
//
// The precheck the loop runs unconditionally before the first iteration
// (`gotcha-unconditional-precheck-call-shifts-order-dependent-fake-sequences
// .md`) is answered separately, by CONTENT (the stub's own workspace path),
// so the generated verdict always lands on the real iteration-1 simulate
// call and the fake never becomes order-dependent on call order.
//
// Validates: Requirements 2.7, 2.8, 2.9

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  InMemorySessionBudgetHandle,
  TraceActionRecorder,
  InMemoryTracePersistence,
  VerificationLoop,
  type CandidateGenerator,
  type GenerationContextOpener,
  type IndependentTestbenchGenerator,
  type ConfirmedGenerationContext,
  type GenerationAdmissionRequest,
  type RepairTestbenchRequest,
} from '@app/agent';
import {
  newUlid,
  ok,
  oracleTrustLabeler,
  unverified,
  type ArtifactRef,
  type Spec,
} from '@app/core';
import {
  FakeSandboxRuntime,
  IcarusSimulatorAdapter,
  SandboxToolRunner,
  type RawRunCapture,
  type ResourceLimits,
  type RunFailureCause,
  type SandboxJob,
} from '@app/tools';
import { propertyParameters } from './property.js';
import { timingContractFor } from '@app/test';

const PROPERTY =
  'instrument-precheck-and-attribution, Property 4: A testbench-only build failure never asks for an RTL repair';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5000 };
const REQUEST = {} as unknown as GenerationAdmissionRequest;

/** The Testbench_Precheck's own stub filename; used to recognize its call by content. */
const PRECHECK_STUB_PATH = 'testbench_precheck_stub.v';

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
function candidateFor(spec: Spec) {
  const id = newUlid();
  const moduleVersion = {
    id,
    projectId: spec.projectId,
    specVersion: spec.version,
    rtl: 'module byte_reg; endmodule',
    createdAt: new Date(0).toISOString(),
  };
  const artifactRef: ArtifactRef = { kind: 'module-version', id, version: 1 };
  return {
    rtl: moduleVersion.rtl,
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
  openGenerationContext() {
    return Promise.resolve(ok(this.#context));
  }
}

/** A testbench port that returns one scripted `generated` outcome, charging budget. */
class ScriptedTestbench implements IndependentTestbenchGenerator {
  readonly #spec: Spec;
  constructor(spec: Spec) {
    this.#spec = spec;
  }
  generateTestbench(_request: unknown, budget: InMemorySessionBudgetHandle) {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve({
      status: 'generated' as const,
      checkingApproach: 'cycle-timed' as const,
      testbench: {
        id: newUlid(),
        specId: this.#spec.id,
        specVersion: this.#spec.version,
        source: 'module byte_reg_tb; endmodule',
        sourceAttribution: 'spec' as const,
        coversCriteria: this.#spec.acceptanceCriteria.map((c) => c.id),
      },
      checks: [],
    });
  }
  repairTestbench(_request: RepairTestbenchRequest, budget: InMemorySessionBudgetHandle) {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve({
      status: 'generation-failed' as const,
      failure: {
        reason: 'model-call-failed' as const,
        detail: 'ScriptedTestbench never repairs',
      },
    });
  }
}

/**
 * A generation port producing one fixed first candidate, recording every
 * `reviseFromErrors` call it receives. The property's central assertion reads
 * `reviseCalls.length`, so this spy - not a scripted response sequence - is
 * the point: it never needs to know how many iterations to script for.
 */
class SpyGenerator implements CandidateGenerator {
  readonly reviseCalls: { previousRtl: string; diagnostics: string }[] = [];
  readonly #first: ReturnType<typeof candidateFor>;
  constructor(spec: Spec) {
    this.#first = candidateFor(spec);
  }
  generateCandidate(_input: unknown, budget: InMemorySessionBudgetHandle) {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve(ok({ candidate: this.#first, interfaceDiagnostics: '' }));
  }
  reviseFromErrors(
    _input: unknown,
    previousRtl: string,
    diagnostics: string,
    budget: InMemorySessionBudgetHandle,
  ) {
    this.reviseCalls.push({ previousRtl, diagnostics });
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    // This property is decided on iteration 1 alone (setup + one simulate), so
    // this branch is never exercised; it still returns a well-typed refusal
    // rather than hang the loop if that assumption is ever wrong.
    return Promise.resolve({
      ok: false as const,
      error: { reason: 'model-unavailable' as const, detail: 'unused' },
    });
  }
}

/** Open an in-memory budget handle generous enough that no repair is budget-starved. */
function generousBudget(): InMemorySessionBudgetHandle {
  return new InMemorySessionBudgetHandle({
    sessionId: newUlid(),
    maxIterations: 20,
    maxTokens: 1_000_000,
    maxWallClockMs: 1_000_000,
    maxCostCents: 1_000_000,
    consumedIterations: 0,
    consumedTokens: 0,
    consumedMs: 0,
    consumedCostCents: 0,
  });
}

/** Whether a sandbox job is the Testbench_Precheck's own build check, not iteration 1. */
function isPrecheckJob(job: SandboxJob): boolean {
  return job.workspaceFiles.some((file) => file.path === PRECHECK_STUB_PATH);
}

/** A raw capture the precheck always sees: builds clean, so it never itself refuses. */
function precheckPassCapture(): RawRunCapture {
  return {
    timedOut: false,
    infraFailure: false,
    exitCode: 0,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts: { vcd: { name: 'dump.vcd', sizeBytes: 8, sha256: 'a'.repeat(64) } },
    deniedOperations: [],
    resourceUsage: { wallMs: 1, maxMemMb: 8, cpuMs: 1 },
  };
}

/**
 * A raw iteration-1 capture whose stderr names the given diagnostic line(s), so
 * the real `IcarusSimulatorAdapter` derives the requested `RunFailureCause` and
 * `attributedFiles` itself - the property exercises the real attribution seam,
 * not a hand-built `SimulationVerdict`.
 */
function iterationCapture(exitCode: number, stderrLines: readonly string[]): RawRunCapture {
  return {
    timedOut: false,
    infraFailure: false,
    exitCode,
    stdout: '',
    stderr: stderrLines.join('\n'),
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts: {},
    deniedOperations: [],
    resourceUsage: { wallMs: 1, maxMemMb: 8, cpuMs: 1 },
  };
}

/** A raw capture whose sandbox flags/exit code drive the given non-build-failed cause. */
function causeCapture(cause: RunFailureCause): RawRunCapture {
  switch (cause) {
    case 'timed-out':
      return { ...iterationCapture(1, []), timedOut: true };
    case 'disk-capped':
      return { ...iterationCapture(1, []), diskLimitExceeded: true };
    case 'output-incomplete':
      // Exits clean with no diagnostics and no VCD: an incomplete capture, not a
      // build defect (Req 1.12's own wording for the precheck; the loop's own
      // non-precheck branch shares the same classification).
      return { ...iterationCapture(0, []), artifacts: {} };
    case 'tool-failed':
      return { ...iterationCapture(1, []), infraFailure: true };
    case 'none':
    case 'build-failed':
      throw new Error(`causeCapture is only for the non-build-failed space, got ${cause}`);
  }
}

/** Assemble a loop over the given fakes and a real sandbox-backed Simulator. */
function makeLoop(
  spec: Spec,
  generator: SpyGenerator,
  captures: (job: SandboxJob) => RawRunCapture,
) {
  const runtime = new FakeSandboxRuntime((job) => captures(job));
  const simulator = new IcarusSimulatorAdapter(new SandboxToolRunner(runtime));
  const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
  return new VerificationLoop({
    gate: new AdmittingGate(confirmedContext(spec)),
    generator,
    testbench: new ScriptedTestbench(spec),
    simulator,
    recorder,
    trustLabeler: oracleTrustLabeler,
  });
}

/** Every `RunFailureCause` other than `build-failed` - the "leave it alone" space (Req 2.9). */
const NON_BUILD_FAILED_CAUSES: readonly RunFailureCause[] = [
  'timed-out',
  'disk-capped',
  'output-incomplete',
  'tool-failed',
];

describe(PROPERTY, () => {
  it('refuses and never repairs when build-failed attributes only the testbench', async () => {
    // Stderr names the testbench file's own workspace path (as the real Icarus
    // toolchain does: a workspace-relative name at a line number), never the RTL
    // path, so `classifyRunFailure` attributes only the testbench.
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 999 }),
        async (exitCode, line) => {
          const spec = approvedSpec();
          const generator = new SpyGenerator(spec);
          const testbenchPath = `${spec.moduleInterface.moduleName}_tb.v`;
          const loop = makeLoop(spec, generator, (job) =>
            isPrecheckJob(job)
              ? precheckPassCapture()
              : iterationCapture(exitCode, [`${testbenchPath}:${line}: syntax error`]),
          );

          const outcome = await loop.verify(REQUEST, generousBudget(), LIMITS);

          expect(outcome.status).toBe('instrument-refused');
          if (outcome.status === 'instrument-refused') {
            expect(outcome.reason).toBe('testbench-build-failed');
            expect(outcome.attributedFiles).toContain(testbenchPath);
            expect(outcome.attributedFiles).not.toContain(`${spec.moduleInterface.moduleName}.v`);
          }
          expect(generator.reviseCalls).toHaveLength(0);
        },
      ),
      propertyParameters(),
    );
  });

  it('proceeds to repair when the cause is anything other than build-failed', async () => {
    // Non-vacuity for the refusing branch above: any OTHER cause takes the exact
    // branch the loop took before attribution existed - a failing iteration 1
    // with budget remaining asks the generator to repair, exactly once.
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...NON_BUILD_FAILED_CAUSES), async (cause) => {
        const spec = approvedSpec();
        const generator = new SpyGenerator(spec);
        const capture = causeCapture(cause);
        const loop = makeLoop(spec, generator, (job) =>
          isPrecheckJob(job) ? precheckPassCapture() : capture,
        );

        const outcome = await loop.verify(REQUEST, generousBudget(), LIMITS);

        expect(outcome.status).not.toBe('instrument-refused');
        expect(generator.reviseCalls).toHaveLength(1);
      }),
      propertyParameters(),
    );
  });

  it('proceeds to repair when build-failed attributes the RTL file too (Req 2.8)', async () => {
    // A build-failed cause naming the RTL path is a genuine RTL build failure,
    // never a refusal - the predicate is membership, not exclusivity, so naming
    // the testbench ALONGSIDE the RTL must still repair.
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (alsoNameTestbench) => {
        const spec = approvedSpec();
        const generator = new SpyGenerator(spec);
        const rtlPath = `${spec.moduleInterface.moduleName}.v`;
        const testbenchPath = `${spec.moduleInterface.moduleName}_tb.v`;
        const stderrLines = alsoNameTestbench
          ? [`${rtlPath}:3: syntax error`, `${testbenchPath}:12: syntax error`]
          : [`${rtlPath}:3: syntax error`];
        const loop = makeLoop(spec, generator, (job) =>
          isPrecheckJob(job) ? precheckPassCapture() : iterationCapture(1, stderrLines),
        );

        const outcome = await loop.verify(REQUEST, generousBudget(), LIMITS);

        expect(outcome.status).not.toBe('instrument-refused');
        expect(generator.reviseCalls).toHaveLength(1);
      }),
      propertyParameters(),
    );
  });

  // Unit anchor: the real `adder_8bit_tb.v:49: syntax error` stderr line
  // measured in `tbslice-v1` (Requirements 2.7, 2.8, 2.9's own evidence).
  it('refuses and never repairs on the real adder_8bit_tb.v:49 syntax error', async () => {
    const spec = approvedSpec();
    const generator = new SpyGenerator(spec);
    const testbenchPath = `${spec.moduleInterface.moduleName}_tb.v`;
    const loop = makeLoop(spec, generator, (job) =>
      isPrecheckJob(job)
        ? precheckPassCapture()
        : iterationCapture(4, [`${testbenchPath}:49: syntax error`]),
    );

    const outcome = await loop.verify(REQUEST, generousBudget(), LIMITS);

    expect(outcome.status).toBe('instrument-refused');
    if (outcome.status === 'instrument-refused') {
      expect(outcome.reason).toBe('testbench-build-failed');
      expect(outcome.attributedFiles).toEqual([testbenchPath]);
    }
    expect(generator.reviseCalls).toHaveLength(0);
  });
});
