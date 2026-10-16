// Model_Router: one provider-abstracted `invoke(task, request, budget)` entry
// point that routes generation/repair -> DeepSeek V4, orchestration/teaching ->
// Gemini Flash, escalated hard planning -> Claude, with bounded fallback/retry
// under the Session_Budget and redacted outcomes recorded in the Trace
// (Requirements 12.1-12.10). Task 9.1.
//
// Credential confinement is the central security property: each vendor adapter
// resolves only its own provider's credential from an injected secret-manager port
// at the point of use; the router holds no credentials and exposes only redacted
// routing diagnostics. Properties 19 (routing/fallback) and 11 (no secret escapes
// its adapter) are covered by tasks 9.2 and 9.3.

// The provider-abstracted contract and router interface.
export type {
  ModelRequest,
  ModelResult,
  ModelRouter,
  ModelRouterFailure,
  ModelRouterFailureCode,
  ModelSelection,
  ModelTask,
  ProviderAdapter,
  ProviderCallError,
  ProviderFailureKind,
  ProviderName,
  ProviderRoutingInfo,
  RoutedModelResult,
  RoutingDiagnostics,
  TaskRoutingInfo,
} from './contract.js';

// The Session_Budget handle threaded through every call, and its in-memory impl.
export type { AttemptCost, AttemptTokenUsage, SessionBudgetHandle } from './budget-handle.js';
export { InMemorySessionBudgetHandle } from './budget-handle.js';

// The secret-manager port, per-provider credential confinement, and test fake.
export type {
  ProviderCredentialResolver,
  SecretManagerPort,
  SecretResolutionError,
} from './secret-manager.js';
export { InMemorySecretManager, providerCredentialRef, scopeToProvider } from './secret-manager.js';

// The environment-backed secret manager: the only reader of the process environment.
export type { EnvironmentMap } from './env-secret-manager.js';
export { BEDROCK_CREDENTIAL_ENV_KEY, EnvSecretManager } from './env-secret-manager.js';

// The Credential_File-backed secret manager: re-read per request, so a refreshed key needs no
// restart. It reads that file alone, with no environment fallback.
export type { ReadTextFile, RefreshingSecretManagerDeps } from './refreshing-secret-manager.js';
export { DEFAULT_CREDENTIAL_FILE, RefreshingSecretManager } from './refreshing-secret-manager.js';

// The routing table, plus the single-provider builder a per-role model bake-off
// permutes (an eval-side policy builder composes it; see @app/eval).
export type { RoutingPolicy, SingleProviderRoutingInput } from './routing.js';
export {
  DEFAULT_ROUTING_POLICY,
  MODEL_TASKS,
  primaryProviderFor,
  primarySelectionFor,
  providerChainFor,
  selectionChainFor,
  singleProviderRoutingPolicy,
} from './routing.js';

// The vendor adapters (real, SDK-isolated) and the shared transport seam.
export { DeepSeekAdapter } from './deepseek-adapter.js';
export { GeminiAdapter } from './gemini-adapter.js';
export { ClaudeAdapter } from './claude-adapter.js';
export { BedrockMantleAdapter } from './bedrock-mantle-adapter.js';
export type { ProviderTransport, ProviderTransportInput } from './remote-adapter.js';
export { assertResolverProvider, callViaTransport } from './remote-adapter.js';

// The injected HTTP seam a vendor transport calls through (fake in tests, real in
// deployment), and the bedrock-mantle transport built on it.
export type {
  AbortSignalLike,
  HostAbortController,
  JsonHttpOutcome,
  JsonHttpPort,
  JsonHttpRequest,
  JsonHttpResponse,
  ScheduleTimeout,
} from './json-http-port.js';
export { exchangeJson, hostScheduleTimeout, newHostAbortController } from './json-http-port.js';

// The production implementation of that seam: one POST over the host `fetch`, whose
// untrusted reply is read under a hard byte cap. Deployment (and an eval run) injects
// this where a test injects a fake.
export type {
  FetchJsonHttpPortDeps,
  HostByteReader,
  HostByteStream,
  HostFetch,
  HostFetchInit,
  HostFetchResponse,
  HostHeaderReader,
  JsonHttpPortFailureCode,
} from './fetch-json-http-port.js';
export {
  DEFAULT_MAX_REPLY_BYTES,
  MAX_HONOURED_RETRY_AFTER_MS,
  JsonHttpPortError,
  createFetchJsonHttpPort,
} from './fetch-json-http-port.js';

// The boundary parser for the one reply header that travels upward: untrusted text in,
// a bounded delay in milliseconds out. Exported because the retrying transport above
// this layer honours that delay as a floor under its own backoff.
export { parseRetryAfterMs } from './retry-after.js';
export type {
  BedrockMantleTransportConfig,
  BedrockMantleTransportDeps,
  ModelPrice,
  ModelPriceTable,
} from './bedrock-mantle-transport.js';
export { createBedrockMantleTransport } from './bedrock-mantle-transport.js';
export type {
  ChatCompletionsReply,
  ChatReplyParseError,
  TokenUsage,
} from './chat-completions-reply.js';
export { parseChatCompletionsReply } from './chat-completions-reply.js';

// The test-double adapter.
export type { FakeAdapterScript } from './fake-adapter.js';
export { FakeProviderAdapter } from './fake-adapter.js';

// The router implementation and its wiring factory.
export type { ModelRouterDeps, ProviderAdapterMap } from './router.js';
export { TaskModelRouter } from './router.js';
export type { CreateModelRouterOptions, ProviderTransports } from './create-router.js';
export { createModelRouter } from './create-router.js';
