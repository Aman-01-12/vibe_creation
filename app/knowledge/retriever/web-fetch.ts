// Web-fetch adapter test doubles.
//
// The concrete network-backed adapter (a web scraper/extractor) is wired in at
// composition time in an outer layer, because `@app/knowledge` imports `@app/core`
// only and performs no network I/O. Within this layer we provide two doubles: a
// fail-safe "unavailable" adapter used as the default when no fetcher is wired,
// and a scriptable fake that records its calls so tests can assert the retriever
// consults the OKF bundle before ever reaching for the web (Req 13.2, 13.3).

import type { KnowledgeGap, WebDocument, WebFetchAdapter, WebFetchResult } from './contract.js';

/** An empty result, reused so the unavailable adapter allocates nothing per call. */
const EMPTY_RESULT: WebFetchResult = { documents: [] };

/**
 * A fail-safe `WebFetchAdapter` that returns no documents.
 *
 * The default when no network fetcher is configured: a missing web tier degrades
 * to OKF-only grounding rather than an error, and never fabricates content.
 */
export class UnavailableWebFetchAdapter implements WebFetchAdapter {
  // The gap argument is intentionally unused: with no fetcher wired, every gap
  // degrades to the same empty result. Omitting the parameter still satisfies the
  // `WebFetchAdapter` signature (an implementation may accept fewer parameters).
  fetchForGap(): Promise<WebFetchResult> {
    return Promise.resolve(EMPTY_RESULT);
  }
}

/**
 * A scriptable `WebFetchAdapter` for tests.
 *
 * Returns the documents it was constructed with and records every gap it was
 * asked to fetch, so a test can assert the adapter was NOT called when the OKF
 * bundle covered the query, and was called exactly once (for the declared gap)
 * when it did not.
 */
export class FakeWebFetchAdapter implements WebFetchAdapter {
  readonly #documents: readonly WebDocument[];
  readonly #gaps: KnowledgeGap[] = [];

  constructor(documents: readonly WebDocument[] = []) {
    this.#documents = [...documents];
  }

  fetchForGap(gap: KnowledgeGap): Promise<WebFetchResult> {
    this.#gaps.push(gap);
    return Promise.resolve({ documents: this.#documents });
  }

  /** The gaps this adapter was asked to fetch, in order. */
  get gaps(): readonly KnowledgeGap[] {
    return [...this.#gaps];
  }

  /** How many times `fetchForGap` was invoked. */
  get callCount(): number {
    return this.#gaps.length;
  }
}
