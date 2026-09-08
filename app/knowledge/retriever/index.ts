// Public surface of the Knowledge_Retriever (task 10.2).

// The `retrieve` contract, result shape, and injected ports.
export type {
  CitedFact,
  ExternalFact,
  KnowledgeGap,
  KnowledgePassage,
  KnowledgeQuery,
  KnowledgeRetriever,
  KnowledgeSanitizer,
  OkfBundleReader,
  OkfStatus,
  PassageAuthority,
  PassageOrigin,
  RawOkfNote,
  RetrievalResult,
  RetrievalSource,
  SanitizedContent,
  UnverifiedFact,
  WebDocument,
  WebFetchAdapter,
  WebFetchResult,
} from './contract.js';

// The parsed-note shape and its parser.
export type { OkfNote } from './okf-note.js';
export { parseOkfNote } from './frontmatter.js';

// Cited/Unverified presentation derivation.
export { presentExternalFact } from './presentation.js';

// The knowledge-layer sanitizer.
export {
  defaultKnowledgeSanitizer,
  NEUTRALIZED_PLACEHOLDER,
  sanitizeWebContent,
} from './sanitizer.js';

// OKF bundle readers: in-memory fake and filesystem-backed real.
export { FileSystemOkfBundleReader, InMemoryOkfBundleReader } from './okf-reader.js';

// Web-fetch adapter test doubles (the real network adapter is wired in an outer layer).
export { FakeWebFetchAdapter, UnavailableWebFetchAdapter } from './web-fetch.js';

// The OKF-first, gap-only retriever implementation.
export type { KnowledgeRetrieverDeps } from './retriever.js';
export { OkfFirstKnowledgeRetriever } from './retriever.js';
