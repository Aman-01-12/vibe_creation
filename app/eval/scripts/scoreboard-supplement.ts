// Prints the Campaign's Streaming_Supplement and Design_Group map (task 9.1), so the config's
// hand-written lists are copied from the rule rather than chosen by a person (Req 8.4, 8.8).
//
// The rule itself lives in `../sweep/runner.ts`; the runner re-checks it at start, so this
// script and the runner can never apply two different rules.

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { designGroupOf, type DesignGroup } from '@app/agent';

import { FileSystemCorpusCheckout, importRtllmCorpus, scoredRtllmCorpus } from '../corpus/index.js';
import { EVAL_CORPUS_ROOT, RTLLM_CHECKOUT_PATH } from '../corpus/fetch-node.js';
import type { EvalProblem } from '../problem.js';
import { streamingSupplementOf } from '../sweep/runner.js';

/** The baseline config whose problem ids the Campaign keeps, in their order. */
const BASELINE_CONFIG = 'app/eval/sweep/sweep.config.stage1-screen-dialect-v1.json';

/** What the script prints: the lists the Campaign config's block must hold. */
export interface ScoreboardCampaignLists {
  readonly problemIds: readonly string[];
  readonly streamingSupplement: readonly string[];
  readonly designGroups: Readonly<Record<string, DesignGroup>>;
}

/**
 * The Campaign's lists from the scored corpus and the baseline ids (pure). Baseline ids absent
 * from the scored corpus are refused, because a Campaign design must have an imported Spec.
 */
export function scoreboardCampaignLists(
  scored: readonly EvalProblem[],
  baselineIds: readonly string[],
): ScoreboardCampaignLists {
  const byId = new Map(scored.map((problem) => [problem.id, problem]));
  const missing = baselineIds.find((id) => !byId.has(id));
  if (missing !== undefined) {
    throw new Error(`baseline design ${missing} is not in the scored corpus`);
  }
  const streamingSupplement = streamingSupplementOf(scored, new Set(baselineIds));
  const problemIds = [...baselineIds, ...streamingSupplement];
  const designGroups: Record<string, DesignGroup> = {};
  for (const id of problemIds) {
    const problem = byId.get(id);
    if (problem !== undefined) {
      designGroups[id] = designGroupOf(problem.spec.moduleInterface);
    }
  }
  return { problemIds, streamingSupplement, designGroups };
}

/** Read the baseline config's explicit ids; anything else is a broken baseline. */
async function baselineIds(): Promise<readonly string[]> {
  // Resolved from the repository root, so the source and the compiled script read one file.
  const path = join(dirname(EVAL_CORPUS_ROOT), BASELINE_CONFIG);
  const raw = JSON.parse(await readFile(path, 'utf8')) as {
    readonly problems?: { readonly ids?: unknown };
  };
  const ids = raw.problems?.ids;
  if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === 'string')) {
    throw new Error('the baseline config does not declare explicit problem ids');
  }
  return ids;
}

async function main(): Promise<void> {
  const corpus = scoredRtllmCorpus(
    await importRtllmCorpus(new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH)),
  );
  const lists = scoreboardCampaignLists(corpus.problems, await baselineIds());
  console.log(JSON.stringify(lists, null, 2));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    // A local operator script: the message names what to fix, and no secret is ever read here.
    const reason = error instanceof Error ? error.message : 'unknown failure';
    console.error(`scoreboard-supplement: ${reason}`);
    process.exitCode = 1;
  });
}
