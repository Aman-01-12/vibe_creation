// Factory that wires a Model_Router with credential-confined vendor adapters.
//
// This is where credential confinement is established (Req 12.7, 12.8): each
// adapter is constructed with a resolver scoped to ITS OWN provider via
// `scopeToProvider`, so no adapter can reach a sibling's credential. The router
// itself is handed only the adapters; it never receives the `SecretManagerPort`,
// so credentials cannot land in shared router or Orchestrator state.
//
// Vendor transports are injected per provider and default to unwired (null), so
// out of the box the adapters fail safe with `provider-unavailable` rather than
// calling a real API. Deployment supplies concrete transports behind the same
// interface.

import type { ActionRecorder } from '../action-recorder/index.js';

import { BedrockMantleAdapter } from './bedrock-mantle-adapter.js';
import { ClaudeAdapter } from './claude-adapter.js';
import type { ModelRouter, ProviderName } from './contract.js';
import { DeepSeekAdapter } from './deepseek-adapter.js';
import { GeminiAdapter } from './gemini-adapter.js';
import type { ProviderTransport } from './remote-adapter.js';
import { TaskModelRouter } from './router.js';
import type { RoutingPolicy } from './routing.js';
import { scopeToProvider, type SecretManagerPort } from './secret-manager.js';

/** Optional per-provider vendor transports; any omitted provider stays unwired. */
export type ProviderTransports = Partial<Record<ProviderName, ProviderTransport>>;

/** Inputs to build a fully wired, credential-confined `ModelRouter`. */
export interface CreateModelRouterOptions {
  readonly secretManager: SecretManagerPort;
  readonly recorder: ActionRecorder;
  readonly transports?: ProviderTransports;
  readonly policy?: RoutingPolicy;
  readonly now?: () => Date;
}

/**
 * Build a `ModelRouter` whose vendor adapters each resolve only their own provider's
 * credential from the injected secret manager at the point of use.
 *
 * Every `ProviderName` gets an adapter, so a routing policy can never select a
 * provider that has none. An adapter with no injected transport fails safe with
 * `provider-unavailable` instead of calling out.
 */
export function createModelRouter(options: CreateModelRouterOptions): ModelRouter {
  const { secretManager, recorder, transports, policy, now } = options;
  const adapters = {
    deepseek: new DeepSeekAdapter(
      scopeToProvider(secretManager, 'deepseek'),
      transports?.deepseek ?? null,
    ),
    gemini: new GeminiAdapter(scopeToProvider(secretManager, 'gemini'), transports?.gemini ?? null),
    claude: new ClaudeAdapter(scopeToProvider(secretManager, 'claude'), transports?.claude ?? null),
    'bedrock-mantle': new BedrockMantleAdapter(
      scopeToProvider(secretManager, 'bedrock-mantle'),
      transports?.['bedrock-mantle'] ?? null,
    ),
  } as const;
  return new TaskModelRouter({
    adapters,
    recorder,
    ...(policy === undefined ? {} : { policy }),
    ...(now === undefined ? {} : { now }),
  });
}
