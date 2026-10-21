// Orchestrator roles: intent, spec, generation, testbench (RTL-isolated),
// verification, iteration, and teach. Implemented across tasks 11, 13, 14, 16.
//
// Intent_Agent (S0, task 11.1), Spec_Agent (S1, task 11.3), the RTL-isolated
// Testbench_Agent (S6, task 13.3), the Generation_Agent (S4, task 13.1), the
// Iteration_Agent (S9, task 16.1), Teach_Mode (task 16.4), and the RTL-blind
// Property_Author (formal-property-oracle task 9.1) are implemented; the remaining
// roles land in their respective tasks and are re-exported here as they arrive.
export * from './intent/index.js';
export * from './spec/index.js';
export * from './generation/index.js';
export * from './testbench/index.js';
export * from './iteration/index.js';
export * from './teach/index.js';
export * from './property/index.js';
export * from './reference-model/index.js';
