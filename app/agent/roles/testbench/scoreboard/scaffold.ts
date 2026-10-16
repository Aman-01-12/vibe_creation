// The Scoreboard_Scaffold: every line of a Scoreboard_Testbench that decides a comparison moment,
// compares a value, or prints a CHECK line (testbench-in-order-scoreboard, C2).
//
// Rendered from the declared interface and the required check names alone, so the model cannot
// choose a comparison cycle: it only fills the slots below. Three prompt rules aimed at that
// choice each failed on re-measurement, which is why this is code and not an instruction.

import { err, ok, type ModuleInterface, type Port, type Result } from '@app/core';

import { inputQualifierNames, timingQualifierNames } from '../prompt.js';
import { isValidCheckName } from '../signalling.js';
import { MAX_RUN_LENGTH, MAX_STIMULUS_CALLS, type ValidatedFragments } from './fragments.js';

/** A liveness bound in clock cycles after the last Input_Transaction; never a latency claim. */
export const DRAIN_BOUND = 1000;
export const QUEUE_DEPTH = MAX_STIMULUS_CALLS;
export const RESET_CYCLES = 4;
const CLK_HALF = 5;
/** The waveform file the sandbox collects as the run's required VCD artifact. */
const VCD_FILENAME = 'dump.vcd';
const SAMPLE_DELAY = 2;

/** The three fixed checks the scaffold owns; product constants, never model output. */
export const SCOREBOARD_CHECK_NAMES = {
  unexpectedOutput: 'scoreboard_unexpected_output',
  missingOutput: 'scoreboard_missing_output',
  vacuous: 'scoreboard_vacuous',
} as const;

/** Names the scaffold declares; a port carrying one would alias scaffold state. */
const RESERVED_PREFIXES = ['sb_', 'txn_', 'stage_', 'stim_'] as const;
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'tb',
  'dut',
  'send_transaction',
  'idle_cycle',
]);

/** Every real check name is `ac<n>_<slug>` or a known-answer id, both plain identifiers. */
const CHECK_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ScoreboardScaffold {
  /** The full Verilog-2001 text with slot markers; byte-identical for equal inputs. */
  readonly text: string;
  readonly dataInputs: readonly Port[];
  readonly dataOutputs: readonly Port[];
  readonly checkNames: readonly string[];
}

export type ScaffoldRefusal =
  | { readonly reason: 'no-clock' }
  | { readonly reason: 'not-one-output-qualifier' }
  | { readonly reason: 'reserved-name'; readonly port: string }
  | { readonly reason: 'no-data-output' }
  | { readonly reason: 'invalid-check-name'; readonly check: string };

/** The slot marker an assembler replaces; a comment, so an unfilled scaffold still parses. */
export function slotMarker(slot: string): string {
  return `/*@SLOT ${slot}@*/`;
}

/** The ports and roles the scaffold is rendered over. */
interface ScaffoldPlan {
  readonly moduleInterface: ModuleInterface;
  /** Every signal the DUT is connected by: the declared ports plus the clocking contract's. */
  readonly connected: readonly Port[];
  readonly clock: string;
  readonly reset: { readonly name: string; readonly activeLow: boolean } | null;
  readonly outputQualifier: string;
  readonly inputQualifiers: readonly string[];
  readonly dataInputs: readonly Port[];
  readonly dataOutputs: readonly Port[];
  readonly checkNames: readonly string[];
}

/**
 * The declared ports plus the clock and reset, which an imported Spec carries only in its
 * clocking contract (the corpus importer splits them out), deduplicated by name.
 */
function connectedPorts(moduleInterface: ModuleInterface): readonly Port[] {
  const { clockName, resetName } = moduleInterface.clocking;
  const declared = new Set(moduleInterface.ports.map((port) => port.name));
  const clocking: Port[] = [clockName, resetName]
    .filter((name): name is string => name !== null && !declared.has(name))
    .map((name) => ({ name, direction: 'input', width: 1 }));
  return [...moduleInterface.ports, ...clocking];
}

function isReservedPortName(name: string): boolean {
  return RESERVED_NAMES.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Derive the plan, or the reason this interface cannot carry a scoreboard. */
function planOf(
  moduleInterface: ModuleInterface,
  checkNames: readonly string[],
): Result<ScaffoldPlan, ScaffoldRefusal> {
  const { clockName, resetName, resetActiveLow } = moduleInterface.clocking;
  if (clockName === null) {
    return err({ reason: 'no-clock' });
  }
  const qualifiers = timingQualifierNames(moduleInterface);
  const outputQualifier = qualifiers.length === 1 ? qualifiers[0] : undefined;
  if (outputQualifier === undefined) {
    return err({ reason: 'not-one-output-qualifier' });
  }
  const connected = connectedPorts(moduleInterface);
  const reserved = connected.find((port) => isReservedPortName(port.name));
  if (reserved !== undefined) {
    return err({ reason: 'reserved-name', port: reserved.name });
  }
  // A name is spliced into a Verilog string and a `case` label, so it must be a plain
  // identifier: a quote or `%` would break or inject the `$display` format.
  const badCheck = checkNames.find((name) => !isValidCheckName(name) || !CHECK_NAME.test(name));
  if (badCheck !== undefined) {
    return err({ reason: 'invalid-check-name', check: badCheck });
  }
  const inputQualifiers = inputQualifierNames(moduleInterface);
  const control = new Set([clockName, resetName, ...inputQualifiers]);
  const dataInputs = moduleInterface.ports.filter(
    (p) => p.direction === 'input' && !control.has(p.name),
  );
  const dataOutputs = moduleInterface.ports.filter(
    (p) => p.direction === 'output' && p.name !== outputQualifier,
  );
  if (dataOutputs.length === 0) {
    return err({ reason: 'no-data-output' });
  }
  const reset = resetName === null ? null : { name: resetName, activeLow: resetActiveLow };
  return ok({
    moduleInterface,
    connected,
    clock: clockName,
    reset,
    outputQualifier,
    inputQualifiers,
    dataInputs,
    dataOutputs,
    checkNames,
  });
}

function range(width: number): string {
  return width === 1 ? '' : `[${String(width - 1)}:0] `;
}

/** Parameters and the testbench's view of every port. */
function declarations(plan: ScaffoldPlan): string[] {
  const ports = plan.connected;
  return [
    '  // DRAIN_BOUND is a liveness bound in clock cycles after the last Input_Transaction.',
    '  // It is not a latency claim: no comparison is ever timed by it.',
    `  localparam integer DRAIN_BOUND = ${String(DRAIN_BOUND)};`,
    `  localparam integer QUEUE_DEPTH = ${String(QUEUE_DEPTH)};`,
    `  localparam integer MAX_RUN_LENGTH = ${String(MAX_RUN_LENGTH)};`,
    `  localparam integer RESET_CYCLES = ${String(RESET_CYCLES)};`,
    `  localparam integer CHECK_COUNT = ${String(Math.max(plan.checkNames.length, 1))};`,
    `  localparam integer RUN_LENGTH = ${slotMarker('runLength')};`,
    '',
    ...ports.map(
      (p) => `  ${p.direction === 'input' ? 'reg' : 'wire'} ${range(p.width)}${p.name};`,
    ),
    '',
    `  ${plan.moduleInterface.moduleName} dut (`,
    ports.map((p) => `    .${p.name}(${p.name})`).join(',\n'),
    '  );',
    '',
  ];
}

/** Scaffold state: staging registers, the run, the Expectation_Queue, and the counters. */
function state(plan: ScaffoldPlan): string[] {
  return [
    ...plan.dataInputs.map((p) => `  reg ${range(p.width)}stage_${p.name};`),
    ...plan.dataInputs.map((p) => `  reg ${range(p.width)}txn_${p.name} [0:MAX_RUN_LENGTH-1];`),
    ...plan.dataOutputs.map((p) => `  reg ${range(p.width)}sb_exp_${p.name} [0:QUEUE_DEPTH-1];`),
    '  integer sb_exp_check [0:QUEUE_DEPTH-1];',
    '  integer sb_check_failed [0:CHECK_COUNT-1];',
    '  integer sb_head, sb_tail, sb_txn_count, sb_comparisons, sb_drain, sb_check, sb_k;',
    '  integer sb_hold_from;',
    '  reg sb_in_reset;',
    '  reg sb_unexpected;',
    '  reg sb_txn_pending;',
    '  integer stim_i, stim_j, stim_k;',
    '',
    '  initial ' + plan.clock + " = 1'b0;",
    `  always #${String(CLK_HALF)} ${plan.clock} = ~${plan.clock};`,
    '',
  ];
}

/** The condition under which an active edge records one Input_Transaction. */
function captureCondition(plan: ScaffoldPlan): string {
  if (plan.inputQualifiers.length === 0) {
    return 'sb_txn_pending';
  }
  return plan.inputQualifiers.map((name) => `${name} === 1'b1`).join(' && ');
}

/** Input_Transaction capture; the only writer of the run and the queue tail (Req 4.1). */
function captureBlock(plan: ScaffoldPlan): string[] {
  return [
    '  // Input_Transaction capture: an active edge on which the design accepts its inputs.',
    `  always @(posedge ${plan.clock}) begin`,
    `    if (!sb_in_reset && ${captureCondition(plan)}) begin`,
    ...plan.dataInputs.map((p) => `      txn_${p.name}[sb_txn_count] = ${p.name};`),
    "      sb_txn_pending = 1'b0;",
    '      sb_txn_count = sb_txn_count + 1;',
    '      sb_drain = 0;',
    '      if (sb_txn_count == RUN_LENGTH) begin',
    ...plan.dataOutputs.map(
      (p) =>
        `        sb_exp_${p.name}[sb_tail % QUEUE_DEPTH] = (${slotMarker(`expectations.${p.name}`)});`,
    ),
    '        sb_exp_check[sb_tail % QUEUE_DEPTH] = sb_check;',
    '        sb_tail = sb_tail + 1;',
    '        sb_txn_count = 0;',
    '      end',
    '    end else begin',
    '      sb_drain = sb_drain + 1;',
    '    end',
    '  end',
    '',
  ];
}

/** One mismatch test per Data_Output; any `x` or `z` bit differs (Q-14). */
function outputComparisons(plan: ScaffoldPlan): string[] {
  return plan.dataOutputs.flatMap((p) => {
    const expected = `sb_exp_${p.name}[sb_head % QUEUE_DEPTH]`;
    return [
      `        if ((^${p.name} === 1'bx) || ${p.name} !== ${expected}) begin`,
      '          sb_check_failed[sb_k] = sb_check_failed[sb_k] + 1;',
      '          case (sb_k)',
      ...plan.checkNames.map(
        (check, index) =>
          `            ${String(index)}: $display("CHECK ${check} FAIL: ${p.name} expected %h observed %h", ${expected}, ${p.name});`,
      ),
      '          endcase',
      '        end',
    ];
  });
}

/** The Comparison_Event: the settled part of a period with the Output_Qualifier asserted. */
function compareBlock(plan: ScaffoldPlan): string[] {
  return [
    '  // Comparison_Event: after the edge settles, before the stimulus drives at the falling edge.',
    `  always @(posedge ${plan.clock}) begin`,
    `    #${String(SAMPLE_DELAY)};`,
    `    if (!sb_in_reset && ${plan.outputQualifier} === 1'b1) begin`,
    '      sb_comparisons = sb_comparisons + 1;',
    '      if (sb_head == sb_tail) begin',
    "        sb_unexpected = 1'b1;",
    `        $display("CHECK ${SCOREBOARD_CHECK_NAMES.unexpectedOutput} FAIL: an output arrived with no queued expectation");`,
    '      end else begin',
    '        sb_k = sb_exp_check[sb_head % QUEUE_DEPTH];',
    ...outputComparisons(plan),
    '        sb_head = sb_head + 1;',
    '      end',
    '    end',
    '  end',
    '',
    '  // Liveness: one missing-output report per stall, then stop (Q-15). On the falling edge,',
    '  // because the drain count moves on the rising edge and a same-edge read races it.',
    `  always @(negedge ${plan.clock}) begin`,
    '    if (!sb_in_reset && sb_drain >= DRAIN_BOUND && sb_head != sb_tail) begin',
    `      $display("CHECK ${SCOREBOARD_CHECK_NAMES.missingOutput} FAIL: %0d expectations outstanding after the drain bound", sb_tail - sb_head);`,
    '      $finish;',
    '    end',
    '  end',
    '',
  ];
}

function driveDataInputs(plan: ScaffoldPlan): string[] {
  return plan.dataInputs.map((p) => `      ${p.name} = stage_${p.name};`);
}

function setInputQualifiers(plan: ScaffoldPlan, level: '0' | '1'): string[] {
  return plan.inputQualifiers.map((name) => `      ${name} = 1'b${level};`);
}

/** The only two ways stimulus may advance time. */
function tasks(plan: ScaffoldPlan): string[] {
  const falling = `@(negedge ${plan.clock});`;
  const send =
    plan.inputQualifiers.length > 0
      ? [...driveDataInputs(plan), ...setInputQualifiers(plan, '1'), `      ${falling}`]
      : [
          ...driveDataInputs(plan),
          "      sb_txn_pending = 1'b1;",
          '      sb_hold_from = sb_comparisons;',
          `      ${falling}`,
          // One transaction in flight: hold until it is compared or the drain bound expires.
          `      while (sb_comparisons == sb_hold_from && sb_drain < DRAIN_BOUND) ${falling}`,
        ];
  return [
    '  task send_transaction;',
    '    begin',
    ...send,
    '    end',
    '  endtask',
    '',
    '  task idle_cycle;',
    '    begin',
    ...setInputQualifiers(plan, '0'),
    `      ${falling}`,
    '    end',
    '  endtask',
    '',
  ];
}

function resetSequence(plan: ScaffoldPlan): string[] {
  if (plan.reset === null) {
    return [`    repeat (RESET_CYCLES) @(negedge ${plan.clock});`];
  }
  const asserted = plan.reset.activeLow ? '0' : '1';
  const released = plan.reset.activeLow ? '1' : '0';
  return [
    `    ${plan.reset.name} = 1'b${asserted};`,
    `    repeat (RESET_CYCLES) @(negedge ${plan.clock});`,
    `    ${plan.reset.name} = 1'b${released};`,
  ];
}

/** Reset, the stimulus regions in check order, the drain, and the end-of-run verdicts. */
function runBlock(plan: ScaffoldPlan): string[] {
  const regions = plan.checkNames.flatMap((check, index) => [
    `    sb_check = ${String(index)};`,
    `    begin : sb_stimulus_${String(index)}`,
    `      ${slotMarker(`stimulus.${check}`)}`,
    '    end',
  ]);
  // A check with zero attributed comparisons prints PASS when nothing differed (DQ-04 B);
  // `scoreboard_vacuous` guards the case where nothing at all was compared.
  const verdicts = plan.checkNames.map(
    (check, index) =>
      `    if (sb_check_failed[${String(index)}] == 0) $display("CHECK ${check} PASS");`,
  );
  return [
    '  initial begin : sb_run',
    // The Simulator requires a waveform; a run without one is `output-incomplete`, not a verdict.
    `    $dumpfile("${VCD_FILENAME}");`,
    '    $dumpvars(0, tb);',
    '    sb_head = 0; sb_tail = 0; sb_txn_count = 0; sb_comparisons = 0; sb_drain = 0;',
    "    sb_check = 0; sb_hold_from = 0; sb_unexpected = 1'b0; sb_txn_pending = 1'b0;",
    '    for (sb_k = 0; sb_k < CHECK_COUNT; sb_k = sb_k + 1) sb_check_failed[sb_k] = 0;',
    ...plan.dataInputs.map((p) => `    stage_${p.name} = 0; ${p.name} = 0;`),
    ...plan.inputQualifiers.map((name) => `    ${name} = 1'b0;`),
    "    sb_in_reset = 1'b1;",
    ...resetSequence(plan),
    "    sb_in_reset = 1'b0;",
    ...regions,
    ...plan.inputQualifiers.map((name) => `    ${name} = 1'b0;`),
    `    while (sb_tail != sb_head) @(posedge ${plan.clock});`,
    `    repeat (2) @(posedge ${plan.clock});`,
    `    $display("CHECK ${SCOREBOARD_CHECK_NAMES.missingOutput} PASS");`,
    `    if (!sb_unexpected) $display("CHECK ${SCOREBOARD_CHECK_NAMES.unexpectedOutput} PASS");`,
    `    if (sb_comparisons == 0) $display("CHECK ${SCOREBOARD_CHECK_NAMES.vacuous} FAIL: no output was ever compared");`,
    `    else $display("CHECK ${SCOREBOARD_CHECK_NAMES.vacuous} PASS");`,
    ...verdicts,
    '    $finish;',
    '  end',
  ];
}

/**
 * Render the scaffold, or refuse an interface that cannot carry one. Pure and deterministic:
 * byte-identical inputs give a byte-identical scaffold (Req 4.5).
 */
export function renderScoreboardScaffold(
  moduleInterface: ModuleInterface,
  checkNames: readonly string[],
): Result<ScoreboardScaffold, ScaffoldRefusal> {
  const planned = planOf(moduleInterface, checkNames);
  if (!planned.ok) {
    return planned;
  }
  const plan = planned.value;
  const lines = [
    '`timescale 1ns/1ps',
    `// Scoreboard_Scaffold for module ${moduleInterface.moduleName}, rendered from its declared interface.`,
    'module tb;',
    ...declarations(plan),
    ...state(plan),
    ...captureBlock(plan),
    ...compareBlock(plan),
    ...tasks(plan),
    ...runBlock(plan),
    'endmodule',
    '',
  ];
  return ok({
    text: lines.join('\n'),
    dataInputs: plan.dataInputs,
    dataOutputs: plan.dataOutputs,
    checkNames: plan.checkNames,
  });
}

/** Replace each slot marker with its validated fragment text, byte for byte, and nothing else. */
export function assembleScoreboardTestbench(
  scaffold: ScoreboardScaffold,
  fragments: ValidatedFragments,
): string {
  const fills = new Map<string, string>([['runLength', String(fragments.runLength)]]);
  for (const [port, expression] of fragments.expectations) {
    fills.set(`expectations.${port}`, expression);
  }
  for (const [check, statements] of fragments.stimulus) {
    fills.set(`stimulus.${check}`, statements);
  }
  let text = scaffold.text;
  for (const [slot, fill] of fills) {
    text = text.split(slotMarker(slot)).join(fill);
  }
  return text;
}
