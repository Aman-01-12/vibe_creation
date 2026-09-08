// Property 18: The Session_Budget always terminates the loop (task 8.2).
//
// This is the universal complement to the example checks in
// `budget-accounting.test.ts`. It asserts, over many generated budgets and
// charge sequences, the guarantees the Session_Budget accountant must never
// break (Design: Property 18; Req 6.3, 8.4, 17.1, 17.2):
//
//   1. Termination: a loop that starts a step only while `admit()` is true always
//      halts within a bounded number of steps. The model mirrors the real loop -
//      while the handle admits, run one step (chargeIteration plus an arbitrary
//      non-negative charge) and thread the new handle forward - and asserts the
//      loop stopped well before a hard step ceiling, so a termination bug fails
//      loudly instead of hanging (Req 17.1).
//   2. Single-step overshoot (Req 17.2): every admitted step was applied to a
//      not-yet-stopped budget, so consumption exceeds any cap by at most the one
//      final in-flight step's charge on that dimension.
//   3. Any cap can terminate the loop: when the token, wall-clock, or cost cap is
//      small relative to a positive per-step charge (and the iteration cap is far
//      away), the loop still stops, via that cap, with the matching stop reason
//      (Req 6.3, 8.4, 17.2).
//   4. Determinism: opening and running the same budget with the same charges
//      yields the same admit/stopReason and the same consumption (Req 17.1).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  budgetStopReason,
  makeBudgetCharge,
  makeSessionBudget,
  newUlid,
  openSessionBudget,
  type BudgetCharge,
  type BudgetStopReason,
  type SessionBudget,
  type SessionBudgetHandle,
} from '@app/core';
import { propertyParameters, propertyTag } from '@app/test';

const PROPERTY = propertyTag(18, 'The Session_Budget always terminates the loop');

// -- Bounds -----------------------------------------------------------------
// Small caps keep each generated loop cheap to run at 100+ iterations while still
// forcing every cap to be reachable within a handful of steps.

/** Extra head-room above `maxIterations` before we declare a hang and bail. */
const HARD_STEP_MARGIN = 5;

/** A cap large enough that it will not trip within a targeted run's few steps. */
const FAR_CAP = 1_000_000;

// -- Generators -------------------------------------------------------------

/** Unwrap a validated budget or fail the property loudly (never expected). */
function buildBudget(input: SessionBudget): SessionBudget {
  const result = makeSessionBudget(input);
  if (!result.ok) {
    throw new Error(`generated budget invalid: ${result.error.code}`);
  }
  return result.value;
}

/** Unwrap a validated charge or fail the property loudly (never expected). */
function buildCharge(tokens: number, ms: number, costCents: number): BudgetCharge {
  const result = makeBudgetCharge({ tokens, ms, costCents });
  if (!result.ok) {
    throw new Error(`generated charge invalid: ${result.error.code}`);
  }
  return result.value;
}

/** A non-negative fractional cost amount (finite, never NaN). */
function costArbitrary(min: number, max: number): fc.Arbitrary<number> {
  return fc.double({ min, max, noNaN: true, noDefaultInfinity: true });
}

/** A valid SessionBudget with positive caps and zero consumption. */
const budgetArbitrary: fc.Arbitrary<SessionBudget> = fc
  .record({
    maxIterations: fc.integer({ min: 1, max: 30 }),
    maxTokens: fc.integer({ min: 1, max: 4_000 }),
    maxWallClockMs: fc.integer({ min: 1, max: 60_000 }),
    maxCostCents: costArbitrary(0.01, 100),
  })
  .map((caps) =>
    buildBudget({
      sessionId: newUlid(),
      ...caps,
      consumedIterations: 0,
      consumedTokens: 0,
      consumedMs: 0,
      consumedCostCents: 0,
    }),
  );

/** A single non-negative charge; a per-step unit of work against the budget. */
const chargeArbitrary: fc.Arbitrary<BudgetCharge> = fc
  .record({
    tokens: fc.integer({ min: 0, max: 1_500 }),
    ms: fc.integer({ min: 0, max: 30_000 }),
    costCents: costArbitrary(0, 20),
  })
  .map((c) => buildCharge(c.tokens, c.ms, c.costCents));

/** A non-empty charge sequence; the loop cycles through it, one charge per step. */
const chargesArbitrary: fc.Arbitrary<readonly BudgetCharge[]> = fc.array(chargeArbitrary, {
  minLength: 1,
  maxLength: 8,
});

// -- Loop model -------------------------------------------------------------
// The real loop contract: start a step only while `admit()` is true, and thread
// the returned handle forward. `hardBound` is a safety ceiling well above the
// iteration cap; hitting it means termination failed, so the caller asserts the
// loop ended strictly before it rather than looping forever.

interface LoopOutcome {
  readonly steps: number;
  readonly finalHandle: SessionBudgetHandle;
  /** The charge applied by the final admitted step, or null if none ran. */
  readonly lastCharge: BudgetCharge | null;
  /** Whether the budget still had room immediately before the final step. */
  readonly hadRoomBeforeFinalStep: boolean;
  /** True only if the loop hit the safety ceiling (a termination bug). */
  readonly hitHardBound: boolean;
}

/** Run the admit-guarded loop, threading each new handle forward. */
function runLoop(
  start: SessionBudget,
  charges: readonly BudgetCharge[],
  hardBound: number,
): LoopOutcome {
  let handle = openSessionBudget(start);
  let steps = 0;
  let lastCharge: BudgetCharge | null = null;
  let hadRoomBeforeFinalStep = false;

  while (handle.admit()) {
    if (steps >= hardBound) {
      return { steps, finalHandle: handle, lastCharge, hadRoomBeforeFinalStep, hitHardBound: true };
    }
    hadRoomBeforeFinalStep = !handle.isStopped;
    const charge = charges[steps % charges.length];
    if (charge === undefined) {
      throw new Error('charge sequence must be non-empty');
    }
    lastCharge = charge;
    handle = handle.chargeIteration().charge(charge);
    steps += 1;
  }

  return { steps, finalHandle: handle, lastCharge, hadRoomBeforeFinalStep, hitHardBound: false };
}

// -- Targeted (non-iteration cap) generator ---------------------------------
// Force termination through the token, wall-clock, or cost cap by making that cap
// small and its per-step charge positive, while every other cap (including
// iterations) sits far out of reach.

type TargetCap = Extract<BudgetStopReason, 'max-tokens' | 'max-wall-clock' | 'max-cost'>;

interface TargetedRun {
  readonly budget: SessionBudget;
  readonly charge: BudgetCharge;
  readonly cap: TargetCap;
}

/** Build a run whose only reachable cap is `cap`, charged a positive amount each step. */
function targetedRun(cap: TargetCap, smallCap: number, cost: number): TargetedRun {
  const base = {
    sessionId: newUlid(),
    maxIterations: FAR_CAP,
    maxTokens: FAR_CAP,
    maxWallClockMs: FAR_CAP,
    maxCostCents: FAR_CAP,
    consumedIterations: 0,
    consumedTokens: 0,
    consumedMs: 0,
    consumedCostCents: 0,
  };
  if (cap === 'max-tokens') {
    return {
      cap,
      budget: buildBudget({ ...base, maxTokens: smallCap }),
      charge: buildCharge(1, 0, 0),
    };
  }
  if (cap === 'max-wall-clock') {
    return {
      cap,
      budget: buildBudget({ ...base, maxWallClockMs: smallCap }),
      charge: buildCharge(0, 1, 0),
    };
  }
  return {
    cap,
    budget: buildBudget({ ...base, maxCostCents: cost }),
    charge: buildCharge(0, 0, 1),
  };
}

const targetedRunArbitrary: fc.Arbitrary<TargetedRun> = fc
  .record({
    cap: fc.constantFrom<TargetCap>('max-tokens', 'max-wall-clock', 'max-cost'),
    smallCap: fc.integer({ min: 1, max: 25 }),
    cost: costArbitrary(0.5, 25),
  })
  .map(({ cap, smallCap, cost }) => targetedRun(cap, smallCap, cost));

// -- Properties -------------------------------------------------------------

describe(PROPERTY, () => {
  it('always terminates within the iteration cap, stopped with a recorded reason', () => {
    fc.assert(
      fc.property(budgetArbitrary, chargesArbitrary, (start, charges) => {
        const hardBound = start.maxIterations + HARD_STEP_MARGIN;
        const outcome = runLoop(start, charges, hardBound);

        // Termination: the loop ended before the safety ceiling (no hang) and
        // within the iteration cap, since each step charges exactly one iteration.
        expect(outcome.hitHardBound).toBe(false);
        expect(outcome.steps).toBeLessThan(hardBound);
        expect(outcome.steps).toBeLessThanOrEqual(start.maxIterations);

        // On stop, the budget refuses further steps and records a stop reason that
        // agrees with the pure accountant (Req 17.2 recording).
        expect(outcome.finalHandle.admit()).toBe(false);
        expect(outcome.finalHandle.isStopped).toBe(true);
        expect(outcome.finalHandle.stopReason).not.toBeNull();
        expect(outcome.finalHandle.stopReason).toBe(budgetStopReason(outcome.finalHandle.budget));
      }),
      propertyParameters(),
    );
  });

  it('overshoots any cap by at most the single final in-flight step', () => {
    fc.assert(
      fc.property(budgetArbitrary, chargesArbitrary, (start, charges) => {
        const hardBound = start.maxIterations + HARD_STEP_MARGIN;
        const outcome = runLoop(start, charges, hardBound);
        const consumed = outcome.finalHandle.budget;

        if (outcome.steps === 0 || outcome.lastCharge === null) {
          // The budget was already stopped at open: nothing was charged, so it
          // cannot have overshot any cap.
          expect(outcome.finalHandle.isStopped).toBe(true);
          return;
        }

        // Every admitted step (including the final one) ran only while the budget
        // had room, so the overshoot is bounded by that one last step's charge.
        expect(outcome.hadRoomBeforeFinalStep).toBe(true);

        const last = outcome.lastCharge;
        // Iterations increment by one and stop exactly at the cap: never exceeded.
        expect(consumed.consumedIterations).toBeLessThanOrEqual(start.maxIterations);
        // Before the final step each dimension was strictly under its cap, so the
        // final total is at most (cap - 1) + last charge for integer dimensions,
        // and at most cap + last charge for the fractional cost dimension.
        expect(consumed.consumedTokens).toBeLessThanOrEqual(start.maxTokens - 1 + last.tokens);
        expect(consumed.consumedMs).toBeLessThanOrEqual(start.maxWallClockMs - 1 + last.ms);
        expect(consumed.consumedCostCents).toBeLessThanOrEqual(start.maxCostCents + last.costCents);
      }),
      propertyParameters(),
    );
  });

  it('terminates via the token, wall-clock, or cost cap, not only the iteration cap', () => {
    fc.assert(
      fc.property(targetedRunArbitrary, (run) => {
        const hardBound = run.budget.maxIterations + HARD_STEP_MARGIN;
        const outcome = runLoop(run.budget, [run.charge], hardBound);

        // The loop halted, and via the targeted cap - well before the far-off
        // iteration cap could have tripped.
        expect(outcome.hitHardBound).toBe(false);
        expect(outcome.finalHandle.isStopped).toBe(true);
        expect(outcome.finalHandle.stopReason).toBe(run.cap);
        expect(outcome.steps).toBeLessThan(run.budget.maxIterations);
      }),
      propertyParameters(),
    );
  });

  it('is deterministic: same budget and charges yield the same outcome', () => {
    fc.assert(
      fc.property(budgetArbitrary, chargesArbitrary, (start, charges) => {
        const hardBound = start.maxIterations + HARD_STEP_MARGIN;
        const first = runLoop(start, charges, hardBound);
        const second = runLoop(start, charges, hardBound);

        // Opening the same budget twice gives the same guard and reason.
        expect(openSessionBudget(start).admit()).toBe(openSessionBudget(start).admit());
        expect(openSessionBudget(start).stopReason).toBe(openSessionBudget(start).stopReason);

        // Running the identical loop twice gives identical consumption and stop.
        expect(second.steps).toBe(first.steps);
        expect(second.finalHandle.stopReason).toBe(first.finalHandle.stopReason);
        expect(second.finalHandle.budget).toEqual(first.finalHandle.budget);
      }),
      propertyParameters(),
    );
  });
});
