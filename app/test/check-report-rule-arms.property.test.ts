// testbench-failure-reportability, Property 14: the Check_Report_Rule reaches the Control_Arm and
// the Grounded_Arm prompts byte-identically, states the harness's callable and argument order, and
// precedes the signalling paragraph.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CHECK_REPORT_RULE,
  buildGroundedTestbenchModelInput,
  buildTestbenchModelInput,
  requiredChecks,
  requiredChecksFor,
  type TestbenchGenerationInput,
} from '@app/agent';
import type { AcceptanceCriterion, AcceptanceMethod, ModuleInterface, Port, Spec } from '@app/core';
import { CHECK_REPORT_TASK_PATH, SIMULATION_HARNESS } from '@app/tools';
import { timingContractFor } from './generators/timing-contract.js';
import { propertyParameters } from './property.js';

const PROPERTY_14 =
  'Feature: testbench-failure-reportability, Property 14: The rule reaches both arms byte-identically';

/** The first words of the signalling paragraph, owned here so placement has its own oracle. */
const SIGNALLING_PARAGRAPH_START = 'For EACH required check below, that task call prints';

/** The harness's module and its Check_Report_Task declaration, parsed from the rendered text. */
const HARNESS_MODULE = /^module (\w+);$/m;
const HARNESS_TASK =
  /task automatic (\w+)\(input \[\d+:0\] (\w+), input \[\d+:0\] (\w+), input \[\d+:0\] (\w+)\);/;

function port(name: string, direction: Port['direction'], width: number): Port {
  return { name, direction, width };
}

const arbInterface: fc.Arbitrary<ModuleInterface> = fc
  .record({
    clocked: fc.boolean(),
    reset: fc.boolean(),
    width: fc.constantFrom(1, 4, 8, 65),
    moduleName: fc.constantFrom('counter_12', 'JC_counter', 'dut', 'adder_x', 'mux4'),
  })
  .map(({ clocked, reset, width, moduleName }) => ({
    moduleName,
    ports: [
      ...(clocked ? [port('clk', 'input', 1)] : []),
      ...(reset ? [port('rst_n', 'input', 1)] : []),
      port('a', 'input', width),
      port('b', 'input', width),
      port('q', 'output', width),
    ],
    clocking: {
      clockName: clocked ? 'clk' : null,
      resetName: reset ? 'rst_n' : null,
      resetActiveLow: true,
    },
    validityOutputName: null,
  }));

const arbCriterion: fc.Arbitrary<AcceptanceCriterion> = fc.record({
  id: fc.constantFrom('01HZX0000000000000000000A1', '01HZX0000000000000000000B2'),
  text: fc.constantFrom('the count increments', 'the sum is correct', 'q holds when idle'),
  measurable: fc.boolean(),
  method: fc.constantFrom<AcceptanceMethod>('simulation', 'formal', 'manual-inspection'),
});

/** An approved Spec with varied interface and criteria and non-empty architecture text. */
const arbSpec: fc.Arbitrary<Spec> = fc
  .record({
    id: fc.constant('01HZX00000000000000000SPEC'),
    projectId: fc.constant('01HZX000000000000000000PRJ'),
    goal: fc.constantFrom(
      'an up counter that wraps at twelve',
      'a half adder',
      'a 4 to 1 multiplexer',
    ),
    constraints: fc.array(fc.constantFrom('no latches', 'single clock'), { maxLength: 2 }),
    moduleInterface: arbInterface,
    acceptanceCriteria: fc.array(arbCriterion, { maxLength: 3 }),
    architecture: fc.constantFrom(
      'The counter resets to zero.',
      'always @(posedge clk) q <= a + b;',
      'Each stage registers its input on the rising edge. '.repeat(20),
    ),
    approved: fc.constant(true),
    version: fc.integer({ min: 1, max: 9 }),
  })
  .map((fields) => ({ ...fields, timingContract: timingContractFor(fields.moduleInterface) }));

const arbInput: fc.Arbitrary<TestbenchGenerationInput> = fc.record({
  spec: arbSpec,
  intentSummary: fc.constantFrom('count to twelve', 'add two numbers'),
  okfPassages: fc.constant([]),
});

/** Every start offset of `needle` in `haystack`, so "exactly once" is a count, not a find. */
function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    found.push(at);
  }
  return found;
}

/** The rule text located in `prompt`, after asserting it appears once and before signalling. */
function extractRule(prompt: string): string {
  const starts = occurrences(prompt, CHECK_REPORT_RULE);
  expect(starts).toHaveLength(1);
  const start = starts[0] ?? -1;
  const signalling = prompt.indexOf(SIGNALLING_PARAGRAPH_START);
  expect(signalling).toBeGreaterThan(start + CHECK_REPORT_RULE.length);
  return prompt.slice(start, start + CHECK_REPORT_RULE.length);
}

/** The callable path and formal order the rendered harness declares, read from its text. */
function harnessCallable(): { path: string; formals: readonly string[] } {
  const moduleName = HARNESS_MODULE.exec(SIMULATION_HARNESS.contents)?.[1];
  const task = HARNESS_TASK.exec(SIMULATION_HARNESS.contents);
  if (moduleName === undefined || task === null) {
    throw new Error('the harness text declares no module or no Check_Report_Task');
  }
  return { path: `${moduleName}.${task[1] ?? ''}`, formals: task.slice(2, 5) };
}

/** The placeholder names inside the rule's call template, in written order. */
function ruleArguments(rule: string, path: string): readonly string[] {
  const call = new RegExp(`${path.replace('.', '\\.')}\\(([^)]*)\\);`).exec(rule);
  expect(call).not.toBeNull();
  return (call?.[1] ?? '').split(',').map((arg) => arg.trim().replace(/^"?<(\w+)>"?$/, '$1'));
}

describe(PROPERTY_14, () => {
  it('places one byte-identical rule before signalling in both arms, matching the harness', () => {
    const harness = harnessCallable();
    expect(harness.path).toBe(CHECK_REPORT_TASK_PATH);
    fc.assert(
      fc.property(arbInput, (input) => {
        const control = buildTestbenchModelInput(input, requiredChecks(input.spec)).prompt;
        const grounded = buildGroundedTestbenchModelInput(
          input,
          requiredChecksFor(input.spec, 'grounded'),
        ).prompt;
        const controlRule = extractRule(control);
        expect(extractRule(grounded)).toBe(controlRule);
        expect(ruleArguments(controlRule, harness.path)).toEqual(harness.formals);
      }),
      propertyParameters({ numRuns: 100 }),
    );
  });
});
