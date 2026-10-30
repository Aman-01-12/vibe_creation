// stimulus-transaction-structure: a second, independent 3-Session draw over exactly the 5
// Always_Verified_Set designs that fell short of unanimous in the task 14.4 Acceptance_
// Measurement run (15 of 20, stop branch 2), to tell stochastic single-Session noise apart from
// a real ceiling before deciding whether that result stands.
//
// WHY THESE FIVE, AND WHY A FRESH DRAW RATHER THAN READING THE OLD ONE AGAIN
//   `adder_16bit` (2 crashed, 1 verified) and `adder_8bit` (1 crashed, 2 verified) lost Sessions
//   to real infrastructure failures (ALL_PROVIDERS_FAILED, BUDGET_EXHAUSTED), not disagreement -
//   every Session that actually completed for them was verified. `multi_8bit`, `counter_12`, and
//   `parallel2serial` each had exactly one of three Sessions miss (`strict-majority` x2,
//   `trusted-testbench-exists` x1), the other two verified. None of the five regressed to
//   "never verifies"; criterion 5.3's bar is unanimous-across-every-Session with zero tolerance,
//   against a fresh, independent population of 8 candidate and 8 testbench draws per Session,
//   not a replay - so a second independent draw, not a re-read of the first, is what actually
//   tests whether 15 of 20 was noise.
//
// Gated the same way task 14.4's own driver is: `requirePaidReRunApproval` before any router is
// constructed.
//
// Run: `node app/eval/dist/scripts/stimulus-transaction-shortfall-remeasure.js`. Paid: 5 designs
// x 3 Sessions = 15 Sessions, about a quarter of task 14.4's own Always_Verified_Set step.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  makeBudgetLedger,
  runSession,
  SESSION_TOKEN_BUDGET,
  type SessionOutcome,
} from '@app/agent';

import { FileSystemCorpusCheckout } from '../corpus/checkout-port.js';
import { RTLLM_CHECKOUT_PATH } from '../corpus/fetch-node.js';
import { importRtllmCorpus } from '../corpus/import.js';
import { localTimingDerivation } from '../corpus/timing-derivation-node.js';
import { liveConsensusSessionDeps, REPOSITORY_ROOT } from '../consensus-regression/live-wiring.js';
import { requirePaidReRunApproval } from './paired-contract-approval-gate.js';

const SHORTFALL_DESIGN_IDS = [
  'rtllm/arithmetic/adder_16bit',
  'rtllm/arithmetic/adder_8bit',
  'rtllm/arithmetic/multi_8bit',
  'rtllm/control/counter_12',
  'rtllm/miscellaneous/parallel2serial',
] as const;

const SESSIONS_PER_DESIGN = 3;

/** One Session's own outcome, or the reason it never returned one - the same crash tolerance
 * `stimulus-transaction-acceptance.ts` added after a real provider failure crashed that run with
 * no report persisted. A single bad Session here must not cost the other four designs' results. */
async function runOneSessionOrCrashReason(
  spec: Parameters<typeof runSession>[0],
): Promise<
  | { readonly crashed: false; readonly outcome: SessionOutcome }
  | { readonly crashed: true; readonly reason: string }
> {
  try {
    const { sessionDeps } = liveConsensusSessionDeps();
    const budget = makeBudgetLedger(SESSION_TOKEN_BUDGET, 'session-token-budget');
    const outcome = await runSession(spec, budget, sessionDeps);
    return { crashed: false, outcome };
  } catch (error) {
    return {
      crashed: true,
      reason: `session crashed before returning an outcome: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

interface DesignResult {
  readonly problemId: string;
  readonly verifiedEverySession: boolean;
  readonly unmetConditionsBySession: readonly (string | null)[];
}

async function main(): Promise<void> {
  await requirePaidReRunApproval();

  const corpus = await importRtllmCorpus(
    new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
    localTimingDerivation(),
  );
  const problemById = new Map(corpus.problems.map((problem) => [problem.id, problem]));

  const results: DesignResult[] = [];
  for (const problemId of SHORTFALL_DESIGN_IDS) {
    const problem = problemById.get(problemId);
    if (problem === undefined) {
      throw new Error(`stimulus-transaction-shortfall-remeasure: ${problemId} not in corpus`);
    }
    const unmetConditionsBySession: (string | null)[] = [];
    for (let index = 0; index < SESSIONS_PER_DESIGN; index += 1) {
      const attempt = await runOneSessionOrCrashReason(problem.spec);
      unmetConditionsBySession.push(
        attempt.crashed
          ? attempt.reason
          : attempt.outcome.kind === 'verified'
            ? null
            : attempt.outcome.unmetCondition,
      );
      console.log(
        `${problemId} session ${String(index)}: ` +
          `${unmetConditionsBySession[index] ?? 'verified'}`,
      );
    }
    const result: DesignResult = {
      problemId,
      verifiedEverySession: unmetConditionsBySession.every((condition) => condition === null),
      unmetConditionsBySession,
    };
    results.push(result);
    // Checkpoint after every design (Req 10.10's own "not measured" tolerance, extended to
    // persistence): this run is cheap, but losing it to a late crash would not be.
    await writeFile(
      join(REPOSITORY_ROOT, '.eval-runs', 'stimulus-transaction-shortfall-remeasure-progress.json'),
      `${JSON.stringify({ designsCompleted: results.length, results }, null, 2)}\n`,
      'utf8',
    );
  }

  const verifiedCount = results.filter((result) => result.verifiedEverySession).length;
  console.log(
    `\nSecond independent draw: ${String(verifiedCount)} of ${String(results.length)} ` +
      'shortfall designs reached a Verified_Outcome in every Session',
  );
  for (const result of results) {
    console.log(
      `  ${result.problemId}: verifiedEverySession=${String(result.verifiedEverySession)} [` +
        `${result.unmetConditionsBySession.map((c) => c ?? 'verified').join(', ')}]`,
    );
  }

  const outDir = join(
    REPOSITORY_ROOT,
    '.eval-runs',
    `stimulus-transaction-shortfall-remeasure-${new Date().toISOString().replace(/[:.]/gu, '-')}`,
  );
  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, 'report.json'),
    `${JSON.stringify({ verifiedCount, results }, null, 2)}\n`,
    'utf8',
  );
  console.log(`\nreport under ${outDir}`);
}

void main().catch((error: unknown) => {
  console.error(
    `stimulus-transaction-shortfall-remeasure: ${error instanceof Error ? error.message : 'unknown'}`,
  );
  process.exitCode = 1;
});
