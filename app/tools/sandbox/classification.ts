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
  const completed = !capture.timedOut && !capture.infraFailure && captureComplete;
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
  };
}

/**
 * Classify a raw capture into a `SandboxResult` (capture-all-or-error).
 *
 * `error` when the run timed out, the runtime failed, or a required output is
 * missing; otherwise `pass`/`fail` from the process exit. Stream fields default
 * to empty strings only when they were not required (a required-but-missing
 * stream already forced `error`).
 */
export function classifyCapture(job: SandboxJob, capture: RawRunCapture): SandboxResult {
  const verdict = classifyVerdict(toInvocationOutcome(job, capture));
  return {
    verdict,
    exitCode: capture.exitCode,
    stdout: capture.stdout ?? '',
    stderr: capture.stderr ?? '',
    artifacts: capture.artifacts,
    deniedOperations: capture.deniedOperations,
    resourceUsage: capture.resourceUsage,
  };
}
