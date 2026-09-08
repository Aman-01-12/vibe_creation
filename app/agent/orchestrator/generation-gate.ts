// The Orchestrator generation gate (Req 4.6, 5.5, 5.6, 5.7; Property 13).
//
// This is the structural barrier that makes it impossible to invoke the
// Generation_Agent while the intent is unconfirmed or the Spec is unapproved. Two
// layers enforce the same rule so it cannot be bypassed:
//
//   1. A capability token (`ConfirmedGenerationContext`) that CANNOT be forged.
//      Its constructor is guarded by a module-private symbol and it carries a
//      private brand field, so no code outside this module can mint one - not by
//      calling `new`, not by casting a plain object. The generation-runner port's
//      entry point (`GenerationRunner.runGeneration`) takes this token as its
//      first argument, so a caller that lacks a token literally cannot type-check
//      a call to generation. The token can only be obtained from
//      `GenerationGate.openGenerationContext`, which mints it exclusively when
//      BOTH preconditions hold. Illegal states are therefore unrepresentable, not
//      merely rejected at runtime.
//
//   2. A runtime guard inside `openGenerationContext` that returns a typed refusal
//      (`GenerationGateRefusal`) when intent is unconfirmed (Req 4.6) or the Spec
//      is unapproved (Req 5.6). This is defense in depth for the JavaScript
//      boundary where the compile-time token guarantee does not hold.
//
// On admission the gate persists the approved Spec as the source of truth and
// writes the durable spec-approved checkpoint (Req 5.7). It does this through the
// injected `SpecApprovalSink` PORT, never by importing `app/api`: the agent layer
// may depend on `core`, `knowledge`, and `tools`, but not on the outer `api`
// layer. The composition root wires this port to `ProjectStore.persist` +
// `ProjectStore.checkpointOnSpecApproval` under a validated principal. This is the
// seam that lets the gate establish the source of truth without an upward import.
//
// Every gate decision - blocked or allowed - is recorded through the injected
// Action_Recorder, so the gating trajectory is replayable. All collaborators are
// injected; there are no globals and no direct provider or store calls here.

import { err, ok, type Json, type Result, type Spec, type Ulid } from '@app/core';

import type { ActionRecorder, SpanDraft } from '../action-recorder/index.js';
import type { SessionBudgetHandle } from '../model-router/index.js';
import {
  isIntentConfirmed,
  type IntentSession,
  type RestatedIntent,
} from '../roles/intent/index.js';

/** The Trace `stageOrTool` name recorded for every gate decision. */
const GATE_STAGE = 'Generation_Gate' as const;

/**
 * Module-private construction guard for the capability token.
 *
 * Because this symbol is neither exported nor otherwise reachable, no code outside
 * this module can name its type or supply its value, so `ConfirmedGenerationContext`
 * cannot be constructed anywhere else. This is what makes the token unforgeable.
 */
const CONTEXT_KEY: unique symbol = Symbol('ConfirmedGenerationContext');

/**
 * A non-forgeable proof that generation is admissible: the intent is confirmed AND
 * the Spec is approved (Req 4.5, 4.6, 5.5, 5.6).
 *
 * The `GenerationRunner` entry point requires a value of this type, and the ONLY
 * way to obtain one is `GenerationGate.openGenerationContext`, which mints it
 * exclusively after both preconditions pass. The private `#brand` field makes the
 * type nominal, so a structurally similar plain object cannot pose as a token; the
 * symbol-guarded constructor makes `new` impossible outside this module.
 *
 * The token also carries the approved Spec (the source of truth generation
 * implements) and the confirmed restated intent, so downstream generation reads
 * them from the token rather than from any mutable, ungated source.
 */
export class ConfirmedGenerationContext {
  /** Nominal brand: prevents any non-instance object from being treated as a token. */
  readonly #brand = true;

  /** The session whose Trace this generation is recorded under. */
  readonly sessionId: Ulid;
  /** The project the approved Spec belongs to. */
  readonly projectId: Ulid;
  /** The Student-confirmed restated intent that drove the Spec (Req 4.5). */
  readonly confirmedIntent: RestatedIntent;
  /** The approved Spec: the single source of truth for generation (Req 5.5, 5.7). */
  readonly approvedSpec: Spec;

  constructor(
    key: typeof CONTEXT_KEY,
    sessionId: Ulid,
    projectId: Ulid,
    confirmedIntent: RestatedIntent,
    approvedSpec: Spec,
  ) {
    if (key !== CONTEXT_KEY) {
      // Unreachable from typed callers; a JS caller that forces the wrong key is
      // rejected here so the token can never be minted outside the gate.
      throw new Error('ConfirmedGenerationContext is not directly constructible');
    }
    // `#brand` is read once so strict "declared but never read" checks are satisfied
    // while the field still enforces nominal typing.
    void this.#brand;
    this.sessionId = sessionId;
    this.projectId = projectId;
    this.confirmedIntent = confirmedIntent;
    this.approvedSpec = approvedSpec;
  }
}

/**
 * The generation-runner port: the single entry point into the Generation_Agent
 * (task 13.1), expressed as an interface so the gate depends on the runner's
 * name and signature, never its internals.
 *
 * `runGeneration` requires a `ConfirmedGenerationContext`, which is the structural
 * gate: no confirmed-and-approved token, no call. `TOutcome` is left open so the
 * Generation_Agent owns the shape of a generation result without coupling the gate
 * to it.
 */
export interface GenerationRunner<TOutcome> {
  /** Run generation for an admitted context. Unreachable without a valid token. */
  runGeneration(
    context: ConfirmedGenerationContext,
    budget: SessionBudgetHandle,
  ): Promise<TOutcome>;
}

/** The approved Spec and its identity, handed to the persistence sink (Req 5.7). */
export interface ApprovedSpecPersistInput {
  readonly sessionId: Ulid;
  readonly projectId: Ulid;
  /** The approved Spec to persist as the source of truth. */
  readonly spec: Spec;
}

/** A sanitized confirmation that the approved Spec was persisted as source of truth. */
export interface SpecApprovalReceipt {
  /** Whether the durable spec-approved checkpoint was written (Req 5.7, 16.1). */
  readonly checkpointWritten: boolean;
}

/** Why persisting the approved Spec through the sink failed, as a sanitized value. */
export interface SpecApprovalSinkError {
  readonly code: 'PERSIST_FAILED' | 'FORBIDDEN';
  /** A short, non-sensitive message; never a host, path, secret, or stack trace. */
  readonly message: string;
}

/**
 * The injected persistence PORT the gate writes the approved Spec through (Req 5.7).
 *
 * Defined purely in agent-layer terms (`Spec`, `Ulid` are core types), so the agent
 * layer never imports `app/api`. The composition root implements this by adapting
 * to `ProjectStore.persist` + `ProjectStore.checkpointOnSpecApproval` under a
 * validated `AuthenticatedPrincipal`, translating the current project state and
 * ownership on the api side of the seam.
 */
export interface SpecApprovalSink {
  /** Persist the approved Spec as the source of truth and checkpoint it (Req 5.7). */
  persistApprovedSpec(
    input: ApprovedSpecPersistInput,
  ): Promise<Result<SpecApprovalReceipt, SpecApprovalSinkError>>;
}

/** Why the gate refused to admit generation. */
export type GenerationGateRefusalReason =
  /** The Student has not confirmed the restated intent (Req 4.6). */
  | 'intent-unconfirmed'
  /** The Student has not approved the Spec (Req 5.6). */
  | 'spec-unapproved'
  /** The approved Spec could not be persisted as source of truth (fail closed). */
  | 'persist-failed';

/** A typed, sanitized refusal to admit generation; carries no token. */
export interface GenerationGateRefusal {
  readonly reason: GenerationGateRefusalReason;
  readonly message: string;
}

/** The intent + approved Spec the gate evaluates for one admission decision. */
export interface GenerationAdmissionRequest {
  /** The current intent session; its confirmation state gates generation (Req 4.6). */
  readonly intent: IntentSession;
  /** The Spec whose `approved` flag gates generation (Req 5.6). */
  readonly spec: Spec;
}

/** The injected collaborators for the gate; no globals. */
export interface GenerationGateDeps<TOutcome> {
  /** The generation-runner port whose entry point requires the capability token. */
  readonly runner: GenerationRunner<TOutcome>;
  /** The persistence port that commits the approved Spec as source of truth (Req 5.7). */
  readonly approvalSink: SpecApprovalSink;
  /** The Action_Recorder that appends this gate's ordered, sanitized decision spans. */
  readonly recorder: ActionRecorder;
  /** Wall-clock source for recorded span timing; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Build a sanitized refusal value. */
function refusal(reason: GenerationGateRefusalReason, message: string): GenerationGateRefusal {
  return { reason, message };
}

/** Fixed, sanitized messages for each refusal reason (no internal detail leaks). */
const REFUSAL_MESSAGE: Readonly<Record<GenerationGateRefusalReason, string>> = {
  'intent-unconfirmed':
    'Generation is blocked: the restated intent must be explicitly confirmed first.',
  'spec-unapproved': 'Generation is blocked: the Spec must be explicitly approved first.',
  'persist-failed':
    'Generation is blocked: the approved Spec could not be persisted as the source of truth.',
};

/**
 * The Orchestrator generation gate.
 *
 * `openGenerationContext` is the fundamental primitive: it evaluates both
 * preconditions, persists the approved Spec as source of truth on success, records
 * the decision, and mints the capability token. `runGeneration` is the wired
 * convenience that admits and then drives the injected runner in one shot; the
 * Verification_Loop (task 14.1) uses `openGenerationContext` once and reuses the
 * token across repair iterations. Both paths guarantee the runner is invoked only
 * after a successful admission, and the token type guarantees no OTHER caller can
 * invoke it at all.
 */
export class GenerationGate<TOutcome> {
  readonly #runner: GenerationRunner<TOutcome>;
  readonly #approvalSink: SpecApprovalSink;
  readonly #recorder: ActionRecorder;
  readonly #now: () => number;

  constructor(deps: GenerationGateDeps<TOutcome>) {
    this.#runner = deps.runner;
    this.#approvalSink = deps.approvalSink;
    this.#recorder = deps.recorder;
    this.#now = deps.now ?? Date.now;
  }

  /**
   * Evaluate the gate and, on success, mint the capability token (Req 4.6, 5.6, 5.7).
   *
   * Fails closed in decision order: unconfirmed intent, then unapproved Spec, then
   * a persistence failure. Only when intent is confirmed, the Spec is approved, and
   * the approved Spec has been persisted as the source of truth does it return a
   * token. Every branch records exactly one decision span.
   */
  async openGenerationContext(
    request: GenerationAdmissionRequest,
  ): Promise<Result<ConfirmedGenerationContext, GenerationGateRefusal>> {
    const { intent, spec } = request;
    if (!isIntentConfirmed(intent)) {
      return this.#refuse(intent.sessionId, spec, 'intent-unconfirmed');
    }
    if (!spec.approved) {
      return this.#refuse(intent.sessionId, spec, 'spec-unapproved');
    }

    const persisted = await this.#approvalSink.persistApprovedSpec({
      sessionId: intent.sessionId,
      projectId: spec.projectId,
      spec,
    });
    if (!persisted.ok) {
      return this.#refuse(intent.sessionId, spec, 'persist-failed');
    }

    await this.#recordAllowed(intent.sessionId, spec, persisted.value.checkpointWritten);
    const token = new ConfirmedGenerationContext(
      CONTEXT_KEY,
      intent.sessionId,
      spec.projectId,
      intent.restatement,
      spec,
    );
    return ok(token);
  }

  /**
   * Admit generation and, on success, invoke the injected runner exactly once.
   *
   * This is the wired path that proves the gate controls generation end to end: the
   * runner is called if and only if the token was minted. On refusal the runner is
   * never touched and the typed refusal is returned unchanged.
   */
  async runGeneration(
    request: GenerationAdmissionRequest,
    budget: SessionBudgetHandle,
  ): Promise<Result<TOutcome, GenerationGateRefusal>> {
    const admission = await this.openGenerationContext(request);
    if (!admission.ok) {
      return admission;
    }
    const outcome = await this.#runner.runGeneration(admission.value, budget);
    return ok(outcome);
  }

  /** Record a blocked decision and return the matching typed refusal. */
  async #refuse(
    sessionId: Ulid,
    spec: Spec,
    reason: GenerationGateRefusalReason,
  ): Promise<Result<ConfirmedGenerationContext, GenerationGateRefusal>> {
    await this.#recordBlocked(sessionId, spec, reason);
    return err(refusal(reason, REFUSAL_MESSAGE[reason]));
  }

  /** Append the "generation allowed" decision span (Req 3.1). */
  #recordAllowed(sessionId: Ulid, spec: Spec, checkpointWritten: boolean): Promise<void> {
    return this.#record(sessionId, {
      decision: 'allowed',
      specId: spec.id,
      specVersion: spec.version,
      sourceOfTruthPersisted: true,
      checkpointWritten,
    });
  }

  /** Append a "generation blocked" decision span, tagging a persist failure (Req 3.4). */
  #recordBlocked(sessionId: Ulid, spec: Spec, reason: GenerationGateRefusalReason): Promise<void> {
    return this.#record(
      sessionId,
      { decision: 'blocked', reason, specId: spec.id, specVersion: spec.version },
      reason === 'persist-failed',
    );
  }

  /** Append one sanitized gate decision span; the recorder redacts and orders it. */
  async #record(sessionId: Ulid, outputs: Json, isToolFailure = false): Promise<void> {
    const startedAtMs = this.#now();
    const base: SpanDraft = {
      sessionId,
      stageOrTool: GATE_STAGE,
      inputs: { stage: GATE_STAGE },
      outputs,
      exitCode: isToolFailure ? null : 0,
      startedAt: new Date(startedAtMs).toISOString(),
      durationMs: 0,
      retryCount: 0,
      costCents: 0,
    };
    const draft: SpanDraft = isToolFailure ? { ...base, failureClass: 'tool-error' } : base;
    await this.#recorder.record(draft);
  }
}
