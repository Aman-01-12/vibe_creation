// Orchestrator roles: intent, spec, generation, testbench (RTL-isolated),
// verification, iteration, and teach. Implemented across tasks 11, 13, 14, 16.
//
// Intent_Agent (S0, task 11.1), Spec_Agent (S1, task 11.3), the RTL-isolated
// Testbench_Agent (S6, task 13.3), the Generation_Agent (S4, task 13.1), the
// Iteration_Agent (S9, task 16.1), and Teach_Mode (task 16.4) are implemented; the
// remaining roles land in their respective tasks and are re-exported here as they
// arrive.
export * from './intent/index.js';
export * from './spec/index.js';
export * from './generation/index.js';
export * from './testbench/index.js';
export * from './iteration/index.js';
export * from './teach/index.js';
