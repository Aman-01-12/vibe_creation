// The Session_Budget: the shared cap object threaded through every model and
// tool call in one loop run.
//
// This module defines the immutable budget record and its construction-time
// invariants only. The accounting behavior (consuming iterations, tokens, time,
// and cost, signalling a stop reason when a cap is reached, and the "overshoot a
// cap by at most one in-flight step" rule) lives in `app/core/budget` (task 8.1)
// and is deliberately absent here, so this type stays a plain validated record
// with no owned mutable state.
//
// Construction-time invariants: the `sessionId` is a valid ULID and every cap
// and consumption count is a non-negative number (counts are also integers).
// A `consumed <= max` relationship is intentionally NOT enforced here: whether a
// budget is exhausted is a runtime accounting judgement (task 8.1), which is also
// where the single-step overshoot allowance is defined.

import { domainError, type DomainError } from './domain-error.js';
import { isUlid, type Ulid } from './identifier.js';
import { err, ok, type Result } from './result.js';

/**
 * The hard caps and running consumption for one loop run.
 *
 * The `max*` fields bound agentic work; the `consumed*` fields record progress
 * against those caps. A result's trust tier is never derived from this object;
 * the budget only bounds how much work a run may perform.
 */
export interface SessionBudget {
  readonly sessionId: Ulid;
  readonly maxIterations: number;
  readonly maxTokens: number;
  readonly maxWallClockMs: number;
  readonly maxCostCents: number;
  readonly consumedIterations: number;
  readonly consumedTokens: number;
  readonly consumedMs: number;
  readonly consumedCostCents: number;
}

/** Fields a caller supplies to build a `SessionBudget`. */
type SessionBudgetInput = SessionBudget;

/** A numeric field to validate: a non-negative amount, optionally an integer. */
interface NumericField {
  readonly name: string;
  readonly value: number;
  readonly integer: boolean;
}

/** Enumerate the numeric fields with their non-negativity and integer rules. */
function numericFields(input: SessionBudgetInput): readonly NumericField[] {
  return [
    { name: 'maxIterations', value: input.maxIterations, integer: true },
    { name: 'maxTokens', value: input.maxTokens, integer: true },
    { name: 'maxWallClockMs', value: input.maxWallClockMs, integer: true },
    { name: 'maxCostCents', value: input.maxCostCents, integer: false },
    { name: 'consumedIterations', value: input.consumedIterations, integer: true },
    { name: 'consumedTokens', value: input.consumedTokens, integer: true },
    { name: 'consumedMs', value: input.consumedMs, integer: true },
    { name: 'consumedCostCents', value: input.consumedCostCents, integer: false },
  ];
}

/** Return a `NEGATIVE_QUANTITY` error when a field breaks its non-negativity rule. */
function checkNumericField(field: NumericField): DomainError | null {
  if (field.integer) {
    if (!Number.isInteger(field.value) || field.value < 0) {
      return domainError(
        'NEGATIVE_QUANTITY',
        `${field.name} must be a non-negative integer`,
        field.name,
      );
    }
    return null;
  }
  if (field.value < 0) {
    return domainError('NEGATIVE_QUANTITY', `${field.name} must not be negative`, field.name);
  }
  return null;
}

/** Reconstruct the budget record from validated fields. */
function buildSessionBudget(input: SessionBudgetInput): SessionBudget {
  return {
    sessionId: input.sessionId,
    maxIterations: input.maxIterations,
    maxTokens: input.maxTokens,
    maxWallClockMs: input.maxWallClockMs,
    maxCostCents: input.maxCostCents,
    consumedIterations: input.consumedIterations,
    consumedTokens: input.consumedTokens,
    consumedMs: input.consumedMs,
    consumedCostCents: input.consumedCostCents,
  };
}

/**
 * Construct a `SessionBudget`, rejecting a non-ULID session id and any negative
 * cap or consumption count (counts must additionally be integers).
 *
 * This is the sole supported constructor; it makes an ill-formed budget record
 * unrepresentable through normal construction. It performs no accounting: see
 * `app/core/budget` (task 8.1) for cap-reached detection and stop reasons.
 */
export function makeSessionBudget(input: SessionBudgetInput): Result<SessionBudget, DomainError> {
  if (!isUlid(input.sessionId)) {
    return err(domainError('INVALID_ULID', 'sessionId must be a valid ULID', 'sessionId'));
  }
  for (const field of numericFields(input)) {
    const fieldError = checkNumericField(field);
    if (fieldError !== null) {
      return err(fieldError);
    }
  }
  return ok(buildSessionBudget(input));
}
