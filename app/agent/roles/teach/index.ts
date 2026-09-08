// Teach_Mode public surface (task 16.4; Requirements 11.1-11.9).
//
// Teach_Mode explains design choices, waveform readings, and verification results
// in plain language tied to the session's ACTUAL artifacts. It grounds each claim by
// its TYPE - a design-specific claim in verified tool output (an oracle verdict, a
// recorded Trace span, or a VCD reading), a general domain fact in a session
// citation - labels any claim lacking its appropriate grounding `Unverified` (or does
// not teach it), coaches constructively on the failing case on a non-pass, and states
// the simulation-vs-silicon limit whenever it presents a `Verified` result. The
// explanation artifact itself is Trust_Tier `Not_Applicable` (pedagogy); its claims
// carry the grounding of what they reference.
//
// Public exports:
//   - `TeachMode` / `TeachModeDeps`: the role and its injected collaborators
//     (Model_Router routed to the teaching model, Action_Recorder).
//   - The domain types (`TeachSession`, `ProposedClaim`, `ClaimDecision`,
//     `Explanation`, `VerifiedResultPresentation`, `FailingCaseCoaching`,
//     `ToolOutputRef`, ...) and the `SIMULATION_VS_SILICON_LIMIT` constant that
//     Property 25 (task 16.5) and the example tests (task 16.6) state over.
//   - The pure grounding core (`groundClaim`, `groundClaims`, `assembleExplanation`,
//     `presentVerifiedResult`, `coachFailingCase`, `toolOutputRefResolves`,
//     `explanationArtifactLabel`) and the sanitized error surface (`teachModeError`).
//   - `parseTeachClaims`: the boundary over untrusted teaching-model output.
//   - `buildTeachPrompt`: the grounded-prompt builder.

export * from './types.js';
export {
  FIRST_EXPLANATION_VERSION,
  assembleExplanation,
  coachFailingCase,
  explanationArtifactLabel,
  explanationArtifactRef,
  groundClaim,
  groundClaims,
  presentVerifiedResult,
  teachModeError,
  toolOutputRefResolves,
} from './teach-claims.js';
export { TeachMode, type TeachModeDeps } from './teach-agent.js';
export { parseTeachClaims } from './model-output.js';
export type { ModelOutputParseError as TeachClaimsParseError } from './model-output.js';
export { buildTeachPrompt, type GroundingRefKind } from './prompt.js';
