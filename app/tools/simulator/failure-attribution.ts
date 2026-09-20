// Why a simulate run's verdict is `error`, decided once at the seam that knows it
// (design "app/tools/simulator/failure-attribution.ts"; Req 2.1-2.6).
//
// `SandboxResult` already carries `timedOut`, `diskLimitExceeded`, and
// `stdoutTruncated`, but `SimulationVerdict` drops all three and reports a bare
// `error`. That collapse is what let a testbench compile failure read as
// undiagnosable RTL breakage: the toolchain names the failing file in its
// diagnostics, and nothing downstream reads the name. This module is the single
// owner of turning those residual facts into a closed `RunFailureCause`, plus the
// submitted files a build diagnostic named.
//
// THIS MODULE DECIDES NO VERDICT
//
//   `classifyVerdict` (`@app/core`) remains the sole owner of pass/fail/error.
//   `classifyRunFailure` explains an `error` after the fact; it is never consulted
//   to produce one, and adding it must never move a pass/fail decision (Property 1).
//
// MEMBERSHIP, NEVER EXTRACTION
//
//   `attributedFiles` is computed by scanning diagnostic text for a submitted
//   path's BASENAME, then returning the matching entries of the caller's own
//   `submittedPaths` list. The returned strings always come from that list, never
//   from the diagnostic text itself, so a diagnostic can never introduce a path of
//   its own into a persisted record (Property 3). This is a security property, not
//   an implementation detail: `submittedPaths` is trusted (workspace filenames are
//   derived from the Spec's module name, never from model output), while the
//   diagnostic text is untrusted tool/model-adjacent output that must never be
//   trusted to name its own path.
//
// WHY BASENAME COMPARISON
//
//   The toolchain reports the workspace-relative name it was given (for example
//   `adder_8bit_tb.v:49`), not the full submitted path, so comparing full paths
//   would never match. Matching on basename is safe here specifically because
//   `submittedPaths` is small (one run's worth of RTL and testbench files) and
//   trusted, so a basename collision within one run's own file set is not a
//   plausible attack surface.

import type { SandboxResult } from '../sandbox/index.js';

/**
 * The maximum number of diagnostic lines `classifyRunFailure` scans when
 * identifying attributed files.
 *
 * A generated testbench can print without bound (that is exactly what the
 * workspace disk cap exists to stop), so attribution work must be bounded
 * independently of how much diagnostic text a run produced.
 */
export const MAX_ATTRIBUTION_LINES = 256;

/**
 * Why a run's verdict is `error`; `none` for a run that reached a functional
 * verdict (`pass` or `fail`).
 *
 * A closed union rather than a free-text reason, so every consumer (the
 * Verification_Loop's repair decision, the positive control's classification, the
 * Artifact_Sink) is forced by the type checker to handle every cause rather than
 * defaulting on an unrecognised string.
 */
export type RunFailureCause =
  | 'none'
  | 'build-failed' // the toolchain named a submitted file at a source location
  | 'timed-out' // SandboxResult.timedOut
  | 'disk-capped' // SandboxResult.diskLimitExceeded
  | 'output-incomplete' // stdout truncated, or a required output missing
  | 'tool-failed'; // error with no cause we can name

/**
 * The cause, plus the submitted files a build diagnostic named.
 *
 * `attributedFiles` is a SUBSET of the `submittedPaths` the caller passed in,
 * never a value read out of diagnostic text, and is empty whenever `cause` is not
 * `build-failed` (Property 3).
 */
export interface RunFailureAttribution {
  readonly cause: RunFailureCause;
  /** A subset of `submittedPaths`, in submission order; empty unless `build-failed`. */
  readonly attributedFiles: readonly string[];
}

/** A `RunFailureAttribution` reporting no failure, for a run that did not error. */
const NO_FAILURE: RunFailureAttribution = { cause: 'none', attributedFiles: [] };

/** Extracts the final path segment, matching how the toolchain names a file. */
function basename(path: string): string {
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return lastSlash === -1 ? path : path.slice(lastSlash + 1);
}

/**
 * The submitted paths whose basename appears at a `<name>:<line>` source location
 * within the first `MAX_ATTRIBUTION_LINES` lines of `diagnostics`.
 *
 * A pure filter of `submittedPaths`: the returned array holds only entries drawn
 * from that list, in submission order, so the diagnostic text can never introduce
 * a path (Property 3). Line-anchored rather than substring-matched, because a
 * bare substring test would match a basename that merely appears in prose (a
 * `$display` banner naming the design under test) with no source-location claim
 * behind it.
 */
function attributedFilesIn(diagnostics: string, submittedPaths: readonly string[]): string[] {
  const lines = diagnostics.split('\n').slice(0, MAX_ATTRIBUTION_LINES);
  const attributed: string[] = [];
  for (const path of submittedPaths) {
    const sourceLocation = `${basename(path)}:`;
    const namesThisPath = lines.some((line) => line.includes(sourceLocation));
    if (namesThisPath) {
      attributed.push(path);
    }
  }
  return attributed;
}

/**
 * Classify why a run's verdict is `error`, and identify the submitted files a
 * build diagnostic named.
 *
 * Ranking, in order (Property 2 pins the first two ranking above everything else):
 *
 * 1. `result.timedOut` -> `timed-out`.
 * 2. `result.diskLimitExceeded` -> `disk-capped`.
 * 3. `result.verdict !== 'error'` -> `none`.
 * 4. `result.stdoutTruncated` -> `output-incomplete`.
 * 5. the run's diagnostics name at least one `submittedPaths` entry at a source
 *    location -> `build-failed`, with those files.
 * 6. otherwise -> `tool-failed`.
 *
 * Resource-bound kills rank first because their residue (a sentinel exit code, a
 * stderr line that reads like a build failure) is plausible enough to be
 * misread as a design defect, which is exactly the misclassification this
 * function exists to prevent - so a kill's cause is read from the sandbox's own
 * flags and never from exit codes or stream text.
 *
 * Pure: no filesystem, no clock, no process. `result.stderr` is the diagnostic
 * text scanned for attribution; nothing else on `result` is read for that purpose.
 */
export function classifyRunFailure(
  result: SandboxResult,
  submittedPaths: readonly string[],
): RunFailureAttribution {
  if (result.timedOut) {
    return { cause: 'timed-out', attributedFiles: [] };
  }
  if (result.diskLimitExceeded) {
    return { cause: 'disk-capped', attributedFiles: [] };
  }
  if (result.verdict !== 'error') {
    return NO_FAILURE;
  }
  if (result.stdoutTruncated) {
    return { cause: 'output-incomplete', attributedFiles: [] };
  }
  const attributedFiles = attributedFilesIn(result.stderr, submittedPaths);
  if (attributedFiles.length > 0) {
    return { cause: 'build-failed', attributedFiles };
  }
  return { cause: 'tool-failed', attributedFiles: [] };
}
