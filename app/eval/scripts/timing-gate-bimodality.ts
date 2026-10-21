// Why is the Session outcome BIMODAL on the Mutation_Strength_Gate? N Sessions, with the one
// measurement that discriminates the candidate mechanisms.
//
// THE HYPOTHESIS UNDER TEST: A BROKEN PEER POISONS `killedByPeer`
//   `requirementOf` admits a mutant into T's requirement when some OTHER pool testbench killed
//   it, and `judgeMutationStrength` then fails T unless T kills all of them. The gate's own
//   header justifies that with: "A true equivalent mutant can never enter the requirement,
//   because no peer killed it either."
//
//   That argument assumes a peer kills by being STRONG. A testbench that is BROKEN - one that
//   fails every design - kills every mutant too, indiscriminately, because `killed` is simply
//   `verdict !== 'pass'`. So one broken peer marks every mutant peer-killable, inflating every
//   good testbench's requirement set to include behaviourally-equivalent mutants that nothing
//   can legitimately kill, and every good testbench then fails at once.
//
//   Every Session measured so far had exactly ONE `not-run` testbench - the signature of a
//   testbench that passes no design, since an empty requirement is what `not-run` means. The
//   free replay (`timing-mutation-gate-replay.ts`) had NO broken member and passed all 8.
//
// THE DISCRIMINATING MEASUREMENT
//   Per testbench, per Session: how many designs it PASSES, and how many mutants it KILLS. The
//   hypothesis predicts an inverse pair - the testbench passing ~0 designs kills ~all mutants -
//   present in failing Sessions. It also predicts that `killedByPeer` for the good members is
//   driven by that one member.
//
// TOKEN ACCOUNTING
//   Every Session's own `tokensSpent` is recorded per run and accumulated, and the aggregate is
//   written beside the report so Cost per Verified Artifact can be computed later from measured
//   spend rather than estimated.
//
// Run: `node app/eval/dist/scripts/timing-gate-bimodality.js [--sessions N]`. Paid.

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  makeBudgetLedger,
  runSession,
  type ConsensusSessionDeps,
  type DesignGenerator,
  type GeneratedDesign,
  type GeneratedReferenceModel,
  type BudgetLedger,
  type ReferenceModelGenerator,
  type SessionOutcome,
} from '@app/agent';
import type { Spec, Ulid } from '@app/core';
import type { SourceFile } from '@app/tools';

import { FileSystemCorpusCheckout } from '../corpus/checkout-port.js';
import { RTLLM_CHECKOUT_PATH } from '../corpus/fetch-node.js';
import { importRtllmCorpus } from '../corpus/import.js';
import { localTimingDerivation } from '../corpus/timing-derivation-node.js';
import { liveConsensusSessionDeps, REPOSITORY_ROOT } from '../consensus-regression/live-wiring.js';
import { requirePaidReRunApproval } from './paired-contract-approval-gate.js';

const PROBLEM_ID = 'rtllm/arithmetic/adder_8bit';
const SESSION_TOKENS = 500_000;

/** Records each generated design's RTL, mirroring `harness.ts`'s own recording wrapper. */
class RecordingDesigns implements DesignGenerator {
  readonly #inner: DesignGenerator;
  readonly #rtl = new Map<Ulid, readonly SourceFile[]>();
  constructor(inner: DesignGenerator) {
    this.#inner = inner;
  }
  async generate(spec: Spec, ledger: BudgetLedger): Promise<GeneratedDesign> {
    const design = await this.#inner.generate(spec, ledger);
    this.#rtl.set(design.designId, design.rtl);
    return design;
  }
  rtl(): ReadonlyMap<Ulid, readonly SourceFile[]> {
    return this.#rtl;
  }
}

/** Records each generated testbench, mirroring `harness.ts`'s own. */
class RecordingTestbenches implements ReferenceModelGenerator {
  readonly #inner: ReferenceModelGenerator;
  readonly #byId = new Map<Ulid, GeneratedReferenceModel>();
  constructor(inner: ReferenceModelGenerator) {
    this.#inner = inner;
  }
  async generate(spec: Spec, ledger: BudgetLedger): Promise<GeneratedReferenceModel> {
    const testbench = await this.#inner.generate(spec, ledger);
    this.#byId.set(testbench.testbenchId, testbench);
    return testbench;
  }
  byId(): ReadonlyMap<Ulid, GeneratedReferenceModel> {
    return this.#byId;
  }
}

/** One testbench's discriminating pair, plus what the gate said about it. */
interface TestbenchRow {
  readonly passedDesigns: number;
  readonly totalDesigns: number;
  readonly killedMutants: number;
  readonly survivingMutants: number;
  readonly gate: string;
  readonly votedTrusted: boolean;
  readonly trusted: boolean;
}

interface SessionRow {
  readonly index: number;
  readonly outcomeKind: SessionOutcome['kind'];
  readonly unmetCondition: string | null;
  readonly poolCorrectness: number;
  readonly attributionStatus: string;
  readonly trustedCount: number;
  readonly votedTrustedCount: number;
  readonly mutationCounts: Readonly<Record<string, number>>;
  readonly faultVerdictCounts: Readonly<Record<string, number>>;
  readonly tokensSpent: number;
  readonly testbenches: readonly TestbenchRow[];
  /** The hypothesis test: a member passing no design while killing the most mutants. */
  readonly brokenPeerPresent: boolean;
  readonly brokenPeerKillShare: number | null;
  /** Distinct surviving mutant ids across every failing member, and whether they coincide. */
  readonly distinctSurvivors: number;
  readonly survivorsIdenticalAcrossFailures: boolean;
}

async function runOne(index: number, spec: Spec): Promise<SessionRow> {
  const { sessionDeps } = liveConsensusSessionDeps();
  const designs = new RecordingDesigns(sessionDeps.generateDesign);
  const testbenches = new RecordingTestbenches(sessionDeps.generateReferenceModel);
  const deps: ConsensusSessionDeps = {
    ...sessionDeps,
    generateDesign: designs,
    generateReferenceModel: testbenches,
  };
  const budget = makeBudgetLedger(SESSION_TOKENS, 'session-token-budget');
  const outcome = await runSession(spec, budget, deps);

  const mutationCounts: Record<string, number> = { 'not-run': 0, passed: 0, failed: 0 };
  const faultVerdictCounts: Record<string, number> = { RTL: 0, TESTBENCH: 0, ABSTAIN: 0 };
  const rows: TestbenchRow[] = [];
  let trustedCount = 0;
  let votedTrustedCount = 0;
  let poolCorrectnessValue = 0;
  let status = 'advisory';
  let tokensSpent = 0;
  let brokenPeerPresent = false;
  let brokenPeerKillShare: number | null = null;
  let distinctSurvivors = 0;
  let survivorsIdentical = false;

  if (outcome.kind === 'verified' || outcome.kind === 'unverified') {
    const record = outcome.record;
    tokensSpent = record.tokensSpent;
    poolCorrectnessValue = record.poolCorrectness.poolCorrectness;
    status = record.poolCorrectness.attributionStatus;
    for (const entry of record.poolCorrectness.faultVerdicts) {
      faultVerdictCounts[entry.verdict] = (faultVerdictCounts[entry.verdict] ?? 0) + 1;
    }
    const censusById = new Map(record.mutantCensus.map((c) => [c.testbenchId, c]));
    const totalDesigns = record.runMatrix.designIds.length;
    for (const trust of record.testbenchTrust) {
      mutationCounts[trust.mutationOutcome.kind] =
        (mutationCounts[trust.mutationOutcome.kind] ?? 0) + 1;
      if (trust.trusted) trustedCount += 1;
      if (trust.votedTrusted) votedTrustedCount += 1;
      const census = censusById.get(trust.testbenchId);
      const passedDesigns = record.runMatrix.cells.filter(
        (cell) => cell.testbenchId === trust.testbenchId && cell.passed === true,
      ).length;
      rows.push({
        passedDesigns,
        totalDesigns,
        killedMutants: census?.killedMutantIds.length ?? 0,
        survivingMutants: census?.survivingMutantIds.length ?? 0,
        gate: trust.mutationOutcome.kind,
        votedTrusted: trust.votedTrusted,
        trusted: trust.trusted,
      });
    }
    // The hypothesis: a member that passes NO design yet kills the largest mutant share.
    const maxKills = Math.max(0, ...rows.map((r) => r.killedMutants));
    const broken = rows.filter((r) => r.passedDesigns === 0);
    brokenPeerPresent = broken.length > 0;
    if (broken.length > 0 && maxKills > 0) {
      brokenPeerKillShare = Math.max(...broken.map((r) => r.killedMutants)) / maxKills;
    }
    // Do the failing members share one survivor set, or differ?
    const failingCensus = record.testbenchTrust
      .filter((t) => t.mutationOutcome.kind === 'failed')
      .map((t) => censusById.get(t.testbenchId)?.survivingMutantIds ?? []);
    const union = new Set(failingCensus.flat());
    distinctSurvivors = union.size;
    survivorsIdentical =
      failingCensus.length > 1 &&
      failingCensus.every((s) => new Set(s).size === union.size && s.every((id) => union.has(id)));
  }

  return {
    index,
    outcomeKind: outcome.kind,
    unmetCondition: outcome.kind === 'unverified' ? outcome.unmetCondition : null,
    poolCorrectness: poolCorrectnessValue,
    attributionStatus: status,
    trustedCount,
    votedTrustedCount,
    mutationCounts,
    faultVerdictCounts,
    tokensSpent,
    testbenches: rows,
    brokenPeerPresent,
    brokenPeerKillShare,
    distinctSurvivors,
    survivorsIdenticalAcrossFailures: survivorsIdentical,
  };
}

async function main(): Promise<void> {
  await requirePaidReRunApproval();
  const at = process.argv.indexOf('--sessions');
  const sessionCount = at === -1 ? 5 : Number(process.argv[at + 1] ?? '5');

  const corpus = await importRtllmCorpus(
    new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
    localTimingDerivation(),
  );
  const problem = corpus.problems.find((candidate) => candidate.id === PROBLEM_ID);
  if (problem === undefined) throw new Error(`${PROBLEM_ID} not in the imported corpus`);

  const rows: SessionRow[] = [];
  for (let index = 0; index < sessionCount; index += 1) {
    const row = await runOne(index, problem.spec);
    rows.push(row);
    console.log(
      `session ${String(index)}: ${row.outcomeKind} | trusted ${String(row.trustedCount)} | ` +
        `mutation ${JSON.stringify(row.mutationCounts)} | brokenPeer ${String(row.brokenPeerPresent)} ` +
        `killShare ${row.brokenPeerKillShare === null ? 'n/a' : row.brokenPeerKillShare.toFixed(2)} | ` +
        `survivors ${String(row.distinctSurvivors)} identical ${String(row.survivorsIdenticalAcrossFailures)} | ` +
        `${String(row.tokensSpent)} tok`,
    );
  }

  const verified = rows.filter((r) => r.outcomeKind === 'verified').length;
  const totalTokens = rows.reduce((sum, r) => sum + r.tokensSpent, 0);
  const report = {
    problemId: PROBLEM_ID,
    sessionCount: rows.length,
    verifiedCount: verified,
    verifiedRate: rows.length === 0 ? 0 : verified / rows.length,
    tokenLedger: {
      totalTokens,
      meanTokensPerSession: rows.length === 0 ? 0 : totalTokens / rows.length,
      tokensPerVerifiedArtifact: verified === 0 ? null : totalTokens / verified,
    },
    hypothesis: {
      statement: 'a broken peer (passes no design) kills ~all mutants and poisons killedByPeer',
      sessionsWithBrokenPeer: rows.filter((r) => r.brokenPeerPresent).length,
      failingSessionsWithBrokenPeer: rows.filter(
        (r) => r.brokenPeerPresent && (r.mutationCounts.failed ?? 0) > 0,
      ).length,
      passingSessionsWithBrokenPeer: rows.filter(
        (r) => r.brokenPeerPresent && (r.mutationCounts.failed ?? 0) === 0,
      ).length,
    },
    sessions: rows,
  };

  const outDir = join(
    REPOSITORY_ROOT,
    '.eval-runs',
    `timing-gate-bimodality-${new Date().toISOString().replace(/[:.]/gu, '-')}`,
  );
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\n${JSON.stringify({ ...report, sessions: undefined }, null, 2)}`);
  console.log(`\nreport under ${outDir}`);
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(`gate-bimodality: ${error instanceof Error ? error.message : 'unknown'}`);
    process.exitCode = 1;
  });
}
