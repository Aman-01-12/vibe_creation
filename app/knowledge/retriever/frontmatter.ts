// Minimal YAML-frontmatter parser for OKF notes.
//
// OKF notes open with a `---` delimited block of simple `key: value` lines plus a
// `tags: [a, b]` inline array (see okf-bundle/*.md). A full YAML dependency is
// unwarranted for that shape, so this parses exactly the subset the bundle uses
// and nothing more. Anything it does not understand is ignored rather than
// guessed at, and a note whose `status` is missing or unrecognized is treated as
// `candidate` (a hint), never as `trusted` authority, so malformed or partial
// frontmatter can never be promoted to authority by accident.

import type { OkfNote } from './okf-note.js';
import type { OkfStatus, RawOkfNote } from './contract.js';

/** The delimiter that opens and closes a frontmatter block. */
const FRONTMATTER_FENCE = '---';

/** Parsed frontmatter key/value pairs plus the note body after the block. */
interface SplitNote {
  readonly frontmatter: ReadonlyMap<string, string>;
  readonly body: string;
}

/**
 * Parse a raw OKF note into its typed form.
 *
 * Returns `null` when the file has no frontmatter block (for example the bundle
 * README), so the caller can skip non-note files rather than surface them.
 */
export function parseOkfNote(raw: RawOkfNote): OkfNote | null {
  const split = splitFrontmatter(raw.content);
  if (split === null) {
    return null;
  }
  const { frontmatter, body } = split;
  const title = frontmatter.get('title') ?? raw.path;
  const type = frontmatter.get('type') ?? 'unknown';
  const status = normalizeStatus(frontmatter.get('status'));
  const tags = parseInlineTags(frontmatter.get('tags'));
  return { path: raw.path, title, type, status, tags, body };
}

/**
 * Split raw markdown into its frontmatter map and body.
 *
 * Requires the very first non-empty content to be the opening fence; returns
 * `null` otherwise so files without frontmatter are not misread.
 */
function splitFrontmatter(content: string): SplitNote | null {
  const normalized = content.replace(/^\uFEFF/, '');
  if (!normalized.startsWith(FRONTMATTER_FENCE)) {
    return null;
  }
  const afterOpen = normalized.slice(FRONTMATTER_FENCE.length);
  const closeIndex = afterOpen.indexOf(`\n${FRONTMATTER_FENCE}`);
  if (closeIndex === -1) {
    return null;
  }
  const block = afterOpen.slice(0, closeIndex);
  const body = afterOpen.slice(closeIndex + `\n${FRONTMATTER_FENCE}`.length).replace(/^\r?\n/, '');
  return { frontmatter: parseBlock(block), body };
}

/** Parse simple `key: value` lines into a map, ignoring blank/nested lines. */
function parseBlock(block: string): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    // Only top-level `key: value` pairs; a leading space marks a nested/continuation
    // line, which this subset does not model.
    if (line.length === 0 || line.startsWith(' ') || line.startsWith('\t')) {
      continue;
    }
    const separator = line.indexOf(':');
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key.length > 0) {
      entries.set(key, value);
    }
  }
  return entries;
}

/** Coerce a frontmatter `status` to `OkfStatus`, defaulting unknown to `candidate`. */
function normalizeStatus(value: string | undefined): OkfStatus {
  return value === 'trusted' ? 'trusted' : 'candidate';
}

/** Parse a `[a, b, c]` inline array into trimmed, non-empty tags. */
function parseInlineTags(value: string | undefined): readonly string[] {
  if (value === undefined) {
    return [];
  }
  const inner = value.replace(/^\[/, '').replace(/\]$/, '');
  return inner
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}
