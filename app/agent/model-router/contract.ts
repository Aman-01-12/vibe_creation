// Model_Router contract: the provider-abstracted types every caller programs to
// (Requirement 12.1). This is the seam between the Orchestrator and the vendor
// adapters. Nothing here holds or transports a credential: requests carry only a
// prompt and neutral metadata, results carry only provider-neutral output, and
// diagnostics carry only redacted references (Req 12.6, 12.9, 12.10).

import type { BudgetStopReason, Json, Result } from '@app/core';

import type { AttemptTokenUsage, SessionBudgetHandle } from './budget-handle.js';

/**
 * The vendor providers this router can route to (design: vendor adapters).
 *
 * `bedrock-mantle` is Amazon Bedrock's OpenAI-compatible Chat Completions host. It
 * is a single provider serving a whole CATALOG of model ids (qwen3-coder variants,
 * zai glm, deepseek, moonshot kimi, minimax, mistral, and more), which is why the
 * routing policy selects a `{provider, modelId}` pair rather than a provider alone:
 * a per-role model bake-off permutes the model id while the provider stays fixed.
 */
export type ProviderName = 'deepseek' | 'gemini' | 'claude' | 'bedrock-mantle';

/**
 * The task a model call serves. The router maps each task to a chain of
 * `{provider, modelId}` selections: generation/testbench/repair -> DeepSeek V4,
 * orchestration/teaching -> Gemini Flash, escalated hard planning -> Claude class
 * (design: Routing defaults; Req 12.2-12.4).
 *
 * `testbench` is deliberately SEPARATE from `generation` even though both default to
 * the same route. Writing an independent, spec-derived testbench is a different
 * capability from writing RTL - it is measured as instrument validity, not as pass@k -
 * so the per-role bake-off must be able to assign the two roles different models and
 * ship the winning mix.
 */
export type ModelTask =
  'generation' | 'testbench' | 'repair' | 'orchestration' | 'teaching' | 'hard-planning';

/**
 * One concrete model choice: which provider serves the call, and which of that
 * provider's models answers it.
 *
 * This is the unit of per-role model selection. A `modelId` is provider-specific
 * configuration (never a secret and never a credential), so it is safe to surface
 * in routing diagnostics and in the Trace.
 */
export interface ModelSelection {
  readonly provider: ProviderName;
  /** The provider's own model identifier, e.g. a Bedrock-mantle catalog entry. */
  readonly modelId: string;
}

/**
 * A provider-neutral model request.
 *
 * It carries the prompt and neutral generation metadata only. It NEVER carries a
 * credential: credentials are resolved inside a vendor adapter at the point of
 * use and never travel in a request, prompt, or cross-component payload (Req 12.9).
 */
export interface ModelRequest {
  /** The model input prompt. Untrusted content; never a place for a credential. */
  readonly prompt: string;
  /** Optional output-length hint passed through to the provider. */
  readonly maxOutputTokens?: number;
  /** Optional neutral metadata for the call (e.g. temperature); never secrets. */
  readonly metadata?: Json;
}

/** A provider-neutral successful model result. */
export interface ModelResult {
  readonly provider: ProviderName;
  readonly outputText: string;
  readonly tokensUsed: number;
  readonly costCents: number;
  /**
   * The provider-reported prompt/completion split for this call.
   *
   * `tokensUsed` above is the provider's TOTAL and reads 0 when no usage was reported,
   * which is indistinguishable from a free call. This field is where that distinction
   * lives: `{ kind: 'unreported' }` says the provider told us nothing.
   *
   * Optional so an adapter that does not meter at all (an in-process fake) need not
   * claim it does. An absent field and `{ kind: 'unreported' }` mean the same thing to a
   * measurer, and the Model_Router normalizes absent to `unreported` before charging the
   * budget, so downstream there is exactly one spelling of "the provider did not say".
   */
  readonly tokenUsage?: AttemptTokenUsage;
}

/**
 * Why a single provider call failed, classified for fallback and Trace recording.
 *
 * `credential-unavailable` means the adapter could not resolve its own credential
 * from the secret manager; `provider-unavailable` covers a transport that is not
 * wired or a rejected/failed call; `timeout` is a call that exceeded its deadline;
 * `invalid-response` is a malformed provider reply.
 */
export type ProviderFailureKind =
  'timeout' | 'provider-unavailable' | 'invalid-response' | 'credential-unavailable';

/** A redacted description of a failed provider call. Never carries a secret. */
export interface ProviderCallError {
  readonly kind: ProviderFailureKind;
  /** A short, non-sensitive reason: no credential, host, URL, or stack trace. */
  readonly reason: string;
}

/**
 * The routed, non-secret call options an adapter receives alongside the request.
 *
 * Carries the model id the routing policy selected for this task, so per-role model
 * selection reaches the vendor transport. It never carries a credential: the
 * adapter resolves that itself at the point of use.
 */
export interface ProviderCallOptions {
  /** The provider-specific model id selected by the routing policy for this task. */
  readonly modelId: string;
}

/**
 * One vendor adapter: the only place a provider's credential is ever used.
 *
 * An adapter resolves ITS OWN single credential from the secret manager at the
 * point of use (inside `call`) and confines it to the outbound call; it holds no
 * other provider's credential (Req 12.7, 12.8). `call` returns a typed result
 * rather than throwing so the router can apply bounded fallback without leaking
 * provider internals.
 *
 * `options` is optional so an adapter may be driven directly (in which case the
 * transport falls back to its own configured default model); the router always
 * supplies the policy-selected model id.
 */
export interface ProviderAdapter {
  readonly provider: ProviderName;
  call(
    request: ModelRequest,
    options?: ProviderCallOptions,
  ): Promise<Result<ModelResult, ProviderCallError>>;
}

/** The result the router returns when a routed call ultimately succeeds. */
export interface RoutedModelResult {
  readonly task: ModelTask;
  /** The provider that produced the successful result. */
  readonly provider: ProviderName;
  /** The model id the routing policy selected for the attempt that succeeded. */
  readonly modelId: string;
  readonly outputText: string;
  readonly tokensUsed: number;
  readonly costCents: number;
  /** The prompt/completion split of the attempt that succeeded; see `ModelResult`. */
  readonly tokenUsage?: AttemptTokenUsage;
  /** How many provider attempts were made (>= 1). */
  readonly attempts: number;
  /** Whether a fallback beyond the primary provider produced the result. */
  readonly fellBack: boolean;
}

/** Why the router gave up on a task without a successful result (fail safe). */
export type ModelRouterFailureCode = 'ALL_PROVIDERS_FAILED' | 'BUDGET_EXHAUSTED';

/** The redacted, terminal failure the router returns on exhaustion (Req 12.5). */
export interface ModelRouterFailure {
  readonly code: ModelRouterFailureCode;
  readonly task: ModelTask;
  /** How many provider attempts were made before giving up. */
  readonly attempts: number;
  /** Which budget cap stopped the loop, when the cause was the Session_Budget. */
  readonly budgetStopReason?: BudgetStopReason;
}

/** A redacted, non-secret view of one provider's routing configuration (Req 12.10). */
export interface ProviderRoutingInfo {
  readonly provider: ProviderName;
  /** An opaque pointer to where the credential is resolved from - never a value. */
  readonly credentialRef: string;
}

/** A redacted, non-secret view of one task's routing chain (Req 12.10). */
export interface TaskRoutingInfo {
  readonly task: ModelTask;
  /** The ordered provider chain: primary first, then bounded fallback/retry. */
  readonly providerChain: readonly ProviderName[];
  /**
   * The same chain with the per-role model id attached to each entry. Model ids are
   * configuration, not secrets, so exposing them keeps diagnostics redacted.
   */
  readonly modelChain: readonly ModelSelection[];
}

/** Redacted routing diagnostics: provider names, tasks, and refs; no credentials. */
export interface RoutingDiagnostics {
  readonly tasks: readonly TaskRoutingInfo[];
  readonly providers: readonly ProviderRoutingInfo[];
}

/**
 * The single provider-abstracted interface for all model calls (Req 12.1).
 *
 * `invoke` routes by task, applies bounded fallback/retry under the Session_Budget,
 * and records each attempt's redacted outcome in the Trace (Req 12.2-12.5).
 * `describeRouting` exposes routing using redacted references only (Req 12.10).
 */
export interface ModelRouter {
  invoke(
    task: ModelTask,
    request: ModelRequest,
    budget: SessionBudgetHandle,
  ): Promise<Result<RoutedModelResult, ModelRouterFailure>>;
  describeRouting(): RoutingDiagnostics;
}
