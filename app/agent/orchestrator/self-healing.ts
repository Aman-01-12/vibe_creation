// The self-healing failure-recovery loop (S7 recovery layer; design "Error
// Handling (self-healing loop)"; Req 8.4, 12.5; `ECE-RELIABILITY-SELFHEALING.md`).
//
// This loop wires AROUND the Verification_Loop: when a verification run surfaces a
// failure signal, this loop detects it, classifies it into exactly one failure
// class (syntax error / simulation timeout / tool crash / malformed model output),
// selects a TARGETED recovery ladder for that class, executes each recovery bounded
// by the SAME Session_Budget, verifies every recovery through the deterministic
// oracle (never model self-assessment), and records the full
// detect -> classify -> recover -> verify trajectory as ordered Trace spans linked
// back to the failed span. When a ladder is exhausted (or the budget is), it
// surfaces a typed, sanitized escalation outcome and NEVER crashes.
//
// Non-negotiables enforced here (design + engineering standards):
//   - Never blind-retry: a simulation timeout is deterministic, so it is recovered
//     by re-planning (regenerating a different candidate), never by re-running the
//     same simulate. Only a transient tool crash is retried with backoff, and even
//     then it is a single bounded, recorded, oracle-verified retry, not a spin loop.
//   - Always fail safe: any thrown sandbox/tool exception is caught and classified
//     as an `error`-class failure and handled; it never escapes this loop.
//   - Sanitized only: no host, path, stack trace, or secret is ever placed in a
//     recorded span or an escalation outcome; only failure classes, recovery
//     actions, oracle verdicts, and already-sanitized diagnostics are recorded.
//   - Oracle is the sole authority: a recovery is "recovered" ONLY when the
//     Simulator reports `pass`; a model claiming success is never sufficient.
//   - Bounded by one budget: every produce call is charged by the Model_Router and
//     every simulate is charged here, so the loop always terminates.
//   - Inject all collaborators: the generator (which routes through the
//     Model_Router incl. its fallback path), the Simulator oracle, the
//     Action_Recorder, and the backoff clock are all injected; no globals.

import {
  type BudgetStopReason,
  type FailureClass,
  type Json,
  type Result,
  type Testbench,
  type TraceSpan,
  type Ulid,
  type Verdict,
} from '@app/core';
import type { ResourceLimits, SimulationVerdict, SimulatorAdapter, SourceFile } from '@app/tools';

import type { ActionRecorder, SpanDraft } from '../action-recorder/index.js';
import type { AttemptCost, SessionBudgetHandle } from '../model-router/index.js';
import type {
  CandidateEval,
  CandidateFailure,
  GeneratedCandidate,
  GenerationInput,
} from '../roles/generation/index.js';

/** The Trace `stageOrTool` name recorded for every self-healing span. */
const SELF_HEALING_STAGE = 'Self_Healing' as const;

/** Default backoff schedule: bounded exponential, so a retry never stalls the loop. */
const DEFAULT_BACKOFF: BackoffSchedule = { baseMs: 100, maxMs: 3000 };

/**
 * The four recoverable failure classes the loop classifies into (task 14.3).
 *
 * Distinct from the core `FailureClass` (which the recorded span reuses); this is
 * the recovery-decision taxonomy that maps each class to a targeted ladder.
 */
export type FailureCategory =
  'syntax-error' | 'simulation-timeout' | 'tool-crash' | 'malformed-model-output';

/**
 * One recovery step in a ladder (design "Error Handling" recovery vocabulary).
 *
 * - `fix-and-retry`: revise the RTL from the compiler diagnostics (no delay).
 * - `backoff`: wait, then re-run the SAME simulate once (transient tool crash only).
 * - `re-plan`: wait, then regenerate a fresh candidate (timeout / malformed output).
 * - `fallback-model`: wait, then revise via the Model_Router's escalation path.
 * - `escalate`: terminal; surface a sanitized escalation outcome, never crash.
 */
export type RecoveryAction =
  'fix-and-retry' | 'backoff' | 're-plan' | 'fallback-model' | 'escalate';

/**
 * A detected failure signal handed to the loop for classification.
 *
 * Some signals are self-describing (`compile`); others are inspected (`simulation`).
 * Every variant is sanitized by construction: no raw stack trace or path is carried
 * into a recorded span or outcome.
 */
export type FailureSignal =
  | { readonly source: 'compile'; readonly diagnostics: string }
  | { readonly source: 'simulation'; readonly verdict: SimulationVerdict }
  | { readonly source: 'model-output'; readonly failure: CandidateFailure }
  | { readonly source: 'exception' };

/** Bounded exponential backoff parameters (never-blind-retry stays bounded). */
export interface BackoffSchedule {
  readonly baseMs: number;
  readonly maxMs: number;
}

/**
 * The generation primitives the recovery ladder drives.
 *
 * `GenerationAgent` satisfies this structurally: `reviseFromErrors` powers
 * `fix-and-retry`, `generateCandidate` powers `re-plan`, and
 * `reviseWithFallbackModel` powers `fallback-model` by routing through the
 * Model_Router's existing escalation path (never an ad-hoc provider retry).
 */
export interface RecoveryGenerator {
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
  reviseWithFallbackModel(
    input: GenerationInput,
    previousRtl: string,
    diagnostics: string,
    budget: SessionBudgetHandle,
  ): Promise<Result<CandidateEval, CandidateFailure>>;
}

/** The inputs a recovery attempt needs, gathered from the failed verification run. */
export interface RecoveryContext {
  /** The approved-Spec-derived generation input (source of every regeneration). */
  readonly genInput: GenerationInput;
  /** The candidate whose run failed: its RTL feeds fix-and-retry and fallback-model. */
  readonly failingCandidate: GeneratedCandidate;
  /** The independent, RTL-free testbench that re-decides correctness on recovery. */
  readonly testbench: Testbench;
  /** Sanitized simulator/compiler diagnostics fed to the next revision. */
  readonly diagnostics: string;
  /** Per-invocation sandbox caps; `wallMs` is the sole time bound for a simulate. */
  readonly limits: ResourceLimits;
  /** The Trace span id of the failed run this recovery attempts to recover. */
  readonly failedSpanId: Ulid;
}

/** The injected collaborators and deterministic seams for the self-healing loop. */
export interface SelfHealingLoopDeps {
  /** The generation primitives (route through the Model_Router incl. its fallback). */
  readonly generator: RecoveryGenerator;
  /** The Simulator oracle: the sole authority that a recovery actually worked. */
  readonly simulator: SimulatorAdapter;
  /** The Action_Recorder that appends each ordered, sanitized recovery span. */
  readonly recorder: ActionRecorder;
  /** Backoff delay port; defaults to a `setTimeout`-based async wait (never sync sleep). */
  readonly wait?: (ms: number) => Promise<void>;
  /** Bounded backoff schedule; defaults to a capped exponential. */
  readonly backoff?: BackoffSchedule;
  /** Wall-clock source for recorded span timing; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** One recorded step of the recovery trajectory (returned to the caller). */
export interface RecoveryStep {
  readonly action: RecoveryAction;
  /** The oracle verdict for the attempt, or `null` when the candidate never ran. */
  readonly verdict: Verdict | null;
  /** The Trace span id recorded for this step. */
  readonly spanId: Ulid;
}

/** The recovery reached a passing oracle verdict (Req 8.3): confirmed by the oracle. */
export interface RecoveredFailure {
  readonly status: 'recovered';
  readonly category: FailureCategory;
  /** The recovery action that produced the passing run. */
  readonly action: RecoveryAction;
  readonly candidate: GeneratedCandidate;
  /** The passing Simulator verdict (the only evidence of recovery). */
  readonly simulation: SimulationVerdict;
  /** The Trace span that IS the ground truth for the recovered run. */
  readonly verifySpanId: Ulid;
  readonly attempts: number;
  readonly trajectory: readonly RecoveryStep[];
}

/** Why recovery was escalated instead of resolved (all sanitized, never a crash). */
export type EscalationReason = 'ladder-exhausted' | 'budget-exhausted' | 'recovery-unavailable';

/** The recovery could not reach an oracle pass; escalate safely (Req 8.4, 12.5). */
export interface EscalatedFailure {
  readonly status: 'escalated';
  readonly category: FailureCategory;
  readonly reason: EscalationReason;
  /** A short, non-sensitive explanation; never a host, path, secret, or stack trace. */
  readonly detail: string;
  /** The budget cap that stopped recovery, when the cause was the Session_Budget. */
  readonly stopReason: BudgetStopReason | null;
  /** The last non-passing Simulator verdict observed, or `null` if none ran. */
  readonly lastSimulation: SimulationVerdict | null;
  readonly attempts: number;
  readonly trajectory: readonly RecoveryStep[];
}

/** The terminal result of a self-healing recovery run. */
export type RecoveryOutcome = RecoveredFailure | EscalatedFailure;

/** The recovery ladder for each failure class (design "Error Handling" mapping). */
const RECOVERY_LADDERS: Readonly<Record<FailureCategory, readonly RecoveryAction[]>> = {
  // A compile error is deterministic and fixable from the diagnostics: revise once,
  // then escalate. No blind retry of the same broken source.
  'syntax-error': ['fix-and-retry', 'escalate'],
  // A timeout is deterministic; re-running the same run would time out again, so we
  // re-plan (regenerate a different candidate) after a backoff, never blind-retry.
  'simulation-timeout': ['re-plan', 'escalate'],
  // A tool crash is often transient infra: one backed-off retry of the same run,
  // then escalate the model to the fallback class, then give up safely.
  'tool-crash': ['backoff', 'fallback-model', 'escalate'],
  // Malformed model output means the primary model produced unusable output: re-plan
  // on the primary, then escalate to the fallback model, then give up safely.
  'malformed-model-output': ['re-plan', 'fallback-model', 'escalate'],
};

/**
 * Classify a detected failure signal into exactly one recoverable failure class.
 *
 * Pure and total: every signal maps to one class, so the loop can always select a
 * ladder. A thrown exception and an otherwise-unclassifiable error both fall to
 * `tool-crash`, whose ladder ends in a safe escalate (fail safe).
 */
export function classifyFailure(signal: FailureSignal, limits?: ResourceLimits): FailureCategory {
  switch (signal.source) {
    case 'compile':
      return 'syntax-error';
    case 'model-output':
      return signal.failure.reason === 'unparseable' ? 'malformed-model-output' : 'tool-crash';
    case 'exception':
      return 'tool-crash';
    case 'simulation':
      return classifySimulation(signal.verdict, limits);
  }
}

/** The ordered recovery ladder for a failure class (design "Error Handling"). */
export function recoveryLadderFor(category: FailureCategory): readonly RecoveryAction[] {
  return RECOVERY_LADDERS[category];
}

/**
 * Map a failure class to the core `FailureClass` recorded on the span.
 *
 * Malformed model output has no dedicated core class; it is recorded as
 * `tool-error` (consistent with the Generation_Agent's unparseable-output span),
 * while the precise category is preserved in the span outputs.
 */
export function coreFailureClass(category: FailureCategory): FailureClass {
  switch (category) {
    case 'syntax-error':
      return 'compile-error';
    case 'simulation-timeout':
      return 'timeout';
    case 'tool-crash':
    case 'malformed-model-output':
      return 'tool-error';
  }
}

/** Bounded exponential backoff for the given 1-based attempt number. */
export function backoffDelayMs(attempt: number, schedule: BackoffSchedule): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(schedule.baseMs * 2 ** exponent, schedule.maxMs);
}

/** A per-`heal` bundle threaded to the step executor (keeps params bounded). */
interface HealRun {
  readonly context: RecoveryContext;
  readonly category: FailureCategory;
}

/** The result of executing one ladder step: either a verified run or a produce failure. */
type StepResult =
  | {
      readonly kind: 'ran';
      readonly candidate: GeneratedCandidate;
      readonly simulation: SimulationVerdict;
      readonly step: RecoveryStep;
    }
  | {
      readonly kind: 'produce-failed';
      readonly failure: CandidateFailure;
      readonly step: RecoveryStep;
    };

/**
 * The self-healing failure-recovery loop.
 *
 * `heal` classifies the failure, walks the class's recovery ladder under the
 * Session_Budget, verifies each attempt through the oracle, records the trajectory,
 * and returns a `recovered` outcome (oracle pass) or a sanitized `escalated`
 * outcome. It never throws and never blind-retries.
 */
export class SelfHealingLoop {
  readonly #generator: RecoveryGenerator;
  readonly #simulator: SimulatorAdapter;
  readonly #recorder: ActionRecorder;
  readonly #wait: (ms: number) => Promise<void>;
  readonly #backoff: BackoffSchedule;
  readonly #now: () => number;

  constructor(deps: SelfHealingLoopDeps) {
    this.#generator = deps.generator;
    this.#simulator = deps.simulator;
    this.#recorder = deps.recorder;
    this.#wait = deps.wait ?? defaultWait;
    this.#backoff = deps.backoff ?? DEFAULT_BACKOFF;
    this.#now = deps.now ?? Date.now;
  }

  /**
   * Detect -> classify -> recover -> verify, bounded by the Session_Budget.
   *
   * Records a classification span, then attempts each ladder step in order: a step
   * that yields an oracle `pass` returns `recovered`; a produce failure or a
   * non-pass verdict advances the ladder; an unaffordable budget or an exhausted
   * ladder returns a sanitized `escalated` outcome. Always terminates, never throws.
   */
  async heal(
    signal: FailureSignal,
    context: RecoveryContext,
    budget: SessionBudgetHandle,
  ): Promise<RecoveryOutcome> {
    const category = classifyFailure(signal, context.limits);
    const ladder = recoveryLadderFor(category);
    await this.#recordClassification(context, category, ladder);

    const run: HealRun = { context, category };
    const trajectory: RecoveryStep[] = [];
    let lastSimulation: SimulationVerdict | null = null;
    let attempt = 0;

    for (const action of ladder) {
      if (action === 'escalate') {
        return exhausted(category, lastSimulation, trajectory);
      }
      if (!budget.canAfford()) {
        return escalate(
          category,
          'budget-exhausted',
          BUDGET_EXHAUSTED,
          budget.stopReason(),
          lastSimulation,
          trajectory,
        );
      }

      attempt += 1;
      const result = await this.#runStep(run, action, attempt, budget);
      trajectory.push(result.step);
      if (result.kind === 'produce-failed') {
        const stop = result.failure.budgetStopReason;
        if (stop !== undefined) {
          return escalate(
            category,
            'budget-exhausted',
            BUDGET_EXHAUSTED,
            stop,
            lastSimulation,
            trajectory,
          );
        }
        continue;
      }
      lastSimulation = result.simulation;
      if (result.simulation.verdict === 'pass') {
        return recovered(
          category,
          action,
          result.candidate,
          result.simulation,
          result.step.spanId,
          trajectory,
        );
      }
    }
    return exhausted(category, lastSimulation, trajectory);
  }

  /** Execute one ladder step: produce (or reuse) a candidate, verify it via the oracle. */
  async #runStep(
    run: HealRun,
    action: RecoveryAction,
    attempt: number,
    budget: SessionBudgetHandle,
  ): Promise<StepResult> {
    const produced = await this.#produceFor(run.context, action, attempt, budget);
    if (produced !== null && !produced.ok) {
      const span = await this.#recordAttempt(run, action, attempt, null, produced.error.detail);
      return { kind: 'produce-failed', failure: produced.error, step: stepOf(action, null, span) };
    }
    const candidate = produced === null ? run.context.failingCandidate : produced.value.candidate;
    const simulation = await this.#simulate(candidate, run.context);
    budget.charge(simulateCost(simulation));
    const span = await this.#recordAttempt(run, action, attempt, simulation, null);
    return { kind: 'ran', candidate, simulation, step: stepOf(action, simulation.verdict, span) };
  }

  /**
   * Produce the candidate for a recovery action, applying a backoff first where the
   * action prescribes it. Returns `null` for `backoff` (which re-runs the SAME
   * candidate) so the caller re-simulates the existing failing candidate.
   */
  async #produceFor(
    context: RecoveryContext,
    action: RecoveryAction,
    attempt: number,
    budget: SessionBudgetHandle,
  ): Promise<Result<CandidateEval, CandidateFailure> | null> {
    if (action === 'fix-and-retry') {
      return this.#generator.reviseFromErrors(
        context.genInput,
        context.failingCandidate.rtl,
        context.diagnostics,
        budget,
      );
    }
    await this.#wait(backoffDelayMs(attempt, this.#backoff));
    if (action === 're-plan') {
      return this.#generator.generateCandidate(context.genInput, budget);
    }
    if (action === 'fallback-model') {
      return this.#generator.reviseWithFallbackModel(
        context.genInput,
        context.failingCandidate.rtl,
        context.diagnostics,
        budget,
      );
    }
    return null;
  }

  /** Compile and simulate a candidate against the independent testbench, failing safe. */
  async #simulate(
    candidate: GeneratedCandidate,
    context: RecoveryContext,
  ): Promise<SimulationVerdict> {
    // Use the trusted Spec module name for the workspace path, never the untrusted
    // parsed name, so model output can never influence a file path.
    const moduleName = context.genInput.spec.moduleInterface.moduleName;
    const rtl: readonly SourceFile[] = [{ path: `${moduleName}.v`, contents: candidate.rtl }];
    const testbenchFile: SourceFile = {
      path: `${moduleName}_tb.v`,
      contents: context.testbench.source,
    };
    try {
      return await this.#simulator.simulate(rtl, testbenchFile, context.limits);
    } catch {
      // A sandbox capture/contract failure is exceptional; classify it `error` and
      // never let it crash the recovery loop (fail safe).
      return toolFailureVerdict();
    }
  }

  /** Record the detect+classify span, linked back to the failed run's span (Req 3.4, 8.8). */
  #recordClassification(
    context: RecoveryContext,
    category: FailureCategory,
    ladder: readonly RecoveryAction[],
  ): Promise<TraceSpan> {
    const outputs: Json = {
      stage: SELF_HEALING_STAGE,
      phase: 'classify',
      category,
      ladder: [...ladder],
    };
    const draft: SpanDraft = {
      ...this.#spanBase(
        context,
        { stage: SELF_HEALING_STAGE, phase: 'classify', category },
        outputs,
      ),
      failureClass: coreFailureClass(category),
      recoveryOf: context.failedSpanId,
    };
    return this.#recorder.record(draft);
  }

  /** Record one recover+verify attempt span, linked back to the failed run's span. */
  #recordAttempt(
    run: HealRun,
    action: RecoveryAction,
    attempt: number,
    simulation: SimulationVerdict | null,
    produceDetail: string | null,
  ): Promise<TraceSpan> {
    const outputs = attemptOutputs(run.category, action, attempt, simulation, produceDetail);
    const base: SpanDraft = {
      ...this.#spanBase(
        run.context,
        { stage: SELF_HEALING_STAGE, phase: 'recover', action, attempt },
        outputs,
      ),
      exitCode: simulation?.exitCode ?? null,
      durationMs: Math.max(0, simulation?.resourceUsage.wallMs ?? 0),
      retryCount: attempt,
      recoveryOf: run.context.failedSpanId,
    };
    const failureClass = attemptFailureClass(run.category, simulation, produceDetail);
    return this.#recorder.record(failureClass === undefined ? base : { ...base, failureClass });
  }

  /** The shared, sanitized-by-construction span fields for a self-healing span. */
  #spanBase(context: RecoveryContext, inputs: Json, outputs: Json): SpanDraft {
    return {
      sessionId: context.genInput.sessionId,
      stageOrTool: SELF_HEALING_STAGE,
      inputs,
      outputs,
      exitCode: null,
      startedAt: new Date(this.#now()).toISOString(),
      durationMs: 0,
      retryCount: 0,
      costCents: 0,
    };
  }
}

/** A host timer accessed without depending on a specific runtime's global typings. */
type HostTimer = (callback: () => void, ms: number) => unknown;

/**
 * The default backoff wait: an async delay backed by the host timer when present
 * (Node or browser), degrading to an immediate resolve on a timer-less host.
 *
 * It is always asynchronous (never a synchronous sleep), and production wiring may
 * inject its own `wait` at the composition edge. The agent layer keeps no hard
 * dependency on a runtime-specific global.
 */
function defaultWait(ms: number): Promise<void> {
  const scheduler = (globalThis as { setTimeout?: HostTimer }).setTimeout;
  if (typeof scheduler !== 'function') {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    scheduler(() => {
      resolve();
    }, ms);
  });
}

/** Classify a Simulator `error` verdict into a recoverable class using its fields. */
function classifySimulation(verdict: SimulationVerdict, limits?: ResourceLimits): FailureCategory {
  if (looksLikeTimeout(verdict, limits)) {
    return 'simulation-timeout';
  }
  if (looksLikeCompileError(verdict)) {
    return 'syntax-error';
  }
  return 'tool-crash';
}

/** A killed run whose wall clock reached the cap is a timeout (best-effort heuristic). */
function looksLikeTimeout(verdict: SimulationVerdict, limits?: ResourceLimits): boolean {
  if (limits === undefined || verdict.exitCode !== null) {
    return false;
  }
  return verdict.resourceUsage.wallMs >= limits.wallMs && limits.wallMs > 0;
}

/** A process that ran to a non-zero exit without a waveform failed at compile time. */
function looksLikeCompileError(verdict: SimulationVerdict): boolean {
  return verdict.exitCode !== null && verdict.exitCode !== 0 && verdict.vcd === null;
}

/** Charge one simulate iteration: no model tokens/cost, the run's observed wall clock. */
function simulateCost(simulation: SimulationVerdict): AttemptCost {
  return { tokens: 0, costCents: 0, wallClockMs: Math.max(0, simulation.resourceUsage.wallMs) };
}

/** The synthesized `error` verdict for a simulate that threw before the oracle spoke. */
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

/** Build the sanitized outputs payload recorded for one recovery attempt. */
function attemptOutputs(
  category: FailureCategory,
  action: RecoveryAction,
  attempt: number,
  simulation: SimulationVerdict | null,
  produceDetail: string | null,
): Json {
  if (simulation === null) {
    return {
      stage: SELF_HEALING_STAGE,
      phase: 'recover',
      category,
      action,
      attempt,
      produced: false,
      reason: produceDetail,
    };
  }
  return {
    stage: SELF_HEALING_STAGE,
    phase: 'verify',
    category,
    action,
    attempt,
    produced: true,
    verdict: simulation.verdict,
    checks: simulation.checks.map((check) => ({ name: check.name, passed: check.passed })),
    vcdCaptured: simulation.vcd !== null,
  };
}

/** The core failure class recorded on an attempt span, or `undefined` for a pass. */
function attemptFailureClass(
  category: FailureCategory,
  simulation: SimulationVerdict | null,
  produceDetail: string | null,
): FailureClass | undefined {
  if (produceDetail !== null) {
    return coreFailureClass(category);
  }
  if (simulation === null || simulation.verdict === 'pass') {
    return undefined;
  }
  return simulation.verdict === 'fail' ? 'functional-fail' : coreFailureClass(category);
}

/** Build one trajectory step record. */
function stepOf(action: RecoveryAction, verdict: Verdict | null, span: TraceSpan): RecoveryStep {
  return { action, verdict, spanId: span.id };
}

/** Sanitized detail messages for escalation outcomes (no internal specifics). */
const LADDER_EXHAUSTED = 'The recovery ladder was exhausted without an oracle pass.';
const BUDGET_EXHAUSTED = 'The Session_Budget was exhausted before recovery could complete.';
const RECOVERY_UNAVAILABLE = 'Recovery could not produce a candidate to verify.';

/**
 * Assemble the terminal escalation when a ladder ends without a pass.
 *
 * When at least one attempt ran but never passed, the ladder is exhausted; when no
 * attempt ever produced a candidate to simulate, recovery was unavailable. Either
 * way the outcome is sanitized and no exception escapes.
 */
function exhausted(
  category: FailureCategory,
  lastSimulation: SimulationVerdict | null,
  trajectory: readonly RecoveryStep[],
): EscalatedFailure {
  if (lastSimulation === null && trajectory.length > 0) {
    return escalate(category, 'recovery-unavailable', RECOVERY_UNAVAILABLE, null, null, trajectory);
  }
  return escalate(category, 'ladder-exhausted', LADDER_EXHAUSTED, null, lastSimulation, trajectory);
}

/** Assemble the `recovered` outcome bound to the passing oracle span. */
function recovered(
  category: FailureCategory,
  action: RecoveryAction,
  candidate: GeneratedCandidate,
  simulation: SimulationVerdict,
  verifySpanId: Ulid,
  trajectory: readonly RecoveryStep[],
): RecoveredFailure {
  return {
    status: 'recovered',
    category,
    action,
    candidate,
    simulation,
    verifySpanId,
    attempts: trajectory.length,
    trajectory: [...trajectory],
  };
}

/** Assemble the sanitized `escalated` outcome (fail safe, never a crash). */
function escalate(
  category: FailureCategory,
  reason: EscalationReason,
  detail: string,
  stopReason: BudgetStopReason | null,
  lastSimulation: SimulationVerdict | null,
  trajectory: readonly RecoveryStep[],
): EscalatedFailure {
  return {
    status: 'escalated',
    category,
    reason,
    detail,
    stopReason,
    lastSimulation,
    attempts: trajectory.length,
    trajectory: [...trajectory],
  };
}
