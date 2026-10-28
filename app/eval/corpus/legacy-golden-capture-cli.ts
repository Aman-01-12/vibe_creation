// The runnable Legacy_Byte_Identity_Check capture entry (stimulus-transaction-structure,
// task 1.1).
//
// `node app/eval/dist/corpus/legacy-golden-capture-cli.js` (npm: `npm run
// corpus:capture-legacy-golden`) renders every scored RTLLM design's harness text through
// `renderLegacyGoldenDesign` and writes one golden file per design into
// `app/test/fixtures/legacy-byte-identity/`. MUST run and be committed before task 4.1 edits
// the Stimulus_Function renderer: `CONSENSUS_HARNESS_VERSION` 3's text cannot be re-rendered
// once that edit lands, so this is the one chance to capture what it rendered.
//
// The decision logic - which designs, which request, which file name - lives in
// `legacy-byte-identity.ts` behind no injected seam beyond the corpus checkout and timing
// derivation; this file only wires the real Node-backed corpus access and owns stdout, the
// filesystem write, and the process exit code.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FileSystemCorpusCheckout } from './checkout-port.js';
import { RTLLM_CHECKOUT_PATH } from './fetch-node.js';
import { importRtllmCorpus } from './import.js';
import { renderLegacyGoldenCorpus } from './legacy-byte-identity.js';
import { RTLLM_SCORED_DESIGN_COUNT, scoredRtllmCorpus } from './stage0-quarantine.js';
import { FixedTimingDerivation } from './timing-derivation-double.js';

/** This module's directory, for the both-layouts path rule (dist runs one level deeper). */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, HERE.includes(`${'dist'}/`) ? '../../../..' : '../../..');

/** Where the committed golden corpus lands, relative to the repository root. */
export const LEGACY_GOLDEN_FIXTURE_DIR = 'app/test/fixtures/legacy-byte-identity';

/**
 * Render and write one golden file per scored design into `outDir`, returning one summary
 * line per design written.
 *
 * `FixedTimingDerivation('registered')` stands in for the real per-design Timing_Derivation;
 * see `legacy-byte-identity.ts`'s header for why a fixed stand-in is correct for a TEXT
 * capture and needs no Yosys. Refuses to write anything if the import did not land exactly
 * the reviewed scored corpus size, so a quarantine-list drift is caught here rather than
 * silently captured as a smaller or larger golden corpus.
 */
export async function runLegacyGoldenCapture(outDir: string): Promise<readonly string[]> {
  const corpus = await importRtllmCorpus(
    new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
    new FixedTimingDerivation('registered'),
  );
  const scored = scoredRtllmCorpus(corpus).problems;
  if (scored.length !== RTLLM_SCORED_DESIGN_COUNT) {
    throw new Error(
      `expected ${String(RTLLM_SCORED_DESIGN_COUNT)} scored designs, imported ${String(scored.length)}`,
    );
  }
  await mkdir(outDir, { recursive: true });
  const designs = renderLegacyGoldenCorpus(scored);
  for (const design of designs) {
    await writeFile(join(outDir, design.fileName), design.contents);
  }
  return designs.map((design) => `${design.problemId} -> ${design.fileName}`);
}

/** Capture into the committed fixture directory and print a summary. */
async function main(): Promise<void> {
  const outDir = resolve(REPOSITORY_ROOT, LEGACY_GOLDEN_FIXTURE_DIR);
  const lines = await runLegacyGoldenCapture(outDir);
  console.log(`Captured ${String(lines.length)} legacy golden file(s) into ${outDir}:`);
  for (const line of lines) {
    console.log(`  ${line}`);
  }
}

// Run only when executed directly, not when imported by a test.
const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error(`legacy-golden-capture-cli: ${message}`);
    process.exitCode = 1;
  });
}
