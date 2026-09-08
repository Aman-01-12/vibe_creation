// Intent_Agent (S0) public surface (task 11.1; Requirements 4.1-4.7).
//
// The Intent_Agent captures and clarifies a Student's single-module idea before
// any generation. It produces a structured restatement, asks bounded clarifying
// questions, proposes a default scope once the bound is reached, proposes a
// single-module reduction when the idea is too large, and requires explicit
// confirmation to unblock the generation gate (task 11.6). Every output artifact
// is labeled `Not_Applicable`, because intent capture makes no correctness claim.
//
// Public exports:
//   - `IntentAgent` / `IntentAgentDeps` / `IntentInput`: the role and its injected
//     collaborators (Model_Router, Action_Recorder).
//   - The state model (`IntentSession`, `IntentOutcome`, `RestatedIntent`,
//     `ClarifyingQuestion`, `ScopeAssessment`, `IntentConfirmationState`) and the
//     pure helpers (`decideIntentOutcome`, `confirmIntent`, `isIntentConfirmed`,
//     `canAskAnotherRound`), plus `MAX_CLARIFICATION_ROUNDS` - the single testable
//     clarification bound Property 14 (task 11.2) pins down.
//   - `ClarificationAnswer`: the follow-up input shape.
//   - `IntentAgentError` / `IntentAgentErrorCode`: the sanitized failure surface.

export { IntentAgent } from './intent-agent.js';
export type { IntentAgentDeps, IntentInput } from './intent-agent.js';

export {
  MAX_CLARIFICATION_ROUNDS,
  MAX_QUESTIONS_PER_ROUND,
  canAskAnotherRound,
  confirmIntent,
  decideIntentOutcome,
  intentAgentError,
  intentArtifactLabel,
  isIntentConfirmed,
} from './intent-state.js';
export type {
  ClarifyingQuestion,
  IntentAgentError,
  IntentAgentErrorCode,
  IntentAnalysis,
  IntentConfirmationState,
  IntentOutcome,
  IntentSession,
  OutcomeDecision,
  RestatedIntent,
  ScopeAssessment,
} from './intent-state.js';

export { parseIntentAnalysis } from './model-output.js';
export type { ModelOutputParseError } from './model-output.js';

export { buildBeginPrompt, buildClarifyPrompt, outstandingQuestions } from './prompt.js';
export type { ClarificationAnswer } from './prompt.js';
