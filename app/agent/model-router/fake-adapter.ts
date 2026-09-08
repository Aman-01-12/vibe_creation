// In-process fake provider adapter (TEST DOUBLE - not for production use).
//
// A faithful stand-in for the `ProviderAdapter` port so the router, its routing,
// and its bounded fallback can be tested without any real vendor SDK, network, or
// credential. It executes nothing and reaches no secret manager; it returns a
// scripted result and counts how many times it was called. The real,
// SDK-isolating adapters are `DeepSeekAdapter`, `GeminiAdapter`, and
// `ClaudeAdapter`; all implement the same port so they are interchangeable by
// dependency injection.

import type { Result } from '@app/core';

import type {
  ModelRequest,
  ModelResult,
  ProviderAdapter,
  ProviderCallError,
  ProviderName,
} from './contract.js';

/** Produces the scripted result a fake call should report for a given request. */
export type FakeAdapterScript = (request: ModelRequest) => Result<ModelResult, ProviderCallError>;

/**
 * A `ProviderAdapter` that returns a scripted result instead of calling a vendor.
 *
 * Construct it with a fixed result or a function of the request. It records its
 * call count so tests can assert routing selected it (or fell back past it).
 */
export class FakeProviderAdapter implements ProviderAdapter {
  readonly provider: ProviderName;
  readonly #script: FakeAdapterScript;
  #callCount = 0;

  constructor(
    provider: ProviderName,
    script: FakeAdapterScript | Result<ModelResult, ProviderCallError>,
  ) {
    this.provider = provider;
    this.#script = typeof script === 'function' ? script : () => script;
  }

  /** How many times `call` has been invoked. */
  get callCount(): number {
    return this.#callCount;
  }

  call(request: ModelRequest): Promise<Result<ModelResult, ProviderCallError>> {
    this.#callCount += 1;
    return Promise.resolve(this.#script(request));
  }
}
