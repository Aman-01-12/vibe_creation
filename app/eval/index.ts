// @app/eval - the Eval_Harness and the fixed VerilogEval/RTLLM subset (Req 15).
//
// Consumer layer: it may import the inner layers down to `api` to drive the loop
// end to end, and only `@app/test` imports it (see `app/README.md` for the layer
// map). The Eval_Harness (task 19.3) runs the fixed subset through the
// Verification_Loop inside the Tool_Runner sandbox under student-session caps, and
// reports + records pass@k, iterations-to-pass, and per-session cost with fixed
// seeds/temperature/sample count for reproducibility. Its integration test is task
// 19.4 and the CI arming is task 19.5.

import { API_LAYER } from '@app/api';

/** Layer identifier, proving the eval harness resolves the full inner chain. */
export const EVAL_LAYER = `${API_LAYER}:eval` as const;

// The harness and its configuration.
export { EvalHarness, createEvalHarness, type EvalHarnessDeps } from './harness.js';

// The reproducibility configuration and per-sample seed derivation (Req 15.10).
export {
  makeReproducibilityConfig,
  sampleSeed,
  type ReproducibilityConfig,
} from './reproducibility.js';

// The pure pass@k estimator and its aggregation (Req 15.2).
export { passAtK, meanPassAtK } from './metrics.js';
// The Replay_Gate (testbench-spec-grounding, C12): the model-free check that this spec's
// harness pipeline moves no recorded verdict, plus the Watchdog_Budget selection.
export {
  collectReplaySet,
  parseReplayGateArgs,
  runReplayGate,
  type ReplayGateArgs,
} from './scripts/replay-gate.js';
export {
  MAX_WATCHDOG_WALL_MS,
  REPLAY_ENDINGS,
  decideReplayGate,
  replayRunOf,
  roundValueAbove,
  simulatedEndNs,
  type ReplayEnding,
  type ReplayGateInput,
  type ReplayGateReport,
  type ReplayPair,
  type ReplayRun,
  type ReplaySampleKey,
} from './replay-gate.js';

// The fixed smoke subset and its shape (Req 15.1). The real, benchmark-sized corpus
// is the RTLLM import below; this hand-written trio stays as the harness's
// toolchain-free smoke subset and is what the recorded eval baseline references.
export { FIXED_EVAL_SUBSET } from './subset.js';
export type { EvalProblem, EvalProblemSource } from './problem.js';

// The RTLLM corpus: pinned fetch, import, and the independent golden testbench judge.
export * from './corpus/index.js';

// The independent-judge seam the harness records a SECOND verdict through, plus the
// agreement summary that measures whether our own testbenches catch bugs.
export {
  NO_AGREEMENT_MEASURED,
  summarizeAgreement,
  type AgreementReport,
  type GoldenJudge,
  type GoldenJudgeRequest,
  type RecordedGoldenVerdict,
  type VerdictPair,
} from './golden-judge.js';

// The loop-runner seam and the student-session caps threaded into every sample.
export type { EvalLoopRunner, EvalSampleRequest, StudentSessionCaps } from './loop-runner.js';

// The POSITIVE CONTROL seam: our own generated testbench run against the benchmark's
// known-good reference design, plus THE pass@k denominator invariant it enforces.
export {
  combineInstrumentControls,
  countsInPassAtK,
  describeInstrumentVerdict,
  instrumentControlMeasured,
  invalidInstrument,
  NO_INSTRUMENT_CONTROL_MEASURED,
  reachedOracleVerdict,
  summarizeInstrumentControl,
  uncheckedInstrument,
  VALID_INSTRUMENT,
  type CombinedControls,
  type InstrumentControl,
  type InstrumentControlReport,
  type InstrumentControlRequest,
  type InstrumentControlResult,
  type InstrumentDefectCode,
  type InstrumentSample,
  type InstrumentUncheckedReason,
  type InstrumentValidity,
  type PassAtKEligibility,
  type RecordedInstrumentVerdict,
} from './instrument-control.js';

// WHY a sample reached no oracle verdict, as a typed value, plus the deferral rule that
// decides whether the matrix cell is finished. The vocabulary is exported because a consumer
// that restates it by hand gets no totality check, and an unlisted cause reads as final.
export {
  describeNoVerdictCause,
  isDeferrableCause,
  isDeferredSample,
  noVerdictCauseOf,
  NO_VERDICT_CAUSES,
  type ClassifiableOutcome,
  type NoVerdictCause,
} from './no-verdict-cause.js';

// The NEGATIVE CONTROL seam: deliberately broken versions of the reference design. Our
// testbench is SCORED over the valid mutant set - every mutant that compiles - and GATED on
// zero coverage-gap survivors, the mutants the independent golden testbench itself killed. So a
// testbench that passes everything is caught, nothing is excluded on an undecidable equivalence
// claim, and nothing is demanded that no testbench could deliver.
export {
  allSurvivors,
  canonicalMutationConfig,
  DEFAULT_MAX_MUTANTS_PER_PROBLEM,
  DEFAULT_MUTANT_WALL_MS,
  DEFAULT_MUTATION_CONFIG,
  describeMutationUnavailable,
  identityOf,
  judgeCoverageGaps,
  killRateOf,
  MAX_MUTANT_WALL_MS,
  MAX_MUTANTS_PER_PROBLEM_LIMIT,
  MAX_SITE_TEXT_CHARS,
  MIN_MUTANT_WALL_MS,
  mutantIdOf,
  mutantIsValid,
  mutantRunLimits,
  mutantWasGoldenKilled,
  MUTATION_OPERATORS,
  mutationControlMeasured,
  NO_MUTATION_CONTROL_MEASURED,
  recordedMutationCounts,
  reportedFailureKills,
  summarizeMutationControl,
  type CoverageGapVerdict,
  type Mutant,
  type MutantCalibration,
  type MutantIdentity,
  type MutantKillKind,
  type MutationConfig,
  type MutationControlReport,
  type MutationNegativeControl,
  type MutationOperatorId,
  type MutationProbeOutcome,
  type MutationProbeReport,
  type MutationProbeRequest,
  type MutationSample,
  type MutationSampleCounts,
  type MutationSite,
  type MutationUnavailableReason,
  type SurvivedOperatorCount,
} from './mutation-control.js';

// The SAME negative-control rule pointed at the PROPERTY SET rather than the testbench, over
// the SAME mutant set and with its OWN denominator - a mutant the formal frontend could not
// read is counted and excluded here while staying a valid mutant above, which is why the two
// kill rates may never share a denominator (Req 9.1, 9.2, 9.3, 9.5, 9.6, 9.7, 9.8). Reads a
// reference design, so it lives here and is unreachable from the product path (Req 10.7).
export {
  admitPropertySet,
  formalCalibrationOf,
  formalKillRateOf,
  formalMutantIsScorable,
  formalMutationCounts,
  mutantIsInPropertySetGateSet,
  propertySetAdmissionFallsBack,
  propertySetAdmissionOutcomeOf,
  propertySetSurvivorCountOf,
  FORMAL_CALIBRATION_ADMITS_TO_DENOMINATOR,
  type CalibratedFormalMutant,
  type FormalMutantCalibration,
  type FormalMutationCounts,
  type PropertySetAdmission,
  type PropertySetGate,
  type PropertySetGateRequest,
} from './property-set-admission.js';

// The PRODUCTION measurement behind that gate (Req 6.1, 6.2, 6.8): RTLLM reference mutants,
// the independent judge on the golden side, and the real Formal_Oracle on the formal side. It
// supplies the population and `admitPropertySet` above applies the rule, and it passes mutant
// IDENTITIES so no mutated reference RTL can ride onto a refusal.
export { RtllmPropertySetGate, type RtllmPropertySetGateDeps } from './property-set-gate-rtllm.js';

// The optional per-sample ARTIFACT seam: the bounded, sanitized evidence that makes a
// disagreement between our own testbench and the independent judge diagnosable.
export {
  ARTIFACT_CAPS,
  candidateRtlOf,
  captureSampleArtifacts,
  MAX_COUNTEREXAMPLE_TRACE_BYTES,
  testbenchSourceOf,
  type ArtifactCaptureInput,
  type CapturedCheckVerdict,
  type CapturedEnd,
  type CapturedFailingCase,
  type CapturedOutcome,
  type CapturedSimulation,
  type CapturedText,
  type EvalArtifactDescriptor,
  type EvalArtifactSink,
  type EvalSampleArtifacts,
} from './artifact-sink.js';

// The eval-layer InstrumentAdmission adapter (Req 4.10, 4.11, 4.12, 4.15, 8.5; task 6.4):
// backs the Instrument_Admission port the Verification_Loop consults with the SAME
// InstrumentControl the harness already records through, so a sample's instrument is
// measured once and described once.
export { MemoizingInstrumentAdmission } from './instrument-admission.js';

// The per-sample Property_Set authoring the gate and the loop share: one authoring call, so
// the gate scores the same artifact the loop was handed and the sample pays one model call.
export { MemoizingPropertySetSource } from './memoizing-property-set-source.js';

// The admission stamp that carries the gate's verdict into the loop: without it the
// PropertyAgent's 'not-gated' stamp would let a refused Property_Set decide a sample.
export { AdmissionStampingPropertySource } from './admission-stamping-property-source.js';

// The eval routing policy: every role on the bedrock-mantle host with a per-role
// model id - the permutation knob for a per-role model bake-off (Req 15.10).
export {
  evalRoutingPolicy,
  singleModelEvalRoutingPolicy,
  type EvalRoleFallbackModels,
  type EvalRoleModels,
  type EvalRoutingPolicyInput,
} from './routing-policy.js';

// The production loop-runner adapter (task 19.4): the real agentic loop against the
// real Simulator oracle, with the oracle-decided outcome returned untouched.
export {
  EvalVerificationLoopRunner,
  HEADLESS_EVAL_APPROVAL_SINK,
  type EvalModelHostConfig,
  type EvalVerificationLoopRunnerDeps,
} from './verification-loop-runner.js';

// The metered per-session budget the harness threads through one sample.
export { MeteredSessionBudget, type BudgetConsumption } from './metered-budget.js';

// The sanitized, bounded note that says WHY a sample produced no oracle verdict, so a
// campaign of `blocked` / `setup-failed` samples is diagnosable rather than opaque.
export { failureNoteOf, MAX_FAILURE_NOTE_LENGTH } from './failure-note.js';

// Every limit this spec's measurements run under, each naming a reason that is not cost
// (Req 12.1, 12.2, 12.3). A measurement asks for its limit by name and refuses to start
// when the registry does not hold it.
export {
  DECLARED_LIMITS,
  LIMIT_REASONS,
  limitOrRefuse,
  type LimitReason,
  type MeasurementLimit,
} from './measurement-limit.js';

// The report shapes and the recorder port (Req 15.2, 15.5).
export type {
  CostEnvelopeReport,
  CostViolation,
  EvalRunRecorder,
  EvalRunReport,
  ProblemResult,
  SampleOutcomeStatus,
  SampleResult,
} from './report.js';

// The runnable model bake-off SWEEP: the declarative campaign config, resumable
// checkpointed execution over the scored RTLLM corpus, the citable run manifest, the
// transport-level retry + circuit breaker, the kill switch, and the per-arm summary.
export * from './sweep/index.js';

// The ratcheting CI gate machinery: baseline config, decision, measurement, and
// the runnable entry (task 19.5, Req 15.4, 15.7). Unarmed by default.
export {
  createDefaultMeasurementProvider,
  decideGateRun,
  measureViaHarness,
  parseBaselineConfig,
  probeOracleToolchain,
  runEvalGate,
  type BaselineConfigError,
  type BaselineConfigErrorCode,
  type BaselineProvenance,
  type GateMeasurement,
  type GateMeasurementProvider,
  type GateRunResult,
  type OracleToolchainProbe,
  type ParsedBaselineConfig,
  type RunEvalGateOptions,
} from './gate/index.js';
// The Property_Only_Measurement record and its codec: a property-only figure labelled by a
// literal, split into two populations, and persisted where no end-to-end report reads it
// (Req 5.16, 9.1, 9.9).
export {
  decodePropertyOnlyMeasurement,
  encodePropertyOnlyMeasurement,
  PROPERTY_ONLY_MEASUREMENT_KIND,
  PROPERTY_ONLY_SCHEMA_VERSION,
  type DesignPopulation,
  type PropertyOnlyDesignResult,
  type PropertyOnlyMeasurement,
  type PropertyOnlyOutcome,
  type PropertyOnlyPropertyResult,
  type PropertyOnlyVerdict,
} from './property-only/record.js';
// The report over that record: one block per Authoring_Model, no pooled figure, and the
// property-only figure kept separate from an End_To_End_Formal_Rate (Req 5.14, 9.3).
export { renderPropertyOnlyReport } from './property-only/report.js';
// The Property_Only_Mode's own configuration: its own type, never the sweep's, so the mode whose
// path omits Instrument_Admission is not reachable as a flag on the product path (Req 10.2, 10.4).
export {
  bypassShapedKeyIn,
  DEFAULT_AUTHORING_MODELS,
  parsePropertyOnlyConfig,
  PROPERTY_ONLY_CONFIG_KEYS,
  REQUIRED_AUTHORING_MODELS,
  type PropertyOnlyConfig,
  type PropertyOnlyConfigResult,
} from './property-only/config.js';
// The Property_Only_Mode entry point: the Cost_Pilot gate, the Anomaly_Guard, and the refusals
// that must hold before a token is spent (Req 1.7, 5.6, 5.8, 9.10, 9.11, 12.4).
export {
  anomalyBreachOf,
  declaredLimitsOrRefuse,
  dispatchPlanFor,
  measureDesign,
  measurementPath,
  OMITTED_STUDENT_PATH_STEPS,
  parsePropertyOnlyArgs,
  perDesignExtrapolationOf,
  PROPERTY_ONLY_MEASUREMENT_FILENAME,
  PROPERTY_ONLY_REPORT_FILENAME,
  PROPERTY_ONLY_USAGE,
  recordedLimitsFor,
  runPropertyOnly,
  runPropertyOnlyCli,
  supersessionNote,
  SUPERSEDED_RUN_DIR,
  SUPERSESSION_NOTE_FILENAME,
  workerIsolationFailure,
  type AnomalyBreach,
  type DesignFigures,
  type DispatchPlan,
  type DispatchPlanInput,
  type DispatchScope,
  type PerDesignExtrapolation,
  type PropertyOnlyCliResult,
  type PropertyOnlyCommand,
  type PropertyOnlyDesign,
  type PropertyOnlyStack,
  type RunLimits,
  type RunPropertyOnlyOptions,
} from './property-only/cli.js';
