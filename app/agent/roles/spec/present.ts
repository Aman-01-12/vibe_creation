// Presentation-layer rendering for Spec_Agent escalations (Req 4.12; task 8.10).
//
// The token grammar in `consensus/behaviour-question.ts` is shared with the
// Consensus escalation path and stays untouched: this module only composes the
// SAME facts a `BehaviourQuestion`'s tokens already carry into a sentence a
// student who has never heard "Port_Timing" can read as a real question.

import type { BehaviourQuestion } from '../../consensus/behaviour-question.js';

/**
 * Render a Timing_Refusal's `BehaviourQuestion` as one grammatical question
 * sentence naming the output port whose Port_Timing statement is absent (Req
 * 4.12). The port name is read out of the question's own signal token rather
 * than taken as a separate parameter, because the question is the source of
 * truth for what it asks about.
 *
 * Generic to the one frame this escalation ever builds
 * (`output-settles-at-cycle`, from `buildTimingQuestion`); rendering
 * `output-differs-at-cycle` is the Consensus escalation's concern, not this one.
 */
export function renderTimingQuestion(question: BehaviourQuestion): string {
  // `buildTimingQuestion` always supplies exactly one signal token (the port
  // name) alongside the one admitted frame token; an empty name here would
  // mean that invariant broke upstream, not a case this renderer should guess at.
  const portToken = question.tokens.find((token) => token.kind === 'signal');
  const portName = portToken?.name ?? '';
  return `At what point does the ${portName} output settle relative to changes in its inputs?`;
}
