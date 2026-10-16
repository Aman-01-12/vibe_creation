#!/usr/bin/env node
// Prints ONE section of a spec document so a task can be worked without reading the whole file.
// design.md for formal-gate-first-light is ~40k tokens; its median component section is ~2.7 KB.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const SPEC_ROOT = resolve('.kiro/specs');
const DOCS = new Set(['design.md', 'requirements.md', 'tasks.md']);
const SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/;

function usage(message) {
  console.error(`${message}\n`);
  console.error('usage: node scripts/spec-section.mjs <spec> <section> [--doc design.md] [--list]');
  console.error('  node scripts/spec-section.mjs formal-gate-first-light C18');
  console.error('  node scripts/spec-section.mjs formal-gate-first-light "Property 36"');
  console.error('  node scripts/spec-section.mjs formal-gate-first-light --list');
  process.exit(2);
}

const args = process.argv.slice(2);
const docIndex = args.indexOf('--doc');
const doc = docIndex === -1 ? 'design.md' : args[docIndex + 1];
const listOnly = args.includes('--list');
const docValueIndex = docIndex === -1 ? -1 : docIndex + 1;
const positional = args.filter((arg, i) => !arg.startsWith('--') && i !== docValueIndex);
const [spec, ...queryParts] = positional;
const query = queryParts.join(' ').trim();

// The spec name becomes a path segment, so it is validated rather than trusted.
if (!spec || !SAFE_NAME.test(spec)) usage('A spec name is required, lowercase and dashes only.');
if (!DOCS.has(doc)) usage(`--doc must be one of: ${[...DOCS].join(', ')}`);
if (!listOnly && !query) usage('A section query is required, or pass --list.');

const path = resolve(SPEC_ROOT, spec, doc);
if (!path.startsWith(`${SPEC_ROOT}/`)) usage('Resolved path escaped .kiro/specs.');

const lines = await readFile(path, 'utf8').then(
  (text) => text.split('\n'),
  (error) => usage(`Cannot read ${path}: ${error.code ?? error.message}`),
);

const headings = lines
  .map((text, i) => ({ text, line: i + 1 }))
  .filter(({ text }) => /^#{2,6} /.test(text))
  .map((h) => ({ ...h, depth: h.text.match(/^#+/)[0].length, title: h.text.replace(/^#+ /, '') }));

if (listOnly) {
  for (const { line, depth, title } of headings) {
    console.log(`${String(line).padStart(5)}  ${'  '.repeat(depth - 2)}${title}`);
  }
  process.exit(0);
}

const needle = query.toLowerCase();
const matches = headings.filter(({ title }) => title.toLowerCase().includes(needle));
if (matches.length === 0) {
  usage(`No heading in ${spec}/${doc} contains "${query}". Try --list.`);
}

for (const match of matches) {
  const next = headings.find((h) => h.line > match.line && h.depth <= match.depth);
  const end = next ? next.line - 1 : lines.length;
  const body = lines
    .slice(match.line - 1, end)
    .join('\n')
    .trimEnd();
  console.log(`\n--- ${spec}/${doc} lines ${match.line}-${end} (${body.length} chars) ---\n`);
  console.log(body);
}
