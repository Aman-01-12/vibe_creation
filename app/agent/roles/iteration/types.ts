// Iteration_Agent (S9) data shapes and injected ports: the conversational-change
// request, the demotion + re-verification result surface, the interface-change and
// regression outcomes, and the diff presented with the new verdict (Req 10.1-10.9).
//
// TWO INVARIANTS ARE ENCODED IN THE TYPES / PORTS HERE.
//
// 1. Demotion by ABSENCE of provenance, never a writable flag (Req 10.7, 14.3).
//    Editing a `Verified` module produces a new module version, and a new version
//    has no passing oracle span yet, so the Trust_Labeler labels it `Unverified`
//    automatically. There is deliberately NO `verified` boolean to clear: the
//    edited module's `Unverified` label is derived, and it becomes `Verified` again
//    only when the Verification_Loop records a fresh passing oracle verdict for the
//    changed design.
//
// 2. No orchestrator import cycle. `orchestrator/verification-loop.ts` depends on
//    the roles, so a role must never import back from the orchestrator. The
//    Iteration_Agent therefore drives re-verification through the narrow
//    `IterationReVerifier` port defined HERE (satisfied at the composition root by
//    an adapter over `VerificationLoop.verify`), and applies the requested change
//    to the source of truth through the `IterationSpecUpdater` port. The
//    Iteration_Agent never names an orchestrator type.

import type {
  ArtifactRef,
  FailingCase,
  LabeledArtifact,
  ModuleVersion,
  Result,
  Spec,
  Testbench,
  Ulid,
  UnverifiedArtifact,
  Verdict,
  VerificationResult,
  VerifiedArtifact,
} from '@app/core';
import type { ResourceLimits } from '@app/tools';

import type { SessionBudgetHandle } from '../../model-router/index.js';
import type { IntentSession } from '../intent/index.js';

/**
 * The last `Verified` state a regression can be reverted to (Req 10.4, 10.5).
 *
 * Carried so a regression can OFFER a revert to a concrete, previously verified
 * design; the Iteration_Agent never reverts silently and never mutates this.
 */
export interface LastVerifiedState {
  /** The module version that last held a `Verified` label. */
  readonly moduleVersion: ModuleVersion;
  /** The oracle-bound `Verified` label for that module version. */
  readonly label: VerifiedArtifact;
  /** The spec-derived Testbench the verified verdict was produced against. */
  readonly testbench: Testbench;
  /** The recorded passing verification result that justified the label. */
  readonly result: VerificationResult;
}

/**
 * A student's conversational change request for the current module (Req 10.1).
 *
 * The change is applied to the Spec (the source of truth) via the
 * `IterationSpecUpdater`, and the Verification_Loop then regenerates and re-verifies
 * the RTL from the updated Spec. `edited` is the current label of the module being
 * changed; when its tier is `Verified`, `lastVerified` carries the state a
 * regression may offer to revert to.
 */
export interface IterationRequest {
  readonly sessionId: Ulid;
  readonly projectId: Ulid;
  /** The confirmed intent session; re-verification is gated on it (Req 4.6). */
  readonly intent: IntentSession;
  /** The current approved Spec the change is applied to. */
  readonly currentSpec: Spec;
  /** The current trust label of the module being edited (demoted on edit). */
  readonly edited: LabeledArtifact;
  /** The natural-language change the Student requested. */
  readonly requestedChange: string;
  /** The last `Verified` state for regression/revert, or `null` if none exists. */
  readonly lastVerified: LastVerifiedState | null;
}

/** The request to apply a conversational change to the Spec source of truth. */
export interface SpecChangeRequest {
  /** The current approved Spec to apply the change onto. */
  readonly currentSpec: Spec;
  /** The Student's natural-language change. */
  readonly requestedChange: string;
}

/** Why applying the requested change to the Spec failed (fail safe). */
export interface SpecUpdateFailure {
  readonly reason: 'model-call-failed' | 'unparseable-output' | 'spec-not-approvable';
  /** A short, non-sensitive explanation; never a secret, host, or stack trace. */
  readonly detail: string;
}

/**
 * The port that applies a conversational change to the Spec source of truth.
 *
 * Returns an updated, re-approved Spec at the next version whose `moduleInterface`
 * reflects any interface change the request implies. The Iteration_Agent then
 * DETECTS whether the interface changed by comparing the updated interface to the
 * current one (Req 10.2). The composition root backs this with the Spec_Agent
 * family; it is a port so the Iteration_Agent never calls a provider directly.
 */
export interface IterationSpecUpdater {
  applyChange(
    request: SpecChangeRequest,
    budget: SessionBudgetHandle,
  ): Promise<Result<Spec, SpecUpdateFailure>>;
}

/** The RTL-free inputs re-verification runs over: the confirmed intent and a Spec. */
export interface ReVerifyInput {
  /** The confirmed intent session gating admission to generation. */
  readonly intent: IntentSession;
  /** The Spec to regenerate the candidate and independent Testbench from. */
  readonly spec: Spec;
}

/** Re-verification reached a fresh passing oracle verdict; the module is `Verified`. */
export interface ReVerifyVerified {
  readonly status: 'verified';
  /** The `Verified` label bound to the fresh passing oracle span. */
  readonly label: VerifiedArtifact;
  /** The new module version the change produced. */
  readonly moduleVersion: ModuleVersion;
  /** The spec-derived Testbench the verdict was produced against (Req 10.2, 10.3). */
  readonly testbench: Testbench;
  /** The recorded passing verification result. */
  readonly result: VerificationResult;
}

/** Re-verification did not reach a passing verdict; the module stays `Unverified`. */
export interface ReVerifyUnverified {
  readonly status: 'unverified';
  readonly label: UnverifiedArtifact;
  readonly moduleVersion: ModuleVersion;
  readonly testbench: Testbench;
  readonly result: VerificationResult;
  /** The concrete failing case, or `null` when none was localized. */
  readonly failingCase: FailingCase | null;
}

/** Re-verification could not start: the generation gate refused admission. */
export interface ReVerifyBlocked {
  readonly status: 'blocked';
  /** A short, non-sensitive reason (intent unconfirmed / spec unapproved). */
  readonly reason: string;
}

/** Re-verification could not produce a candidate or independent Testbench (fail safe). */
export interface ReVerifySetupFailed {
  readonly status: 'setup-failed';
  /** A short, non-sensitive reason; never a secret, host, or stack trace. */
  readonly reason: string;
}

/**
 * The result of re-verifying a changed design.
 *
 * This is the narrow surface the Iteration_Agent needs from the Verification_Loop,
 * expressed in role-local terms so the role never imports the orchestrator. The
 * composition root maps the loop's `VerificationOutcome` onto this union.
 */
export type ReVerifyResult =
  ReVerifyVerified | ReVerifyUnverified | ReVerifyBlocked | ReVerifySetupFailed;

/**
 * The re-verification port the Iteration_Agent drives (Req 10.1, 10.3).
 *
 * The composition root implements this over `VerificationLoop.verify`: generation
 * and independent testbench generation run in parallel from `input.spec`, the FULL
 * spec-derived Testbench is re-run, the Simulator verdict is the sole authority, and
 * `Verified` is bound to the recorded passing oracle span. Re-verification therefore
 * runs through the SAME loop the initial build used, never a subset.
 */
export interface IterationReVerifier {
  reVerify(
    input: ReVerifyInput,
    budget: SessionBudgetHandle,
    limits: ResourceLimits,
  ): Promise<ReVerifyResult>;
}

/** A single line of the presented RTL diff (Req 10.6). */
export interface DiffLine {
  /** Whether the line is unchanged context, added by the change, or removed by it. */
  readonly kind: 'context' | 'added' | 'removed';
  /** The line text (without a trailing newline). */
  readonly text: string;
}

/**
 * The diff of a change presented together with its new verdict (Req 10.6).
 *
 * `previousModuleVersionId` is `null` when the edited module had no prior version
 * to diff against (for example an edit to an `Unverified` module with no baseline).
 */
export interface IterationDiff {
  /** The line-level RTL diff from the previous version to the new one. */
  readonly rtlDiff: readonly DiffLine[];
  /** Whether the Module_Interface changed (drives Spec + Testbench regeneration). */
  readonly interfaceChanged: boolean;
  /** The previous module version diffed against, or `null` when there was none. */
  readonly previousModuleVersionId: Ulid | null;
  /** The new module version the change produced. */
  readonly newModuleVersionId: Ulid;
  /** The new oracle verdict for the changed design. */
  readonly verdict: Verdict;
}

/**
 * The offer to revert to the last `Verified` state after a regression (Req 10.4).
 *
 * The Iteration_Agent only OFFERS; it never reverts silently. Acting on the offer
 * (persisting the reverted state under an idempotency key) is the caller's explicit,
 * separate step.
 */
export interface RevertOffer {
  readonly offered: true;
  /** The concrete last `Verified` state the Student may choose to restore. */
  readonly lastVerified: LastVerifiedState;
  /** A short, non-sensitive message describing the offer. */
  readonly message: string;
}

/** The change was re-verified to a fresh passing oracle verdict (Req 10.5, 10.6). */
export interface IterationVerified {
  readonly status: 'verified';
  readonly label: VerifiedArtifact;
  readonly moduleVersion: ModuleVersion;
  readonly testbench: Testbench;
  readonly result: VerificationResult;
  /** The updated approved Spec the change was applied to. */
  readonly updatedSpec: Spec;
  readonly diff: IterationDiff;
}

/**
 * The change made a previously passing module fail: a regression (Req 10.4).
 *
 * Carries the revert offer to the last `Verified` state; the module is left
 * `Unverified` and is never presented as correct (Req 10.5).
 */
export interface IterationRegressed {
  readonly status: 'regressed';
  readonly label: UnverifiedArtifact;
  readonly moduleVersion: ModuleVersion;
  readonly testbench: Testbench;
  readonly result: VerificationResult;
  readonly failingCase: FailingCase | null;
  readonly revertOffer: RevertOffer;
  readonly updatedSpec: Spec;
  readonly diff: IterationDiff;
}

/** The change did not pass and there was no prior `Verified` baseline to revert to. */
export interface IterationUnverified {
  readonly status: 'unverified';
  readonly label: UnverifiedArtifact;
  readonly moduleVersion: ModuleVersion;
  readonly testbench: Testbench;
  readonly result: VerificationResult;
  readonly failingCase: FailingCase | null;
  readonly updatedSpec: Spec;
  readonly diff: IterationDiff;
}

/** Re-verification was blocked because the generation gate refused admission. */
export interface IterationBlocked {
  readonly status: 'blocked';
  /** A short, non-sensitive reason (intent unconfirmed / spec unapproved). */
  readonly reason: string;
}

/** The iteration could not proceed (spec update or re-verification setup failed). */
export interface IterationFailed {
  readonly status: 'failed';
  readonly reason: 'spec-update-failed' | 'reverify-setup-failed';
  /** A short, non-sensitive explanation; never a secret, host, or stack trace. */
  readonly detail: string;
}

/**
 * The terminal result of one conversational iteration.
 *
 * A module is presented as correct only in the `verified` state; `regressed` and
 * `unverified` leave it `Unverified` with a diff and the failing verdict (Req 10.5).
 */
export type IterationOutcome =
  IterationVerified | IterationRegressed | IterationUnverified | IterationBlocked | IterationFailed;

/** Which step of the iteration a progress event reports. */
export type IterationPhase =
  | 'demoting'
  | 'updating-spec'
  | 'regenerating-testbench'
  | 'verifying'
  | 'verified'
  | 'regressed'
  | 'unverified'
  | 'blocked'
  | 'failed';

/**
 * A non-blocking progress event streamed while an iteration runs (Req 10.8, 17.6).
 *
 * A domain event; the API_Gateway maps it to its own stream frame. During
 * re-verification the event carries `tier: 'Unverified'` so the intermediate module
 * is shown under the `Unverified` treatment with a transient `verifying` status
 * (Req 10.6, 10.8, 10.9).
 */
export interface IterationProgressEvent {
  readonly kind: 'progress';
  readonly phase: IterationPhase;
  /** A short, non-sensitive human-readable status line. */
  readonly message: string;
  /** The trust tier of the module at this step, when the event reports one. */
  readonly tier?: 'Verified' | 'Unverified';
  /** The oracle verdict, when the event reports one. */
  readonly verdict?: Verdict;
}

/** The arguments a demotion computes over: the edited module's current label. */
export type EditedLabel = LabeledArtifact;

/** The artifact reference of a demoted module, re-exported for property tests. */
export type DemotedRef = ArtifactRef;
