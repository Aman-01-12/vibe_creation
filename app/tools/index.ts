// @app/tools - Tool_Runner sandbox adapter and EDA adapters.
//
// Inward dependency: may import @app/core only. The sandbox isolation, path
// validation, and capture-all-or-error logic (tasks 3.1-3.2), the iverilog+vvp
// simulator oracle (task 3.5), and the Yosys/netlistsvg synth adapter live in the
// subfolders below. The thin Python worker is the sole TS-to-Python seam and lives
// under sandbox/worker with its own project config.

import { CORE_LAYER } from '@app/core';

export * from './sandbox/index.js';
export * from './simulator/index.js';
export * from './synth/index.js';

/** Layer identifier, proving inward resolution of @app/core through the scaffold. */
export const TOOLS_LAYER = `${CORE_LAYER}:tools` as const;
