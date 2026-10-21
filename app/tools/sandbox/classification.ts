// Capture-all-or-error classification (Property 8, Req 2.4, 2.5, 2.9).
//
// The rule: if the run timed out, the runtime failed to execute it, or any
// required output could not be captured, the WHOLE invocation is `error` rather
// than a partial or functional result. Otherwise the verdict reflects the run.
//
// The `error` verdict and its precedence are not redefined here: this module
// builds an `InvocationOutcome` from the raw capture and delegates to the core
// `classifyVerdict` (`@app/core/verdict`), so the sandbox and the verification
// loop share one definition of what `error` means. The coarse process-exit signal
// used for a completed run reflects the run at the process level; the richer
// per-spec-check classification belongs to the Simulator adapter (task 3.5).

import { classifyVerdict, type InvocationOutcome } from '@app/core';

import type { RawRunCapture, RequiredOutput, SandboxJob, SandboxResult } from './contract.js';

/** True when the given required output is present in the capture. */
function outputCaptured(output: RequiredOutput, capture: RawRunCapture): boolean {
  switch (output) {
    case 'stdout':
      return capture.stdout !== null;
    case 'stderr':
      return capture.stderr !== null;
    case 'exitCode':
      return capture.exitCode !== null;
    case 'vcd':
    case 'netlistJson':
    case 'formalReport':
    case 'formalPrepassReport':
    case 'lintReport':
      return Object.prototype.hasOwnProperty.call(capture.artifacts, output);
    default: {
      // Exhaustiveness: a new RequiredOutput must be handled explicitly.
      const unreachable: never = output;
      return unreachable;
    }
  }
}

/**
 * The required outputs the invocation was supposed to produce but did not.
 *
 * A non-empty result forces the whole invocation to `error` (capture-all-or-error).
 */
export function missingRequiredOutputs(
  required: readonly RequiredOutput[],
  capture: RawRunCapture,
): readonly RequiredOutput[] {
  return required.filter((output) => !outputCaptured(output, capture));
}

/** Map a raw capture to the core invocation outcome used for verdict classification. */
function toInvocationOutcome(job: SandboxJob, capture: RawRunCapture): InvocationOutcome {
  const captureComplete = missingRequiredOutputs(job.requiredOutputs, capture).length === 0;
  const completed =
    !capture.timedOut && !capture.diskLimitExceeded && !capture.infraFailure && captureComplete;
  // A completed run contributes a single coarse process-exit check so the verdict
  // reflects the run; an incomplete run contributes none and classifies as error.
  const checks = completed
    ? [{ name: 'sandbox-process-exit', passed: capture.exitCode === 0 }]
    : [];
  return {
    timedOut: capture.timedOut,
    toolFailure: capture.infraFailure,
    completed,
    checks,
    // The coarse process-exit check above is SYNTHESIZED from the capture, never
    // parsed out of the run's output, so there is no signalling here that could
    // have been unreadable. Reading the testbench's own per-check signalling (and
    // counting what it could not read) belongs to the Simulator adapter.
    unreadableCheckSignals: 0,
    // A disk-cap kill is stated as its own signal, not left to `completed` above.
    // It has to be, because the exit code a killed tool reports is OUR sentinel, so
    // the coarse process-exit check would otherwise turn our own resource decision
    // into a functional `fail` against the design.
    diskLimitExceeded: capture.diskLimitExceeded,
    // Truncation of the captured stdout is carried through even though the coarse
    // process-exit check above is synthesized rather than read from that stream.
    // The rule belongs to the core classifier, in one place, and an adapter that
    // DOES read stdout (the Simulator) must not be the only layer that respects
    // it: a truncated run reaching `pass` from any entry point is the defect.
    stdoutTruncated: capture.stdoutTruncated,
  };
}

/**
 * Classify a raw capture into a `SandboxResult` (capture-all-or-error).
 *
 * `error` when the run timed out, breached its workspace disk cap, the runtime
 * failed, a required output is missing, or the captured stdout was truncated;
 * otherwise `pass`/`fail` from the process exit. Stream fields default to empty
 * strings only when they were not required (a required-but-missing stream already
 * forced `error`), and the truncation flags are carried through unchanged so a
 * caller can tell a complete capture from a bounded prefix.
 *
 * `timedOut` and `diskLimitExceeded` are carried through for the same reason as the
 * truncation flags and with the same discipline: the verdict stays the single owner
 * of pass/fail/error, and the flags only record WHICH cause produced an `error` a
 * caller could not otherwise recover. A wall-clock kill leaves no exit code, no
 * streams, and zeroed usage to infer from; a disk-cap kill leaves the opposite
 * problem - a plausible-looking exit code and real output that would read as a tool
 * that failed on its own.
 */
export function classifyCapture(job: SandboxJob, capture: RawRunCapture): SandboxResult {
  const verdict = classifyVerdict(toInvocationOutcome(job, capture));
  return {
    verdict,
    timedOut: capture.timedOut,
    exitCode: capture.exitCode,
    stdout: capture.stdout ?? '',
    stderr: capture.stderr ?? '',
    stdoutTruncated: capture.stdoutTruncated,
    stderrTruncated: capture.stderrTruncated,
    diskLimitExceeded: capture.diskLimitExceeded,
    artifacts: capture.artifacts,
    deniedOperations: capture.deniedOperations,
    resourceUsage: capture.resourceUsage,
  };
}
