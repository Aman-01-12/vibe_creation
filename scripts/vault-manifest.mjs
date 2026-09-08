#!/usr/bin/env node
/**
 * Generates `chipAgent/MANIFEST.md`: a flat, greppable catalog of every note in the
 * build-time knowledge vault.
 *
 * Why this exists: the vault is navigated by following MOC (`index.md`) links, but those
 * maps are hand-maintained and drifted out of date, so notes that existed were unreachable
 * by the documented navigation path. The manifest is the machine-facing index - one read,
 * always complete, regenerated from the notes themselves - while the `index.md` maps stay
 * the human-facing narrative.
 *
 * Usage:
 *   node scripts/vault-manifest.mjs           # write chipAgent/MANIFEST.md
 *   node scripts/vault-manifest.mjs --check   # exit 1 if the committed manifest is stale
 *   node scripts/vault-manifest.mjs --digest  # print a compact digest to stdout (SessionStart hook)
 *
 * Design constraints:
 * - Deterministic output, so `--check` is a stable CI gate.
 * - `_private/` is never read (it holds secrets/PII and is gitignored).
 * - Note content is treated as untrusted data: extracted values are escaped and length-capped
 *   so a note body can never break out of the manifest's markdown structure.
 * - Symlinks are skipped, so the walk cannot escape the vault root.
 */

import { readFile, writeFile, readdir, realpath } from 'node:fs/promises';
import { resolve, relative, join, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VAULT_DIR_NAME = 'chipAgent';
const MANIFEST_FILE_NAME = 'MANIFEST.md';
const SECTION_MAP_FILE_NAME = 'index.md';
const MARKDOWN_EXTENSION = '.md';

/** Directories inside the vault that are never catalogued, and why. */
const EXCLUDED_DIRECTORIES = new Map([
  ['_private', 'gitignored; holds secrets/PII'],
  ['templates', 'blank scaffolds, not knowledge'],
  ['.obsidian', 'editor state'],
]);

/** Files at the vault root that are not notes. */
const EXCLUDED_FILE_NAMES = new Set([MANIFEST_FILE_NAME]);

/** Emission order for note types. Types outside this list are appended alphabetically. */
const TYPE_ORDER = [
  'gotcha',
  'decision',
  'pattern',
  'verification-recipe',
  'domain-note',
  'glossary',
  'reference',
];

const TYPE_HEADINGS = {
  gotcha: 'Gotchas and dead-ends - read these before debugging anything in their area',
  decision: 'Decisions - why the codebase is shaped this way',
  pattern: 'Patterns - reusable shapes already proven in this repo',
  'verification-recipe': 'Verification recipes - how to independently test a class of design',
  'domain-note': 'Domain knowledge - HDL / embedded / PCB source material',
  glossary: 'Glossary',
  reference: 'Reference',
};

/** Frontmatter keys the manifest surfaces. */
const CAPTURED_KEYS = ['type', 'title', 'status', 'tags', 'provenance', 'timestamp', 'validUntil'];

/** Upper bound on any single extracted value, to keep the manifest bounded. */
const MAX_VALUE_LENGTH = 220;

const FRONTMATTER_DELIMITER = '---';
const MAX_FRONTMATTER_LINES = 40;

/**
 * Renders a frontmatter value as safe single-line markdown table-cell text.
 * Note content is untrusted structurally: pipes, backticks and newlines are neutralised so a
 * note can never inject rows, columns, or code fences into the manifest.
 */
function toSafeCell(rawValue) {
  if (typeof rawValue !== 'string' || rawValue.length === 0) return '';
  const collapsed = rawValue.replace(/\s+/gu, ' ').trim();
  const escaped = collapsed.replace(/\|/gu, '\\|').replace(/`/gu, "'");
  return escaped.length > MAX_VALUE_LENGTH ? `${escaped.slice(0, MAX_VALUE_LENGTH - 1)}…` : escaped;
}

/** Strips one layer of matching surrounding quotes, if present. */
function unquote(value) {
  const isWrapped =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")));
  return isWrapped ? value.slice(1, -1) : value;
}

/**
 * Parses the leading YAML frontmatter block into a flat record of the keys we care about.
 *
 * Intentionally minimal rather than a full YAML parser: only `key: value` pairs on a single
 * line are recognised. A key with no inline value is reported as absent instead of guessed at,
 * so the manifest never invents metadata a note does not actually carry.
 *
 * @returns {Record<string, string>} present captured keys only; `{}` when there is no frontmatter
 */
function parseFrontmatter(fileContent) {
  const lines = fileContent.split(/\r?\n/u);
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) return {};

  const fields = {};
  const lastLineToScan = Math.min(lines.length, MAX_FRONTMATTER_LINES + 1);

  for (let lineIndex = 1; lineIndex < lastLineToScan; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line.trim() === FRONTMATTER_DELIMITER) return fields;
    // Indented lines belong to a block/nested value; the minimal parser does not claim them.
    if (/^\s/u.test(line)) continue;

    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) continue;

    const key = line.slice(0, separatorIndex).trim();
    if (!CAPTURED_KEYS.includes(key)) continue;

    const value = unquote(line.slice(separatorIndex + 1).trim());
    if (value.length > 0) fields[key] = value;
  }

  // No closing delimiter within the scan window: treat as malformed, not as a note.
  return {};
}

/** Normalises a `tags: [a, b]` inline array into `a, b`. */
function formatTags(rawTags) {
  if (typeof rawTags !== 'string') return '';
  const inner = rawTags.replace(/^\[/u, '').replace(/\]$/u, '');
  return inner
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
    .join(', ');
}

/**
 * Recursively collects markdown file paths under `directory`.
 *
 * Symlinks are skipped so the walk is guaranteed to stay inside the vault, and every resolved
 * path is re-checked against the vault root before being accepted.
 */
async function collectMarkdownFiles(directory, vaultRoot) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      files.push(...(await collectMarkdownFiles(entryPath, vaultRoot)));
      continue;
    }

    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(MARKDOWN_EXTENSION)) continue;
    if (EXCLUDED_FILE_NAMES.has(entry.name)) continue;

    const containment = relative(vaultRoot, resolve(entryPath));
    if (containment.startsWith('..') || containment.includes(`..${sep}`)) {
      throw new Error(`Refusing to index a path outside the vault: ${entryPath}`);
    }
    files.push(entryPath);
  }

  return files;
}

/**
 * Reads every vault note and splits it into catalogued notes, section maps, and malformed files.
 * @returns {Promise<{notes: object[], sectionMaps: string[], missingFrontmatter: string[]}>}
 */
async function loadVault(vaultRoot) {
  const filePaths = (await collectMarkdownFiles(vaultRoot, vaultRoot)).sort();
  const notes = [];
  const sectionMaps = [];
  const missingFrontmatter = [];

  for (const filePath of filePaths) {
    const vaultRelativePath = relative(REPO_ROOT, filePath);
    // A read failure means the manifest would be silently incomplete, so it must fail loudly.
    const content = await readFile(filePath, 'utf8');
    const fields = parseFrontmatter(content);

    if (typeof fields.type !== 'string') {
      if (basename(filePath) === SECTION_MAP_FILE_NAME) sectionMaps.push(vaultRelativePath);
      else missingFrontmatter.push(vaultRelativePath);
      continue;
    }

    notes.push({
      type: fields.type,
      title: fields.title ?? basename(filePath, MARKDOWN_EXTENSION),
      status: fields.status ?? 'unknown',
      tags: formatTags(fields.tags),
      timestamp: fields.timestamp ?? '',
      validUntil: fields.validUntil ?? '',
      // Repo-relative so an agent can pass the value straight to a file-read tool.
      path: vaultRelativePath,
    });
  }

  return { notes, sectionMaps, missingFrontmatter };
}

/** Orders note types by TYPE_ORDER, then alphabetically for anything unlisted. */
function compareTypes(leftType, rightType) {
  const leftRank = TYPE_ORDER.indexOf(leftType);
  const rightRank = TYPE_ORDER.indexOf(rightType);
  if (leftRank !== -1 && rightRank !== -1) return leftRank - rightRank;
  if (leftRank !== -1) return -1;
  if (rightRank !== -1) return 1;
  return leftType.localeCompare(rightType);
}

/** Groups notes by type in emission order, each group's notes sorted by path. */
function groupNotesByType(notes) {
  const types = [...new Set(notes.map((note) => note.type))].sort(compareTypes);
  return types.map((type) => ({
    type,
    heading: TYPE_HEADINGS[type] ?? type,
    notesOfType: notes
      .filter((note) => note.type === type)
      .sort((left, right) => left.path.localeCompare(right.path)),
  }));
}

/** One note as a compact single line: status, title, tags, and a directly readable path. */
function renderNoteLine(note) {
  const tagSuffix = note.tags.length > 0 ? ` [${toSafeCell(note.tags)}]` : '';
  const expirySuffix =
    note.validUntil.length > 0 ? ` (expires ${toSafeCell(note.validUntil)})` : '';
  return `- ${toSafeCell(note.status)}: ${toSafeCell(note.title)}${tagSuffix}${expirySuffix} -> \`${toSafeCell(note.path)}\``;
}

function renderManifestPreamble(noteCount) {
  return [
    '---',
    'type: reference',
    'title: Vault manifest (generated)',
    'status: trusted',
    'provenance: generated by scripts/vault-manifest.mjs',
    '---',
    '',
    '# Vault manifest - every note, one page',
    '',
    '<!-- GENERATED FILE. Do not edit by hand. Run `npm run vault:manifest`. -->',
    '',
    'The machine-facing index of the build-time knowledge vault, generated from the notes',
    'themselves so it is always complete. The hand-written `index.md` section maps are the',
    'human-facing narrative and may lag; this file does not.',
    '',
    'How to use it: scan titles and tags for your current area, then read only the few notes that',
    'match. Never read the whole vault.',
    '',
    'Reading `status`: `trusted` = eval-gated, may steer generation. `candidate` = not eval-gated;',
    'still authoritative as a record of what happened (what was tried, what the oracle said, what',
    'failed), but not as a correctness claim.',
    '',
    `Notes catalogued: ${noteCount}.`,
    '',
  ];
}

function renderManifest({ notes, sectionMaps, missingFrontmatter }) {
  const lines = renderManifestPreamble(notes.length);

  for (const { heading, notesOfType } of groupNotesByType(notes)) {
    lines.push(`## ${heading} (${notesOfType.length})`, '');
    for (const note of notesOfType) lines.push(renderNoteLine(note));
    lines.push('');
  }

  if (sectionMaps.length > 0) {
    lines.push('## Section maps (human-facing narrative)', '');
    for (const path of sectionMaps) lines.push(`- \`${toSafeCell(path)}\``);
    lines.push('');
  }

  if (missingFrontmatter.length > 0) {
    lines.push(
      '## Needs frontmatter (not catalogued above)',
      '',
      'These files carry no parseable `type:`, so they are invisible to lookup. Fix per `_SCHEMA.md`.',
      '',
    );
    for (const path of missingFrontmatter) lines.push(`- \`${toSafeCell(path)}\``);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * A compact digest for injection into context at session start: titles and paths only, no
 * preamble and no prose, so the agent knows what the vault holds without spending a tool call.
 */
function renderDigest(notes) {
  const lines = [
    `Knowledge vault (chipAgent/) holds ${notes.length} notes from past sessions.`,
    'Consult these before re-deriving anything from the codebase. Full index: chipAgent/MANIFEST.md',
    '',
  ];

  // Tags are omitted here (titles already carry the keywords); MANIFEST.md keeps them for lookup.
  for (const { heading, notesOfType } of groupNotesByType(notes)) {
    lines.push(`${heading} (${notesOfType.length}):`);
    for (const note of notesOfType) {
      lines.push(`  ${toSafeCell(note.title)} -> ${toSafeCell(note.path)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Compares the rendered manifest against the committed one; sets a failing exit code if stale. */
async function runCheck(manifestPath, rendered, noteCount) {
  const existing = await readFile(manifestPath, 'utf8').catch(() => null);
  if (existing === rendered) {
    process.stdout.write(`vault manifest is current (${noteCount} notes)\n`);
    return;
  }
  const reason = existing === null ? 'is missing' : 'is stale';
  process.stderr.write(`chipAgent/${MANIFEST_FILE_NAME} ${reason}. Run: npm run vault:manifest\n`);
  process.exitCode = 1;
}

async function main() {
  const vaultRoot = await realpath(resolve(REPO_ROOT, VAULT_DIR_NAME));
  const vault = await loadVault(vaultRoot);

  if (process.argv.includes('--digest')) {
    process.stdout.write(renderDigest(vault.notes));
    return;
  }

  const manifestPath = resolve(vaultRoot, MANIFEST_FILE_NAME);
  const rendered = renderManifest(vault);

  if (process.argv.includes('--check')) {
    await runCheck(manifestPath, rendered, vault.notes.length);
    return;
  }

  await writeFile(manifestPath, rendered, 'utf8');
  process.stdout.write(
    `wrote chipAgent/${MANIFEST_FILE_NAME}: ${vault.notes.length} notes, ` +
      `${vault.sectionMaps.length} section maps, ${vault.missingFrontmatter.length} need frontmatter\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `vault-manifest failed: ${error instanceof Error ? error.message : error}\n`,
  );
  process.exitCode = 1;
});
