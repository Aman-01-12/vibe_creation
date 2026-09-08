// Gemini Flash vendor adapter (design: Gemini adapter; Req 12.3).
//
// Isolates the Gemini vendor SDK behind our `ProviderAdapter` interface. It holds
// only a Gemini-scoped credential resolver, so it can resolve Gemini's credential
// and no other (Req 12.8). The real SDK call lives behind the injected transport
// and is unexercised here (no SDK, no key); see `remote-adapter.ts`.

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

/** Routes orchestration and teaching tasks to Gemini Flash behind the SDK seam. */
export class GeminiAdapter implements ProviderAdapter {
  readonly provider = 'gemini' as const;
  readonly #resolver: ProviderCredentialResolver;
  readonly #transport: ProviderTransport | null;

  constructor(resolver: ProviderCredentialResolver, transport: ProviderTransport | null = null) {
    assertResolverProvider(resolver, 'gemini');
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
