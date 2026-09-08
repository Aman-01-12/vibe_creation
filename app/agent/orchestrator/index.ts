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
  VerificationLoop,
  type CandidateGenerator,
  type GenerationContextOpener,
  type IndependentTestbenchGenerator,
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
