// Prompt construction for the Intent_Agent (S0).
//
// These builders assemble the orchestration-model prompt that asks for a
// structured restatement, focused clarifying questions, and a scope assessment
// (Req 4.1, 4.2, 4.4). The Student's description and answers are UNTRUSTED input;
// the API_Gateway has already injection-filtered them upstream, and this module
// only embeds them as clearly delimited data, never as instructions. The model's
// reply is re-validated at the boundary (model-output.ts) regardless of what this
// prompt requests, so a prompt the model ignores can never bypass validation.

import type { ClarifyingQuestion, IntentSession, RestatedIntent } from './intent-state.js';

/** One answered clarifying question, supplied by the Student for a follow-up turn. */
export interface ClarificationAnswer {
  /** The clarifying question that was asked. */
  readonly question: string;
  /** The Student's answer to it. */
  readonly answer: string;
}

/** The JSON contract the model is asked to follow; re-validated after the call. */
const OUTPUT_CONTRACT = [
  'Respond with a single JSON object and nothing else, using exactly these fields:',
  '- "summary": string. A concise restatement of the single hardware module the student wants.',
  '- "constraints": string[]. Explicit constraints the design must satisfy.',
  '- "assumptions": string[]. Assumptions you made that the student should confirm.',
  '- "clarifyingQuestions": string[]. Focused questions ONLY where the intent is ambiguous or a',
  '  needed constraint is missing; use an empty array when the intent is already unambiguous.',
  '- "scope": "single-module" or "exceeds-single-module". Use "exceeds-single-module" when the',
  '  idea needs more than one hardware module for this single-module slice.',
  '- "proposedReduction": string. When scope is "exceeds-single-module", the single module to',
  '  build first; otherwise an empty string.',
].join('\n');

/** The role framing shared by every intent turn. */
const ROLE_PREAMBLE =
  'You are the intent-clarification stage for a tool that builds ONE Verilog hardware module ' +
  'at a time. Restate the student idea below, surface missing constraints as focused questions, ' +
  'and judge whether it fits a single module. Do not design or write any code.';

/** Delimit untrusted student text so it is read as data, not as instructions. */
function fencedBlock(label: string, content: string): string {
  return `${label}:\n"""\n${content}\n"""`;
}

/** Build the prompt for the first intent turn from the raw student description. */
export function buildBeginPrompt(description: string): string {
  return [ROLE_PREAMBLE, fencedBlock('STUDENT_IDEA', description), OUTPUT_CONTRACT].join('\n\n');
}

/** Render the current restatement as compact context for a follow-up turn. */
function renderRestatement(restatement: RestatedIntent): string {
  const lines = [`summary: ${restatement.summary}`];
  if (restatement.constraints.length > 0) {
    lines.push(`constraints: ${restatement.constraints.join('; ')}`);
  }
  if (restatement.assumptions.length > 0) {
    lines.push(`assumptions: ${restatement.assumptions.join('; ')}`);
  }
  return lines.join('\n');
}

/** Render the Student's answers to the previously asked questions. */
function renderAnswers(answers: readonly ClarificationAnswer[]): string {
  return answers.map((entry) => `Q: ${entry.question}\nA: ${entry.answer}`).join('\n\n');
}

/**
 * Build the prompt for a follow-up turn that incorporates the Student's answers.
 *
 * It carries the prior restatement and the new answers so the model refines rather
 * than restarts, then asks for the same JSON contract so the reply validates the
 * same way as the first turn.
 */
export function buildClarifyPrompt(
  session: IntentSession,
  answers: readonly ClarificationAnswer[],
): string {
  return [
    ROLE_PREAMBLE,
    fencedBlock('CURRENT_RESTATEMENT', renderRestatement(session.restatement)),
    fencedBlock('STUDENT_ANSWERS', renderAnswers(answers)),
    'Refine the restatement using these answers. Only keep questions that remain unresolved.',
    OUTPUT_CONTRACT,
  ].join('\n\n');
}

/** The clarifying questions currently outstanding for a session, if any. */
export function outstandingQuestions(session: IntentSession): readonly ClarifyingQuestion[] {
  if (session.outcome.kind === 'clarifying') {
    return session.outcome.questions;
  }
  if (session.outcome.kind === 'default-scope-proposed') {
    return session.outcome.unresolvedQuestions;
  }
  return [];
}
