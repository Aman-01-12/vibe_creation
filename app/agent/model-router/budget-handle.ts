// The Session_Budget handle threaded through every model call (Req 12.5, 17.1).
//
// The router charges every attempt (success or failure) against this handle and
// checks it before each attempt, so the fallback/retry loop is bounded by the
// budget and always terminates. This module defines the PORT the router programs
// to plus a self-contained in-memory implementation.
//
// Coupling note: the authoritative Session_Budget accountant is being built in
// `app/core/budget` (task 8.1). Its public surface is not final yet, so the router
// depends on this narrow `SessionBudgetHandle` port rather than a concrete core
// accountant. When task 8.1 settles, its accountant should implement this port
// (or a thin shim should adapt it), keeping the coupling to a single interface.
// `InMemorySessionBudgetHandle` is derived from the core `SessionBudget` record so
// the two stay consistent in the meantime.

import type { BudgetStopReason, SessionBudget, Ulid } from '@app/core';

/**
 * How one attempt's TOKEN USAGE is known: reported by the provider, or not reported.
 *
 * Two states rather than a pair of numbers, because a provider that sends no usable
 * `usage` block has told us NOTHING, and zero is a measurement. Collapsing the two
 * would make an arm whose provider stopped reporting usage look like the cheapest arm
 * in the bake-off. The split is carried separately from `AttemptCost.tokens` (the
 * provider's own total, which some hosts report as more than prompt + completion) so
 * neither number is derived from the other.
 */
export type AttemptTokenUsage =
  | {
      readonly kind: 'reported';
      readonly promptTokens: number;
      readonly completionTokens: number;
    }
  | { readonly kind: 'unreported' };

/** The measured cost of one model attempt, charged against the budget. */
export interface AttemptCost {
  readonly tokens: number;
  readonly costCents: number;
  readonly wallClockMs: number;
  /**
   * The provider-reported prompt/completion split, when this attempt CALLED a model.
   *
   * THREE STATES, and the distinction is the point:
   *   - `{ kind: 'reported', ... }` - a model call whose provider sent a usable `usage`
   *     block; the counts are real measurements.
   *   - `{ kind: 'unreported' }` - a model call whose provider sent no usable `usage`
   *     block (absent, malformed, or the call failed outright). NOT zero tokens: an
   *     accumulator must exclude it from its sums and count it, so a total built from
   *     these is known to be a FLOOR.
   *   - ABSENT - this attempt made no model call at all, so there is no provider usage
   *     to speak about. A simulate iteration is the canonical case: it genuinely spends
   *     zero tokens, and that is a measurement, not silence.
   *
   * Optional rather than required because most charges are the third case, and the
   * Model_Router normalizes every model call into one of the first two before charging
   * (see `router.ts`), so absent unambiguously means "not a model call".
   */
  readonly tokenUsage?: AttemptTokenUsage;
}

/**
 * A mutable accounting handle for one session's Session_Budget.
 *
 * The router uses this to bound its fallback/retry loop: `canAfford` gates each
 * attempt and `charge` records the attempt's cost (counting as one iteration), so
 * after at most `maxIterations` charges the budget is exhausted and the loop stops.
 */
export interface SessionBudgetHandle {
  readonly sessionId: Ulid;
  /** Whether the budget can afford another attempt right now. */
  canAfford(): boolean;
  /** Charge one attempt; returns the stop reason if this exhausted a cap, else null. */
  charge(cost: AttemptCost): BudgetStopReason | null;
  /** The stop reason if the budget is already exhausted, else null. */
  stopReason(): BudgetStopReason | null;
}

/**
 * A self-contained `SessionBudgetHandle` backed by an in-memory copy of a core
 * `SessionBudget` record.
 *
 * Each `charge` counts as exactly one iteration and adds the measured tokens,
 * cost, and wall-clock, so the loop is bounded by `maxIterations` even if a caller
 * reports zero token/cost usage. This is the stopgap accountant until the core
 * budget module (task 8.1) exposes a handle implementing this same port.
 */
export class InMemorySessionBudgetHandle implements SessionBudgetHandle {
  readonly sessionId: Ulid;
  readonly #maxIterations: number;
  readonly #maxTokens: number;
  readonly #maxWallClockMs: number;
  readonly #maxCostCents: number;
  #consumedIterations: number;
  #consumedTokens: number;
  #consumedMs: number;
  #consumedCostCents: number;

  constructor(budget: SessionBudget) {
    this.sessionId = budget.sessionId;
    this.#maxIterations = budget.maxIterations;
    this.#maxTokens = budget.maxTokens;
    this.#maxWallClockMs = budget.maxWallClockMs;
    this.#maxCostCents = budget.maxCostCents;
    this.#consumedIterations = budget.consumedIterations;
    this.#consumedTokens = budget.consumedTokens;
    this.#consumedMs = budget.consumedMs;
    this.#consumedCostCents = budget.consumedCostCents;
  }

  canAfford(): boolean {
    return this.stopReason() === null;
  }

  charge(cost: AttemptCost): BudgetStopReason | null {
    this.#consumedIterations += 1;
    this.#consumedTokens += cost.tokens;
    this.#consumedMs += cost.wallClockMs;
    this.#consumedCostCents += cost.costCents;
    return this.stopReason();
  }

  stopReason(): BudgetStopReason | null {
    if (this.#consumedIterations >= this.#maxIterations) {
      return 'max-iterations';
    }
    if (this.#consumedTokens >= this.#maxTokens) {
      return 'max-tokens';
    }
    if (this.#consumedMs >= this.#maxWallClockMs) {
      return 'max-wall-clock';
    }
    if (this.#consumedCostCents >= this.#maxCostCents) {
      return 'max-cost';
    }
    return null;
  }
}
