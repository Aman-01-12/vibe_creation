// The Session and Run token ledgers that bound a Consensus_Gate Session and
// Student_Run in tokens (C18; Req 15.1, 15.2, 15.3, 15.5, 15.6, 15.7, 11.8).
//
// Two scopes, one shared implementation: a Session ledger bounds one `runSession`
// call and a Run ledger bounds the up-to-3 attempts of one Student_Run, wrapping
// every Session attempt inside it. The orchestrator (C1) checks the Session ledger
// first and the Run ledger second, so a Session that fits its own ceiling can still
// be refused by the Run ceiling it is nested inside. Both criteria describe the
// same stop-and-report behaviour at a different scope, so one `makeBudgetLedger`
// factory serves both rather than two near-duplicate implementations.
//
// STOP AND REPORT, NEVER TRUNCATE: reaching a ceiling starts no further model call;
// the caller delivers an Unverified_Outcome naming the exhausted ceiling as the
// cause (Req 15.3, 15.7). A silently shortened Design_Pool or Testbench_Pool would
// weaken the Strict_Majority threshold, the family cap, and the Peer_Floor at once,
// so this ledger never truncates on the caller's behalf; it only ever refuses the
// next call.
//
// The absolute spend (roughly 16x today's ~8k tokens per sample, against the PRD's
// pennies-per-session target) is a product decision tracked as a follow-up outside
// this spec, not a constant here.

/** JUDGEMENT: 23% headroom over the measured 65k per Session, because a tight ceiling costs coverage. */
export const SESSION_TOKEN_BUDGET = 80_000;

/** JUDGEMENT: 56% headroom over the measured 128k per Student_Run. */
export const RUN_TOKEN_BUDGET = 200_000;

/** Which ceiling exhausted a ledger; names the Unverified_Outcome's cause (Req 15.3, 15.7). */
export type BudgetCause = 'session-token-budget' | 'run-token-budget';

/**
 * A mutable token ledger bounding one scope (a Session or a Student_Run).
 *
 * Spending exactly the ceiling is within budget (Req 15.1, 15.2): `canAfford`
 * answers whether a call of the given estimated size may still be issued, and
 * `charge` records what a call actually spent once it completes.
 */
export interface BudgetLedger {
  /** True when a call of this estimated size may be issued without exceeding the ceiling. */
  canAfford(estimatedTokens: number): boolean;
  /** Record what a completed call actually spent. */
  charge(actualTokens: number): void;
  /** The total tokens charged so far. */
  spent(): number;
  /** This ledger's cause when its ceiling is reached or exceeded, else null. */
  exhaustedCause(): BudgetCause | null;
}

/**
 * Build a `BudgetLedger` for one ceiling and the cause it reports when exhausted.
 *
 * One implementation serves both scopes: construct it once with
 * `SESSION_TOKEN_BUDGET` and `'session-token-budget'`, and once with
 * `RUN_TOKEN_BUDGET` and `'run-token-budget'`. A negative or non-finite token
 * count passed to either method is floored to zero rather than trusted, because a
 * token count here ultimately originates in a provider's usage reply, the same
 * untrusted-input discipline `app/eval/metered-budget.ts` applies at its own
 * charge boundary.
 */
export function makeBudgetLedger(ceilingTokens: number, cause: BudgetCause): BudgetLedger {
  let spentTokens = 0;

  return {
    canAfford(estimatedTokens: number): boolean {
      return spentTokens + nonNegativeInt(estimatedTokens) <= ceilingTokens;
    },
    charge(actualTokens: number): void {
      spentTokens += nonNegativeInt(actualTokens);
    },
    spent(): number {
      return spentTokens;
    },
    exhaustedCause(): BudgetCause | null {
      return spentTokens >= ceilingTokens ? cause : null;
    },
  };
}

/** Floor an externally-sourced token count to a non-negative integer. */
function nonNegativeInt(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
