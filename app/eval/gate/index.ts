// The eval-gate arming machinery (task 19.5).
//
// This subpackage turns the pure `decideEvalGate` rule (task 19.1) and the
// Eval_Harness (task 19.3) into a runnable CI gate: it reads the version-controlled
// `eval-baseline.json`, resolves it to an `EvalGate`, measures pass@k (through the
// real oracle when wired), and applies the ratcheting decision. It is unarmed by
// default and never blocks while unarmed (Req 15.7), but runs the real decision
// path so it is ready to block the moment a verified baseline is recorded.

export {
  parseBaselineConfig,
  type BaselineConfigError,
  type BaselineConfigErrorCode,
  type BaselineProvenance,
  type ParsedBaselineConfig,
} from './baseline-config.js';

export { decideGateRun, type GateMeasurement, type GateRunResult } from './gate-run.js';

export {
  createDefaultMeasurementProvider,
  measureViaHarness,
  probeOracleToolchain,
  type GateMeasurementProvider,
  type OracleToolchainProbe,
} from './measure.js';

export { runEvalGate, type RunEvalGateOptions } from './cli.js';
