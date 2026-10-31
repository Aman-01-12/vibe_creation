// The breadth sweep: is the single-module loop RELIABLE, or was adder_8bit flattering?
//
// WHAT THIS ANSWERS
//   Everything measured so far is one design. The `killedByPeer` fix took adder_8bit from 3 of 5
//   verified to 5 of 5, but a fix validated on one design is a hypothesis about the corpus. This
//   sweep runs N Sessions per design over the whole imported corpus and reports, per design and
//   in aggregate: the verified rate, the Mutation_Strength_Gate outcome distribution, the
//   Fault_Verdict distribution, Pool_Correctness, and measured token spend.
//
//   It also answers the question that decides whether the repair loop is worth wiring at all:
//   HOW OFTEN DOES A SESSION REACH ZERO TRUSTED TESTBENCHES. Requirement 11.1 scopes repair to
//   exactly that case, so if it is rare corpus-wide then repair stays parked and the decompose /
//   integrate stages (S2, S6) are the better next investment.
//
// WHY IT WRITES INCREMENTALLY
//   A full 46-design pass is hours of wall clock. Results are flushed after EVERY design, so an
//   interrupted sweep still yields every design it finished rather than nothing.
//
// ORDERING IS DELIBERATE
//   Combinational designs first: they are the class the timing fix unlocked and therefore the
//   class whose reliability is least established. The mixed design next, then the registered
//   ones, which include the three (multi_16bit, accu, RAM) that Requirement 8.8 parked as a
//   model-quality problem back when the oracle itself was broken - a parking worth re-testing.
//
// SURVIVING A CRASH
//   A multi-hour paid sweep must not lose finished designs to a network blip or a process death.
//   Each design's Sessions are individually guarded, so one failure is logged and skipped rather
//   than fatal, and results flush after every design. `--resume <dir>` then reads that directory's
//   own `report.json`, skips every design it already MEASURED, and continues appending - so a
//   relaunch costs only the designs that had not finished. A row recorded with `sessions: 0` is
//   not a measurement (every Session threw), so resume drops it and re-runs that design.
//
// Run: `node app/eval/dist/scripts/timing-corpus-sweep.js [--sessions N] [--limit M]
//      [--resume DIR] [--never-verified-from REPORT]`.
// Paid.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Spec } from '@app/core';

import { FileSystemCorpusCheckout } from '../corpus/checkout-port.js';
import { RTLLM_CHECKOUT_PATH } from '../corpus/fetch-node.js';
import { importRtllmCorpus } from '../corpus/import.js';
import { localTimingDerivation } from '../corpus/timing-derivation-node.js';
import { REPOSITORY_ROOT } from '../consensus-regression/live-wiring.js';
import { requirePaidReRunApproval } from './paired-contract-approval-gate.js';
import { runOne, type SessionRow } from './timing-gate-bimodality.js';

/** Which Port_Timing shape a design's derived contract has; the sweep orders by it. */
type TimingKind = 'combinational' | 'mixed' | 'registered';

function kindOf(spec: Spec): TimingKind {
  const entries = spec.timingContract.entries;
  if (entries.every((e) => e.timing === 'combinational')) return 'combinational';
  if (entries.every((e) => e.timing === 'registered')) return 'registered';
  return 'mixed';
}

const KIND_ORDER: readonly TimingKind[] = ['combinational', 'mixed', 'registered'];

interface DesignResult {
  readonly problemId: string;
  readonly kind: TimingKind;
  readonly sessions: number;
  readonly verified: number;
  readonly verifiedRate: number;
  /** Sessions reaching ZERO trusted testbenches: the only case Req 11.1 scopes repair to. */
  readonly zeroTrustedSessions: number;
  readonly meanTrusted: number;
  readonly mutationFailedSessions: number;
  readonly brokenPeerSessions: number;
  readonly actionableSessions: number;
  readonly faultVerdictCounts: Readonly<Record<string, number>>;
  readonly tokens: number;
  readonly rows: readonly SessionRow[];
}

function reduceDesign(
  problemId: string,
  kind: TimingKind,
  rows: readonly SessionRow[],
): DesignResult {
  const verified = rows.filter((r) => r.outcomeKind === 'verified').length;
  const faultVerdictCounts: Record<string, number> = { RTL: 0, TESTBENCH: 0, ABSTAIN: 0 };
  for (const row of rows) {
    for (const [verdict, count] of Object.entries(row.faultVerdictCounts)) {
      faultVerdictCounts[verdict] = (faultVerdictCounts[verdict] ?? 0) + count;
    }
  }
  return {
    problemId,
    kind,
    sessions: rows.length,
    verified,
    verifiedRate: rows.length === 0 ? 0 : verified / rows.length,
    zeroTrustedSessions: rows.filter((r) => r.trustedCount === 0).length,
    meanTrusted: rows.length === 0 ? 0 : rows.reduce((s, r) => s + r.trustedCount, 0) / rows.length,
    mutationFailedSessions: rows.filter((r) => (r.mutationCounts.failed ?? 0) > 0).length,
    brokenPeerSessions: rows.filter((r) => r.brokenPeerPresent).length,
    actionableSessions: rows.filter((r) => r.attributionStatus === 'actionable').length,
    faultVerdictCounts,
    tokens: rows.reduce((s, r) => s + r.tokensSpent, 0),
    rows,
  };
}

function aggregate(results: readonly DesignResult[]) {
  const sessions = results.reduce((s, d) => s + d.sessions, 0);
  const verified = results.reduce((s, d) => s + d.verified, 0);
  const tokens = results.reduce((s, d) => s + d.tokens, 0);
  const byKind = Object.fromEntries(
    KIND_ORDER.map((kind) => {
      const group = results.filter((d) => d.kind === kind);
      const groupSessions = group.reduce((s, d) => s + d.sessions, 0);
      const groupVerified = group.reduce((s, d) => s + d.verified, 0);
      return [
        kind,
        {
          designs: group.length,
          sessions: groupSessions,
          verified: groupVerified,
          verifiedRate: groupSessions === 0 ? null : groupVerified / groupSessions,
          designsAlwaysVerified: group.filter((d) => d.verified === d.sessions).length,
          designsNeverVerified: group.filter((d) => d.verified === 0 && d.sessions > 0).length,
        },
      ];
    }),
  );
  return {
    designs: results.length,
    sessions,
    verified,
    verifiedRate: sessions === 0 ? 0 : verified / sessions,
    byKind,
    repairRelevance: {
      note: 'Req 11.1 scopes repair to a Session with ZERO Trusted_Testbenches',
      zeroTrustedSessions: results.reduce((s, d) => s + d.zeroTrustedSessions, 0),
      zeroTrustedShare:
        sessions === 0 ? 0 : results.reduce((s, d) => s + d.zeroTrustedSessions, 0) / sessions,
      designsWithAnyZeroTrusted: results.filter((d) => d.zeroTrustedSessions > 0).length,
    },
    tokenLedger: {
      totalTokens: tokens,
      meanTokensPerSession: sessions === 0 ? 0 : tokens / sessions,
      tokensPerVerifiedArtifact: verified === 0 ? null : tokens / verified,
    },
  };
}

/** The value after a flag, or null when the flag is absent. */
function argAfter(flag: string): string | null {
  const at = process.argv.indexOf(flag);
  return at === -1 ? null : (process.argv[at + 1] ?? null);
}

/**
 * The problem ids a prior sweep report never verified, or null to sweep the whole corpus.
 *
 * `sessions > 0` excludes a design whose every Session THREW: it was never measured, so it is
 * not evidence of a verification failure and re-running it proves nothing about a fix.
 */
async function neverVerifiedCohort(reportPath: string | null): Promise<ReadonlySet<string> | null> {
  if (reportPath === null) return null;
  const parsed = JSON.parse(await readFile(resolve(reportPath), 'utf8')) as {
    readonly designs?: readonly DesignResult[];
  };
  const designs = parsed.designs ?? [];
  if (designs.length === 0) throw new Error(`${reportPath} lists no designs`);
  return new Set(designs.filter((d) => d.verified === 0 && d.sessions > 0).map((d) => d.problemId));
}

async function main(): Promise<void> {
  await requirePaidReRunApproval();
  const sessionsAt = process.argv.indexOf('--sessions');
  const perDesign = sessionsAt === -1 ? 3 : Number(process.argv[sessionsAt + 1] ?? '3');
  const limitAt = process.argv.indexOf('--limit');
  const limit =
    limitAt === -1 ? Number.POSITIVE_INFINITY : Number(process.argv[limitAt + 1] ?? '0');
  // `--never-verified-from REPORT` re-measures exactly the designs a prior sweep never verified,
  // read from that report rather than a hand-kept list, so the cohort cannot drift from the
  // measurement it is being compared against.
  const cohort = await neverVerifiedCohort(argAfter('--never-verified-from'));

  const corpus = await importRtllmCorpus(
    new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
    localTimingDerivation(),
  );
  const ordered = [...corpus.problems]
    .filter((problem) => cohort === null || cohort.has(problem.id))
    .map((problem) => ({ problem, kind: kindOf(problem.spec) }))
    .sort((a, b) => {
      const byKind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
      return byKind !== 0 ? byKind : a.problem.id.localeCompare(b.problem.id);
    })
    .slice(0, limit);

  // `--resume DIR` continues an interrupted sweep in place, keeping its finished designs.
  const resumeAt = process.argv.indexOf('--resume');
  const resumeDir = resumeAt === -1 ? null : resolve(process.argv[resumeAt + 1] ?? '');
  const outDir =
    resumeDir ??
    join(
      REPOSITORY_ROOT,
      '.eval-runs',
      `timing-corpus-sweep-${new Date().toISOString().replace(/[:.]/gu, '-')}`,
    );
  await mkdir(outDir, { recursive: true });

  const results: DesignResult[] = [];
  if (resumeDir !== null) {
    const existing = await readFile(join(resumeDir, 'report.json'), 'utf8').catch(() => null);
    if (existing !== null) {
      const parsed = JSON.parse(existing) as { readonly designs?: readonly DesignResult[] };
      results.push(...(parsed.designs ?? []));
    }
  }
  // A design whose every Session THREW was recorded with `sessions: 0`, which is not a
  // measurement - an outage mid-sweep would otherwise be frozen into the report as a result and
  // skipped by every later resume. Drop those and re-run them; the same rule the cohort filter
  // applies when reading a prior report.
  const unmeasured = results.filter((result) => result.sessions === 0).map((r) => r.problemId);
  if (unmeasured.length > 0) {
    console.log(
      `resume: re-running ${String(unmeasured.length)} design(s) recorded with no Session`,
    );
    results.splice(0, results.length, ...results.filter((result) => result.sessions > 0));
  }
  const done = new Set(results.map((result) => result.problemId));
  const remaining = ordered.filter(({ problem }) => !done.has(problem.id));
  console.log(
    `sweep: ${String(remaining.length)} designs x ${String(perDesign)} sessions -> ${outDir}` +
      (done.size === 0 ? '' : ` (resumed, ${String(done.size)} already done)`) +
      '\n',
  );

  for (const [index, { problem, kind }] of remaining.entries()) {
    const rows: SessionRow[] = [];
    for (let s = 0; s < perDesign; s += 1) {
      try {
        rows.push(await runOne(s, problem.spec));
      } catch (error: unknown) {
        // One design's failure must not abort the sweep; it is recorded by its absence from
        // `rows` and the design's own session count, never silently retried.
        console.log(
          `  ! ${problem.id} session ${String(s)} threw: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }
    }
    const result = reduceDesign(problem.id, kind, rows);
    results.push(result);
    console.log(
      `[${String(done.size + index + 1)}/${String(ordered.length)}] ${result.problemId} (${kind}): ` +
        `verified ${String(result.verified)}/${String(result.sessions)} | ` +
        `meanTrusted ${result.meanTrusted.toFixed(1)} | zeroTrusted ${String(result.zeroTrustedSessions)} | ` +
        `mutFail ${String(result.mutationFailedSessions)} | brokenPeer ${String(result.brokenPeerSessions)} | ` +
        `${String(result.tokens)} tok`,
    );
    // Flush after EVERY design, so an interrupted sweep keeps what it measured.
    await writeFile(
      join(outDir, 'report.json'),
      `${JSON.stringify({ aggregate: aggregate(results), designs: results }, null, 2)}\n`,
      'utf8',
    );
  }

  console.log(`\n${JSON.stringify(aggregate(results), null, 2)}`);
  console.log(`\nreport under ${outDir}`);
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(`corpus-sweep: ${error instanceof Error ? error.message : 'unknown'}`);
    process.exitCode = 1;
  });
}
