// Output-capture state generators (task 1.3).
//
// Feed the capture-all-or-error property (Property 8, tasks 3.1/3.3): a sandbox
// invocation captures exit code, stdout, stderr, and its required artifact, and
// the whole invocation must classify as `error` if any required output is
// missing or the wall-clock cap is exceeded. `CaptureState` is a primitive,
// structural fixture shape - deliberately independent of the task 2.1 domain
// types - so this generator does not depend on later modeling work.

import fc from 'fast-check';

/**
 * A structural snapshot of what a sandbox run captured. A `null` field models a
 * missing capture; `requiredArtifactPresent` false models a missing required
 * artifact; `wallClockExceeded` true models a timeout.
 */
export interface CaptureState {
  readonly exitCode: number | null;
  readonly stdout: string | null;
  readonly stderr: string | null;
  readonly requiredArtifactPresent: boolean;
  readonly wallClockExceeded: boolean;
}

/**
 * True when the capture is incomplete: any required output is missing or the
 * wall-clock cap was exceeded. Such a capture must classify as `error`.
 */
export function isIncompleteCapture(state: CaptureState): boolean {
  return (
    state.exitCode === null ||
    state.stdout === null ||
    state.stderr === null ||
    !state.requiredArtifactPresent ||
    state.wallClockExceeded
  );
}

/** A fully captured run: every output present and within the wall-clock cap. */
export function completeCaptureStateArbitrary(): fc.Arbitrary<CaptureState> {
  return fc.record({
    exitCode: fc.integer({ min: 0, max: 255 }),
    stdout: fc.string(),
    stderr: fc.string(),
    requiredArtifactPresent: fc.constant(true),
    wallClockExceeded: fc.constant(false),
  });
}

/** A run that is missing at least one required output or exceeded the wall-clock cap. */
export function partialCaptureStateArbitrary(): fc.Arbitrary<CaptureState> {
  return fc
    .record({
      exitCode: fc.option(fc.integer({ min: 0, max: 255 }), { nil: null }),
      stdout: fc.option(fc.string(), { nil: null }),
      stderr: fc.option(fc.string(), { nil: null }),
      requiredArtifactPresent: fc.boolean(),
      wallClockExceeded: fc.boolean(),
    })
    .filter(isIncompleteCapture);
}

/** Either a complete or a partial capture state. */
export function captureStateArbitrary(): fc.Arbitrary<CaptureState> {
  return fc.oneof(completeCaptureStateArbitrary(), partialCaptureStateArbitrary());
}
