// Teach_Mode (Req 11): the Orchestrator role that explains design choices, waveform
// readings, and verification results in plain language grounded in the session's
// ACTUAL artifacts.
//
// This class is a thin orchestration shell over the pure grounding logic in
// teach-claims.ts. Its only responsibilities are the ones that need collaborators:
//   - route the teaching call through the injected Model_Router as a `teaching`
//     task, threading the Session_Budget (design routes teaching -> Gemini Flash);
//   - shape the untrusted model reply at the boundary before grounding it
//     (model-output.ts);
//   - assemble the grounded explanation with the pure core, which grounds each
//     claim by type, presents a `Verified` result with the mandatory
//     simulation-vs-silicon limit, and coaches on the failing case on a non-pass
//     (Req 11.2-11.9);
//   - record the turn as a sanitized Trace span via the injected Action_Recorder.
//
// The grounding rule, the mandatory limit, and the failing-case coaching all live as
// pure functions in teach-claims.ts, so this shell never re-implements them and can
// never present an ungrounded claim as correct. All collaborators are injected;
// there are no globals, no direct provider calls, and no import of `app/api`.

import { newUlid, type Json, type Result, type Ulid, err, ok } from '@app/core';

import type { ActionRecorder, SpanDraft } from '../../action-recorder/index.js';
import type {
  ModelRouter,
  ModelRouterFailure,
  RoutedModelResult,
  SessionBudgetHandle,
} from '../../model-router/index.js';

import { assembleExplanation, teachModeError } from './teach-claims.js';
import { parseTeachClaims } from './model-output.js';
import { buildTeachPrompt } from './prompt.js';
import type { ClaimDecision, Explanation, TeachModeError, TeachSession } from './types.js';

/** The Trace `stageOrTool` name recorded for every Teach_Mode turn. */
const TEACH_STAGE = 'Teach_Mode' as const;

/** The collaborators Teach_Mode depends on, all injected (no globals). */
export interface TeachModeDeps {
  /** The provider-abstracted Model_Router; teaching uses the `teaching` task. */
  readonly router: ModelRouter;
  /** The Action_Recorder that appends this stage's ordered, sanitized spans. */
  readonly recorder: ActionRecorder;
  /** Identifier factory, injectable so tests get deterministic ids. */
  readonly newId?: () => Ulid;
  /** Clock, injectable so recorded timing is deterministic under test. */
  readonly now?: () => number;
}

/**
 * Teach_Mode.
 *
 * `explain` produces a grounded explanation for the session's artifacts: it routes
 * one teaching call, shapes the untrusted reply, and assembles the explanation with
 * the pure grounding core. Every returned explanation is `Not_Applicable` (pedagogy),
 * every taught claim carries its own grounding, a `Verified` result always states the
 * simulation-vs-silicon limit, and a non-pass always coaches on the failing case.
 */
export class TeachMode {
  readonly #router: ModelRouter;
  readonly #recorder: ActionRecorder;
  readonly #newId: () => Ulid;
  readonly #now: () => number;

  constructor(deps: TeachModeDeps) {
    this.#router = deps.router;
    this.#recorder = deps.recorder;
    this.#newId = deps.newId ?? newUlid;
    this.#now = deps.now ?? Date.now;
  }

  /**
   * Explain the session's artifacts in grounded plain language (Req 11.1-11.9).
   *
   * Fails closed on an empty session, a Model_Router failure, or model output that
   * cannot be shaped into claims; in each case a sanitized error is returned and the
   * failure is recorded, and no ungrounded claim is ever presented as correct.
   */
  async explain(
    session: TeachSession,
    budget: SessionBudgetHandle,
  ): Promise<Result<Explanation, TeachModeError>> {
    if (session.spec.goal.trim().length === 0) {
      return err(teachModeError('EMPTY_SESSION', 'There is no module goal to explain yet.'));
    }

    const routed = await this.#router.invoke(
      'teaching',
      { prompt: buildTeachPrompt(session) },
      budget,
    );
    if (!routed.ok) {
      await this.#recordFailure(session.sessionId, 'model-unavailable', 0);
      return err(this.#mapRouterFailure(routed.error));
    }

    const parsed = parseTeachClaims(routed.value.outputText);
    if (!parsed.ok) {
      await this.#recordFailure(session.sessionId, parsed.error.reason, routed.value.costCents);
      return err(teachModeError('INVALID_MODEL_OUTPUT', 'The model reply could not be validated.'));
    }

    const explanation = assembleExplanation(session, parsed.value, this.#newId());
    await this.#recordTurn(session, explanation, routed.value);
    return ok(explanation);
  }

  /** Map a redacted Model_Router failure to a sanitized Teach_Mode error. */
  #mapRouterFailure(failure: ModelRouterFailure): TeachModeError {
    const message =
      failure.code === 'BUDGET_EXHAUSTED'
        ? 'The session budget was exhausted before an explanation could be produced.'
        : 'No model was available to produce an explanation.';
    return teachModeError('MODEL_UNAVAILABLE', message, failure.budgetStopReason);
  }

  /** Record a successful turn as an ordered, sanitized Trace span (Req 3.1). */
  async #recordTurn(
    session: TeachSession,
    explanation: Explanation,
    result: RoutedModelResult,
  ): Promise<void> {
    await this.#recorder.record({
      sessionId: session.sessionId,
      stageOrTool: TEACH_STAGE,
      inputs: { moduleTier: session.moduleLabel.tier },
      outputs: this.#explanationSummary(explanation, result),
      exitCode: 0,
      startedAt: new Date(this.#now()).toISOString(),
      durationMs: 0,
      retryCount: 0,
      costCents: result.costCents,
    });
  }

  /** Record a failed turn as an ordered, sanitized Trace span (Req 3.4). */
  async #recordFailure(sessionId: Ulid, reason: string, costCents: number): Promise<void> {
    const draft: SpanDraft = {
      sessionId,
      stageOrTool: TEACH_STAGE,
      inputs: { stage: TEACH_STAGE },
      outputs: { outcome: 'failure', reason },
      exitCode: null,
      startedAt: new Date(this.#now()).toISOString(),
      durationMs: 0,
      retryCount: 0,
      costCents,
      failureClass: 'tool-error',
    };
    await this.#recorder.record(draft);
  }

  /** The sanitized, structural summary of an explanation recorded in the Trace. */
  #explanationSummary(explanation: Explanation, result: RoutedModelResult): Json {
    return {
      trustTier: explanation.artifact.tier,
      taughtClaims: countDisposition(explanation.claims, 'taught'),
      unverifiedClaims: countDisposition(explanation.claims, 'unverified'),
      omittedClaims: countDisposition(explanation.claims, 'omitted'),
      presentedVerifiedResult: explanation.verifiedResult !== null,
      statedSimulationVsSiliconLimit: explanation.verifiedResult !== null,
      coachedFailingCase: explanation.coaching !== null,
      provider: result.provider,
      fellBack: result.fellBack,
    };
  }
}

/** Count claims with a given disposition, for the sanitized Trace summary. */
function countDisposition(
  claims: readonly ClaimDecision[],
  disposition: ClaimDecision['disposition'],
): number {
  return claims.reduce(
    (total, claim) => (claim.disposition === disposition ? total + 1 : total),
    0,
  );
}
