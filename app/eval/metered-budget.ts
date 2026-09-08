// The metered Session_Budget the Eval_Harness threads through one eval sample.
//
// Every eval sample IS a student session (Req 15.2, 15.6, 17.3): it must run under
// the exact same iteration/token/wall-clock/cost caps a real student gets, never a
// looser set. This handle enforces that by wrapping an immutable core
// `SessionBudget` (built from the shared student caps) and doing all accounting
// through the core `app/core/budget` functions - so there is exactly one budget
// accounting implementation in the codebase and the eval layer never re-invents it.
//
// It implements the model-router `SessionBudgetHandle` port so the Verification_Loop
// (and the Generation/Testbench agents beneath it) charge it exactly as they would
// a student's budget. On top of that port it exposes a read-only `consumed()`
// snapshot, which is how the harness measures per-session cost (Req 15.2): the
// model-router port intentionally does not expose consumption, so the harness owns
// this thin measuring wrapper rather than reading budget internals from elsewhere.
//
// WHY THE TOKEN SPLIT IS ACCUMULATED HERE AND THE TOTAL IS NOT
//   The core budget caps the TOTAL, so `consumedTokens` is core's number and is read
//   straight out of it. The prompt/completion breakdown caps nothing, so putting it in
//   core would add state no cap consults; it is measurement, and this is the measuring
//   wrapper. The one number both layers could disagree about - the total - therefore has
//   exactly one owner.
//
//   The breakdown also carries an honesty channel core has no room for: a provider that
//   sends no usable `usage` block has reported NOTHING, and charging that as zero tokens
//   would make a silent provider look like a free one. Those calls are counted, not
//   summed, so every token figure derived from here is a floor whose looseness is stated.

import {
  ZERO_CHARGE,
  budgetStopReason,
  chargeBudget,
  chargeBudgetIteration,
  makeBudgetCharge,
  type BudgetStopReason,
  type SessionBudget,
  type Ulid,
} from '@app/core';
import type { AttemptCost, AttemptTokenUsage, SessionBudgetHandle } from '@app/agent';

/** A read-only view of what one eval sample consumed against its caps. */
export interface BudgetConsumption {
  readonly iterations: number;
  /**
   * Total tokens the core budget accounted, as the providers reported them.
   *
   * A FLOOR when `unreportedUsageCalls` is non-zero: a call whose provider sent no usable
   * `usage` block contributes nothing here, because zero would be a measurement and
   * silence is not.
   */
  readonly tokens: number;
  /** Prompt tokens over the calls that REPORTED a split; a floor, same as `tokens`. */
  readonly promptTokens: number;
  /** Completion tokens over the calls that REPORTED a split; a floor, same as `tokens`. */
  readonly completionTokens: number;
  /**
   * Model calls whose provider reported no usable token usage.
   *
   * The honesty channel for every token number above: non-zero means they are floors of
   * unknown tightness, and a consumer must label them rather than divide them as if
   * complete. A charge that made NO model call - a simulate iteration - is not counted
   * here, because zero tokens is what it genuinely spent.
   */
  readonly unreportedUsageCalls: number;
  readonly wallClockMs: number;
  readonly costCents: number;
}

/**
 * A `SessionBudgetHandle` that measures consumption for one eval sample.
 *
 * Accounting is delegated to the core budget functions so it matches a student
 * session exactly. `charge` counts one iteration and adds the (non-negative,
 * normalized) token/wall-clock/cost deltas, so within `maxIterations` charges the
 * budget is guaranteed to stop - the same termination guarantee the loop relies on
 * in production.
 */
export class MeteredSessionBudget implements SessionBudgetHandle {
  readonly sessionId: Ulid;
  #budget: SessionBudget;
  #promptTokens = 0;
  #completionTokens = 0;
  #unreportedUsageCalls = 0;

  constructor(budget: SessionBudget) {
    this.sessionId = budget.sessionId;
    this.#budget = budget;
  }

  canAfford(): boolean {
    return this.stopReason() === null;
  }

  charge(cost: AttemptCost): BudgetStopReason | null {
    const charged = makeBudgetCharge(normalizeCost(cost));
    // `normalizeCost` already floors and clamps to the non-negative integers/costs
    // `makeBudgetCharge` accepts, so the error branch is unreachable defensive
    // hardening: an unexpectedly malformed cost still counts its iteration (so the
    // loop terminates) but adds no phantom consumption, rather than throwing.
    const delta = charged.ok ? charged.value : ZERO_CHARGE;
    this.#budget = chargeBudget(chargeBudgetIteration(this.#budget), delta);
    this.#accrueTokenUsage(cost.tokenUsage);
    return this.stopReason();
  }

  stopReason(): BudgetStopReason | null {
    return budgetStopReason(this.#budget);
  }

  /** The consumption accrued so far; the harness reads cost from here (Req 15.2). */
  consumed(): BudgetConsumption {
    return {
      iterations: this.#budget.consumedIterations,
      tokens: this.#budget.consumedTokens,
      promptTokens: this.#promptTokens,
      completionTokens: this.#completionTokens,
      unreportedUsageCalls: this.#unreportedUsageCalls,
      wallClockMs: this.#budget.consumedMs,
      costCents: this.#budget.consumedCostCents,
    };
  }

  /**
   * Accrue one charge's prompt/completion split, or count it as unreported.
   *
   * The prompt/completion breakdown is NOT part of the core budget's cap accounting -
   * the caps are on the total - so this is the eval layer's own measurement, kept beside
   * the core accountant rather than duplicated inside it. The total still comes from
   * core, so the two can never disagree about how many tokens were spent.
   *
   * ABSENT means this charge made no model call (a simulate iteration), which genuinely
   * spent zero tokens and is therefore neither summed nor flagged. `unreported` means a
   * model call whose provider said nothing, which is flagged so the sums above are known
   * to be floors instead of quietly reading as free.
   */
  #accrueTokenUsage(usage: AttemptTokenUsage | undefined): void {
    if (usage === undefined) {
      return;
    }
    if (usage.kind === 'unreported') {
      this.#unreportedUsageCalls += 1;
      return;
    }
    this.#promptTokens += nonNegativeInt(usage.promptTokens);
    this.#completionTokens += nonNegativeInt(usage.completionTokens);
  }
}

/**
 * Floor an externally supplied count to a non-negative integer.
 *
 * The counts originate in an untrusted provider reply. The reply parser already rejects a
 * negative or non-finite one, but this handle is a PORT implementation any caller may
 * charge, so it normalizes rather than trusting its caller - the same reasoning as
 * `normalizeCost` below.
 */
function nonNegativeInt(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Normalize an `AttemptCost` into the shape `makeBudgetCharge` accepts: token and
 * wall-clock deltas are floored to non-negative integers and cost is clamped to a
 * non-negative number. This keeps charging total over any in-range cost the loop
 * reports without ever rejecting a legitimate (possibly zero) charge.
 */
function normalizeCost(cost: AttemptCost): { tokens: number; ms: number; costCents: number } {
  return {
    tokens: Math.max(0, Math.floor(cost.tokens)),
    ms: Math.max(0, Math.floor(cost.wallClockMs)),
    costCents: Math.max(0, cost.costCents),
  };
}
