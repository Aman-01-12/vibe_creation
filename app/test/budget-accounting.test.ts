// Example unit tests for Session_Budget accounting (task 8.1).
//
// Concrete checks of the budget accountant's core behavior: charges accumulate,
// reaching a cap flips the budget to stopped, each cap maps to its own stop
// reason with a deterministic precedence, and the "overshoot by at most one
// in-flight step" rule holds. The universal Property 18 (termination + overshoot
// over all inputs) is the separate fast-check test in task 8.2; these examples
// complement it.

import { describe, expect, it } from 'vitest';

import {
  ZERO_CHARGE,
  budgetStopReason,
  chargeBudget,
  chargeBudgetIteration,
  isBudgetStopped,
  makeBudgetCharge,
  makeSessionBudget,
  newUlid,
  openSessionBudget,
  type SessionBudget,
} from '@app/core';

/** Build a valid, generous budget with zero consumption; override per test. */
function budget(overrides: Partial<SessionBudget> = {}): SessionBudget {
  const result = makeSessionBudget({
    sessionId: newUlid(),
    maxIterations: 10,
    maxTokens: 1_000,
    maxWallClockMs: 60_000,
    maxCostCents: 5,
    consumedIterations: 0,
    consumedTokens: 0,
    consumedMs: 0,
    consumedCostCents: 0,
    ...overrides,
  });
  if (!result.ok) {
    throw new Error(`test budget invalid: ${result.error.code}`);
  }
  return result.value;
}

/** Unwrap a validated charge or fail the test loudly. */
function charge(tokens: number, ms: number, costCents: number) {
  const result = makeBudgetCharge({ tokens, ms, costCents });
  if (!result.ok) {
    throw new Error(`test charge invalid: ${result.error.code}`);
  }
  return result.value;
}

describe('makeBudgetCharge', () => {
  it('accepts a non-negative, finite charge', () => {
    const result = makeBudgetCharge({ tokens: 500, ms: 1_200, costCents: 0.3 });
    expect(result.ok).toBe(true);
  });

  it('rejects negative, fractional-count, and non-finite amounts', () => {
    expect(makeBudgetCharge({ tokens: -1, ms: 0, costCents: 0 }).ok).toBe(false);
    expect(makeBudgetCharge({ tokens: 1.5, ms: 0, costCents: 0 }).ok).toBe(false);
    expect(makeBudgetCharge({ tokens: 0, ms: -1, costCents: 0 }).ok).toBe(false);
    expect(makeBudgetCharge({ tokens: 0, ms: 0, costCents: -0.1 }).ok).toBe(false);
    expect(makeBudgetCharge({ tokens: 0, ms: 0, costCents: Number.POSITIVE_INFINITY }).ok).toBe(
      false,
    );
    expect(makeBudgetCharge({ tokens: 0, ms: 0, costCents: Number.NaN }).ok).toBe(false);
  });
});

describe('charging accumulates without mutating the input', () => {
  it('adds token, ms, and cost deltas onto a fresh record', () => {
    const start = budget();
    const next = chargeBudget(start, charge(100, 250, 0.4));

    expect(next.consumedTokens).toBe(100);
    expect(next.consumedMs).toBe(250);
    expect(next.consumedCostCents).toBeCloseTo(0.4);
    // The input record is untouched (single-owner, immutable state).
    expect(start.consumedTokens).toBe(0);
    expect(start.consumedMs).toBe(0);
    expect(start.consumedCostCents).toBe(0);
  });

  it('increments only the iteration count on chargeBudgetIteration', () => {
    const next = chargeBudgetIteration(budget({ consumedIterations: 3 }));
    expect(next.consumedIterations).toBe(4);
    expect(next.consumedTokens).toBe(0);
  });

  it('treats a zero charge as a no-op on the caps', () => {
    const start = budget({ consumedTokens: 42 });
    const next = chargeBudget(start, ZERO_CHARGE);
    expect(next.consumedTokens).toBe(42);
    expect(next.consumedMs).toBe(0);
  });
});

describe('reaching a cap flips the budget to stopped', () => {
  it('is not stopped while every cap has room', () => {
    expect(isBudgetStopped(budget())).toBe(false);
    expect(budgetStopReason(budget())).toBeNull();
  });

  it('stops exactly when a consumed value reaches its max', () => {
    expect(isBudgetStopped(budget({ consumedTokens: 999 }))).toBe(false);
    expect(isBudgetStopped(budget({ consumedTokens: 1_000 }))).toBe(true);
  });
});

describe('each cap maps to its own stop reason', () => {
  it('reports max-iterations when the iteration cap is reached', () => {
    expect(budgetStopReason(budget({ consumedIterations: 10 }))).toBe('max-iterations');
  });

  it('reports max-tokens when only the token cap is reached', () => {
    expect(budgetStopReason(budget({ consumedTokens: 1_000 }))).toBe('max-tokens');
  });

  it('reports max-wall-clock when only the time cap is reached', () => {
    expect(budgetStopReason(budget({ consumedMs: 60_000 }))).toBe('max-wall-clock');
  });

  it('reports max-cost when only the cost cap is reached', () => {
    expect(budgetStopReason(budget({ consumedCostCents: 5 }))).toBe('max-cost');
  });

  it('applies iterations -> tokens -> wall-clock -> cost precedence on a multi-cap breach', () => {
    const allReached = budget({
      consumedIterations: 10,
      consumedTokens: 1_000,
      consumedMs: 60_000,
      consumedCostCents: 5,
    });
    expect(budgetStopReason(allReached)).toBe('max-iterations');
  });
});

describe('the handle threads immutably and guards the next step', () => {
  it('admits steps until a cap is reached, then refuses', () => {
    const handle = openSessionBudget(budget({ maxIterations: 2 }));

    expect(handle.admit()).toBe(true);
    const afterFirst = handle.chargeIteration();
    expect(afterFirst.admit()).toBe(true);
    const afterSecond = afterFirst.chargeIteration();
    expect(afterSecond.admit()).toBe(false);
    expect(afterSecond.isStopped).toBe(true);
    expect(afterSecond.stopReason).toBe('max-iterations');
    // The original handle is unchanged: charging returns fresh handles.
    expect(handle.isStopped).toBe(false);
  });

  it('overshoots a cap by at most the single admitted in-flight step', () => {
    // A step admitted while under budget may cross the cap; the next admit refuses.
    const handle = openSessionBudget(budget({ maxTokens: 100 }));
    expect(handle.admit()).toBe(true);

    const afterStep = handle.charge(charge(60, 0, 0)).charge(charge(60, 0, 0));
    // One in-flight step charged 120 tokens against a 100 cap: overshoot is that
    // one step, and the budget is now stopped so no further step is admitted.
    expect(afterStep.budget.consumedTokens).toBe(120);
    expect(afterStep.admit()).toBe(false);
    expect(afterStep.stopReason).toBe('max-tokens');
  });

  it('refuses every step when opened on an already-exhausted budget', () => {
    const handle = openSessionBudget(budget({ maxIterations: 0 }));
    expect(handle.admit()).toBe(false);
    expect(handle.stopReason).toBe('max-iterations');
  });
});
