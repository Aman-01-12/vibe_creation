// Session_Budget accounting: the runtime consumption logic over the immutable
// `SessionBudget` record (task 8.1, Req 17.1, 17.2). Property 18 (task 8.2)
// verifies the termination and single-step-overshoot guarantees this module
// makes; it is deliberately not implemented here.
//
// Design shape (Cross-cutting components / Error Handling):
//
//   - Pure and deterministic. This module owns no clock and performs no I/O: the
//     caller supplies the elapsed-ms, token, and cost deltas for each unit of
//     work, so charging is a total function of its inputs and the property test
//     needs no time source. `chargeBudget`/`chargeBudgetIteration` never mutate
//     their input; they return a new `SessionBudget`, so budget state has a
//     single owner (the loop variable the caller threads forward).
//
//   - The single overshoot rule (Req 17.2). A step may start only while the
//     budget is not already stopped (`admit()` / `!isBudgetStopped`). Charging is
//     monotonic (deltas are non-negative) and `consumedIterations` strictly
//     increases each iteration, so a cap is crossed by at most the one in-flight
//     step that was admitted while still under budget; the next `admit()` then
//     refuses. Stated as one invariant a test can assert: a charged step is only
//     ever applied to a not-yet-stopped budget, and a stopped budget stays
//     stopped, so consumption exceeds any cap by at most one step's charge.
//
//   - Stop reasons map one-to-one to the four caps. A budget is stopped iff some
//     `consumed*` has reached its `max*`; `budgetStopReason` reports which cap
//     tripped, checked in the fixed precedence iterations -> tokens -> wall-clock
//     -> cost so a simultaneous multi-cap breach yields one deterministic reason.
//
// M0 vs M1 note (Req 1.4): the M0 spine skeleton (task 6.1) does NOT use this
// accountant; it bounded run time solely with the sandbox wall-clock cap from the
// Tool_Runner. This module is the M1 Session_Budget that fully satisfies Req
// 1.4's time limit as an explicit agentic cap threaded through every model and
// tool call.

import type { BudgetStopReason } from '../models/enums.js';
import { domainError, type DomainError } from '../models/domain-error.js';
import { err, ok, type Result } from '../models/result.js';
import type { SessionBudget } from '../models/session-budget.js';

/**
 * A non-negative amount of work to charge against a `SessionBudget` in one step.
 *
 * `tokens` and `ms` are whole counts; `costCents` may be fractional (sub-cent
 * pricing). Construct via `makeBudgetCharge`, which enforces non-negativity and
 * finiteness so charging can stay a total, monotonic function.
 */
export interface BudgetCharge {
  readonly tokens: number;
  readonly ms: number;
  readonly costCents: number;
}

/** A zero charge: advances no cap. Useful for a step that only counts iterations. */
export const ZERO_CHARGE: BudgetCharge = { tokens: 0, ms: 0, costCents: 0 };

/** Reject a token or millisecond delta that is not a non-negative integer. */
function checkCount(name: string, value: number): DomainError | null {
  if (!Number.isInteger(value) || value < 0) {
    return domainError('NEGATIVE_QUANTITY', `${name} must be a non-negative integer`, name);
  }
  return null;
}

/** Reject a cost delta that is not a finite, non-negative number. */
function checkCost(value: number): DomainError | null {
  if (!Number.isFinite(value) || value < 0) {
    return domainError(
      'NEGATIVE_QUANTITY',
      'costCents must be a non-negative finite number',
      'costCents',
    );
  }
  return null;
}

/**
 * Construct a validated `BudgetCharge`, rejecting negative, non-finite, or
 * non-integer amounts.
 *
 * Validating at construction lets callers (for example the Model_Router turning a
 * provider-reported token count into a charge) reject a malformed usage report at
 * the boundary, and lets `chargeBudget` stay total over an already-valid charge.
 */
export function makeBudgetCharge(input: BudgetCharge): Result<BudgetCharge, DomainError> {
  const tokensError = checkCount('tokens', input.tokens);
  if (tokensError !== null) {
    return err(tokensError);
  }
  const msError = checkCount('ms', input.ms);
  if (msError !== null) {
    return err(msError);
  }
  const costError = checkCost(input.costCents);
  if (costError !== null) {
    return err(costError);
  }
  return ok({ tokens: input.tokens, ms: input.ms, costCents: input.costCents });
}

/**
 * Report which cap, if any, the budget has reached (`consumed >= max`).
 *
 * Precedence is fixed at iterations -> tokens -> wall-clock -> cost so that a run
 * which breaches several caps in the same step still yields one deterministic
 * stop reason. Returns `null` while the budget still has room on every cap.
 */
export function budgetStopReason(budget: SessionBudget): BudgetStopReason | null {
  if (budget.consumedIterations >= budget.maxIterations) {
    return 'max-iterations';
  }
  if (budget.consumedTokens >= budget.maxTokens) {
    return 'max-tokens';
  }
  if (budget.consumedMs >= budget.maxWallClockMs) {
    return 'max-wall-clock';
  }
  if (budget.consumedCostCents >= budget.maxCostCents) {
    return 'max-cost';
  }
  return null;
}

/** Whether any cap has been reached, i.e. no further step may be admitted. */
export function isBudgetStopped(budget: SessionBudget): boolean {
  return budgetStopReason(budget) !== null;
}

/**
 * Charge one iteration against the budget, returning a new record.
 *
 * `consumedIterations` strictly increases, which is what guarantees the loop
 * terminates: within `maxIterations` admitted steps the iteration cap is reached
 * even if no other cap is.
 */
export function chargeBudgetIteration(budget: SessionBudget): SessionBudget {
  return { ...budget, consumedIterations: budget.consumedIterations + 1 };
}

/**
 * Charge token, wall-clock, and cost consumption against the budget, returning a
 * new record. Deltas are non-negative (validated in `BudgetCharge`), so
 * consumption is monotonic and a reached cap can never become un-reached.
 */
export function chargeBudget(budget: SessionBudget, charge: BudgetCharge): SessionBudget {
  return {
    ...budget,
    consumedTokens: budget.consumedTokens + charge.tokens,
    consumedMs: budget.consumedMs + charge.ms,
    consumedCostCents: budget.consumedCostCents + charge.costCents,
  };
}

/**
 * An immutable, threadable view over a `SessionBudget` and its accounting.
 *
 * This is the value passed down through every model and tool call (the design's
 * `SessionBudgetHandle`). It never mutates in place: `chargeIteration` and
 * `charge` return a fresh handle wrapping the updated budget, so the caller keeps
 * a single owning reference and threads the latest handle forward.
 */
export interface SessionBudgetHandle {
  /** The underlying immutable budget, for recording consumption and stop reason. */
  readonly budget: SessionBudget;
  /** The cap that has tripped, or `null` while the budget still has room. */
  readonly stopReason: BudgetStopReason | null;
  /** Whether any cap has been reached. */
  readonly isStopped: boolean;
  /**
   * The next-step guard: `true` iff a further step may start. Equal to
   * `!isStopped`; the caller MUST check this before starting a step and MUST NOT
   * start one when it is `false`. Under that contract a cap is exceeded by at
   * most one in-flight step (Req 17.2).
   */
  admit(): boolean;
  /** Charge one iteration and return the resulting handle. */
  chargeIteration(): SessionBudgetHandle;
  /** Charge token/wall-clock/cost consumption and return the resulting handle. */
  charge(charge: BudgetCharge): SessionBudgetHandle;
}

/**
 * Open a budget handle over an already-validated `SessionBudget`.
 *
 * The stop state is derived from the budget on each read rather than stored, so
 * there is never a second, divergable copy of "is this budget exhausted".
 */
export function openSessionBudget(budget: SessionBudget): SessionBudgetHandle {
  return Object.freeze({
    budget,
    get stopReason(): BudgetStopReason | null {
      return budgetStopReason(budget);
    },
    get isStopped(): boolean {
      return isBudgetStopped(budget);
    },
    admit(): boolean {
      return !isBudgetStopped(budget);
    },
    chargeIteration(): SessionBudgetHandle {
      return openSessionBudget(chargeBudgetIteration(budget));
    },
    charge(charge: BudgetCharge): SessionBudgetHandle {
      return openSessionBudget(chargeBudget(budget, charge));
    },
  });
}
