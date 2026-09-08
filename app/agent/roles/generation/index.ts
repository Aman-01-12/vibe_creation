// Generation_Agent (S4): generate candidate Verilog implementing the Spec
// Module_Interface exactly, route generation/repair through the Model_Router under
// the Session_Budget, read compiler errors and revise, stream progress, and on
// budget exhaustion present the last failing candidate labeled `Unverified`
// (Req 6.1-6.7, 17.6; task 13.1).
//
// Public surface:
//   - `GenerationAgent` / `GenerationAgentDeps`: the role and its injected seams,
//     with `run` (streaming loop), `generate` (drained outcome), and the
//     `generateCandidate` / `reviseFromErrors` primitives a driver can call.
//   - The domain types (`GenerationInput`, `GeneratedCandidate`, `GenerationOutcome`,
//     `GenerationProgressEvent`, `InterfaceMatch`, ...): the untrusted-output shapes
//     and deterministic results.
//   - `CandidateCompiler` port + `SimulatorCandidateCompiler`: the compile-and-
//     diagnostics seam and its Simulator-backed implementation.
//   - `parseModuleInterface` / `checkInterfaceExact` / `describeInterfaceMismatch`:
//     the interface-exactness core Property 17 (task 13.2) states over.
//   - `parseCandidateRtl`: the structural boundary over untrusted model output.

export * from './types.js';
export { GenerationAgent, type GenerationAgentDeps } from './generation-agent.js';
export {
  parseModuleInterface,
  checkInterfaceExact,
  describeInterfaceMismatch,
  type InterfaceParseError,
} from './interface-check.js';
export { parseCandidateRtl, type RtlParseError } from './model-output.js';
export { SimulatorCandidateCompiler, buildCompileHarness } from './candidate-compiler.js';
export {
  specInterfaceView,
  expectedInterfacePorts,
  type ModelInterfacePortsView,
} from './spec-view.js';
export { buildGenerationPrompt, buildRepairPrompt } from './prompt.js';
