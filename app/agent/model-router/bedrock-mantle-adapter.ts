// bedrock-mantle vendor adapter (design: vendor adapters; Req 12.7, 12.8).
//
// Amazon Bedrock's OpenAI-compatible Chat Completions host, isolated behind our
// `ProviderAdapter` interface. It holds only a bedrock-mantle-scoped credential
// resolver, so it can resolve that provider's credential and no other, and it
// resolves it at the point of use inside `callViaTransport` - never at construction,
// never into a field.
//
// One instance serves the whole bedrock-mantle catalog: the routed model id arrives
// per call on `ProviderCallOptions` and is handed to the transport, because a single
// credential fronts every model on this host (see `bedrock-mantle-transport.ts`).

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

/** Routes calls to the bedrock-mantle host behind the injected vendor transport. */
export class BedrockMantleAdapter implements ProviderAdapter {
  readonly provider = 'bedrock-mantle' as const;
  readonly #resolver: ProviderCredentialResolver;
  readonly #transport: ProviderTransport | null;

  constructor(resolver: ProviderCredentialResolver, transport: ProviderTransport | null = null) {
    assertResolverProvider(resolver, 'bedrock-mantle');
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
