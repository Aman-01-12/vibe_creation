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
//   - `RepairTestbenchRequest` / `RepairTestbenchModelInput` / `buildRepairModelInput`
//     (testbench-repair-loop task 4.1): the repair sibling of the request/input pair
//     above, with the identical RTL-free discipline plus a sanitized `RepairHint`
//     (never the reference design's observed behaviour or source).
//   - `describeRepairHint` (testbench-repair-loop task 8.7): the same anti-circular
//     Repair_Hint-to-prose renderer `buildRepairModelInput` uses for the model call,
//     re-exported so the eval-layer artifact capture can render the identical text
//     for `EvalSampleArtifacts.repairHint` rather than inventing a second renderer.
//   - `TESTBENCH_PROMPT_VERSION` (Req 11.1-11.5; task 9.1): the assembled prompt's
//     identity, folded into the eval sweep's config identity and manifest so a prompt
//     change cannot pool samples with the version it changed from.

export * from './types.js';
export {
  requiredChecks,
  requiredChecksFor,
  simulationCriteria,
  coveredCriterionIds,
} from './coverage.js';
export {
  CHECK_KEYWORD,
  formatCheckLine,
  isValidCheckName,
  sourceEmitsCheck,
} from './signalling.js';
export {
  detectGroundedStandardBlocks,
  detectStandardBlocks,
  type StandardBlockReference,
} from './standard-blocks.js';
export {
  TESTBENCH_PARSE_REFUSALS,
  parseFencedTestbenchDraft,
  parseTestbenchDraft,
  type TestbenchParseError,
  type TestbenchParseRefusal,
} from './parse.js';
export {
  ARCHITECTURE_FRAMING,
  ARCHITECTURE_SECTION_LABEL,
  FENCED_OUTPUT_CONTRACT_INSTRUCTION,
  buildGroundedRepairModelInput,
  buildGroundedTestbenchModelInput,
  buildRepairModelInput,
  buildTestbenchModelInput,
  describeArchitectureSection,
  describeRepairHint,
} from './prompt.js';
export { TESTBENCH_PROMPT_VERSION } from './prompt-version.js';
export {
  CHECKING_APPROACHES,
  DESIGN_GROUPS,
  STRATEGY_ARMS,
  designGroupOf,
  routeCheckingApproach,
  type CheckingApproach,
  type DesignGroup,
  type StrategyArm,
} from './approach-router.js';
export {
  MAX_EXPECTATION_CHARS,
  MAX_REPLY_CHARS,
  MAX_RUN_LENGTH,
  MAX_STIMULUS_CALLS,
  MAX_STIMULUS_CHARS,
  parseFragmentReply,
  type FragmentCriterion,
  type FragmentRefusal,
  type FragmentTargets,
  type ValidatedFragments,
} from './scoreboard/fragments.js';
export {
  DRAIN_BOUND,
  QUEUE_DEPTH,
  RESET_CYCLES,
  SCOREBOARD_CHECK_NAMES,
  assembleScoreboardTestbench,
  renderScoreboardScaffold,
  slotMarker,
  type ScaffoldRefusal,
  type ScoreboardScaffold,
} from './scoreboard/scaffold.js';
export {
  SCOREBOARD_CARVE_OUT,
  buildScoreboardModelInput,
  buildScoreboardRepairModelInput,
} from './scoreboard/prompt.js';
export {
  CONCURRENCY_RULE,
  CHECK_REPORT_RULE,
  DIALECT_RULE,
  EXPECTED_VALUE_RULE,
  describeInputWindow,
  describeStateAnchoring,
} from './prompt.js';
export {
  STUDENT_PATH_STRATEGY_ARM,
  TestbenchAgent,
  type TestbenchAgentDeps,
} from './testbench-agent.js';
