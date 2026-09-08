// The RTLLM eval corpus: pinned fetch, import, and the independent golden judge.
//
// Attribution and the pinned commit live in `./pinned-source.js` - RTLLM is MIT
// licensed and its two citations are recorded in that module's header, which is also
// the single place the pinned commit is defined so a run manifest can cite it.

// What we fetch, at exactly which commit, and how the checkout is laid out.
export {
  asRtllmCategory,
  DESIGN_DESCRIPTION_FILENAME,
  GOLDEN_TESTBENCH_FILENAME,
  REFERENCE_PREFIX,
  RTLLM_CATEGORY_DIRECTORIES,
  RTLLM_EXPECTED_DESIGN_COUNT,
  RTLLM_LICENSE,
  RTLLM_PINNED_COMMIT,
  RTLLM_REPOSITORY_URL,
  rtllmProblemId,
  VCS_MAKEFILE_FILENAME,
  type RtllmCategory,
} from './pinned-source.js';

// The pinned, commit-verified fetch and its seams.
export {
  fetchPinnedRtllmCheckout,
  isCorpusFetchError,
  type CheckoutPresence,
  type CheckoutProbePort,
  type CorpusFetchAction,
  type CorpusFetchError,
  type CorpusFetchErrorCode,
  type CorpusFetchOutcome,
  type CorpusFetchRequest,
  type GitCommandPort,
  type GitCommandResult,
} from './fetch.js';
export {
  EVAL_CORPUS_ROOT,
  NodeCheckoutProbePort,
  NodeGitCommandPort,
  RTLLM_CHECKOUT_PATH,
} from './fetch-node.js';
export { runCorpusFetch, type FetchCliResult } from './fetch-cli.js';

// Reading a checkout, behind an injectable port.
export { FileSystemCorpusCheckout, type CorpusCheckoutPort } from './checkout-port.js';

// The parsers, exported so each is unit-testable against fixtures without a fetch.
export { evaluateIntExpression, type IntExprResult, type IntExprScope } from './int-expr.js';
export {
  listDeclaredModuleNames,
  parseDeclaredModule,
  stripVerilogNoise,
  type DeclaredModule,
  type DeclaredPort,
  type ModuleParseResult,
} from './verilog-module.js';
export {
  parseDesignDescription,
  type DescriptionParseResult,
  type DesignDescription,
} from './design-description.js';

// The importer and the shapes it produces.
export {
  importRtllmCorpus,
  readOverriddenParameters,
  REFERENCE_WORKSPACE_FILENAME,
  renameTopModule,
} from './import.js';
export type {
  GoldenTestbench,
  QuarantinedDesign,
  QuarantineReasonCode,
  QuarantineStage,
  ReferenceDesign,
  RtllmCorpus,
} from './corpus-types.js';

// The independent judge: banner parsing, the scorer, and the harness-facing adapter.
export {
  extractGoldenBanners,
  parseGoldenVerdict,
  type GoldenVerdict,
  type GoldenVerdictKind,
} from './golden-banner.js';
export {
  assembleGoldenJob,
  CANDIDATE_WORKSPACE_FILENAME,
  SandboxGoldenTestbenchScorer,
  type GoldenScore,
  type GoldenTestbenchScorer,
} from './golden-scorer.js';
export { RtllmGoldenJudge } from './rtllm-golden-judge.js';

// The POSITIVE CONTROL: our own generated testbench driven against RTLLM's own reference
// design, so a sample judged by a broken instrument is identified instead of being counted
// as a model failure.
export {
  CONTROL_TESTBENCH_WORKSPACE_FILENAME,
  RtllmInstrumentControl,
  type RtllmInstrumentControlDeps,
} from './rtllm-instrument-control.js';

// The NEGATIVE CONTROL: our own testbench driven against DELIBERATELY BROKEN versions of
// RTLLM's reference design, so a testbench that passes everything is identified instead of
// being reported as a sound instrument.
export { generateMutants, MAX_MUTATED_SOURCE_CHARS } from './verilog-mutation.js';
export {
  decodeCalibrationCache,
  describeCalibration,
  encodeCalibrationCache,
  goldenKilled,
  goldenKilledCountOf,
  goldenTimeoutCountOf,
  goldenSurvivedCountOf,
  MUTATION_CALIBRATION_CACHE_VERSION,
  mutationConfigHash,
  renderCalibrationCacheKey,
  RtllmMutationCalibrator,
  type CalibratedMutant,
  type CalibratedMutants,
  type CalibrationCacheDocument,
  type DigestHex as MutationDigestHex,
  type MutationCalibrationCacheKey,
  type MutationCalibrationCachePort,
  type MutationCalibratorDeps,
} from './mutation-calibration.js';
export {
  MUTANT_WORKSPACE_FILENAME,
  NEGATIVE_CONTROL_TESTBENCH_FILENAME,
  RtllmMutationNegativeControl,
  type RtllmNegativeControlDeps,
} from './rtllm-negative-control.js';

// The shared rule both the control and Stage 0 explain a non-pass with.
export {
  classifyNonPass,
  firstDiagnosticLine,
  MAX_DIAGNOSTIC_LINE_CHARS,
  type NonPassCause,
  type NonPassEvidence,
} from './nonpass-cause.js';

// Stage 0: validating the golden testbenches as measuring sticks before trusting them.
export { validateReferenceDesigns, type Stage0DesignOutcome, type Stage0Report } from './stage0.js';
export {
  RTLLM_SCORED_DESIGN_COUNT,
  scoredRtllmCorpus,
  STAGE0_QUARANTINE,
  STAGE0_QUARANTINED_PROBLEM_IDS,
  type Stage0QuarantineEntry,
} from './stage0-quarantine.js';
