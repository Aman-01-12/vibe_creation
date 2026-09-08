// The Intent_Agent (S0): the Orchestrator role that captures and clarifies a
// Student's idea before any generation (Requirements 4.1-4.7).
//
// This class is a thin orchestration shell over the pure decision logic in
// intent-state.ts. Its only responsibilities are the ones that need collaborators:
//   - route the restatement call through the injected Model_Router as an
//     `orchestration` task, threading the Session_Budget (Req 4.1; design routes
//     orchestration -> Gemini Flash);
//   - shape the untrusted model reply at the boundary before trusting it (Req 4.2);
//   - record each turn as a Trace span via the injected Action_Recorder;
//   - stamp every produced session with a `Not_Applicable` label (Req 4.7).
//
// The clarification bound (Req 4.3), the default-scope and single-module-reduction
// proposals (Req 4.4), and the explicit-confirmation transition that gates
// generation (Req 4.5, 4.6) all live as pure functions in intent-state.ts, so this
// shell never re-implements them. All collaborators are injected; there are no
// globals and no direct provider calls.

import { newUlid, type Json, type Result, type Ulid, err, ok } from '@app/core';

import type { ActionRecorder, SpanDraft } from '../../action-recorder/index.js';
import type {
  ModelRouter,
  ModelRouterFailure,
  RoutedModelResult,
  SessionBudgetHandle,
} from '../../model-router/index.js';

import {
  confirmIntent,
  decideIntentOutcome,
  intentAgentError,
  intentArtifactLabel,
  type IntentAgentError,
  type IntentAnalysis,
  type IntentOutcome,
  type IntentSession,
} from './intent-state.js';
import { parseIntentAnalysis } from './model-output.js';
import { buildBeginPrompt, buildClarifyPrompt, type ClarificationAnswer } from './prompt.js';

/** The Trace `stageOrTool` name recorded for every Intent_Agent turn. */
const INTENT_STAGE = 'Intent_Agent' as const;

/** The first version number assigned to a freshly created intent artifact. */
const FIRST_VERSION = 1 as const;

/** The collaborators the Intent_Agent depends on, all injected (no globals). */
export interface IntentAgentDeps {
  /** The provider-abstracted Model_Router; intent uses the `orchestration` task. */
  readonly router: ModelRouter;
  /** The Action_Recorder that appends this stage's ordered, sanitized spans. */
  readonly recorder: ActionRecorder;
  /** Identifier factory, injectable so tests get deterministic ids. */
  readonly newId?: () => Ulid;
  /** Clock, injectable so recorded timing is deterministic under test. */
  readonly now?: () => number;
}

/** The first input to an intent session: the Student's natural-language idea. */
export interface IntentInput {
  /** The session whose Trace this intent is recorded under. */
  readonly sessionId: Ulid;
  /** The Student's raw, gateway-validated single-module idea (untrusted content). */
  readonly description: string;
}

/** A model turn that succeeded and yielded a validated analysis. */
interface AnalyzedTurn {
  readonly analysis: IntentAnalysis;
  readonly result: RoutedModelResult;
}

/**
 * The Intent_Agent role.
 *
 * `begin` opens a session from the Student's description; `clarify` advances it
 * with the Student's answers; `confirm` applies the explicit confirmation that
 * gates generation. Every returned session carries a `Not_Applicable` label and a
 * `clarificationRounds` count bounded by `MAX_CLARIFICATION_ROUNDS`.
 */
export class IntentAgent {
  readonly #router: ModelRouter;
  readonly #recorder: ActionRecorder;
  readonly #newId: () => Ulid;
  readonly #now: () => number;

  constructor(deps: IntentAgentDeps) {
    this.#router = deps.router;
    this.#recorder = deps.recorder;
    this.#newId = deps.newId ?? newUlid;
    this.#now = deps.now ?? Date.now;
  }

  /**
   * Open an intent session from the Student's description (Req 4.1, 4.2, 4.4).
   *
   * Produces a structured restatement, and either focused questions, a
   * single-module reduction, or a ready-for-confirmation state, all labeled
   * `Not_Applicable`. Fails closed on an empty description, a Model_Router failure,
   * or model output that cannot be shaped into a valid analysis.
   */
  async begin(
    input: IntentInput,
    budget: SessionBudgetHandle,
  ): Promise<Result<IntentSession, IntentAgentError>> {
    const description = input.description.trim();
    if (description.length === 0) {
      return err(intentAgentError('EMPTY_DESCRIPTION', 'An intent description must not be empty.'));
    }

    const turn = await this.#analyze(
      input.sessionId,
      buildBeginPrompt(description),
      budget,
      'begin',
    );
    if (!turn.ok) {
      return turn;
    }

    const decision = decideIntentOutcome(turn.value.analysis, 0);
    const intentId = this.#newId();
    const session: IntentSession = {
      sessionId: input.sessionId,
      artifact: intentArtifactLabel(intentId, FIRST_VERSION),
      restatement: turn.value.analysis.restatement,
      scope: turn.value.analysis.scope,
      clarificationRounds: decision.clarificationRounds,
      outcome: decision.outcome,
      confirmation: 'unconfirmed',
    };
    await this.#recordTurn(session, 'begin', turn.value.result);
    return ok(session);
  }

  /**
   * Advance an unconfirmed session with the Student's answers (Req 4.2, 4.3, 4.4).
   *
   * Refines the restatement, then re-decides the outcome under the same bound so
   * the round count can never exceed `MAX_CLARIFICATION_ROUNDS`. A confirmed
   * session is rejected: clarification is over once the Student has confirmed.
   */
  async clarify(
    session: IntentSession,
    answers: readonly ClarificationAnswer[],
    budget: SessionBudgetHandle,
  ): Promise<Result<IntentSession, IntentAgentError>> {
    if (session.confirmation === 'confirmed') {
      return err(
        intentAgentError(
          'ALREADY_CONFIRMED',
          'The intent is already confirmed; clarification is closed.',
        ),
      );
    }

    const turn = await this.#analyze(
      session.sessionId,
      buildClarifyPrompt(session, answers),
      budget,
      'clarify',
    );
    if (!turn.ok) {
      return turn;
    }

    const decision = decideIntentOutcome(turn.value.analysis, session.clarificationRounds);
    const nextVersion = session.artifact.artifactRef.version + 1;
    const next: IntentSession = {
      sessionId: session.sessionId,
      artifact: intentArtifactLabel(session.artifact.artifactRef.id, nextVersion),
      restatement: turn.value.analysis.restatement,
      scope: turn.value.analysis.scope,
      clarificationRounds: decision.clarificationRounds,
      outcome: decision.outcome,
      confirmation: 'unconfirmed',
    };
    await this.#recordTurn(next, 'clarify', turn.value.result);
    return ok(next);
  }

  /**
   * Apply the Student's explicit confirmation (Req 4.5).
   *
   * Delegates to the pure `confirmIntent` transition, which fails closed on an
   * already-confirmed or out-of-scope session. No model call is made: confirmation
   * is a Student act, not a model decision.
   */
  confirm(session: IntentSession): Result<IntentSession, IntentAgentError> {
    return confirmIntent(session);
  }

  /** Route one restatement turn through the model and shape its untrusted reply. */
  async #analyze(
    sessionId: Ulid,
    prompt: string,
    budget: SessionBudgetHandle,
    turn: TurnKind,
  ): Promise<Result<AnalyzedTurn, IntentAgentError>> {
    const routed = await this.#router.invoke('orchestration', { prompt }, budget);
    if (!routed.ok) {
      // A router failure is redacted and cost-free at this seam: the router
      // already charged and recorded each provider attempt against the budget.
      await this.#recordFailure(sessionId, turn, 'model-unavailable', 0);
      return err(this.#mapRouterFailure(routed.error));
    }

    const parsed = parseIntentAnalysis(routed.value.outputText, this.#newId);
    if (!parsed.ok) {
      await this.#recordFailure(sessionId, turn, parsed.error.reason, routed.value.costCents);
      return err(
        intentAgentError('INVALID_MODEL_OUTPUT', 'The model reply could not be validated.'),
      );
    }
    return ok({ analysis: parsed.value, result: routed.value });
  }

  /** Map a redacted Model_Router failure to a sanitized Intent_Agent error. */
  #mapRouterFailure(failure: ModelRouterFailure): IntentAgentError {
    const message =
      failure.code === 'BUDGET_EXHAUSTED'
        ? 'The session budget was exhausted before intent could be restated.'
        : 'No model was available to restate the intent.';
    return intentAgentError('MODEL_UNAVAILABLE', message, failure.budgetStopReason);
  }

  /** Record a successful turn as an ordered, sanitized Trace span (Req 3.1). */
  async #recordTurn(
    session: IntentSession,
    turn: TurnKind,
    result: RoutedModelResult,
  ): Promise<void> {
    await this.#recorder.record({
      sessionId: session.sessionId,
      stageOrTool: INTENT_STAGE,
      inputs: { turn, clarificationRounds: session.clarificationRounds },
      outputs: this.#outcomeSummary(session, result),
      exitCode: 0,
      startedAt: new Date(this.#now()).toISOString(),
      durationMs: 0,
      retryCount: 0,
      costCents: result.costCents,
    });
  }

  /** Record a failed turn as an ordered, sanitized Trace span (Req 3.4). */
  async #recordFailure(
    sessionId: Ulid,
    turn: TurnKind,
    reason: string,
    costCents: number,
  ): Promise<void> {
    const draft: SpanDraft = {
      sessionId,
      stageOrTool: INTENT_STAGE,
      inputs: { turn },
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

  /** The sanitized, structural summary of a turn recorded in the Trace. */
  #outcomeSummary(session: IntentSession, result: RoutedModelResult): Json {
    return {
      outcome: outcomeKind(session.outcome),
      scope: session.scope,
      trustTier: session.artifact.tier,
      questionCount: countQuestions(session.outcome),
      provider: result.provider,
      fellBack: result.fellBack,
    };
  }
}

/** Which turn produced a span, recorded for replay. */
type TurnKind = 'begin' | 'clarify';

/** The discriminant of an outcome, for the Trace summary. */
function outcomeKind(outcome: IntentOutcome): IntentOutcome['kind'] {
  return outcome.kind;
}

/** How many questions an outcome carries, for the Trace summary. */
function countQuestions(outcome: IntentOutcome): number {
  if (outcome.kind === 'clarifying') {
    return outcome.questions.length;
  }
  if (outcome.kind === 'default-scope-proposed') {
    return outcome.unresolvedQuestions.length;
  }
  return 0;
}
