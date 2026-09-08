// The Iteration_Agent (S9): apply a conversational change, demote the edited
// module to `Unverified` immediately, re-run the FULL Testbench through the same
// Verification_Loop the initial build used, detect an interface change (updating
// the Spec and regenerating the Testbench from the updated Spec before
// re-verification), report a regression with an offer to revert to the last
// `Verified` state, and present a diff with the new verdict (Req 10.1-10.9).
//
// THE SOURCE OF TRUTH IS THE SPEC. A conversational change is applied to the Spec
// through the injected `IterationSpecUpdater`, and the Verification_Loop then
// regenerates and re-verifies the RTL from the updated Spec. This keeps the
// S1 -> S4 -> S6 -> S7 pipeline intact on every iteration: generation and the
// independent Testbench are both re-derived from the updated Spec, so a passing
// check can never be an artifact of the edited implementation (Property 4 holds
// across iterations too), and the re-verification is spec-consistent by
// construction (Property 21).
//
// DEMOTION IS BY ABSENCE OF PROVENANCE (Req 10.7, 14.3). The edited module is
// demoted with `demoteOnEdit`, which DERIVES an `Unverified` label rather than
// clearing any flag: the changed design has no passing oracle span yet. It becomes
// `Verified` again only when the Verification_Loop records a fresh passing oracle
// verdict for the changed design; the positive `Verified` label always comes from
// the loop's oracle-derived Trust_Labeler, never from this agent.
//
// All collaborators are injected as narrow ports (no globals, no direct provider,
// store, or orchestrator calls; the agent layer never imports `app/api` and, to
// avoid a cycle, never imports the orchestrator). Progress is streamed without
// blocking, and every failure path fails safe with a sanitized reason.

import type { Json, ModuleVersion, Spec, Ulid, Verdict } from '@app/core';
import type { ResourceLimits } from '@app/tools';

import type { ActionRecorder, SpanDraft } from '../../action-recorder/index.js';
import type { SessionBudgetHandle } from '../../model-router/index.js';

import { buildRtlDiff, demoteOnEdit, interfaceChangedBetween } from './diff.js';
import type {
  IterationDiff,
  IterationOutcome,
  IterationPhase,
  IterationProgressEvent,
  IterationReVerifier,
  IterationRequest,
  IterationSpecUpdater,
  LastVerifiedState,
  ReVerifyResult,
  ReVerifyUnverified,
  ReVerifyVerified,
  RevertOffer,
} from './types.js';

/** The Trace `stageOrTool` name recorded for every Iteration_Agent action. */
const ITERATION_STAGE = 'Iteration_Agent' as const;

/** A JSON object; the span-output shape the Action_Recorder redacts and persists. */
type JsonObject = { readonly [key: string]: Json };

/** The sanitized message offered when a regression is detected (Req 10.4). */
const REVERT_OFFER_MESSAGE =
  'The change caused a previously passing module to fail. You can revert to the last verified version.';

/** The injected collaborators and deterministic seams for the Iteration_Agent. */
export interface IterationAgentDeps {
  /** Applies the conversational change to the Spec source of truth (Req 10.1, 10.2). */
  readonly specUpdater: IterationSpecUpdater;
  /** Re-verifies the updated Spec through the full Verification_Loop (Req 10.1, 10.3). */
  readonly reVerifier: IterationReVerifier;
  /** The Action_Recorder that appends each ordered, sanitized iteration span. */
  readonly recorder: ActionRecorder;
  /** Wall-clock source for recorded span timing; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * The Iteration_Agent (S9).
 *
 * `run` streams progress and returns the terminal `IterationOutcome`; `iterate`
 * drains `run` for callers that do not need streaming. The agent demotes the edited
 * module, applies the change to the Spec, re-verifies through the Verification_Loop,
 * and interprets the verdict into a verified / regressed / unverified outcome, each
 * carrying a diff and the new verdict.
 */
export class IterationAgent {
  readonly #specUpdater: IterationSpecUpdater;
  readonly #reVerifier: IterationReVerifier;
  readonly #recorder: ActionRecorder;
  readonly #now: () => number;

  constructor(deps: IterationAgentDeps) {
    this.#specUpdater = deps.specUpdater;
    this.#reVerifier = deps.reVerifier;
    this.#recorder = deps.recorder;
    this.#now = deps.now ?? Date.now;
  }

  /**
   * Run one conversational iteration and stream progress (Req 10.1-10.9).
   *
   * Demotes the edited module immediately (Req 10.7), applies the change to the Spec
   * (Req 10.1), re-verifies the FULL Testbench through the Verification_Loop
   * regenerating from the updated Spec (Req 10.2, 10.3), and returns the terminal
   * outcome with a diff and the new verdict (Req 10.6).
   */
  async *run(
    request: IterationRequest,
    budget: SessionBudgetHandle,
    limits: ResourceLimits,
  ): AsyncGenerator<IterationProgressEvent, IterationOutcome, void> {
    const demoted = demoteOnEdit(request.edited);
    await this.#recordDemotion(request);
    yield this.#progress('demoting', 'edited module demoted to Unverified until re-verified', {
      tier: demoted.tier,
    });

    yield this.#progress('updating-spec', 'applying the requested change to the Spec');
    const updated = await this.#specUpdater.applyChange(
      { currentSpec: request.currentSpec, requestedChange: request.requestedChange },
      budget,
    );
    if (!updated.ok) {
      await this.#recordTerminal('failed', request, { reason: updated.error.reason }, 'tool-error');
      yield this.#progress('failed', 'the requested change could not be applied to the Spec');
      return { status: 'failed', reason: 'spec-update-failed', detail: updated.error.detail };
    }

    const updatedSpec = updated.value;
    const interfaceChanged = interfaceChangedBetween(
      request.currentSpec.moduleInterface,
      updatedSpec.moduleInterface,
    );
    await this.#recordSpecUpdate(request, updatedSpec, interfaceChanged);
    if (interfaceChanged) {
      yield this.#progress(
        'regenerating-testbench',
        'interface changed; regenerating the Testbench from the updated Spec',
      );
    }

    yield this.#progress(
      'verifying',
      're-verifying the changed design against the full Testbench',
      {
        tier: 'Unverified',
      },
    );
    const result = await this.#reVerifier.reVerify(
      { intent: request.intent, spec: updatedSpec },
      budget,
      limits,
    );
    return yield* this.#interpret(request, updatedSpec, interfaceChanged, result);
  }

  /** Drain `run`, discarding progress, and return only the terminal outcome. */
  async iterate(
    request: IterationRequest,
    budget: SessionBudgetHandle,
    limits: ResourceLimits,
  ): Promise<IterationOutcome> {
    const iterator = this.run(request, budget, limits);
    let step = await iterator.next();
    while (!step.done) {
      step = await iterator.next();
    }
    return step.value;
  }

  /** Map the re-verification result into the terminal iteration outcome. */
  async *#interpret(
    request: IterationRequest,
    updatedSpec: Spec,
    interfaceChanged: boolean,
    result: ReVerifyResult,
  ): AsyncGenerator<IterationProgressEvent, IterationOutcome, void> {
    if (result.status === 'blocked') {
      await this.#recordTerminal('blocked', request, { reason: result.reason });
      yield this.#progress('blocked', 'the generation gate refused admission');
      return { status: 'blocked', reason: result.reason };
    }
    if (result.status === 'setup-failed') {
      await this.#recordTerminal('failed', request, { reason: result.reason }, 'tool-error');
      yield this.#progress('failed', 're-verification could not produce a candidate or testbench');
      return { status: 'failed', reason: 'reverify-setup-failed', detail: result.reason };
    }
    if (result.status === 'verified') {
      return yield* this.#onVerified(request, updatedSpec, interfaceChanged, result);
    }
    return yield* this.#onNotVerified(request, updatedSpec, interfaceChanged, result);
  }

  /** Build the passing outcome: the change re-verified to a fresh oracle pass (Req 10.5, 10.6). */
  async *#onVerified(
    request: IterationRequest,
    updatedSpec: Spec,
    interfaceChanged: boolean,
    result: ReVerifyVerified,
  ): AsyncGenerator<IterationProgressEvent, IterationOutcome, void> {
    const diff = this.#buildDiff(
      request.lastVerified,
      result.moduleVersion,
      interfaceChanged,
      'pass',
    );
    await this.#recordTerminal('verified', request, {
      moduleVersionId: result.moduleVersion.id,
      verdict: 'pass',
      interfaceChanged,
    });
    yield this.#progress('verified', 'the changed design passed re-verification', {
      tier: 'Verified',
      verdict: 'pass',
    });
    return {
      status: 'verified',
      label: result.label,
      moduleVersion: result.moduleVersion,
      testbench: result.testbench,
      result: result.result,
      updatedSpec,
      diff,
    };
  }

  /**
   * Build the non-passing outcome (Req 10.4, 10.5).
   *
   * A prior `Verified` baseline makes this a regression: the failure is reported and
   * a revert to the last `Verified` state is OFFERED, never applied silently. With no
   * baseline the module is simply left `Unverified`. Either way the module is never
   * presented as correct.
   */
  async *#onNotVerified(
    request: IterationRequest,
    updatedSpec: Spec,
    interfaceChanged: boolean,
    result: ReVerifyUnverified,
  ): AsyncGenerator<IterationProgressEvent, IterationOutcome, void> {
    const verdict: Verdict = result.result.verdict;
    const diff = this.#buildDiff(
      request.lastVerified,
      result.moduleVersion,
      interfaceChanged,
      verdict,
    );

    if (request.lastVerified !== null) {
      await this.#recordTerminal('regressed', request, {
        moduleVersionId: result.moduleVersion.id,
        verdict,
        interfaceChanged,
        revertTargetModuleVersionId: request.lastVerified.moduleVersion.id,
      });
      yield this.#progress('regressed', 'the change caused a regression; offering revert', {
        verdict,
      });
      return this.#regressed(updatedSpec, diff, result, revertOfferFor(request.lastVerified));
    }

    await this.#recordTerminal('unverified', request, {
      moduleVersionId: result.moduleVersion.id,
      verdict,
      interfaceChanged,
    });
    yield this.#progress('unverified', 'the changed design did not pass re-verification', {
      verdict,
    });
    return {
      status: 'unverified',
      label: result.label,
      moduleVersion: result.moduleVersion,
      testbench: result.testbench,
      result: result.result,
      failingCase: result.failingCase,
      updatedSpec,
      diff,
    };
  }

  /** Assemble the regression outcome from a non-passing re-verification result. */
  #regressed(
    updatedSpec: Spec,
    diff: IterationDiff,
    result: ReVerifyUnverified,
    revertOffer: RevertOffer,
  ): IterationOutcome {
    return {
      status: 'regressed',
      label: result.label,
      moduleVersion: result.moduleVersion,
      testbench: result.testbench,
      result: result.result,
      failingCase: result.failingCase,
      revertOffer,
      updatedSpec,
      diff,
    };
  }

  /** Build the diff of the change from the last-verified RTL to the new module version. */
  #buildDiff(
    lastVerified: LastVerifiedState | null,
    newModule: ModuleVersion,
    interfaceChanged: boolean,
    verdict: Verdict,
  ): IterationDiff {
    const previousRtl = lastVerified === null ? null : lastVerified.moduleVersion.rtl;
    const previousModuleVersionId = lastVerified === null ? null : lastVerified.moduleVersion.id;
    return {
      rtlDiff: buildRtlDiff(previousRtl, newModule.rtl),
      interfaceChanged,
      previousModuleVersionId,
      newModuleVersionId: newModule.id,
      verdict,
    };
  }

  /** Record the immediate demotion of the edited module (Req 10.7). */
  #recordDemotion(request: IterationRequest): Promise<void> {
    return this.#record(request.sessionId, {
      stage: 'iteration-demotion',
      artifactId: request.edited.artifactRef.id,
      demotedTo: 'Unverified',
      wasVerified: request.edited.tier === 'Verified',
    });
  }

  /** Record the applied Spec change and whether it changed the interface (Req 10.2). */
  #recordSpecUpdate(
    request: IterationRequest,
    updatedSpec: Spec,
    interfaceChanged: boolean,
  ): Promise<void> {
    return this.#record(request.sessionId, {
      stage: 'iteration-spec-update',
      specId: updatedSpec.id,
      specVersion: updatedSpec.version,
      interfaceChanged,
    });
  }

  /** Record the terminal outcome span, tagging a failure class when it failed. */
  #recordTerminal(
    phase: IterationPhase,
    request: IterationRequest,
    details: JsonObject,
    failureClass?: SpanDraft['failureClass'],
  ): Promise<void> {
    return this.#record(
      request.sessionId,
      { stage: 'iteration-outcome', status: phase, ...details },
      failureClass,
    );
  }

  /** Build a progress event, carrying tier/verdict only when reported. */
  #progress(
    phase: IterationPhase,
    message: string,
    extra?: { readonly tier?: 'Verified' | 'Unverified'; readonly verdict?: Verdict },
  ): IterationProgressEvent {
    const base: IterationProgressEvent = { kind: 'progress', phase, message };
    const withTier = extra?.tier === undefined ? base : { ...base, tier: extra.tier };
    return extra?.verdict === undefined ? withTier : { ...withTier, verdict: extra.verdict };
  }

  /** Append one sanitized Iteration_Agent span; the recorder redacts and orders it. */
  async #record(
    sessionId: Ulid,
    outputs: Json,
    failureClass?: SpanDraft['failureClass'],
  ): Promise<void> {
    const startedAtMs = this.#now();
    const base: SpanDraft = {
      sessionId,
      stageOrTool: ITERATION_STAGE,
      inputs: { stage: ITERATION_STAGE },
      outputs,
      exitCode: failureClass === undefined ? 0 : null,
      startedAt: new Date(startedAtMs).toISOString(),
      durationMs: 0,
      retryCount: 0,
      costCents: 0,
    };
    const draft = failureClass === undefined ? base : { ...base, failureClass };
    await this.#recorder.record(draft);
  }
}

/** Build the revert offer to the last `Verified` state (Req 10.4); never auto-applied. */
function revertOfferFor(lastVerified: LastVerifiedState): RevertOffer {
  return { offered: true, lastVerified, message: REVERT_OFFER_MESSAGE };
}
