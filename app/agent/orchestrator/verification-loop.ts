// The Verification_Loop (S7): the M1 agentic hero loop that layers generate ->
// simulate -> fix on top of the M0 oracle-path spine (Req 8.1-8.6, 8.9; design
// "End-to-end hero loop" and "Verification loop design").
//
// The non-negotiable invariant: the language model proposes and the deterministic
// Simulator decides. This loop NEVER judges correctness from model output. It
// compiles and simulates the candidate against an INDEPENDENTLY derived Testbench
// in the sandbox, treats the Simulator verdict as the sole authority (Req 8.2),
// records each verdict/iteration span in the Trace (Req 8.8), and repairs the RTL
// from the simulator output when the oracle does not pass - all bounded by one
// Session_Budget so the loop always terminates.
//
// Anti-circular by construction (Property 4): generation (S4) and testbench
// generation (S6) both derive from the approved Spec and run in PARALLEL. The
// testbench request is assembled from the Spec + intent BEFORE any RTL exists and
// is structurally incapable of carrying RTL (see the Testbench_Agent), so a
// passing check can never be an artifact of the implementation it is testing.
//
// A pass must be COMPLETE, not just clean (Req 7.3, 8.10). The Simulator oracle
// reads standard output, so it can only judge the checks a run actually printed; it
// cannot know which ones the Spec required. This loop is the one place that holds
// both facts, so it keeps the Testbench_Agent's required check names from setup and
// refuses to accept a `pass` whose evidence is incomplete: a required check that
// printed nothing was not verified, and the passes that did print are not a
// substitute for it. See `#incompleteEvidence`.
//
// Verified is oracle-bound (Req 8.3, 8.9, 14.2, 14.8): on a passing verdict the
// loop asks the Trust_Labeler for `Verified` bound to the recorded oracle span,
// regardless of budget status - a pass discovered on the last affordable run still
// yields `Verified`, because the label depends on the recorded verdict, not on the
// budget. On exhaustion the loop presents the last failing case labeled
// `Unverified` and exposes a Teach_Mode handoff seam (Teach_Mode itself is task
// 16.4; this loop only produces the handoff payload).
//
// Budget reconciliation (single interface): the Generation_Agent and
// Testbench_Agent consume the model-router `SessionBudgetHandle` port (the mutable
// `InMemorySessionBudgetHandle` derived from a core `SessionBudget`). This loop
// threads that SAME handle through generation, testbench, and its own per-iteration
// simulate accounting, so exactly one budget bounds the whole loop. Each model call
// (charged by the Model_Router) and each simulate (charged here via `charge`) counts
// an iteration, so within `maxIterations` the loop is guaranteed to stop.
//
// All collaborators are injected as narrow ports (no globals, no direct provider or
// store calls, no import of `app/api`). Any thrown sandbox/infra failure is caught
// and classified `error` (fail safe), never crashing the loop.

import {
  makeVerificationResult,
  missingCheckNames,
  unverified,
  type BudgetStopReason,
  type FailingCase,
  type Json,
  type ModuleVersion,
  type Result,
  type Testbench,
  type TraceSpan,
  type TrustLabeler,
  type Ulid,
  type UnverifiedArtifact,
  type Verdict,
  type VerificationResult,
  type VerifiedArtifact,
  newUlid,
} from '@app/core';
import type { ResourceLimits, SimulationVerdict, SimulatorAdapter, SourceFile } from '@app/tools';

import type { ActionRecorder, SpanDraft } from '../action-recorder/index.js';
import type {
  AttemptCost,
  ModelRouterFailure,
  ModelRouterFailureCode,
  SessionBudgetHandle,
} from '../model-router/index.js';
import type {
  CandidateEval,
  CandidateFailure,
  GeneratedCandidate,
  GenerationInput,
} from '../roles/generation/index.js';
import type {
  GenerateTestbenchRequest,
  TestbenchGenerationFailureReason,
  TestbenchGenerationOutcome,
} from '../roles/testbench/index.js';

import type {
  ConfirmedGenerationContext,
  GenerationAdmissionRequest,
  GenerationGateRefusal,
} from './generation-gate.js';

/** The Trace `stageOrTool` name recorded for every oracle verdict this loop runs. */
const VERIFICATION_STAGE = 'Verification_Loop' as const;

/**
 * The generation port the loop drives: produce a first candidate and revise a
 * candidate from simulator output. `GenerationAgent` satisfies this structurally,
 * so the loop depends on the two primitives it needs, never the whole agent.
 */
export interface CandidateGenerator {
  generateCandidate(
    input: GenerationInput,
    budget: SessionBudgetHandle,
  ): Promise<Result<CandidateEval, CandidateFailure>>;
  reviseFromErrors(
    input: GenerationInput,
    previousRtl: string,
    diagnostics: string,
    budget: SessionBudgetHandle,
  ): Promise<Result<CandidateEval, CandidateFailure>>;
}

/** The independent-testbench port the loop drives. `TestbenchAgent` satisfies it. */
export interface IndependentTestbenchGenerator {
  generateTestbench(
    request: GenerateTestbenchRequest,
    budget: SessionBudgetHandle,
  ): Promise<TestbenchGenerationOutcome>;
}

/**
 * The generation-gate opener the loop uses ONCE per run to mint the confirmed
 * context, then reuses across repair iterations. `GenerationGate` satisfies this
 * (its `openGenerationContext`), so the loop never re-opens the gate mid-run and
 * never depends on the gate's generic runner parameter.
 */
export interface GenerationContextOpener {
  openGenerationContext(
    request: GenerationAdmissionRequest,
  ): Promise<Result<ConfirmedGenerationContext, GenerationGateRefusal>>;
}

/** The injected collaborators and deterministic seams for the Verification_Loop. */
export interface VerificationLoopDeps {
  /** The generation gate opener; called once, its token reused across iterations. */
  readonly gate: GenerationContextOpener;
  /** The Generation_Agent primitives that generate and repair candidate RTL. */
  readonly generator: CandidateGenerator;
  /** The RTL-isolated Testbench_Agent that derives the independent Testbench. */
  readonly testbench: IndependentTestbenchGenerator;
  /** The Simulator oracle: compile+simulate candidate + Testbench in the sandbox. */
  readonly simulator: SimulatorAdapter;
  /** The Action_Recorder that appends each ordered, sanitized verdict span. */
  readonly recorder: ActionRecorder;
  /** The oracle-derived Trust_Labeler: the only path to a `Verified` label. */
  readonly trustLabeler: TrustLabeler;
  /** ULID source for verification-result ids; defaults to `newUlid`. */
  readonly newId?: () => Ulid;
  /** Wall-clock source for recorded span timing; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Which step of the loop a progress event reports. */
export type VerificationPhase =
  'setup' | 'simulating' | 'repairing' | 'verified' | 'exhausted' | 'blocked' | 'setup-failed';

/**
 * A non-blocking progress event streamed while the loop runs (Req 6.7, 17.6).
 *
 * A domain event; the API_Gateway maps it to its own stream frame. The agent layer
 * never imports the gateway, so the shape stays provider-neutral.
 */
export interface VerificationProgressEvent {
  readonly kind: 'progress';
  /** The 1-based verification iteration this event belongs to (0 during setup). */
  readonly iteration: number;
  readonly phase: VerificationPhase;
  /** The oracle verdict, when the event reports one. */
  readonly verdict?: Verdict;
  /** A short, non-sensitive human-readable status line. */
  readonly message: string;
}

/**
 * The Teach_Mode handoff payload produced on exhaustion (Req 8.5).
 *
 * This is the seam only: it carries the failing case and sanitized diagnostics for
 * the Teach_Mode role (task 16.4) to coach on. This loop never invokes Teach_Mode.
 */
export interface TeachModeHandoff {
  readonly sessionId: Ulid;
  readonly specId: Ulid;
  readonly moduleVersionId: Ulid;
  /** The concrete failing case to coach on, or `null` if none was localized. */
  readonly failingCase: FailingCase | null;
  /** Student-facing, sanitized diagnostics (no hosts, paths, or stack traces). */
  readonly diagnostics: string;
  readonly stopReason: BudgetStopReason;
}

/** The module reached a passing oracle verdict and was labeled `Verified` (Req 8.3). */
export interface VerifiedModule {
  readonly status: 'verified';
  /** The `Verified` label bound to the passing oracle span (Req 14.2, 14.8). */
  readonly label: VerifiedArtifact;
  /** The recorded passing verification result (pass integrity enforced). */
  readonly result: VerificationResult;
  readonly moduleVersion: ModuleVersion;
  readonly testbench: Testbench;
  readonly simulation: SimulationVerdict;
  /** The Trace span that IS the ground truth for the `Verified` label. */
  readonly oracleSpanId: Ulid;
  readonly iterations: number;
}

/** The loop exhausted its budget without a pass; the module is `Unverified` (Req 8.5). */
export interface UnverifiedModule {
  readonly status: 'unverified';
  readonly label: UnverifiedArtifact;
  /** The last recorded non-passing verification result. */
  readonly result: VerificationResult;
  readonly candidate: GeneratedCandidate;
  readonly testbench: Testbench;
  readonly simulation: SimulationVerdict;
  readonly failingCase: FailingCase | null;
  readonly stopReason: BudgetStopReason;
  readonly iterations: number;
  /** The seam handed to Teach_Mode for coaching on the failure (Req 8.5). */
  readonly teachMode: TeachModeHandoff;
}

/** The generation gate refused admission (intent unconfirmed / spec unapproved). */
export interface VerificationBlocked {
  readonly status: 'blocked';
  readonly refusal: GenerationGateRefusal;
}

/**
 * WHY setup failed, as a value rather than as prose.
 *
 * `reason` above says WHICH HALF of setup failed and `detail` says it in words an operator
 * reads. Neither can be branched on safely: `detail` is a sentence, and both halves can fail
 * for causes that mean opposite things to a measurement. This union is the branchable fact,
 * and the distinction it exists to carry is INFRASTRUCTURE versus FINDING:
 *
 *   - `provider-unreachable` - no provider answered at all (the router exhausted its chain,
 *     or the transport breaker refused the call). NOTHING about the model was measured, so a
 *     consumer that treats this as a result is reporting an outage as data.
 *   - `budget-exhausted` - a configured Session_Budget cap stopped setup. The caps are the
 *     experiment, so this IS a result of running it.
 *   - `model-output-unusable` - a provider answered and the answer could not be used
 *     (unparseable output, a testbench that misses acceptance criteria). A reproducible
 *     finding about the model or our prompt.
 *   - `inputs-inadmissible` - setup was refused before any model call, because the inputs
 *     could not admit one (an unapproved Spec, no simulation criteria, an out-of-range seed).
 *     A configuration fact, reproducible by construction.
 *
 * Deliberately REQUIRED. An optional cause would default to absent at every construction
 * site, and absent would have to be read as "not infrastructure" - which is the exact claim
 * that turns a rate-limit burst into 29 measurements.
 */
export type SetupFailureCause =
  'provider-unreachable' | 'budget-exhausted' | 'model-output-unusable' | 'inputs-inadmissible';

/** Setup could not produce a candidate or an independent Testbench (fail safe). */
export interface VerificationSetupFailed {
  readonly status: 'setup-failed';
  readonly reason: 'generation-unavailable' | 'testbench-unavailable';
  /** A short, non-sensitive explanation; never a secret, host, or stack trace. */
  readonly detail: string;
  /** The branchable cause; see `SetupFailureCause` for why `detail` cannot serve. */
  readonly cause: SetupFailureCause;
}

/** The terminal result of a Verification_Loop run. */
export type VerificationOutcome =
  VerifiedModule | UnverifiedModule | VerificationBlocked | VerificationSetupFailed;

/** The prepared, admissible inputs for the iterate phase, or a terminal setup outcome. */
type SetupResult =
  | {
      readonly ok: true;
      readonly firstCandidate: CandidateEval;
      readonly testbench: Testbench;
      /**
       * The spec-derived check names the Testbench MUST report, kept from setup.
       *
       * The oracle reads stdout and cannot know what the run was SUPPOSED to check,
       * so this is the only place that holds both facts. Without it a testbench that
       * reports two of its three checks - both passing - reads as a full pass.
       */
      readonly requiredCheckNames: readonly string[];
    }
  | { readonly ok: false; readonly outcome: VerificationSetupFailed; readonly detail: string };

/**
 * The Verification_Loop (S7).
 *
 * `run` streams progress and returns the terminal `VerificationOutcome`; `verify`
 * drains `run` for callers that do not need streaming. The loop opens the
 * generation context once, runs generation and independent testbench generation in
 * parallel, then iterates simulate -> label-or-repair under one Session_Budget.
 */
export class VerificationLoop {
  readonly #gate: GenerationContextOpener;
  readonly #generator: CandidateGenerator;
  readonly #testbench: IndependentTestbenchGenerator;
  readonly #simulator: SimulatorAdapter;
  readonly #recorder: ActionRecorder;
  readonly #trustLabeler: TrustLabeler;
  readonly #newId: () => Ulid;
  readonly #now: () => number;

  constructor(deps: VerificationLoopDeps) {
    this.#gate = deps.gate;
    this.#generator = deps.generator;
    this.#testbench = deps.testbench;
    this.#simulator = deps.simulator;
    this.#recorder = deps.recorder;
    this.#trustLabeler = deps.trustLabeler;
    this.#newId = deps.newId ?? newUlid;
    this.#now = deps.now ?? Date.now;
  }

  /**
   * Run the generate-simulate-fix loop and stream progress (Req 8.1-8.6, 8.9).
   *
   * Opens the confirmed generation context once (blocking if the gate refuses),
   * runs generation and independent testbench generation in parallel from the
   * approved Spec, then iterates under the Session_Budget until the oracle passes
   * or the budget is exhausted.
   */
  async *run(
    request: GenerationAdmissionRequest,
    budget: SessionBudgetHandle,
    limits: ResourceLimits,
  ): AsyncGenerator<VerificationProgressEvent, VerificationOutcome, void> {
    const admission = await this.#gate.openGenerationContext(request);
    if (!admission.ok) {
      yield this.#progress(0, 'blocked', 'generation gate refused admission');
      return { status: 'blocked', refusal: admission.error };
    }

    const context = admission.value;
    const genInput = toGenerationInput(context);
    yield this.#progress(
      0,
      'setup',
      'generating candidate RTL and the independent testbench in parallel',
    );
    const setup = await this.#setup(context, genInput, budget);
    if (!setup.ok) {
      yield this.#progress(0, 'setup-failed', setup.detail);
      return setup.outcome;
    }

    return yield* this.#iterate(context, genInput, setup, budget, limits);
  }

  /**
   * Drain `run`, discarding intermediate progress, and return only the terminal
   * outcome. Callers that need streaming use `run`.
   */
  async verify(
    request: GenerationAdmissionRequest,
    budget: SessionBudgetHandle,
    limits: ResourceLimits,
  ): Promise<VerificationOutcome> {
    const iterator = this.run(request, budget, limits);
    let step = await iterator.next();
    while (!step.done) {
      step = await iterator.next();
    }
    return step.value;
  }

  /**
   * Run generation (S4) and independent testbench generation (S6) in parallel from
   * the approved Spec (Req 7.1, Property 4), returning the prepared inputs or a
   * terminal setup failure. The testbench request holds no RTL and is built before
   * any candidate exists, so the anti-circular guarantee holds by construction.
   */
  async #setup(
    context: ConfirmedGenerationContext,
    genInput: GenerationInput,
    budget: SessionBudgetHandle,
  ): Promise<SetupResult> {
    const [candidate, testbench] = await Promise.all([
      this.#generator.generateCandidate(genInput, budget),
      this.#testbench.generateTestbench(toTestbenchRequest(context), budget),
    ]);

    if (testbench.status !== 'generated') {
      const detail = describeTestbenchFailure(testbench);
      const cause = testbenchFailureCause(testbench);
      return {
        ok: false,
        detail,
        outcome: { status: 'setup-failed', reason: 'testbench-unavailable', detail, cause },
      };
    }
    if (!candidate.ok) {
      const detail = candidate.error.detail;
      const cause = candidateFailureCause(candidate.error);
      return {
        ok: false,
        detail,
        outcome: { status: 'setup-failed', reason: 'generation-unavailable', detail, cause },
      };
    }
    return {
      ok: true,
      firstCandidate: candidate.value,
      testbench: testbench.testbench,
      requiredCheckNames: testbench.checks.map((check) => check.name),
    };
  }

  /**
   * Iterate simulate -> label-or-repair under the Session_Budget.
   *
   * The candidate we already hold is ALWAYS simulated before any budget check, so a
   * pass discovered on the last affordable run still yields `Verified` (Req 8.9).
   * Only the repair step is gated on remaining budget; a non-pass with no budget
   * left ends the loop with the failing case labeled `Unverified` (Req 8.4, 8.5).
   */
  async *#iterate(
    context: ConfirmedGenerationContext,
    genInput: GenerationInput,
    setup: Extract<SetupResult, { ok: true }>,
    budget: SessionBudgetHandle,
    limits: ResourceLimits,
  ): AsyncGenerator<VerificationProgressEvent, VerificationOutcome, void> {
    const moduleName = genInput.spec.moduleInterface.moduleName;
    const testbench = setup.testbench;
    const testbenchFile = toTestbenchFile(testbench, moduleName);
    let candidateEval = setup.firstCandidate;
    let iteration = 0;

    while (true) {
      iteration += 1;
      const candidate = candidateEval.candidate;
      yield this.#progress(
        iteration,
        'simulating',
        'compiling and simulating the candidate against the independent testbench',
      );
      const simulation = await this.#simulate(candidate, moduleName, testbenchFile, limits);
      const span = await this.#recordVerdict(context.sessionId, candidate, simulation, iteration);
      budget.charge(simulateCost(simulation));

      if (simulation.verdict === 'pass') {
        const unreported = missingCheckNames(simulation.checks, setup.requiredCheckNames);
        if (unreported.length > 0) {
          yield this.#progress(
            iteration,
            'exhausted',
            'the oracle passed on incomplete evidence; failing closed',
            simulation.verdict,
          );
          return this.#incompleteEvidence(
            { context, candidate, testbench, simulation, span, iteration },
            unreported,
          );
        }
        yield this.#progress(iteration, 'verified', 'oracle reported every check passing', 'pass');
        return this.#onPass(candidate, testbench, simulation, span, iteration);
      }

      const failingCase = failingCaseOf(simulation);
      if (!budget.canAfford()) {
        yield this.#progress(
          iteration,
          'exhausted',
          'budget exhausted without an oracle pass',
          simulation.verdict,
        );
        return this.#unverified(
          context,
          candidate,
          testbench,
          simulation,
          span,
          failingCase,
          iteration,
          budget.stopReason() ?? 'max-iterations',
        );
      }

      yield this.#progress(
        iteration,
        'repairing',
        'oracle did not pass; repairing RTL from the simulator output',
        simulation.verdict,
      );
      const revised = await this.#generator.reviseFromErrors(
        genInput,
        candidate.rtl,
        repairDiagnostics(candidateEval, simulation),
        budget,
      );
      if (!revised.ok) {
        const stopReason =
          revised.error.budgetStopReason ?? budget.stopReason() ?? 'max-iterations';
        yield this.#progress(
          iteration,
          'exhausted',
          'repair unavailable; presenting the failing case as Unverified',
          simulation.verdict,
        );
        return this.#unverified(
          context,
          candidate,
          testbench,
          simulation,
          span,
          failingCase,
          iteration,
          stopReason,
        );
      }
      candidateEval = revised.value;
    }
  }

  /**
   * Request `Verified` from the Trust_Labeler bound to the passing oracle span
   * (Req 8.3, 8.9, 14.2, 14.8). Fails closed: if the passing result cannot be
   * constructed or the labeler declines to bind provenance, the module is presented
   * `Unverified` rather than `Verified` without valid evidence (Req 14.8, 14.12).
   */
  #onPass(
    candidate: GeneratedCandidate,
    testbench: Testbench,
    simulation: SimulationVerdict,
    span: TraceSpan,
    iteration: number,
  ): VerificationOutcome {
    const built = makeVerificationResult({
      id: this.#newId(),
      moduleVersionId: candidate.moduleVersion.id,
      testbenchId: testbench.id,
      verdict: 'pass',
      allChecksPassed: true,
      iterations: iteration,
      costCents: 0,
      oracleSpanId: span.id,
    });
    if (!built.ok) {
      return this.#failClosed(candidate, testbench, simulation, span, iteration);
    }

    const artifactRef = candidate.label.artifactRef;
    const label = this.#trustLabeler.label(artifactRef, [{ artifactRef, result: built.value }]);
    if (label.tier !== 'Verified') {
      return this.#failClosed(candidate, testbench, simulation, span, iteration);
    }
    return {
      status: 'verified',
      label,
      result: built.value,
      moduleVersion: candidate.moduleVersion,
      testbench,
      simulation,
      oracleSpanId: span.id,
      iterations: iteration,
    };
  }

  /**
   * Build the `Unverified` exhaustion outcome: the last failing candidate, its
   * failing case, and the Teach_Mode handoff seam (Req 8.5).
   */
  #unverified(
    context: ConfirmedGenerationContext,
    candidate: GeneratedCandidate,
    testbench: Testbench,
    simulation: SimulationVerdict,
    span: TraceSpan,
    failingCase: FailingCase | null,
    iteration: number,
    stopReason: BudgetStopReason,
  ): UnverifiedModule {
    const result = nonPassResult({
      id: this.#newId(),
      moduleVersionId: candidate.moduleVersion.id,
      testbenchId: testbench.id,
      verdict: simulation.verdict === 'pass' ? 'error' : simulation.verdict,
      failingCase,
      iterations: iteration,
      oracleSpanId: span.id,
      stopReason,
    });
    const teachMode: TeachModeHandoff = {
      sessionId: context.sessionId,
      specId: context.approvedSpec.id,
      moduleVersionId: candidate.moduleVersion.id,
      failingCase,
      diagnostics: studentDiagnostics(simulation),
      stopReason,
    };
    return {
      status: 'unverified',
      label: unverified(candidate.label.artifactRef),
      result,
      candidate,
      testbench,
      simulation,
      failingCase,
      stopReason,
      iterations: iteration,
      teachMode,
    };
  }

  /**
   * The fail-closed outcome for the (near-impossible) case where a passing run
   * cannot be bound to valid oracle provenance: never present it as `Verified`.
   */
  #failClosed(
    candidate: GeneratedCandidate,
    testbench: Testbench,
    simulation: SimulationVerdict,
    span: TraceSpan,
    iteration: number,
  ): UnverifiedModule {
    return this.#refusePass({
      sessionId: candidate.moduleVersion.projectId,
      specId: testbench.specId,
      candidate,
      testbench,
      simulation,
      span,
      iteration,
      failingCase: {
        checkName: 'provenance',
        description: 'A passing run could not be bound to a valid oracle provenance reference.',
        expected: 'a Verified label bound to the recorded passing oracle span',
        observed: 'the passing verdict could not be labeled Verified; failing closed',
        atSimTimeNs: null,
      },
      diagnostics: 'Verification could not confirm provenance for a passing run.',
    });
  }

  /**
   * The fail-closed outcome for a run the oracle passed on INCOMPLETE evidence:
   * the testbench never reported one or more of the checks the Spec required.
   *
   * The oracle reads standard output, so it can only judge the checks the run
   * actually printed; it cannot know which ones were owed. A required check that
   * printed nothing was not verified, and accepting the remaining passes as a full
   * pass is the same class of defect as ignoring an unreadable signal. So the
   * verdict is refused here rather than repaired: the Testbench is fixed for the
   * whole run, so a check the instrument did not report is an instrument gap, and
   * revising the RTL is not its remedy.
   *
   * The unreported NAMES are safe to surface: they are spec-derived check names
   * this process computed itself, never text read back from tool output.
   */
  #incompleteEvidence(
    run: {
      readonly context: ConfirmedGenerationContext;
      readonly candidate: GeneratedCandidate;
      readonly testbench: Testbench;
      readonly simulation: SimulationVerdict;
      readonly span: TraceSpan;
      readonly iteration: number;
    },
    unreportedChecks: readonly string[],
  ): UnverifiedModule {
    const named = unreportedChecks.join(', ');
    return this.#refusePass({
      sessionId: run.context.sessionId,
      specId: run.context.approvedSpec.id,
      candidate: run.candidate,
      testbench: run.testbench,
      simulation: run.simulation,
      span: run.span,
      iteration: run.iteration,
      failingCase: {
        checkName: unreportedChecks[0] ?? 'coverage',
        description: `The testbench reported no result for required check(s): ${named}.`,
        expected: 'every spec-derived check to report PASS or FAIL',
        observed: 'the run passed the checks it reported but never reported these',
        atSimTimeNs: null,
      },
      diagnostics: `Required checks the simulation never reported: ${named}.`,
    });
  }

  /**
   * The single owner of the refuse-a-pass shape: an `Unverified` outcome for a run
   * whose oracle verdict was `pass` but whose evidence we decline to accept.
   *
   * Both refusal reasons (unbindable provenance, incomplete check coverage) build
   * the identical outcome, so the shape is defined once and the two callers differ
   * only in the failing case and diagnostics they supply.
   */
  #refusePass(refusal: RefusedPass): UnverifiedModule {
    const { candidate, testbench, simulation, span, iteration, failingCase } = refusal;
    const result = nonPassResult({
      id: this.#newId(),
      moduleVersionId: candidate.moduleVersion.id,
      testbenchId: testbench.id,
      verdict: 'error',
      failingCase,
      iterations: iteration,
      oracleSpanId: span.id,
      stopReason: 'max-iterations',
    });
    return {
      status: 'unverified',
      label: unverified(candidate.label.artifactRef),
      result,
      candidate,
      testbench,
      simulation,
      failingCase,
      stopReason: 'max-iterations',
      iterations: iteration,
      teachMode: {
        sessionId: refusal.sessionId,
        specId: refusal.specId,
        moduleVersionId: candidate.moduleVersion.id,
        failingCase,
        diagnostics: refusal.diagnostics,
        stopReason: 'max-iterations',
      },
    };
  }

  /** Compile and simulate one candidate against the Testbench, failing safe on any throw. */
  async #simulate(
    candidate: GeneratedCandidate,
    moduleName: string,
    testbenchFile: SourceFile,
    limits: ResourceLimits,
  ): Promise<SimulationVerdict> {
    // Use the trusted Spec module name for the workspace path, never the untrusted
    // parsed name, so model output can never influence a file path.
    const rtl: readonly SourceFile[] = [{ path: `${moduleName}.v`, contents: candidate.rtl }];
    try {
      return await this.#simulator.simulate(rtl, testbenchFile, limits);
    } catch {
      // A sandbox capture/contract failure is exceptional; classify it `error` and
      // never let it crash the loop (fail safe, Req 8.7).
      return toolFailureVerdict();
    }
  }

  /** Record one oracle verdict span (verdict, iteration, cost) in the Trace (Req 8.8). */
  #recordVerdict(
    sessionId: Ulid,
    candidate: GeneratedCandidate,
    simulation: SimulationVerdict,
    iteration: number,
  ): Promise<TraceSpan> {
    const startedAtMs = this.#now();
    const outputs: Json = {
      stage: VERIFICATION_STAGE,
      verdict: simulation.verdict,
      iteration,
      moduleVersionId: candidate.moduleVersion.id,
      checks: simulation.checks.map((check) => ({ name: check.name, passed: check.passed })),
      vcdCaptured: simulation.vcd !== null,
    };
    const base: SpanDraft = {
      sessionId,
      stageOrTool: VERIFICATION_STAGE,
      inputs: { stage: VERIFICATION_STAGE, moduleVersionId: candidate.moduleVersion.id, iteration },
      outputs,
      exitCode: simulation.exitCode,
      startedAt: new Date(startedAtMs).toISOString(),
      durationMs: Math.max(0, simulation.resourceUsage.wallMs),
      retryCount: 0,
      costCents: 0,
    };
    const failureClass = verdictFailureClass(simulation.verdict);
    return this.#recorder.record(failureClass === undefined ? base : { ...base, failureClass });
  }

  /** Build a progress event, carrying a verdict only when one is reported. */
  #progress(
    iteration: number,
    phase: VerificationPhase,
    message: string,
    verdict?: Verdict,
  ): VerificationProgressEvent {
    return verdict === undefined
      ? { kind: 'progress', iteration, phase, message }
      : { kind: 'progress', iteration, phase, verdict, message };
  }
}

/**
 * One refusal to accept an oracle `pass` as `Verified`, and the evidence for it.
 *
 * Grouped as a value so the shared refusal path takes one parameter instead of
 * seven, and so a new refusal reason has to state its failing case and its
 * student-facing diagnostics rather than inheriting another reason's wording.
 */
interface RefusedPass {
  readonly sessionId: Ulid;
  readonly specId: Ulid;
  readonly candidate: GeneratedCandidate;
  readonly testbench: Testbench;
  readonly simulation: SimulationVerdict;
  readonly span: TraceSpan;
  readonly iteration: number;
  readonly failingCase: FailingCase;
  /** Sanitized, student-facing explanation; never a path, host, or tool message. */
  readonly diagnostics: string;
}

/** The fields for a non-passing verification result. */
interface NonPassResultInput {
  readonly id: Ulid;
  readonly moduleVersionId: Ulid;
  readonly testbenchId: Ulid;
  readonly verdict: Exclude<Verdict, 'pass'>;
  readonly failingCase: FailingCase | null;
  readonly iterations: number;
  readonly oracleSpanId: Ulid;
  readonly stopReason: BudgetStopReason;
}

/**
 * Build a non-passing `VerificationResult` directly.
 *
 * Pass integrity (Req 8.10) is vacuously satisfied for a non-`pass` verdict, so
 * `makeVerificationResult` (which validates the pass case) is intentionally not
 * used here; the discriminated union in core guarantees the fields are well-typed.
 * Cost is recorded per step on the agents' own Trace spans; the loop's rollup is
 * the tool cost it observes (zero for a simulate run).
 */
function nonPassResult(input: NonPassResultInput): VerificationResult {
  const base = {
    id: input.id,
    moduleVersionId: input.moduleVersionId,
    testbenchId: input.testbenchId,
    verdict: input.verdict,
    allChecksPassed: false,
    iterations: input.iterations,
    costCents: 0,
    oracleSpanId: input.oracleSpanId,
    stopReason: input.stopReason,
  };
  return input.failingCase === null ? base : { ...base, failingCase: input.failingCase };
}

/** The synthesized `SimulationVerdict` for a run that threw before the oracle spoke. */
function toolFailureVerdict(): SimulationVerdict {
  return {
    verdict: 'error',
    checks: [],
    vcd: null,
    stdout: '',
    stderr: '',
    exitCode: null,
    resourceUsage: { wallMs: 0, maxMemMb: 0, cpuMs: 0 },
  };
}

/** The failure classification recorded for a non-passing verdict (Req 3.4, 8.7). */
function verdictFailureClass(verdict: Verdict): SpanDraft['failureClass'] {
  if (verdict === 'fail') {
    return 'functional-fail';
  }
  if (verdict === 'error') {
    return 'tool-error';
  }
  return undefined;
}

/** The generation input derived from the confirmed context (the approved Spec). */
function toGenerationInput(context: ConfirmedGenerationContext): GenerationInput {
  return { sessionId: context.sessionId, projectId: context.projectId, spec: context.approvedSpec };
}

/** The RTL-free testbench request derived from the approved Spec + confirmed intent. */
function toTestbenchRequest(context: ConfirmedGenerationContext): GenerateTestbenchRequest {
  return {
    sessionId: context.sessionId,
    spec: context.approvedSpec,
    intentSummary: context.confirmedIntent.summary,
  };
}

/** The testbench workspace file, named from the trusted Spec module name. */
function toTestbenchFile(testbench: Testbench, moduleName: string): SourceFile {
  return { path: `${moduleName}_tb.v`, contents: testbench.source };
}

/** Charge one simulate iteration: no model tokens/cost, the run's wall clock. */
function simulateCost(simulation: SimulationVerdict): AttemptCost {
  return { tokens: 0, costCents: 0, wallClockMs: Math.max(0, simulation.resourceUsage.wallMs) };
}

/** The first failing check as a failing case, or an error-run case, else `null`. */
function failingCaseOf(simulation: SimulationVerdict): FailingCase | null {
  const failed = simulation.checks.find((check) => !check.passed);
  if (failed !== undefined) {
    return {
      checkName: failed.name,
      description: `Spec-derived check "${failed.name}" did not pass.`,
      expected: 'the check to report PASS',
      observed: 'the check reported FAIL',
      atSimTimeNs: null,
    };
  }
  if (simulation.verdict === 'error') {
    return {
      checkName: 'simulation',
      description: 'The simulation did not complete a passing run.',
      expected: 'a completed simulation with every spec-derived check passing',
      observed: 'the run classified as error (tool or infrastructure failure)',
      atSimTimeNs: null,
    };
  }
  return null;
}

/** Sanitized, student-facing diagnostics for a non-passing run (no paths/hosts). */
function studentDiagnostics(simulation: SimulationVerdict): string {
  const failed = simulation.checks.filter((check) => !check.passed).map((check) => check.name);
  if (failed.length > 0) {
    return `Failing spec-derived checks: ${failed.join(', ')}.`;
  }
  return 'The simulation did not complete a passing run.';
}

/**
 * Richer repair diagnostics for the Generation_Agent: interface deviations, failing
 * check names, and the simulator streams. This feeds the model's next revision and
 * is redacted by the Action_Recorder before any of it is persisted.
 */
function repairDiagnostics(candidateEval: CandidateEval, simulation: SimulationVerdict): string {
  const parts: string[] = [];
  if (candidateEval.interfaceDiagnostics.length > 0) {
    parts.push(candidateEval.interfaceDiagnostics);
  }
  const failed = simulation.checks.filter((check) => !check.passed).map((check) => check.name);
  if (failed.length > 0) {
    parts.push(`Failing checks: ${failed.join(', ')}`);
  }
  const stderr = simulation.stderr.trim();
  const stdout = simulation.stdout.trim();
  if (stderr.length > 0) {
    parts.push(stderr);
  } else if (stdout.length > 0) {
    parts.push(stdout);
  }
  if (parts.length === 0) {
    parts.push('The simulation did not report a passing run.');
  }
  return parts.join('\n');
}

/** A short, non-sensitive reason a testbench outcome was not a produced Testbench. */
function describeTestbenchFailure(outcome: TestbenchGenerationOutcome): string {
  if (outcome.status === 'coverage-incomplete') {
    return 'The independent testbench did not cover every acceptance criterion.';
  }
  if (outcome.status === 'generation-failed') {
    return outcome.failure.detail;
  }
  return 'The independent testbench could not be produced.';
}

/**
 * What a Model_Router failure means for a measurement (pure, total).
 *
 * The one place the router's terminal codes are turned into the infrastructure/finding
 * distinction, so both halves of setup classify an outage identically. `undefined` means a
 * `model-call-failed` that carried no typed failure, which only an older or hand-built
 * collaborator produces; it resolves to `provider-unreachable` because "the model call failed
 * and we cannot say the caps did it" is not evidence about the model.
 */
const ROUTER_FAILURE_CAUSE: Readonly<Record<ModelRouterFailureCode, SetupFailureCause>> = {
  ALL_PROVIDERS_FAILED: 'provider-unreachable',
  BUDGET_EXHAUSTED: 'budget-exhausted',
};

/** The setup cause a router failure implies, defaulting to the infrastructure reading. */
function routerFailureCause(failure: ModelRouterFailure | undefined): SetupFailureCause {
  return failure === undefined ? 'provider-unreachable' : ROUTER_FAILURE_CAUSE[failure.code];
}

/**
 * Classify a non-`generated` testbench outcome (pure, total).
 *
 * Keyed off the failure's own closed `reason` union through an exhaustive table, so a reason
 * added to the Testbench_Agent cannot ship without deciding whether it is infrastructure or a
 * finding. `coverage-incomplete` is a FINDING: the model answered and its answer did not cover
 * the criteria, which is reproducible and is exactly the signal the Testbench_Agent is
 * measured on.
 */
function testbenchFailureCause(outcome: TestbenchGenerationOutcome): SetupFailureCause {
  if (outcome.status !== 'generation-failed') {
    return 'model-output-unusable';
  }
  const { reason, routerFailure } = outcome.failure;
  const table: Readonly<Record<TestbenchGenerationFailureReason, SetupFailureCause>> = {
    'spec-not-approved': 'inputs-inadmissible',
    'no-simulation-criteria': 'inputs-inadmissible',
    'model-call-failed': routerFailureCause(routerFailure),
    'unparseable-output': 'model-output-unusable',
  };
  return table[reason];
}

/** Classify a candidate-generation failure (pure, total), by the same rule. */
function candidateFailureCause(failure: CandidateFailure): SetupFailureCause {
  return failure.reason === 'model-unavailable'
    ? routerFailureCause(failure.routerFailure)
    : 'model-output-unusable';
}
