// Why a run that was SUPPOSED to pass did not: one rule, two callers.
//
// WHY THIS IS SHARED RATHER THAN WRITTEN TWICE
//   Two places drive a KNOWN-GOOD design through the real toolchain and require a pass,
//   and both must explain a non-pass:
//     - Stage 0 runs a reference against its own GOLDEN testbench (`./stage0.ts`);
//     - the positive control runs a reference against OUR GENERATED testbench
//       (`./rtllm-instrument-control.ts`).
//   The evidence differs (a VCS-style banner versus our `CHECK` signalling) but the
//   inference does not, and it is the inference that is easy to get subtly wrong. Written
//   twice, the two copies would drift in the direction nobody checks - and the whole point
//   of both callers is that a non-pass must be attributable.
//
// THE RULE, STATED ONCE
//   1. The run reported a failure -> it built, it ran, and it disagreed with the design.
//   2. No failure reported, but the toolchain wrote diagnostics -> it never got as far as
//      simulating: a compile or elaboration error.
//   3. No failure reported and no diagnostics -> the run died without saying anything: a
//      timeout, a crash, or an incomplete capture.
//   The distinction between (1) and (2) is the one that matters most, because they point
//   at different defects: (1) is a disagreement about behaviour, (2) is a broken build.
//
// Pure: no clock, no I/O, no randomness.

/** Why a run that should have passed did not. */
export type NonPassCause =
  /** It built, it ran, and it reported a failure: a real disagreement about behaviour. */
  | 'reported-failure'
  /** No failure reported but the toolchain wrote diagnostics: it never simulated. */
  | 'did-not-build'
  /** Neither a failure nor diagnostics: the run produced no outcome at all. */
  | 'produced-nothing';

/** The evidence the cause is inferred from. */
export interface NonPassEvidence {
  /**
   * Whether the run explicitly reported a failing outcome.
   *
   * Each caller derives this in its own vocabulary - a fenced failure banner for the
   * golden testbench, a failing `CHECK` verdict for ours - so this module stays free of
   * either grammar.
   */
  readonly reportedFailure: boolean;
  /** What the toolchain wrote to stderr; read only for emptiness, never interpreted. */
  readonly diagnostics: string;
}

/** Longest diagnostic excerpt a caller should quote; bounds an operator-facing detail. */
export const MAX_DIAGNOSTIC_LINE_CHARS = 240;

/** Classify a non-pass into its cause (pure, total). */
export function classifyNonPass(evidence: NonPassEvidence): NonPassCause {
  if (evidence.reportedFailure) {
    return 'reported-failure';
  }
  return evidence.diagnostics.trim().length > 0 ? 'did-not-build' : 'produced-nothing';
}

/**
 * The first non-empty line of a diagnostic blob, bounded.
 *
 * Tool diagnostics routinely name a sandbox workspace path, so a caller that puts this in
 * an operator-facing detail must be one whose details are already understood to carry tool
 * output (Stage 0's quarantine records are). A caller whose notes must be path-free should
 * write the diagnostics to an artifact file instead and not quote them.
 */
export function firstDiagnosticLine(diagnostics: string): string {
  const line = diagnostics
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return (line ?? '').slice(0, MAX_DIAGNOSTIC_LINE_CHARS);
}
