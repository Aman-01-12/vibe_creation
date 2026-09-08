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
  DEFAULT_NEGATIVE_CONTROL_CONFIG,
  DEFAULT_NEGATIVE_CONTROL_ENABLED,
  isSingleModel,
  modelSignatureOf,
  mutationConfigFor,
  SWEEP_CONFIG_BOUNDS,
  SWEEP_CONFIG_SCHEMA_VERSION,
  SWEEP_NAME_PATTERN,
  type SweepArmConfig,
  type SweepConfig,
  type SweepModelHostConfig,
  type SweepNegativeControlConfig,
  type SweepProblemSelection,
} from './config.js';
export { parseSweepConfig } from './config-parse.js';
export type { SweepConfigError, SweepConfigErrorCode, SweepConfigResult } from './config-values.js';
export { parseArms, parseProblemSelection } from './config-arms.js';
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
  RESULTS_LOG_FILENAME,
  RESULTS_SCHEMA_VERSION,
  sampleKey,
  STALE_SCHEMA_ADVICE,
  type ParsedResultsLog,
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
  type SweepManifest,
} from './manifest.js';
export {
  findWorkerPython,
  probeHarnessProvenance,
  probeHost,
  probeToolchainAvailability,
  probeToolchainVersions,
  type ToolchainAvailability,
} from './host-facts.js';

// One-sample scheduling through the harness.
export {
  captureOneSample,
  scheduleOneSample,
  SLOT_NOT_SCHEDULED_DETAIL,
  type ScheduledSlot,
} from './sample-scheduler.js';

// The execution engine.
export { SweepRunner, type SweepRunResult, type SweepRunnerDeps } from './runner.js';

// Preflight: never start a run that cannot produce a real verdict.
export {
  checkCorpus,
  checkCredential,
  preflightFailure,
  renderPreflightFailure,
  toolchainFailure,
  type CheckoutPresencePort,
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
