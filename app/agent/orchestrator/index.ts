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
