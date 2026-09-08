// Property 27 for the Knowledge_Retriever: Facts are Cited iff they have a
// citation, independent of usefulness (task 10.4).
//
// This is the universal complement to the concrete examples in
// `knowledge-retriever.test.ts`. It asserts, over generated inputs, the four
// guarantees the design binds to Property 27 (Req 13.5, 13.7, 13.10, 13.11, 13.12):
//
//   - Cited IFF citation: `presentExternalFact(claim, citation)` presents `Cited`
//     (carrying the citation) exactly when a citation is supplied, and
//     `Unverified` exactly when it is not - a strict biconditional (Req 13.7, 13.12).
//   - Independent of usefulness: a generated "usefulness"/influence flag has NO
//     effect on the presentation. A useful-but-uncited fact is still `Unverified`
//     and a not-useful-but-cited fact is still `Cited`; usefulness is not even a
//     parameter of the labeling function, so it can never suppress `Unverified`
//     (Req 13.11).
//   - Never Verified: the presentation is always one of `Cited`/`Unverified` and
//     never oracle-`Verified` - a citation is attribution, not a verdict (Req 13.10).
//   - Through the retriever: driving `retrieve()` with web documents that carry a
//     URL yields `Cited` facts that appear in `result.citations`, while documents
//     with a blank/absent URL yield `Unverified` facts that contribute no citation;
//     the citations list and the fact presentations line up exactly (Req 13.5, 13.12).
//
// The labeling function takes only (claim, citation?), so usefulness-independence
// holds by construction; the property proves it stays that way across all inputs.
// The retriever assertions use an empty OKF bundle (so every query is a gap that
// forces the web path) plus a scriptable fake fetcher, keeping the property
// hermetic - no network, no filesystem.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Citation } from '@app/core';
import {
  FakeWebFetchAdapter,
  InMemoryOkfBundleReader,
  OkfFirstKnowledgeRetriever,
  presentExternalFact,
  type CitedFact,
  type ExternalFact,
  type WebDocument,
} from '@app/knowledge';
import { propertyParameters, propertyTag } from '@app/test';

// --- Local character helpers -------------------------------------------------
// Benign alphabets only: generated titles/content/urls never contain the
// injection-control spans the knowledge sanitizer keys on, so sanitization can
// neither drop nor rewrite them and the citation-vs-URL correspondence the
// property asserts stays exact.

const LOWER: readonly string[] = 'abcdefghijklmnopqrstuvwxyz'.split('');
const DIGITS: readonly string[] = '0123456789'.split('');

/** An arbitrary string of length `[min, max]` drawn from an explicit alphabet. */
function fromChars(chars: readonly string[], min: number, max: number): fc.Arbitrary<string> {
  const [first, ...rest] = chars;
  if (first === undefined) {
    throw new Error('fromChars requires a non-empty character set');
  }
  return fc
    .array(fc.constantFrom(first, ...rest), { minLength: min, maxLength: max })
    .map((picked) => picked.join(''));
}

// --- Generators for the labeling-function property ---------------------------

/** Claims span empty, whitespace, unicode, and ordinary text. */
const claimArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.constant(''),
  fc.constant('   '),
  fc.string({ unit: 'grapheme' }),
);

/** A core `Citation` with a required literal `presentation: 'cited'`. */
function citationArbitrary(): fc.Arbitrary<Citation> {
  const host = fromChars(LOWER, 3, 10);
  const tld = fromChars(LOWER, 2, 3);
  return fc.record<Citation>({
    claim: fc.string(),
    sourceUrl: fc.tuple(host, tld).map(([h, t]) => `https://${h}.${t}/doc`),
    sourceTitle: fc.string(),
    presentation: fc.constant('cited' as const),
  });
}

// --- Generators for the retriever-level property -----------------------------

/** A benign, non-empty title/content fragment (letters, digits, spaces). */
const benignTextArbitrary: fc.Arbitrary<string> = fromChars([...LOWER, ...DIGITS, ' '], 1, 24);

/** A non-blank source URL, so its document is attributable. */
const nonBlankUrlArbitrary: fc.Arbitrary<string> = fc
  .tuple(fromChars(LOWER, 3, 10), fromChars(LOWER, 2, 3))
  .map(([host, tld]) => `https://${host}.${tld}/x`);

/** A blank/absent URL, so its document cannot be attributed. */
const blankUrlArbitrary: fc.Arbitrary<string> = fc.constantFrom('', ' ', '   ', '\t', '\n');

/** A web document that either carries a URL or is deliberately unattributable. */
function webDocumentArbitrary(): fc.Arbitrary<WebDocument> {
  return fc.record<WebDocument>({
    url: fc.oneof(nonBlankUrlArbitrary, blankUrlArbitrary),
    title: benignTextArbitrary,
    content: benignTextArbitrary,
  });
}

/** A document is attributable exactly when its URL has non-whitespace content. */
function hasUrl(document: WebDocument): boolean {
  return document.url.trim().length > 0;
}

/** Narrow an `ExternalFact` to its `Cited` arm to reach `.citation`. */
function isCited(fact: ExternalFact): fact is CitedFact {
  return fact.presentation === 'Cited';
}

// --- Properties --------------------------------------------------------------

describe('Knowledge_Retriever citation labeling (Property 27)', () => {
  // Feature: hdl-creation-loop, Property 27: Facts are Cited iff they have a citation, independent of usefulness
  it('labels a fact Cited iff a citation exists, regardless of usefulness, and never Verified', () => {
    fc.assert(
      fc.property(
        claimArbitrary,
        fc.option(citationArbitrary(), { nil: undefined }),
        // The "usefulness"/influence flag: whether the fact improved a proposal.
        fc.boolean(),
        (claim, citation, useful) => {
          void useful; // Deliberately not passed: usefulness cannot reach the label.
          const fact = presentExternalFact(claim, citation);

          // Cited IFF citation - a strict biconditional (Req 13.7, 13.12).
          expect(fact.presentation === 'Cited').toBe(citation !== undefined);

          // Usefulness-independence (Req 13.11): the presentation is fixed by
          // citation presence alone, so it is identical for useful === true and
          // useful === false. A useful-but-uncited fact stays Unverified; a
          // not-useful-but-cited fact stays Cited.
          const expected = citation === undefined ? 'Unverified' : 'Cited';
          expect(fact.presentation).toBe(expected);

          // Never oracle-Verified: a citation is attribution, not a verdict (Req 13.10).
          expect(fact.presentation).not.toBe('Verified');
          expect(['Cited', 'Unverified']).toContain(fact.presentation);

          // A Cited fact carries exactly the citation it was given; an Unverified
          // fact carries none (13.5: surfaced knowledge always carries its citation).
          if (isCited(fact)) {
            expect(fact.citation).toStrictEqual(citation);
          } else {
            expect('citation' in fact).toBe(false);
          }
        },
      ),
      propertyParameters(),
    );
  });

  // Feature: hdl-creation-loop, Property 27: Facts are Cited iff they have a citation, independent of usefulness
  it('presents web facts Cited iff attributable and lines citations up with them, through retrieve()', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(webDocumentArbitrary(), { maxLength: 8 }),
        // Usefulness is not an input to retrieve() either; generated to show it
        // cannot influence which facts are Cited (Req 13.11).
        fc.boolean(),
        async (documents, useful) => {
          void useful;
          // Empty OKF bundle: every query is an uncovered gap, forcing the web
          // path so the generated documents drive the fact presentations.
          const retriever = new OkfFirstKnowledgeRetriever({
            okfReader: new InMemoryOkfBundleReader([]),
            webFetch: new FakeWebFetchAdapter(documents),
          });

          const result = await retriever.retrieve({ topic: 'uart framing gap xyz' });

          const expectedCited = documents.filter(hasUrl).length;
          const expectedUncited = documents.length - expectedCited;

          const citedFacts = result.facts.filter(isCited);
          const uncitedFacts = result.facts.filter((fact) => fact.presentation === 'Unverified');

          // Presentations line up with attributability (Req 13.7, 13.12).
          expect(citedFacts).toHaveLength(expectedCited);
          expect(uncitedFacts).toHaveLength(expectedUncited);
          expect(result.facts).toHaveLength(documents.length);

          // The citations list lines up one-to-one with the Cited facts (Req 13.5).
          expect(result.citations).toHaveLength(expectedCited);
          citedFacts.forEach((fact) => {
            expect(fact.citation.sourceUrl.trim().length).toBeGreaterThan(0);
          });

          // Every fact is Cited or Unverified, never oracle-Verified (Req 13.10);
          // the result carries no verdict or trust tier by construction.
          expect(
            result.facts.every(
              (fact) => fact.presentation === 'Cited' || fact.presentation === 'Unverified',
            ),
          ).toBe(true);
          expect(result.sanitized).toBe(true);
        },
      ),
      propertyParameters(),
    );
  });
});

// The labeling function takes only (claim, citation?): usefulness is structurally
// absent from its signature, so it can never be a labeling input (Req 13.11).
describe('Property 27 shape', () => {
  it('exposes no usefulness parameter on the labeling function', () => {
    expect(presentExternalFact.length).toBe(2);
  });

  it('uses the canonical feature tag', () => {
    expect(
      propertyTag(27, 'Facts are Cited iff they have a citation, independent of usefulness'),
    ).toBe(
      'Feature: hdl-creation-loop, Property 27: Facts are Cited iff they have a citation, independent of usefulness',
    );
  });
});
