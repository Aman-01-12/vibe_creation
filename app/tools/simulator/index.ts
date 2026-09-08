// Simulator adapter: Icarus Verilog (iverilog + vvp) as the deterministic oracle
// (design "Tool_Runner and EDA adapters"; Req 2.5, 8.1). Implemented in task 3.5.
//
// The adapter drives the Tool_Runner sandbox (it does not isolate or run tools
// itself), assembling a simulate `SandboxJob`, capturing the VCD waveform, and
// interpreting the run's per-check testbench signalling into a `SimulationVerdict`
// via the core verdict rules. Real-oracle reproducibility (Property 10) is task
// 3.6; the real Icarus integration path is task 3.8.

export { IcarusSimulatorAdapter, assembleSimulateJob, interpretSandboxResult } from './adapter.js';
export type { SimulationVerdict, SimulatorAdapter } from './adapter.js';
export { readCheckSignals } from './check-signalling.js';
export type { CheckSignalReading } from './check-signalling.js';
