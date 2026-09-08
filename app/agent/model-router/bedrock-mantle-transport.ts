// The bedrock-mantle vendor transport: Amazon Bedrock's OpenAI-compatible Chat
// Completions host, behind the shared `ProviderTransport` seam (Req 12.6-12.9).
//
// ONE CREDENTIAL, MANY MODELS
//   A single bearer token fronts the whole bedrock-mantle catalog (qwen3-coder
//   variants, zai glm, deepseek, moonshot kimi, minimax, mistral, and more), and the
//   model id is just a request field. So one transport instance serves every model:
//   the per-call model id arrives on `ProviderTransportInput.modelId` (the routed
//   selection the policy chose, carried through `ProviderCallOptions`), and the
//   instance only supplies `defaultModelId` when an adapter is driven directly. The
//   model id is deliberately NOT put on `ModelRequest`, which stays
//   provider-neutral: a request that named a model would couple every caller to one
//   provider's catalog, and a per-role model bake-off permutes the routed selection,
//   not the prompt.
//
// SECURITY
//   The credential exists only as a local `Authorization` header inside one call. It
//   never enters a result, an error, a log, or a trace. Neither does the URL, the
//   host, or a provider error body: every failure is collapsed to a typed
//   `ProviderCallError` with a short, non-sensitive reason. The HTTP client and the
//   deadline timer are injected, so tests exercise every path with no network.
//
// COST
//   Prices are injected, never guessed here. An unpriced model reports `costCents: 0`
//   which means PRICE UNKNOWN, not free - see `costCentsFor`.
//
// GENERATION SETTINGS
//   Sampling comes from this instance's configuration, not from
//   `ModelRequest.metadata`: that field is free-form provider-neutral JSON, and
//   interpreting some of it here would silently half-honor a caller's intent. Only
//   `maxOutputTokens`, which the contract types explicitly, is read off the request.

import { err, ok, type Result } from '@app/core';

import type { AttemptTokenUsage } from './budget-handle.js';
import { parseChatCompletionsReply, type TokenUsage } from './chat-completions-reply.js';
import type { ModelResult, ProviderCallError } from './contract.js';
import {
  exchangeJson,
  hostScheduleTimeout,
  newHostAbortController,
  type JsonHttpOutcome,
  type JsonHttpPort,
  type JsonHttpRequest,
  type ScheduleTimeout,
} from './json-http-port.js';
import type { ProviderTransport, ProviderTransportInput } from './remote-adapter.js';

/** The provider this transport speaks for; every reason string is prefixed with it. */
const PROVIDER = 'bedrock-mantle' as const;

/** Path of the OpenAI-compatible Chat Completions endpoint on the mantle host. */
const CHAT_COMPLETIONS_PATH = '/v1/chat/completions';

/**
 * Accepted shape of an AWS region label.
 *
 * The region is external configuration that is interpolated into the request URL, so
 * it is validated at the boundary: without this, a stray path, credential, or CRLF in
 * the region would rewrite the endpoint the credential is sent to.
 */
const REGION_PATTERN = /^[a-z0-9-]{1,32}$/;

/** Deterministic sampling by default, so a model bake-off compares like with like. */
const DEFAULT_TEMPERATURE = 0;

/** Highest accepted temperature; above this the provider rejects the call anyway. */
const MAX_TEMPERATURE = 2;

/**
 * Largest accepted sampling seed: the 32-bit unsigned range.
 *
 * Bounded because the seed is interpolated into the request body as a number and an
 * out-of-range or fractional value is rejected by the provider, which would look
 * like an outage rather than the wiring mistake it is.
 */
const MAX_SEED = 0xffffffff;

/** Default output cap, matching the reference benchmark client for this endpoint. */
const DEFAULT_MAX_OUTPUT_TOKENS = 6_000;

/** Default per-call deadline, matching the reference benchmark client (240s). */
const DEFAULT_REQUEST_TIMEOUT_MS = 240_000;

/** Prices are quoted per one million tokens, so cost divides by this. */
const TOKENS_PER_PRICE_UNIT = 1_000_000;

/** Lowest HTTP status treated as a successful reply. */
const HTTP_OK = 200;

/** First HTTP status treated as a failed reply. */
const HTTP_REDIRECT = 300;

/** Cents per one million tokens for one model id. Injected; never inferred here. */
export interface ModelPrice {
  readonly inputCentsPerMillionTokens: number;
  readonly outputCentsPerMillionTokens: number;
}

/**
 * Per-model prices keyed by the provider's model id.
 *
 * A model absent from the table has an UNKNOWN price, which is not the same as a
 * free one; see `costCentsFor`.
 */
export type ModelPriceTable = Readonly<Record<string, ModelPrice>>;

/**
 * Non-secret configuration for one transport instance.
 *
 * Region and the default model id are injected, never literals in the call path, so
 * one instance can serve the whole catalog and a region change never touches code.
 */
export interface BedrockMantleTransportConfig {
  /** AWS region hosting the endpoint, e.g. `us-east-1`. Configuration, not a secret. */
  readonly region: string;
  /** Model id used only when a call arrives without a routed one. */
  readonly defaultModelId: string;
  /** Output cap when the request carries no hint; defaults to 6000 tokens. */
  readonly maxOutputTokens?: number;
  /** Sampling temperature; defaults to 0 for deterministic comparison. */
  readonly temperature?: number;
  /**
   * Optional sampling seed, forwarded as the OpenAI-compatible `seed` field.
   *
   * BEST EFFORT, NOT A GUARANTEE. The endpoint treats `seed` as a hint: a hosted
   * provider is not bit-deterministic even at temperature 0, because batching,
   * kernel selection, and model-server revisions all move the sampled tokens. So a
   * seed makes a run as repeatable as the host allows and no more - which is exactly
   * why an eval draws k samples per problem instead of trusting one.
   *
   * Omitted when absent, so a request that does not pin a seed keeps the reference
   * client's exact body shape.
   */
  readonly seed?: number;
  /** Per-call deadline in milliseconds; defaults to 240000. */
  readonly requestTimeoutMs?: number;
  /** Optional per-model prices; models omitted here report an unknown cost. */
  readonly prices?: ModelPriceTable;
}

/** The injected collaborators one transport instance needs (no globals). */
export interface BedrockMantleTransportDeps {
  readonly config: BedrockMantleTransportConfig;
  /** The HTTP client seam; a fake in tests, a real client in deployment. */
  readonly http: JsonHttpPort;
  /** Deadline timer; defaults to the host timer. */
  readonly scheduleTimeout?: ScheduleTimeout;
}

/** Configuration after validation and defaulting: every field is present and legal. */
interface ResolvedConfig {
  readonly url: string;
  readonly defaultModelId: string;
  readonly maxOutputTokens: number;
  readonly temperature: number;
  /** The validated seed, or null when this instance pins none. */
  readonly seed: number | null;
  readonly requestTimeoutMs: number;
  readonly prices: ModelPriceTable;
}

/** A positive whole number, or null when the value cannot be one. */
function positiveInt(value: number): number | null {
  if (!Number.isFinite(value) || value < 1) {
    return null;
  }
  return Math.trunc(value);
}

/** Reject a wiring mistake loudly at composition time rather than per call. */
function configError(detail: string): never {
  throw new Error(`Model_Router wiring error: ${PROVIDER} transport ${detail}`);
}

/** Validate and default the injected configuration, throwing on a wiring mistake. */
function resolveConfig(config: BedrockMantleTransportConfig): ResolvedConfig {
  if (!REGION_PATTERN.test(config.region)) {
    configError('was given an invalid region');
  }
  if (config.defaultModelId.trim().length === 0) {
    configError('was given a blank default model id');
  }
  const maxOutputTokens = positiveInt(config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS);
  const requestTimeoutMs = positiveInt(config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const temperature = config.temperature ?? DEFAULT_TEMPERATURE;
  if (maxOutputTokens === null || requestTimeoutMs === null) {
    configError('was given a non-positive token cap or timeout');
  }
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > MAX_TEMPERATURE) {
    configError('was given an out-of-range temperature');
  }
  return {
    url: `https://${PROVIDER}.${config.region}.api.aws${CHAT_COMPLETIONS_PATH}`,
    defaultModelId: config.defaultModelId.trim(),
    maxOutputTokens,
    temperature,
    seed: resolveSeed(config.seed),
    requestTimeoutMs,
    prices: config.prices ?? {},
  };
}

/** The validated seed, or null when none is pinned; an illegal seed fails loudly. */
function resolveSeed(seed: number | undefined): number | null {
  if (seed === undefined) {
    return null;
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) {
    configError('was given an out-of-range seed');
  }
  return seed;
}

/** The output cap for one call: the request's hint when usable, else the configured cap. */
function outputCapFor(requested: number | undefined, configured: number): number {
  if (requested === undefined) {
    return configured;
  }
  return positiveInt(requested) ?? configured;
}

/**
 * Build the outbound request for one call.
 *
 * The credential lives only in the returned object's `Authorization` header, which is
 * handed to the HTTP port and then dropped; it is never returned to a caller.
 */
function buildRequest(call: {
  readonly config: ResolvedConfig;
  readonly input: ProviderTransportInput;
  readonly modelId: string;
  readonly signal: JsonHttpRequest['signal'];
}): JsonHttpRequest {
  const { config, input, modelId, signal } = call;
  const body = JSON.stringify({
    model: modelId,
    messages: [{ role: 'user', content: input.request.prompt }],
    max_tokens: outputCapFor(input.request.maxOutputTokens, config.maxOutputTokens),
    temperature: config.temperature,
    // Omitted entirely when unpinned, so an unseeded call keeps the reference
    // client's exact body rather than sending an explicit null the host may reject.
    ...(config.seed === null ? {} : { seed: config.seed }),
  });
  return {
    url: config.url,
    headers: { Authorization: `Bearer ${input.credential}`, 'Content-Type': 'application/json' },
    body,
    timeoutMs: config.requestTimeoutMs,
    ...(signal === undefined ? {} : { signal }),
  };
}

/**
 * Cost in cents from REAL reported usage and an INJECTED price.
 *
 * Returns 0 when the model has no configured price or the provider reported no
 * usage. Zero here means PRICE UNKNOWN / USAGE UNREPORTED - it does NOT mean the
 * call was free. No price is ever fabricated in this module, so a downstream cost
 * metric must treat 0 from an unpriced model as unmeasured rather than as real zero
 * spend, or it will silently understate spend.
 */
function costCentsFor(price: ModelPrice | undefined, usage: TokenUsage | undefined): number {
  if (price === undefined || usage === undefined) {
    return 0;
  }
  const input = usage.promptTokens * price.inputCentsPerMillionTokens;
  const output = usage.completionTokens * price.outputCentsPerMillionTokens;
  return (input + output) / TOKENS_PER_PRICE_UNIT;
}

/** Whether the reply status is a success, so a failure is never parsed as a result. */
function isSuccessStatus(status: number): boolean {
  return status >= HTTP_OK && status < HTTP_REDIRECT;
}

/** Map a non-reply exchange outcome to its redacted, typed provider failure. */
function exchangeFailure(
  outcome: Exclude<JsonHttpOutcome, { readonly kind: 'reply' }>,
  timeoutMs: number,
): ProviderCallError {
  if (outcome.kind === 'timeout') {
    return { kind: 'timeout', reason: `${PROVIDER} call exceeded its ${timeoutMs}ms deadline` };
  }
  return { kind: 'provider-unavailable', reason: `${PROVIDER} call could not be completed` };
}

/**
 * The prompt/completion split, or the explicit statement that none was reported.
 *
 * `parseChatCompletionsReply` has already decided this at the trust boundary: a `usage`
 * block that is absent, not an object, or carries an unusable prompt/completion count
 * comes back as `undefined` rather than as zeros. All this does is give that absence a
 * name a measurer can carry, instead of letting it read as a free call.
 */
function tokenUsageOf(usage: TokenUsage | undefined): AttemptTokenUsage {
  if (usage === undefined) {
    return { kind: 'unreported' };
  }
  return {
    kind: 'reported',
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
  };
}

/** Turn a validated reply into a provider-neutral result with real usage and cost. */
function toModelResult(
  reply: { readonly text: string; readonly usage?: TokenUsage },
  modelId: string,
  prices: ModelPriceTable,
): ModelResult {
  return {
    provider: PROVIDER,
    outputText: reply.text,
    // Absent usage reads as 0 in this scalar, which is UNREPORTED and not free; see
    // `costCentsFor`. `tokenUsage` below is the channel that says which one it is.
    tokensUsed: reply.usage?.totalTokens ?? 0,
    costCents: costCentsFor(prices[modelId], reply.usage),
    tokenUsage: tokenUsageOf(reply.usage),
  };
}

/** Perform one Chat Completions call, returning only redacted, typed outcomes. */
async function callChatCompletions(
  config: ResolvedConfig,
  http: JsonHttpPort,
  scheduleTimeout: ScheduleTimeout,
  input: ProviderTransportInput,
): Promise<Result<ModelResult, ProviderCallError>> {
  const modelId = (input.modelId ?? config.defaultModelId).trim();
  if (modelId.length === 0) {
    return err({ kind: 'provider-unavailable', reason: `${PROVIDER} call had no model id` });
  }
  const controller = newHostAbortController();
  const outcome = await exchangeJson({
    port: http,
    request: buildRequest({ config, input, modelId, signal: controller?.signal }),
    scheduleTimeout,
    // Tear the in-flight call down on a deadline breach instead of leaking it.
    onTimeout: () => controller?.abort(),
  });
  if (outcome.kind !== 'reply') {
    return err(exchangeFailure(outcome, config.requestTimeoutMs));
  }
  if (!isSuccessStatus(outcome.response.status)) {
    // The body is dropped deliberately: a provider error body can echo the request,
    // the host, or the credential. Only the status code, which carries none of
    // those, is safe to report.
    return err({
      kind: 'provider-unavailable',
      reason: `${PROVIDER} returned HTTP status ${outcome.response.status}`,
    });
  }
  const reply = parseChatCompletionsReply(outcome.response.body);
  if (!reply.ok) {
    return err({ kind: 'invalid-response', reason: `${PROVIDER} ${reply.error.reason}` });
  }
  return ok(toModelResult(reply.value, modelId, config.prices));
}

/**
 * Build the bedrock-mantle transport.
 *
 * The returned function is the `ProviderTransport` the adapter injects its resolved
 * credential into, once per call. Invalid configuration throws here, at composition
 * time, so a wiring mistake can never masquerade as a provider outage at runtime.
 */
export function createBedrockMantleTransport(deps: BedrockMantleTransportDeps): ProviderTransport {
  const config = resolveConfig(deps.config);
  const scheduleTimeout = deps.scheduleTimeout ?? hostScheduleTimeout;
  return (input) => callChatCompletions(config, deps.http, scheduleTimeout, input);
}
