// Task 18.2 PRE-FLIGHT: one real, paid Session over `counter_12`, driven through the full
// production Consensus_Gate wiring, reporting the Mutation_Strength_Gate's own outcome
// distribution and whether the Session granted (design-answers-round3.md DQ-10). Operator
// script, not a shipped component; PARKED and paid, same discipline as `pilot.ts`.
//
// `pilot.ts` (task 18.1) never calls `runSession`. `cli.ts` (task 16.5) spends no paid work by
// design. This script is the first real exercise of the live wiring `live-wiring.ts` builds,
// scoped to ONE Session before the full corpus sweep (`sweep.ts`, task 18.2) runs on top of it.
// It does NOT establish any pre-registered figure - one Session is one data point.

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  makeBudgetLedger,
  REFERENCE_MODEL_PROMPT_VERSION,
  runSession,
  type SessionOutcome,
} from '@app/agent';

import { FileSystemCorpusCheckout } from '../corpus/checkout-port.js';
import { RTLLM_CHECKOUT_PATH } from '../corpus/fetch-node.js';
import { importRtllmCorpus } from '../corpus/import.js';
import { localTimingDerivation } from '../corpus/timing-derivation-node.js';
import { liveConsensusSessionDeps, REPOSITORY_ROOT } from './live-wiring.js';

/** The one Pilot_Design_Set problem this smoke run drives, per DQ-10's "one cheap Session". */
const SMOKE_PROBLEM_ID = 'rtllm/control/counter_12';

/** The report this script writes: the mutation-outcome distribution and the grant outcome. */
interface SmokeReport {
  readonly problemId: string;
  readonly outcomeKind: SessionOutcome['kind'];
  /** The unmet Grant_Condition, or null when the Session granted. */
  readonly unmetCondition: string | null;
  readonly mutationOutcomeCounts: Readonly<Record<'not-run' | 'passed' | 'failed', number>>;
  readonly trustedTestbenchCount: number;
  /** The admitted Design_Pool size and family count, present only on an UnverifiedOutcome. */
  readonly admittedPoolSize: number | null;
  readonly distinctModelFamilyCount: number | null;
  /** Per-generated-design Structural_Gate admission, present only on an UnverifiedOutcome. */
  readonly structuralGateChecks: readonly {
    readonly designId: string;
    readonly admitted: boolean;
  }[];
  /** How many testbenches won the Trust_Vote (passed by a strict majority of the Design_Pool). */
  readonly votedTrustedCount: number;
  /** Highest passingDesignCount any one testbench reached, out of admittedPoolSize. */
  readonly maxPassingDesignCount: number;
}

async function runSmoke(): Promise<SmokeReport> {
  const corpus = await importRtllmCorpus(
    new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
    localTimingDerivation(),
  );
  const problem = corpus.problems.find((candidate) => candidate.id === SMOKE_PROBLEM_ID);
  if (problem === undefined) {
    throw new Error(`smoke-session: ${SMOKE_PROBLEM_ID} not found in the imported corpus`);
  }

  const { sessionDeps } = liveConsensusSessionDeps();
  const budget = makeBudgetLedger(500_000, 'session-token-budget');
  const outcome = await runSession(problem.spec, budget, sessionDeps);

  const mutationOutcomeCounts: Record<'not-run' | 'passed' | 'failed', number> = {
    'not-run': 0,
    passed: 0,
    failed: 0,
  };
  let trustedTestbenchCount = 0;
  let votedTrustedCount = 0;
  let maxPassingDesignCount = 0;
  if (outcome.kind === 'verified' || outcome.kind === 'unverified') {
    for (const testbench of outcome.record.testbenchTrust) {
      mutationOutcomeCounts[testbench.mutationOutcome.kind] += 1;
      if (testbench.trusted) {
        trustedTestbenchCount += 1;
      }
      if (testbench.votedTrusted) {
        votedTrustedCount += 1;
      }
      maxPassingDesignCount = Math.max(maxPassingDesignCount, testbench.passingDesignCount);
    }
  }

  return {
    problemId: SMOKE_PROBLEM_ID,
    outcomeKind: outcome.kind,
    unmetCondition: outcome.kind === 'unverified' ? outcome.unmetCondition : null,
    mutationOutcomeCounts,
    trustedTestbenchCount,
    admittedPoolSize: outcome.kind === 'unverified' ? outcome.checked.poolSize : null,
    distinctModelFamilyCount:
      outcome.kind === 'unverified' ? outcome.checked.distinctModelFamilyCount : null,
    structuralGateChecks: outcome.kind === 'unverified' ? outcome.checked.structuralGateChecks : [],
    votedTrustedCount,
    maxPassingDesignCount,
  };
}

async function main(): Promise<void> {
  const outDir = join(
    REPOSITORY_ROOT,
    '.eval-runs',
    `smoke-session-${new Date().toISOString().replace(/[:.]/gu, '-')}`,
  );
  await mkdir(outDir, { recursive: true });
  console.log(
    `consensus smoke session (prompt v${String(REFERENCE_MODEL_PROMPT_VERSION)}): ${outDir}`,
  );
  const report = await runSmoke();
  await writeFile(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(
      `consensus smoke session failed: ${error instanceof Error ? error.message : 'unknown'}`,
    );
    process.exitCode = 1;
  });
}
