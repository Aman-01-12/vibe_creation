// The eval SWEEP: the runnable model bake-off over the scored RTLLM corpus.
//
// The harness measures ONE arm's samples; the sweep drives the MATRIX - every arm, every
// selected problem, every sample - and persists results that are attributable to an exact
// model, corpus commit, toolchain, and code revision. Read `./cli.ts` for the composition
// root, `./runner.ts` for the execution model, and `./transport-retry.ts` for the one
// distinction that keeps pass@k honest (a transport retry is not a second sample).

// The declarative campaign definition and its boundary validation.
export {
  armCostIsKnown,
  armModelIds,
  DEFAULT_CAPTURE_ARTIFACTS,
  DEFAULT_FORMAL_GATE_ENABLED,
  DEFAULT_NEGATIVE_CONTROL_CONFIG,
  DEFAULT_NEGATIVE_CONTROL_ENABLED,
  isSingleModel,
  modelSignatureOf,
  mutationConfigFor,
  SCOREBOARD_CAMPAIGN_MAX_RESUMES,
  SWEEP_CONFIG_BOUNDS,
  SWEEP_CONFIG_SCHEMA_VERSION,
  SWEEP_NAME_PATTERN,
  type ScoreboardCampaignConfig,
  type SweepArmConfig,
  type SweepConfig,
  type SweepModelHostConfig,
  type SweepNegativeControlConfig,
  type SweepProblemSelection,
} from './config.js';
export { parseSweepConfig } from './config-parse.js';
export type { SweepConfigError, SweepConfigErrorCode, SweepConfigResult } from './config-values.js';
export { parseArms, parseProblemSelection } from './config-arms.js';
export { parseScoreboardCampaign } from './config-campaign.js';
export {
  campaignCells,
  renderCampaignTable,
  type CampaignCell,
  type CampaignScope,
} from './campaign-table.js';
export {
  renderCampaignReport,
  verdictFigures,
  type CampaignReportInput,
} from './campaign-report.js';
export {
  BASELINE_SCHEMA_VERSION,
  readBaseline,
  renderBaselineReading,
  type BaselineCell,
  type BaselineReading,
} from './baseline-reading.js';
export {
  agreementLower,
  evaluateSuccessCriterion,
  isPreRegisteredCriterion,
  PRE_REGISTERED_SUCCESS_CRITERION,
  type CampaignVerdict,
  type CriterionResult,
  type ModelArmStreamingFigures,
  type StreamingFigures,
  type SuccessCriterion,
  type VerdictReport,
} from './success-criterion.js';
// The Grounding Campaign's pre-registered rule (testbench-spec-grounding, C17).
export {
  CLAUSE_OUTCOMES,
  PRE_REGISTERED_GROUNDING_CRITERION,
  evaluateGroundingCriterion,
  isPreRegisteredGroundingCriterion,
  mcnemarUpperTailNumerator,
  nonInferior,
  type ClauseOutcome,
  type Fraction,
  type GroundingCriterionResults,
  type GroundingFigures,
  type GroundingSuccessCriterion,
  type GroundingVerdictReport,
  type GuardFigures,
  type MutantFigures,
  type NonInferiorityRule,
  type SlotPairOutcome,
} from './grounding-criterion.js';
// The Grounding Campaign's table and Slot_Pairs (testbench-spec-grounding, C16).
export {
  GROUNDING_STRATEGY_ARMS,
  groundingCells,
  slotPairs,
  type GroundingCell,
  type GroundingScope,
  type GroundingStrategyArm,
} from './grounding-table.js';
export { selectProblems } from './problem-selection.js';

// The experiment identity that scopes a resume.
export { canonicalSweepConfigJson, sweepConfigHash, type DigestHex } from './config-identity.js';

// The convenience catalog of reachable model ids (never a runtime allow-list).
export { BAKEOFF_MODEL_CATALOG } from './model-catalog.js';

// The append-only results log, its untrusted-input decoding, and the resume decision.
export {
  CompletedSampleIndex,
  decodeSampleRecord,
  encodeSampleRecord,
  instrumentVerdictOf,
  MAX_RECORDED_SURVIVORS,
  MAX_RESULTS_FILE_BYTES,
  parseResultsLog,
  recordedFormalRun,
  RESULTS_LOG_FILENAME,
  RESULTS_SCHEMA_VERSION,
  sampleKey,
  STALE_SCHEMA_ADVICE,
  type ParsedResultsLog,
  type RecordedFormalRun,
  type ResultsLogHealth,
  type ResultsLogPort,
  type SweepSampleRecord,
} from './results-log.js';
export {
  ensureDirectory,
  FileResultsLog,
  ResultsLogError,
  resultsLogPath,
} from './results-log-node.js';

// The per-sample artifact layout, and the Node-backed sink that writes it.
export {
  ARTIFACT_DOCUMENT_SCHEMA_VERSION,
  ARTIFACT_FILENAMES,
  ARTIFACTS_DIRNAME,
  artifactDocument,
  artifactSampleSegments,
  encodeArtifactDocument,
  planArtifactFiles,
  safePathSegment,
  type ArtifactDocument,
  type ArtifactFileNote,
  type ArtifactFilePlan,
  type CapturedSimulationSummary,
} from './artifact-layout.js';
export {
  FileSystemArtifactStore,
  type FileSystemArtifactStoreDeps,
} from './artifact-store-node.js';

// The corpus-level calibration cache: keyed by corpus commit + mutation config, outside any
// run directory, because a calibration is not a property of a campaign.
export {
  CALIBRATION_CACHE_DIRNAME,
  calibrationCacheDirectory,
  EVAL_CACHE_DIRNAME,
  FileSystemCalibrationCache,
  type FileSystemCalibrationCacheDeps,
} from './mutation-cache-node.js';

// Transport-level retry, backoff+jitter, and the three-state circuit breaker.
export {
  backoffDelayMs,
  classifyStatus,
  createRetryingHttpPort,
  DEFAULT_TRANSPORT_RETRY_POLICY,
  TransportCircuitBreaker,
  TransportCircuitOpenError,
  type AttemptClassification,
  type CircuitState,
  type TransportRetryDeps,
  type TransportRetryPolicy,
} from './transport-retry.js';

// The run-wide throttle observer: a slowdown, never a stop (see the breaker above for that).
export { THROTTLE_GOVERNOR_LIMITS, ThrottleGovernor } from './throttle-governor.js';

// The bounds that stop a run cleanly.
export {
  DEFAULT_KILL_SWITCH_BOUNDS,
  stopReasonFor,
  SweepKillSwitch,
  type KillSwitchBounds,
  type SweepProgress,
  type SweepStopReason,
} from './kill-switch.js';

// The run manifest: what makes a number citable.
export {
  assembleManifest,
  finalizeManifest,
  MANIFEST_FILENAME,
  MANIFEST_SCHEMA_VERSION,
  type ManifestArm,
  type ManifestCorpus,
  type ManifestExclusion,
  type ManifestFacts,
  type ManifestHarness,
  type ManifestHost,
  type ManifestInput,
  type ManifestToolchain,
  type ProbedVersion,
  type SweepManifest,
} from './manifest.js';
export {
  classifyVersionProbe,
  findWorkerPython,
  probeFormalToolchainAvailability,
  probeHarnessProvenance,
  probeHost,
  probeToolchainAvailability,
  probeToolchainVersions,
  withoutFilesystemPaths,
  yosysBuildIdOf,
  type ToolchainAvailability,
  type VersionProbeRun,
} from './host-facts.js';

// One-sample scheduling through the harness.
export {
  captureOneSample,
  scheduleOneSample,
  SLOT_NOT_SCHEDULED_DETAIL,
  type ScheduledSlot,
} from './sample-scheduler.js';

// The execution engine.
export {
  SweepRunner,
  type SweepPropertySetGate,
  type SweepRunResult,
  type SweepRunnerDeps,
} from './runner.js';

// Preflight: never start a run that cannot produce a real verdict.
export {
  checkCorpus,
  checkCredential,
  checkFormalToolchain,
  preflightFailure,
  renderPreflightFailure,
  toolchainFailure,
  type CheckoutPresencePort,
  type CredentialProbeDeps,
  type FormalToolchainProbePort,
  type ModelListAnswer,
  type ModelListProbePort,
  type PreflightFailure,
  type PreflightFailureCode,
} from './preflight.js';

// The per-arm summary, computed from the persisted records.
export {
  renderSummary,
  summarizeRecords,
  SUMMARY_FILENAME,
  type ArmCost,
  type ArmEfficiency,
  type ArmSummary,
  type ArmTokenTotals,
  type NoVerdictNoteCount,
  type SweepSummary,
} from './summary.js';

// The runnable entry.
export {
  parseSweepArgs,
  runSweep,
  runSweepCli,
  summarizeSweepRun,
  SWEEP_USAGE,
  type RunSweepOptions,
  type SweepCliResult,
  type SweepCommand,
} from './cli.js';

// The run-time credential watch: the one question answered WHILE samples land.
export { appendedSampleFacts, AuthFailureWatch, type AppendedSampleFacts } from './cli.js';

// The exit-status taxonomy, exported for the property test that grades it from `@app/test`.
export { runExitStatus, runShapeOf, type RunShape } from './cli.js';
