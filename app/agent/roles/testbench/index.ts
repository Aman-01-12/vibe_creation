// Testbench_Agent (S6): the RTL-isolated, spec-derived testbench generator and the
// anti-circular guarantee it structurally enforces (Req 7.1-7.7; task 13.3).
//
// Public surface:
//   - `TestbenchAgent` / `TestbenchAgentDeps`: the role and its injected seams
//     (Model_Router, Action_Recorder, Knowledge_Retriever).
//   - `GenerateTestbenchRequest` / `TestbenchGenerationInput`: the request and the
//     RTL-free generation-input type. RTL is unrepresentable on both; Property 4
//     (task 13.4) states directly over `TestbenchGenerationInput` and the model
//     input assembled from it by `buildTestbenchModelInput`.
//   - Outcome types (`TestbenchGenerationOutcome`, `TestbenchGenerated`,
//     `TestbenchCoverageIncomplete`, `TestbenchGenerationFailed`, `RequiredCheck`):
//     the produced-or-failed states and the per-check coverage contract.
//   - Coverage mapping (`requiredChecks`, `simulationCriteria`, `coveredCriterionIds`):
//     the deterministic acceptance-criterion coverage Property 6 (task 13.5) states over.
//   - Signalling (`formatCheckLine`, `sourceEmitsCheck`, `isValidCheckName`,
//     `CHECK_KEYWORD`): the `CHECK <name> PASS|FAIL` emission matching the oracle parser.
//   - Known-answer references (`detectStandardBlocks`, `StandardBlockReference`) and
//     the untrusted-output boundary (`parseTestbenchDraft`, `buildTestbenchModelInput`).
//   - `TESTBENCH_PROMPT_VERSION` (Req 11.1-11.5; task 9.1): the assembled prompt's
//     identity, folded into the eval sweep's config identity and manifest so a prompt
//     change cannot pool samples with the version it changed from.

export * from './types.js';
export { requiredChecks, simulationCriteria, coveredCriterionIds } from './coverage.js';
export {
  CHECK_KEYWORD,
  formatCheckLine,
  isValidCheckName,
  sourceEmitsCheck,
} from './signalling.js';
export { detectStandardBlocks, type StandardBlockReference } from './standard-blocks.js';
export { parseTestbenchDraft, type TestbenchParseError } from './parse.js';
export { buildTestbenchModelInput } from './prompt.js';
export { TESTBENCH_PROMPT_VERSION } from './prompt-version.js';
export { TestbenchAgent, type TestbenchAgentDeps } from './testbench-agent.js';
