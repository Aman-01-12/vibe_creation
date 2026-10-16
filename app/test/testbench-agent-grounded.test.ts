// The Grounded_Arm through the real Testbench_Agent (testbench-spec-grounding, C5): which
// parser a reply meets, what a refusal carries, and the Student_Path's default arm.

import { describe, expect, it } from 'vitest';

import {
  buildGroundedTestbenchModelInput,
  buildRepairHint,
  buildTestbenchModelInput,
  InMemorySessionBudgetHandle,
  InMemoryTracePersistence,
  requiredChecks,
  requiredChecksFor,
  STUDENT_PATH_STRATEGY_ARM,
  TestbenchAgent,
  TraceActionRecorder,
  type ModelRequest,
  type ModelRouter,
  type ModelRouterFailure,
  type RepairTestbenchRequest,
  type RoutedModelResult,
  type RoutingDiagnostics,
  type SessionBudgetHandle,
  type StrategyArm,
} from '@app/agent';
import { makeSessionBudget, newUlid, type Result, type Spec } from '@app/core';
import type { KnowledgeRetriever, RetrievalResult } from '@app/knowledge';
import { routedModelIdFor, timingContractFor } from '@app/test';

/** Replies with each scripted text in turn and records every request. */
class ScriptedRouter implements ModelRouter {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly replies: readonly string[]) {}
  invoke(
    _task: unknown,
    request: ModelRequest,
    budget: SessionBudgetHandle,
  ): Promise<Result<RoutedModelResult, ModelRouterFailure>> {
    const outputText = this.replies[this.requests.length] ?? '';
    this.requests.push(request);
    budget.charge({ tokens: 1, costCents: 0, wallClockMs: 1 });
    return Promise.resolve({
      ok: true,
      value: {
        task: 'testbench',
        provider: 'deepseek',
        modelId: routedModelIdFor('deepseek'),
        outputText,
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

/** A mod-12 up-counter Spec, so the up-counter known-answer check is in the Control list. */
const COUNTER: Spec = {
  timingContract: timingContractFor({
    validityOutputName: null,
    moduleName: 'counter_12',
    ports: [
      { name: 'clk', direction: 'input', width: 1 },
      { name: 'rst_n', direction: 'input', width: 1 },
      { name: 'out', direction: 'output', width: 4 },
    ],
    clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
  }),
  id: newUlid(),
  projectId: newUlid(),
  goal: 'An up counter that wraps at twelve',
  constraints: ['single clock'],
  architecture: 'On each rising edge the count increments; after 11 it returns to 0.',
  moduleInterface: {
    validityOutputName: null,
    moduleName: 'counter_12',
    ports: [
      { name: 'clk', direction: 'input', width: 1 },
      { name: 'rst_n', direction: 'input', width: 1 },
      { name: 'out', direction: 'output', width: 4 },
    ],
    clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
  },
  acceptanceCriteria: [
    { id: newUlid(), text: 'the count wraps after 11', measurable: true, method: 'simulation' },
  ],
  approved: true,
  version: 1,
};

function agentWith(
  replies: readonly string[],
  strategyArm?: StrategyArm,
): { readonly agent: TestbenchAgent; readonly router: ScriptedRouter } {
  const router = new ScriptedRouter(replies);
  const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
  const deps = { router, recorder, retriever: new NoPassages(), now: () => 1_700_000_000_000 };
  const agent = new TestbenchAgent(strategyArm === undefined ? deps : { ...deps, strategyArm });
  return { agent, router };
}

/** A source that prints every one of `spec`'s checks under `arm`. */
function coveringSource(spec: Spec, arm: StrategyArm): string {
  const lines = requiredChecksFor(spec, arm).map(
    (check) => `  initial $display("CHECK ${check.name} PASS");`,
  );
  return ['module tb;', ...lines, '  initial $finish;', 'endmodule', ''].join('\n');
}

function repairOf(spec: Spec): RepairTestbenchRequest {
  return {
    sessionId: newUlid(),
    spec,
    previousSource: 'module tb; endmodule',
    hint: buildRepairHint({ kind: 'precheck-build-failed', diagnostic: 'syntax error' }),
  };
}

const GENERATE = { sessionId: newUlid(), spec: COUNTER, intentSummary: 'a counter' };

describe('the Grounded_Arm Testbench_Agent', () => {
  it('refuses an unfenced reply with no-fence after one model call', async () => {
    const { agent, router } = agentWith(
      [JSON.stringify({ source: 'module tb; endmodule' })],
      'grounded',
    );

    const outcome = await agent.generateTestbench(GENERATE, budget());

    expect(outcome).toEqual({
      status: 'generation-failed',
      failure: {
        reason: 'unparseable-output',
        detail: 'model output contained no fenced code block',
        parseRefusal: 'no-fence',
      },
    });
    expect(router.requests).toHaveLength(1);
  });

  it('sends the grounded request with the grounded check list, and accepts a fenced reply', async () => {
    const source = coveringSource(COUNTER, 'grounded');
    const { agent, router } = agentWith(
      ['Here it is:\n```verilog\n' + source + '```\n'],
      'grounded',
    );

    const outcome = await agent.generateTestbench(GENERATE, budget());

    expect(outcome.status).toBe('generated');
    const input = { spec: COUNTER, intentSummary: 'a counter', okfPassages: [] };
    expect(router.requests).toEqual([
      buildGroundedTestbenchModelInput(input, requiredChecksFor(COUNTER, 'grounded')),
    ]);
    expect(requiredChecks(COUNTER).length).toBe(requiredChecksFor(COUNTER, 'grounded').length + 1);
  });

  it('parses a grounded repair with the fenced parser', async () => {
    const source = coveringSource(COUNTER, 'grounded');
    const { agent } = agentWith(['```verilog\n' + source + '```\n'], 'grounded');

    const outcome = await agent.repairTestbench(repairOf(COUNTER), budget());

    expect(outcome.status).toBe('generated');
  });

  it('parses a Control_Arm repair with the JSON parser, so a fenced Verilog reply is refused', async () => {
    const source = coveringSource(COUNTER, 'control');
    const { agent } = agentWith(['```verilog\n' + source + '```\n'], 'control');

    const outcome = await agent.repairTestbench(repairOf(COUNTER), budget());

    expect(outcome).toEqual({
      status: 'generation-failed',
      failure: {
        reason: 'unparseable-output',
        detail: 'model output was not valid JSON',
        parseRefusal: 'not-json',
      },
    });
  });

  it('defaults the Student_Path to control, which sends the Control_Arm request', async () => {
    expect(STUDENT_PATH_STRATEGY_ARM).toBe('control');
    const { agent, router } = agentWith([
      JSON.stringify({ source: coveringSource(COUNTER, 'control') }),
    ]);

    await agent.generateTestbench(GENERATE, budget());

    const input = { spec: COUNTER, intentSummary: 'a counter', okfPassages: [] };
    expect(router.requests).toEqual([buildTestbenchModelInput(input, requiredChecks(COUNTER))]);
  });
});
