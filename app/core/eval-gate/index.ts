// Ratcheting pass@k eval-gate decision (Property 28, task 19.1).
//
// This module is the single owner of the CI eval-gate rules over the fixed
// benchmark subset the Eval_Harness measures (Reqs 15.4, 15.7, 15.8, 15.9,
// 15.11). It holds three closely related pure rules and no I/O:
//
//   1. The block decision (`decideEvalGate`, Property 28 / Reqs 15.4, 15.7,
//      15.8): the gate blocks the merge iff it is armed AND the measured pass@k
//      is either strictly below `baseline - tolerance` or at/below the absolute
//      `floor`. A pass@k equal to the baseline never blocks; an unarmed gate
//      never blocks on this criterion.
//   2. The ratchet (`ratchetBaseline`, Req 15.9): the recorded baseline is a
//      high-water mark that only ever rises. A measured value above the current
//      baseline raises it; a value at or below it leaves the baseline untouched.
//   3. The one non-ratcheting escape (`lowerBaselineWithReview`, Req 15.9): the
//      baseline may be lowered ONLY through an explicit, reviewed decision. This
//      is a distinct, clearly-flagged function rather than a silent path, and it
//      refuses any call that is not an approved, genuine decrease.
//
// Design shape, mirroring the sibling pure core modules (`budget`, `verdict`):
//
//   - Pure and deterministic. Every function is a total function of its inputs;
//     the property test (task 19.2) states directly over `decideEvalGate` and
//     `ratchetBaseline` with no clock, store, or CI runner in scope.
//   - Validate untrusted numbers at the boundary. pass@k, baseline, tolerance,
//     and floor arrive from an eval report and a config file, so they are
//     untrusted: the `make*` constructors reject NaN, infinities, and
//     out-of-range values via the core `Result`/`DomainError` idiom, and the
//     decision/ratchet functions stay total over already-validated values.
//   - Optionality is explicit in the types. `EvalGate` is a discriminated union
//     over `armed`, so the baseline/tolerance/floor exist only on the armed arm
//     and cannot be read on an unarmed gate.
//   - The "equal to baseline never blocks" guarantee is made structural. An
//     armed gate is constructed only when `floor < baseline` (Req 15.8's absolute
//     floor sits strictly below the ratcheting baseline), so a measured pass@k
//     equal to the baseline is always strictly above the floor and never below
//     `baseline - tolerance` (tolerance is non-negative), and therefore never
//     blocks. Without that invariant a degenerate `floor === baseline` config
//     could block an at-baseline run, contradicting Req 15.4.

import { domainError, type DomainError } from '../models/domain-error.js';
import { err, ok, type Result } from '../models/result.js';

/** Inclusive lower bound of a probability (pass@k, baseline, floor). */
const PROBABILITY_MIN = 0;
/** Inclusive upper bound of a probability (pass@k, baseline, floor). */
const PROBABILITY_MAX = 1;

/**
 * Reject a value that is not a finite number within `[0, 1]`.
 *
 * pass@k, baseline, and floor are all fractions of solved benchmark problems, so
 * each must be a finite probability. Rejecting NaN and infinities here keeps the
 * comparison logic total and free of surprising IEEE-754 outcomes.
 */
function checkProbability(name: string, value: number): DomainError | null {
  if (!Number.isFinite(value) || value < PROBABILITY_MIN || value > PROBABILITY_MAX) {
    return domainError(
      'PROBABILITY_OUT_OF_RANGE',
      `${name} must be a finite number in [${PROBABILITY_MIN}, ${PROBABILITY_MAX}]`,
      name,
    );
  }
  return null;
}

/**
 * A measured pass@k over the benchmark subset: the fraction of problems solved,
 * a finite number in `[0, 1]`. Construct via `makePassAtK`.
 */
export interface PassAtK {
  readonly value: number;
}

/**
 * A recorded ratcheting baseline pass@k: a finite number in `(0, 1]`.
 *
 * The lower bound is exclusive because the gate is armed only after a non-zero
 * baseline is established (Req 15.7); a zero baseline means the gate is unarmed
 * and is represented by `UNARMED_GATE`, not by a baseline of `0`.
 */
export interface EvalBaseline {
  readonly value: number;
}

/**
 * Construct a validated measured pass@k, rejecting NaN, infinities, and values
 * outside `[0, 1]`.
 */
export function makePassAtK(value: number): Result<PassAtK, DomainError> {
  const rangeError = checkProbability('measuredPassAtK', value);
  if (rangeError !== null) {
    return err(rangeError);
  }
  return ok({ value });
}

/**
 * Construct a validated ratcheting baseline, rejecting out-of-range values and a
 * non-positive baseline (an armed gate always has a non-zero baseline, Req 15.7).
 */
export function makeEvalBaseline(value: number): Result<EvalBaseline, DomainError> {
  const rangeError = checkProbability('baseline', value);
  if (rangeError !== null) {
    return err(rangeError);
  }
  if (value <= PROBABILITY_MIN) {
    return err(
      domainError('EVAL_BASELINE_NOT_POSITIVE', 'baseline must be greater than 0', 'baseline'),
    );
  }
  return ok({ value });
}

/** The gate before a non-zero baseline exists: it never blocks (Req 15.7). */
export interface UnarmedGate {
  readonly armed: false;
}

/**
 * The gate once a non-zero baseline is recorded (Req 15.7).
 *
 * Invariants, all enforced by `makeArmedGate`: `baseline` is in `(0, 1]`,
 * `tolerance` is a finite non-negative number, `floor` is in `[0, 1]`, and
 * `floor < baseline` so an at-baseline run is always strictly above the floor.
 */
export interface ArmedGate {
  readonly armed: true;
  readonly baseline: number;
  readonly tolerance: number;
  readonly floor: number;
}

/**
 * The eval gate in exactly one of its two states. Callers narrow on `armed`
 * before reading `baseline`/`tolerance`/`floor`, which exist only when armed.
 */
export type EvalGate = UnarmedGate | ArmedGate;

/** The single unarmed-gate value; frozen because it carries no configuration. */
export const UNARMED_GATE: UnarmedGate = Object.freeze({ armed: false });

/** The parameters needed to arm the gate, validated together by `makeArmedGate`. */
export interface ArmedGateConfig {
  /** The recorded ratcheting baseline pass@k, in `(0, 1]`. */
  readonly baseline: number;
  /** The agreed noise tolerance absorbed below the baseline, a non-negative delta. */
  readonly tolerance: number;
  /** The absolute catastrophic floor, in `[0, 1]` and strictly below the baseline. */
  readonly floor: number;
}

/** Reject a tolerance that is not a finite, non-negative number. */
function checkTolerance(value: number): DomainError | null {
  if (!Number.isFinite(value) || value < 0) {
    return domainError(
      'NEGATIVE_QUANTITY',
      'tolerance must be a non-negative finite number',
      'tolerance',
    );
  }
  return null;
}

/**
 * Construct a validated armed gate, enforcing every gate invariant at the
 * boundary (Reqs 15.7, 15.8): baseline in `(0, 1]`, tolerance finite and
 * non-negative, floor in `[0, 1]`, and `floor < baseline`.
 *
 * The `floor < baseline` check is what makes "a pass@k equal to the baseline
 * never blocks" (Req 15.4) a structural guarantee rather than a runtime accident.
 */
export function makeArmedGate(config: ArmedGateConfig): Result<ArmedGate, DomainError> {
  const baselineResult = makeEvalBaseline(config.baseline);
  if (!baselineResult.ok) {
    return baselineResult;
  }
  const baseline = baselineResult.value.value;
  const toleranceError = checkTolerance(config.tolerance);
  if (toleranceError !== null) {
    return err(toleranceError);
  }
  const floorError = checkProbability('floor', config.floor);
  if (floorError !== null) {
    return err(floorError);
  }
  if (config.floor >= baseline) {
    return err(
      domainError(
        'EVAL_FLOOR_NOT_BELOW_BASELINE',
        'floor must be strictly below the baseline',
        'floor',
      ),
    );
  }
  return ok({ armed: true, baseline, tolerance: config.tolerance, floor: config.floor });
}

/** Why the gate blocked the merge (Reqs 15.4, 15.8). */
export type EvalGateBlockReason = 'below-baseline-minus-tolerance' | 'at-or-below-floor';

/** Why the gate allowed the merge (Reqs 15.4, 15.7). */
export type EvalGateAllowReason = 'unarmed' | 'within-tolerance';

/** The exhaustive set of decision reasons the gate can report. */
export type EvalGateReason = EvalGateBlockReason | EvalGateAllowReason;

/** A block outcome carrying the single reason that tripped the gate. */
export interface EvalGateBlocked {
  readonly blocked: true;
  readonly reason: EvalGateBlockReason;
}

/** An allow outcome carrying the reason the gate did not block. */
export interface EvalGateAllowed {
  readonly blocked: false;
  readonly reason: EvalGateAllowReason;
}

/** The eval-gate decision: block or allow, always with a typed reason. */
export type EvalGateDecision = EvalGateBlocked | EvalGateAllowed;

/**
 * Decide whether the CI eval gate blocks the merge (Property 28).
 *
 * The gate blocks iff it is armed AND (the measured pass@k is at or below the
 * absolute floor OR strictly below `baseline - tolerance`). Guard-clause
 * precedence, top to bottom:
 *   1. An unarmed gate never blocks on this criterion (Req 15.7)       -> allow
 *   2. At or below the absolute floor is a catastrophic state that can
 *      never merge, checked first because it holds regardless of the
 *      baseline (Req 15.8)                                             -> block
 *   3. Strictly below `baseline - tolerance` is a real regression
 *      beyond noise (Req 15.4); equal-to-baseline never reaches here
 *      because `tolerance >= 0` and `floor < baseline`                 -> block
 *   4. Otherwise the run is within tolerance of the baseline           -> allow
 */
export function decideEvalGate(measured: PassAtK, gate: EvalGate): EvalGateDecision {
  if (!gate.armed) {
    return { blocked: false, reason: 'unarmed' };
  }
  if (measured.value <= gate.floor) {
    return { blocked: true, reason: 'at-or-below-floor' };
  }
  if (measured.value < gate.baseline - gate.tolerance) {
    return { blocked: true, reason: 'below-baseline-minus-tolerance' };
  }
  return { blocked: false, reason: 'within-tolerance' };
}

/**
 * Ratchet the recorded baseline against a fresh measurement (Req 15.9).
 *
 * The baseline is a high-water mark: a measured pass@k strictly above the current
 * baseline raises it to the measured value; a value at or below the current
 * baseline leaves it unchanged. This is total and never lowers the baseline, so
 * the recorded high-water mark can only rise through this path. The result stays
 * in `(0, 1]`: the raised value is either the current baseline (already positive)
 * or a strictly larger measured value.
 */
export function ratchetBaseline(current: EvalBaseline, measured: PassAtK): EvalBaseline {
  if (measured.value > current.value) {
    return { value: measured.value };
  }
  return current;
}

/**
 * An explicit, reviewed decision to lower the baseline (Req 15.9).
 *
 * `approved` is the literal `true`, so a caller cannot assemble this record
 * without stating approval, and `reason` records why the high-water mark was
 * lowered. Both are still validated at runtime because they cross a trust
 * boundary (a config edit or an API payload).
 */
export interface ReviewedLowering {
  /** The proposed lower baseline, in `(0, 1]` and strictly below the current one. */
  readonly newBaseline: number;
  /** Explicit reviewed approval; the literal `true` blocks a silent lowering path. */
  readonly approved: true;
  /** A non-empty human-readable justification recorded with the decision. */
  readonly reason: string;
}

/**
 * Lower the baseline through the one sanctioned non-ratcheting path (Req 15.9).
 *
 * This is deliberately separate from `ratchetBaseline` so the baseline can never
 * silently drift down. It refuses any call that is not an approved, genuine
 * decrease: approval must be present, the reason must be non-empty, the proposed
 * value must be a valid baseline, and it must be strictly below the current one
 * (a raise must go through `ratchetBaseline`, never through review).
 */
export function lowerBaselineWithReview(
  current: EvalBaseline,
  lowering: ReviewedLowering,
): Result<EvalBaseline, DomainError> {
  if (lowering.approved !== true) {
    return err(
      domainError(
        'EVAL_LOWERING_NOT_APPROVED',
        'lowering the baseline requires an explicit reviewed approval',
        'approved',
      ),
    );
  }
  if (lowering.reason.trim().length === 0) {
    return err(domainError('EMPTY_FIELD', 'a reviewed lowering must record a reason', 'reason'));
  }
  const target = makeEvalBaseline(lowering.newBaseline);
  if (!target.ok) {
    return target;
  }
  if (target.value.value >= current.value) {
    return err(
      domainError(
        'EVAL_LOWERING_NOT_A_DECREASE',
        'a reviewed lowering must set a baseline strictly below the current one',
        'newBaseline',
      ),
    );
  }
  return target;
}
