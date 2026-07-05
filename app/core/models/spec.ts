// The Spec cluster: the approved source of truth that drives generation and
// verification, plus its module interface and acceptance criteria.
//
// Invariant encoded here: a Port's bit width is a positive integer (Req 5.3,
// 5.9). TypeScript cannot express "positive integer" statically, so it is
// enforced by the validating `makePort` constructor, which is the only supported
// way to build a `Port`.

import { domainError, type DomainError } from './domain-error.js';
import type { AcceptanceMethod, PortDirection } from './enums.js';
import type { Ulid } from './identifier.js';
import { err, ok, type Result } from './result.js';

/** A single declared port on the module interface. */
export interface Port {
  readonly name: string;
  readonly direction: PortDirection;
  /** Bit width; a positive integer. Enforced by `makePort` (Req 5.3, 5.9). */
  readonly width: number;
}

/**
 * The clock and reset contract for a module.
 *
 * A purely combinational module has no clock and no reset, expressed as `null`
 * rather than a sentinel width or empty name, so optionality is explicit.
 *
 * Note: the design names this the "clock/reset contract" without fixing its
 * fields; this minimal shape is the decision for this slice and may be extended
 * by a later task without breaking the positive-width invariant above.
 */
export interface ClockingContract {
  /** Clock signal name, or `null` for a combinational module. */
  readonly clockName: string | null;
  /** Reset signal name, or `null` when the module has no reset. */
  readonly resetName: string | null;
  /** Reset polarity; meaningful only when `resetName` is present. */
  readonly resetActiveLow: boolean;
}

/** The declared ports and clocking contract for the single module. */
export interface ModuleInterface {
  readonly moduleName: string;
  readonly ports: readonly Port[];
  readonly clocking: ClockingContract;
}

/** One testable acceptance criterion in the Spec. */
export interface AcceptanceCriterion {
  readonly id: Ulid;
  readonly text: string;
  /** `false` flags the criterion for a measurable replacement (Req 5.4). */
  readonly measurable: boolean;
  readonly method: AcceptanceMethod;
}

/** The approved, structured source of truth produced at S1. */
export interface Spec {
  readonly id: Ulid;
  readonly projectId: Ulid;
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly moduleInterface: ModuleInterface;
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  /** Block-level architecture description. */
  readonly architecture: string;
  /** Generation is blocked until the Student approves (Req 5.5, 5.6). */
  readonly approved: boolean;
  readonly version: number;
}

/** Return whether a value is a positive integer (rejects 0, negatives, NaN). */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * Construct a `Port`, rejecting a non-positive or non-integer bit width and an
 * empty name.
 *
 * This is the sole supported constructor for `Port`; it makes the positive-width
 * invariant (Req 5.3, 5.9) impossible to violate through normal construction.
 */
export function makePort(input: {
  readonly name: string;
  readonly direction: PortDirection;
  readonly width: number;
}): Result<Port, DomainError> {
  if (input.name.trim().length === 0) {
    return err(domainError('EMPTY_FIELD', 'Port name must not be empty', 'name'));
  }
  if (!isPositiveInteger(input.width)) {
    return err(
      domainError(
        'PORT_WIDTH_NOT_POSITIVE_INTEGER',
        'Port width must be a positive integer',
        'width',
      ),
    );
  }
  return ok({ name: input.name, direction: input.direction, width: input.width });
}
