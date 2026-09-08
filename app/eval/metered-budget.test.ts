// Unit tests for the metered per-session budget (task 19.3, Req 15.2, 17.3).
//
// The metered budget must (a) account exactly like a student session via the core
// budget functions, (b) expose the consumed cost the harness measures, and (c)
// terminate at the student caps so an eval sample can never run looser than a
// student.
//
// It also owns the honesty channel behind the campaign's headline efficiency figure: a
// model call whose provider reported no usage must stay DISTINGUISHABLE from a charge that
// genuinely spent no tokens, because tokens per verified artifact is divided out of these
// numbers and a silent provider would otherwise read as a free one.

import { describe, expect, it } from 'vitest';

import { makeSessionBudget, newUlid, type SessionBudget } from '@app/core';

import { MeteredSessionBudget } from './metered-budget.js';

function budget(overrides: Partial<SessionBudget> = {}): SessionBudget {
  const built = makeSessionBudget({
    sessionId: newUlid(),
    maxIterations: 10,
    maxTokens: 1_000_000,
    maxWallClockMs: 1_000_000,
    maxCostCents: 1_000_000,
    consumedIterations: 0,
    consumedTokens: 0,
    consumedMs: 0,
    consumedCostCents: 0,
    ...overrides,
  });
  if (!built.ok) {
    throw new Error(built.error.message);
  }
  return built.value;
}

describe('MeteredSessionBudget', () => {
  it('accumulates cost, tokens, wall-clock, and one iteration per charge', () => {
    const metered = new MeteredSessionBudget(budget());
    metered.charge({ tokens: 5, costCents: 2, wallClockMs: 30 });
    metered.charge({ tokens: 3, costCents: 1.5, wallClockMs: 20 });
    expect(metered.consumed()).toEqual({
      iterations: 2,
      tokens: 8,
      // Neither charge stated a token usage, so neither was a model call: the split stays
      // zero AND nothing is flagged unreported, which is the honest reading of two
      // simulate iterations.
      promptTokens: 0,
      completionTokens: 0,
      unreportedUsageCalls: 0,
      wallClockMs: 50,
      costCents: 3.5,
    });
  });

  it('normalizes a fractional token/ms charge to a non-negative integer', () => {
    const metered = new MeteredSessionBudget(budget());
    metered.charge({ tokens: 2.9, costCents: 0, wallClockMs: 9.9 });
    expect(metered.consumed()).toEqual({
      iterations: 1,
      tokens: 2,
      promptTokens: 0,
      completionTokens: 0,
      unreportedUsageCalls: 0,
      wallClockMs: 9,
      costCents: 0,
    });
  });

  it('stops at the iteration cap after exactly maxIterations charges', () => {
    const metered = new MeteredSessionBudget(budget({ maxIterations: 2 }));
    expect(metered.canAfford()).toBe(true);
    expect(metered.charge({ tokens: 0, costCents: 0, wallClockMs: 0 })).toBeNull();
    expect(metered.canAfford()).toBe(true);
    expect(metered.charge({ tokens: 0, costCents: 0, wallClockMs: 0 })).toBe('max-iterations');
    expect(metered.canAfford()).toBe(false);
  });

  it('reports the cost cap when cost is the first cap reached', () => {
    const metered = new MeteredSessionBudget(budget({ maxCostCents: 5 }));
    expect(metered.charge({ tokens: 0, costCents: 5, wallClockMs: 0 })).toBe('max-cost');
    expect(metered.consumed().costCents).toBe(5);
  });
});

describe('MeteredSessionBudget - reported token usage is measured, not assumed', () => {
  it('given a reported split, when charged, then it accumulates alongside the core total', () => {
    const metered = new MeteredSessionBudget(budget());

    metered.charge({
      tokens: 1_500,
      costCents: 0,
      wallClockMs: 10,
      tokenUsage: { kind: 'reported', promptTokens: 1_200, completionTokens: 300 },
    });
    metered.charge({
      tokens: 500,
      costCents: 0,
      wallClockMs: 10,
      tokenUsage: { kind: 'reported', promptTokens: 400, completionTokens: 100 },
    });

    const consumed = metered.consumed();
    expect(consumed.promptTokens).toBe(1_600);
    expect(consumed.completionTokens).toBe(400);
    expect(consumed.tokens).toBe(2_000);
    expect(consumed.unreportedUsageCalls).toBe(0);
  });

  it('given a host whose total exceeds prompt + completion, when charged, then both stand', () => {
    // Some hosts bill cached or reasoning tokens into `total_tokens`. The total is the
    // provider's own number and is NOT re-derived from the split, so neither is discarded.
    const metered = new MeteredSessionBudget(budget());

    metered.charge({
      tokens: 900,
      costCents: 0,
      wallClockMs: 1,
      tokenUsage: { kind: 'reported', promptTokens: 500, completionTokens: 100 },
    });

    const consumed = metered.consumed();
    expect(consumed.tokens).toBe(900);
    expect(consumed.promptTokens + consumed.completionTokens).toBe(600);
  });

  it('given a fractional reported split, when charged, then it floors to whole tokens', () => {
    // The counts originate in an untrusted provider reply; this port normalizes rather than
    // trusting its caller, exactly as it already does for the total.
    const metered = new MeteredSessionBudget(budget());

    metered.charge({
      tokens: 3,
      costCents: 0,
      wallClockMs: 1,
      tokenUsage: { kind: 'reported', promptTokens: 2.9, completionTokens: -4 },
    });

    expect(metered.consumed().promptTokens).toBe(2);
    expect(metered.consumed().completionTokens).toBe(0);
  });
});

describe('MeteredSessionBudget - absent usage is NEVER read as zero tokens', () => {
  it('given an unreported model call, when charged, then it is counted and not summed', () => {
    const metered = new MeteredSessionBudget(budget());

    // A provider that answered with no usable `usage` block: the call happened, we were
    // told nothing about it.
    metered.charge({
      tokens: 0,
      costCents: 0,
      wallClockMs: 40,
      tokenUsage: { kind: 'unreported' },
    });

    const consumed = metered.consumed();
    expect(consumed.unreportedUsageCalls).toBe(1);
    expect(consumed.promptTokens).toBe(0);
    expect(consumed.completionTokens).toBe(0);
  });

  it('given a no-model charge and an unreported call, when charged, then the two differ', () => {
    // THE DISTINCTION THAT MATTERS. Both add zero to every token count, so a sum cannot
    // tell them apart; `unreportedUsageCalls` is the only thing that can, and without it a
    // provider that stopped metering would win a tokens-per-artifact bake-off.
    const simulateOnly = new MeteredSessionBudget(budget());
    const silentProvider = new MeteredSessionBudget(budget());

    simulateOnly.charge({ tokens: 0, costCents: 0, wallClockMs: 40 });
    silentProvider.charge({
      tokens: 0,
      costCents: 0,
      wallClockMs: 40,
      tokenUsage: { kind: 'unreported' },
    });

    expect(simulateOnly.consumed().tokens).toBe(silentProvider.consumed().tokens);
    expect(simulateOnly.consumed().unreportedUsageCalls).toBe(0);
    expect(silentProvider.consumed().unreportedUsageCalls).toBe(1);
  });

  it('given a malformed usage object, when charged, then it neither throws nor invents', () => {
    // The reply parser already rejects a non-numeric count at the trust boundary, so this
    // shape can only arrive from a broken collaborator. It must still not throw mid-campaign
    // and must not fabricate a count.
    const metered = new MeteredSessionBudget(budget());
    const malformed = {
      kind: 'reported',
      promptTokens: Number.NaN,
      completionTokens: Number.POSITIVE_INFINITY,
    } as const;

    expect(() =>
      metered.charge({ tokens: 0, costCents: 0, wallClockMs: 1, tokenUsage: malformed }),
    ).not.toThrow();

    expect(metered.consumed().promptTokens).toBe(0);
    expect(metered.consumed().completionTokens).toBe(0);
  });
});
