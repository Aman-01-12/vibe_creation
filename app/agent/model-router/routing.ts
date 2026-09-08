// The routing policy: task -> ordered chain of `{provider, modelId}` selections
// (Req 12.2-12.5).
//
// Each task resolves to a chain whose FIRST entry is that task's configured primary
// selection; the remaining entries are the bounded fallback/retry escalation, tried
// only when an earlier attempt fails. `maxAttempts` caps how many entries a single
// `invoke` may walk, so the fallback loop is bounded twice over: by the finite chain
// and by that cap, independently of (and in addition to) the Session_Budget guard.
//
// WHY A SELECTION AND NOT JUST A PROVIDER
//   Selecting a provider alone is not enough. One provider - notably the
//   OpenAI-compatible Bedrock-mantle host - serves a whole catalog of models, and
//   the per-role model bake-off (`ECE-CONTEXT-ENGINEERING.md` section 7) permutes
//   the model id per role while holding provider, prompt, and context strategy
//   constant. So per-role model selection is first-class here: the policy resolves
//   `{provider, modelId}`, and the router hands the model id to the vendor transport.
//
// Defaults follow `product-ece/ECE-TECH-DECISIONS.md` Q1 and the design's routing
// defaults: generation and repair -> DeepSeek V4; orchestration and teaching ->
// Gemini Flash; escalated hard planning -> Claude class. Every non-Claude task
// escalates to Claude on failure; hard planning (already Claude) retries Claude
// once. The whole table is data, so models stay swappable per task.

import type { ModelSelection, ModelTask, ProviderName } from './contract.js';

/** Every `ModelTask`, in a stable order, so diagnostics and policies stay exhaustive. */
export const MODEL_TASKS: readonly ModelTask[] = [
  'generation',
  'repair',
  'orchestration',
  'teaching',
  'hard-planning',
];

/**
 * The default model id per provider.
 *
 * These are CONFIGURATION, not constants of the domain: they name the model class
 * the settled tech decision picked for each provider (ECE-TECH-DECISIONS Q1), and
 * deployment is expected to override them with the exact ids its accounts are
 * entitled to. They live here as one named table rather than as literals scattered
 * through the adapters.
 */
export const DEFAULT_PROVIDER_MODEL: Readonly<Record<ProviderName, string>> = {
  deepseek: 'deepseek-v4-pro',
  gemini: 'gemini-3-flash',
  claude: 'claude-sonnet',
  'bedrock-mantle': 'qwen3-coder-480b',
};

/**
 * The routing configuration consumed by the Model_Router.
 *
 * `taskRoute` is the ordered per-task chain of selections (primary first);
 * `maxAttempts` bounds how many of those entries one `invoke` may try.
 */
export interface RoutingPolicy {
  readonly taskRoute: Readonly<Record<ModelTask, readonly ModelSelection[]>>;
  /** Upper bound on provider attempts per `invoke`, so fallback is never unbounded. */
  readonly maxAttempts: number;
}

/** A selection on a provider using that provider's default model id. */
function defaultSelection(provider: ProviderName): ModelSelection {
  return { provider, modelId: DEFAULT_PROVIDER_MODEL[provider] };
}

/** The default bound on provider attempts per `invoke`; see `RoutingPolicy`. */
const DEFAULT_MAX_ATTEMPTS = 3;

/** The default routing policy (design: Routing defaults; ECE-TECH-DECISIONS Q1). */
export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  taskRoute: {
    generation: [defaultSelection('deepseek'), defaultSelection('claude')],
    repair: [defaultSelection('deepseek'), defaultSelection('claude')],
    orchestration: [defaultSelection('gemini'), defaultSelection('claude')],
    teaching: [defaultSelection('gemini'), defaultSelection('claude')],
    'hard-planning': [defaultSelection('claude'), defaultSelection('claude')],
  },
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
};

/**
 * The effective attempt cap: at least one attempt, always a whole number.
 *
 * A non-finite `maxAttempts` from a malformed custom policy is treated as "no
 * configured cap" and falls back to the default policy's cap. Without this guard
 * `Math.trunc(NaN)` propagates into `slice(0, NaN)`, which yields an EMPTY chain -
 * so the router would make zero attempts and report `ALL_PROVIDERS_FAILED` as if
 * every provider had been tried. A wiring mistake must never look like a provider
 * outage.
 */
function attemptCap(policy: RoutingPolicy): number {
  if (!Number.isFinite(policy.maxAttempts)) {
    return DEFAULT_MAX_ATTEMPTS;
  }
  return Math.max(1, Math.trunc(policy.maxAttempts));
}

/**
 * The ordered, bounded chain of model selections the router will attempt for a task
 * (never empty).
 *
 * The head is the task's configured primary selection; the tail is its bounded
 * escalation, truncated to `maxAttempts`.
 */
export function selectionChainFor(
  policy: RoutingPolicy,
  task: ModelTask,
): readonly ModelSelection[] {
  const configured = policy.taskRoute[task];
  // Every task chain in a `RoutingPolicy` is authored non-empty; guard anyway so a
  // malformed custom policy fails loudly rather than routing to `undefined`.
  if (configured.length === 0) {
    throw new Error(`Model_Router configuration error: empty model chain for task ${task}`);
  }
  return configured.slice(0, attemptCap(policy));
}

/** The provider-only view of a task's bounded chain (Req 12.2-12.5). */
export function providerChainFor(policy: RoutingPolicy, task: ModelTask): readonly ProviderName[] {
  return selectionChainFor(policy, task).map((selection) => selection.provider);
}

/** The configured primary selection for a task: the head of its chain (Req 12.2-12.4). */
export function primarySelectionFor(policy: RoutingPolicy, task: ModelTask): ModelSelection {
  const [primary] = selectionChainFor(policy, task);
  if (primary === undefined) {
    throw new Error(`Model_Router configuration error: empty model chain for task ${task}`);
  }
  return primary;
}

/** The configured primary provider for a task (Req 12.2-12.4). */
export function primaryProviderFor(policy: RoutingPolicy, task: ModelTask): ProviderName {
  return primarySelectionFor(policy, task).provider;
}

/** The per-role model ids a single-provider policy is built from. */
export interface SingleProviderRoutingInput {
  /** The one provider serving every role (e.g. the Bedrock-mantle host). */
  readonly provider: ProviderName;
  /** The model id that serves each role; the unit a model bake-off permutes. */
  readonly taskModel: Readonly<Record<ModelTask, string>>;
  /**
   * Optional same-provider fallback model per role, appended after the primary. A
   * role with no entry has a single-entry chain and therefore no fallback.
   */
  readonly fallbackModel?: Readonly<Partial<Record<ModelTask, string>>>;
  /** Attempt cap; defaults to the default policy's cap. */
  readonly maxAttempts?: number;
}

/**
 * Build a routing policy that serves every role from ONE provider with a per-role
 * model id (the shape a per-role model bake-off permutes).
 *
 * This keeps the certified configuration explicit: provider, prompt, and context
 * strategy are held constant while the model id varies per role, which is exactly
 * what selecting on Cost per Verified Artifact requires.
 */
export function singleProviderRoutingPolicy(input: SingleProviderRoutingInput): RoutingPolicy {
  const taskRoute = {} as Record<ModelTask, readonly ModelSelection[]>;
  for (const task of MODEL_TASKS) {
    const primary: ModelSelection = { provider: input.provider, modelId: input.taskModel[task] };
    const fallbackModelId = input.fallbackModel?.[task];
    taskRoute[task] =
      fallbackModelId === undefined
        ? [primary]
        : [primary, { provider: input.provider, modelId: fallbackModelId }];
  }
  return { taskRoute, maxAttempts: input.maxAttempts ?? DEFAULT_ROUTING_POLICY.maxAttempts };
}
