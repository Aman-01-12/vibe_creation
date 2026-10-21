// The Reference_Model role: the Authoring_Contract and C7's prompt/parse boundary.

export { buildReferenceModelInput } from './prompt.js';
export {
  EXAMPLE_DRAFT,
  EXAMPLE_GOAL,
  EXAMPLE_INTERFACE,
  EXAMPLE_TIMING,
} from './canonical-example.js';
export { REFERENCE_MODEL_PROMPT_VERSION } from './prompt-version.js';
export { parseReferenceModelDraft } from './parse.js';
export {
  AUTHORING_CONTRACT_VERSION,
  checkAuthoringContract,
  type AuthoringCheck,
  type ExcludedConstruct,
} from './authoring-contract.js';
export type {
  ReferenceModelDraft,
  ReferenceModelParseError,
  ReferenceModelRequest,
} from './types.js';
