// Spec_Agent (S1): produce and validate the Spec plus block-level architecture,
// and model the student approve/edit cycle (Req 5.1-5.4, 5.8, 5.9; task 11.3).
//
// Public surface:
//   - `SpecAgent` / `SpecAgentDeps` / `ProduceSpecInput` / `EditablePresentation`:
//     the role, its injected seams, and the produce/edit/approve flow.
//   - Draft, edit, issue, and presentation types (`SpecDraft`, `SpecEdit`,
//     `SpecPresentation`, `SignalValidationIssue`, `UnmeasurableCriterionFlag`, ...):
//     the untrusted inputs and the deterministic validation outputs.
//   - Validation core (`validateSpecDraft`, `validateInterface`,
//     `partitionAcceptanceCriteria`, `isCriterionMeasurable`, `isRigorousMethod`,
//     `ValidatedSpecCore`): the two Spec gates Properties 15 and 16 state over.
//   - `parseSpecDraft`: the structural boundary over untrusted model output.

export * from './types.js';
export * from './validation.js';
export { parseSpecDraft } from './parse.js';
export { renderTimingQuestion } from './present.js';
export {
  SpecAgent,
  type SpecAgentDeps,
  type ProduceSpecInput,
  type EditablePresentation,
} from './spec-agent.js';
