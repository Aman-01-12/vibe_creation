// Claude vendor adapter (design: Claude adapter; Req 12.4).
//
// Isolates the Claude vendor SDK behind our `ProviderAdapter` interface. It holds
// only a Claude-scoped credential resolver, so it can resolve Claude's credential
// and no other (Req 12.8). Claude is the escalation route for hard planning and
// the configured fallback for the other tasks. The real SDK call lives behind the
// injected transport and is unexercised here (no SDK, no key); see
// `remote-adapter.ts`.

import type { Result } from '@app/core';

import type {
  ModelRequest,
  ModelResult,
  ProviderAdapter,
  ProviderCallError,
  ProviderCallOptions,
} from './contract.js';
import {
  assertResolverProvider,
  callViaTransport,
  type ProviderTransport,
} from './remote-adapter.js';
import type { ProviderCredentialResolver } from './secret-manager.js';

/** Routes escalated hard planning (and fallbacks) to the Claude class behind the seam. */
export class ClaudeAdapter implements ProviderAdapter {
  readonly provider = 'claude' as const;
  readonly #resolver: ProviderCredentialResolver;
  readonly #transport: ProviderTransport | null;

  constructor(resolver: ProviderCredentialResolver, transport: ProviderTransport | null = null) {
    assertResolverProvider(resolver, 'claude');
    this.#resolver = resolver;
    this.#transport = transport;
  }

  call(
    request: ModelRequest,
    options?: ProviderCallOptions,
  ): Promise<Result<ModelResult, ProviderCallError>> {
    return callViaTransport(this.#resolver, this.#transport, request, options);
  }
}
