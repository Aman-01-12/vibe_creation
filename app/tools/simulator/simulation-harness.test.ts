// The Simulation_Harness text is pinned beside its version, so a text change that forgets to
// move SIMULATION_HARNESS_VERSION fails here (testbench-spec-grounding C6,
// testbench-failure-reportability C1).

import { createHash } from 'node:crypto';

import { describe, expect, expectTypeOf, it } from 'vitest';

import type { ResourceLimits, SourceFile } from '../sandbox/contract.js';
import { assembleSimulateJob } from './adapter.js';
import {
  CHECK_REPORT_FAIL_FORMAT,
  CHECK_REPORT_PASS_FORMAT,
  CHECK_REPORT_TASK_NAME,
  CHECK_REPORT_TASK_PATH,
  DUMP_LIMIT_BYTES,
  SIMULATION_HARNESS,
  SIMULATION_HARNESS_PATH,
  SIMULATION_HARNESS_VERSION,
  WATCHDOG_BUDGET_NS,
  WATCHDOG_SENTINEL,
  renderSimulationHarness,
} from './simulation-harness.js';

const PINNED_HARNESS_VERSION = 3;
const PINNED_HARNESS_DIGEST = '59e9f1310095b5a40e9af1bd11466744b92f59075832a7e720272645d7bbd2e0';

/** Every identifier the harness may contain: Verilog keywords plus its own declared names. */
const HARNESS_VOCABULARY = new Set([
  'module',
  'endmodule',
  'localparam',
  'task',
  'automatic',
  'input',
  'endtask',
  'begin',
  'end',
  'if',
  'else',
  'initial',
  'ece_simulation_harness',
  'WATCHDOG_BUDGET_NS',
  'DUMP_LIMIT_BYTES',
  CHECK_REPORT_TASK_NAME,
  'name',
  'expected',
  'actual',
]);

const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 32, diskMb: 128, wallMs: 30_000 };

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The identifiers in Verilog text, minus directives, comments, strings, and sized literals. */
function identifiersOf(text: string): string[] {
  const code = text
    .replace(/^`.*$/gm, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/"[^"]*"/g, '')
    .replace(/\d+'[dhbo][0-9a-fA-F_]+/g, '');
  return code.match(/(?<![$\w])[A-Za-z_]\w*/g) ?? [];
}

describe('SIMULATION_HARNESS', () => {
  it('is pinned with its version', () => {
    expect(SIMULATION_HARNESS_VERSION).toBe(PINNED_HARNESS_VERSION);
    expect(sha256(SIMULATION_HARNESS.contents)).toBe(PINNED_HARNESS_DIGEST);
    expect(SIMULATION_HARNESS.path).toBe(SIMULATION_HARNESS_PATH);
  });

  it('states the budget as exactly one localparam under its liveness comment', () => {
    const lines = SIMULATION_HARNESS.contents.split('\n');
    const budgetLines = lines.filter((line) => line.includes('WATCHDOG_BUDGET_NS ='));
    expect(budgetLines).toEqual([
      `  localparam [63:0] WATCHDOG_BUDGET_NS = 64'd${String(WATCHDOG_BUDGET_NS)};`,
    ]);
    const at = lines.indexOf(budgetLines[0] ?? '');
    expect(lines[at - 1]).toContain('a liveness bound in ns, not a latency claim');
    expect(SIMULATION_HARNESS.contents).toContain(`32'd${String(DUMP_LIMIT_BYTES)};`);
  });

  it('keeps the dump and the Watchdog at their shipped values', () => {
    expect(WATCHDOG_BUDGET_NS).toBe(2_000_000);
    expect(DUMP_LIMIT_BYTES).toBe(16_777_216);
    const text = SIMULATION_HARNESS.contents;
    for (const line of [
      '    $dumpfile("dump.vcd");',
      '    $dumplimit(DUMP_LIMIT_BYTES);',
      '    $dumpvars;',
      '    #(WATCHDOG_BUDGET_NS);',
      `    $display("${WATCHDOG_SENTINEL}");`,
      '    $finish;',
    ]) {
      expect(text.split('\n')).toContain(line);
    }
  });

  it('declares exactly one module and exactly one reporting task, at the stated path', () => {
    const text = SIMULATION_HARNESS.contents;
    expect(text.match(/\bmodule\b/g)).toHaveLength(1);
    expect(text.match(/\bendmodule\b/g)).toHaveLength(1);
    expect(text.match(/\btask\b/g)).toHaveLength(1);
    expect(text.match(/\bendtask\b/g)).toHaveLength(1);
    expect(text).toContain(
      `  task automatic ${CHECK_REPORT_TASK_NAME}(input [1023:0] name, ` +
        'input [127:0] expected, input [127:0] actual);',
    );
    expect(CHECK_REPORT_TASK_PATH).toBe('ece_simulation_harness.ece_check');
  });

  it('holds exactly one comparison, a four-state one, and one display per branch', () => {
    const text = SIMULATION_HARNESS.contents;
    expect(text.match(/===|!==|==|!=|<=|>=/g)).toEqual(['===']);
    expect(text).toContain('      if (expected === actual) begin');
    expect(text).toContain(`        $display("${CHECK_REPORT_PASS_FORMAT}", name);`);
    expect(text).toContain(
      `        $display("${CHECK_REPORT_FAIL_FORMAT}", name, expected, actual);`,
    );
    expect(CHECK_REPORT_PASS_FORMAT).toBe('CHECK %0s PASS');
    expect(CHECK_REPORT_FAIL_FORMAT).toBe('CHECK %0s FAIL: expected %0h, got %0h');
  });

  it('contains no identifier outside its own declared names', () => {
    const strays = identifiersOf(SIMULATION_HARNESS.contents).filter(
      (id) => !HARNESS_VOCABULARY.has(id),
    );
    expect(strays).toEqual([]);
  });

  it('takes the two numbers and nothing else', () => {
    expect(renderSimulationHarness).toHaveLength(2);
    expectTypeOf(renderSimulationHarness).parameters.toEqualTypeOf<[number, number]>();
    expect(renderSimulationHarness(WATCHDOG_BUDGET_NS, DUMP_LIMIT_BYTES)).toEqual(
      SIMULATION_HARNESS,
    );
  });

  it('is the one value every Testbench_Run compiles, whichever Strategy_Arm wrote it', () => {
    // The job carries no arm, so a Control_Arm run and a Grounded_Arm run differ only in checks.
    const testbench: SourceFile = { path: 'tb.v', contents: 'module tb; endmodule\n' };
    const control = assembleSimulateJob([], testbench, LIMITS, { requiredCheckNames: ['a'] });
    const grounded = assembleSimulateJob([], testbench, LIMITS, { requiredCheckNames: ['b'] });
    expect(control.workspaceFiles.at(-1)).toBe(SIMULATION_HARNESS);
    expect(grounded.workspaceFiles.at(-1)).toBe(SIMULATION_HARNESS);
  });

  it('refuses a budget or limit that is not a positive integer in range', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => renderSimulationHarness(bad, DUMP_LIMIT_BYTES)).toThrow(RangeError);
      expect(() => renderSimulationHarness(WATCHDOG_BUDGET_NS, bad)).toThrow(RangeError);
    }
    expect(() => renderSimulationHarness(WATCHDOG_BUDGET_NS, 2 ** 32)).toThrow(RangeError);
  });
});
