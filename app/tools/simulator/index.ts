// Simulator adapter: Icarus Verilog (iverilog + vvp) as the deterministic oracle
// (design "Tool_Runner and EDA adapters"; Req 2.5, 8.1). Implemented in task 3.5.
//
// The adapter drives the Tool_Runner sandbox (it does not isolate or run tools
// itself), assembling a simulate `SandboxJob`, capturing the VCD waveform, and
// interpreting the run's per-check testbench signalling into a `SimulationVerdict`
// via the core verdict rules. Real-oracle reproducibility (Property 10) is task
// 3.6; the real Icarus integration path is task 3.8.

export { IcarusSimulatorAdapter, assembleSimulateJob, interpretSandboxResult } from './adapter.js';
export type { SimulationVerdict, SimulatorAdapter, TestbenchRun } from './adapter.js';
export { readCheckSignals, readWatchdogStop } from './check-signalling.js';
export type { CheckSignalReading, WatchdogReading } from './check-signalling.js';
export { classifyRunFailure, MAX_ATTRIBUTION_LINES } from './failure-attribution.js';
export {
  DEFAULT_TIMESCALE_PROBE_CHECK,
  probeDefaultTimescale,
  type DefaultTimescaleProbeOutcome,
} from './default-timescale-probe.js';
export {
  CHECK_REPORT_TASK_NAME,
  CHECK_REPORT_TASK_PATH,
  DEFAULT_TIMESCALE,
  DUMP_LIMIT_BYTES,
  SIMULATION_HARNESS,
  SIMULATION_HARNESS_PATH,
  SIMULATION_HARNESS_VERSION,
  WATCHDOG_BUDGET_NS,
  WATCHDOG_SENTINEL,
  renderSimulationHarness,
} from './simulation-harness.js';
export type { RunFailureAttribution, RunFailureCause } from './failure-attribution.js';
export {
  CHECK_REPORT_PASS_FORMAT as CONSENSUS_HARNESS_CHECK_REPORT_PASS_FORMAT,
  CLOCK_PERIOD_NS,
  CONSENSUS_HARNESS_PATH,
  CONSENSUS_HARNESS_VERSION,
  SAMPLE_BUDGET,
  SAMPLE_END_PREFIX,
  SAMPLE_LINE_PREFIX,
  SAMPLE_SKEW_NS,
  renderConsensusHarness,
  sizedSampleBudget,
} from './consensus-harness.js';
export type { ConsensusHarnessRequest } from './consensus-harness.js';
