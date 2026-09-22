// testbench-repair-loop, Property 7: Repair_Provenance is exactly
// `{attempted, accepted}` and nothing else moves with it (task 2.2).
//
// This uses a LITERAL tag string, never `propertyTag()` - `app/test/property.ts`'s
// `FEATURE_TAG` is hardcoded to `hdl-creation-loop`
// (`gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`), so a
// second spec's own numbered property must not call it. `propertyParameters()` is
// still used, since the 100+-iteration convention is shared and feature-agnostic.
//
// UPDATED for task 6.4 (the precheck-path wiring landed in
// `VerificationLoop#admitInstrument`): a `testbench-build-failed` precheck now
// attempts ONE `repairTestbench` call before refusing, so that trajectory's
// terminal outcome no longer carries the never-wired-in `NO_REPAIR` baseline.
// This test's `ScriptedTestbench.repairTestbench` always declines
// (`generation-failed`), so the `testbench-build-failed` trajectory now asserts
// `{ attempted: true, accepted: false }` - the repair was attempted and declined,
// never accepted - while the other two trajectories (which never reach a precheck
// build failure) still assert `NO_REPAIR` exactly, unaffected by task 6.4 landing.
// Task 8.3 (the positive-control-path wiring) has not landed yet, so this test
// still asserts nothing about that trigger point.
//
// This test's remaining scope:
//
//   1. For a pass or a fail-to-exhaustion trajectory (neither of which reaches a
//      precheck build failure), the terminal outcome's `repairProvenance` is
//      `NO_REPAIR` exactly - identical to what it would be had the precheck-path
//      repair capability never been wired in, because this trajectory set never
//      exercises that trigger point.
//   2. For the `testbench-build-failed` trajectory, the terminal outcome's
//      `repairProvenance` is exactly `{ attempted: true, accepted: false }` -
//      the ONE repair attempt task 6.4 wires in, declined by this fixture's
//      always-fails `repairTestbench`, finalizing the identical
//      `InstrumentRefusedModule` an unrepaired failure would have produced.
//   3. The structural half of the property that holds regardless of what task 8.3
//      later adds - `accepted` implies `attempted` - is checked directly against
//      arbitrary `RepairProvenance`-shaped values, not derived from a loop run.
//
// Once task 8.3 (positive-control-path repair) lands, this test needs a FOURTH
// arm: drive a trajectory that reaches a positive-control repair attempt and
// assert the oracle verdict / golden verdict / Recorded_Instrument_Verdict a
// `NO_REPAIR` baseline would have produced are unaffected by the mere fact that a
// repair was attempted elsewhere in the same run - the comparison design.md
// actually states. That comparison is not reachable yet, so it is not attempted
// here.
//
// Validates: Requirements 4.1, 4.2, 4.3, 4.4, 6.6

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  InMemorySessionBudgetHandle,
  NO_REPAIR,
  repairAccepted,
  repairDeclined,
  TraceActionRecorder,
  InMemoryTracePersistence,
  VerificationLoop,
  type BuildDiagnosticHint,
  type CandidateGenerator,
  type GenerationContextOpener,
  type IndependentTestbenchGenerator,
  type ConfirmedGenerationContext,
  type GenerationAdmissionRequest,
  type RepairDeclineReason,
  type RepairProvenance,
  type RepairTestbenchRequest,
} from '@app/agent';
import {
  newUlid,
  ok,
  oracleTrustLabeler,
  unverified,
  type ArtifactRef,
  type Result,
  type Spec,
} from '@app/core';
import {
  FakeSandboxRuntime,
  IcarusSimulatorAdapter,
  SandboxToolRunner,
  type RawRunCapture,
  type ResourceLimits,
  type SandboxJob,
} from '@app/tools';
import { propertyParameters } from './property.js';

const PROPERTY =
  'testbench-repair-loop, Property 7: Repair_Provenance is exactly {attempted, accepted} and nothing else moves with it';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5000 };
const REQUEST = {} as unknown as GenerationAdmissionRequest;

/** The Testbench_Precheck's own stub filename; used to recognize its call by content. */
const PRECHECK_STUB_PATH = 'testbench_precheck_stub.v';

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

/**
 * A testbench port that returns one scripted `generated` outcome, charging
 * budget. `repairTestbench` always declines (`generation-failed`): this
 * property's own content (see the header comment) is scoped to asserting
 * `NO_REPAIR` propagates unchanged through the trajectories that never reach a
 * repair attempt, so a testbench that never repairs keeps that scope exact -
 * task 6.4's own repair-acceptance behaviour is covered by
 * `verification-loop.test.ts`'s dedicated repair-branch assertions instead.
 */
class ScriptedTestbench implements IndependentTestbenchGenerator {
  readonly #spec: Spec;
  constructor(spec: Spec) {
    this.#spec = spec;
  }
  generateTestbench(_request: unknown, budget: InMemorySessionBudgetHandle) {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve({
      status: 'generated' as const,
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

/** A generation port producing one fixed candidate and, when scripted, one revision. */
class ScriptedGenerator implements CandidateGenerator {
  readonly #first: ReturnType<typeof candidateFor>;
  #revised = false;
  constructor(spec: Spec) {
    this.#first = candidateFor(spec);
  }
  generateCandidate(_input: unknown, budget: InMemorySessionBudgetHandle) {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve(ok({ candidate: this.#first, interfaceDiagnostics: '' }));
  }
  reviseFromErrors(
    _input: unknown,
    _previousRtl: string,
    _diagnostics: string,
    budget: InMemorySessionBudgetHandle,
  ): Promise<
    Result<
      { candidate: ReturnType<typeof candidateFor>; interfaceDiagnostics: string },
      { reason: 'model-unavailable'; detail: string }
    >
  > {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    this.#revised = true;
    return Promise.resolve(ok({ candidate: this.#first, interfaceDiagnostics: '' }));
  }
  get revised(): boolean {
    return this.#revised;
  }
}

/** Open an in-memory budget handle with the given iteration cap and generous other caps. */
function budgetWithIterations(maxIterations: number): InMemorySessionBudgetHandle {
  return new InMemorySessionBudgetHandle({
    sessionId: newUlid(),
    maxIterations,
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

const BASE_CAPTURE = {
  timedOut: false,
  infraFailure: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  diskLimitExceeded: false,
  deniedOperations: [],
  resourceUsage: { wallMs: 1, maxMemMb: 8, cpuMs: 1 },
} as const;

/** A raw capture the precheck always sees: builds clean, so it never itself refuses. */
function precheckPassCapture(): RawRunCapture {
  return {
    ...BASE_CAPTURE,
    exitCode: 0,
    stdout: '',
    stderr: '',
    artifacts: { vcd: { name: 'dump.vcd', sizeBytes: 8, sha256: 'a'.repeat(64) } },
  };
}

/** A raw capture whose testbench emitted a passing check and a VCD. */
function passCapture(): RawRunCapture {
  return {
    ...BASE_CAPTURE,
    exitCode: 0,
    stdout: 'CHECK q_captures_d PASS\n',
    stderr: '',
    artifacts: { vcd: { name: 'dump.vcd', sizeBytes: 8, sha256: 'b'.repeat(64) } },
  };
}

/** A raw capture whose testbench emitted a failing check but still produced a VCD. */
function failCapture(): RawRunCapture {
  return {
    ...BASE_CAPTURE,
    exitCode: 0,
    stdout: 'CHECK q_captures_d FAIL\n',
    stderr: '',
    artifacts: { vcd: { name: 'dump.vcd', sizeBytes: 8, sha256: 'c'.repeat(64) } },
  };
}

/** A raw capture whose stderr names the testbench's own path, so the loop refuses it. */
function testbenchBuildFailedCapture(testbenchPath: string): RawRunCapture {
  return {
    ...BASE_CAPTURE,
    exitCode: 1,
    stdout: '',
    stderr: `${testbenchPath}:1: syntax error`,
    artifacts: {},
  };
}

/** Assemble a loop over the given fakes and a real sandbox-backed Simulator. */
function makeLoop(
  spec: Spec,
  generator: CandidateGenerator,
  captures: (job: SandboxJob) => RawRunCapture,
): VerificationLoop {
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

/** A stand-in hint for the structural-half property below; its content is not asserted. */
const BUILD_DIAGNOSTIC_HINT: BuildDiagnosticHint = {
  kind: 'build-diagnostic',
  diagnostic: 'stand-in diagnostic for the structural property',
};

/** The three trajectory shapes this property drives, over pass / fail / build-failure. */
type Trajectory = 'pass-first-iteration' | 'fail-to-exhaustion' | 'testbench-build-failed';

/**
 * The `RepairProvenance` each trajectory's terminal outcome must carry, checked by
 * its narrowed discriminant fields rather than full-object equality: since task
 * 1.1 widened `RepairProvenance` into a discriminated union, the declined member
 * also carries a `hint` and a `declineReason` this fixture cannot predict without
 * duplicating `#repairPrecheckFailure`'s own diagnostic text. Only
 * `testbench-build-failed` reaches the precheck-path repair trigger task 6.4
 * wires in; the other two never attempt a repair at all.
 */
const EXPECTED_PROVENANCE: Readonly<Record<Trajectory, RepairProvenance>> = {
  'pass-first-iteration': NO_REPAIR,
  'fail-to-exhaustion': NO_REPAIR,
  'testbench-build-failed': repairDeclined(BUILD_DIAGNOSTIC_HINT, 'no-admissible-revision'),
};

describe(PROPERTY, () => {
  it("every terminal outcome carries the provenance its trajectory's trigger points imply", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<Trajectory>(
          'pass-first-iteration',
          'fail-to-exhaustion',
          'testbench-build-failed',
        ),
        async (trajectory) => {
          const spec = approvedSpec();
          const generator = new ScriptedGenerator(spec);
          const testbenchPath = `${spec.moduleInterface.moduleName}_tb.v`;

          const loop = makeLoop(spec, generator, (job) => {
            if (isPrecheckJob(job)) {
              return trajectory === 'testbench-build-failed'
                ? testbenchBuildFailedCapture(testbenchPath)
                : precheckPassCapture();
            }
            return trajectory === 'pass-first-iteration' ? passCapture() : failCapture();
          });

          // 2 iterations affordable for the exhaustion trajectory (setup already
          // spends 1, leaving no budget for a repair after the first fail), and
          // generous for the other two, which decide on iteration 1.
          const maxIterations = trajectory === 'fail-to-exhaustion' ? 2 : 20;
          const outcome = await loop.verify(REQUEST, budgetWithIterations(maxIterations), LIMITS);

          switch (trajectory) {
            case 'pass-first-iteration':
              expect(outcome.status).toBe('verified');
              break;
            case 'fail-to-exhaustion':
              expect(outcome.status).toBe('unverified');
              break;
            case 'testbench-build-failed':
              expect(outcome.status).toBe('instrument-refused');
              break;
          }

          // Every one of the three widened outcome shapes carries `repairProvenance`;
          // `VerificationBlocked` and `VerificationSetupFailed` never reach a
          // repairable point (task 2.1) and are not driven by this trajectory set.
          if (
            outcome.status === 'verified' ||
            outcome.status === 'unverified' ||
            outcome.status === 'instrument-refused'
          ) {
            // Task 6.4 wired the precheck-path repair trigger: a
            // `testbench-build-failed` precheck now attempts and (per this
            // fixture's always-declining `repairTestbench`) fails to repair,
            // while the other two trajectories never reach that trigger at all.
            // Compared by discriminant fields, not full-object equality: the
            // declined member also carries a `hint` this fixture does not predict.
            const expected = EXPECTED_PROVENANCE[trajectory];
            expect(outcome.repairProvenance.attempted).toBe(expected.attempted);
            expect(outcome.repairProvenance.accepted).toBe(expected.accepted);
            if (expected.attempted && !expected.accepted) {
              expect(outcome.repairProvenance).toMatchObject({
                attempted: true,
                accepted: false,
                declineReason: expected.declineReason,
              });
            }
          } else {
            throw new Error(`unexpected outcome status for this trajectory: ${outcome.status}`);
          }
        },
      ),
      propertyParameters(),
    );
  });

  it('accepted implies attempted, for every member of the RepairProvenance union (the permanent structural half)', () => {
    // Generated over the three ACTUAL union members (task 1.1), not over two raw
    // booleans: the widened type makes `accepted: true, attempted: false`
    // unrepresentable, so this property is now a fact a type checker already
    // enforces at every construction site. It stays here as a runtime check over
    // values built through the real constructors, rather than being deleted,
    // because a future loosening of the union (e.g. reintroducing a flat shape)
    // would still be caught here even though `tsc` would no longer catch it.
    const member = fc.oneof(
      fc.constant(NO_REPAIR),
      fc
        .constantFrom<RepairDeclineReason>(
          'no-admissible-revision',
          'coverage-validation-failed',
          'recheck-failed',
          'port-threw',
          'port-unavailable',
        )
        .map((reason) => repairDeclined(BUILD_DIAGNOSTIC_HINT, reason)),
      fc.constant(repairAccepted(BUILD_DIAGNOSTIC_HINT, 'module byte_reg_tb; endmodule')),
    );
    fc.assert(
      fc.property(member, (provenance) => {
        const impliesAttempted = !provenance.accepted || provenance.attempted;
        expect(impliesAttempted).toBe(true);
      }),
      propertyParameters(),
    );
  });
});
