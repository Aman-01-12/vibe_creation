// The Student_Run loop: up to 3 Sessions, a fresh pool per attempt, bounded by
// the Run ledger wrapping the Session ledger (C1, Req 14.6, 15.2, 15.7, 16.7).
//
// Each attempt generates a FRESH Design_Pool and a fresh Testbench_Pool - the
// configuration the 63.4%-within-3-attempts figure was measured under, since
// that figure comes from independently drawn sessions.

import type { Spec } from '@app/core';

import {
  makeBudgetLedger,
  RUN_TOKEN_BUDGET,
  SESSION_TOKEN_BUDGET,
  type BudgetLedger,
} from './budget.js';
import {
  buildOutcome,
  type CheckedSummary,
  type SessionOutcome,
  type SessionRecord,
} from './outcome.js';
import { runSession, type ConsensusSessionDeps } from './session.js';

/** The bound on Sessions per Student_Run (Req 14.6). */
export const MAX_STUDENT_RUN_ATTEMPTS = 3;

/** One Student_Run's result: the terminal outcome and how many Sessions it took. */
export interface StudentRunResult {
  readonly outcome: SessionOutcome;
  readonly attempts: number;
}

/** Whether `outcome` is terminal for the Student_Run loop: stop retrying once verified. */
function isTerminal(outcome: SessionOutcome): boolean {
  return outcome.kind === 'verified';
}

/** An empty `SessionRecord`, for the Run-ledger-exhausted outcome built before any Session ran. */
function emptySessionRecord(): SessionRecord {
  return {
    clusters: [],
    signaturesByDesign: [],
    modelFamilyByArtifact: [],
    roleDeclarations: [],
    testbenchTrust: [],
    mutantCensus: [],
    poolCorrectness: { poolCorrectness: 0, attributionStatus: 'advisory', faultVerdicts: [] },
    repairAttempts: [],
    tokensSpent: 0,
    runMatrix: { designIds: [], testbenchIds: [], cells: [] },
  };
}

/** The Unverified_Outcome naming the exhausted Run_Token_Budget as the cause (Req 15.7). */
function runBudgetExhaustedOutcome(): SessionOutcome {
  const summary: CheckedSummary = {
    poolSize: 0,
    distinctModelFamilyCount: 0,
    trustedTestbenchCount: 0,
    consensusRunCount: 0,
    largestClusterCardinality: 0,
    structuralGateChecks: [],
  };
  return buildOutcome(
    { kind: 'unmet', unmetCondition: 'run-token-budget', checked: summary },
    emptySessionRecord(),
  );
}

/**
 * Run a Student_Run: up to `MAX_STUDENT_RUN_ATTEMPTS` Sessions over `spec`, each
 * a fresh pool, sharing one Run ledger across every attempt (Req 15.2, 15.7).
 *
 * The Run ledger wraps the Session ledger (Req 15.2): each attempt gets its own
 * fresh `SESSION_TOKEN_BUDGET` ledger, and what it spends is charged to the
 * shared Run ledger afterward, so a Session fitting its own ceiling can still
 * be refused on the NEXT attempt by the Run ceiling. Stops at the first
 * Verified_Outcome, at the attempt bound, or when the Run ledger cannot afford
 * another attempt - the last of which names `run-token-budget` as the cause
 * (Req 15.7), the only one of the three stops that does.
 */
export async function runStudentRun(
  spec: Spec,
  deps: ConsensusSessionDeps,
  runLedger: BudgetLedger = makeBudgetLedger(RUN_TOKEN_BUDGET, 'run-token-budget'),
): Promise<StudentRunResult> {
  let lastOutcome: SessionOutcome | null = null;

  for (let attempt = 1; attempt <= MAX_STUDENT_RUN_ATTEMPTS; attempt += 1) {
    if (runLedger.exhaustedCause() !== null) {
      return { outcome: runBudgetExhaustedOutcome(), attempts: attempt - 1 };
    }
    const sessionLedger = makeBudgetLedger(SESSION_TOKEN_BUDGET, 'session-token-budget');
    const outcome = await runSession(spec, sessionLedger, deps);
    runLedger.charge(sessionLedger.spent());
    lastOutcome = outcome;
    if (isTerminal(outcome)) {
      return { outcome, attempts: attempt };
    }
  }

  if (lastOutcome === null) {
    throw new Error('Student_Run defect: the attempt loop never ran once');
  }
  return { outcome: lastOutcome, attempts: MAX_STUDENT_RUN_ATTEMPTS };
}
