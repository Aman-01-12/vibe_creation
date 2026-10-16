// Spec_Agent (S1) data shapes: the untrusted draft the model (or a student edit)
// produces, the deterministic validation issues, and the presentation states of
// the approve/edit cycle (Req 5.1-5.4, 5.8, 5.9).
//
// The draft types are deliberately looser than the core `Spec` cluster: a
// `PortDraft.direction` and an `AcceptanceCriterionDraft.method` are plain strings
// because they arrive from untrusted model output and must be validated before
// they can be narrowed to the closed core unions (`PortDirection`,
// `AcceptanceMethod`). Nothing here is trusted until `validateSpecDraft` (see
// validation.ts) turns a draft into the core `Spec`.

import type { Spec, Ulid } from '@app/core';

import type { ModelRouterFailure } from '../../model-router/index.js';

/** An untrusted single-port declaration, before width/direction validation. */
export interface PortDraft {
  readonly name: string;
  /** Untrusted; validated against the core `PortDirection` union. */
  readonly direction: string;
  readonly width: number;
}

/** An untrusted clock/reset contract declaration. */
export interface ClockingDraft {
  readonly clockName: string | null;
  readonly resetName: string | null;
  readonly resetActiveLow: boolean;
}

/** An untrusted module interface declaration. */
export interface ModuleInterfaceDraft {
  readonly moduleName: string;
  readonly ports: readonly PortDraft[];
  readonly clocking: ClockingDraft;
}

/**
 * An untrusted single output port's timing declaration, before `PortTiming`
 * validation.
 */
export interface TimingContractEntryDraft {
  readonly portName: string;
  /** Untrusted; validated against the core `PortTiming` set by membership. */
  readonly timing: string;
}

/** An untrusted acceptance-criterion declaration, before the measurability check. */
export interface AcceptanceCriterionDraft {
  readonly text: string;
  /** The Spec_Agent's own claim that the criterion is measurable. */
  readonly measurable: boolean;
  /** Untrusted; validated against the rigorous `AcceptanceMethod` set. */
  readonly method: string;
}

/**
 * The untrusted Spec content the model emits or a student edit produces.
 *
 * This is the single structure the approve/edit cycle operates on: producing,
 * editing, and approving all validate a `SpecDraft` through the same deterministic
 * path, so the positive-width and measurability gates cannot be bypassed.
 */
export interface SpecDraft {
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly moduleInterface: ModuleInterfaceDraft;
  /**
   * The possibly-partial Timing_Contract entries proposed so far (Req 6.4, 6.7).
   *
   * Deliberately a plain list here, not the core `TimingContract`: an approved
   * `Spec` always carries a total contract (`makeTimingContract` enforces that),
   * so the gap between "entries proposed" and "every output port covered" is a
   * draft-stage fact, representable only before that constructor runs.
   */
  readonly timingContractEntries: readonly TimingContractEntryDraft[];
  readonly acceptanceCriteria: readonly AcceptanceCriterionDraft[];
  readonly architecture: string;
}

/**
 * A partial patch a student applies to a presented draft before approval (Req 5.8).
 *
 * Only the provided fields are overwritten; omitted fields keep their current
 * value, so an edit that touches one field never silently drops the rest.
 */
export interface SpecEdit {
  readonly goal?: string;
  readonly constraints?: readonly string[];
  readonly moduleInterface?: ModuleInterfaceDraft;
  readonly timingContractEntries?: readonly TimingContractEntryDraft[];
  readonly acceptanceCriteria?: readonly AcceptanceCriterionDraft[];
  readonly architecture?: string;
}

/**
 * One rejected interface signal (Req 5.3, 5.9).
 *
 * `signalName` names the offending signal so the student can locate it; it falls
 * back to a positional label when the declared name is itself empty.
 */
export interface SignalValidationIssue {
  readonly signalName: string;
  /** The violated rule, e.g. a non-positive width or an unknown direction. */
  readonly reason: string;
  /** The concrete correction requested of the student, e.g. a positive width. */
  readonly request: string;
}

/**
 * One flagged acceptance criterion that is not verifiable by a rigorous method
 * (Req 5.4), carried with the measurable-replacement request.
 */
export interface UnmeasurableCriterionFlag {
  readonly criterionText: string;
  readonly reason: string;
  /** The request for a measurable replacement (Req 5.4). */
  readonly replacementRequest: string;
}

/** The aggregate deterministic validation failure that blocks approval. */
export interface SpecValidationError {
  readonly code: 'SPEC_NOT_APPROVABLE';
  readonly signalIssues: readonly SignalValidationIssue[];
  readonly unmeasurableCriteria: readonly UnmeasurableCriterionFlag[];
}

/** Why spec production could not yield a draft to validate. */
export type SpecProductionFailureReason = 'model-call-failed' | 'unparseable-output';

/** A model-side failure that prevented producing a draft (fail safe, Req 12.5). */
export interface SpecProductionFailure {
  readonly reason: SpecProductionFailureReason;
  /** A short, non-sensitive explanation; never a secret, host, or stack trace. */
  readonly detail: string;
  /** The redacted router failure, when the cause was the Model_Router. */
  readonly routerFailure?: ModelRouterFailure;
}

/**
 * The identity and revision of a Spec as it moves through the approve/edit cycle.
 *
 * `specId` is stable across edits so re-presentations refer to the same Spec;
 * `version` increments on each edit so a re-presented Spec is distinguishable from
 * the one it replaced.
 */
export interface SpecRevisionContext {
  readonly sessionId: Ulid;
  readonly projectId: Ulid;
  readonly specId: Ulid;
  readonly version: number;
}

/** A validated Spec awaiting explicit student approval (not yet approved). */
export interface AwaitingApproval {
  readonly status: 'awaiting-approval';
  /** The validated, unapproved Spec presented to the student. */
  readonly spec: Spec;
  /** The draft the Spec was validated from; the source for any further edit. */
  readonly draft: SpecDraft;
  readonly context: SpecRevisionContext;
}

/** A draft that failed validation and must be revised before it can be approved. */
export interface NeedsRevision {
  readonly status: 'needs-revision';
  readonly issues: SpecValidationError;
  /** The rejected draft, so a student edit can be applied on top of it. */
  readonly draft: SpecDraft;
  readonly context: SpecRevisionContext;
}

/** Spec production failed before a draft existed (model unavailable / malformed). */
export interface ProductionFailed {
  readonly status: 'production-failed';
  readonly failure: SpecProductionFailure;
}

/**
 * The outcome of presenting a Spec for approval.
 *
 * The Spec is never `approved` in any of these states: approval is a separate,
 * explicit step (`SpecAgent.approveSpec`) that re-runs the same validation, so a
 * draft can only reach `approved: true` once every signal is positive-width and
 * every acceptance criterion is measurable (Req 5.5, 5.6 at the Spec level).
 */
export type SpecPresentation = AwaitingApproval | NeedsRevision | ProductionFailed;
