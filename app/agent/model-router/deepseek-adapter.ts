// DeepSeek V4 vendor adapter (design: DeepSeek adapter; Req 12.2).
//
// Isolates the DeepSeek vendor SDK behind our `ProviderAdapter` interface. It
// holds only a DeepSeek-scoped credential resolver, so it can resolve DeepSeek's
// credential and no other (Req 12.8). The real SDK call lives behind the injected
// transport and is unexercised here (no SDK, no key); see `remote-adapter.ts`.

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

/** Routes generation and repair tasks to DeepSeek V4 behind the vendor SDK seam. */
export class DeepSeekAdapter implements ProviderAdapter {
  readonly provider = 'deepseek' as const;
  readonly #resolver: ProviderCredentialResolver;
  readonly #transport: ProviderTransport | null;

  constructor(resolver: ProviderCredentialResolver, transport: ProviderTransport | null = null) {
    assertResolverProvider(resolver, 'deepseek');
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
