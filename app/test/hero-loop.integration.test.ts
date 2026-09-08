// Full hero-loop integration test (task 17.1).
//
// This is the M1 "hero loop" end to end: it drives a confirmed intent + an approved
// Spec through PARALLEL generation + an independent (RTL-isolated) testbench, the
// Verification_Loop to a passing oracle verdict, visualization delivery, one
// conversational iteration, and a Teach_Mode explanation - tying together the stages
// built in tasks 8-16 across their REAL seams (design "End-to-end hero loop"):
//
//   Intent/Spec (confirmed + approved) -> generation gate -> Generation_Agent (S4)
//     || Testbench_Agent (S6, RTL-isolated) -> Verification_Loop (S7) -> oracle
//     verdict -> Trust_Labeler -> Display_Layer (fail-closed) -> visualizations (S8)
//     -> Iteration_Agent (S9) -> Teach_Mode.
//
// THE CRUX ASSERTIONS (Req 6.6, 8.3, 14.13). The module ends `Verified` bound to the
// recorded passing ORACLE span (provenance present, Req 8.3); no module is presented
// as correct without that passing oracle verdict (Req 6.6); and when that labeled
// artifact reaches the Display_Layer, the `Verified` treatment is applied ONLY
// because the label's oracle provenance validates against the recorded Trace - strip
// or tamper the evidence and the Display_Layer fails closed to `Unverified` with a
// recorded discrepancy (Req 14.13, 14.14, 14.15). Oracle-bound labeling and
// fail-closed provenance therefore hold across the real seams, not a stub.
//
// ANTI-CIRCULAR END TO END (Req 7.1, 7.2, 7.7). The exact request the loop hands the
// Testbench_Agent is captured and asserted to contain none of the generated RTL, so
// verification can never be an artifact of the implementation it is testing.
//
// REAL ORACLE vs FAKE ORACLE (matches the 3.8 / 14.2 / 15.8 precedent exactly). The
// real Icarus toolchain (`iverilog` + `vvp`) is absent in most environments, so the
// real-oracle end-to-end run is gated behind the shared `PROBE` and SKIPS cleanly via
// `describe.skipIf(!PROBE.available)` (its reason surfaced), while the SAME end-to-end
// trajectory is ALSO driven through the `FakeSandboxRuntime`-backed Simulator so this
// test is non-vacuous even when the real oracle is unavailable. Only the Simulator
// differs between the two suites; the loop, labeler, display layer, visualizations,
// iteration, teach, and every assertion are identical. The oracle (real or fake) is
// the sole authority - no verdict is fabricated here.

import { describe, expect, it } from 'vitest';

import {
  newUlid,
  ok,
  oracleTrustLabeler,
  treatmentForTier,
  type ArtifactRef,
  type Json,
  type OracleVerdictSpan,
  type Result,
  type SessionBudget,
  type Spec,
  type Testbench,
  type Trace,
  type Ulid,
  type VerificationResult,
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
  SIMULATION_VS_SILICON_LIMIT,
  TeachMode,
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
  type IntentSession,
  type IterationReVerifier,
  type IterationRequest,
  type IterationSpecUpdater,
  type LastVerifiedState,
  type ModelRouter,
  type ModelRouterFailure,
  type ReVerifyInput,
  type ReVerifyResult,
  type RoutedModelResult,
  type RoutingDiagnostics,
  type SessionBudgetHandle,
  type SpecChangeRequest,
  type SpecUpdateFailure,
  type TeachSession,
  type TestbenchGenerationOutcome,
  type VerificationOutcome,
  type VerifiedModule,
} from '@app/agent';
import { routedModelIdFor } from '@app/test';
import {
  createDisplayLayer,
  decideTrustTreatment,
  deliverVisualizations,
  type ProvenanceDiscrepancy,
  type SchematicSource,
  type WaveformSource,
} from '@app/web';

import {
  BUGGY_COUNTER_RTL,
  COUNTER_MODULE_NAME,
  COUNTER_TESTBENCH,
  PASSING_COUNTER_RTL,
  PROBE,
  realOracleAdapter,
} from './real-oracle-harness.js';

if (!PROBE.available) {
  console.warn(
    `[hero-loop.integration] Real-oracle hero loop NOT exercised: ${PROBE.reason}. ` +
      'The full intent->...->teach trajectory is still driven through the fake Simulator in ' +
      'this environment; the real iverilog + vvp end-to-end run is SKIPPED.',
  );
}

/** The Trace `stageOrTool` name every oracle verdict is recorded under. */
const VERIFICATION_STAGE = 'Verification_Loop';

/** The single spec-derived check the counter testbench can fail. */
const FAILING_CHECK = 'counts_up';

/** Generous caps for a local process launch plus a real iverilog + vvp run. */
const LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };

/** Per-test timeout covering several real compile-and-simulate runs (ms). */
const REAL_TIMEOUT = 240_000;

/** The gate admission request; the admitting gate ignores it in this test. */
const REQUEST = {} as unknown as GenerationAdmissionRequest;

// -- Spec + candidate fixtures (shared with the counter harness) ------------

/** An approved single-module Spec for the 4-bit counter the harness fixtures build. */
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
    label: { artifactRef, tier: 'Unverified' },
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

// -- Injected collaborators (fakes for the model-backed roles) --------------
//
// The oracle is real (or the faithful fake Simulator); only the MODEL-backed roles
// are scripted, exactly as the Verification_Loop integration test does. The seams
// under test - the loop, the Trust_Labeler, the Display_Layer, the visualization
// delivery, the Iteration_Agent, and the Teach_Mode grounding core - are the real
// production code.

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

/**
 * A testbench port that returns the produced Testbench and RECORDS every request it
 * was handed, so the anti-circular guarantee (Req 7.2) can be asserted end to end
 * against the exact input the loop assembled.
 */
class RecordingTestbench implements IndependentTestbenchGenerator {
  readonly requests: GenerateTestbenchRequest[] = [];
  readonly #outcome: TestbenchGenerationOutcome;
  constructor(outcome: TestbenchGenerationOutcome) {
    this.#outcome = outcome;
  }
  generateTestbench(
    request: GenerateTestbenchRequest,
    budget: SessionBudgetHandle,
  ): Promise<TestbenchGenerationOutcome> {
    this.requests.push(request);
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve(this.#outcome);
  }
}

/** A Spec updater that applies the change as a no-op (same interface: no regen needed). */
class NoInterfaceChangeSpecUpdater implements IterationSpecUpdater {
  applyChange(
    request: SpecChangeRequest,
    budget: SessionBudgetHandle,
  ): Promise<Result<Spec, SpecUpdateFailure>> {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve(ok(request.currentSpec));
  }
}

/**
 * A teaching Model_Router that returns one scripted, well-formed claims payload.
 *
 * This is the same seam Teach_Mode routes through (`teaching` -> Gemini Flash); the
 * payload is a design claim grounded in the REAL passing oracle verdict, so the
 * grounding core teaches it only because its provenance resolves in the session.
 */
class ScriptedTeachingRouter implements ModelRouter {
  readonly #outputText: string;
  constructor(outputText: string) {
    this.#outputText = outputText;
  }
  invoke(
    task: RoutedModelResult['task'],
    _request: unknown,
    budget: SessionBudgetHandle,
  ): Promise<Result<RoutedModelResult, ModelRouterFailure>> {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve(
      ok({
        task,
        provider: 'gemini',
        modelId: routedModelIdFor('gemini'),
        outputText: this.#outputText,
        tokensUsed: 1,
        costCents: 1,
        attempts: 1,
        fellBack: false,
      }),
    );
  }
  describeRouting(): RoutingDiagnostics {
    return { tasks: [], providers: [] };
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

/** A fake Simulator that plays scripted captures in sequence (last repeats). */
function fakeSimulator(sequence: readonly (() => RawRunCapture)[]): SimulatorAdapter {
  let index = 0;
  const runtime = new FakeSandboxRuntime(() => {
    const make = sequence[Math.min(index, sequence.length - 1)];
    index += 1;
    return (make ?? failCapture)();
  });
  return new IcarusSimulatorAdapter(new SandboxToolRunner(runtime));
}

// -- Budget assembly --------------------------------------------------------

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

// -- Trace projection + stream-label shaping --------------------------------

/** Narrow a `Json` value to its object shape, or an empty record. */
function asRecord(value: Json): Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
}

/**
 * Project the oracle-verdict evidence the Display_Layer validates against, straight
 * from the recorded Trace.
 *
 * This is the real seam: the Display_Layer never re-derives correctness, it only
 * confirms the label's `oracleSpanRef` names a recorded PASSING verdict span for the
 * exact artifact version. Here the evidence is the passing Verification_Loop span the
 * loop actually recorded (its span id is what the `Verified` label is bound to), so a
 * match proves the label's provenance validates against the Trace rather than a stub.
 */
function oracleEvidenceFromTrace(trace: Trace, artifactRef: ArtifactRef): OracleVerdictSpan[] {
  return trace.spans
    .filter((span) => span.stageOrTool === VERIFICATION_STAGE)
    .filter((span) => asRecord(span.outputs).verdict === 'pass')
    .map((span) => ({ spanId: span.id, artifactRef, verdict: 'pass' as const }));
}

/** The untrusted `Verified` label as it would arrive from the SSE stream. */
function streamLabelOf(verified: VerifiedModule): unknown {
  return {
    artifactRef: verified.label.artifactRef,
    tier: 'Verified',
    oracleSpanRef: verified.label.oracleSpanRef,
  };
}

/** A capturing discrepancy port for observing what the Display_Layer records. */
function recordingPort(): {
  emit: (d: ProvenanceDiscrepancy) => void;
  emitted: ProvenanceDiscrepancy[];
} {
  const emitted: ProvenanceDiscrepancy[] = [];
  return { emit: (discrepancy) => emitted.push(discrepancy), emitted };
}

// -- The build (stages S0/S1 -> S4 || S6 -> S7) -----------------------------

/** The prepared artifacts a hero-loop build produces, carried to the later stages. */
interface BuildBundle {
  readonly spec: Spec;
  readonly sessionId: Ulid;
  readonly recorder: TraceActionRecorder;
  readonly testbench: RecordingTestbench;
  readonly generator: ScriptedGenerator;
  readonly outcome: VerificationOutcome;
}

/**
 * Drive a confirmed intent + approved Spec through the generation gate, parallel
 * generation + independent testbench, and the Verification_Loop along a
 * fail -> repair -> pass trajectory, returning everything the later stages assert on.
 */
async function buildAndVerify(simulator: SimulatorAdapter): Promise<BuildBundle> {
  const spec = counterSpec();
  const sessionId = newUlid();
  const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
  const generator = new ScriptedGenerator(evalOf(candidate(spec, BUGGY_COUNTER_RTL)), [
    evalOf(candidate(spec, PASSING_COUNTER_RTL)),
  ]);
  const testbench = new RecordingTestbench({
    status: 'generated',
    testbench: testbenchFor(spec),
    checks: [],
  });
  const loop = new VerificationLoop({
    gate: new AdmittingGate(confirmedContext(spec, sessionId)),
    generator,
    testbench,
    simulator,
    recorder,
    trustLabeler: oracleTrustLabeler,
  });
  const outcome = await loop.verify(REQUEST, budgetWithIterations(20), LIMITS);
  return { spec, sessionId, recorder, testbench, generator, outcome };
}

/** Re-verification port over the SAME Verification_Loop the initial build used (S9). */
class LoopReVerifier implements IterationReVerifier {
  readonly #makeSimulator: () => SimulatorAdapter;
  readonly #recorder: TraceActionRecorder;
  readonly #sessionId: Ulid;
  constructor(
    makeSimulator: () => SimulatorAdapter,
    recorder: TraceActionRecorder,
    sessionId: Ulid,
  ) {
    this.#makeSimulator = makeSimulator;
    this.#recorder = recorder;
    this.#sessionId = sessionId;
  }

  async reVerify(
    input: ReVerifyInput,
    budget: SessionBudgetHandle,
    limits: ResourceLimits,
  ): Promise<ReVerifyResult> {
    const generator = new ScriptedGenerator(evalOf(candidate(input.spec, PASSING_COUNTER_RTL)));
    const testbench = new RecordingTestbench({
      status: 'generated',
      testbench: testbenchFor(input.spec),
      checks: [],
    });
    const loop = new VerificationLoop({
      gate: new AdmittingGate(confirmedContext(input.spec, this.#sessionId)),
      generator,
      testbench,
      simulator: this.#makeSimulator(),
      recorder: this.#recorder,
      trustLabeler: oracleTrustLabeler,
    });
    return mapReVerify(await loop.verify(REQUEST, budget, limits));
  }
}

/** Map the loop's `VerificationOutcome` onto the Iteration_Agent's re-verify union. */
function mapReVerify(outcome: VerificationOutcome): ReVerifyResult {
  if (outcome.status === 'verified') {
    return {
      status: 'verified',
      label: outcome.label,
      moduleVersion: outcome.moduleVersion,
      testbench: outcome.testbench,
      result: outcome.result,
    };
  }
  if (outcome.status === 'unverified') {
    return {
      status: 'unverified',
      label: outcome.label,
      moduleVersion: outcome.candidate.moduleVersion,
      testbench: outcome.testbench,
      result: outcome.result,
      failingCase: outcome.failingCase,
    };
  }
  if (outcome.status === 'blocked') {
    return { status: 'blocked', reason: 'generation gate refused admission' };
  }
  return { status: 'setup-failed', reason: outcome.reason };
}

// -- Stage assertions -------------------------------------------------------

/**
 * Assert the module ends `Verified` bound to the recorded passing oracle span
 * (Req 6.6, 8.3): provenance present, the verdict is a real oracle `pass`, and the
 * loop took the fail -> repair -> pass path (a module is never `Verified` without a
 * passing oracle verdict).
 */
function assertVerifiedWithProvenance(bundle: BuildBundle): VerifiedModule {
  const { outcome, generator } = bundle;
  expect(outcome.status).toBe('verified');
  if (outcome.status !== 'verified') {
    throw new Error('expected a verified module');
  }
  // Verified, bound to the recorded passing oracle span (provenance present).
  expect(outcome.label.tier).toBe('Verified');
  expect(outcome.label.oracleSpanRef).toBe(outcome.oracleSpanId);
  expect(outcome.result.verdict).toBe('pass');
  expect(outcome.result.allChecksPassed).toBe(true);
  expect(outcome.result.oracleSpanId).toBe(outcome.oracleSpanId);
  // One failing run, then one repair, then the passing run: exactly two iterations.
  expect(outcome.iterations).toBe(2);
  expect(generator.reviseCalls).toHaveLength(1);
  expect(generator.reviseCalls[0]?.diagnostics).toContain(FAILING_CHECK);
  return outcome;
}

/**
 * Assert the testbench-generation input never contained the RTL (Req 7.1, 7.2, 7.7):
 * the exact request handed to the Testbench_Agent, serialized in full, contains none
 * of the generated RTL, and the produced Testbench is attributed to the Spec.
 */
function assertAntiCircular(bundle: BuildBundle, verified: VerifiedModule): void {
  expect(bundle.testbench.requests).toHaveLength(1);
  const serialized = JSON.stringify(bundle.testbench.requests[0]);
  // Distinctive RTL fragments from both the buggy and the passing candidate.
  expect(serialized).not.toContain("count + 4'd1");
  expect(serialized).not.toContain("count + 4'd2");
  expect(serialized).not.toContain('module counter');
  expect(serialized).not.toContain(verified.moduleVersion.rtl);
  expect(verified.testbench.sourceAttribution).toBe('spec');
}

/**
 * Assert the fail-closed provenance contract at the Display_Layer (Req 14.13-14.15):
 * the `Verified` treatment is applied ONLY because the label's provenance validates
 * against the recorded Trace; strip the evidence or tamper the reference and the
 * layer fails closed to `Unverified` and records a discrepancy.
 */
async function assertDisplayLayerProvenance(
  bundle: BuildBundle,
  verified: VerifiedModule,
): Promise<void> {
  const trace = await bundle.recorder.getTrace(bundle.sessionId);
  const evidence = oracleEvidenceFromTrace(trace, verified.label.artifactRef);
  // The projected evidence is exactly the recorded passing span the label is bound to.
  expect(evidence).toHaveLength(1);
  expect(evidence[0]?.spanId).toBe(verified.oracleSpanId);

  const rawLabel = streamLabelOf(verified);
  const verifiedTreatment = treatmentForTier('Verified');
  const unverifiedTreatment = treatmentForTier('Unverified');

  // Verified is EARNED: the treatment is applied through the impure edge, and no
  // discrepancy is recorded, only because the provenance validates against the Trace.
  const port = recordingPort();
  const model = createDisplayLayer(port).resolveTreatment(rawLabel, evidence);
  expect(model.tier).toBe('Verified');
  expect(model.treatment).toBe(verifiedTreatment);
  expect(port.emitted).toHaveLength(0);

  // Strip the evidence: the SAME Verified label now fails closed (Req 14.14) and a
  // discrepancy is recorded (Req 14.15). This is what makes the pass "only because".
  const stripped = recordingPort();
  const withoutEvidence = createDisplayLayer(stripped).resolveTreatment(rawLabel, []);
  expect(withoutEvidence.tier).toBe('Unverified');
  expect(withoutEvidence.treatment).toBe(unverifiedTreatment);
  expect(stripped.emitted).toHaveLength(1);
  expect(stripped.emitted[0]?.reason).toBe('unvalidatable-provenance');

  // Tamper the provenance reference against the real Trace: still fails closed.
  const tampered = decideTrustTreatment(
    { artifactRef: verified.label.artifactRef, tier: 'Verified', oracleSpanRef: newUlid() },
    evidence,
  );
  expect(tampered.tier).toBe('Unverified');
  expect(tampered.discrepancy?.reason).toBe('unvalidatable-provenance');
}

/**
 * Assert the visualizations are delivered from the oracle-bound `Verified` label and
 * inherit its trust (Req 9.2, 9.4, 9.12): a visualization carries the `Verified`
 * treatment only because its source artifact is `Verified`.
 */
function assertVisualizationDelivery(verified: VerifiedModule): void {
  const waveformSource: WaveformSource = {
    state: 'ready',
    vcd: ['$var wire 1 ! clk $end', '$enddefinitions $end', '#0', '0!', '#5', '1!', ''].join('\n'),
    sourceLabel: verified.label,
  };
  const schematicSource: SchematicSource = {
    state: 'ready',
    svgRef: { name: 'counter.svg', sizeBytes: 2_048, sha256: 'c'.repeat(64) },
    sourceLabel: verified.label,
  };
  const delivery = deliverVisualizations(waveformSource, schematicSource);

  const verifiedTreatment = treatmentForTier('Verified');
  expect(delivery.waveform.phase).toBe('available');
  expect(delivery.schematic.phase).toBe('available');
  if (delivery.waveform.phase === 'available') {
    expect(delivery.waveform.tier).toBe('Verified');
    expect(delivery.waveform.treatment).toBe(verifiedTreatment);
  }
  if (delivery.schematic.phase === 'available') {
    expect(delivery.schematic.tier).toBe('Verified');
    expect(delivery.schematic.treatment).toBe(verifiedTreatment);
  }
}

/**
 * Assert one conversational iteration re-verifies through the SAME loop and ends
 * `Verified` again bound to a FRESH oracle span, presenting a diff with the new
 * verdict (Req 10.1, 10.3, 10.5, 10.6). The edited module is demoted first.
 */
async function assertIteration(
  bundle: BuildBundle,
  verified: VerifiedModule,
  makeSimulator: () => SimulatorAdapter,
): Promise<void> {
  const lastVerified: LastVerifiedState = {
    moduleVersion: verified.moduleVersion,
    label: verified.label,
    testbench: verified.testbench,
    result: verified.result,
  };
  const request: IterationRequest = {
    sessionId: bundle.sessionId,
    projectId: bundle.spec.projectId,
    // The re-verifier does not consult the intent session, so a marker suffices here.
    intent: {} as unknown as IntentSession,
    currentSpec: bundle.spec,
    edited: verified.label,
    requestedChange: 'Add a comment clarifying the synchronous reset behavior.',
    lastVerified,
  };
  const agent = new IterationAgent({
    specUpdater: new NoInterfaceChangeSpecUpdater(),
    reVerifier: new LoopReVerifier(makeSimulator, bundle.recorder, bundle.sessionId),
    recorder: bundle.recorder,
  });

  const outcome = await agent.iterate(request, budgetWithIterations(20), LIMITS);

  expect(outcome.status).toBe('verified');
  if (outcome.status !== 'verified') {
    return;
  }
  expect(outcome.label.tier).toBe('Verified');
  // A fresh oracle span backs the re-verified module (never the old one reused).
  expect(outcome.label.oracleSpanRef).not.toBe(verified.oracleSpanId);
  expect(outcome.result.verdict).toBe('pass');
  expect(outcome.diff.verdict).toBe('pass');
  expect(outcome.diff.interfaceChanged).toBe(false);
}

/**
 * Assert a Teach_Mode explanation is produced through the real grounding core, bound
 * to the SAME passing oracle verdict (Req 8.3, 11.1, 11.2, 11.5): the `Verified`
 * result presentation states the mandatory simulation-vs-silicon limit and is
 * grounded in the recorded oracle span, and the pedagogy artifact is `Not_Applicable`.
 */
async function assertTeach(verified: VerifiedModule): Promise<void> {
  const result: VerificationResult = verified.result;
  const teachOutput = JSON.stringify({
    claims: [
      {
        kind: 'design',
        statement: 'The counter increments by one each clock, proven by the oracle run.',
        grounding: {
          kind: 'oracle-verdict',
          verificationResultId: result.id,
          oracleSpanId: result.oracleSpanId,
        },
      },
    ],
  });
  const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
  const teach = new TeachMode({ router: new ScriptedTeachingRouter(teachOutput), recorder });
  const session: TeachSession = {
    sessionId: verified.result.moduleVersionId,
    spec: counterSpec(),
    moduleLabel: verified.label,
    verification: result,
    waveform: null,
    traceSpanIds: [],
    availableCitations: [],
  };

  const explained = await teach.explain(session, budgetWithIterations(20));

  expect(explained.ok).toBe(true);
  if (!explained.ok) {
    return;
  }
  const explanation = explained.value;
  // The pedagogy artifact makes no correctness claim.
  expect(explanation.artifact.tier).toBe('Not_Applicable');
  // The design claim is taught only because its oracle provenance resolves.
  expect(explanation.claims[0]?.disposition).toBe('taught');
  // The Verified presentation states the mandatory limit and is bound to the oracle span.
  expect(explanation.verifiedResult).not.toBeNull();
  expect(explanation.verifiedResult?.simulationVsSiliconLimit).toBe(SIMULATION_VS_SILICON_LIMIT);
  expect(explanation.verifiedResult?.grounding.kind).toBe('oracle-verdict');
  if (explanation.verifiedResult?.grounding.kind === 'oracle-verdict') {
    expect(explanation.verifiedResult.grounding.oracleSpanId).toBe(verified.oracleSpanId);
  }
}

// -- The whole hero loop, asserted once, run against fake and real oracles --

/** Simulator factories: the build takes a fail->pass path, re-verify passes at once. */
interface HeroLoopSimulators {
  readonly buildSimulator: () => SimulatorAdapter;
  readonly reVerifySimulator: () => SimulatorAdapter;
}

/**
 * Drive and assert the entire hero loop end to end over the given oracle.
 *
 * Expressed once so the fake-Simulator suite and the real-oracle suite assert
 * identically and cannot drift (only the Simulator differs between them).
 */
async function assertHeroLoop(simulators: HeroLoopSimulators): Promise<void> {
  const bundle = await buildAndVerify(simulators.buildSimulator());
  const verified = assertVerifiedWithProvenance(bundle);
  assertAntiCircular(bundle, verified);
  await assertDisplayLayerProvenance(bundle, verified);
  assertVisualizationDelivery(verified);
  await assertIteration(bundle, verified, simulators.reVerifySimulator);
  await assertTeach(verified);
}

/** The fake-oracle simulators: fail -> pass for the build, pass-at-once for re-verify. */
const FAKE_SIMULATORS: HeroLoopSimulators = {
  buildSimulator: () => fakeSimulator([failCapture, passCapture]),
  reVerifySimulator: () => fakeSimulator([passCapture]),
};

/** The real-oracle simulators: the RTL decides the verdict, so both use the real adapter. */
const REAL_SIMULATORS: HeroLoopSimulators = {
  buildSimulator: realOracleAdapter,
  reVerifySimulator: realOracleAdapter,
};

// -- Fake-Simulator suite (always runs; keeps the test non-vacuous) ---------

describe('Hero loop integration - fake Simulator (non-vacuous; Req 6.6, 8.3, 14.13)', () => {
  it('drives intent -> spec -> generation || testbench -> verify -> visualize -> iterate -> teach', async () => {
    await assertHeroLoop(FAKE_SIMULATORS);
  });
});

// -- Capability probe (always runs) -----------------------------------------

describe('Hero loop integration - real-oracle capability probe', () => {
  it('documents whether the real oracle path was exercised in this environment', () => {
    expect(typeof PROBE.available).toBe('boolean');
    expect(PROBE.reason.length).toBeGreaterThan(0);
  });
});

// -- Real-oracle suite (skips cleanly when iverilog/vvp are absent) ---------

describe.skipIf(!PROBE.available)(
  'Hero loop integration - real oracle (iverilog + vvp; Req 6.6, 8.3, 14.13)',
  () => {
    it(
      'drives the full hero loop end to end through real iverilog + vvp',
      async () => {
        await assertHeroLoop(REAL_SIMULATORS);
      },
      REAL_TIMEOUT,
    );
  },
);
