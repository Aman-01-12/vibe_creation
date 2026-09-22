// The Repair_Hint vocabulary and its one builder (Req 2.1-2.7; task 1.1).
//
// WHY THIS IS ITS OWN FILE, AND WHY IT IS PURE
//   `prompt.ts`'s five interface-conditioned rule builders (`describeStateAnchoring`,
//   `describeTiming`, `describeInputWindow`, `describeStimulusAdequacy`, plus the two
//   unconditional ones) exist to tell the model what to do on a FIRST draft, before
//   anything is known about how it will fail. A Repair_Hint is the opposite kind of
//   fact: it says which rule family a SPECIFIC, MEASURED run actually violated.
//   This module is the one place Req 2.1, 2.2's auditability rests on: `buildRepairHint`
//   is a short, pure, total function whose body can be read in full rather than trusted
//   by convention.
//
// THE ANTI-CIRCULARITY GUARANTEE IS A READING DISCIPLINE, NOT A RUNTIME CHECK
//   `buildRepairHint` reads only `diagnostic`, off the one remaining `RepairTrigger`
//   shape (`precheck-build-failed`). There is no other field a reference value, a
//   diff, or the reference's source could occupy, so the anti-circularity guarantee
//   (Req 2.4, 2.5, 2.6) is provable by reading this function's body once. Testbench-
//   dialect-normalization task 10.3 retired the two positive-control trigger points
//   (`reference-unbuildable`, `failed-reference`) along with them: control-triggered
//   repair no longer exists (task 10.1, 10.2), so `RepairTrigger` now has exactly one
//   member, fired only on a Testbench_Precheck outcome of `testbench-build-failed`.

import type { PrecheckDiagnostic } from './testbench-precheck.js';

/**
 * A build diagnostic, carried verbatim (Req 2.1, 2.2). Fired only on a
 * Testbench_Precheck build failure - our own stub, never the benchmark's
 * reference - so it cannot reveal implementation behaviour.
 */
export interface BuildDiagnosticHint {
  readonly kind: 'build-diagnostic';
  /** The toolchain's own diagnostic text, unmodified. */
  readonly diagnostic: string;
}

/**
 * Structurally incapable of carrying an observed value, a diff, or reference
 * source. Kept as a union of one so a future second hint kind is additive
 * rather than a rewrite of `describeRepairHint`'s signature.
 */
export type RepairHint = BuildDiagnosticHint;

/** The measured fact a Repair_Hint is built from; nothing beyond what this shape holds. */
export type RepairTrigger = { readonly kind: 'precheck-build-failed'; readonly diagnostic: string };

/**
 * Build a Repair_Hint from a measured trigger (pure, total, the single owner of
 * Req 2.1, 2.2).
 *
 * `diagnostic` is the ONLY field this function reads off its input; there is no
 * other field on `RepairTrigger` a reference value or a diff could occupy.
 */
export function buildRepairHint(trigger: RepairTrigger): RepairHint {
  return { kind: 'build-diagnostic', diagnostic: trigger.diagnostic };
}

/**
 * The single owner of how a `PrecheckDiagnostic` reads as text (Req 6.11, 6.12).
 *
 * Used for BOTH the model-facing `BuildDiagnosticHint.diagnostic` text (via the
 * caller building a `RepairTrigger`) and the persisted artifact, so neither can
 * drift from the other - the same discipline `describeRepairHint` already
 * establishes for the hint itself.
 *
 * Pure and total: never throws, and renders a distinct message when nothing was
 * captured (Req 6.5) rather than an empty string.
 */
export function describePrecheckDiagnostic(diagnostic: PrecheckDiagnostic): string {
  if (diagnostic.noDiagnosticCaptured) {
    return 'The Testbench build failed, but the toolchain captured no diagnostic output.';
  }
  const lines: string[] = [];
  if (diagnostic.firstError !== null) {
    lines.push(diagnostic.firstError);
  } else {
    lines.push('The Testbench build failed, but no diagnostic line named the Testbench file.');
  }
  if (diagnostic.sourceLine !== null) {
    lines.push(`Testbench line ${diagnostic.sourceLine.lineNumber}: ${diagnostic.sourceLine.text}`);
  }
  if (diagnostic.dialectClasses.length > 0) {
    lines.push(`Detected dialect issue: ${diagnostic.dialectClasses.join(', ')}`);
  }
  return lines.join('\n');
}
