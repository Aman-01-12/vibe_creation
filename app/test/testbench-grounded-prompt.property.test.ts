// testbench-spec-grounding, Properties 2 to 4: the Grounded_Arm's Required_Check list and
// prompts are the Control_Arm's plus exactly the stated differences, and Control and Treatment
// requests do not move through the agent.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ARCHITECTURE_FRAMING,
  ARCHITECTURE_SECTION_LABEL,
  CONCURRENCY_RULE,
  FENCED_OUTPUT_CONTRACT_INSTRUCTION,
  buildGroundedRepairModelInput,
  buildGroundedTestbenchModelInput,
  buildRepairHint,
  buildRepairModelInput,
  buildScoreboardModelInput,
  buildScoreboardRepairModelInput,
  buildTestbenchModelInput,
  InMemorySessionBudgetHandle,
  InMemoryTracePersistence,
  renderScoreboardScaffold,
  requiredChecks,
  requiredChecksFor,
  routeCheckingApproach,
  TestbenchAgent,
  TraceActionRecorder,
  type ModelRequest,
  type ModelRouter,
  type ModelRouterFailure,
  type RepairTestbenchModelInput,
  type RepairTestbenchRequest,
  type RoutedModelResult,
  type RoutingDiagnostics,
  type SessionBudgetHandle,
  type StrategyArm,
  type TestbenchGenerationInput,
} from '@app/agent';
import {
  makeSessionBudget,
  newUlid,
  type AcceptanceCriterion,
  type AcceptanceMethod,
  type ModuleInterface,
  type Port,
  type Result,
  type Spec,
} from '@app/core';
import type { KnowledgePassage, KnowledgeRetriever, RetrievalResult } from '@app/knowledge';
import { routedModelIdFor, timingContractFor } from '@app/test';
import { propertyParameters } from './property.js';

const PROPERTY_2 =
  'Feature: testbench-spec-grounding, Property 2: Grounded Required_Checks are the Control list minus the up-counter check';

const PROPERTY_4 =
  'Feature: testbench-spec-grounding, Property 4: Control and Treatment requests are unchanged through the agent';
const PROPERTY_3 =
  'Feature: testbench-spec-grounding, Property 3: Grounded prompts are the Control prompts plus one section and one contract';

const UP_COUNTER_CHECK = 'known_answer_counter_increments';

/** The JSON contract the Control_Arm states, copied so the comparison owns its own oracle. */
const JSON_OUTPUT_CONTRACT =
  'Return a JSON object with exactly one field: "source", whose value is the\n' +
  'complete Verilog testbench as a string. Return nothing else.';

/** Goals that hit each standard block, several at once, or none, all frequently. */
const GOALS = [
  'an up counter that wraps at twelve',
  'a Johnson counter',
  'a full adder over single bits',
  'a half adder',
  'a 4 to 1 multiplexer',
  'a 3 to 8 decoder',
  'a shift register that loads serially',
  'a counter feeding a decoder',
  'a mux and a shift register',
  'a plain datapath that adds two words',
] as const;

/** Architecture texts: empty, whitespace-only, prose, register-level pseudocode, and long. */
const ARCHITECTURES: fc.Arbitrary<string> = fc.oneof(
  fc.constant(''),
  fc.constantFrom('   ', '\n\t\n'),
  fc.constantFrom('The counter resets to zero.', 'Outputs settle one cycle after inputs.'),
  fc.constant(
    'always @(posedge clk) if (!rst_n) q <= 0;\nelse if (q == 11) q <= 0;\nelse q <= q + 1;',
  ),
  fc.constant('Each stage registers its input on the rising edge. '.repeat(60)),
);

function port(name: string, direction: Port['direction'], width: number): Port {
  return { name, direction, width };
}

const arbInterface: fc.Arbitrary<ModuleInterface> = fc
  .record({
    clocked: fc.boolean(),
    reset: fc.boolean(),
    singleBit: fc.boolean(),
    qualified: fc.boolean(),
    moduleName: fc.constantFrom('counter_12', 'JC_counter', 'dut', 'adder_x', 'mux4'),
  })
  .map(({ clocked, reset, singleBit, qualified, moduleName }) => {
    const width = singleBit ? 1 : 4;
    const ports = [
      ...(clocked ? [port('clk', 'input', 1)] : []),
      ...(reset ? [port('rst_n', 'input', 1)] : []),
      port('a', 'input', width),
      port('b', 'input', width),
      port('q', 'output', width),
      ...(qualified ? [port('valid_out', 'output', 1)] : []),
    ];
    return {
      moduleName,
      ports,
      clocking: {
        clockName: clocked ? 'clk' : null,
        resetName: reset ? 'rst_n' : null,
        resetActiveLow: true,
      },
      validityOutputName: null,
    };
  });

const arbCriterion: fc.Arbitrary<AcceptanceCriterion> = fc.record({
  id: fc.constantFrom('01HZX0000000000000000000A1', '01HZX0000000000000000000B2'),
  text: fc.constantFrom('the count increments', 'the sum is correct', 'q holds when idle'),
  measurable: fc.boolean(),
  method: fc.constantFrom<AcceptanceMethod>('simulation', 'formal', 'manual-inspection'),
});

/** An approved Spec over the declared interface, goal, architecture, and criteria. */
const arbSpec: fc.Arbitrary<Spec> = fc
  .record({
    id: fc.constant('01HZX00000000000000000SPEC'),
    projectId: fc.constant('01HZX000000000000000000PRJ'),
    goal: fc.constantFrom(...GOALS),
    constraints: fc.array(fc.constantFrom('no latches', 'single clock'), { maxLength: 2 }),
    moduleInterface: arbInterface,
    acceptanceCriteria: fc.array(arbCriterion, { maxLength: 3 }),
    architecture: ARCHITECTURES,
    approved: fc.constant(true),
    version: fc.integer({ min: 1, max: 9 }),
  })
  .map((fields) => ({ ...fields, timingContract: timingContractFor(fields.moduleInterface) }));

describe(PROPERTY_2, () => {
  it('equals the Control list for control and treatment, and drops only the up-counter check', () => {
    let sawUpCounter = false;
    fc.assert(
      fc.property(arbSpec, (spec) => {
        const control = requiredChecks(spec);
        expect(requiredChecksFor(spec, 'control')).toEqual(control);
        expect(requiredChecksFor(spec, 'treatment')).toEqual(control);
        expect(requiredChecksFor(spec, 'grounded')).toEqual(
          control.filter((check) => check.name !== UP_COUNTER_CHECK),
        );
        sawUpCounter ||= control.some((check) => check.name === UP_COUNTER_CHECK);
      }),
      propertyParameters(),
    );
    // Non-vacuity: the one entry the arms differ by was generated at least once.
    expect(sawUpCounter).toBe(true);
  });
});

const arbPassage: fc.Arbitrary<KnowledgePassage> = fc.record({
  title: fc.constantFrom('VCD dumping', 'Reset idioms'),
  content: fc.constantFrom('Sample outputs at negedge.', 'Hold reset for two cycles.'),
  origin: fc.constant('okf' as const),
  authority: fc.constantFrom('authority' as const, 'hint' as const),
  okfStatus: fc.constantFrom('trusted' as const, 'candidate' as const),
});

const arbGenerationInput: fc.Arbitrary<TestbenchGenerationInput> = fc.record({
  spec: arbSpec,
  intentSummary: fc.constantFrom('count to twelve', 'add two numbers'),
  okfPassages: fc.array(arbPassage, { maxLength: 2 }),
});

const arbRepairInput: fc.Arbitrary<RepairTestbenchModelInput> = fc.record({
  spec: arbSpec,
  previousSource: fc.constantFrom(
    'module tb; endmodule',
    'module tb;\ninitial $finish;\nendmodule',
  ),
  hint: fc.record({
    kind: fc.constant('build-diagnostic' as const),
    diagnostic: fc.constantFrom('tb.v:3: syntax error', 'tb.v:9: Unknown module type: dut'),
  }),
});

/** The section the grounded prompt must carry for `spec`, as one block of text. */
function sectionOf(spec: Spec): string {
  return (
    [ARCHITECTURE_SECTION_LABEL, ARCHITECTURE_FRAMING, spec.architecture, ''].join('\n') + '\n'
  );
}

/** Undo exactly the two grounded differences, to compare with the Control prompt. */
function stripGrounding(prompt: string, spec: Spec): string {
  const withoutSection =
    spec.architecture.trim().length > 0 ? prompt.replace(sectionOf(spec), '') : prompt;
  return withoutSection.replace(FENCED_OUTPUT_CONTRACT_INSTRUCTION, JSON_OUTPUT_CONTRACT);
}

/** How many times `needle` occurs in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The section rule: present exactly once when the text is non-blank, and absent otherwise. */
function expectSectionRule(prompt: string, spec: Spec): void {
  if (spec.architecture.trim().length === 0) {
    expect(prompt).not.toContain(ARCHITECTURE_SECTION_LABEL);
    return;
  }
  expect(occurrences(prompt, ARCHITECTURE_SECTION_LABEL)).toBe(1);
  expect(prompt).toContain(sectionOf(spec) + 'Module interface:');
}

describe(PROPERTY_3, () => {
  it('generation: one section and the fenced contract over the Control prompt', () => {
    fc.assert(
      fc.property(arbGenerationInput, (input) => {
        const checks = requiredChecksFor(input.spec, 'grounded');
        const grounded = buildGroundedTestbenchModelInput(input, checks).prompt;
        expectSectionRule(grounded, input.spec);
        expect(grounded).toContain(CONCURRENCY_RULE);
        expect(grounded).toContain(FENCED_OUTPUT_CONTRACT_INSTRUCTION);
        expect(grounded).not.toContain(JSON_OUTPUT_CONTRACT);
        expect(grounded).not.toMatch(/\$dump(file|vars)/u);
        expect(stripGrounding(grounded, input.spec)).toBe(
          buildTestbenchModelInput(input, checks).prompt,
        );
      }),
      propertyParameters(),
    );
  });

  it('repair: one section and the fenced contract over the Control repair prompt', () => {
    fc.assert(
      fc.property(arbRepairInput, (input) => {
        const grounded = buildGroundedRepairModelInput(input).prompt;
        expectSectionRule(grounded, input.spec);
        expect(grounded).toContain(FENCED_OUTPUT_CONTRACT_INSTRUCTION);
        expect(grounded).not.toMatch(/\$dump(file|vars)/u);
        expect(stripGrounding(grounded, input.spec)).toBe(buildRepairModelInput(input).prompt);
      }),
      propertyParameters(),
    );
  });
});

/** Captures every request and replies with text no parser accepts, so each call stops there. */
class CapturingRouter implements ModelRouter {
  readonly requests: ModelRequest[] = [];
  invoke(
    _task: unknown,
    request: ModelRequest,
    budget: SessionBudgetHandle,
  ): Promise<Result<RoutedModelResult, ModelRouterFailure>> {
    this.requests.push(request);
    budget.charge({ tokens: 1, costCents: 0, wallClockMs: 1 });
    return Promise.resolve({
      ok: true,
      value: {
        task: 'testbench',
        provider: 'deepseek',
        modelId: routedModelIdFor('deepseek'),
        outputText: 'no testbench here',
        tokensUsed: 1,
        costCents: 1,
        attempts: 1,
        fellBack: false,
      },
    });
  }
  describeRouting(): RoutingDiagnostics {
    return { tasks: [], providers: [] };
  }
}

class NoPassages implements KnowledgeRetriever {
  retrieve(): Promise<RetrievalResult> {
    return Promise.resolve({
      passages: [],
      citations: [],
      facts: [],
      source: 'okf',
      sanitized: true,
    });
  }
}

function budget(): SessionBudgetHandle {
  const built = makeSessionBudget({
    sessionId: newUlid(),
    maxIterations: 100,
    maxTokens: 1_000_000,
    maxWallClockMs: 1_000_000,
    maxCostCents: 1_000_000,
    consumedIterations: 0,
    consumedTokens: 0,
    consumedMs: 0,
    consumedCostCents: 0,
  });
  if (!built.ok) {
    throw new Error('test budget must be valid');
  }
  return new InMemorySessionBudgetHandle(built.value);
}

const SIMULATION_CRITERION: AcceptanceCriterion = {
  id: '01HZX0000000000000000000C3',
  text: 'the output follows the specified behaviour',
  measurable: true,
  method: 'simulation',
};

/** Specs the agent reaches the model for: approved, with a simulation criterion. */
const arbCallableSpec: fc.Arbitrary<Spec> = arbSpec.map((spec) => ({
  ...spec,
  acceptanceCriteria: [SIMULATION_CRITERION, ...spec.acceptanceCriteria],
}));

/** The version-5 generation and repair requests for one Spec and arm, as the agent builds them. */
function version5Requests(
  spec: Spec,
  arm: StrategyArm,
  repair: RepairTestbenchRequest,
): readonly ModelRequest[] {
  const checks = requiredChecks(spec);
  const input = { spec, intentSummary: INTENT, okfPassages: [] };
  if (routeCheckingApproach(spec.moduleInterface, arm) === 'cycle-timed') {
    return [buildTestbenchModelInput(input, checks), buildRepairModelInput(repair)];
  }
  const scaffold = renderScoreboardScaffold(
    spec.moduleInterface,
    checks.map((check) => check.name),
  );
  if (!scaffold.ok) {
    return [];
  }
  return [
    buildScoreboardModelInput(input, checks, scaffold.value),
    buildScoreboardRepairModelInput(repair, scaffold.value),
  ];
}

const INTENT = 'a small module';

describe(PROPERTY_4, () => {
  it('sends the version-5 requests under an absent, control, or treatment arm', async () => {
    let sawScoreboard = false;
    await fc.assert(
      fc.asyncProperty(
        arbCallableSpec,
        fc.constantFrom<StrategyArm | undefined>(undefined, 'control', 'treatment'),
        async (spec, arm) => {
          const router = new CapturingRouter();
          const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
          const deps = {
            router,
            recorder,
            retriever: new NoPassages(),
            now: () => 1_700_000_000_000,
          };
          const agent = new TestbenchAgent(
            arm === undefined ? deps : { ...deps, strategyArm: arm },
          );
          const repair: RepairTestbenchRequest = {
            sessionId: newUlid(),
            spec,
            previousSource: 'module tb; endmodule',
            hint: buildRepairHint({ kind: 'precheck-build-failed', diagnostic: 'syntax error' }),
          };
          await agent.generateTestbench(
            { sessionId: newUlid(), spec, intentSummary: INTENT },
            budget(),
          );
          await agent.repairTestbench(repair, budget());
          expect(router.requests).toEqual(version5Requests(spec, arm ?? 'control', repair));
          sawScoreboard ||=
            routeCheckingApproach(spec.moduleInterface, arm ?? 'control') === 'in-order-scoreboard';
        },
      ),
      propertyParameters(),
    );
    // Non-vacuity: the Treatment_Arm's scoreboard route was exercised, not only Cycle_Timed.
    expect(sawScoreboard).toBe(true);
  });
});
