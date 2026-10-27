// Prompt construction for the Generation_Agent's generate and repair calls.
//
// Both prompts pin the module name and the EXACT port list (including the
// clock/reset contract) derived from the approved Spec, and demand a fixed JSON
// envelope so the untrusted reply can be shaped at the boundary (model-output.ts).
// The repair prompt additionally carries the previous candidate and the compiler
// (or interface) diagnostics the revision must resolve, within the Session_Budget
// (Req 6.2, 6.3). No secret is ever placed in a prompt (Req 17.7).

import type { ModelInterfacePortsView } from './spec-view.js';
import { specInterfaceView } from './spec-view.js';
import type { GenerationInput } from './types.js';

/** The JSON envelope every generation/repair reply must use, shaped at the boundary. */
const OUTPUT_CONTRACT =
  'Respond with ONLY a JSON object of the form {"rtl": "<complete Verilog module source>"} ' +
  'and nothing else. Do not wrap it in markdown fences.';

/** Render one required port as a single instruction line. */
function renderPortLine(port: ModelInterfacePortsView['ports'][number]): string {
  return `  - ${port.name}: ${port.direction}, width ${port.width}`;
}

/** The shared interface contract both prompts state, derived from the Spec. */
function interfaceContract(input: GenerationInput): string {
  const view = specInterfaceView(input.spec);
  const portLines = view.ports.map(renderPortLine).join('\n');
  return [
    `Implement a synthesizable Verilog module named exactly "${view.moduleName}".`,
    'The module port list MUST match this interface EXACTLY, using ANSI-style port',
    'declarations in the module header. Do not add, remove, rename, or resize any port:',
    portLines,
  ].join('\n');
}

/**
 * The initial-state rule, stated ONLY for a clocked interface that declares no reset port.
 *
 * With no reset there is no edge at which a starting state is established, so a register the
 * module never initialises holds `x` for the whole run and no oracle can check the output: `x`
 * compares equal to nothing. Measured on `square_wave`, whose Spec asks for no reset and never
 * names a starting value: 6 of 8 candidates omitted any initialisation and passed 0 of 8
 * testbenches, while the 2 that initialised were the only ones to pass anything - and RTLLM's
 * own verified reference opens with `initial begin wave_out = 0; count = 0; end`.
 *
 * Every other interface shape renders byte-identically, so a reset-bearing design is unaffected.
 */
function initialStateRule(input: GenerationInput): string {
  const { clocking } = input.spec.moduleInterface;
  if (clocking.clockName === null || clocking.resetName !== null) return '';
  return [
    'This interface declares a clock but NO reset port, so nothing establishes a starting',
    'state for you: give every register an initial value, or it holds x for the whole run',
    'and the module cannot be checked. Use the value the Spec implies, and 0 where it',
    'implies none.',
  ].join('\n');
}

/** Build the first-attempt generation prompt from the approved Spec (Req 6.1, 6.4). */
export function buildGenerationPrompt(input: GenerationInput): string {
  const { spec } = input;
  return [
    'You are the Generation_Agent producing candidate RTL for a single Verilog module.',
    '',
    interfaceContract(input),
    '',
    `Design goal: ${spec.goal}`,
    spec.constraints.length > 0
      ? `Constraints:\n${spec.constraints.map((c) => `  - ${c}`).join('\n')}`
      : '',
    spec.architecture.trim().length > 0 ? `Architecture notes: ${spec.architecture}` : '',
    '',
    initialStateRule(input),
    'The module must compile with a standard Verilog compiler. Do not introduce ports',
    'that are absent from the interface above.',
    '',
    OUTPUT_CONTRACT,
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * Build a repair prompt that carries the previous candidate and the diagnostics it
 * must resolve, re-stating the exact interface so a fix cannot drift off it.
 *
 * `diagnostics` are compiler errors or interface-exactness deviations produced by
 * this agent; they are non-sensitive and safe to feed back to the model.
 */
export function buildRepairPrompt(
  input: GenerationInput,
  previousRtl: string,
  diagnostics: string,
): string {
  return [
    'You are the Generation_Agent revising a candidate Verilog module that did not',
    'compile cleanly or did not match the required interface.',
    '',
    interfaceContract(input),
    '',
    'Previous candidate:',
    previousRtl,
    '',
    'Fix these problems without changing the interface:',
    diagnostics,
    '',
    OUTPUT_CONTRACT,
  ].join('\n');
}
