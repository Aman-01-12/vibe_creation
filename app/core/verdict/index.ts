// Verdict classification and the pass-integrity rule (Properties 5 and 7).
//
// This module is the single owner of two closely related pure rules:
//
//   1. Classification (Property 7, Req 1.5 / 8.7): map one invocation outcome to
//      exactly one of `pass` / `fail` / `error`. `error` is reserved for tool or
//      infrastructure failure (including a wall-clock timeout or a workspace
//      disk-cap kill), for a missing/partial run, and for a run whose check
//      signalling could not be read at all; it is never used for a functional
//      check failure.
//   2. Pass integrity (Property 5, Req 8.10): a `pass` verdict requires every
//      spec-derived testbench check to pass. A merely completed or partially
//      passing run is never `pass`, and neither is a run whose check EVIDENCE was
//      incomplete - a signal the reader could not parse, or output truncated
//      before the reader saw all of it. Both verified nothing about what could not
//      be read, so ignoring either is how a failing design reads as correct.
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
  /**
   * How many check signals the run emitted that could NOT be read as a
   * `(name, status)` pair.
   *
   * A testbench that tried to signal a check and produced something the reader
   * could not parse verified nothing about that check. The count is carried as a
   * first-class input rather than discarded, because discarding it is exactly how
   * a failing design reads as a pass: drop the unreadable line and the remaining
   * lines are all passes. It is a COUNT and never the offending text, so this
   * value is structurally incapable of carrying a path, a host, or tool output
   * into a verdict, a report, or a persisted span.
   */
  readonly unreadableCheckSignals: number;
  /**
   * Whether a resource bound on WORKSPACE DISK killed the invocation mid-flight.
   *
   * The disk twin of `timedOut`. The Tool_Runner caps how many bytes a run may
   * write into its workspace, because a testbench that dumps a waveform and never
   * reaches `$finish` writes continuously - measured at tens of megabytes per
   * second, which filled a 228 GB disk over one eval campaign. When the cap is
   * reached the tool is killed, so the run stopped part-way through: every check it
   * had not signalled yet is simply absent, and the checks it did signal describe a
   * fraction of the stimulus.
   *
   * Carried as a first-class input rather than folded into `timedOut`, because
   * collapsing the two would leave a caller unable to tell which bound fired and
   * would make the timeout flag untrue. Like `timedOut` it is a BOOLEAN, so it
   * cannot carry a path, a host, or tool output into a verdict.
   */
  readonly diskLimitExceeded: boolean;
  /**
   * Whether the stream the check signalling was read from was TRUNCATED, so the
   * reader saw only a bounded prefix of what the run actually printed.
   *
   * The Tool_Runner caps how many bytes of a child's output it retains, because a
   * testbench whose wait condition never becomes true prints without end and an
   * unbounded capture is a measured out-of-memory vector. A truncated stream is
   * the same epistemic situation as an unreadable check signal, one step earlier:
   * a `CHECK ... FAIL` line may have been among the bytes that were discarded, and
   * nothing in the retained prefix can rule that out. It is carried as a
   * first-class input for the same reason the unreadable count is - dropping it is
   * exactly how a failing design would read as a pass - and it is a BOOLEAN, so it
   * cannot carry discarded tool output into a verdict.
   */
  readonly stdoutTruncated: boolean;
}

/**
 * The pass-integrity rule (Req 8.10): a functional run passes only when it has at
 * least one spec-derived check and every one of those checks passed.
 *
 * An empty check set is never a pass, because such a run verified nothing.
 *
 * DUPLICATE CHECK NAMES. `checks` is the emission-ordered list, so one name may
 * appear many times (a testbench that signals the same check once per stimulus
 * step prints it once per step). Quantifying over every OCCURRENCE rather than
 * over distinct names is what makes this conservative per name: a name passes
 * only when every occurrence of it passed, and any single `FAIL` for a name means
 * that name did not pass, regardless of how many times it also passed. There is
 * deliberately no per-name reduction step (no last-wins, no majority, no
 * de-duplication) that a later `FAIL` could be voted down by.
 */
export function allSpecChecksPassed(checks: readonly CheckResult[]): boolean {
  return checks.length > 0 && checks.every((check) => check.passed);
}

/**
 * The required check names the run never reported at all.
 *
 * A check the testbench was required to signal but that produced NO line is not a
 * pass and not a failure - it is an absence, and treating an absence as a pass
 * would let a testbench that exits early verify nothing and still read as correct.
 * Callers that hold the spec-derived required set use this to refuse a pass whose
 * evidence is incomplete; callers with no required set have nothing to check here.
 *
 * Linear in both inputs (a set membership test per required name), because the
 * reported names come from untrusted simulator output.
 */
export function missingCheckNames(
  checks: readonly CheckResult[],
  requiredNames: readonly string[],
): readonly string[] {
  const reported = new Set(checks.map((check) => check.name));
  return requiredNames.filter((name) => !reported.has(name));
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
 *   2. A workspace disk-cap breach killed the run, which is the same
 *      kind of event as rule 1 - a resource bound we imposed
 *      terminated the run part-way through - so it is ranked with it    -> error
 *   3. Any other tool or infrastructure failure (Req 1.5)               -> error
 *   4. A missing or partial run captured no usable functional result    -> error
 *   5. A completed run that produced no readable spec-derived check
 *      verified nothing, so it can be neither a pass nor a functional
 *      fail                                                             -> error
 *   6. At least one readable spec-derived check failed (a functional
 *      failure). Ranked ABOVE both evidence-incompleteness rules below
 *      because a definite failing check is a stronger and more
 *      actionable fact than missing evidence, and all three are
 *      non-pass either way                                              -> fail
 *   7. The run emitted a check signal that could not be read. Every
 *      readable check passed, but the unreadable one verified nothing,
 *      so this run did not establish that the design is correct         -> error
 *   8. The stream the checks were read from was truncated, so the
 *      reader saw a bounded prefix. Every check it COULD see passed,
 *      but a failing check may have been among the discarded bytes      -> error
 *   9. Every spec-derived check was readable and passed on complete
 *      output (pass integrity holds)                                    -> pass
 *
 * Rules 7 and 8 are the fail-safe direction and neither is optional: a `pass` that
 * ignores an unreadable signal, or one that ignores output it never saw, is
 * precisely the shape of a false `Verified`. `pass` is therefore reachable only
 * when the run's ENTIRE check signalling was readable AND complete.
 *
 * WHY THE DISK-CAP KILL SITS AT RULE 2 AND NOT DOWN WITH TRUNCATION. Both are
 * evidence failures rather than functional ones, so both stay inside the Property 7
 * reservation on `error`; what separates them is whether the run ENDED. Truncation
 * describes a run that finished on its own and simply printed more than was kept, so
 * a `CHECK ... FAIL` in the retained prefix is a real verdict on the whole stimulus
 * and outranks the missing evidence. A disk-cap kill describes a run WE terminated
 * part-way through, exactly as a wall-clock kill does: the stimulus was never
 * finished, so the checks that did print are a verdict on a fraction of it, and
 * calling that a functional `fail` would attribute our own resource decision to the
 * design. Ranking it with rule 1 also keeps one shape for "a resource bound killed
 * this run" instead of two dissimilar ones, and it keeps continuity - a hung
 * waveform-dumping run classified `error` via rule 1 before the cap was enforced,
 * and classifies `error` via rule 2 now that the disk stops it sooner.
 *
 * It is deliberately NOT folded into `timedOut`, which would be untrue - the wall
 * clock did not fire - and would leave a caller unable to tell which bound stopped
 * the run. Nor does rule 2 lean on `completed`: a caller that reports a disk-killed
 * run as `completed` (it may genuinely have captured every required output before
 * the kill) still cannot reach `pass`, because the rule stands on its own signal.
 * That independence is the point of stating the cause rather than inferring it.
 *
 * WHY TRUNCATION SITS AT RULE 8 AND NOT HIGHER. It is deliberately ranked below the
 * functional-fail rule, following the precedent set for unreadable signals: a
 * legible `CHECK ... FAIL` in the retained prefix is a real, actionable failure,
 * and blurring it into `error` would throw away the stronger fact and leave
 * self-healing with nothing to repair. It is also deliberately NOT folded into
 * `completed` (rule 4): `completed` answers "was every REQUIRED OUTPUT captured",
 * and stdout WAS captured - just not all of it - so conflating the two would make
 * the missing-output report untrue. Rule 8 keeps `error` within its Property 7
 * reservation: truncation is an evidence failure, never a functional check failure.
 */
export function classifyVerdict(outcome: InvocationOutcome): Verdict {
  if (outcome.timedOut) {
    return 'error';
  }
  if (outcome.diskLimitExceeded) {
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
  if (!allSpecChecksPassed(outcome.checks)) {
    return 'fail';
  }
  if (outcome.unreadableCheckSignals > 0) {
    return 'error';
  }
  return outcome.stdoutTruncated ? 'error' : 'pass';
}
