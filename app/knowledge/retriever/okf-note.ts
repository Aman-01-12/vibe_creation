// The typed form of a curated OKF note after frontmatter parsing.
//
// Kept in its own module so the parser, the reader, and the retriever share one
// definition without a circular import.

import type { OkfStatus } from './contract.js';

/** A parsed OKF note: frontmatter fields the retriever uses, plus the body. */
export interface OkfNote {
  /** Bundle-relative path; also the note's citation source. */
  readonly path: string;
  readonly title: string;
  /** Frontmatter `type` (for example `pattern`, `verification-recipe`, `moc`). */
  readonly type: string;
  readonly status: OkfStatus;
  readonly tags: readonly string[];
  /** Markdown body after the frontmatter block. */
  readonly body: string;
}
