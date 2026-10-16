// The Property_Author: the RTL-blind, Spec-derived Formal_Property set generator
// (Req 6.8, 6.14, 6.15, 6.16, 6.17; task 9.1).
//
// Public surface:
//   - `derivePropertySet` / `PropertyAuthorDeps`: the derivation task 9.1 and design.md
//     name, and its injected seams (Model_Router, Action_Recorder, Session_Budget).
//     Neither parameter can carry a candidate design source, which is the structural
//     RTL-blindness Property 30 (task 9.3) extends its existing assertion over.
//   - `PropertyAgent` / `PropertyAgentDeps`: the role as the Verification_Loop's
//     property source. Its `propertySetFor(spec, budget)` satisfies `PropertySetSource`
//     structurally and delegates to `derivePropertySet`.
//   - `PropertySetOutcome` / `UnexpressedCriterion` / `UnexpressedReason`: the Property_Set
//     plus the criteria the dialect could not express, and why. The expressed and
//     unexpressed sets partition the Spec's criteria (Property 17, task 9.2).
//   - `buildPropertyModelInput`: the pure, Spec-only model-input assembly, exported so an
//     RTL-isolation property can serialize it and assert no design source reached it.
//   - `parsePropertyDrafts` / `PropertyDraft` / `PropertyDraftKind` / `PropertyParseError`:
//     the untrusted-model-output boundary. A draft's expressions are plain strings and
//     cannot reach a `FormalProperty`, whose every expression field needs the
//     `ValidatedExpression` brand only `validateExpression` mints.

export {
  PropertyAgent,
  derivePropertySet,
  type PropertyAgentDeps,
  type PropertyAuthorDeps,
  type PropertySetOutcome,
  type UnexpressedCriterion,
  type UnexpressedReason,
} from './property-agent.js';
export { buildPropertyModelInput } from './prompt.js';
export {
  parsePropertyDrafts,
  type PropertyDraft,
  type PropertyDraftKind,
  type PropertyParseError,
} from './model-output.js';
