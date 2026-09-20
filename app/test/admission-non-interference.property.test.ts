// instrument-precheck-and-attribution, Property 7: The only difference an
// admission port can make is a refusal (task 4.3).
//
// `VerificationLoop.#admitInstrument` (`app/agent/orchestrator/verification-loop.ts`)
// consults the optional `instrumentAdmission` port at most once per run, only
// after the unconditional Testbench_Precheck reports `undecided` (i.e. did not
// attribute a build failure to the Testbench). Every branch other
// than `inadmissible` - `admissible`, `undecided`, and a thrown `admit` call - is
// documented to proceed to the first iteration exactly as the loop would with no
// port wired at all (Req 4.5, 4.7, 4.8, 4.9). This property drives the SAME setup
// (spec, candidate, testbench, a precheck that always builds clean) through TWO
// loop instances that differ only in whether an `instrumentAdmission` port is
// wired, and asserts the design's own statement of Property 7 directly: for any
// decision, the ported run yields either (a) the identical terminal outcome AND
// the identical consumed budget as the no-port run, or (b) `instrument-refused`
// at zero iterations - never a third thing.
//
// Design's own non-vacuity warning (`design.md`, "Design constraints and
// invariants"): "Property 7's budget claim must be asserted against a metered
// budget over a trajectory with at least one refusal AND one admission, or
// 'identical budget' is trivially true on an empty trajectory." This test uses
// `MeteredSessionBudget` (`app/eval/metered-budget.ts`) - the harness's own
// `consumed()`-exposing accountant - as the metered budget for both trajectories,
// and drives the property over a fixed, iterating (fail-then-pass) trajectory so
// each run always charges at least one real iteration before any admission
// decision could end it. The decision itself is generated over all four cases
// (`admissible`, `inadmissible`, `undecided`, throw) with `fc.constantFrom`, so
// the space is guaranteed - not merely possible - to include at least one
// refusal and at least one admission across the property's runs.
//
// This lives in `app/test/`, not beside `verification-loop.ts` in
// `app/agent/orchestrator/`, for the same import-boundary reason
// `repair-decision.property.test.ts` (Property 4) states: `@app/agent` may
// import only `core`, `knowledge`, and `tools` (Req 9.6, 9.7), and this property
// needs both `@app/test`'s `propertyParameters` and `@app/eval`'s
// `MeteredSessionBudget`, neither reachable from inside `@app/agent`.
//
// The Testbench_Precheck's own unconditional simulate call is recognized by
// CONTENT - the stub's own workspace path - never by call order
// (`gotcha-unconditional-precheck-call-shifts-order-dependent-fake-sequences.md`),
// so the fake sandbox never becomes order-dependent on the precheck's position.
// The tag string is a literal, not `propertyTag(...)`, because that helper's
// `FEATURE_TAG` is hardcoded to a different spec's numbering
// (`gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// Validates: Requirements 4.3, 4.5, 4.6, 4.7, 4.8, 4.9, 4.16

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  TraceActionRecorder,
  InMemoryTracePersistence,
  VerificationLoop,
  type CandidateGenerator,
  type GenerationContextOpener,
  type IndependentTestbenchGenerator,
  type ConfirmedGenerationContext,
  type GenerationAdmissionRequest,
  type GenerateTestbenchRequest,
  type GenerationInput,
  type InstrumentAdmission,
  type InstrumentAdmissionDecision,
  type RepairTestbenchRequest,
  type VerificationOutcome,
} from '@app/agent';
import {
  newUlid,
  ok,
  oracleTrustLabeler,
  unverified,
  type ArtifactRef,
  type Spec,
  type Testbench,
} from '@app/core';
import { MeteredSessionBudget } from '@app/eval';
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
  'instrument-precheck-and-attribution, Property 7: The only difference an admission port ' +
  'can make is a refusal';

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

/** The shape `FixedGenerator` hands the loop; named so both trajectories share one type. */
type GeneratedCandidateStub = ReturnType<typeof candidateFor>;

/**
 * A generated candidate whose label carries a module-version ref, built ONCE per
 * property case and reused by both trajectories - so `moduleVersion.id` and the
 * label's `artifactRef` are shared identity, not two independently minted ULIDs
 * that would make the comparison below fail for a reason unrelated to admission.
 */
function candidateFor(spec: Spec, rtl: string) {
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
 * A testbench port that always returns the SAME already-built `generated`
 * outcome, charging budget. Fixed rather than freshly minted per call: the two
 * trajectories a property case drives must share one `testbench.id`, or the
 * comparison below would fail on an incidental identifier neither run's
 * admission decision could ever have influenced.
 */
class FixedTestbench implements IndependentTestbenchGenerator {
  readonly #outcome: { status: 'generated'; testbench: Testbench; checks: readonly [] };
  constructor(testbench: Testbench) {
    this.#outcome = { status: 'generated', testbench, checks: [] };
  }
  generateTestbench(
    _request: GenerateTestbenchRequest,
    budget: MeteredSessionBudget,
  ): Promise<{ status: 'generated'; testbench: Testbench; checks: readonly [] }> {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve(this.#outcome);
  }
  repairTestbench(
    _request: RepairTestbenchRequest,
    budget: MeteredSessionBudget,
  ): Promise<{
    status: 'generation-failed';
    failure: { reason: 'model-call-failed'; detail: string };
  }> {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve({
      status: 'generation-failed',
      failure: { reason: 'model-call-failed', detail: 'FixedTestbench never repairs' },
    });
  }
}

/** The single Testbench shared by both trajectories a property case drives. */
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

/**
 * A generation port that always yields the SAME already-built first candidate
 * then the SAME already-built revision on every repair - fully deterministic
 * across the two trajectories a property case drives, so nothing but the
 * admission decision itself can make the two runs diverge.
 */
class FixedGenerator implements CandidateGenerator {
  readonly #first: GeneratedCandidateStub;
  readonly #revised: GeneratedCandidateStub;
  constructor(first: GeneratedCandidateStub, revised: GeneratedCandidateStub) {
    this.#first = first;
    this.#revised = revised;
  }
  generateCandidate(_input: GenerationInput, budget: MeteredSessionBudget) {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve(ok({ candidate: this.#first, interfaceDiagnostics: '' }));
  }
  reviseFromErrors(
    _input: GenerationInput,
    _previousRtl: string,
    _diagnostics: string,
    budget: MeteredSessionBudget,
  ) {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve(ok({ candidate: this.#revised, interfaceDiagnostics: '' }));
  }
}

/** An Instrument_Admission port that resolves or throws one scripted decision. */
class ScriptedAdmission implements InstrumentAdmission {
  constructor(private readonly scripted: ScriptedDecision) {}
  admit(): Promise<InstrumentAdmissionDecision> {
    if (this.scripted.kind === 'throw') {
      return Promise.reject(new Error('admission check fell over'));
    }
    return Promise.resolve(this.scripted.decision);
  }
}

/** Open a fresh metered budget, generous enough that no repair is budget-starved. */
function generousBudget(): MeteredSessionBudget {
  return new MeteredSessionBudget({
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

/** Whether a sandbox job is the Testbench_Precheck's own build check, not an iteration. */
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

/** A raw iteration capture that fails the check but still produces a VCD (never a refusal). */
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

/** A raw iteration capture that passes the check and produces a VCD. */
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
    artifacts: { vcd: { name: 'dump.vcd', sizeBytes: 8, sha256: 'c'.repeat(64) } },
    deniedOperations: [],
    resourceUsage: { wallMs: 11, maxMemMb: 8, cpuMs: 9 },
  };
}

/**
 * A fixed fail-then-pass iteration trajectory: iteration 1 fails (never a
 * build-failed refusal), iteration 2 passes. Content-derived, not order-derived
 * (the precheck job is recognized separately by its own stub path), so this is
 * exactly one real, non-vacuous repair cycle every case in this property drives -
 * the minimal shape that makes "identical consumed budget" a claim over a
 * trajectory that actually charged something, per the design's own warning.
 */
function makeCaptures(): (job: SandboxJob) => RawRunCapture {
  let realCalls = 0;
  return (job) => {
    if (isPrecheckJob(job)) {
      return precheckPassCapture();
    }
    realCalls += 1;
    return realCalls === 1 ? failCapture() : passCapture();
  };
}

/** The fixed, shared inputs one property case builds once and drives through both trajectories. */
interface SharedFixture {
  readonly spec: Spec;
  readonly testbench: Testbench;
  readonly firstCandidate: GeneratedCandidateStub;
  readonly revisedCandidate: GeneratedCandidateStub;
}

function sharedFixture(): SharedFixture {
  const spec = approvedSpec();
  return {
    spec,
    testbench: testbenchFor(spec),
    firstCandidate: candidateFor(spec, 'module byte_reg; // v1'),
    revisedCandidate: candidateFor(spec, 'module byte_reg; // v2'),
  };
}

/**
 * Assemble a loop over a fresh fail-then-pass trajectory and the given admission
 * port, from a `SharedFixture` both trajectories in one property case reuse
 * as-is - only the admission port (and each run's OWN budget/recorder/sandbox,
 * which are never part of the comparison) differs between the two calls.
 */
function makeLoop(
  fixture: SharedFixture,
  instrumentAdmission: InstrumentAdmission | undefined,
): VerificationLoop {
  const runtime = new FakeSandboxRuntime(makeCaptures());
  const simulator = new IcarusSimulatorAdapter(new SandboxToolRunner(runtime));
  const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
  return new VerificationLoop({
    gate: new AdmittingGate(confirmedContext(fixture.spec)),
    generator: new FixedGenerator(fixture.firstCandidate, fixture.revisedCandidate),
    testbench: new FixedTestbench(fixture.testbench),
    simulator,
    recorder,
    trustLabeler: oracleTrustLabeler,
    ...(instrumentAdmission === undefined ? {} : { instrumentAdmission }),
  });
}

/** How the scripted admission port resolves for one generated property case. */
type ScriptedDecision =
  | { readonly kind: 'resolve'; readonly decision: InstrumentAdmissionDecision }
  | { readonly kind: 'throw' };

/**
 * Every generated admission case: the three decisions the port can resolve with,
 * plus a throw. `fc.constantFrom` over this closed, exhaustive list is what makes
 * the property's own generated space GUARANTEE at least one `inadmissible`
 * (refusal) and at least one non-`inadmissible` (admission) case across its runs,
 * rather than merely making both possible.
 */
const SCRIPTED_DECISIONS: readonly ScriptedDecision[] = [
  { kind: 'resolve', decision: 'admissible' },
  { kind: 'resolve', decision: 'inadmissible' },
  { kind: 'resolve', decision: 'undecided' },
  { kind: 'throw' },
];

/**
 * A terminal outcome stripped of the fields two independently-run loops can never
 * share by construction, so the comparison asserts what Property 7 actually claims
 * (the SAME oracle-observable outcome) without failing on incidental identity.
 *
 * `result.id` (both statuses) and `oracleSpanId`/`result.oracleSpanId` (verified)
 * are minted per-run - a fresh Trace span, a fresh `newUlid()` - so two
 * independently executed but behaviourally identical runs never share them even
 * when nothing about admission changed anything. Every other field (verdict,
 * iterations, checks, failingCase, stopReason, candidate RTL, label tier) comes
 * from the fixed trajectory itself and is compared as-is.
 */
function comparableOutcome(outcome: VerificationOutcome): unknown {
  if (outcome.status !== 'verified' && outcome.status !== 'unverified') {
    return outcome;
  }
  const comparableResult = objectWithout(outcome.result, ['id', 'oracleSpanId']);
  if (outcome.status === 'unverified') {
    return { ...outcome, result: comparableResult };
  }
  // `label.oracleSpanRef` (Verified only) is the same per-run minted Trace span id
  // as `oracleSpanId` above - a fresh id for a behaviourally identical run.
  const comparableLabel = objectWithout(outcome.label, ['oracleSpanRef']);
  return {
    ...objectWithout(outcome, ['oracleSpanId']),
    label: comparableLabel,
    result: comparableResult,
  };
}

/** A shallow copy of `value` with the named keys removed, without binding an unused local. */
function objectWithout<T extends object, K extends keyof T>(
  value: T,
  keys: readonly K[],
): Omit<T, K> {
  const excluded = new Set<PropertyKey>(keys);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.has(key))) as Omit<
    T,
    K
  >;
}

describe(PROPERTY, () => {
  it(
    'yields the identical outcome and consumed budget, or an instrument-refused ' +
      'outcome at zero iterations, and never a third thing',
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.constantFrom(...SCRIPTED_DECISIONS), async (scripted) => {
          const fixture = sharedFixture();

          const noPortBudget = generousBudget();
          const noPortLoop = makeLoop(fixture, undefined);
          const noPortOutcome = await noPortLoop.verify(REQUEST, noPortBudget, LIMITS);

          const portedBudget = generousBudget();
          const portedLoop = makeLoop(fixture, new ScriptedAdmission(scripted));
          const portedOutcome = await portedLoop.verify(REQUEST, portedBudget, LIMITS);

          // The no-port trajectory is never itself a refusal: it is the control
          // trajectory the ported run is compared against, and it must exercise a
          // real repair iteration (fail then pass) for the budget comparison below
          // to be over a non-empty trajectory.
          expect(noPortOutcome.status).not.toBe('instrument-refused');

          if (scripted.kind === 'resolve' && scripted.decision === 'inadmissible') {
            // The refusing branch (Req 4.6): zero iterations, and the no-port run
            // still proceeded normally - the divergence this property exists to
            // permit, and the only one it permits.
            expect(portedOutcome.status).toBe('instrument-refused');
            if (portedOutcome.status === 'instrument-refused') {
              // `InstrumentRefusedModule` carries no `iterations` field at all -
              // zero iterations is structural (Req 4.6: "without running an
              // iteration"), not a counted value - so the absence itself is the
              // assertion, over and above the reason it refused for.
              expect(portedOutcome).not.toHaveProperty('iterations');
              expect(portedOutcome.reason).toBe('instrument-inadmissible');
            }
            return;
          }

          // Every other decision - admissible, undecided, or a thrown admit call -
          // proceeds exactly as the no-port run did (Req 4.5, 4.7, 4.8, 4.9): the
          // identical terminal outcome and the identical consumed budget.
          expect(comparableOutcome(portedOutcome)).toEqual(comparableOutcome(noPortOutcome));
          expect(portedBudget.consumed()).toEqual(noPortBudget.consumed());
        }),
        propertyParameters(),
      );
    },
  );
});
