// The In_Order_Scoreboard prompt builders (testbench-in-order-scoreboard, C5).
//
// Every rule is the Cycle_Timed text, reused byte for byte from `../prompt.ts`. What differs is
// what the model writes: fragments that fill a product-written testbench, so `describeTiming`
// and the CHECK-printing paragraph are absent, because no part of the reply chooses a moment.

import type { ModelRequest } from '../../../model-router/index.js';
import {
  CONCURRENCY_RULE,
  DIALECT_RULE,
  EXPECTED_VALUE_RULE,
  GENERATION_PREAMBLE,
  REPAIR_PREAMBLE,
  describeInputWindow,
  describeRepairHint,
  describeRequiredChecks,
  describeStateAnchoring,
  describeStimulusAdequacy,
  generationSections,
  repairSpecSections,
} from '../prompt.js';
import type {
  RepairTestbenchModelInput,
  RequiredCheck,
  TestbenchGenerationInput,
} from '../types.js';
import { MAX_RUN_LENGTH, MAX_STIMULUS_CALLS } from './fragments.js';
import type { ScoreboardScaffold } from './scaffold.js';

/** The one carve-out beside `CONCURRENCY_RULE`, so the two cannot be read as contradicting. */
export const SCOREBOARD_CARVE_OUT =
  "A queue of expected values computed from the input transactions you drove, and compared only when the design's own output qualifier says a result is present, is not a second implementation of the design.";

const PRODUCT_WRITES_THE_TESTBENCH = [
  'The product writes the testbench shown below, including every comparison and every CHECK line.',
  'You do not write a testbench: you fill only its marked slots, as described in the fragment contract.',
].join('\n');

/** The fragment contract, stated as rules over the names this scaffold actually declares. */
function fragmentContract(scaffold: ScoreboardScaffold): string {
  const recorded = scaffold.dataInputs.map((port) => `txn_${port.name}[i]`).join(', ') || '(none)';
  const staged = scaffold.dataInputs.map((port) => `stage_${port.name}`).join(', ') || '(none)';
  return [
    'Fragment contract:',
    `  - "runLength": a JSON integer, how many accepted input transactions form one result, counted in transactions and never in clock cycles, from 1 to ${String(MAX_RUN_LENGTH)}.`,
    `  - "expectations": one key per data output (${scaffold.dataOutputs.map((p) => p.name).join(', ')}). Each value is ONE Verilog expression for that output's expected value, reading only ${recorded}, where i is a decimal index below runLength. txn_<input>[0] is the first transaction of the run.`,
    `  - "stimulus": one key per required check. Each value is Verilog statements that may only assign ${staged} and the loop variables stim_i, stim_j, stim_k, and call send_transaction; or idle_cycle;. send_transaction drives the staged values as one transaction; idle_cycle waits one cycle without one.`,
    '  - Allowed statements: begin/end blocks, if/else, repeat (N) with a decimal N, for (v = A; v < B; v = v + C) with decimal A, B, C, and $random in a value.',
    `  - Across all stimulus fragments, at most ${String(MAX_STIMULUS_CALLS)} calls to send_transaction and idle_cycle may execute.`,
    '  - Never write a comment, a string, a delay, an event control, $display, or any port name. A fragment that does is refused.',
  ].join('\n');
}

const FRAGMENT_OUTPUT_CONTRACT =
  'Return a JSON object with exactly three fields: "runLength", "expectations", and\n' +
  '"stimulus", as the fragment contract describes. Return nothing else.';

function scaffoldSection(scaffold: ScoreboardScaffold): string {
  return ['Testbench (product-written, do not reproduce it):', scaffold.text].join('\n');
}

/** The generation instruction block, in the order design C5 fixes. */
function scoreboardInstructions(
  input: TestbenchGenerationInput,
  checks: readonly RequiredCheck[],
  scaffold: ScoreboardScaffold,
): string {
  const moduleInterface = input.spec.moduleInterface;
  return [
    ...GENERATION_PREAMBLE,
    '',
    PRODUCT_WRITES_THE_TESTBENCH,
    '',
    EXPECTED_VALUE_RULE,
    '',
    describeStateAnchoring(moduleInterface.clocking),
    '',
    CONCURRENCY_RULE,
    SCOREBOARD_CARVE_OUT,
    '',
    describeInputWindow(moduleInterface),
    '',
    describeStimulusAdequacy(moduleInterface),
    '',
    DIALECT_RULE,
    '',
    scaffoldSection(scaffold),
    '',
    fragmentContract(scaffold),
    '',
    'Required checks (one stimulus fragment each):',
    describeRequiredChecks(checks),
    '',
    FRAGMENT_OUTPUT_CONTRACT,
  ].join('\n');
}

/** Assemble the In_Order_Scoreboard generation request; it carries no channel for RTL. */
export function buildScoreboardModelInput(
  input: TestbenchGenerationInput,
  checks: readonly RequiredCheck[],
  scaffold: ScoreboardScaffold,
): ModelRequest {
  const prompt = [
    scoreboardInstructions(input, checks, scaffold),
    '',
    generationSections(input),
  ].join('\n');
  return { prompt };
}

/** Assemble the In_Order_Scoreboard repair request; it carries no channel for RTL. */
export function buildScoreboardRepairModelInput(
  input: RepairTestbenchModelInput,
  scaffold: ScoreboardScaffold,
): ModelRequest {
  const prompt = [
    ...REPAIR_PREAMBLE,
    '',
    describeRepairHint(input.hint),
    '',
    CONCURRENCY_RULE,
    SCOREBOARD_CARVE_OUT,
    '',
    'Revise your fragments to fix this failure, keeping one stimulus fragment per required check.',
    '',
    scaffoldSection(scaffold),
    '',
    fragmentContract(scaffold),
    '',
    FRAGMENT_OUTPUT_CONTRACT,
    '',
    repairSpecSections(input),
    '',
    'Previous reply (revise this):',
    input.previousSource,
  ].join('\n');
  return { prompt };
}
