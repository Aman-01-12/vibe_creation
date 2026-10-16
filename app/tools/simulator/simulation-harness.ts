// The product-written Simulation_Harness (testbench-spec-grounding, C6): the sole owner of
// `dump.vcd` and the Watchdog that ends a hung Testbench_Run in simulated time.
//
// It is an uninstantiated second root module that reads nothing from the testbench; the
// testbench reaches only its Check_Report_Task, by hierarchical name. Its inputs are two numbers.

import type { SourceFile } from '../sandbox/contract.js';

/**
 * Moves whenever the harness text, the budget, the dump limit, or the timescale entry moves.
 *   3 - adds the `ece_check` Check_Report_Task (testbench-failure-reportability); dump,
 *       Watchdog, budget, and dump limit are byte-identical to 2.
 */
export const SIMULATION_HARNESS_VERSION = 3;

/**
 * The Watchdog_Budget in 1 ns units, MEASURED by the Replay_Gate's select pass (C12, Req 6.5).
 *
 * The largest simulated end time of any finishing run over the 489-sample Replay_Set was
 * 1,728,040 ns, and 2,000,000 is the smallest Round_Value above it. At this budget a hang on a
 * 1 ns clock reaches the Watchdog in roughly 2 million events, which is inside the 15 s wall
 * bound of Requirement 6.6; the 20,000,000 placeholder was not.
 */
export const WATCHDOG_BUDGET_NS = 2_000_000;

/** `$dumplimit` in bytes: a hung dumping run stops writing here and keeps running. */
export const DUMP_LIMIT_BYTES = 16_777_216;

/** The one line the Watchdog prints before `$finish`; the Check_Reader matches it exactly. */
export const WATCHDOG_SENTINEL = 'ECE_WATCHDOG_TIMEOUT';

/** The default timescale every Testbench_Run compiles under, so `#` delays have a unit. */
export const DEFAULT_TIMESCALE = '1ns/1ps' as const;

/** A hyphenated path, so no identifier-derived RTL or testbench path can collide with it. */
export const SIMULATION_HARNESS_PATH = 'ece-simulation-harness.v';

/** The root module's name, which is also its instance name for a hierarchical call. */
const SIMULATION_HARNESS_MODULE = 'ece_simulation_harness';

/** 128 chars: the longest Required_Check name measured over the corpus is 44. */
const CHECK_NAME_BITS = 1024;

// ponytail: 128 bits fits the widest measured value (65 bits), but a wider one truncates and a
// SIGNED actual sign-extends, so a negative expectation prints 32 hex digits (DQ-03). Upgrade
// path is a fourth width argument, which costs Requirement 1.1's three-argument signature.
const CHECK_VALUE_BITS = 128;

/** The two printed forms, exported so the prompt and the tests read one owner, not three. */
export const CHECK_REPORT_PASS_FORMAT = 'CHECK %0s PASS' as const;
export const CHECK_REPORT_FAIL_FORMAT = 'CHECK %0s FAIL: expected %0h, got %0h' as const;

/** The one name the prompt states and the testbench calls. */
export const CHECK_REPORT_TASK_NAME = 'ece_check' as const;

/** The hierarchical path a separate compilation input calls it by. */
export const CHECK_REPORT_TASK_PATH = `${SIMULATION_HARNESS_MODULE}.${CHECK_REPORT_TASK_NAME}`;

/** `automatic` keeps the formals off module storage, so no call sees another's state. */
const CHECK_REPORT_TASK_LINES = [
  "  // Check_Report_Task: we own the report; the comparison and both values stay the testbench's.",
  `  task automatic ${CHECK_REPORT_TASK_NAME}(input [${String(CHECK_NAME_BITS - 1)}:0] name, ` +
    `input [${String(CHECK_VALUE_BITS - 1)}:0] expected, ` +
    `input [${String(CHECK_VALUE_BITS - 1)}:0] actual);`,
  '    begin',
  // `===` so an `x` actual reads FAIL rather than PASS.
  '      if (expected === actual) begin',
  `        $display("${CHECK_REPORT_PASS_FORMAT}", name);`,
  '      end else begin',
  `        $display("${CHECK_REPORT_FAIL_FORMAT}", name, expected, actual);`,
  '      end',
  '    end',
  '  endtask',
] as const;

/** The dump limit is a 32-bit Verilog literal, so a larger value would silently truncate. */
const MAX_DUMP_LIMIT_BYTES = 0xffff_ffff;

/** Refuse a value that would reach Verilog text as anything but a positive integer literal. */
function requirePositiveSafeInteger(name: string, value: number, max: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${String(max)}`);
  }
}

/** Pure: the harness file for a budget and a dump limit, each a positive safe integer. */
export function renderSimulationHarness(
  watchdogBudgetNs: number,
  dumpLimitBytes: number,
): SourceFile {
  requirePositiveSafeInteger('watchdogBudgetNs', watchdogBudgetNs, Number.MAX_SAFE_INTEGER);
  requirePositiveSafeInteger('dumpLimitBytes', dumpLimitBytes, MAX_DUMP_LIMIT_BYTES);
  const contents = [
    '`timescale 1ns/1ps',
    '// Product-written Simulation_Harness: sole owner of dump.vcd, and the Watchdog.',
    `module ${SIMULATION_HARNESS_MODULE};`,
    '  // Watchdog_Budget: a liveness bound in ns, not a latency claim about any design.',
    `  localparam [63:0] WATCHDOG_BUDGET_NS = 64'd${String(watchdogBudgetNs)};`,
    `  localparam [31:0] DUMP_LIMIT_BYTES = 32'd${String(dumpLimitBytes)};`,
    ...CHECK_REPORT_TASK_LINES,
    '  initial begin',
    '    $dumpfile("dump.vcd");',
    '    $dumplimit(DUMP_LIMIT_BYTES);',
    '    $dumpvars;',
    '  end',
    '  initial begin',
    '    #(WATCHDOG_BUDGET_NS);',
    `    $display("${WATCHDOG_SENTINEL}");`,
    '    $finish;',
    '  end',
    'endmodule',
    '',
  ].join('\n');
  return { path: SIMULATION_HARNESS_PATH, contents };
}

/** The harness every Testbench_Run compiles, rendered once from the two constants. */
export const SIMULATION_HARNESS: SourceFile = renderSimulationHarness(
  WATCHDOG_BUDGET_NS,
  DUMP_LIMIT_BYTES,
);
