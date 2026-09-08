// Read-only access to a fetched corpus checkout, behind a narrow port.
//
// The importer must not know about `node:fs`, absolute paths, or path separators:
// injecting this port is what lets the whole conversion be unit-tested against
// in-memory fixtures with no network fetch and no disk, which is the only way the
// parsing tests can be fast and independent.
//
// Paths cross the seam as SEGMENT ARRAYS rather than joined strings. That is not
// cosmetic: a segment array cannot express `..` traversal or an absolute path
// without a segment that is literally `..` or starts with `/`, both of which the
// Node implementation rejects. The port therefore has one obvious validation point
// instead of a string-parsing one.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Read-only access to one fetched corpus checkout. */
export interface CorpusCheckoutPort {
  /** Names of the subdirectories directly under a checkout-relative path. */
  listDirectories(segments: readonly string[]): Promise<readonly string[]>;
  /** Names of the files directly under a checkout-relative path. */
  listFiles(segments: readonly string[]): Promise<readonly string[]>;
  /** UTF-8 contents of a checkout-relative file, or `null` when it cannot be read. */
  readTextFile(segments: readonly string[]): Promise<string | null>;
}

/** Largest single file this reader will return; bounds untrusted checkout contents. */
const MAX_FILE_BYTES = 1_048_576;

/** Reject a path segment that could escape the checkout or is not a plain name. */
function isSafeSegment(segment: string): boolean {
  if (segment.length === 0 || segment === '.' || segment === '..') {
    return false;
  }
  return !segment.includes('/') && !segment.includes('\\') && !segment.includes('\0');
}

/** Every segment must be a plain, non-traversing name. */
function segmentsAreSafe(segments: readonly string[]): boolean {
  return segments.every(isSafeSegment);
}

/**
 * A `CorpusCheckoutPort` over a real checkout directory.
 *
 * The root is supplied at construction, so this class never decides where the
 * corpus lives; `fetch-node.ts` owns that. Any unsafe segment yields an empty
 * listing or `null` rather than a filesystem call, and an unreadable path is
 * reported as absent rather than thrown - the importer turns absence into a
 * recorded quarantine, which is the behaviour we want for a malformed checkout.
 */
export class FileSystemCorpusCheckout implements CorpusCheckoutPort {
  readonly #rootPath: string;

  constructor(rootPath: string) {
    this.#rootPath = rootPath;
  }

  async listDirectories(segments: readonly string[]): Promise<readonly string[]> {
    return this.#list(segments, (entry) => entry.isDirectory());
  }

  async listFiles(segments: readonly string[]): Promise<readonly string[]> {
    return this.#list(segments, (entry) => entry.isFile());
  }

  async readTextFile(segments: readonly string[]): Promise<string | null> {
    if (!segmentsAreSafe(segments)) {
      return null;
    }
    try {
      const buffer = await readFile(this.#resolve(segments));
      // Truncate rather than reject: a data file longer than the cap is still
      // materialized, and the golden run's own verdict decides whether the
      // truncation mattered. Truncation can only make a run fail, never pass.
      return buffer.subarray(0, MAX_FILE_BYTES).toString('utf8');
    } catch {
      // A missing or unreadable file is indistinguishable to the importer, and the
      // underlying errno carries nothing it can act on differently, so it is
      // classified as absent rather than propagated.
      return null;
    }
  }

  /** List entries under a path, filtered by kind, sorted for a deterministic import. */
  async #list(
    segments: readonly string[],
    keep: (entry: { isDirectory(): boolean; isFile(): boolean }) => boolean,
  ): Promise<readonly string[]> {
    if (!segmentsAreSafe(segments)) {
      return [];
    }
    try {
      const entries = await readdir(this.#resolve(segments), { withFileTypes: true });
      return entries
        .filter(keep)
        .map((entry) => entry.name)
        .sort();
    } catch {
      // Same reasoning as `readTextFile`: an unreadable directory is treated as empty
      // so the importer records a quarantine instead of aborting the whole import.
      return [];
    }
  }

  /** Join validated segments onto the checkout root. */
  #resolve(segments: readonly string[]): string {
    return join(this.#rootPath, ...segments);
  }
}
