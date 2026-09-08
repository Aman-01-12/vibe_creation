// Iteration_Agent (S9): apply a conversational change, demote the edited module to
// `Unverified` immediately, re-verify the FULL Testbench through the same
// Verification_Loop the initial build used, update the Spec and regenerate the
// Testbench on an interface change, offer a revert on regression, and present a diff
// with the new verdict (Req 10.1-10.9; task 16.1).
//
// Public surface:
//   - `IterationAgent` / `IterationAgentDeps`: the role and its injected seams
//     (the Spec updater, the re-verification port, the Action_Recorder). `run`
//     streams progress; `iterate` drains it.
//   - The request/outcome types (`IterationRequest`, `IterationOutcome`,
//     `IterationVerified`, `IterationRegressed`, `IterationUnverified`,
//     `IterationBlocked`, `IterationFailed`, `IterationProgressEvent`,
//     `RevertOffer`, `IterationDiff`, `DiffLine`, `LastVerifiedState`): the
//     conversational-change surface and the diff-with-verdict result.
//   - The injected ports (`IterationSpecUpdater`, `IterationReVerifier`) and their
//     input/result types, defined role-locally so the role never imports the
//     orchestrator (the Verification_Loop depends on the roles).
//   - The pure deterministic core (`demoteOnEdit`, `moduleInterfacesEqual`,
//     `interfaceChangedBetween`, `buildRtlDiff`): the demotion (Property 20) and the
//     spec-consistent, interface-aware re-verification (Property 21) state over these.

export * from './types.js';
export {
  demoteOnEdit,
  moduleInterfacesEqual,
  interfaceChangedBetween,
  buildRtlDiff,
} from './diff.js';
export { IterationAgent, type IterationAgentDeps } from './iteration-agent.js';
