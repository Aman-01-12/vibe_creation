// The Model_Router: one provider-abstracted entry point that routes by task,
// applies bounded fallback/retry under the Session_Budget, and records each
// attempt's redacted outcome in the Trace (Req 12.1-12.5).
//
// Credential confinement (Req 12.6-12.9): the router holds only `ProviderAdapter`
// instances. It never resolves, stores, or passes a credential; each adapter owns
// its own provider-scoped resolver. The spans this router records carry only
// redacted references - task, provider, outcome, failure class, attempt index, and
// cost - never a prompt payload or a credential.

import { err, ok, type FailureClass, type Json, type Result } from '@app/core';

import type { ActionRecorder, SpanDraft } from '../action-recorder/index.js';

import type { AttemptTokenUsage, SessionBudgetHandle } from './budget-handle.js';
import {
  type ModelRequest,
  type ModelResult,
  type ModelRouter,
  type ModelRouterFailure,
  type ModelSelection,
  type ModelTask,
  type ProviderAdapter,
  type ProviderCallError,
  type ProviderName,
  type RoutedModelResult,
  type RoutingDiagnostics,
} from './contract.js';
import { providerCredentialRef } from './secret-manager.js';
import {
  DEFAULT_ROUTING_POLICY,
  MODEL_TASKS,
  providerChainFor,
  selectionChainFor,
  type RoutingPolicy,
} from './routing.js';

/** Every provider must have an adapter so routing can never reach an absent one. */
export type ProviderAdapterMap = Readonly<Record<ProviderName, ProviderAdapter>>;

/** Injected collaborators for the router (dependency injection, no globals). */
export interface ModelRouterDeps {
  /** One adapter per provider; each confines its own credential. */
  readonly adapters: ProviderAdapterMap;
  /** Records each attempt's redacted outcome as a Trace span. */
  readonly recorder: ActionRecorder;
  /** The task -> provider-chain table; defaults to `DEFAULT_ROUTING_POLICY`. */
  readonly policy?: RoutingPolicy;
  /** Injectable clock for deterministic span timing in tests. */
  readonly now?: () => Date;
}

/** The outcome of one provider attempt, plus any budget stop it triggered. */
type AttemptResult =
  | { readonly status: 'success'; readonly result: ModelResult; readonly stopped: boolean }
  | { readonly status: 'failure'; readonly stopped: boolean };

/** Map a provider failure to the Trace failure classification. */
function toFailureClass(kind: ProviderCallError['kind']): FailureClass {
  return kind === 'timeout' ? 'timeout' : 'tool-error';
}

/**
 * The token usage to charge for one attempt: ALWAYS stated, never absent.
 *
 * This attempt called a model, so an absent `AttemptCost.tokenUsage` - which means "no
 * model call happened" - would be a lie. Normalizing here is what lets every measurer
 * downstream read absence as "not a model call" and nothing else.
 *
 * A FAILED attempt is `unreported` rather than zero for the same reason a reply with no
 * `usage` block is: the call was made, the provider may well have billed for it, and we
 * were told nothing. Recording it as zero would make an arm that is failing every call
 * look like the most token-efficient arm in the bake-off.
 */
function attemptTokenUsage(called: Result<ModelResult, ProviderCallError>): AttemptTokenUsage {
  if (!called.ok) {
    return { kind: 'unreported' };
  }
  return called.value.tokenUsage ?? { kind: 'unreported' };
}

/**
 * Task-routing implementation of `ModelRouter`.
 *
 * `invoke` walks the task's provider chain, gating each attempt on the budget and
 * charging every attempt (so the loop always terminates), and returns the first
 * success or a redacted, fail-safe error on exhaustion.
 */
export class TaskModelRouter implements ModelRouter {
  readonly #adapters: ProviderAdapterMap;
  readonly #recorder: ActionRecorder;
  readonly #policy: RoutingPolicy;
  readonly #now: () => Date;

  constructor(deps: ModelRouterDeps) {
    this.#adapters = deps.adapters;
    this.#recorder = deps.recorder;
    this.#policy = deps.policy ?? DEFAULT_ROUTING_POLICY;
    this.#now = deps.now ?? (() => new Date());
  }

  async invoke(
    task: ModelTask,
    request: ModelRequest,
    budget: SessionBudgetHandle,
  ): Promise<Result<RoutedModelResult, ModelRouterFailure>> {
    const chain = selectionChainFor(this.#policy, task);
    let attempts = 0;
    for (const [index, selection] of chain.entries()) {
      if (!budget.canAfford()) {
        return this.#stopForBudget(task, budget, attempts);
      }
      attempts += 1;
      const outcome = await this.#attempt(task, selection, request, budget, index);
      if (outcome.status === 'success') {
        return ok(
          this.#toRouted(task, selection, outcome.result, { attempts, fellBack: index > 0 }),
        );
      }
      if (outcome.stopped) {
        return this.#stopForBudget(task, budget, attempts);
      }
    }
    return err({ code: 'ALL_PROVIDERS_FAILED', task, attempts });
  }

  describeRouting(): RoutingDiagnostics {
    const tasks = MODEL_TASKS.map((task) => ({
      task,
      providerChain: providerChainFor(this.#policy, task),
      modelChain: selectionChainFor(this.#policy, task),
    }));
    const providers = (Object.keys(this.#adapters) as ProviderName[]).map((provider) => ({
      provider,
      credentialRef: providerCredentialRef(provider),
    }));
    return { tasks, providers };
  }

  /** Attempt one selected `{provider, modelId}` call, charge the budget, record a span. */
  async #attempt(
    task: ModelTask,
    selection: ModelSelection,
    request: ModelRequest,
    budget: SessionBudgetHandle,
    index: number,
  ): Promise<AttemptResult> {
    const { provider, modelId } = selection;
    const startedAt = this.#now();
    const called = await this.#adapters[provider].call(request, { modelId });
    const durationMs = Math.max(0, this.#now().getTime() - startedAt.getTime());
    const tokens = called.ok ? called.value.tokensUsed : 0;
    const costCents = called.ok ? called.value.costCents : 0;
    const stopReason = budget.charge({
      tokens,
      costCents,
      wallClockMs: durationMs,
      tokenUsage: attemptTokenUsage(called),
    });
    await this.#record({
      task,
      selection,
      index,
      called,
      startedAt: startedAt.toISOString(),
      durationMs,
      sessionId: budget.sessionId,
    });
    if (called.ok) {
      return { status: 'success', result: called.value, stopped: stopReason !== null };
    }
    return { status: 'failure', stopped: stopReason !== null };
  }

  /** Append the redacted outcome span for one attempt via the Action_Recorder. */
  async #record(entry: {
    readonly task: ModelTask;
    readonly selection: ModelSelection;
    readonly index: number;
    readonly called: Result<ModelResult, ProviderCallError>;
    readonly startedAt: string;
    readonly durationMs: number;
    readonly sessionId: SpanDraft['sessionId'];
  }): Promise<void> {
    const success = entry.called.ok;
    const tokensUsed = success ? entry.called.value.tokensUsed : 0;
    const costCents = success ? entry.called.value.costCents : 0;
    const { provider, modelId } = entry.selection;
    const outputs: Json = {
      task: entry.task,
      provider,
      // The routed model id is configuration, never a credential, so recording it
      // keeps the span redacted while making a per-role bake-off auditable.
      modelId,
      outcome: success ? 'success' : 'failure',
      attempt: entry.index + 1,
      fellBack: entry.index > 0,
      tokensUsed,
      costCents,
      ...(entry.called.ok ? {} : { failureKind: entry.called.error.kind }),
    };
    const base: SpanDraft = {
      sessionId: entry.sessionId,
      stageOrTool: 'Model_Router',
      inputs: { task: entry.task, provider, modelId },
      outputs,
      exitCode: success ? 0 : 1,
      startedAt: entry.startedAt,
      durationMs: entry.durationMs,
      retryCount: entry.index,
      costCents,
    };
    const draft: SpanDraft = entry.called.ok
      ? base
      : { ...base, failureClass: toFailureClass(entry.called.error.kind) };
    await this.#recorder.record(draft);
  }

  /** Record a budget-stop span and return the fail-safe budget-exhausted error. */
  async #stopForBudget(
    task: ModelTask,
    budget: SessionBudgetHandle,
    attempts: number,
  ): Promise<Result<RoutedModelResult, ModelRouterFailure>> {
    const reason = budget.stopReason();
    await this.#recorder.record({
      sessionId: budget.sessionId,
      stageOrTool: 'Model_Router',
      inputs: { task },
      outputs: {
        task,
        outcome: 'budget-exhausted',
        attempts,
        ...(reason === null ? {} : { budgetStopReason: reason }),
      },
      exitCode: 1,
      startedAt: this.#now().toISOString(),
      durationMs: 0,
      retryCount: attempts,
      costCents: 0,
    });
    return err({
      code: 'BUDGET_EXHAUSTED',
      task,
      attempts,
      ...(reason === null ? {} : { budgetStopReason: reason }),
    });
  }

  /** Build the router's success result from the routed selection and provider result. */
  #toRouted(
    task: ModelTask,
    selection: ModelSelection,
    result: ModelResult,
    walk: { readonly attempts: number; readonly fellBack: boolean },
  ): RoutedModelResult {
    return {
      task,
      provider: result.provider,
      modelId: selection.modelId,
      outputText: result.outputText,
      tokensUsed: result.tokensUsed,
      costCents: result.costCents,
      // Omitted rather than set to undefined: the field is optional and the project
      // compiles with `exactOptionalPropertyTypes`.
      ...(result.tokenUsage === undefined ? {} : { tokenUsage: result.tokenUsage }),
      attempts: walk.attempts,
      fellBack: walk.fellBack,
    };
  }
}
