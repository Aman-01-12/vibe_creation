// Orchestrator: spine stages, generation gate (Property 13), Verification_Loop,
// and the self-healing failure-recovery loop.
//
// Task 6.1 lands the M0 skeleton: the oracle-path spine that compiles and
// simulates a validated module + testbench through the Simulator adapter, records
// the run via the Action_Recorder, and reports pass/fail/error bounded by the
// sandbox wall-clock cap. The M1 agentic stages (intent, spec, generation,
// testbench, verification loop, iteration, teach) and the Session_Budget arrive in
// later tasks (11.6, 14, 8.1).

export {
  OrchestratorSkeleton,
  type SkeletonSimulationRequest,
  type SkeletonSimulationResult,
} from './skeleton.js';

// The generation gate (task 11.6): the structural + runtime barrier that admits
// the Generation_Agent only when intent is confirmed AND the Spec is approved,
// persists the approved Spec as source of truth through an injected port on
// admission, and records every gate decision. Property 13 (task 11.7) states
// directly over `GenerationGate`.
export {
  ConfirmedGenerationContext,
  GenerationGate,
  type ApprovedSpecPersistInput,
  type GenerationAdmissionRequest,
  type GenerationGateDeps,
  type GenerationGateRefusal,
  type GenerationGateRefusalReason,
  type GenerationRunner,
  type SpecApprovalReceipt,
  type SpecApprovalSink,
  type SpecApprovalSinkError,
} from './generation-gate.js';

// The Verification_Loop (task 14.1): the M1 agentic hero loop that runs generation
// and independent testbench generation in parallel, treats the Simulator verdict as
// sole authority, iterates generate-simulate-fix under one Session_Budget, requests
// `Verified` from the Trust_Labeler bound to the passing oracle span, and on
// exhaustion presents the failing case labeled `Unverified` with a Teach_Mode
// handoff seam. Its integration test is task 14.2; its self-healing loop is 14.3.
export {
  NO_REPAIR,
  VerificationLoop,
  type CandidateGenerator,
  type GenerationContextOpener,
  type IndependentTestbenchGenerator,
  type InstrumentRefusalReason,
  type InstrumentRefusedModule,
  type RepairProvenance,
  type SetupFailureCause,
  type TeachModeHandoff,
  type UnverifiedModule,
  type VerificationBlocked,
  type VerificationLoopDeps,
  type VerificationOutcome,
  type VerificationPhase,
  type VerificationProgressEvent,
  type VerificationSetupFailed,
  type VerifiedModule,
} from './verification-loop.js';

// The self-healing failure-recovery loop (task 14.3): the recovery layer that wires
// AROUND the Verification_Loop. It detects a failure signal, classifies it into one
// of syntax error / simulation timeout / tool crash / malformed model output,
// selects a targeted recovery ladder (fix-and-retry, backoff, re-plan, fallback
// model, or escalate), verifies every recovery through the deterministic oracle,
// and records the full detect -> classify -> recover -> verify trajectory - all
// bounded by the SAME Session_Budget, never blind-retrying and always failing safe.
// The "fallback model" recovery routes through the Model_Router's existing
// escalation path via `Generation_Agent.reviseWithFallbackModel`. Its unit test is
// task 14.4.
export {
  SelfHealingLoop,
  backoffDelayMs,
  classifyFailure,
  coreFailureClass,
  recoveryLadderFor,
  type BackoffSchedule,
  type EscalatedFailure,
  type EscalationReason,
  type FailureCategory,
  type FailureSignal,
  type RecoveredFailure,
  type RecoveryAction,
  type RecoveryContext,
  type RecoveryGenerator,
  type RecoveryOutcome,
  type RecoveryStep,
  type SelfHealingLoopDeps,
} from './self-healing.js';

// The Instrument_Admission port (task 3.5): consulted by the Verification_Loop at
// most once per run, before the first iteration, to learn whether a generated
// Testbench is an admissible measuring instrument. No implementation lives here -
// see `app/eval/instrument-admission.ts` for the eval-layer adapter.
export {
  type InstrumentAdmission,
  type InstrumentAdmissionDecision,
  type InstrumentAdmissionRequest,
} from './instrument-admission.js';

// The build constant identifying the Verification_Loop's instrument-admission
// behaviour (task 3.5), folded into the experiment identity the same way
// `TESTBENCH_PROMPT_VERSION` is.
export { INSTRUMENT_POLICY_VERSION } from './instrument-policy-version.js';

// The build constant identifying the testbench-repair-loop's behaviour (task
// 6.3): whether `#admitInstrument` attempts a precheck-path repair, and whether
// the harness attempts a positive-control-path repair, folded into the
// experiment identity the same way `INSTRUMENT_POLICY_VERSION` is.
export { TESTBENCH_REPAIR_POLICY_VERSION } from './testbench-repair-policy-version.js';

// The Testbench_Precheck (task 3.1): a deterministic, model-free build check of a
// generated Testbench against a Spec-derived Interface_Stub, run once before the
// first repair iteration. See `app/tools/simulator/adapter.ts` for the
// `SimulationVerdict.failureCause` / `attributedFiles` fields this check reads.
export {
  buildInterfaceStub,
  TestbenchPrecheck,
  type PrecheckOutcome,
} from './testbench-precheck.js';

// The Repair_Hint vocabulary and its one builder (testbench-repair-loop task
// 1.1/1.2): the closed `DefectClass` enum, the two-member `RepairHint` union, the
// `RepairTrigger` a hint is built from, and the pure `buildRepairHint` /
// `ruleFamilyFor` functions. Exported here (rather than deferred to task 10.10)
// because the property tests task 1.4 adds can only reach this module through
// `@app/agent`'s package export map, which resolves `dist/index.js` alone.
export {
  buildRepairHint,
  ruleFamilyFor,
  type BuildDiagnosticHint,
  type ClassifiedFunctionalHint,
  type DefectClass,
  type RepairHint,
  type RepairTrigger,
} from './repair-hint.js';

// The Testbench_Repair port (task 6.2): consulted by the Eval_Harness for a
// Positive_Control-caused Repair_Trigger, before that sample's Session_Budget is
// read for the record. No implementation lives here - see
// `app/eval/testbench-repair.ts` for `EvalTestbenchRepair`.
export {
  type TestbenchRepair,
  type TestbenchRepairDecision,
  type TestbenchRepairDeclined,
  type TestbenchRepairOutcome,
  type TestbenchRepairRequest,
  type TestbenchRepairResult,
} from './testbench-repair.js';
