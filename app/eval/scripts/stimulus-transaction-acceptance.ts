// stimulus-transaction-structure, task 14.1: the Acceptance_Measurement driver (C15).
//
// A paid script, gated by `requirePaidReRunApproval` before any router is constructed, exactly
// as `never-verified-autopsy.ts` already does. Writing and type-checking this file is free;
// *running* it is task 14.4, the feature's only paid step - see that task before invoking `main`.
//
// FIXED ORDER, THREE STOP BRANCHES
//   1. The Legacy_Byte_Identity_Check (C7) over all 46 scored corpus designs.
//      STOP BRANCH 1, before any Session: a non-zero differing byte count for any design stops
//      the run, naming the design, the first differing offset, and the Input_Role resolved from
//      the `packedPortSlices` line that offset falls in (Req 5.7).
//   2. 3 Sessions over each Witness_Design (`square_wave`, `multi_16bit`), each drawing the
//      Session's own fixed `CONSENSUS_POOL_SIZE` (8) Candidate_Designs and 8 Reference_Model_
//      Testbenches, so each Session contributes 64 matrix cells (Req 10.9).
//      STOP BRANCH 3, before any Sweep over a design outside the Witness_Designs: fires when
//      `square_wave`'s passing-cell count is at or below the Witness_Baseline of 12 of 64 cells
//      in any one of its measured Sessions (the baseline's own denominator is one Session's
//      matrix, never scaled across Sessions - see this file's own note at
//      `councilEarlyWarningFired`).
//   3. The Always_Verified_Set reading (Req 5.3): a measurement over real Sessions, not a
//      citation of the historical "20 of 46" figure, per design.md's own "What is measured
//      rather than tested" section. STOP BRANCH 2, before any wider Sweep: a count below 20 of
//      20 stops the run, naming each design that failed and the Grant_Condition it left unmet in
//      each such Session.
//   4. The mutation probe comparison of task 12.5 (C16): `compareKillRates`/
//      `renderKillRateComparison`, already landed in `pilot.ts`.
//
// TWO CITATION SEAMS, DELIBERATELY NOT FABRICATED
//   Steps 3 and 4 both depend on data this driver does not itself produce: step 3 needs the
//   Always_Verified_Set's exact 20 design IDs (a named historical population, per the glossary -
//   not something re-derived from a fresh sweep, which would redefine the term and multiply the
//   draw cost far beyond task 14.4's own estimate), and step 4 needs task 12.5's own committed
//   mutation-probe reading. Neither artifact existed in the repository when this driver was
//   written (task 12.5 was still in progress), so both are read from a named, documented path
//   and reported as "not measured" with a clear cause when absent, rather than guessed or
//   hardcoded. See `.kiro/specs/stimulus-transaction-structure/design-questions.md` (Q1, Q2) for
//   the full reasoning and the options considered; an absent step-3 citation is treated the same
//   as a stop-branch-2 failure, because this driver cannot confirm 20 of 20 without it.
//
// Run: `node app/eval/dist/scripts/stimulus-transaction-acceptance.js`. Paid (task 14.4 only).

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONSENSUS_POOL_SIZE,
  makeBudgetLedger,
  REFERENCE_MODEL_PROMPT_VERSION,
  runSession,
  SESSION_TOKEN_BUDGET,
  type SessionOutcome,
} from '@app/agent';
import type { ModuleInterface, Spec } from '@app/core';
import {
  packedPortSlices,
  readNonVacuity,
  renderNonVacuityProbe,
  SAMPLE_BUDGET,
  type InputRole,
  type NonVacuityOutcome,
  type ResourceLimits,
  type RoleDeclaration,
  type SimulatorAdapter,
} from '@app/tools';

import type { EvalProblem } from '../problem.js';
import { FileSystemCorpusCheckout } from '../corpus/checkout-port.js';
import { RTLLM_CHECKOUT_PATH } from '../corpus/fetch-node.js';
import { importRtllmCorpus } from '../corpus/import.js';
import {
  legacyGoldenFileName,
  legacyRoleDeclarationFor,
  renderLegacyGoldenDesign,
} from '../corpus/legacy-byte-identity.js';
import { LEGACY_GOLDEN_FIXTURE_DIR } from '../corpus/legacy-golden-capture-cli.js';
import { RTLLM_SCORED_DESIGN_COUNT, scoredRtllmCorpus } from '../corpus/stage0-quarantine.js';
import { FixedTimingDerivation } from '../corpus/timing-derivation-double.js';
import { localTimingDerivation } from '../corpus/timing-derivation-node.js';
import {
  cliquePartitionOf,
  type CliquePartition,
} from '../consensus-regression/clique-partition.js';
import { roleAdoptionShareOf, type RoleAdoptionShare } from '../consensus-regression/figures.js';
import {
  liveConsensusSessionDeps,
  LiveReferenceModelGenerator,
  REPOSITORY_ROOT,
} from '../consensus-regression/live-wiring.js';
import {
  compareKillRates,
  renderKillRateComparison,
  type KillRateReading,
} from '../consensus-regression/pilot.js';
import type { ConsensusRegressionSample } from '../consensus-regression/harness.js';
import { requirePaidReRunApproval } from './paired-contract-approval-gate.js';

const WITNESS_SQUARE_WAVE_ID = 'rtllm/miscellaneous/square_wave';
const WITNESS_MULTI_16BIT_ID = 'rtllm/arithmetic/multi_16bit';
const WITNESS_SESSIONS_PER_DESIGN = 3;
/** Req 10.1, 10.5: one Session's own matrix size (`CONSENSUS_POOL_SIZE` squared), never scaled. */
const SQUARE_WAVE_WITNESS_BASELINE_CELLS = 12;
const ALWAYS_VERIFIED_SET_REQUIRED_COUNT = 20;

/** Q1 (design-questions.md): the Always_Verified_Set's citation, not yet committed. */
const ALWAYS_VERIFIED_SET_CITATION_PATH = 'app/eval/consensus-regression/always-verified-set.json';
/** Q2 (design-questions.md): task 12.5's own committed reading, not yet committed. */
const PROBED_KILL_RATE_CITATION_PATH = 'app/eval/consensus-regression/mutation-probe-reading.json';

// -- Step 1: the Legacy_Byte_Identity_Check over all 46 scored designs (C7, Req 5.6, 5.7) -------

interface ByteDiff {
  readonly differingByteCount: number;
  readonly firstDifferingOffset: number | null;
}

/** Byte-for-byte diff, mirroring `legacy-byte-identity-comparison.integration.test.ts`'s own
 * `diffBytes`: that logic is test-file-local (task 5.1's gate), so this driver re-states the
 * same small algorithm rather than importing from a `.test.ts` file. */
function diffBytes(golden: Buffer, actual: Buffer): ByteDiff {
  const sharedLength = Math.min(golden.length, actual.length);
  let differingByteCount = Math.abs(golden.length - actual.length);
  let firstDifferingOffset: number | null = null;
  for (let offset = 0; offset < sharedLength; offset += 1) {
    if (golden[offset] !== actual[offset]) {
      differingByteCount += 1;
      firstDifferingOffset ??= offset;
    }
  }
  if (firstDifferingOffset === null && differingByteCount > 0) {
    firstDifferingOffset = sharedLength;
  }
  return { differingByteCount, firstDifferingOffset };
}

function inputUnpackLine(portName: string, high: number, low: number): string {
  return `  assign ${portName} = ece_in_bits[${String(high)}:${String(low)}];`;
}

function lineSpanning(text: string, offset: number): string | null {
  if (offset < 0 || offset >= text.length) {
    return null;
  }
  let cursor = 0;
  for (const line of text.split('\n')) {
    const end = cursor + line.length;
    if (offset <= end) {
      return line;
    }
    cursor = end + 1;
  }
  return null;
}

/** The Input_Role of the port whose `packedPortSlices` line spans byte `offset` (Req 5.7). */
function resolveInputRole(
  problem: EvalProblem,
  actualText: string,
  goldenText: string,
  offset: number,
): string {
  const text = offset < actualText.length ? actualText : goldenText;
  const line = lineSpanning(text, offset);
  const inputPorts = problem.spec.moduleInterface.ports.filter(
    (port) => port.direction === 'input',
  );
  const roles = legacyRoleDeclarationFor(problem.spec.moduleInterface);
  const slice =
    line === null
      ? undefined
      : packedPortSlices(inputPorts).find(
          (candidate) => line === inputUnpackLine(candidate.name, candidate.high, candidate.low),
        );
  if (slice === undefined) {
    return 'unresolved (no packedPortSlices input-unpack line spans this offset)';
  }
  const role = roles.find((entry) => entry.portName === slice.name)?.role ?? 'data';
  return `${role} (port "${slice.name}")`;
}

interface ByteIdentityFailure {
  readonly problemId: string;
  readonly differingByteCount: number;
  readonly firstDifferingOffset: number;
  readonly inputRole: string;
}

interface ByteIdentityCheckResult {
  readonly checkedCount: number;
  readonly failures: readonly ByteIdentityFailure[];
}

/** Step 1 (C7, Req 5.6, 5.7): exhausted over all 46 scored designs, never sampled. */
async function checkLegacyByteIdentity(): Promise<ByteIdentityCheckResult> {
  const corpus = await importRtllmCorpus(
    new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
    new FixedTimingDerivation('registered'),
  );
  const scored = scoredRtllmCorpus(corpus).problems;
  if (scored.length !== RTLLM_SCORED_DESIGN_COUNT) {
    throw new Error(
      `stimulus-transaction-acceptance: expected ${String(RTLLM_SCORED_DESIGN_COUNT)} scored ` +
        `designs, imported ${String(scored.length)}`,
    );
  }
  const fixtureDir = join(REPOSITORY_ROOT, LEGACY_GOLDEN_FIXTURE_DIR);
  const failures: ByteIdentityFailure[] = [];
  for (const problem of scored) {
    const golden = await readFile(join(fixtureDir, legacyGoldenFileName(problem.id)));
    const actualText = renderLegacyGoldenDesign(problem).contents;
    const diff = diffBytes(golden, Buffer.from(actualText, 'utf8'));
    if (diff.differingByteCount > 0) {
      failures.push({
        problemId: problem.id,
        differingByteCount: diff.differingByteCount,
        firstDifferingOffset: diff.firstDifferingOffset ?? -1,
        inputRole:
          diff.firstDifferingOffset === null
            ? 'unresolved (no differing offset)'
            : resolveInputRole(
                problem,
                actualText,
                golden.toString('utf8'),
                diff.firstDifferingOffset,
              ),
      });
    }
  }
  return { checkedCount: scored.length, failures };
}

// -- Session running: one real Session via the live wiring, mirroring `never-verified-autopsy.ts`
//    and `timing-gate-bimodality.ts`'s own `runOne` pattern -----------------------------------

/** Pulls out the concrete `LiveReferenceModelGenerator` so its refused-reply count (Req 8.6,
 * which `SessionRecord` does not track - see live-wiring.ts's own comment on the field) is
 * readable after the Session completes. */
function liveDepsWithRefusalTracking(): ReturnType<typeof liveConsensusSessionDeps> & {
  readonly referenceModelGenerator: LiveReferenceModelGenerator;
} {
  const wiring = liveConsensusSessionDeps();
  const { generateReferenceModel } = wiring.sessionDeps;
  if (!(generateReferenceModel instanceof LiveReferenceModelGenerator)) {
    throw new Error(
      'stimulus-transaction-acceptance defect: live wiring did not return a LiveReferenceModelGenerator',
    );
  }
  return { ...wiring, referenceModelGenerator: generateReferenceModel };
}

interface OneSessionResult {
  readonly outcome: SessionOutcome;
  readonly refusedReplyCount: number;
  readonly simulator: SimulatorAdapter;
  readonly limits: ResourceLimits;
}

/** One real, paid Session over `spec`, through the unchanged strict-majority rule and the
 * unchanged Grant_Conditions (Req 10.7, 10.8). */
async function runOneSession(spec: Spec): Promise<OneSessionResult> {
  const { sessionDeps, referenceModelGenerator } = liveDepsWithRefusalTracking();
  const budget = makeBudgetLedger(SESSION_TOKEN_BUDGET, 'session-token-budget');
  const outcome = await runSession(spec, budget, sessionDeps);
  return {
    outcome,
    refusedReplyCount: referenceModelGenerator.refusedReplyCount(),
    simulator: sessionDeps.simulator,
    limits: sessionDeps.limits,
  };
}

/**
 * A crash-tolerant `runOneSession`: `LiveReferenceModelGenerator`'s own retry loop throws when
 * every attempt fails (its own comment: "model noise, not a wiring fault, since
 * ReferenceModelGenerator has no failure variant to report it through"), and that exception
 * would otherwise propagate straight through this multi-hour, many-Session driver and crash it
 * with no report persisted - the catastrophic failure mode a real paid run hit (budget exhausted
 * on one Reference_Model draw, three attempts into a Session near the end of the 66-Session
 * Always_Verified_Set sweep). Req 10.10 already tolerates a Session that "does not complete" as
 * not measured with its reason; this extends that same tolerance to a Session that never
 * returns an outcome at all, rather than fixing the deeper gap in the shared `live-wiring.ts`
 * retry loop, which every other script built on it shares and which is out of this task's scope.
 */
async function runOneSessionOrCrashReason(
  spec: Spec,
): Promise<
  | { readonly crashed: false; readonly session: OneSessionResult }
  | { readonly crashed: true; readonly reason: string }
> {
  try {
    return { crashed: false, session: await runOneSession(spec) };
  } catch (error) {
    return {
      crashed: true,
      reason: `session crashed before returning an outcome: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/** `null` when `outcome`'s matrix completed every Consensus_Run; otherwise the reason it did
 * not, so a mean is never computed over a Session that was not actually measured (Req 10.10).
 *
 * Exported for task 14.2's Property 25 test; pure, and no part of the paid path. */
export function incompleteSessionReason(outcome: SessionOutcome): string | null {
  const expectedSize = CONSENSUS_POOL_SIZE * CONSENSUS_POOL_SIZE;
  const { runMatrix } = outcome.record;
  const complete =
    runMatrix.cells.length === expectedSize &&
    runMatrix.cells.every((cell) => cell.passed !== null);
  if (complete) {
    return null;
  }
  return outcome.kind === 'unverified'
    ? outcome.unmetCondition
    : 'incomplete-despite-verified-outcome';
}

function passingCells(outcome: SessionOutcome): {
  readonly passing: number;
  readonly total: number;
} {
  const { cells } = outcome.record.runMatrix;
  return { passing: cells.filter((cell) => cell.passed === true).length, total: cells.length };
}

function trustedTestbenchCount(outcome: SessionOutcome): number {
  return outcome.record.testbenchTrust.filter((entry) => entry.trusted).length;
}

/** Adapts a `SessionOutcome` to the three fields `roleAdoptionShareOf` reads; the remaining
 * `ConsensusRegressionSample` fields feed Attribution_Accuracy figures this driver does not
 * report, so they carry that type's own "nothing measured" defaults. */
function roleAdoptionShareFor(
  problemId: string,
  outcome: SessionOutcome,
  role: InputRole,
  refusedReplyCount: number,
): RoleAdoptionShare {
  const sample: ConsensusRegressionSample = {
    problemId,
    outcome,
    goldenVerdict: null,
    designGroundTruth: [],
    testbenchGroundTruth: [],
  };
  return roleAdoptionShareOf(sample, role, refusedReplyCount, REFERENCE_MODEL_PROMPT_VERSION);
}

// -- Non_Vacuity_Check, run for every distinct accepted declaration naming a Strobe or a
//    Held_Input (Req 7.10; C8, C9) --------------------------------------------------------------

function roleDeclarationKey(roles: RoleDeclaration): string {
  return [...roles]
    .map((entry) => `${entry.portName}=${entry.role}`)
    .sort()
    .join(',');
}

/** Distinct accepted Role_Declarations of `outcome`, in first-seen order, that name a Strobe
 * or a Held_Input - the only declarations criterion 7.10 asks a Non_Vacuity_Check for.
 *
 * Exported for task 14.3's unit test; pure, and no part of the paid path. */
export function nonVacuityCandidateDeclarations(
  outcome: SessionOutcome,
): readonly RoleDeclaration[] {
  const seen = new Set<string>();
  const distinct: RoleDeclaration[] = [];
  for (const { roles } of outcome.record.roleDeclarations) {
    const key = roleDeclarationKey(roles);
    if (!seen.has(key) && roles.some((entry) => entry.role === 'strobe' || entry.role === 'hold')) {
      seen.add(key);
      distinct.push(roles);
    }
  }
  return distinct;
}

/** One real Non_Vacuity_Probe render-and-run for `roles`, read by the pure C9 reader. */
async function readOneNonVacuity(
  moduleInterface: ModuleInterface,
  roles: RoleDeclaration,
  simulator: SimulatorAdapter,
  limits: ResourceLimits,
): Promise<NonVacuityOutcome> {
  const nonce = `nv${randomUUID().replace(/-/gu, '').slice(0, 10)}`;
  const probe = renderNonVacuityProbe({
    moduleInterface,
    nonce,
    roles,
    sampleBudget: SAMPLE_BUDGET,
  });
  if (!probe.ok) {
    return {
      kind: 'incomplete',
      reason: `probe render refused (${probe.error.code}): ${probe.error.message}`,
    };
  }
  const verdict = await simulator.simulate([], probe.value, limits);
  return readNonVacuity(verdict.stdout, nonce, moduleInterface, roles, SAMPLE_BUDGET);
}

interface NonVacuityForDeclaration {
  readonly roles: RoleDeclaration;
  readonly outcome: NonVacuityOutcome;
}

async function nonVacuityResultsFor(
  spec: Spec,
  session: OneSessionResult,
): Promise<readonly NonVacuityForDeclaration[]> {
  const declarations = nonVacuityCandidateDeclarations(session.outcome);
  const results: NonVacuityForDeclaration[] = [];
  for (const roles of declarations) {
    const outcome = await readOneNonVacuity(
      spec.moduleInterface,
      roles,
      session.simulator,
      session.limits,
    );
    results.push({ roles, outcome });
  }
  return results;
}

// -- Step 2: 3 Sessions over each Witness_Design (Req 10.1-10.4, 10.9) ---------------------------

interface WitnessSessionReport {
  readonly index: number;
  readonly outcomeKind: SessionOutcome['kind'];
  readonly unmetCondition: string | null;
  readonly incompleteReason: string | null;
  readonly passingCells: number;
  readonly totalCells: number;
  readonly trustedTestbenchCount: number;
  readonly roleAdoptionShare: RoleAdoptionShare;
  readonly nonVacuity: readonly NonVacuityForDeclaration[];
  /** Req 10.6, 10.11: only for an Unverified_Outcome, and carrying no trust label or verdict. */
  readonly cliquePartition: CliquePartition | null;
}

interface WitnessDesignReport {
  readonly problemId: string;
  readonly sessions: readonly WitnessSessionReport[];
}

/** One Witness_Design's `WITNESS_SESSIONS_PER_DESIGN` Sessions, each measuring `roleToReport`'s
 * Role_Adoption_Share (Req 8.9 for `multi_16bit`'s `enable`, retargeted from `strobe` by the
 * role-classification-decisions.md amendment; 8.10 for `square_wave`'s `hold`). */
/** A Session that never returned an outcome: zero cells, zero trust, and an empty
 * Role_Adoption_Share, since there were no accepted replies to measure a share over. Carries
 * `reason` as both `unmetCondition` and `incompleteReason`, matching how every other "not
 * measured" Session already reports why (Req 10.10). */
function crashedWitnessSessionReport(
  index: number,
  problemId: string,
  role: InputRole,
  reason: string,
): WitnessSessionReport {
  return {
    index,
    outcomeKind: 'unverified',
    unmetCondition: reason,
    incompleteReason: reason,
    passingCells: 0,
    totalCells: 0,
    trustedTestbenchCount: 0,
    roleAdoptionShare: {
      problemId,
      role,
      numerator: 0,
      denominator: 0,
      refusedReplyCount: 0,
      referenceModelPromptVersion: REFERENCE_MODEL_PROMPT_VERSION,
      floorMeasurable: false,
    },
    nonVacuity: [],
    cliquePartition: null,
  };
}

async function runWitnessDesignSessions(
  problemId: string,
  spec: Spec,
  roleToReport: InputRole,
): Promise<WitnessDesignReport> {
  const sessions: WitnessSessionReport[] = [];
  for (let index = 0; index < WITNESS_SESSIONS_PER_DESIGN; index += 1) {
    const attempt = await runOneSessionOrCrashReason(spec);
    if (attempt.crashed) {
      sessions.push(crashedWitnessSessionReport(index, problemId, roleToReport, attempt.reason));
      continue;
    }
    const session = attempt.session;
    const { passing, total } = passingCells(session.outcome);
    sessions.push({
      index,
      outcomeKind: session.outcome.kind,
      unmetCondition: session.outcome.kind === 'unverified' ? session.outcome.unmetCondition : null,
      incompleteReason: incompleteSessionReason(session.outcome),
      passingCells: passing,
      totalCells: total,
      trustedTestbenchCount: trustedTestbenchCount(session.outcome),
      roleAdoptionShare: roleAdoptionShareFor(
        problemId,
        session.outcome,
        roleToReport,
        session.refusedReplyCount,
      ),
      nonVacuity: await nonVacuityResultsFor(spec, session),
      cliquePartition:
        session.outcome.kind === 'unverified' ? cliquePartitionOf(session.outcome.record) : null,
    });
  }
  return { problemId, sessions };
}

/** Req 10.1, 10.5: the Witness_Baseline's 12-of-64 denominator is ONE Session's own matrix
 * (`CONSENSUS_POOL_SIZE` squared). This fires per measured Session against that same
 * denominator rather than inventing a scaled, combined threshold across the 3 Sessions. */
function councilEarlyWarningFired(report: WitnessDesignReport): boolean {
  const fullMatrixSize = CONSENSUS_POOL_SIZE * CONSENSUS_POOL_SIZE;
  return report.sessions.some(
    (session) =>
      session.incompleteReason === null &&
      session.totalCells === fullMatrixSize &&
      session.passingCells <= SQUARE_WAVE_WITNESS_BASELINE_CELLS,
  );
}

function renderWitnessSessionLine(session: WitnessSessionReport): string {
  const status =
    session.incompleteReason === null
      ? session.outcomeKind
      : `NOT MEASURED (${session.incompleteReason})`;
  const share = session.roleAdoptionShare;
  return (
    `  session ${String(session.index)}: ${status} | cells ${String(session.passingCells)}/` +
    `${String(session.totalCells)} | trusted ${String(session.trustedTestbenchCount)} | ` +
    `unmet ${session.unmetCondition ?? 'none'} | Role_Adoption_Share[${share.role}] ` +
    `${String(share.numerator)}/${String(share.denominator)} (floorMeasurable ${String(share.floorMeasurable)})`
  );
}

function renderNonVacuityLines(sessions: readonly WitnessSessionReport[]): readonly string[] {
  return sessions.flatMap((session) =>
    session.nonVacuity.map((entry) => {
      const label =
        entry.outcome.kind === 'incomplete'
          ? `incomplete (${entry.outcome.reason})`
          : `demonstratesTransactionStructure=${String(entry.outcome.demonstratesTransactionStructure)}`;
      return `    session ${String(session.index)} Non_Vacuity_Check: ${label}`;
    }),
  );
}

function renderCliquePartitionLines(sessions: readonly WitnessSessionReport[]): readonly string[] {
  return sessions
    .filter((session) => session.cliquePartition !== null)
    .map((session) => {
      const partition = session.cliquePartition as CliquePartition;
      return (
        `    session ${String(session.index)} Clique_Partition: ` +
        `${String(partition.designCliques.length)} design clique(s), ` +
        `${String(partition.testbenchPartition.length)} testbench group(s)`
      );
    });
}

/** Req 10.1-10.4: `square_wave` is reported against its combined-cell Witness_Baseline;
 * `multi_16bit` against its mean-Trusted_Testbench Witness_Baseline. Every figure states how
 * many Sessions it was measured over (Req 10.10), never silently assuming all 3 completed.
 *
 * Exported for task 14.2's Property 25 test; pure, and no part of the paid path. */
export function renderWitnessDesignReport(
  report: WitnessDesignReport,
  isSquareWave: boolean,
): string {
  const lines = [
    `Witness_Design ${report.problemId}:`,
    ...report.sessions.map(renderWitnessSessionLine),
  ];
  lines.push(...renderNonVacuityLines(report.sessions));
  lines.push(...renderCliquePartitionLines(report.sessions));
  const measured = report.sessions.filter((session) => session.incompleteReason === null);
  const verifiedCount = measured.filter((session) => session.outcomeKind === 'verified').length;
  lines.push(
    `  Verified_Outcome count: ${String(verifiedCount)} of ${String(measured.length)} measured ` +
      `Session(s) (${String(report.sessions.length)} run)`,
  );
  if (isSquareWave) {
    const totalPassing = measured.reduce((sum, session) => sum + session.passingCells, 0);
    const totalCells = measured.reduce((sum, session) => sum + session.totalCells, 0);
    lines.push(
      `  passing matrix cells over ${String(measured.length)} measured Session(s): ` +
        `${String(totalPassing)} of ${String(totalCells)}, against the Witness_Baseline of ` +
        `${String(SQUARE_WAVE_WITNESS_BASELINE_CELLS)} of ${String(CONSENSUS_POOL_SIZE * CONSENSUS_POOL_SIZE)} per Session`,
    );
  } else {
    const trustedCounts = measured.map((session) => session.trustedTestbenchCount);
    const mean =
      trustedCounts.length === 0
        ? null
        : trustedCounts.reduce((a, b) => a + b, 0) / trustedCounts.length;
    const atLeastOneTrusted = measured.filter(
      (session) => session.trustedTestbenchCount > 0,
    ).length;
    lines.push(
      `  mean Trusted_Testbench count: ${mean === null ? 'unmeasured' : mean.toFixed(2)} over ` +
        `${String(measured.length)} measured Session(s); ${String(atLeastOneTrusted)} of ` +
        `${String(measured.length)} reached at least one Trusted_Testbench`,
    );
  }
  return lines.join('\n');
}

// -- Step 3: the Always_Verified_Set reading (Req 5.3, 5.8) - a citation of which designs and
//    how many Sessions each needs (Q1, design-questions.md), then real Sessions over them ------

interface AlwaysVerifiedSetCitationEntry {
  readonly problemId: string;
  readonly sessionCount: number;
}

interface AlwaysVerifiedSetCitation {
  readonly designs: readonly AlwaysVerifiedSetCitationEntry[];
}

function isAlwaysVerifiedSetCitation(value: unknown): value is AlwaysVerifiedSetCitation {
  const record = value as { readonly designs?: unknown } | null;
  return (
    typeof record === 'object' &&
    record !== null &&
    Array.isArray(record.designs) &&
    record.designs.every(
      (entry: unknown) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as AlwaysVerifiedSetCitationEntry).problemId === 'string' &&
        typeof (entry as AlwaysVerifiedSetCitationEntry).sessionCount === 'number',
    )
  );
}

/** `null` when no citation is committed yet (Q1): this driver never guesses the 20 design IDs. */
async function loadAlwaysVerifiedSetCitation(): Promise<AlwaysVerifiedSetCitation | null> {
  const raw = await readFile(
    resolve(REPOSITORY_ROOT, ALWAYS_VERIFIED_SET_CITATION_PATH),
    'utf8',
  ).catch(() => null);
  if (raw === null) {
    return null;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isAlwaysVerifiedSetCitation(parsed)) {
    throw new Error(
      `stimulus-transaction-acceptance: ${ALWAYS_VERIFIED_SET_CITATION_PATH} is malformed ` +
        '(expected { designs: { problemId, sessionCount }[] })',
    );
  }
  return parsed;
}

interface AlwaysVerifiedSetDesignResult {
  readonly problemId: string;
  readonly verifiedEverySession: boolean;
  /** One entry per Session: the Grant_Condition left unmet, or `null` when that Session verified. */
  readonly unmetConditionsBySession: readonly (string | null)[];
}

type AlwaysVerifiedSetReading =
  | {
      readonly available: true;
      readonly verifiedDesignCount: number;
      readonly requiredDesignCount: number;
      readonly results: readonly AlwaysVerifiedSetDesignResult[];
    }
  | { readonly available: false; readonly reason: string };

/** Req 5.3: real Sessions over the cited Always_Verified_Set, never a text comparison - see
 * design.md's "What is measured rather than tested" section for why this is a measurement. */
async function readAlwaysVerifiedSet(
  problemById: ReadonlyMap<string, EvalProblem>,
): Promise<AlwaysVerifiedSetReading> {
  const citation = await loadAlwaysVerifiedSetCitation();
  if (citation === null) {
    return {
      available: false,
      reason:
        `no citation committed at ${ALWAYS_VERIFIED_SET_CITATION_PATH} - see ` +
        'design-questions.md Q1; this driver cannot confirm 20 of 20 without it',
    };
  }
  const results: AlwaysVerifiedSetDesignResult[] = [];
  for (const entry of citation.designs) {
    const problem = problemById.get(entry.problemId);
    if (problem === undefined) {
      throw new Error(
        `stimulus-transaction-acceptance: ${entry.problemId} named by the Always_Verified_Set ` +
          'citation is not in the imported corpus',
      );
    }
    const unmetConditionsBySession: (string | null)[] = [];
    for (let index = 0; index < entry.sessionCount; index += 1) {
      const attempt = await runOneSessionOrCrashReason(problem.spec);
      if (attempt.crashed) {
        unmetConditionsBySession.push(attempt.reason);
        continue;
      }
      const { outcome } = attempt.session;
      unmetConditionsBySession.push(outcome.kind === 'verified' ? null : outcome.unmetCondition);
    }
    results.push({
      problemId: entry.problemId,
      verifiedEverySession: unmetConditionsBySession.every((condition) => condition === null),
      unmetConditionsBySession,
    });
    // This step alone is ~60 Sessions (the 91% of this run's spend that is NOT the Witness_
    // Designs), so a checkpoint after every design - not only at the very end of this function -
    // is what keeps a later crash from re-destroying work this step already paid for.
    await persistCheckpoint('always-verified-set-progress', {
      designsCompleted: results.length,
      designsTotal: citation.designs.length,
      results,
    });
  }
  return {
    available: true,
    verifiedDesignCount: results.filter((result) => result.verifiedEverySession).length,
    requiredDesignCount: citation.designs.length,
    results,
  };
}

function renderAlwaysVerifiedSetReading(reading: AlwaysVerifiedSetReading): string {
  if (!reading.available) {
    return `Always_Verified_Set reading: not measured - ${reading.reason}`;
  }
  const lines = [
    `Always_Verified_Set reading: ${String(reading.verifiedDesignCount)} of ` +
      `${String(reading.requiredDesignCount)} designs reached a Verified_Outcome in every Session`,
  ];
  for (const result of reading.results) {
    if (!result.verifiedEverySession) {
      const perSession = result.unmetConditionsBySession
        .map((condition, index) => `session ${String(index)}: ${condition ?? 'verified'}`)
        .join(', ');
      lines.push(`  ${result.problemId}: ${perSession}`);
    }
  }
  return lines.join('\n');
}

// -- Step 4: the mutation probe comparison of task 12.5 (C16, Req 6.3-6.5, 6.7, 6.8) -------------

interface ProbedKillRateCitationEntry {
  readonly designId: string;
  readonly probed: KillRateReading;
  readonly baseline: KillRateReading;
}

function isProbedKillRateCitation(value: unknown): value is readonly ProbedKillRateCitationEntry[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry: unknown) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as ProbedKillRateCitationEntry).designId === 'string' &&
        typeof (entry as ProbedKillRateCitationEntry).probed === 'object' &&
        typeof (entry as ProbedKillRateCitationEntry).baseline === 'object',
    )
  );
}

/** `null` when task 12.5's reading is not committed yet (Q2): never re-run or fabricated here. */
async function loadProbedKillRateReadings(): Promise<
  readonly ProbedKillRateCitationEntry[] | null
> {
  const raw = await readFile(
    resolve(REPOSITORY_ROOT, PROBED_KILL_RATE_CITATION_PATH),
    'utf8',
  ).catch(() => null);
  if (raw === null) {
    return null;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isProbedKillRateCitation(parsed)) {
    throw new Error(
      `stimulus-transaction-acceptance: ${PROBED_KILL_RATE_CITATION_PATH} is malformed ` +
        '(expected { designId, probed, baseline }[])',
    );
  }
  return parsed;
}

async function renderProbeComparisonStep(): Promise<string> {
  const entries = await loadProbedKillRateReadings();
  if (entries === null) {
    return (
      `mutation probe comparison: not measured - no citation committed at ` +
      `${PROBED_KILL_RATE_CITATION_PATH} (task 12.5) - see design-questions.md Q2`
    );
  }
  return entries
    .map((entry) =>
      renderKillRateComparison(entry.designId, compareKillRates(entry.probed, entry.baseline)),
    )
    .join('\n');
}

// -- Orchestration --------------------------------------------------------------------------

function requireProblem(
  problemById: ReadonlyMap<string, EvalProblem>,
  problemId: string,
): EvalProblem {
  const problem = problemById.get(problemId);
  if (problem === undefined) {
    throw new Error(`stimulus-transaction-acceptance: ${problemId} not in the imported corpus`);
  }
  return problem;
}

interface AcceptanceReport {
  readonly byteIdentity: ByteIdentityCheckResult;
  readonly stoppedAt: 'byte-identity' | 'council-early-warning' | 'always-verified-set' | null;
  readonly squareWave: WitnessDesignReport | null;
  readonly multi16Bit: WitnessDesignReport | null;
  readonly alwaysVerifiedSet: AlwaysVerifiedSetReading | null;
  readonly probeComparison: string | null;
}

async function persistReport(report: AcceptanceReport): Promise<string> {
  const outDir = join(
    REPOSITORY_ROOT,
    '.eval-runs',
    `stimulus-transaction-acceptance-${new Date().toISOString().replace(/[:.]/gu, '-')}`,
  );
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return outDir;
}

/**
 * A fixed-path, overwritten-in-place checkpoint, distinct from `persistReport`'s own
 * timestamped final-report directory. Every call overwrites the same file, so this is a
 * resumability aid for whoever reads the tree after a crash, never a second copy of the final
 * report and never read back by this driver itself (Req 10.10's "not measured" tolerance covers
 * a crashed Session; this covers a crash losing everything measured before it).
 */
async function persistCheckpoint(label: string, data: unknown): Promise<void> {
  const outDir = join(REPOSITORY_ROOT, '.eval-runs', 'stimulus-transaction-acceptance-checkpoints');
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, `${label}.json`), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function main(): Promise<void> {
  await requirePaidReRunApproval();

  const byteIdentity = await checkLegacyByteIdentity();
  console.log(
    `Legacy_Byte_Identity_Check: ${String(byteIdentity.checkedCount)} designs checked, ` +
      `${String(byteIdentity.failures.length)} differing`,
  );
  if (byteIdentity.failures.length > 0) {
    // STOP BRANCH 1: before any Session is run.
    for (const failure of byteIdentity.failures) {
      console.log(
        `  STOP: ${failure.problemId}: ${String(failure.differingByteCount)} differing byte(s), ` +
          `first at offset ${String(failure.firstDifferingOffset)}, Input_Role ${failure.inputRole}`,
      );
    }
    await persistReport({
      byteIdentity,
      stoppedAt: 'byte-identity',
      squareWave: null,
      multi16Bit: null,
      alwaysVerifiedSet: null,
      probeComparison: null,
    });
    return;
  }

  const corpus = await importRtllmCorpus(
    new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
    localTimingDerivation(),
  );
  const problemById = new Map(corpus.problems.map((problem) => [problem.id, problem]));

  const squareWave = await runWitnessDesignSessions(
    WITNESS_SQUARE_WAVE_ID,
    requireProblem(problemById, WITNESS_SQUARE_WAVE_ID).spec,
    'hold',
  );
  const multi16Bit = await runWitnessDesignSessions(
    WITNESS_MULTI_16BIT_ID,
    requireProblem(problemById, WITNESS_MULTI_16BIT_ID).spec,
    // Req 8.9 retargeted 'strobe' -> 'enable' (role-classification-decisions.md): the golden
    // RTL resets the shift count on deassert, so a Strobe abandons the multiply (measured
    // 62.5% -> 29.2%) while enable sustains it (measured 62.5% -> 83.3%).
    'enable',
  );
  console.log(renderWitnessDesignReport(squareWave, true));
  console.log(renderWitnessDesignReport(multi16Bit, false));
  // Checkpoint before the far more expensive Always_Verified_Set step (60 of this run's 66
  // Sessions): the 6 Witness_Design Sessions just spent are real tokens too, and a crash
  // further into the run must not re-destroy them a second time.
  await persistCheckpoint('witness-designs-complete', { squareWave, multi16Bit });

  if (councilEarlyWarningFired(squareWave)) {
    // STOP BRANCH 3: before any Sweep over a design outside the Witness_Designs.
    console.log(
      "STOP: the council's early warning fired (square_wave at or below its Witness_Baseline " +
        'of 12 of 64 cells in a measured Session). The deferred decision-rule question is ' +
        'reopened against the clique-partition data of task 11.7.',
    );
    await persistReport({
      byteIdentity,
      stoppedAt: 'council-early-warning',
      squareWave,
      multi16Bit,
      alwaysVerifiedSet: null,
      probeComparison: null,
    });
    return;
  }

  const alwaysVerifiedSet = await readAlwaysVerifiedSet(problemById);
  console.log(renderAlwaysVerifiedSetReading(alwaysVerifiedSet));
  const verifiedCount = alwaysVerifiedSet.available ? alwaysVerifiedSet.verifiedDesignCount : 0;
  if (!alwaysVerifiedSet.available || verifiedCount < ALWAYS_VERIFIED_SET_REQUIRED_COUNT) {
    // STOP BRANCH 2: before any wider Sweep.
    console.log(
      `STOP: the Always_Verified_Set count (${String(verifiedCount)} of ` +
        `${String(ALWAYS_VERIFIED_SET_REQUIRED_COUNT)}) did not reach 20 of 20.`,
    );
    await persistReport({
      byteIdentity,
      stoppedAt: 'always-verified-set',
      squareWave,
      multi16Bit,
      alwaysVerifiedSet,
      probeComparison: null,
    });
    return;
  }

  const probeComparison = await renderProbeComparisonStep();
  console.log(probeComparison);

  const outDir = await persistReport({
    byteIdentity,
    stoppedAt: null,
    squareWave,
    multi16Bit,
    alwaysVerifiedSet,
    probeComparison,
  });
  console.log(`\nreport under ${outDir}`);
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(
      `stimulus-transaction-acceptance: ${error instanceof Error ? error.message : 'unknown'}`,
    );
    process.exitCode = 1;
  });
}
