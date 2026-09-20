// Property 20: Editing a Verified module demotes it until re-verified (task 16.2).
//
// Canonical statement (design.md Property 20; Req 10.7, 10.5):
//   For any edit to a `Verified` module, the module is immediately labeled
//   `Unverified` and remains so until a fresh passing oracle verdict exists for
//   the changed version.
//
// THE DESIGN FACT THIS PINS DOWN. Demotion is by ABSENCE of provenance, not by a
// writable flag (iteration/diff.ts `demoteOnEdit`, iteration-agent.ts). Editing a
// module produces a NEW module version, and a new version has no recorded passing
// oracle span yet, so the core Trust_Labeler labels it `Unverified` automatically.
// The positive `Verified` label can only be re-earned when the Verification_Loop
// records a fresh passing oracle verdict for the CHANGED design, bound to that
// span. There is deliberately no `verified` boolean to clear.
//
// Three complementary properties, each deriving its expectation independently of
// the code under test:
//
//   Property 20.A (pure core). Over `demoteOnEdit` + the core `labelArtifact`:
//     the demotion is immediate and tier-agnostic (Verified/Unverified/
//     Not_Applicable all demote to `Unverified`), the edited (new) version is
//     `Unverified` precisely because no passing span exists for it, it stays
//     `Unverified` under fail/error evidence, and it becomes `Verified` bound to
//     the fresh span only once a passing verdict for the NEW version is recorded.
//
//   Property 20.B (through the Iteration_Agent, driven by the REAL Verification_
//     Loop over a fake Simulator - no real oracle). The streamed intermediate
//     ("demoting" and the transient "verifying") is shown under `Unverified`
//     regardless of the prior tier (Req 10.5, 10.7, 10.8), and the terminal module
//     is `Verified` if and only if the fake oracle produced a fresh pass for the
//     new version - in which case the `Verified` label genuinely comes from the
//     loop's oracle-derived Trust_Labeler, bound to the recorded oracle span.
//
//   Property 20.C (through the Iteration_Agent, scripted re-verification). For
//     every possible re-verification result (verified / unverified / blocked /
//     setup-failed), the module is presented as correct (`Verified`) if and only
//     if re-verification produced a fresh pass; every other result leaves it
//     `Unverified` or non-correct (Req 10.5). This closes the "does not produce a
//     pass" branches the oracle-driven loop cannot easily reach.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  isOk,
  labelArtifact,
  makeVerificationResult,
  newUlid,
  notApplicable,
  ok,
  unverified,
  verified,
  type ArtifactRef,
  type LabelingEvidence,
  type LabeledArtifact,
  type ModuleVersion,
  type Result,
  type SessionBudget,
  type Spec,
  type Testbench,
  type Ulid,
  type VerificationResult,
  type Verdict,
} from '@app/core';
import {
  FakeSandboxRuntime,
  IcarusSimulatorAdapter,
  SandboxToolRunner,
  type RawRunCapture,
  type ResourceLimits,
  type SimulatorAdapter,
} from '@app/tools';
import {
  ConfirmedGenerationContext,
  InMemorySessionBudgetHandle,
  InMemoryTracePersistence,
  IterationAgent,
  TraceActionRecorder,
  VerificationLoop,
  demoteOnEdit,
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
  type IntentSession,
  type IterationOutcome,
  type RepairTestbenchRequest,
  type IterationProgressEvent,
  type IterationReVerifier,
  type IterationRequest,
  type IterationSpecUpdater,
  type LastVerifiedState,
  type ReVerifyInput,
  type ReVerifyResult,
  type SessionBudgetHandle,
  type SpecChangeRequest,
  type SpecUpdateFailure,
  type TestbenchGenerationOutcome,
} from '@app/agent';
import { propertyParameters, propertyTag } from '@app/test';

const PROPERTY = propertyTag(20, 'Editing a Verified module demotes it until re-verified');

// -- ULID helpers -----------------------------------------------------------

/** Crockford base32, the ULID alphabet. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_LENGTH = 26;

/** A deterministic, valid 26-character ULID string built from fast-check. */
const validUlidArbitrary: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...CROCKFORD.split('')), {
    minLength: ULID_LENGTH,
    maxLength: ULID_LENGTH,
  })
  .map((chars) => chars.join(''));

/** A valid ULID guaranteed to differ from `base` (mutates one char). */
function differentUlid(base: string): string {
  const lastIndex = base.length - 1;
  const current = CROCKFORD.indexOf(base.charAt(lastIndex));
  const replacement = CROCKFORD.charAt((current + 1) % CROCKFORD.length);
  return `${base.slice(0, lastIndex)}${replacement}`;
}

// -- Verification-result + evidence helpers (Property 20.A) -----------------

/** Build a recorded `VerificationResult` for a verdict, or throw on setup error. */
function verificationResult(verdict: Verdict, oracleSpanId: Ulid): VerificationResult {
  const built = makeVerificationResult({
    id: newUlid(),
    moduleVersionId: newUlid(),
    testbenchId: newUlid(),
    verdict,
    allChecksPassed: verdict === 'pass',
    iterations: 1,
    costCents: 0,
    oracleSpanId,
  });
  if (!isOk(built)) {
    throw new Error(`test setup: could not build a ${verdict} VerificationResult`);
  }
  return built.value;
}

/** A recorded oracle-verdict evidence item for an exact artifact version. */
function evidenceFor(ref: ArtifactRef, verdict: Verdict, oracleSpanId: Ulid): LabelingEvidence {
  return { artifactRef: ref, result: verificationResult(verdict, oracleSpanId) };
}

// -- Fixtures shared by the Iteration_Agent properties (20.B, 20.C) ---------

const COUNTER_MODULE_NAME = 'counter';

/** The single spec-derived check name the fake testbench emits. */
const FAILING_CHECK = 'counts_up';

/** Generous caps for the in-memory fake sandbox. */
const LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };

/** An approved single-module Spec (its interface is held constant across the edit). */
function counterSpec(): Spec {
  return {
    id: newUlid(),
    projectId: newUlid(),
    goal: 'A 4-bit synchronous up-counter that clears to zero on reset.',
    constraints: [],
    moduleInterface: {
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
    ],
    architecture: 'Single always block incrementing count on the clock edge.',
    approved: true,
    version: 1,
  };
}

/** A generated candidate carrying a fresh module-version ref (a NEW version). */
function candidate(spec: Spec, rtl: string): GeneratedCandidate {
  const id = newUlid();
  const moduleVersion: ModuleVersion = {
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

/** The independent, spec-derived Testbench for the current Spec. */
function testbenchFor(spec: Spec): Testbench {
  return {
    id: newUlid(),
    specId: spec.id,
    specVersion: spec.version,
    source: `// testbench emitting CHECK ${FAILING_CHECK}`,
    sourceAttribution: 'spec',
    coversCriteria: spec.acceptanceCriteria.map((criterion) => criterion.id),
  };
}

// -- Fake oracle captures ---------------------------------------------------

/** The oracle behaviours a re-verification run can exhibit. */
type OracleBehavior = 'pass' | 'fail' | 'error';

/** A capture whose testbench emitted the check PASS plus a VCD. */
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

/** A capture whose testbench emitted the check FAIL but still a VCD. */
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

/** A capture that timed out; the Simulator classifies the whole run `error`. */
function errorCapture(): RawRunCapture {
  return { ...failCapture(), timedOut: true };
}

/** The single-shot capture a given oracle behaviour keeps returning. */
function captureFor(behavior: OracleBehavior): () => RawRunCapture {
  if (behavior === 'pass') {
    return passCapture;
  }
  return behavior === 'fail' ? failCapture : errorCapture;
}

/** A fake Simulator that always plays the given capture (no real oracle). */
function fakeSimulator(make: () => RawRunCapture): SimulatorAdapter {
  return new IcarusSimulatorAdapter(new SandboxToolRunner(new FakeSandboxRuntime(make)));
}

// -- Fakes for the Verification_Loop collaborators (20.B) -------------------

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

/** A generation port that yields the same candidate for generate and every repair. */
class SteadyGenerator implements CandidateGenerator {
  readonly #cand: Result<CandidateEval, CandidateFailure>;
  constructor(cand: Result<CandidateEval, CandidateFailure>) {
    this.#cand = cand;
  }
  generateCandidate(
    _input: GenerationInput,
    budget: SessionBudgetHandle,
  ): Promise<Result<CandidateEval, CandidateFailure>> {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve(this.#cand);
  }
  reviseFromErrors(
    _input: GenerationInput,
    _previousRtl: string,
    _diagnostics: string,
    budget: SessionBudgetHandle,
  ): Promise<Result<CandidateEval, CandidateFailure>> {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve(this.#cand);
  }
}

/** A testbench port that returns the produced Testbench, charging one budget step. */
class SteadyTestbench implements IndependentTestbenchGenerator {
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
      failure: { reason: 'model-call-failed', detail: 'SteadyTestbench never repairs' },
    });
  }
}

/** A confirmed generation context bound to a session id (fields the fakes ignore). */
function confirmedContext(spec: Spec, sessionId: Ulid): ConfirmedGenerationContext {
  return {
    sessionId,
    projectId: spec.projectId,
    confirmedIntent: { summary: 'A 4-bit up-counter.', constraints: [], assumptions: [] },
    approvedSpec: spec,
  } as unknown as ConfirmedGenerationContext;
}

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

/** The generation-admission request the fakes ignore. */
const ADMISSION = {} as unknown as GenerationAdmissionRequest;

/**
 * A re-verifier backed by the REAL Verification_Loop over a fake Simulator.
 *
 * The loop runs generation + independent testbench + fake simulate, and its
 * oracle-derived Trust_Labeler decides `Verified` vs `Unverified`; this adapter
 * only maps the loop's `VerificationOutcome` onto the role-local `ReVerifyResult`,
 * exactly as the composition root will. No re-verification verdict is fabricated
 * here - the fake oracle's capture is the sole knob.
 */
class LoopReVerifier implements IterationReVerifier {
  readonly #loop: VerificationLoop;
  constructor(loop: VerificationLoop) {
    this.#loop = loop;
  }
  async reVerify(
    _input: ReVerifyInput,
    budget: SessionBudgetHandle,
    limits: ResourceLimits,
  ): Promise<ReVerifyResult> {
    const outcome = await this.#loop.verify(ADMISSION, budget, limits);
    switch (outcome.status) {
      case 'verified':
        return {
          status: 'verified',
          label: outcome.label,
          moduleVersion: outcome.moduleVersion,
          testbench: outcome.testbench,
          result: outcome.result,
        };
      case 'unverified':
        return {
          status: 'unverified',
          label: outcome.label,
          moduleVersion: outcome.candidate.moduleVersion,
          testbench: outcome.testbench,
          result: outcome.result,
          failingCase: outcome.failingCase,
        };
      case 'blocked':
        return { status: 'blocked', reason: 'generation gate refused admission' };
      case 'setup-failed':
        return { status: 'setup-failed', reason: outcome.detail };
      case 'instrument-refused':
        // `ReVerifyResult` has no refused-instrument member (role-local, task-scoped
        // separately); map onto `setup-failed`, the existing shape meaning "no usable
        // module was produced", so this test fixture's switch stays exhaustive.
        return { status: 'setup-failed', reason: outcome.reason };
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  }
}

/** A Spec updater that re-approves the Spec at the next version, interface unchanged. */
class SteadySpecUpdater implements IterationSpecUpdater {
  applyChange(
    request: SpecChangeRequest,
    budget: SessionBudgetHandle,
  ): Promise<Result<Spec, SpecUpdateFailure>> {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    const next: Spec = { ...request.currentSpec, version: request.currentSpec.version + 1 };
    return Promise.resolve(ok(next));
  }
}

/** A scripted re-verifier that returns a fixed result (20.C). */
class ScriptedReVerifier implements IterationReVerifier {
  readonly #result: ReVerifyResult;
  constructor(result: ReVerifyResult) {
    this.#result = result;
  }
  reVerify(): Promise<ReVerifyResult> {
    return Promise.resolve(this.#result);
  }
}

/** Build the current trust label of the module being edited. */
function editedLabel(priorVerified: boolean, ref: ArtifactRef): LabeledArtifact {
  if (!priorVerified) {
    return unverified(ref);
  }
  const label = verified(ref, newUlid());
  if (!isOk(label)) {
    throw new Error('test setup: could not build a Verified prior label');
  }
  return label.value;
}

/** Build the last-verified state a regression may revert to, when prior was Verified. */
function lastVerifiedFor(spec: Spec, priorVerified: boolean): LastVerifiedState | null {
  if (!priorVerified) {
    return null;
  }
  const priorModule = candidate(spec, 'module counter; endmodule').moduleVersion;
  const label = verified({ kind: 'module-version', id: priorModule.id, version: 1 }, newUlid());
  if (!isOk(label)) {
    throw new Error('test setup: could not build the last-verified label');
  }
  return {
    moduleVersion: priorModule,
    label: label.value,
    testbench: testbenchFor(spec),
    result: verificationResult('pass', label.value.oracleSpanRef),
  };
}

/** Build the iteration request for an edit to a module of the given prior tier. */
function iterationRequest(spec: Spec, priorVerified: boolean): IterationRequest {
  const editedRef: ArtifactRef = { kind: 'module-version', id: newUlid(), version: 1 };
  return {
    sessionId: newUlid(),
    projectId: spec.projectId,
    intent: {} as unknown as IntentSession,
    currentSpec: spec,
    edited: editedLabel(priorVerified, editedRef),
    requestedChange: 'widen the counter to 8 bits of behaviour without changing the interface',
    lastVerified: lastVerifiedFor(spec, priorVerified),
  };
}

/** Drain the agent's streamed run, collecting progress events and the outcome. */
async function runIteration(
  agent: IterationAgent,
  request: IterationRequest,
  budget: SessionBudgetHandle,
): Promise<{ events: IterationProgressEvent[]; outcome: IterationOutcome }> {
  const events: IterationProgressEvent[] = [];
  const iterator = agent.run(request, budget, LIMITS);
  let step = await iterator.next();
  while (!step.done) {
    events.push(step.value);
    step = await iterator.next();
  }
  return { events, outcome: step.value };
}

/** The tier a progress event of the given phase reported, if any. */
function tierOfPhase(events: readonly IterationProgressEvent[], phase: string): string | undefined {
  return events.find((event) => event.phase === phase)?.tier;
}

// -- Property 20.A: pure demotion-by-absence-of-provenance ------------------

describe(`${PROPERTY} (core: demotion is immediate and by absence of provenance)`, () => {
  const priorTierArbitrary = fc.constantFrom<'Verified' | 'Unverified' | 'Not_Applicable'>(
    'Verified',
    'Unverified',
    'Not_Applicable',
  );

  const scenarioArbitrary = fc.record({
    id: validUlidArbitrary,
    baseVersion: fc.integer({ min: 1, max: 5 }),
    priorTier: priorTierArbitrary,
    priorSpan: validUlidArbitrary,
    freshSpan: validUlidArbitrary,
    nonPass: fc.constantFrom<Verdict>('fail', 'error'),
  });

  it('demotes the edited module to Unverified immediately, regardless of the prior tier', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ id, baseVersion, priorTier, priorSpan }) => {
        const oldRef: ArtifactRef = { kind: 'module-version', id, version: baseVersion };
        const priorLabel: LabeledArtifact =
          priorTier === 'Verified'
            ? unwrapVerified(oldRef, priorSpan)
            : priorTier === 'Unverified'
              ? unverified(oldRef)
              : notApplicable(oldRef);

        const demoted = demoteOnEdit(priorLabel);

        // Immediate demotion to Unverified, preserving the artifact reference,
        // whatever the prior tier was (Req 10.7).
        expect(demoted.tier).toBe('Unverified');
        expect(demoted.artifactRef).toEqual(oldRef);
        expect(demoted).toEqual(unverified(oldRef));
      }),
      propertyParameters(),
    );
  });

  it('labels the edited (new) version Unverified purely because it has no passing span', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ id, baseVersion, priorSpan, nonPass, freshSpan }) => {
        const oldRef: ArtifactRef = { kind: 'module-version', id, version: baseVersion };
        const newRef: ArtifactRef = { kind: 'module-version', id, version: baseVersion + 1 };
        // Evidence that genuinely made the OLD version Verified.
        const priorEvidence: LabelingEvidence[] = [evidenceFor(oldRef, 'pass', priorSpan)];

        // The prior version really was Verified (non-vacuous setup).
        expect(labelArtifact(oldRef, priorEvidence).tier).toBe('Verified');

        // The edited version inherits no passing provenance: Unverified.
        expect(labelArtifact(newRef, priorEvidence).tier).toBe('Unverified');

        // It STAYS Unverified while re-verification produces only a non-pass verdict.
        const withNonPass = [
          ...priorEvidence,
          evidenceFor(newRef, nonPass, differentUlid(freshSpan)),
        ];
        expect(labelArtifact(newRef, withNonPass).tier).toBe('Unverified');
      }),
      propertyParameters(),
    );
  });

  it('re-labels the edited version Verified only on a fresh passing verdict for that version', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ id, baseVersion, priorSpan, freshSpan }) => {
        const oldRef: ArtifactRef = { kind: 'module-version', id, version: baseVersion };
        const newRef: ArtifactRef = { kind: 'module-version', id, version: baseVersion + 1 };
        // A fresh passing span for the NEW version, distinct from the old one.
        const freshSpanId = freshSpan === priorSpan ? differentUlid(freshSpan) : freshSpan;
        const evidence: LabelingEvidence[] = [
          evidenceFor(oldRef, 'pass', priorSpan),
          evidenceFor(newRef, 'pass', freshSpanId),
        ];

        const labeled = labelArtifact(newRef, evidence);

        expect(labeled.tier).toBe('Verified');
        if (labeled.tier === 'Verified') {
          // Bound to the fresh passing span for the NEW version.
          expect(labeled.oracleSpanRef).toBe(freshSpanId);
          expect(labeled.artifactRef).toEqual(newRef);
        }
      }),
      propertyParameters(),
    );
  });
});

/** Build a Verified prior label or throw (keeps the arbitrary body flat). */
function unwrapVerified(ref: ArtifactRef, span: Ulid): LabeledArtifact {
  const label = verified(ref, span);
  if (!isOk(label)) {
    throw new Error('test setup: could not build a Verified prior label');
  }
  return label.value;
}

// -- Property 20.B: through the agent, driven by the real loop + fake oracle -

describe(`${PROPERTY} (agent: intermediate is Unverified; Verified iff a fresh oracle pass)`, () => {
  const caseArbitrary = fc.record({
    priorVerified: fc.boolean(),
    oracle: fc.constantFrom<OracleBehavior>('pass', 'fail', 'error'),
  });

  it('shows the transient under Unverified and re-earns Verified only on a fresh oracle pass', async () => {
    await fc.assert(
      fc.asyncProperty(caseArbitrary, async ({ priorVerified, oracle }) => {
        const spec = counterSpec();
        const request = iterationRequest(spec, priorVerified);

        // The immediate demotion the agent applies is Unverified for any prior tier.
        expect(demoteOnEdit(request.edited).tier).toBe('Unverified');

        const simulator = fakeSimulator(captureFor(oracle));
        const cand = evalOf(candidate(spec, 'module counter; endmodule'));
        const testbench: TestbenchGenerationOutcome = {
          status: 'generated',
          testbench: testbenchFor(spec),
          checks: [],
        };
        const loop = new VerificationLoop({
          gate: new AdmittingGate(confirmedContext(spec, request.sessionId)),
          generator: new SteadyGenerator(cand),
          testbench: new SteadyTestbench(testbench),
          simulator,
          recorder: new TraceActionRecorder(new InMemoryTracePersistence()),
          trustLabeler: { label: labelArtifact },
        });
        const agent = new IterationAgent({
          specUpdater: new SteadySpecUpdater(),
          reVerifier: new LoopReVerifier(loop),
          recorder: new TraceActionRecorder(new InMemoryTracePersistence()),
        });

        const { events, outcome } = await runIteration(
          agent,
          request,
          budgetWithIterations(oracle === 'pass' ? 20 : 6),
        );

        // The intermediate demotion and the transient verifying state are shown
        // under Unverified (Req 10.5, 10.7, 10.8).
        expect(tierOfPhase(events, 'demoting')).toBe('Unverified');
        expect(tierOfPhase(events, 'verifying')).toBe('Unverified');
        // Only a terminal `verified` phase event may ever carry the Verified tier.
        expect(
          events.filter((event) => event.tier === 'Verified').map((event) => event.phase),
        ).toEqual(outcome.status === 'verified' ? ['verified'] : []);

        if (oracle === 'pass') {
          expect(outcome.status).toBe('verified');
          if (outcome.status !== 'verified') {
            return;
          }
          // Verified, bound to the fresh passing oracle span for the NEW version.
          expect(outcome.label.tier).toBe('Verified');
          expect(outcome.label.oracleSpanRef).toBe(outcome.result.oracleSpanId);
          expect(outcome.label.artifactRef.id).toBe(outcome.moduleVersion.id);
          return;
        }

        // No fresh pass: the module is never presented as correct (Req 10.5). It is
        // a regression when a prior Verified baseline exists, otherwise Unverified.
        expect(outcome.status).toBe(priorVerified ? 'regressed' : 'unverified');
        if (outcome.status === 'regressed' || outcome.status === 'unverified') {
          expect(outcome.label.tier).toBe('Unverified');
        }
      }),
      propertyParameters(),
    );
  });
});

// -- Property 20.C: exhaustive re-verification-result mapping ---------------

describe(`${PROPERTY} (agent: Verified iff re-verification produced a fresh pass)`, () => {
  type ReVerifyKind = 'verified' | 'unverified' | 'blocked' | 'setup-failed';

  const caseArbitrary = fc.record({
    kind: fc.constantFrom<ReVerifyKind>('verified', 'unverified', 'blocked', 'setup-failed'),
    priorVerified: fc.boolean(),
    span: validUlidArbitrary,
  });

  /** Build the scripted re-verification result of the requested kind for the new version. */
  function reVerifyResult(kind: ReVerifyKind, spec: Spec, span: Ulid): ReVerifyResult {
    const cand = candidate(spec, 'module counter; endmodule');
    const newRef = cand.label.artifactRef;
    if (kind === 'verified') {
      // The Verified label is oracle-derived through the core labeler.
      const label = labelArtifact(newRef, [evidenceFor(newRef, 'pass', span)]);
      if (label.tier !== 'Verified') {
        throw new Error('test setup: expected a Verified label for a fresh pass');
      }
      return {
        status: 'verified',
        label,
        moduleVersion: cand.moduleVersion,
        testbench: testbenchFor(spec),
        result: verificationResult('pass', span),
      };
    }
    if (kind === 'unverified') {
      return {
        status: 'unverified',
        label: unverified(newRef),
        moduleVersion: cand.moduleVersion,
        testbench: testbenchFor(spec),
        result: verificationResult('fail', span),
        failingCase: null,
      };
    }
    return kind === 'blocked'
      ? { status: 'blocked', reason: 'intent unconfirmed' }
      : { status: 'setup-failed', reason: 'generation unavailable' };
  }

  it('re-earns Verified only for a fresh pass; every other result stays non-correct', async () => {
    await fc.assert(
      fc.asyncProperty(caseArbitrary, async ({ kind, priorVerified, span }) => {
        const spec = counterSpec();
        const request = iterationRequest(spec, priorVerified);
        const agent = new IterationAgent({
          specUpdater: new SteadySpecUpdater(),
          reVerifier: new ScriptedReVerifier(reVerifyResult(kind, spec, span)),
          recorder: new TraceActionRecorder(new InMemoryTracePersistence()),
        });

        const { events, outcome } = await runIteration(agent, request, budgetWithIterations(20));

        // A Verified terminal outcome occurs if and only if re-verification passed.
        expect(outcome.status === 'verified').toBe(kind === 'verified');
        // The Verified tier never leaks onto a non-terminal (transient) event.
        expect(
          events.filter((event) => event.tier === 'Verified').map((event) => event.phase),
        ).toEqual(kind === 'verified' ? ['verified'] : []);

        if (kind === 'verified') {
          if (outcome.status !== 'verified') {
            return;
          }
          expect(outcome.label.tier).toBe('Verified');
          expect(outcome.label.oracleSpanRef).toBe(span);
        } else if (kind === 'unverified') {
          expect(outcome.status).toBe(priorVerified ? 'regressed' : 'unverified');
          if (outcome.status === 'regressed' || outcome.status === 'unverified') {
            expect(outcome.label.tier).toBe('Unverified');
          }
        } else if (kind === 'blocked') {
          expect(outcome.status).toBe('blocked');
        } else {
          expect(outcome.status).toBe('failed');
        }
      }),
      propertyParameters(),
    );
  });
});
