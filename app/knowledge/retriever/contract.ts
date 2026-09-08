// Knowledge_Retriever contract: the single `retrieve` tool, its result shape,
// and the ports it is programmed against (Requirement 13, task 10.2).
//
// Two structural guarantees are encoded in these types, not merely asserted in
// prose:
//
//   1. Retrieved knowledge can never override the Simulator verdict or set a
//      Trust_Tier (Req 13.6, 13.8). `RetrievalResult` carries passages, citations
//      and Cited/Unverified fact presentations only; it has no `Verdict` field and
//      no `TrustTier` field, and `ExternalFact` deliberately has no `Verified`
//      member. There is therefore no representable way for the retriever to emit a
//      verdict or a `Verified` trust label.
//
//   2. An external fact is `Cited` if and only if it carries a citation, and
//      `Unverified` otherwise (Req 13.7, 13.11, 13.12). This is a discriminated
//      union: the `Cited` arm requires a `Citation`, the `Unverified` arm forbids
//      one. Usefulness is not an input to that union, so a useful-but-uncited fact
//      still types as `Unverified`.
//
// The retriever depends only on the ports below (OKF bundle reader, web-fetch
// adapter, sanitizer), so it is fully testable without a network and without
// coupling to any concrete fetcher, mirroring the sandbox and model-router
// real-vs-fake pattern.

import type { Citation } from '@app/core';

/** A declared external-knowledge need routed through the `retrieve` tool. */
export interface KnowledgeQuery {
  /** Free-text description of what grounding is needed. */
  readonly topic: string;
  /** Optional explicit search terms; when absent, terms are derived from `topic`. */
  readonly keywords?: readonly string[];
}

/** The curation status carried by an OKF note's frontmatter. */
export type OkfStatus = 'trusted' | 'candidate';

/**
 * Whether a passage may steer generation as authority or is only a hint.
 *
 * Only a `status: trusted` OKF note is `authority` (Req 13.8/13.9); a
 * `status: candidate` note and all web content are `hint`. Web content is never
 * authority, because it is neither curated nor eval-gated.
 */
export type PassageAuthority = 'authority' | 'hint';

/** Where a passage came from. */
export type PassageOrigin = 'okf' | 'web';

/**
 * A selected unit of grounding surfaced to the Orchestrator.
 *
 * `okfStatus` is present only for OKF passages; `citation` is present only when
 * the passage is attributable to a source.
 */
export interface KnowledgePassage {
  readonly title: string;
  /** Passage text. Web passages are already sanitized (see `RetrievalResult.sanitized`). */
  readonly content: string;
  readonly origin: PassageOrigin;
  readonly authority: PassageAuthority;
  readonly okfStatus?: OkfStatus;
  readonly citation?: Citation;
}

/** An external fact shown with a citation because it is attributable. */
export interface CitedFact {
  readonly presentation: 'Cited';
  readonly claim: string;
  readonly citation: Citation;
}

/** An external fact shown as `Unverified` because no citation attributes it. */
export interface UnverifiedFact {
  readonly presentation: 'Unverified';
  readonly claim: string;
}

/**
 * An external fact's presentation treatment.
 *
 * Closed union with exactly two arms and no `Verified` member: a citation is
 * attribution, not a Simulator verdict (Req 13.10), so the retriever cannot
 * present anything as oracle-`Verified`.
 */
export type ExternalFact = CitedFact | UnverifiedFact;

/** Which family of sources the result was drawn from. */
export type RetrievalSource = 'okf' | 'web';

/**
 * The outcome of one `retrieve` call.
 *
 * `sanitized` is the literal `true`: any web content in `passages`/`facts` has
 * been neutralized against prompt injection before this value leaves the
 * retriever (Req 13.4). It has no `verdict` and no `trustTier` field by design.
 */
export interface RetrievalResult {
  readonly passages: readonly KnowledgePassage[];
  readonly citations: readonly Citation[];
  readonly facts: readonly ExternalFact[];
  readonly source: RetrievalSource;
  readonly sanitized: true;
}

/** The single knowledge-grounding tool the Orchestrator calls (Req 13.1). */
export interface KnowledgeRetriever {
  retrieve(query: KnowledgeQuery): Promise<RetrievalResult>;
}

// ---------------------------------------------------------------------------
// Injected ports
// ---------------------------------------------------------------------------

/** A raw OKF note as read from the bundle, before frontmatter parsing. */
export interface RawOkfNote {
  /** Bundle-relative path, used as the citation source for the note. */
  readonly path: string;
  /** Raw markdown, including the YAML frontmatter block. */
  readonly content: string;
}

/**
 * Reads the curated OKF bundle.
 *
 * The retriever consults this before any web search (Req 13.2). A filesystem
 * implementation and an in-memory fake are provided; the retriever itself is
 * indifferent to which is injected.
 */
export interface OkfBundleReader {
  listNotes(): Promise<readonly RawOkfNote[]>;
}

/** A declared gap the OKF bundle did not cover, handed to the web-fetch adapter. */
export interface KnowledgeGap {
  readonly query: KnowledgeQuery;
  /** Non-sensitive explanation of why a web fetch was needed. */
  readonly reason: string;
}

/** A single untrusted document returned by a web fetch. */
export interface WebDocument {
  /** Source URL; empty when the source cannot be attributed (renders `Unverified`). */
  readonly url: string;
  readonly title: string;
  /** UNTRUSTED, unsanitized content; the retriever sanitizes it before use. */
  readonly content: string;
}

/** The result of a targeted, gap-only web fetch. */
export interface WebFetchResult {
  readonly documents: readonly WebDocument[];
}

/**
 * Performs a targeted, gap-only web fetch (Req 13.3), never a blind crawl.
 *
 * The concrete network-backed implementation is wired in at composition time in
 * an outer layer (the knowledge layer imports `@app/core` only and does no
 * network I/O); this port keeps the retriever testable with a fake. It is the
 * same real-vs-fake seam used by the sandbox runtime and model-router adapters.
 */
export interface WebFetchAdapter {
  fetchForGap(gap: KnowledgeGap): Promise<WebFetchResult>;
}

/** The outcome of sanitizing one string of untrusted web content. */
export interface SanitizedContent {
  /** Input with every recognized injection-control span neutralized. */
  readonly text: string;
  readonly neutralized: boolean;
  /** The raw spans that were neutralized, for the Trace. */
  readonly markersFound: readonly string[];
}

/**
 * Neutralizes prompt-injection control content in retrieved web text.
 *
 * A knowledge-layer concern because `@app/knowledge` cannot import the API
 * gateway's filter; the gateway still filters inbound free-text at the outer
 * boundary, so this is defense in depth, not a replacement.
 */
export interface KnowledgeSanitizer {
  sanitize(content: string): SanitizedContent;
}
