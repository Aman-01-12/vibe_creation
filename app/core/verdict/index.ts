// Verdict classification and the pass-integrity rule (Properties 5 and 7).
//
// This module is the single owner of two closely related pure rules:
//
//   1. Classification (Property 7, Req 1.5 / 8.7): map one invocation outcome to
//      exactly one of `pass` / `fail` / `error`. `error` is reserved for tool or
//      infrastructure failure (including a wall-clock timeout) and for a
//      missing/partial run; it is never used for a functional check failure.
//   2. Pass integrity (Property 5, Req 8.10): a `pass` verdict requires every
//      spec-derived testbench check to pass. A merely completed or partially
//      passing run is never `pass`.
//
// `verification.ts` reuses `passIntegrityHolds` so the pass-integrity rule has a
// single definition, never two divergent copies. This module imports only leaf
// types from `../models` (no import of `verification.ts`), so the two files do
// not form an import cycle.

import type { Verdict } from '../models/enums.js';

/** One spec-derived testbench check and whether the run satisfied it. */
export interface CheckResult {
  /** The check name, traceable back to a Spec acceptance criterion. */
  readonly name: string;
  /** Whether the simulation satisfied this check. */
  readonly passed: boolean;
}

/**
 * The structured outcome of one compile-and-simulate invocation.
 *
 * The three boolean signals are orthogonal inputs the Tool_Runner reports;
 * `checks` carries the per-check results captured from a functional run.
 * Classification applies a strict precedence over these fields, so overlapping
 * signals (for example a timed-out run that also reports incomplete capture)
 * still resolve to exactly one verdict.
 */
export interface InvocationOutcome {
  /** The invocation exceeded its wall-clock time limit (Req 8.7). */
  readonly timedOut: boolean;
  /**
   * A tool or infrastructure failure prevented a valid functional run, distinct
   * from a timeout (which has its own signal) and from a functional failure.
   */
  readonly toolFailure: boolean;
  /**
   * The invocation ran to completion with every required output captured.
   *
   * `false` marks a missing or partial run, which classifies as `error` rather
   * than as a functional `fail`.
   */
  readonly completed: boolean;
  /** The spec-derived testbench check results captured from the run. */
  readonly checks: readonly CheckResult[];
}

/**
 * The pass-integrity rule (Req 8.10): a functional run passes only when it has at
 * least one spec-derived check and every one of those checks passed.
 *
 * An empty check set is never a pass, because such a run verified nothing.
 */
export function allSpecChecksPassed(checks: readonly CheckResult[]): boolean {
  return checks.length > 0 && checks.every((check) => check.passed);
}

/**
 * The single source of truth for pass integrity: a `pass` verdict is valid only
 * when all spec-derived checks passed (Req 8.10, Property 5).
 *
 * Any non-`pass` verdict trivially satisfies the rule. `verification.ts` calls
 * this so the rule is defined once for both the classifier and the
 * `VerificationResult` constructor.
 */
export function passIntegrityHolds(verdict: Verdict, allChecksPassed: boolean): boolean {
  return verdict !== 'pass' || allChecksPassed === true;
}

/**
 * Classify one invocation outcome as exactly one verdict (Property 7).
 *
 * Precedence, applied top to bottom via guard clauses:
 *   1. A wall-clock timeout is an infrastructure failure (Req 8.7)      -> error
 *   2. Any other tool or infrastructure failure (Req 1.5)               -> error
 *   3. A missing or partial run captured no usable functional result    -> error
 *   4. A completed run that produced no spec-derived checks verified
 *      nothing, so it can be neither a pass nor a functional fail        -> error
 *   5. Every spec-derived check passed (pass integrity holds)           -> pass
 *   6. At least one spec-derived check failed (a functional failure)    -> fail
 */
export function classifyVerdict(outcome: InvocationOutcome): Verdict {
  if (outcome.timedOut) {
    return 'error';
  }
  if (outcome.toolFailure) {
    return 'error';
  }
  if (!outcome.completed) {
    return 'error';
  }
  if (outcome.checks.length === 0) {
    return 'error';
  }
  return allSpecChecksPassed(outcome.checks) ? 'pass' : 'fail';
}
