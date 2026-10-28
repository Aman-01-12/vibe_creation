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

// The Timing_Derivation the importer requires: the seam, the real host composition, and the
// doubles the suites that never read `timingContract` stand in with.
export {
  FormalPrepassTimingDerivation,
  type TimingDerivationPort,
} from './timing-derivation-port.js';
export { localTimingDerivation, TIMING_DERIVATION_LIMITS } from './timing-derivation-node.js';
export { FixedTimingDerivation, RefusingTimingDerivation } from './timing-derivation-double.js';

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
export { RTLLM_VALIDITY_OUTPUTS, validityOutputFor } from './validity-outputs.js';

// The Legacy_Byte_Identity_Check's shared render logic (C7, task 1.1): the one request
// builder both the capture CLI and the future byte comparison (task 5.1) import, so neither
// can drift from the other.
export {
  legacyGoldenFileName,
  legacyRoleDeclarationFor,
  legacyGoldenRequestFor,
  LEGACY_GOLDEN_NONCE,
  LEGACY_GOLDEN_WATCHDOG_BUDGET_NS,
  renderLegacyGoldenCorpus,
  renderLegacyGoldenDesign,
  type LegacyGoldenDesign,
} from './legacy-byte-identity.js';
export { LEGACY_GOLDEN_FIXTURE_DIR, runLegacyGoldenCapture } from './legacy-golden-capture-cli.js';

// The five named populations of the timing derivation, every size computed from
// membership so no count can double-subtract an already-excluded design.
export {
  DERIVABLE_SCORING_COHORT_SIZE,
  DERIVATION_POPULATION_SIZE,
  inDerivableScoringCohort,
  inDerivationPopulation,
  inScoringCohort,
  SCORING_COHORT_SIZE,
  SOURCE_UNIVERSE_SIZE,
  summarizeTimingPopulations,
  YOSYS_FRONTEND_REJECTED_PROBLEM_IDS,
  type DerivationExclusion,
  type DesignDerivationOutcome,
  type TimingPopulationSummary,
} from './timing-populations.js';
// The importer's inference count, which never travels without the population it is over.
export {
  derivationOutcomesOf,
  timingInferenceCountReport,
  type ReportedPopulation,
  type TimingInferenceCountReport,
} from './timing-count-report.js';

// The both-direction ratchet: derived Port_Timing against the reviewed manifest, where a
// newly disagreeing port and a port that starts agreeing where the manifest records a
// refusal both fail. Plus the published six-figure report C11 assembles over it (task 12.1).
export {
  assembleCrossCheckReport,
  compareDerivedTiming,
  isTimingRatchetFailure,
  type CrossCheckClockedFigure,
  type CrossCheckReport,
  type DerivedPortResult,
  type TimingComparisonOutcome,
  type TimingDisagreement,
  type TimingPortComparison,
  type TimingRatchetResult,
  type TimingWitnessRow,
} from './timing-cross-check.js';
