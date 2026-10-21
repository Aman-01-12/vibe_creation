// Post-timing-fix attribution measurement: ONE real Session over a purely combinational design,
// reporting whether the Pool_Correctness gate of Requirement 10 has switched attribution on.
//
// WHY THIS SESSION, AND WHY adder_8bit
//   `attributionStatus` is `actionable` only at or above `ATTRIBUTION_POOL_CORRECTNESS_GATE`
//   (0.5), a threshold measured over `.eval-runs/wave-consensus-replay-v1`: a Fault_Verdict other
//   than ABSTAIN is available on 2.8% of failures at 10% Pool_Correctness, 6.7% at 30%, and 46.8%
//   at 50%. Before the timing fix, the 13 purely combinational corpus designs sat at 0% by
//   construction - the fabricated all-`registered` contract made every testbench wrong - so
//   attribution could only ever abstain on them. `adder_8bit` is the one with a recorded
//   pre-fix baseline (0 of 8 trusted) and a measured post-fix Reference_Model pass rate of 8 of 8.
//   This Session measures what that did to Pool_Correctness, which is what decides whether
//   attribution can steer anything.
//
// WHAT IT DELIBERATELY DOES NOT CLAIM
//   One Session is one data point and establishes no pre-registered figure, the same caveat
//   `smoke-session.ts` carries. It also cannot tell whether repair would fire: that is settled
//   by proof rather than measurement, since Req 11.1's `!hasTrustedTestbench` and Req 10's
//   `actionable` gate are satisfied by disjoint session states. The firing count is reported
//   anyway, computed from this Session's own real state, so the proof has a measured companion.
//
// Run with `node app/eval/dist/scripts/timing-attribution-session.js`, after `npm run build`.
// Paid: one Session's worth of model calls, under the Req 8.9 approval already on record.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import {
  ATTRIBUTION_POOL_CORRECTNESS_GATE,
  makeBudgetLedger,
  REFERENCE_MODEL_PROMPT_VERSION,
  runSession,
  shouldTriggerRepair,
  type FaultVerdict,
  type SessionOutcome,
} from '@app/agent';

import { FileSystemCorpusCheckout } from '../corpus/checkout-port.js';
import { RTLLM_CHECKOUT_PATH } from '../corpus/fetch-node.js';
import { importRtllmCorpus } from '../corpus/import.js';
import { localTimingDerivation } from '../corpus/timing-derivation-node.js';
import { liveConsensusSessionDeps, REPOSITORY_ROOT } from '../consensus-regression/live-wiring.js';
import { requirePaidReRunApproval } from './paired-contract-approval-gate.js';

/** A purely combinational design of Requirement 3.2, with a recorded pre-fix baseline. */
const PROBLEM_ID = 'rtllm/arithmetic/adder_8bit';

/** The Session ledger, matching `smoke-session.ts`'s own. */
const SESSION_TOKENS = 500_000;

interface AttributionReport {
  readonly problemId: string;
  readonly declaredContract: readonly { readonly portName: string; readonly timing: string }[];
  readonly outcomeKind: SessionOutcome['kind'];
  readonly unmetCondition: string | null;
  /** The figure the Requirement 10 gate reads, and the gate it is compared against. */
  readonly poolCorrectness: number;
  readonly attributionGate: number;
  readonly attributionStatus: string;
  readonly trustedTestbenchCount: number;
  readonly votedTrustedCount: number;
  readonly testbenchPoolSize: number;
  readonly admittedPoolSize: number | null;
  readonly distinctModelFamilyCount: number | null;
  readonly maxPassingDesignCount: number;
  readonly mutationOutcomeCounts: Readonly<Record<string, number>>;
  /** The Fault_Verdict distribution over every failing pair of the Run_Matrix. */
  readonly faultVerdictCounts: Readonly<Record<FaultVerdict, number>>;
  readonly failingPairCount: number;
  /** How many failing pairs would start a Repair_Attempt, from this Session's own real state. */
  readonly repairWouldFireCount: number;
  readonly tokensSpent: number;
  readonly baselineTrustedTestbenchCount: number;
  /**
   * The Mutation_Strength_Gate is a ZERO-COVERAGE-GAP PEER-RELATIVE gate: testbench T must kill
   * every compiled mutant that any OTHER pool testbench killed. So a pool whose members have
   * DIFFERENT blind spots can fail every member at once, with no member being individually weak -
   * each one simply misses something some peer caught. These figures separate that structural
   * pattern from genuine uniform weakness.
   */
  readonly mutantCensus: {
    /** Distinct mutants seen across the whole pool. */
    readonly distinctMutants: number;
    /** Mutants at least one testbench killed: the peer-killable universe. */
    readonly killedByAtLeastOne: number;
    /** Mutants EVERY testbench killed. */
    readonly killedByAll: number;
    /** Mutants NO testbench killed - excluded from every requirement set by design. */
    readonly killedByNone: number;
    /** Per testbench: what it killed, and how many peer-killed mutants it missed. */
    readonly perTestbench: readonly {
      readonly killed: number;
      readonly survived: number;
      /** Peer-killed mutants this testbench missed. Non-zero is exactly why the gate failed it. */
      readonly missedPeerKilled: number;
    }[];
  };
}

async function run(): Promise<AttributionReport> {
  const corpus = await importRtllmCorpus(
    new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
    localTimingDerivation(),
  );
  const problem = corpus.problems.find((candidate) => candidate.id === PROBLEM_ID);
  if (problem === undefined) {
    throw new Error(`${PROBLEM_ID} not found in the imported corpus`);
  }

  const { sessionDeps } = liveConsensusSessionDeps();
  const budget = makeBudgetLedger(SESSION_TOKENS, 'session-token-budget');
  const outcome = await runSession(problem.spec, budget, sessionDeps);

  const mutationOutcomeCounts: Record<string, number> = { 'not-run': 0, passed: 0, failed: 0 };
  const faultVerdictCounts: Record<FaultVerdict, number> = { RTL: 0, TESTBENCH: 0, ABSTAIN: 0 };
  let trustedTestbenchCount = 0;
  let votedTrustedCount = 0;
  let maxPassingDesignCount = 0;
  let testbenchPoolSize = 0;
  let correctness = 0;
  let status = 'advisory';
  let failingPairCount = 0;
  let repairWouldFireCount = 0;

  if (outcome.kind === 'verified' || outcome.kind === 'unverified') {
    const record = outcome.record;
    testbenchPoolSize = record.testbenchTrust.length;
    for (const testbench of record.testbenchTrust) {
      mutationOutcomeCounts[testbench.mutationOutcome.kind] =
        (mutationOutcomeCounts[testbench.mutationOutcome.kind] ?? 0) + 1;
      if (testbench.trusted) trustedTestbenchCount += 1;
      if (testbench.votedTrusted) votedTrustedCount += 1;
      maxPassingDesignCount = Math.max(maxPassingDesignCount, testbench.passingDesignCount);
    }
    correctness = record.poolCorrectness.poolCorrectness;
    status = record.poolCorrectness.attributionStatus;
    for (const entry of record.poolCorrectness.faultVerdicts) {
      faultVerdictCounts[entry.verdict] += 1;
      failingPairCount += 1;
      // The real trigger, over this Session's own state rather than a constructed one.
      const fires = shouldTriggerRepair({
        hasTrustedTestbench: trustedTestbenchCount > 0,
        majorityFamilyCount:
          outcome.kind === 'unverified' ? outcome.checked.distinctModelFamilyCount : 0,
        attributionStatus: record.poolCorrectness.attributionStatus,
        faultVerdict: entry.verdict,
      });
      if (fires) repairWouldFireCount += 1;
    }
  }

  // Peer-relative census: which mutants each testbench killed, and what it missed that a peer got.
  const census = { distinctMutants: 0, killedByAtLeastOne: 0, killedByAll: 0, killedByNone: 0 };
  const perTestbench: {
    readonly killed: number;
    readonly survived: number;
    readonly missedPeerKilled: number;
  }[] = [];
  if (outcome.kind === 'verified' || outcome.kind === 'unverified') {
    const records = outcome.record.mutantCensus;
    const killedSets = records.map((r) => new Set(r.killedMutantIds));
    const allMutants = new Set<string>();
    for (const r of records) {
      for (const id of r.killedMutantIds) allMutants.add(id);
      for (const id of r.survivingMutantIds) allMutants.add(id);
    }
    census.distinctMutants = allMutants.size;
    for (const id of allMutants) {
      const killers = killedSets.filter((s) => s.has(id)).length;
      if (killers > 0) census.killedByAtLeastOne += 1;
      if (killers === killedSets.length && killedSets.length > 0) census.killedByAll += 1;
      if (killers === 0) census.killedByNone += 1;
    }
    for (const [index, record] of records.entries()) {
      const mine = killedSets[index] ?? new Set<string>();
      const peerKilled = new Set<string>();
      for (const [peerIndex, peerSet] of killedSets.entries()) {
        if (peerIndex === index) continue;
        for (const id of peerSet) peerKilled.add(id);
      }
      let missed = 0;
      for (const id of peerKilled) {
        if (!mine.has(id)) missed += 1;
      }
      perTestbench.push({
        killed: record.killedMutantIds.length,
        survived: record.survivingMutantIds.length,
        missedPeerKilled: missed,
      });
    }
  }

  return {
    problemId: PROBLEM_ID,
    declaredContract: problem.spec.timingContract.entries,
    mutantCensus: { ...census, perTestbench },
    outcomeKind: outcome.kind,
    unmetCondition: outcome.kind === 'unverified' ? outcome.unmetCondition : null,
    poolCorrectness: correctness,
    attributionGate: ATTRIBUTION_POOL_CORRECTNESS_GATE,
    attributionStatus: status,
    trustedTestbenchCount,
    votedTrustedCount,
    testbenchPoolSize,
    admittedPoolSize: outcome.kind === 'unverified' ? outcome.checked.poolSize : null,
    distinctModelFamilyCount:
      outcome.kind === 'unverified' ? outcome.checked.distinctModelFamilyCount : null,
    maxPassingDesignCount,
    mutationOutcomeCounts,
    faultVerdictCounts,
    failingPairCount,
    repairWouldFireCount,
    tokensSpent:
      outcome.kind === 'verified' || outcome.kind === 'unverified' ? outcome.record.tokensSpent : 0,
    baselineTrustedTestbenchCount: 0,
  };
}

async function main(): Promise<void> {
  await requirePaidReRunApproval();
  const outDir = join(
    REPOSITORY_ROOT,
    '.eval-runs',
    `timing-attribution-session-${new Date().toISOString().replace(/[:.]/gu, '-')}`,
  );
  await mkdir(outDir, { recursive: true });
  console.log(`attribution session (prompt v${String(REFERENCE_MODEL_PROMPT_VERSION)}): ${outDir}`);
  const report = await run();
  await writeFile(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(
      `attribution session failed: ${error instanceof Error ? error.message : 'unknown'}`,
    );
    process.exitCode = 1;
  });
}
