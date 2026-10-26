// Model-input assembly for the Reference_Model role (Req 5.1, 5.4-5.7).
//
// Pure function of a Spec; no candidate design or RTL can reach it (same structural
// guarantee as the Testbench_Agent and Property_Author prompts).

import type { ModuleInterface, Spec, TimingContract } from '@app/core';
import {
  ECE_STATE_W,
  packedPortSlices,
  referenceModelFunctionHeaders,
  SAMPLE_BUDGET,
  sizedSampleBudget,
} from '@app/tools';

import type { ModelRequest } from '../../model-router/index.js';
import {
  EXAMPLE2_DRAFT,
  EXAMPLE2_GOAL,
  EXAMPLE2_INTERFACE,
  EXAMPLE2_TIMING,
  EXAMPLE_DRAFT,
  EXAMPLE_GOAL,
  EXAMPLE_INTERFACE,
  EXAMPLE_TIMING,
} from './canonical-example.js';
import type { ReferenceModelDraft } from './types.js';

/** No minimum/maximum check count: a fixed count is wrong on 94-100% of failing designs. */
const CHECK_COUNT_RULE =
  'Checks: there is no required or capped number of checks. Write as many as the ' +
  'acceptance criteria need; a fixed count is not a target.';

const STATE_RULE = [
  `State: ece_state is a harness-owned ${String(ECE_STATE_W)}-bit register threaded between`,
  'steps. Pack whatever state your expectation needs into those bits; you do not declare',
  'a width or a clock. Reset is asserted more than once over a run, not only before step 0,',
  'so ece_reset_state returns the state right after EVERY reset, including any register',
  'whose reset value is not zero. ece_next_state returns the state after one clock edge',
  'that consumes `in`.',
  'A registered output is itself a register, so what it shows now is part of the state: carry',
  'it in ece_state, compute its next value in ece_next_state, and read it back in ece_expect.',
  'Writing the pre-register expression over `in` instead states the value one edge EARLY and',
  'mismatches at every step.',
].join('\n');

/** The closed Role_Vocabulary and what each member drives, named explicitly (Req 4.1, 4.2). */
const ROLE_RULE = [
  'Roles: declare exactly one role per input port, from the vocabulary `data` or `enable`.',
  'The product renders that port\u2019s stimulus from the declared role; you do not author',
  'stimulus. `data` may change at every step. `enable` is held asserted and released for',
  'one step periodically, so the operation it gates restarts; declare a port `enable` only',
  'when that periodic restart is the condition your expectation should be exercised under.',
].join('\n');

/** The state convention (Q-15): v3's "value after the edge" was contradicted by 7 of 8 draws. */
const EXPECT_RULE = [
  'Expectation: ece_expect(s, in) returns what every output shows right now, in state `s`,',
  'with `in` applied. An output marked registered must depend on `s` only; the harness',
  'evaluates it with `in` all zeros.',
].join('\n');

/** Ports are not in scope inside a function; v2 replies assigned them and failed to elaborate. */
const SCOPE_RULE = [
  'Scope: the harness owns the clock and the reset and drives them itself. Port names are',
  'NOT visible inside these functions. Read inputs only from the bits of `in`, return outputs',
  'only as the bits of the function result, and keep any other variable a local reg.',
].join('\n');

const BODY_CONTRACT =
  'Return exactly three function bodies - ece_reset_state, ece_next_state, and ece_expect - ' +
  'each as the statements inside the given header, plus a roles array declaring one role ' +
  'per input port. The product renders the stimulus itself: no reply is asked for a ' +
  'stimulus body. ece_expect must state a value for every output port at every step.';

/** The JSON reply envelope parseReferenceModelDraft requires; named explicitly (v2). */
const REPLY_FORMAT_RULE = [
  'Reply with exactly one JSON object and nothing else - no prose, no markdown fence:',
  '{"functions": [',
  '  {"name": "ece_reset_state", "body": "<statements inside the ece_reset_state header>"},',
  '  {"name": "ece_next_state", "body": "<statements inside the ece_next_state header>"},',
  '  {"name": "ece_expect", "body": "<statements inside the ece_expect header>"}',
  '], "roles": [',
  '  {"port": "<input port name>", "role": "data" | "enable"},',
  '  ...one entry for every input port, no omission, no duplicate, no unknown port',
  ']}',
].join('\n');

/** What each Port_Timing means for `ece_expect`, matching the harness's comparison (Q-15). */
const TIMING_MEANING: Readonly<Record<'registered' | 'combinational', string>> = {
  registered: 'depends on `s` only',
  combinational: 'may depend on `s` and on `in`',
};

/**
 * The declared Port_Timing for one output port, never defaulted.
 *
 * This read was `?? 'registered'` until timing-contract-inference landed, which made it the
 * FOURTH site fabricating an all-`registered` contract - the same defect class that made the 13
 * purely combinational corpus designs unwinnable, since a prompt that calls a combinational port
 * `registered` tells the model to write `ece_expect` off retained state alone and the harness
 * then compares it against the applied input. Unreachable through either real path, because a
 * Spec's contract is built by `makeTimingContract` on both the production (Spec_Agent) and eval
 * (Corpus_Importer) sides and that constructor is total over the declared output ports. So an
 * absent entry is an invariant violation worth throwing on rather than a value to coerce around,
 * the same call `timing-cross-check.ts` makes for its own unreachable rows.
 */
function timingOf(
  timingContract: TimingContract,
  portName: string,
): 'registered' | 'combinational' {
  const timing = timingContract.entries.find((entry) => entry.portName === portName)?.timing;
  if (timing === undefined) {
    throw new Error(`unreachable: Timing_Contract carries no entry for output port "${portName}"`);
  }
  return timing;
}

/** `{high, ..., low}` over the slices, the order a Verilog concatenation is written in (Q-19). */
function concatenationOf(slices: readonly { readonly name: string }[]): string {
  return `{${[...slices]
    .reverse()
    .map((slice) => slice.name)
    .join(', ')}}`;
}

/**
 * A representative nonce length for the budget estimate below. The real nonce (`live-wiring.ts`,
 * `pilot.ts`) is a one-character prefix plus 12 hex characters; no real nonce exists yet at
 * prompt-build time, so this stands in for it. The estimate only has to tell the model
 * approximately how many steps to expect, not reproduce the harness's own byte accounting.
 */
const REPRESENTATIVE_NONCE_LENGTH = 13;

/** Sum of a port list's widths, at least 1 bit (matches the renderer's own bundle sizing). */
function bundleWidth(ports: readonly { readonly width: number }[]): number {
  return Math.max(
    1,
    ports.reduce((sum, port) => sum + port.width, 0),
  );
}

/** The Sample_Budget this interface would render under, width-reduced same as the harness. */
function sampleBudgetFor(moduleInterface: ModuleInterface): number {
  const outputs = moduleInterface.ports.filter((port) => port.direction === 'output');
  return sizedSampleBudget(REPRESENTATIVE_NONCE_LENGTH, bundleWidth(outputs), SAMPLE_BUDGET);
}

/** The packed layout of `in` and of the ece_expect result, from the harness's own slices. */
function describeInterface(
  moduleInterface: ModuleInterface,
  timingContract: TimingContract,
): string {
  const inputs = moduleInterface.ports.filter((port) => port.direction === 'input');
  const outputs = moduleInterface.ports.filter((port) => port.direction === 'output');
  const inputSlices = packedPortSlices(inputs);
  const outputSlices = packedPortSlices(outputs);
  const inputLines = inputSlices.map(
    (slice) => `  in[${String(slice.high)}:${String(slice.low)}] = ${slice.name}`,
  );
  const outputLines = outputSlices.map((slice) => {
    const timing = timingOf(timingContract, slice.name);
    return `  result[${String(slice.high)}:${String(slice.low)}] = ${slice.name} (${timing}: ${TIMING_MEANING[timing]})`;
  });
  return [
    'Inputs, packed into `in`:',
    ...(inputLines.length > 0 ? inputLines : ['  (none)']),
    ...(inputSlices.length > 0
      ? [`  as a concatenation, most significant first: ${concatenationOf(inputSlices)}`]
      : []),
    'Outputs, packed into the ece_expect result:',
    ...outputLines,
    `  as a concatenation, most significant first: ${concatenationOf(outputSlices)}`,
    '  (bit positions, not variables: port names are not in scope)',
    `Sample_Budget: ece_next_state and ece_expect are authored against ` +
      `${String(sampleBudgetFor(moduleInterface))} steps, the step count the product renders ` +
      'the Stimulus_Function over.',
  ].join('\n');
}

/** Render the three headers the model's bodies must fill, from the Spec's own interface. */
function describeHeaders(moduleInterface: ModuleInterface): string {
  const headers = referenceModelFunctionHeaders(moduleInterface);
  return [
    'Headers (rendered by the harness; fill the body only):',
    headers.resetState,
    headers.nextState,
    headers.expect,
  ].join('\n');
}

/** One worked example: its interface, then each header with its body (Q-19). */
function describeExample(example: {
  readonly lead: string;
  readonly goal: string;
  readonly moduleInterface: ModuleInterface;
  readonly timingContract: TimingContract;
  readonly draft: ReferenceModelDraft;
}): string {
  const headers = referenceModelFunctionHeaders(example.moduleInterface);
  const functions = [
    [headers.resetState, example.draft.resetStateBody],
    [headers.nextState, example.draft.nextStateBody],
    [headers.expect, example.draft.expectBody],
  ].flatMap(([header, body]) => [header, body, 'endfunction']);
  const roles = example.draft.roles
    .map((role) => `{"port": "${role.portName}", "role": "${role.role}"}`)
    .join(', ');
  return [
    example.lead,
    example.goal,
    describeInterface(example.moduleInterface, example.timingContract),
    ...functions,
    `roles: [${roles}]`,
  ].join('\n');
}

/** Both worked examples: the Moore shape, then the one whose output register is in the state. */
function describeExamples(): string {
  return [
    describeExample({
      lead: 'Example, for a different design. It shows the encoding only, never your design:',
      goal: EXAMPLE_GOAL,
      moduleInterface: EXAMPLE_INTERFACE,
      timingContract: EXAMPLE_TIMING,
      draft: EXAMPLE_DRAFT,
    }),
    '',
    describeExample({
      lead:
        'Second example, showing a registered output that the input determines. Its value now ' +
        'is a register, so the state carries that register and ece_expect reads it from `s`:',
      goal: EXAMPLE2_GOAL,
      moduleInterface: EXAMPLE2_INTERFACE,
      timingContract: EXAMPLE2_TIMING,
      draft: EXAMPLE2_DRAFT,
    }),
  ].join('\n');
}

/** Assemble the model request for Reference_Model generation (Req 5.1, 5.4-5.7). */
export function buildReferenceModelInput(spec: Spec): ModelRequest {
  const prompt = [
    'You are the Reference_Model for a single Verilog module.',
    'You are given ONLY the approved Spec. You are NOT given any implementation or RTL.',
    '',
    STATE_RULE,
    '',
    ROLE_RULE,
    '',
    EXPECT_RULE,
    '',
    SCOPE_RULE,
    '',
    CHECK_COUNT_RULE,
    '',
    BODY_CONTRACT,
    '',
    REPLY_FORMAT_RULE,
    '',
    describeExamples(),
    '',
    'Spec goal:',
    spec.goal,
    '',
    'Constraints:',
    spec.constraints.map((constraint) => `  - ${constraint}`).join('\n'),
    '',
    'Acceptance criteria:',
    spec.acceptanceCriteria.map((criterion) => `  - ${criterion.text}`).join('\n'),
    '',
    // Q-17: the same approved Spec text the Candidate_Design calls receive (Req 5.13).
    ...(spec.architecture.trim().length > 0 ? ['Architecture notes:', spec.architecture, ''] : []),
    describeInterface(spec.moduleInterface, spec.timingContract),
    '',
    describeHeaders(spec.moduleInterface),
  ].join('\n');
  return { prompt };
}
