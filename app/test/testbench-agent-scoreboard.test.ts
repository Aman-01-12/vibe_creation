// The strategy-aware Testbench_Agent (testbench-in-order-scoreboard, C6), driven through a fake
// Model_Router so every prompt it sends can be compared byte for byte.
//
// Covers Property 4 (Cycle_Timed requests are byte-identical whatever the arm), Property 11
// (a repair uses the approach generation used), and the scoreboard path's example cases.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  buildRepairHint,
  buildRepairModelInput,
  buildScoreboardModelInput,
  buildScoreboardRepairModelInput,
  buildTestbenchModelInput,
  InMemorySessionBudgetHandle,
  InMemoryTracePersistence,
  renderScoreboardScaffold,
  requiredChecks,
  TestbenchAgent,
  TraceActionRecorder,
  type ModelRequest,
  type ModelRouter,
  type ModelRouterFailure,
  type ModelTask,
  type RepairTestbenchRequest,
  type RoutedModelResult,
  type RoutingDiagnostics,
  type SessionBudgetHandle,
  type StrategyArm,
} from '@app/agent';
import { makeSessionBudget, newUlid, type Port, type Result, type Spec } from '@app/core';
import type { KnowledgeRetriever, RetrievalResult } from '@app/knowledge';
import { propertyParameters, routedModelIdFor, timingContractFor } from '@app/test';

const PROPERTY_4 =
  'Feature: testbench-in-order-scoreboard, Property 4: Cycle_Timed model inputs are byte-identical across arms';
const PROPERTY_11 =
  'Feature: testbench-in-order-scoreboard, Property 11: Repair uses the generation approach';

class FakeRouter implements ModelRouter {
  readonly prompts: string[] = [];
  constructor(private readonly reply: string) {}
  invoke(
    _task: ModelTask,
    request: ModelRequest,
    budget: SessionBudgetHandle,
  ): Promise<Result<RoutedModelResult, ModelRouterFailure>> {
    this.prompts.push(request.prompt);
    budget.charge({ tokens: 1, costCents: 0, wallClockMs: 1 });
    return Promise.resolve({
      ok: true,
      value: {
        task: 'testbench',
        provider: 'deepseek',
        modelId: routedModelIdFor('deepseek'),
        outputText: this.reply,
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

function agent(
  reply: string,
  strategyArm?: StrategyArm,
): { agent: TestbenchAgent; router: FakeRouter } {
  const router = new FakeRouter(reply);
  const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
  const deps = { router, recorder, retriever: new NoPassages(), now: () => 1_700_000_000_000 };
  return {
    agent: new TestbenchAgent(strategyArm === undefined ? deps : { ...deps, strategyArm }),
    router,
  };
}

/** An accumulator Spec; `clocked` and `qualified` move it between the two Design_Groups. */
function accuSpec(options: {
  clocked: boolean;
  qualified: boolean;
  criteria: readonly string[];
}): Spec {
  const ports: Port[] = [
    ...(options.clocked ? [{ name: 'clk', direction: 'input' as const, width: 1 }] : []),
    { name: 'data_in', direction: 'input', width: 8 },
    { name: 'valid_in', direction: 'input', width: 1 },
    ...(options.qualified ? [{ name: 'valid_out', direction: 'output' as const, width: 1 }] : []),
    { name: 'data_out', direction: 'output', width: 10 },
  ];
  return {
    timingContract: timingContractFor({
      validityOutputName: null,
      moduleName: 'accu',
      ports,
      clocking: {
        clockName: options.clocked ? 'clk' : null,
        resetName: null,
        resetActiveLow: false,
      },
    }),
    id: newUlid(),
    projectId: newUlid(),
    goal: 'Accumulate four inputs and output their sum',
    constraints: ['no reset'],
    architecture: 'A clocked accumulator.',
    moduleInterface: {
      validityOutputName: null,
      moduleName: 'accu',
      ports,
      clocking: {
        clockName: options.clocked ? 'clk' : null,
        resetName: null,
        resetActiveLow: false,
      },
    },
    acceptanceCriteria: options.criteria.map((text) => ({
      id: newUlid(),
      text,
      measurable: true,
      method: 'simulation' as const,
    })),
    approved: true,
    version: 1,
  };
}

const STREAMING = accuSpec({ clocked: true, qualified: true, criteria: ['sums four inputs'] });
const INTENT = 'an accumulator';

/** A reply the validator accepts for STREAMING's one required check. */
function goodReply(spec: Spec): string {
  const stimulus = Object.fromEntries(
    requiredChecks(spec).map((check) => [
      check.name,
      'repeat (8) begin stage_data_in = $random; send_transaction; end',
    ]),
  );
  return JSON.stringify({
    runLength: 4,
    expectations: { data_out: 'txn_data_in[0] + txn_data_in[1] + txn_data_in[2] + txn_data_in[3]' },
    stimulus,
  });
}

function repairRequest(spec: Spec): RepairTestbenchRequest {
  return {
    sessionId: newUlid(),
    spec,
    previousSource: 'module tb; endmodule',
    hint: buildRepairHint({ kind: 'precheck-build-failed', diagnostic: 'syntax error' }),
  };
}

describe('the In_Order_Scoreboard path', () => {
  it('assembles a testbench from accepted fragments and the coverage gate accepts it', async () => {
    const { agent: tb } = agent(goodReply(STREAMING), 'treatment');
    const outcome = await tb.generateTestbench(
      { sessionId: newUlid(), spec: STREAMING, intentSummary: INTENT },
      budget(),
    );

    expect(outcome.status).toBe('generated');
    if (outcome.status !== 'generated') {
      return;
    }
    expect(outcome.checkingApproach).toBe('in-order-scoreboard');
    expect(outcome.testbench.source).toContain('txn_data_in[0] + txn_data_in[1]');
    expect(outcome.testbench.source).not.toContain('/*@SLOT');
  });

  it('returns fragments-refused, with the refusal and the reply, when a fragment breaks the contract', async () => {
    const bad = goodReply(STREAMING).replace('txn_data_in[0] +', 'data_out +');
    const { agent: tb } = agent(bad, 'treatment');
    const outcome = await tb.generateTestbench(
      { sessionId: newUlid(), spec: STREAMING, intentSummary: INTENT },
      budget(),
    );

    expect(outcome).toEqual({
      status: 'fragments-refused',
      refusal: { fragment: 'expectations.data_out', criterion: '4.11', construct: 'data_out' },
      source: bad,
    });
  });

  it('routes a clockless interface with one qualifier Cycle_Timed, even under the treatment arm', async () => {
    const clockless = accuSpec({ clocked: false, qualified: true, criteria: ['sums four inputs'] });
    const { agent: tb, router } = agent(
      JSON.stringify({ source: 'module tb; endmodule' }),
      'treatment',
    );
    const input = { spec: clockless, intentSummary: INTENT, okfPassages: [] };
    await tb.generateTestbench(
      { sessionId: newUlid(), spec: clockless, intentSummary: INTENT },
      budget(),
    );

    expect(router.prompts).toEqual([
      buildTestbenchModelInput(input, requiredChecks(clockless)).prompt,
    ]);
    // The renderer would refuse it directly, before any model call could be made.
    expect(renderScoreboardScaffold(clockless.moduleInterface, ['ac1_x'])).toEqual({
      ok: false,
      error: { reason: 'no-clock' },
    });
  });
});

const arbCriteria = fc.array(
  fc.constantFrom('sums four inputs', 'holds when idle', 'wraps at max'),
  {
    minLength: 1,
    maxLength: 3,
  },
);

describe(PROPERTY_4, () => {
  it('sends the version-3 Cycle_Timed request byte for byte under every arm', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbCriteria,
        fc.constantFrom<StrategyArm | undefined>(undefined, 'control', 'treatment'),
        fc.boolean(),
        async (criteria, arm, streaming) => {
          // A Cycle_Exact_Group design under any arm, or a Streaming_Group design under control.
          const spec = accuSpec({ clocked: true, qualified: streaming, criteria });
          if (streaming && arm === 'treatment') {
            return;
          }
          const { agent: tb, router } = agent(
            JSON.stringify({ source: 'module tb; endmodule' }),
            arm,
          );
          await tb.generateTestbench(
            { sessionId: newUlid(), spec, intentSummary: INTENT },
            budget(),
          );
          const repair = repairRequest(spec);
          await tb.repairTestbench(repair, budget());

          const input = { spec, intentSummary: INTENT, okfPassages: [] };
          expect(router.prompts).toEqual([
            buildTestbenchModelInput(input, requiredChecks(spec)).prompt,
            buildRepairModelInput(repair).prompt,
          ]);
        },
      ),
      propertyParameters(),
    );
  });
});

describe(PROPERTY_11, () => {
  it('repairs a Streaming_Group design under treatment with the scoreboard builder', async () => {
    await fc.assert(
      fc.asyncProperty(arbCriteria, async (criteria) => {
        const spec = accuSpec({ clocked: true, qualified: true, criteria });
        const { agent: tb, router } = agent(goodReply(spec), 'treatment');
        await tb.generateTestbench({ sessionId: newUlid(), spec, intentSummary: INTENT }, budget());
        const repair = repairRequest(spec);
        await tb.repairTestbench(repair, budget());

        const rendered = renderScoreboardScaffold(
          spec.moduleInterface,
          requiredChecks(spec).map((check) => check.name),
        );
        if (!rendered.ok) {
          throw new Error('a streaming accumulator must render a scaffold');
        }
        const input = { spec, intentSummary: INTENT, okfPassages: [] };
        expect(router.prompts).toEqual([
          buildScoreboardModelInput(input, requiredChecks(spec), rendered.value).prompt,
          buildScoreboardRepairModelInput(repair, rendered.value).prompt,
        ]);
      }),
      propertyParameters(),
    );
  });
});
