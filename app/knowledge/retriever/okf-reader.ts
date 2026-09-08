// OKF bundle readers: an in-memory fake for tests and a filesystem-backed reader
// for production.
//
// The retriever is programmed against the `OkfBundleReader` port, so it neither
// knows nor cares which of these is injected. The in-memory reader keeps the
// retriever's unit tests hermetic; the filesystem reader lets the real bundle
// under `okf-bundle/` be read at composition time by pointing it at that root.

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import type { OkfBundleReader, RawOkfNote } from './contract.js';

/** File extension that marks an OKF note. */
const NOTE_EXTENSION = '.md';

/**
 * An in-memory `OkfBundleReader` for tests.
 *
 * Seeded with raw notes so a test can exercise the retriever's traversal,
 * selection, and authority logic without touching the filesystem.
 */
export class InMemoryOkfBundleReader implements OkfBundleReader {
  readonly #notes: readonly RawOkfNote[];

  constructor(notes: readonly RawOkfNote[]) {
    this.#notes = [...notes];
  }

  listNotes(): Promise<readonly RawOkfNote[]> {
    return Promise.resolve(this.#notes);
  }
}

/**
 * A filesystem-backed `OkfBundleReader` that reads every markdown file under a
 * root directory.
 *
 * Paths are reported bundle-relative with forward slashes so a note's citation
 * source is stable across platforms. Non-markdown files are ignored; frontmatter
 * validation happens later in the parser, so a stray markdown file without
 * frontmatter is simply skipped downstream rather than failing the read.
 */
export class FileSystemOkfBundleReader implements OkfBundleReader {
  readonly #rootDir: string;

  constructor(rootDir: string) {
    this.#rootDir = rootDir;
  }

  async listNotes(): Promise<readonly RawOkfNote[]> {
    const absolutePaths = await this.#collectMarkdownFiles(this.#rootDir);
    const notes = await Promise.all(
      absolutePaths.map(async (absolutePath) => {
        const content = await readFile(absolutePath, 'utf8');
        const bundleRelative = relative(this.#rootDir, absolutePath).split(sep).join('/');
        return { path: bundleRelative, content } satisfies RawOkfNote;
      }),
    );
    // Stable ordering so retrieval is deterministic regardless of directory-read order.
    return notes.sort((left, right) => left.path.localeCompare(right.path));
  }

  /** Recursively gather absolute paths of every markdown file under `dir`. */
  async #collectMarkdownFiles(dir: string): Promise<readonly string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map((entry) => {
        const entryPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          return this.#collectMarkdownFiles(entryPath);
        }
        if (entry.isFile() && entry.name.endsWith(NOTE_EXTENSION)) {
          return Promise.resolve([entryPath]);
        }
        return Promise.resolve([]);
      }),
    );
    return nested.flat();
  }
}
