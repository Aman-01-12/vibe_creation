// @app/tools - Tool_Runner sandbox adapter and EDA adapters.
//
// Inward dependency: may import @app/core only. The sandbox isolation, path
// validation, and capture-all-or-error logic (tasks 3.1-3.2), the iverilog+vvp
// simulator oracle (task 3.5), the Yosys/netlistsvg synth adapter, the Yosys
// `check -assert` lint adapter, and the Yosys+Z3 formal oracle live in the subfolders
// below. The thin Python worker is the sole TS-to-Python seam and lives under
// sandbox/worker with its own project config.

import { CORE_LAYER } from '@app/core';

export * from './formal/index.js';
export * from './lint/index.js';
export * from './mutation/generator.js';
export * from './mutation/operators.js';
export * from './sandbox/index.js';
export * from './simulator/index.js';
export * from './synth/index.js';
export * from './verilog/admit-lexer.js';
export * from './verilog/declared-module.js';
export * from './verilog/int-expr.js';
export * from './verilog/property.js';
export * from './verilog/source-mask.js';
export * from './verilog/valueless-failure-report.js';

/** Layer identifier, proving inward resolution of @app/core through the scaffold. */
export const TOOLS_LAYER = `${CORE_LAYER}:tools` as const;
