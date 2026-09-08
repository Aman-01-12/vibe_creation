// Intent_Agent (S0) state model and pure decision logic (Requirements 4.1-4.7).
//
// This module holds the parts of the Intent_Agent that need no I/O: the state a
// session carries between turns, the single testable clarification bound, the
// pure function that maps a validated intent analysis to the next interaction
// outcome, and the pure confirmation transition. Keeping this logic free of the
// Model_Router and Action_Recorder makes the numbered Property 14 (clarification
// rounds are bounded, task 11.2) trivial to state directly against
// `decideIntentOutcome`, and lets the outer `IntentAgent` (intent-agent.ts) stay
// a thin orchestration shell over these decisions.
//
// Trust tier: every state this module produces carries a `Not_Applicable` label
// built with the core trust labeler's `notApplicable`, because intent capture is
// an input stage and makes no correctness claim (Req 4.7). There is no path here
// to a `Verified` or `Unverified` intent label.

import {
  err,
  notApplicable,
  ok,
  type ArtifactRef,
  type BudgetStopReason,
  type NotApplicableArtifact,
  type Result,
  type Ulid,
} from '@app/core';

/**
 * The hard cap on clarifying-question ROUNDS for one intent session (Req 4.3).
 *
 * A single, testable constant: after this many rounds of questions have been put
 * to the Student, the Intent_Agent proposes a default scope instead of asking
 * again (Req 4.4). Property 14 (task 11.2) pins that a session's
 * `clarificationRounds` never exceeds this value across any sequence of turns.
 */
export const MAX_CLARIFICATION_ROUNDS = 3 as const;

/**
 * The most clarifying questions accepted from the model in a single round.
 *
 * A defensive cap at the untrusted-output boundary: the model proposes questions,
 * and this bounds how many the Student is shown per round regardless of what the
 * model returns. It is not the round bound (that is `MAX_CLARIFICATION_ROUNDS`).
 */
export const MAX_QUESTIONS_PER_ROUND = 5 as const;

/** Whether the Student has explicitly confirmed the restated intent (Req 4.5). */
export type IntentConfirmationState = 'unconfirmed' | 'confirmed';

/** Whether the described idea fits the single-module slice or exceeds it (Req 4.4). */
export type ScopeAssessment = 'single-module' | 'exceeds-single-module';

/** A structured restatement of the Student's intent and its constraints (Req 4.1). */
export interface RestatedIntent {
  /** A one-paragraph restatement of what the Student wants to build. */
  readonly summary: string;
  /** The explicit constraints the design must satisfy. */
  readonly constraints: readonly string[];
  /** Assumptions the restatement makes that the Student may correct. */
  readonly assumptions: readonly string[];
}

/** A single focused clarifying question put to the Student (Req 4.2). */
export interface ClarifyingQuestion {
  /** A stable id so an answer can be attributed back to its question. */
  readonly id: Ulid;
  /** The question text shown to the Student. */
  readonly prompt: string;
}

/**
 * The next interaction the Intent_Agent proposes after analysing a turn.
 *
 * A discriminated union so the Orchestrator and Editor branch exhaustively:
 * - `clarifying`: focused questions, only while under the round bound (Req 4.2, 4.3).
 * - `default-scope-proposed`: the round bound is reached, so a default scope is
 *   proposed for the Student to adjust rather than asking further (Req 4.3, 4.4).
 * - `single-module-reduction-proposed`: the idea exceeds the single-module slice,
 *   so a reduction to one module is proposed (Req 4.4).
 * - `ready-for-confirmation`: the restatement is unambiguous and in scope, awaiting
 *   the explicit confirmation that gates generation (Req 4.5).
 */
export type IntentOutcome =
  | { readonly kind: 'clarifying'; readonly questions: readonly ClarifyingQuestion[] }
  | {
      readonly kind: 'default-scope-proposed';
      readonly defaultScope: RestatedIntent;
      readonly unresolvedQuestions: readonly ClarifyingQuestion[];
    }
  | { readonly kind: 'single-module-reduction-proposed'; readonly reduction: string }
  | { readonly kind: 'ready-for-confirmation' };

/**
 * The validated, model-derived analysis of one intent turn.
 *
 * Produced by shaping untrusted model output at the boundary (model-output.ts),
 * so by the time it reaches `decideIntentOutcome` every field is well-formed.
 */
export interface IntentAnalysis {
  readonly restatement: RestatedIntent;
  readonly scope: ScopeAssessment;
  readonly clarifyingQuestions: readonly ClarifyingQuestion[];
  /** A model-suggested single-module reduction, when the scope exceeds the slice. */
  readonly proposedReduction: string | null;
}

/**
 * The full state of one intent session, carried between turns.
 *
 * `artifact` is the `Not_Applicable` label for this intent version (Req 4.7);
 * `confirmation` is the blocking precondition the generation gate reads (Req 4.6,
 * task 11.6); `clarificationRounds` is bounded by `MAX_CLARIFICATION_ROUNDS`.
 */
export interface IntentSession {
  /** The session whose Trace this intent is recorded under. */
  readonly sessionId: Ulid;
  /** The `Not_Applicable` label bound to this intent artifact version (Req 4.7). */
  readonly artifact: NotApplicableArtifact;
  /** The current structured restatement of intent and constraints (Req 4.1). */
  readonly restatement: RestatedIntent;
  /** Whether the current restatement fits the single-module slice (Req 4.4). */
  readonly scope: ScopeAssessment;
  /** Rounds of clarifying questions asked so far; never exceeds the bound (Req 4.3). */
  readonly clarificationRounds: number;
  /** The interaction the agent proposes next for this session. */
  readonly outcome: IntentOutcome;
  /** Whether the Student has explicitly confirmed the intent (Req 4.5). */
  readonly confirmation: IntentConfirmationState;
}

/** Why an Intent_Agent operation could not complete, as a typed, sanitized value. */
export type IntentAgentErrorCode =
  | 'EMPTY_DESCRIPTION'
  | 'MODEL_UNAVAILABLE'
  | 'INVALID_MODEL_OUTPUT'
  | 'SCOPE_EXCEEDS_SINGLE_MODULE'
  | 'ALREADY_CONFIRMED';

/** A sanitized Intent_Agent failure: a stable code and a non-sensitive message. */
export interface IntentAgentError {
  readonly code: IntentAgentErrorCode;
  readonly message: string;
  /** The budget cap that stopped the run, when the cause was the Session_Budget. */
  readonly budgetStopReason?: BudgetStopReason;
}

/** Build a sanitized Intent_Agent error value. */
export function intentAgentError(
  code: IntentAgentErrorCode,
  message: string,
  budgetStopReason?: BudgetStopReason,
): IntentAgentError {
  return budgetStopReason === undefined ? { code, message } : { code, message, budgetStopReason };
}

/** The default single-module reduction message when the model offers none (Req 4.4). */
const DEFAULT_REDUCTION_MESSAGE =
  'This idea spans more than one hardware module. For this slice, reduce it to a single ' +
  'module: pick the one core block to build first, and we can compose the rest later.';

/** Whether another round of clarifying questions is allowed under the bound (Req 4.3). */
export function canAskAnotherRound(clarificationRounds: number): boolean {
  return clarificationRounds < MAX_CLARIFICATION_ROUNDS;
}

/** Whether the Student has confirmed the intent, the gate the generation stage reads. */
export function isIntentConfirmed(session: IntentSession): boolean {
  return session.confirmation === 'confirmed';
}

/** The next outcome and the resulting (bounded) clarification-round count. */
export interface OutcomeDecision {
  readonly outcome: IntentOutcome;
  readonly clarificationRounds: number;
}

/**
 * Decide the next interaction from a validated analysis and the prior round count.
 *
 * The decision is total and bounded (Req 4.3, 4.4):
 * - An out-of-scope idea yields a single-module reduction and consumes no round.
 * - Outstanding questions under the bound are asked, incrementing the round by one.
 * - Outstanding questions at the bound yield a default-scope proposal, holding the
 *   round count at the cap so it can never exceed `MAX_CLARIFICATION_ROUNDS`.
 * - An unambiguous, in-scope restatement is ready for confirmation.
 *
 * Because the returned `clarificationRounds` is `min(priorRounds + 1, cap)` on the
 * only incrementing branch and unchanged elsewhere, it is monotonic and bounded,
 * which is exactly what Property 14 asserts.
 */
export function decideIntentOutcome(
  analysis: IntentAnalysis,
  priorRounds: number,
): OutcomeDecision {
  if (analysis.scope === 'exceeds-single-module') {
    const reduction = analysis.proposedReduction ?? DEFAULT_REDUCTION_MESSAGE;
    return {
      outcome: { kind: 'single-module-reduction-proposed', reduction },
      clarificationRounds: priorRounds,
    };
  }

  if (analysis.clarifyingQuestions.length > 0) {
    if (canAskAnotherRound(priorRounds)) {
      return {
        outcome: { kind: 'clarifying', questions: analysis.clarifyingQuestions },
        clarificationRounds: priorRounds + 1,
      };
    }
    return {
      outcome: {
        kind: 'default-scope-proposed',
        defaultScope: analysis.restatement,
        unresolvedQuestions: analysis.clarifyingQuestions,
      },
      clarificationRounds: priorRounds,
    };
  }

  return { outcome: { kind: 'ready-for-confirmation' }, clarificationRounds: priorRounds };
}

/** Build the `Not_Applicable` label for an intent artifact version (Req 4.7). */
export function intentArtifactLabel(intentId: Ulid, version: number): NotApplicableArtifact {
  const ref: ArtifactRef = { kind: 'intent', id: intentId, version };
  return notApplicable(ref);
}

/**
 * Apply the Student's explicit confirmation to a session (Req 4.5).
 *
 * Confirmation is the blocking precondition for generation (Req 4.6): only a
 * `confirmed` session may pass the generation gate (task 11.6). This transition
 * is pure and fails closed:
 * - An already-confirmed session is rejected, so confirmation is a single,
 *   explicit, non-idempotent act rather than something re-applied silently.
 * - An out-of-scope session is rejected, so the Student cannot confirm an idea
 *   that exceeds the single-module slice; they must first accept the proposed
 *   reduction (via a further clarify turn) so the restatement becomes in-scope.
 */
export function confirmIntent(session: IntentSession): Result<IntentSession, IntentAgentError> {
  if (session.confirmation === 'confirmed') {
    return err(intentAgentError('ALREADY_CONFIRMED', 'The intent is already confirmed.'));
  }
  if (session.scope === 'exceeds-single-module') {
    return err(
      intentAgentError(
        'SCOPE_EXCEEDS_SINGLE_MODULE',
        'The intent exceeds the single-module slice; accept the proposed reduction before confirming.',
      ),
    );
  }
  return ok({ ...session, confirmation: 'confirmed' });
}
