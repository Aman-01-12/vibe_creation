// OKF-first, gap-only Knowledge_Retriever (Requirement 13, task 10.2).
//
// Flow of a single `retrieve` call:
//   1. Consult the curated OKF bundle FIRST (Req 13.2): read and parse every note,
//      then select the ones relevant to the query. A `status: trusted` note is
//      surfaced as authority; a `status: candidate` note as a hint (Req 13.8/13.9).
//   2. Only if no OKF note covers the query, perform a TARGETED, gap-only web fetch
//      through the injected adapter (Req 13.3) - never a blind crawl, and never
//      when the bundle already covers the need.
//   3. SANITIZE all retrieved web content against prompt injection before it leaves
//      the retriever (Req 13.4).
//   4. Return passages WITH CITATIONS (Req 13.5), each fact presented `Cited` when a
//      citation attributes it and `Unverified` when not (Req 13.7, 13.10, 13.12),
//      derived independently of usefulness (Req 13.11).
//
// The result type carries no verdict and no Trust_Tier, so retrieved knowledge can
// only improve a proposal; it can never override the Simulator verdict or set a
// trust label (Req 13.6, 13.8). See contract.ts for that structural guarantee.

import type { Citation } from '@app/core';

import type {
  KnowledgePassage,
  KnowledgeQuery,
  KnowledgeRetriever,
  KnowledgeSanitizer,
  OkfBundleReader,
  RetrievalResult,
  WebDocument,
  WebFetchAdapter,
} from './contract.js';
import { parseOkfNote } from './frontmatter.js';
import type { OkfNote } from './okf-note.js';
import { presentExternalFact } from './presentation.js';
import { defaultKnowledgeSanitizer } from './sanitizer.js';
import { UnavailableWebFetchAdapter } from './web-fetch.js';

/** Note types that are navigation maps, not concept content, so never selected. */
const MAP_OF_CONTENT_TYPE = 'moc';

/** Shortest query token considered for relevance, to skip noise words like "of". */
const MIN_TOKEN_LENGTH = 3;

/** Collaborators injected into the retriever; all replaceable for tests. */
export interface KnowledgeRetrieverDeps {
  readonly okfReader: OkfBundleReader;
  readonly webFetch?: WebFetchAdapter;
  readonly sanitizer?: KnowledgeSanitizer;
}

/** The default OKF-first, gap-only implementation of the `retrieve` tool. */
export class OkfFirstKnowledgeRetriever implements KnowledgeRetriever {
  readonly #okfReader: OkfBundleReader;
  readonly #webFetch: WebFetchAdapter;
  readonly #sanitizer: KnowledgeSanitizer;

  constructor(deps: KnowledgeRetrieverDeps) {
    this.#okfReader = deps.okfReader;
    this.#webFetch = deps.webFetch ?? new UnavailableWebFetchAdapter();
    this.#sanitizer = deps.sanitizer ?? defaultKnowledgeSanitizer;
  }

  async retrieve(query: KnowledgeQuery): Promise<RetrievalResult> {
    const okfPassages = await this.#selectOkfPassages(query);
    if (okfPassages.length > 0) {
      return this.#buildResult(okfPassages, 'okf');
    }
    const webPassages = await this.#fetchWebPassages(query);
    return this.#buildResult(webPassages, 'web');
  }

  /** Read, parse, and select the OKF notes relevant to the query. */
  async #selectOkfPassages(query: KnowledgeQuery): Promise<readonly KnowledgePassage[]> {
    const rawNotes = await this.#okfReader.listNotes();
    const tokens = queryTokens(query);
    return rawNotes
      .map((raw) => parseOkfNote(raw))
      .filter((note): note is OkfNote => note !== null && note.type !== MAP_OF_CONTENT_TYPE)
      .filter((note) => noteMatchesTokens(note, tokens))
      .map((note) => okfPassage(note));
  }

  /**
   * Perform the gap-only web fetch and turn each document into a sanitized passage.
   *
   * Every document's title and content is neutralized against prompt injection
   * before it becomes a passage, so no unsanitized web text leaves the retriever.
   */
  async #fetchWebPassages(query: KnowledgeQuery): Promise<readonly KnowledgePassage[]> {
    const gap = { query, reason: 'not covered by curated OKF bundle' } as const;
    const { documents } = await this.#webFetch.fetchForGap(gap);
    return documents.map((document) => this.#webPassage(document));
  }

  /** Sanitize one untrusted web document into a hint passage. */
  #webPassage(document: WebDocument): KnowledgePassage {
    const title = this.#sanitizer.sanitize(document.title).text;
    const content = this.#sanitizer.sanitize(document.content).text;
    const citation = webCitation(title, content, document.url);
    const base: KnowledgePassage = { title, content, origin: 'web', authority: 'hint' };
    return citation === undefined ? base : { ...base, citation };
  }

  /** Assemble the final result: passages, their citations, and fact presentations. */
  #buildResult(passages: readonly KnowledgePassage[], source: 'okf' | 'web'): RetrievalResult {
    const citations = passages
      .map((passage) => passage.citation)
      .filter((citation): citation is Citation => citation !== undefined);
    const facts = passages.map((passage) => presentExternalFact(passage.title, passage.citation));
    return { passages, citations, facts, source, sanitized: true };
  }
}

/** Build a `KnowledgePassage` from a parsed OKF note, with the note as its citation. */
function okfPassage(note: OkfNote): KnowledgePassage {
  return {
    title: note.title,
    content: note.body,
    origin: 'okf',
    authority: note.status === 'trusted' ? 'authority' : 'hint',
    okfStatus: note.status,
    citation: okfCitation(note),
  };
}

/** A curated OKF note is always attributable to its bundle path. */
function okfCitation(note: OkfNote): Citation {
  return {
    claim: note.title,
    sourceUrl: `okf://${note.path}`,
    sourceTitle: note.title,
    presentation: 'cited',
  };
}

/**
 * A web citation, present only when the document carries a source URL.
 *
 * A document with no URL is unattributable, so its fact is later presented
 * `Unverified` (Req 13.7); the URL and title are already sanitized by the caller.
 */
function webCitation(title: string, content: string, url: string): Citation | undefined {
  if (url.trim().length === 0) {
    return undefined;
  }
  const claim = title.trim().length > 0 ? title : content.slice(0, 80);
  return { claim, sourceUrl: url, sourceTitle: title, presentation: 'cited' };
}

/** Lowercased, deduplicated relevance tokens from the query's topic and keywords. */
function queryTokens(query: KnowledgeQuery): ReadonlySet<string> {
  const fromTopic = query.topic.toLowerCase().split(/[^a-z0-9]+/i);
  const fromKeywords = (query.keywords ?? []).flatMap((keyword) =>
    keyword.toLowerCase().split(/[^a-z0-9]+/i),
  );
  const tokens = [...fromTopic, ...fromKeywords].filter(
    (token) => token.length >= MIN_TOKEN_LENGTH,
  );
  return new Set(tokens);
}

/** A note is relevant when any query token appears in its title, tags, or body. */
function noteMatchesTokens(note: OkfNote, tokens: ReadonlySet<string>): boolean {
  if (tokens.size === 0) {
    return false;
  }
  const haystack = `${note.title} ${note.tags.join(' ')} ${note.body}`.toLowerCase();
  for (const token of tokens) {
    if (haystack.includes(token)) {
      return true;
    }
  }
  return false;
}
