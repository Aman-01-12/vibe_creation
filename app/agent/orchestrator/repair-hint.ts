// The Repair_Hint vocabulary and its one builder (Req 2.1-2.7; task 1.1).
//
// WHY THIS IS ITS OWN FILE, AND WHY IT IS PURE
//   `prompt.ts`'s five interface-conditioned rule builders (`describeStateAnchoring`,
//   `describeTiming`, `describeInputWindow`, `describeStimulusAdequacy`, plus the two
//   unconditional ones) exist to tell the model what to do on a FIRST draft, before
//   anything is known about how it will fail. A Repair_Hint is the opposite kind of
//   fact: it says which rule family a SPECIFIC, MEASURED run actually violated.
//   Reusing the rule-prose builders as literal hint text would require re-auditing
//   every clause by hand against Req 2.4-2.6 every time `prompt.ts`'s wording
//   changes, with nothing in the type system forcing that re-audit. This module is
//   the one place Req 2.1-2.6's auditability rests on: a closed, enumerable
//   `DefectClass` is auditable by inspecting a fixed list once, and `buildRepairHint`
//   is a five-line, pure, total function whose body can be read in full rather than
//   trusted by convention.
//
// THE ANTI-CIRCULARITY GUARANTEE IS A READING DISCIPLINE, NOT A RUNTIME CHECK
//   `buildRepairHint` reads only `diagnostic` (for a `precheck-build-failed` or
//   `reference-unbuildable` trigger) or `failingCheckName` / `ruleFamily` (for a
//   `failed-reference` trigger). There is no third field on `RepairTrigger` a
//   reference value, a diff, or the reference's source could occupy, so the
//   anti-circularity guarantee (Req 2.4, 2.5, 2.6) is provable by reading this
//   function's body once, rather than by auditing every call site that constructs
//   a trigger. Callers are responsible for never constructing a `RepairTrigger`
//   whose `diagnostic`, `failingCheckName`, or `ruleFamily` field itself carries a
//   reference-derived value - see `app/eval/testbench-repair.ts` (task 8.2) and
//   `verification-loop.ts`'s precheck-path wiring (task 6.4) for where each
//   trigger is actually constructed, and design.md Component 2 for the traced data
//   flow proving neither call site reads the reference's observed output.
//
// `ruleFamilyFor` (task 1.2) IS THE DERIVATION, NOT A SECOND READING OF TOOL OUTPUT
//   Its two parameters are a `RequiredCheck` (Spec-derived, from `coverage.ts`) and
//   a `ModuleInterface` (Spec-derived, from `spec.ts`) - the same two Spec-owned
//   facts `prompt.ts` already had when it decided which first-draft rule applied.
//   It imports `prompt.ts`'s own `declaresVectorDataPort`, `timingQualifierNames`,
//   and `inputQualifierNames` rather than re-implementing them, so the two modules
//   cannot silently drift onto two different readings of the same interface.

import type { ModuleInterface } from '@app/core';

import {
  declaresVectorDataPort,
  inputQualifierNames,
  timingQualifierNames,
} from '../roles/testbench/prompt.js';
import type { RequiredCheck } from '../roles/testbench/types.js';

/**
 * The closed, non-exhaustive-but-stated vocabulary a classified Repair_Hint's
 * defect class is drawn from (Req 2.7). One member per existing `prompt.ts` rule
 * family, plus a residual member for a failure neither the compiler-diagnostic
 * path nor this vocabulary can explain.
 *
 * Never conditional prose: `prompt.ts`'s rule-describing functions build
 * interface-specific text for a FIRST draft; this enum names which rule FAMILY a
 * measured run violated, and is exhaustively checkable against Req 2.4-2.6 by
 * reading this list once.
 */
export type DefectClass =
  | 'state-anchoring' // re-anchored to an unreachable state (describeStateAnchoring)
  | 'concurrency' // stepped a shadow implementation instead of observing (CONCURRENCY_RULE)
  | 'timing' // assumed an output latency/cycle the Spec never stated (describeTiming)
  | 'input-window' // assumed which driven inputs form one result (describeInputWindow)
  | 'stimulus-adequacy' // did not reach a value distinguishing right from wrong (describeStimulusAdequacy)
  | 'unclassified'; // a functional failure this vocabulary cannot name

/**
 * A build diagnostic, carried verbatim (Req 2.1, 2.2). Used for BOTH a
 * Testbench_Precheck build failure and a Positive_Control build failure
 * (`TESTBENCH_REFERENCE_UNBUILDABLE`) - both are build failures against files
 * this process itself submitted (our own stub, or the benchmark's reference),
 * and neither reveals implementation behaviour.
 */
export interface BuildDiagnosticHint {
  readonly kind: 'build-diagnostic';
  /** The toolchain's own diagnostic text, unmodified. */
  readonly diagnostic: string;
}

/**
 * A classified functional failure (Req 2.3). Used ONLY for
 * `TESTBENCH_FAILED_REFERENCE`. Carries the failing check's name and ONE
 * `DefectClass` - never the reference's observed value, never a diff, never the
 * reference's source (Req 2.4, 2.5, 2.6).
 */
export interface ClassifiedFunctionalHint {
  readonly kind: 'classified-functional';
  /** The spec-derived check name that failed; computed by this process, never tool text. */
  readonly failingCheckName: string;
  readonly defectClass: DefectClass;
}

/** Structurally incapable of carrying an observed value, a diff, or reference source. */
export type RepairHint = BuildDiagnosticHint | ClassifiedFunctionalHint;

/** The measured fact a Repair_Hint is built from; nothing beyond what this shape holds. */
export type RepairTrigger =
  | { readonly kind: 'precheck-build-failed'; readonly diagnostic: string }
  | { readonly kind: 'reference-unbuildable'; readonly diagnostic: string }
  | {
      readonly kind: 'failed-reference';
      readonly failingCheckName: string;
      readonly ruleFamily: DefectClass;
    };

/**
 * Build a Repair_Hint from a measured trigger (pure, total, the single owner of
 * Req 2.1-2.6).
 *
 * `diagnostic` and `ruleFamily` are the ONLY two fields this function reads off
 * its input; there is no third field on `RepairTrigger` a reference value or a
 * diff could occupy, so the anti-circularity guarantee is provable by reading
 * this function's five-line body rather than by auditing every call site.
 */
export function buildRepairHint(trigger: RepairTrigger): RepairHint {
  if (trigger.kind === 'failed-reference') {
    return {
      kind: 'classified-functional',
      failingCheckName: trigger.failingCheckName,
      defectClass: trigger.ruleFamily,
    };
  }
  return { kind: 'build-diagnostic', diagnostic: trigger.diagnostic };
}

/**
 * Map a failed required check to the `DefectClass` its own STRUCTURE implies -
 * never from anything a control run printed.
 *
 * A `known-answer` check (a standard block's reference truth table) has no
 * interface-conditioned rule family of its own in `prompt.ts` and maps to
 * `unclassified` rather than guessing one. A `criterion` check maps by the SAME
 * interface facts `prompt.ts`'s own conditional rules already branch on
 * (`declaresVectorDataPort`, `timingQualifierNames`, `inputQualifierNames`),
 * read again here rather than threaded through, so this function has the
 * identical inputs `prompt.ts` had when it decided which rule applied to this
 * Spec - and nothing else.
 *
 * ponytail: this is a fixed heuristic table over check shape and interface, not
 * a learned or measured one - a `DefectClass` here is the family most likely to
 * explain a failure of that check's shape, given the interface, never a claim
 * that the model's actual mistake is knowable in advance. Ceiling: the table can
 * misclassify any individual failure, and `'unclassified'` is the honest
 * fallback when the interface gives no signal. Upgrade path: once the vault
 * measures which family a given check-shape/interface pairing actually
 * correlates with, revisit this table against that evidence rather than leave
 * it as a first guess.
 */
export function ruleFamilyFor(check: RequiredCheck, moduleInterface: ModuleInterface): DefectClass {
  if (check.kind === 'known-answer') {
    return 'unclassified';
  }
  if (timingQualifierNames(moduleInterface).length > 0) {
    return 'timing';
  }
  if (inputQualifierNames(moduleInterface).length > 0) {
    return 'input-window';
  }
  if (declaresVectorDataPort(moduleInterface)) {
    return 'stimulus-adequacy';
  }
  return 'unclassified';
}
