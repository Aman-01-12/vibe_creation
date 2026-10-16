// reference-model-consensus-gate, Property 25: Both token ledgers stop and report at the ceiling
// (task 3.4).
//
// THE ORACLE
//   A running sum computed in this test, independently of `BudgetLedger`'s own `spent()`
//   accounting. A charge sequence is built as a COMPOSITION of the ceiling (positive integers
//   summing to exactly it, via random cut points), so the exact-boundary case - "spending exactly
//   the ceiling is within budget" (Req 15.1, 15.2) - is reached on every run rather than missed by
//   chance, which is the one point a uniformly random charge sequence will not land on.
//
// WHAT EACH CLAUSE ASSERTS
//   1. The ledger admits every charge of a sequence summing exactly to its ceiling (each prefix sum
//      is at most the ceiling), ends with `spent()` equal to the ceiling, and `exhaustedCause()`
//      naming that scope's cause.
//   2. The refusal lands on the call that would EXCEED, not on the one that reached: after the
//      sequence is admitted, the next call's `canAfford` is false, so a loop modelled on it issues
//      zero further charges at that scope (Req 15.3, 15.7).
//   3. Nesting: a Session ledger with headroom (not exhausted) composed with an exhausted Run
//      ledger, through a caller that consults the Run ledger first, names the Run ceiling as the
//      cause even though the Session ledger's own `exhaustedCause()` is null. There is no single
//      nested-ledger type in `budget.ts` to call; this clause tests the two ledgers'
//      COMPOSABILITY, which the Session orchestrator (a later task) performs for real.
//
// Validates: Requirements 15.1, 15.2, 15.3, 15.7

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  makeBudgetLedger,
  RUN_TOKEN_BUDGET,
  SESSION_TOKEN_BUDGET,
} from '../agent/consensus/budget.js';
import type { BudgetCause } from '../agent/consensus/budget.js';

import { propertyParameters } from './property.js';

const PROPERTY =
  'reference-model-consensus-gate, Property 25: Both token ledgers stop and report at the ceiling';

/** Cut points drawn from this range keep the composition's piece count small and the test fast. */
const MAX_PIECES = 12;

/** One scope's ceiling and the cause its ledger reports once exhausted. */
interface ScopeConfig {
  readonly ceiling: number;
  readonly cause: BudgetCause;
}

const SESSION_SCOPE: ScopeConfig = { ceiling: SESSION_TOKEN_BUDGET, cause: 'session-token-budget' };
const RUN_SCOPE: ScopeConfig = { ceiling: RUN_TOKEN_BUDGET, cause: 'run-token-budget' };

/**
 * A composition of `total`: positive integers summing to exactly `total`, in sequence order.
 *
 * Built from a set of unique cut points in `(0, total)`; the gaps between 0, the sorted cuts, and
 * `total` are the charges, so the sum is exactly `total` by construction regardless of which cuts
 * are drawn. Zero cuts yields the single-charge case (one charge of the whole ceiling).
 */
function compositionArbitrary(total: number): fc.Arbitrary<readonly number[]> {
  return fc
    .uniqueArray(fc.integer({ min: 1, max: total - 1 }), {
      minLength: 0,
      maxLength: MAX_PIECES - 1,
    })
    .map((cuts) => {
      const points = [0, ...[...cuts].sort((left, right) => left - right), total];
      const charges: number[] = [];
      for (let index = 1; index < points.length; index += 1) {
        charges.push((points[index] as number) - (points[index - 1] as number));
      }
      return charges;
    });
}

const scopedCompositionArbitrary: fc.Arbitrary<{
  readonly scope: ScopeConfig;
  readonly charges: readonly number[];
}> = fc
  .constantFrom(SESSION_SCOPE, RUN_SCOPE)
  .chain((scope) => compositionArbitrary(scope.ceiling).map((charges) => ({ scope, charges })));

/** The outcome of running a composed sequence against a ledger, then probing one call past it. */
interface LedgerRunOutcome {
  readonly callsIssued: number;
  readonly nextCallIssued: boolean;
}

/**
 * Charge `ledger` with every element of `charges` in order, asserting each is admitted against the
 * independently-tracked running sum, then probe one further call of `nextEstimate` tokens.
 *
 * Mirrors the real caller contract: a call is only issued while `canAfford` holds, so a call this
 * function never admits is a call that is never charged (Req 15.3).
 */
function runLedgerUntilCeiling(
  ledger: ReturnType<typeof makeBudgetLedger>,
  charges: readonly number[],
  nextEstimate: number,
): LedgerRunOutcome {
  let runningSum = 0;
  let callsIssued = 0;
  for (const charge of charges) {
    expect(ledger.canAfford(charge)).toBe(true);
    ledger.charge(charge);
    runningSum += charge;
    callsIssued += 1;
    expect(ledger.spent()).toBe(runningSum);
  }

  const nextCallIssued = ledger.canAfford(nextEstimate);
  if (nextCallIssued) {
    // Only reached if the oracle's own composition was unfaithful; charging here makes the
    // resulting assertion failure legible rather than silently skipped.
    ledger.charge(nextEstimate);
  }
  return { callsIssued, nextCallIssued };
}

describe(PROPERTY, () => {
  it('admits a sequence summing exactly to the ceiling, then refuses the next call at both scopes', () => {
    let singleChargeCases = 0;
    let multiChargeCases = 0;
    let sessionScopeCases = 0;
    let runScopeCases = 0;

    fc.assert(
      fc.property(
        scopedCompositionArbitrary,
        fc.integer({ min: 1, max: 1_000 }),
        ({ scope, charges }, nextEstimate) => {
          const ledger = makeBudgetLedger(scope.ceiling, scope.cause);

          const outcome = runLedgerUntilCeiling(ledger, charges, nextEstimate);

          // Spending exactly the ceiling is within budget (Req 15.1, 15.2): every charge of the
          // composed sequence was admitted, and the final spend lands exactly on the ceiling.
          expect(outcome.callsIssued).toBe(charges.length);
          expect(ledger.spent()).toBe(scope.ceiling);

          // The ledger reports exhausted, naming this scope's own cause.
          expect(ledger.exhaustedCause()).toBe(scope.cause);

          // The refusal is of the NEXT call, the one that would exceed, not of the one that
          // reached the ceiling: zero further calls are issued once the ceiling is spent.
          expect(ledger.canAfford(nextEstimate)).toBe(false);
          expect(outcome.nextCallIssued).toBe(false);

          if (charges.length === 1) {
            singleChargeCases += 1;
          } else {
            multiChargeCases += 1;
          }
          if (scope === SESSION_SCOPE) {
            sessionScopeCases += 1;
          } else {
            runScopeCases += 1;
          }
        },
      ),
      propertyParameters(),
    );

    // NON-VACUITY: the one-shot composition, a multi-piece composition, and both scopes each ran.
    expect({
      singleChargeCases: singleChargeCases > 0,
      multiChargeCases: multiChargeCases > 0,
      sessionScopeCases: sessionScopeCases > 0,
      runScopeCases: runScopeCases > 0,
    }).toEqual({
      singleChargeCases: true,
      multiChargeCases: true,
      sessionScopeCases: true,
      runScopeCases: true,
    });
  });

  it('nests the Run ceiling over a Session with headroom: the cause names the Run budget, not the Session one', () => {
    fc.assert(
      fc.property(
        compositionArbitrary(RUN_TOKEN_BUDGET),
        fc.integer({ min: 0, max: SESSION_TOKEN_BUDGET - 1 }),
        (runCharges, sessionSpent) => {
          const sessionLedger = makeBudgetLedger(SESSION_TOKEN_BUDGET, 'session-token-budget');
          sessionLedger.charge(sessionSpent);

          const runLedger = makeBudgetLedger(RUN_TOKEN_BUDGET, 'run-token-budget');
          for (const charge of runCharges) {
            runLedger.charge(charge);
          }

          // The Session ledger has headroom: it is independently built, not nested as a type, and
          // its own exhaustedCause is null even though the Run ledger wrapping it is exhausted.
          expect(sessionLedger.canAfford(1)).toBe(true);
          expect(sessionLedger.exhaustedCause()).toBeNull();

          // The Run ledger is exhausted at exactly its own ceiling.
          expect(runLedger.spent()).toBe(RUN_TOKEN_BUDGET);
          expect(runLedger.exhaustedCause()).toBe('run-token-budget');

          // The composing caller (the orchestrator's real behaviour, exercised here directly since
          // no nested-ledger type exists): consult the Run ledger first. The Session ledger fitting
          // its own ceiling must not hide the Run ceiling it is nested inside (Req 15.7).
          const cause = runLedger.exhaustedCause() ?? sessionLedger.exhaustedCause();
          expect(cause).toBe('run-token-budget');
        },
      ),
      propertyParameters(),
    );
  });
});
