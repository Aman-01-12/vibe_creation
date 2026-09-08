// The runnable RTLLM corpus fetch entry.
//
// `node app/eval/dist/corpus/fetch-cli.js` (npm: `npm run corpus:fetch`) ensures the
// pinned RTLLM checkout exists at the gitignored working location and VERIFIES it
// landed on `RTLLM_PINNED_COMMIT`. It exits non-zero on any failure, including a
// commit mismatch, because importing a corpus of unknown provenance would silently
// invalidate every pass@k number measured against it.
//
// The decision logic lives in `fetch.ts` behind injected seams and is unit-tested
// with a fake git; this file only wires the real Node-backed ports and owns stdout
// and the process exit code.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchPinnedRtllmCheckout, isCorpusFetchError } from './fetch.js';
import { NodeCheckoutProbePort, NodeGitCommandPort, RTLLM_CHECKOUT_PATH } from './fetch-node.js';
import { RTLLM_LICENSE, RTLLM_PINNED_COMMIT, RTLLM_REPOSITORY_URL } from './pinned-source.js';

/** The result of a fetch run: what to print and what exit code to use. */
export interface FetchCliResult {
  readonly exitCode: number;
  readonly lines: readonly string[];
}

/** Run the fetch against the real ports and format its outcome (no process effects). */
export async function runCorpusFetch(
  targetPath: string = RTLLM_CHECKOUT_PATH,
): Promise<FetchCliResult> {
  const result = await fetchPinnedRtllmCheckout({
    targetPath,
    git: new NodeGitCommandPort(),
    probe: new NodeCheckoutProbePort(),
  });
  if (isCorpusFetchError(result)) {
    const observed =
      result.observedCommit === null ? [] : [`observed HEAD: ${result.observedCommit}`];
    return {
      exitCode: 1,
      lines: [`RTLLM corpus fetch failed (${result.code}).`, result.message, ...observed],
    };
  }
  return {
    exitCode: 0,
    lines: [
      `RTLLM corpus ready (${result.action}).`,
      `source:  ${RTLLM_REPOSITORY_URL} (${RTLLM_LICENSE})`,
      `commit:  ${RTLLM_PINNED_COMMIT} (verified)`,
      `path:    ${result.path}`,
    ],
  };
}

/** Print the fetch outcome and set the exit code. */
async function main(): Promise<void> {
  const result = await runCorpusFetch();
  for (const line of result.lines) {
    console.log(line);
  }
  process.exitCode = result.exitCode;
}

// Run only when executed directly, not when imported by a test.
const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error(`RTLLM corpus fetch failed: ${message}`);
    process.exitCode = 1;
  });
}
