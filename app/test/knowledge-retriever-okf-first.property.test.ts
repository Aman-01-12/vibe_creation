// Property 26: Retrieval is OKF-first and gap-only for web, with sanitized
// untrusted content (task 10.3).
//
// This is the universal complement to the example checks in
// `knowledge-retriever.test.ts` (task 10.2). Over many generated OKF bundles,
// queries, and web documents it asserts the three guarantees the
// Knowledge_Retriever must never break (Design: Property 26; Req 13.2, 13.3, 13.4):
//
//   1. OKF-first (Req 13.2): when the curated bundle contains a note relevant to
//      the query, `retrieve` returns source `okf` and the web-fetch adapter is
//      NEVER consulted (callCount 0). The web is not touched when the bundle
//      already covers the need.
//   2. Gap-only (Req 13.3): when NO OKF note matches the query, the web-fetch
//      adapter is invoked EXACTLY once - for the one declared gap, never a blind
//      crawl - and the result source is `web`.
//   3. Sanitized untrusted content (Req 13.4): for any web document whose title
//      or content embeds prompt-injection markers, every returned web passage has
//      no raw marker left and carries the neutralized placeholder, and
//      `result.sanitized` is the literal `true`.
//
// It also pins the authority rule the two branches imply: web passages are always
// `hint` (never `authority`), while an OKF passage is `authority` iff its note is
// `status: trusted` and a `hint` otherwise (Req 13.8, 13.9).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  FakeWebFetchAdapter,
  InMemoryOkfBundleReader,
  NEUTRALIZED_PLACEHOLDER,
  OkfFirstKnowledgeRetriever,
  type OkfStatus,
  type RawOkfNote,
  type WebDocument,
} from '@app/knowledge';
import {
  INJECTION_MARKERS,
  injectionMarkerArbitrary,
  propertyParameters,
  propertyTag,
} from '@app/test';

const PROPERTY = propertyTag(
  26,
  'Retrieval is OKF-first and gap-only for web, with sanitized untrusted content',
);

// -- Alphabets --------------------------------------------------------------
//
// The bundle-content alphabet and the gap-query alphabet are DISJOINT letter
// sets. Note relevance is a substring test over a note's title, tags, and body
// (all built from `CONTENT_LETTERS`), so a query token built only from
// `GAP_LETTERS` can never be a substring of any note - which lets the gap
// generator force the no-match branch with certainty rather than by luck.

/** Letters used for every piece of OKF note content the matcher inspects. */
const CONTENT_LETTERS: readonly string[] = 'abcdefghijklm'.split('');

/** Letters used for gap queries; disjoint from `CONTENT_LETTERS` by construction. */
const GAP_LETTERS: readonly string[] = 'nopqrstuvwxyz'.split('');

/** OKF note types that are concept content, never a `moc` navigation map. */
const CONCEPT_TYPES: readonly string[] = ['pattern', 'verification-recipe', 'toolchain-note'];

/** A token long enough to survive the retriever's 3-char relevance floor. */
const MIN_TOKEN_LEN = 4;
const MAX_TOKEN_LEN = 8;

// -- Primitive arbitraries --------------------------------------------------

/** A lowercase word drawn from `letters`, length in the relevance-safe range. */
function word(letters: readonly string[]): fc.Arbitrary<string> {
  const [first, ...rest] = letters;
  if (first === undefined) {
    throw new Error('word requires a non-empty alphabet');
  }
  return fc
    .array(fc.constantFrom(first, ...rest), { minLength: MIN_TOKEN_LEN, maxLength: MAX_TOKEN_LEN })
    .map((chars) => chars.join(''));
}

/** A short phrase of `letters` words joined by spaces (may be empty). */
function phrase(letters: readonly string[]): fc.Arbitrary<string> {
  return fc.array(word(letters), { minLength: 0, maxLength: 4 }).map((words) => words.join(' '));
}

/** Serialize a note spec into the raw markdown + frontmatter the reader expects. */
function toRawNote(spec: {
  readonly path: string;
  readonly type: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly status: OkfStatus;
  readonly body: string;
}): RawOkfNote {
  const content = [
    '---',
    `type: ${spec.type}`,
    `title: ${spec.title}`,
    `tags: [${spec.tags.join(', ')}]`,
    `status: ${spec.status}`,
    '---',
    '',
    spec.body,
  ].join('\n');
  return { path: spec.path, content };
}

/** A content-alphabet OKF note that shares no tokens with any gap query. */
function contentNoteArbitrary(): fc.Arbitrary<RawOkfNote> {
  return fc
    .record({
      slug: word(CONTENT_LETTERS),
      type: fc.constantFrom(...CONCEPT_TYPES),
      title: phrase(CONTENT_LETTERS),
      tags: fc.array(word(CONTENT_LETTERS), { minLength: 0, maxLength: 3 }),
      status: fc.constantFrom<OkfStatus>('trusted', 'candidate'),
      body: phrase(CONTENT_LETTERS),
    })
    .map((spec) => toRawNote({ ...spec, path: `notes/${spec.slug}.md` }));
}

// -- OKF-hit case: a bundle note that covers the query ----------------------

interface OkfHitCase {
  readonly notes: readonly RawOkfNote[];
  readonly query: { readonly topic: string; readonly keywords: readonly string[] };
}

/**
 * A bundle containing a concept note whose tags carry a distinctive match token,
 * plus a query keyed on that token, so the OKF-first branch is forced. The note's
 * `status` varies so both `authority` (trusted) and `hint` (candidate) are seen.
 */
function okfHitCaseArbitrary(): fc.Arbitrary<OkfHitCase> {
  return fc
    .record({
      matchToken: word(CONTENT_LETTERS),
      type: fc.constantFrom(...CONCEPT_TYPES),
      title: phrase(CONTENT_LETTERS),
      extraTags: fc.array(word(CONTENT_LETTERS), { minLength: 0, maxLength: 2 }),
      status: fc.constantFrom<OkfStatus>('trusted', 'candidate'),
      body: phrase(CONTENT_LETTERS),
      distractors: fc.array(contentNoteArbitrary(), { minLength: 0, maxLength: 2 }),
      slug: word(CONTENT_LETTERS),
    })
    .map(({ matchToken, type, title, extraTags, status, body, distractors, slug }) => {
      const relevant = toRawNote({
        path: `notes/hit-${slug}.md`,
        type,
        title,
        tags: [matchToken, ...extraTags],
        status,
        body,
      });
      return {
        notes: [...distractors, relevant],
        query: { topic: title, keywords: [matchToken] },
      };
    });
}

// -- Gap case: a populated bundle that covers nothing in the query ----------

interface GapCase {
  readonly notes: readonly RawOkfNote[];
  readonly query: { readonly topic: string; readonly keywords: readonly string[] };
  readonly documents: readonly WebDocument[];
}

/** A URL or an unattributable blank, so both citation states are exercised. */
function urlArbitrary(): fc.Arbitrary<string> {
  return fc.oneof(
    word(GAP_LETTERS).map((host) => `https://${host}.example/doc`),
    fc.constantFrom('', '   '),
  );
}

/** A benign web document (no injection markers), for the gap-only branch. */
function benignDocumentArbitrary(): fc.Arbitrary<WebDocument> {
  return fc.record({
    url: urlArbitrary(),
    title: phrase(CONTENT_LETTERS),
    content: phrase(CONTENT_LETTERS),
  });
}

/**
 * A populated content-alphabet bundle paired with a gap-alphabet query. Because
 * the alphabets are disjoint, no note can match, forcing the gap-only web branch.
 */
function gapCaseArbitrary(): fc.Arbitrary<GapCase> {
  return fc.record({
    notes: fc.array(contentNoteArbitrary(), { minLength: 0, maxLength: 3 }),
    query: fc.record({
      topic: phrase(GAP_LETTERS).map((text) => text.trim()),
      keywords: fc.array(word(GAP_LETTERS), { minLength: 1, maxLength: 3 }),
    }),
    documents: fc.array(benignDocumentArbitrary(), { minLength: 0, maxLength: 3 }),
  });
}

// -- Sanitization case: web documents carrying injection markers ------------

interface SanitizeCase {
  readonly query: { readonly topic: string; readonly keywords: readonly string[] };
  readonly documents: readonly WebDocument[];
}

/** A web document whose content always embeds an injection marker; title sometimes. */
function injectedDocumentArbitrary(): fc.Arbitrary<WebDocument> {
  return fc.record({
    url: urlArbitrary(),
    title: fc.oneof(injectionMarkerArbitrary(), phrase(CONTENT_LETTERS)),
    content: injectionMarkerArbitrary(),
  });
}

/**
 * An EMPTY bundle plus at least one injected web document, so the web branch is
 * forced and every returned passage must be sanitized.
 */
function sanitizeCaseArbitrary(): fc.Arbitrary<SanitizeCase> {
  return fc.record({
    query: fc.record({
      topic: phrase(GAP_LETTERS).map((text) => text.trim()),
      keywords: fc.array(word(GAP_LETTERS), { minLength: 1, maxLength: 3 }),
    }),
    documents: fc.array(injectedDocumentArbitrary(), { minLength: 1, maxLength: 3 }),
  });
}

/** Assert a string carries no raw injection marker from the shared corpus. */
function expectNoRawMarker(text: string): void {
  for (const marker of INJECTION_MARKERS) {
    expect(text).not.toContain(marker);
  }
}

// -- Properties -------------------------------------------------------------

describe(PROPERTY, () => {
  it('is OKF-first: a covering bundle note yields source okf and never touches the web (Req 13.2)', async () => {
    await fc.assert(
      fc.asyncProperty(okfHitCaseArbitrary(), async ({ notes, query }) => {
        const web = new FakeWebFetchAdapter([
          { url: 'https://unused.example', title: 't', content: 'c' },
        ]);
        const retriever = new OkfFirstKnowledgeRetriever({
          okfReader: new InMemoryOkfBundleReader(notes),
          webFetch: web,
        });

        const result = await retriever.retrieve(query);

        expect(result.source).toBe('okf');
        expect(web.callCount).toBe(0);
        expect(result.passages.length).toBeGreaterThan(0);
        // Every returned passage is an OKF passage, and its authority follows its
        // curation status: trusted -> authority, candidate -> hint (Req 13.8/13.9).
        for (const passage of result.passages) {
          expect(passage.origin).toBe('okf');
          const expectedAuthority = passage.okfStatus === 'trusted' ? 'authority' : 'hint';
          expect(passage.authority).toBe(expectedAuthority);
        }
      }),
      propertyParameters(),
    );
  });

  it('is gap-only: an uncovered query fetches the web exactly once, source web (Req 13.3)', async () => {
    await fc.assert(
      fc.asyncProperty(gapCaseArbitrary(), async ({ notes, query, documents }) => {
        const web = new FakeWebFetchAdapter(documents);
        const retriever = new OkfFirstKnowledgeRetriever({
          okfReader: new InMemoryOkfBundleReader(notes),
          webFetch: web,
        });

        const result = await retriever.retrieve(query);

        expect(result.source).toBe('web');
        // Exactly one fetch, for the one declared gap - never a blind crawl.
        expect(web.callCount).toBe(1);
        expect(web.gaps[0]?.query.topic).toBe(query.topic);
        // Web passages are never authority.
        for (const passage of result.passages) {
          expect(passage.origin).toBe('web');
          expect(passage.authority).toBe('hint');
        }
      }),
      propertyParameters(),
    );
  });

  it('sanitizes untrusted web content: no raw markers remain and each passage is neutralized (Req 13.4)', async () => {
    await fc.assert(
      fc.asyncProperty(sanitizeCaseArbitrary(), async ({ query, documents }) => {
        const web = new FakeWebFetchAdapter(documents);
        const retriever = new OkfFirstKnowledgeRetriever({
          // Empty bundle forces the web branch for every generated query.
          okfReader: new InMemoryOkfBundleReader([]),
          webFetch: web,
        });

        const result = await retriever.retrieve(query);

        expect(result.source).toBe('web');
        expect(result.sanitized).toBe(true);
        expect(result.passages.length).toBe(documents.length);
        for (const passage of result.passages) {
          // No raw injection marker survives in either the title or the content.
          expectNoRawMarker(passage.title);
          expectNoRawMarker(passage.content);
          // The content always embedded a marker, so it must carry the placeholder.
          expect(passage.content).toContain(NEUTRALIZED_PLACEHOLDER);
          // Sanitized web content is still only a hint, never authority.
          expect(passage.authority).toBe('hint');
        }
      }),
      propertyParameters(),
    );
  });
});
