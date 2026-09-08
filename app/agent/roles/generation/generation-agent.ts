// The Generation_Agent (S4): generate candidate Verilog implementing the Spec
// Module_Interface EXACTLY, route generation/repair through the Model_Router under
// the threaded Session_Budget, read compiler errors and revise within the budget,
// stream progress without blocking, and on budget exhaustion present the last
// failing candidate labeled `Unverified` (Requirements 6.1-6.7, 17.6).
//
// Collaborator seams are injected (no globals, no direct provider calls): model
// calls go through the `ModelRouter`; compilation goes through the narrow
// `CandidateCompiler` port (decoupled from the independent testbench and the pass
// verdict); every action is recorded through the `ActionRecorder`. Model output is
// untrusted: it is shaped (`parseCandidateRtl`) and the interface is derived from
// the RTL itself and checked against the Spec (`checkInterfaceExact`) before a
// candidate is ever presented.
//
// The seam is deliberately clean: this agent produces candidates and revises them
// against COMPILER errors. It NEVER assigns a pass verdict and NEVER labels a
// candidate `Verified`; only the Verification_Loop's oracle decides pass (Req 6.6).
// `generateCandidate` and `reviseFromErrors` are the primitives a driving loop
// (the Verification_Loop, task 14) can call; `run` is the self-contained bounded
// loop that streams progress and returns the terminal outcome.

import {
  newUlid,
  ok,
  err,
  oracleTrustLabeler,
  type ArtifactRef,
  type BudgetStopReason,
  type Json,
  type ModuleVersion,
  type Result,
  type Ulid,
} from '@app/core';
import type { SourceFile } from '@app/tools';

import type { ActionRecorder, SpanDraft } from '../../action-recorder/index.js';
import type {
  ModelRequest,
  ModelRouter,
  ModelRouterFailure,
  ModelTask,
  SessionBudgetHandle,
} from '../../model-router/index.js';

import {
  checkInterfaceExact,
  describeInterfaceMismatch,
  parseModuleInterface,
} from './interface-check.js';
import { parseCandidateRtl } from './model-output.js';
import { buildGenerationPrompt, buildRepairPrompt } from './prompt.js';
import type {
  CandidateCompiler,
  CandidateEval,
  CandidateFailure,
  GeneratedCandidate,
  GenerationInput,
  GenerationOutcome,
  GenerationPhase,
  GenerationProgressEvent,
  InterfaceMatch,
  ParsedInterface,
} from './types.js';

/** The Trace `stageOrTool` name recorded for every Generation_Agent action. */
const GENERATION_STAGE = 'Generation_Agent' as const;

/** The Model_Router task for a first-attempt generation call (Req 6.2). */
const GENERATION_TASK: ModelTask = 'generation';

/** The Model_Router task for a revision call driven by compiler/interface errors (Req 6.2, 6.3). */
const REPAIR_TASK: ModelTask = 'repair';

/**
 * The Model_Router task that escalates a repair to the fallback model class
 * (Claude, Req 12.4). Used by the self-healing loop's `fallback-model` recovery so
 * it routes through the router's EXISTING escalation path, never an ad-hoc retry.
 */
const FALLBACK_MODEL_TASK: ModelTask = 'hard-planning';

/** The interface parsed for a candidate whose module header could not be read at all. */
const UNREADABLE_INTERFACE: ParsedInterface = { moduleName: '', ports: [] };

/** The injected collaborators and deterministic seams for the Generation_Agent. */
export interface GenerationAgentDeps {
  readonly router: ModelRouter;
  /** The compile-and-diagnostics seam the agent revises against (Req 6.2, 6.3). */
  readonly compiler: CandidateCompiler;
  readonly recorder: ActionRecorder;
  /** ULID source for module-version ids; defaults to `newUlid`. */
  readonly newId?: () => Ulid;
  /** Wall-clock source for timestamps and span timing; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * The Generation_Agent (S4).
 *
 * `run` is the bounded generate-compile-revise loop: it streams progress events and
 * returns the terminal `GenerationOutcome`. `generateCandidate` and
 * `reviseFromErrors` are the model-backed primitives a driver can call directly;
 * both enforce the exact-interface check and treat model output as untrusted.
 */
export class GenerationAgent {
  readonly #router: ModelRouter;
  readonly #compiler: CandidateCompiler;
  readonly #recorder: ActionRecorder;
  readonly #newId: () => Ulid;
  readonly #now: () => number;

  constructor(deps: GenerationAgentDeps) {
    this.#router = deps.router;
    this.#compiler = deps.compiler;
    this.#recorder = deps.recorder;
    this.#newId = deps.newId ?? newUlid;
    this.#now = deps.now ?? Date.now;
  }

  /**
   * Generate a first candidate from the approved Spec (Req 6.1, 6.4).
   *
   * Routes one `generation` call under the budget, shapes the untrusted reply, and
   * derives the module interface from the RTL to check it against the Spec exactly.
   * A produced candidate is returned even when its interface deviates (that is a
   * defect to revise); only a model failure or unparseable output is an error.
   */
  generateCandidate(
    input: GenerationInput,
    budget: SessionBudgetHandle,
  ): Promise<Result<CandidateEval, CandidateFailure>> {
    return this.#produce(input, GENERATION_TASK, buildGenerationPrompt(input), budget);
  }

  /**
   * Revise a previous candidate against compiler (or interface) errors (Req 6.3).
   *
   * Routes one `repair` call under the budget, carrying the previous RTL and the
   * diagnostics to resolve, then re-checks the exact interface on the result.
   */
  reviseFromErrors(
    input: GenerationInput,
    previousRtl: string,
    diagnostics: string,
    budget: SessionBudgetHandle,
  ): Promise<Result<CandidateEval, CandidateFailure>> {
    return this.#produce(
      input,
      REPAIR_TASK,
      buildRepairPrompt(input, previousRtl, diagnostics),
      budget,
    );
  }

  /**
   * Revise a candidate by escalating the repair to the Model_Router's fallback
   * model class (Claude, Req 12.4, 12.5).
   *
   * This is the `fallback-model` recovery the self-healing loop (task 14.3) calls
   * when a targeted fix or re-plan on the primary model did not recover. It routes
   * through the router's EXISTING escalation path (task `hard-planning`) rather than
   * a new ad-hoc provider retry, then re-checks the exact interface on the result.
   */
  reviseWithFallbackModel(
    input: GenerationInput,
    previousRtl: string,
    diagnostics: string,
    budget: SessionBudgetHandle,
  ): Promise<Result<CandidateEval, CandidateFailure>> {
    const prompt = buildRepairPrompt(input, previousRtl, diagnostics);
    return this.#produce(input, FALLBACK_MODEL_TASK, prompt, budget);
  }

  /**
   * Run the bounded generate-compile-revise loop and stream progress (Req 6.7, 17.6).
   *
   * Yields a `GenerationProgressEvent` at each step and returns the terminal
   * outcome: a compiling, interface-exact candidate ready for verification; the last
   * failing candidate labeled `Unverified` on budget exhaustion (Req 6.5); or a
   * fail-safe error when no candidate could be produced. The loop is bounded because
   * every attempt routes exactly one model call, which the Model_Router charges
   * against the Session_Budget until a cap stops it.
   */
  async *run(
    input: GenerationInput,
    budget: SessionBudgetHandle,
  ): AsyncGenerator<GenerationProgressEvent, GenerationOutcome, void> {
    if (!input.spec.approved) {
      return {
        status: 'generation-failed',
        reason: 'spec-not-approved',
        detail: 'Generation is gated on an approved Spec.',
        iterations: 0,
      };
    }

    let iterations = 0;
    let lastCandidate: GeneratedCandidate | null = null;
    let lastDiagnostics = '';

    while (true) {
      if (!budget.canAfford()) {
        return this.#exhausted(
          budget,
          lastCandidate,
          lastDiagnostics,
          iterations,
          budget.stopReason(),
        );
      }

      const repairing: boolean = lastCandidate !== null;
      yield this.#progress(iterations, repairing ? 'revising' : 'generating');
      const produced: Result<CandidateEval, CandidateFailure> =
        lastCandidate !== null
          ? await this.reviseFromErrors(input, lastCandidate.rtl, lastDiagnostics, budget)
          : await this.generateCandidate(input, budget);
      iterations += 1;

      if (!produced.ok) {
        const terminal = this.#classifyProductionFailure(
          produced.error,
          budget,
          lastCandidate,
          lastDiagnostics,
          iterations,
        );
        if (terminal !== null) {
          return terminal;
        }
        lastDiagnostics = `The previous reply was not the required JSON envelope: ${produced.error.detail}`;
        continue;
      }

      lastCandidate = produced.value.candidate;
      if (produced.value.interfaceDiagnostics.length > 0) {
        lastDiagnostics = produced.value.interfaceDiagnostics;
        yield this.#progress(
          iterations,
          'checking-interface',
          'interface does not match the Spec; revising',
        );
        continue;
      }

      yield this.#progress(iterations, 'compiling');
      const compiled = await this.#compileCandidate(input, produced.value.candidate);
      if (compiled.compiled) {
        return {
          status: 'ready-for-verification',
          candidate: produced.value.candidate,
          iterations,
        };
      }
      lastDiagnostics = compiled.diagnostics;
    }
  }

  /**
   * Convenience driver that drains `run`, discarding intermediate progress, and
   * returns only the terminal outcome. Callers that need streaming use `run`.
   */
  async generate(input: GenerationInput, budget: SessionBudgetHandle): Promise<GenerationOutcome> {
    const iterator = this.run(input, budget);
    let step = await iterator.next();
    while (!step.done) {
      step = await iterator.next();
    }
    return step.value;
  }

  /** Route one model call, shape the untrusted reply, and evaluate the candidate. */
  async #produce(
    input: GenerationInput,
    task: ModelTask,
    prompt: string,
    budget: SessionBudgetHandle,
  ): Promise<Result<CandidateEval, CandidateFailure>> {
    const startedAtMs = this.#now();
    const request: ModelRequest = { prompt };
    const routed = await this.#router.invoke(task, request, budget);
    if (!routed.ok) {
      await this.#recordFailure(
        input.sessionId,
        task,
        startedAtMs,
        0,
        routerFailureReason(routed.error),
      );
      return err(this.#toModelFailure(routed.error));
    }

    const rtlResult = parseCandidateRtl(routed.value.outputText);
    if (!rtlResult.ok) {
      await this.#recordFailure(
        input.sessionId,
        task,
        startedAtMs,
        routed.value.costCents,
        rtlResult.error.reason,
      );
      return err({ reason: 'unparseable', detail: rtlResult.error.reason });
    }

    const evaluated = this.#evaluate(input, rtlResult.value);
    await this.#recordProduction(
      input.sessionId,
      task,
      startedAtMs,
      routed.value.costCents,
      evaluated,
    );
    return ok(evaluated);
  }

  /** Build a candidate from RTL: derive its interface, check exactness, label it `Unverified`. */
  #evaluate(input: GenerationInput, rtl: string): CandidateEval {
    const parsed = parseModuleInterface(rtl);
    if (!parsed.ok) {
      const match = checkInterfaceExact(input.spec.moduleInterface, UNREADABLE_INTERFACE);
      return {
        candidate: this.#buildCandidate(input, rtl, UNREADABLE_INTERFACE, match),
        interfaceDiagnostics: parsed.error.reason,
      };
    }
    const match = checkInterfaceExact(input.spec.moduleInterface, parsed.value);
    return {
      candidate: this.#buildCandidate(input, rtl, parsed.value, match),
      interfaceDiagnostics: match.matches ? '' : describeInterfaceMismatch(match),
    };
  }

  /** Persist a `ModuleVersion` view and label it via the oracle Trust_Labeler (always `Unverified`). */
  #buildCandidate(
    input: GenerationInput,
    rtl: string,
    parsedInterface: ParsedInterface,
    interfaceMatch: InterfaceMatch,
  ): GeneratedCandidate {
    const id = this.#newId();
    const moduleVersion: ModuleVersion = {
      id,
      projectId: input.projectId,
      specVersion: input.spec.version,
      rtl,
      createdAt: new Date(this.#now()).toISOString(),
    };
    const artifactRef: ArtifactRef = { kind: 'module-version', id, version: 1 };
    // No passing oracle evidence exists yet, so the labeler yields `Unverified`
    // (Req 6.6, 14.3). Only the Verification_Loop can later produce `Verified`.
    const label = oracleTrustLabeler.label(artifactRef, []);
    return { rtl, parsedInterface, interfaceMatch, moduleVersion, label };
  }

  /** Write the candidate RTL to the sandbox workspace and compile it (Req 6.3). */
  async #compileCandidate(
    input: GenerationInput,
    candidate: GeneratedCandidate,
  ): Promise<{ compiled: boolean; diagnostics: string }> {
    // Use the trusted Spec module name for the workspace path, never the untrusted
    // parsed name, so model output can never influence a file path.
    const file: SourceFile = {
      path: `${input.spec.moduleInterface.moduleName}.v`,
      contents: candidate.rtl,
    };
    const startedAtMs = this.#now();
    const outcome = await this.#compiler.compile([file]);
    await this.#recordCompile(input.sessionId, startedAtMs, outcome.compiled);
    return outcome;
  }

  /**
   * Classify a production failure into a terminal outcome, or `null` when the loop
   * should retry (an unparseable reply is retried within the budget).
   */
  #classifyProductionFailure(
    failure: CandidateFailure,
    budget: SessionBudgetHandle,
    lastCandidate: GeneratedCandidate | null,
    lastDiagnostics: string,
    iterations: number,
  ): GenerationOutcome | null {
    if (failure.reason === 'model-unavailable') {
      if (failure.budgetStopReason !== undefined) {
        return this.#exhausted(
          budget,
          lastCandidate,
          lastDiagnostics,
          iterations,
          failure.budgetStopReason,
        );
      }
      return {
        status: 'generation-failed',
        reason: 'model-unavailable',
        detail: failure.detail,
        iterations,
      };
    }
    return null;
  }

  /** Assemble the budget-exhaustion outcome: last failing candidate, labeled `Unverified` (Req 6.5). */
  #exhausted(
    budget: SessionBudgetHandle,
    lastCandidate: GeneratedCandidate | null,
    lastDiagnostics: string,
    iterations: number,
    stopReason: BudgetStopReason | null,
  ): GenerationOutcome {
    return {
      status: 'budget-exhausted',
      candidate: lastCandidate,
      diagnostics: lastDiagnostics,
      stopReason: stopReason ?? budget.stopReason() ?? 'max-iterations',
      iterations,
    };
  }

  /**
   * Map a redacted Model_Router failure to a sanitized candidate failure.
   *
   * The whole failure travels on `routerFailure`, not only its code flattened into
   * `detail`. A consumer deciding whether this was an infrastructure gap or a measurement
   * must read a typed value; parsing it back out of the note string would make an operator
   * message load-bearing.
   */
  #toModelFailure(failure: ModelRouterFailure): CandidateFailure {
    const base: CandidateFailure = {
      reason: 'model-unavailable',
      detail: failure.code,
      routerFailure: failure,
    };
    return failure.budgetStopReason === undefined
      ? base
      : { ...base, budgetStopReason: failure.budgetStopReason };
  }

  /** Build a progress event with a default or explicit message. */
  #progress(iteration: number, phase: GenerationPhase, message?: string): GenerationProgressEvent {
    return { kind: 'progress', iteration, phase, message: message ?? DEFAULT_MESSAGES[phase] };
  }

  /** Record a successful production attempt as an ordered, sanitized span. */
  #recordProduction(
    sessionId: Ulid,
    task: ModelTask,
    startedAtMs: number,
    costCents: number,
    evaluated: CandidateEval,
  ): Promise<void> {
    const { candidate } = evaluated;
    const outputs: Json = {
      stage: GENERATION_STAGE,
      task,
      moduleName: candidate.parsedInterface.moduleName,
      portCount: candidate.parsedInterface.ports.length,
      interfaceMatches: candidate.interfaceMatch.matches,
      trustTier: candidate.label.tier,
    };
    return this.#record(sessionId, startedAtMs, costCents, outputs);
  }

  /** Record the outcome of a compile run as a span. */
  #recordCompile(sessionId: Ulid, startedAtMs: number, compiled: boolean): Promise<void> {
    const outputs: Json = { stage: GENERATION_STAGE, phase: 'compiling', compiled };
    return compiled
      ? this.#record(sessionId, startedAtMs, 0, outputs)
      : this.#record(sessionId, startedAtMs, 0, outputs, 'compile-error');
  }

  /** Record a failed production attempt (model unavailable or unparseable output). */
  #recordFailure(
    sessionId: Ulid,
    task: ModelTask,
    startedAtMs: number,
    costCents: number,
    reason: string,
  ): Promise<void> {
    const outputs: Json = { stage: GENERATION_STAGE, task, outcome: 'failure', reason };
    return this.#record(sessionId, startedAtMs, costCents, outputs, 'tool-error');
  }

  /** Append one sanitized Generation_Agent span; the recorder redacts and orders it. */
  async #record(
    sessionId: Ulid,
    startedAtMs: number,
    costCents: number,
    outputs: Json,
    failureClass?: SpanDraft['failureClass'],
  ): Promise<void> {
    const base: SpanDraft = {
      sessionId,
      stageOrTool: GENERATION_STAGE,
      inputs: { stage: GENERATION_STAGE },
      outputs,
      exitCode: null,
      startedAt: new Date(startedAtMs).toISOString(),
      durationMs: Math.max(0, this.#now() - startedAtMs),
      retryCount: 0,
      costCents,
    };
    const draft = failureClass === undefined ? base : { ...base, failureClass };
    await this.#recorder.record(draft);
  }
}

/** Default, non-sensitive progress messages per phase. */
const DEFAULT_MESSAGES: Readonly<Record<GenerationPhase, string>> = {
  generating: 'generating candidate RTL',
  revising: 'revising candidate against errors',
  'checking-interface': 'checking the module interface against the Spec',
  compiling: 'compiling the candidate',
};

/** A short, non-sensitive reason string for a router failure, for the Trace. */
function routerFailureReason(failure: ModelRouterFailure): string {
  return failure.code;
}
