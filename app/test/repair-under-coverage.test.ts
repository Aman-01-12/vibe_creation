// testbench-repair-loop, task 4.4: `repairTestbench` applies the SAME `#validateCoverage`
// gate `generateTestbench` already applies to a first draft (Req 6.3).
//
// This mirrors testbench-agent.test.ts's own under-coverage case for `generateTestbench`
// ("returns coverage-incomplete and produces no Testbench when a check line is missing"),
// over `repairTestbench` instead, to pin that both methods return the IDENTICAL
// `TestbenchGenerationOutcome` shape - same discriminant, same field names, same content
// kind (the missing check names) - rather than two similarly-shaped but distinct types.

import { describe, expect, it } from 'vitest';

import {
  TestbenchAgent,
  buildRepairHint,
  formatCheckLine,
  requiredChecks,
  InMemorySessionBudgetHandle,
  InMemoryTracePersistence,
  TraceActionRecorder,
  type ModelRequest,
  type ModelRouter,
  type ModelRouterFailure,
  type ModelTask,
  type RepairTestbenchRequest,
  type RequiredCheck,
  type RoutedModelResult,
  type RoutingDiagnostics,
  type SessionBudgetHandle,
} from '@app/agent';
import {
  makeSessionBudget,
  newUlid,
  type AcceptanceCriterion,
  type Result,
  type Spec,
} from '@app/core';
import type { KnowledgeQuery, KnowledgeRetriever, RetrievalResult } from '@app/knowledge';
import { routedModelIdFor, timingContractFor } from '@app/test';

/** Build one measurable, simulation-verifiable acceptance criterion. */
function criterion(text: string): AcceptanceCriterion {
  return { id: newUlid(), text, measurable: true, method: 'simulation' };
}

/** An approved 4-bit up-counter Spec with two simulation criteria. */
function approvedCounterSpec(): Spec {
  return {
    timingContract: timingContractFor({
      validityOutputName: null,
      moduleName: 'up_counter',
      ports: [
        { name: 'clk', direction: 'input', width: 1 },
        { name: 'rst', direction: 'input', width: 1 },
        { name: 'q', direction: 'output', width: 4 },
      ],
      clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
    }),
    id: newUlid(),
    projectId: newUlid(),
    goal: 'A 4-bit synchronous up counter with reset',
    constraints: ['synchronous active-high reset'],
    architecture: 'A single clocked always block increments q on each rising clk edge.',
    moduleInterface: {
      validityOutputName: null,
      moduleName: 'up_counter',
      ports: [
        { name: 'clk', direction: 'input', width: 1 },
        { name: 'rst', direction: 'input', width: 1 },
        { name: 'q', direction: 'output', width: 4 },
      ],
      clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
    },
    acceptanceCriteria: [
      criterion('q increments by one on each clock while not in reset'),
      criterion('q returns to zero when reset is asserted'),
    ],
    approved: true,
    version: 3,
  };
}

/** Build a testbench source that emits a passing CHECK line for every required check. */
function sourceCovering(checks: readonly RequiredCheck[]): string {
  const lines = checks.map((check) => `      $display("${formatCheckLine(check.name, true)}");`);
  return ['module tb;', '  initial begin', ...lines, '    $finish;', '  end', 'endmodule'].join(
    '\n',
  );
}

/** A fake Model_Router: returns a scripted result and captures each prompt. */
class FakeModelRouter implements ModelRouter {
  readonly prompts: string[] = [];
  readonly tasks: ModelTask[] = [];

  constructor(private readonly script: Result<RoutedModelResult, ModelRouterFailure>) {}

  invoke(
    task: ModelTask,
    request: ModelRequest,
    budget: SessionBudgetHandle,
  ): Promise<Result<RoutedModelResult, ModelRouterFailure>> {
    this.tasks.push(task);
    this.prompts.push(request.prompt);
    budget.charge({ tokens: 1, costCents: 0, wallClockMs: 1 });
    return Promise.resolve(this.script);
  }

  describeRouting(): RoutingDiagnostics {
    return { tasks: [], providers: [] };
  }
}

/** A fake Knowledge_Retriever that returns no passages (unused on the repair path). */
class EmptyKnowledgeRetriever implements KnowledgeRetriever {
  readonly queries: KnowledgeQuery[] = [];

  retrieve(query: KnowledgeQuery): Promise<RetrievalResult> {
    this.queries.push(query);
    return Promise.resolve({
      passages: [],
      citations: [],
      facts: [],
      source: 'okf',
      sanitized: true,
    });
  }
}

/** A successful routed result carrying the given output text as the model reply. */
function routed(outputText: string): Result<RoutedModelResult, ModelRouterFailure> {
  return {
    ok: true,
    value: {
      task: 'testbench',
      provider: 'deepseek',
      modelId: routedModelIdFor('deepseek'),
      outputText,
      tokensUsed: 42,
      costCents: 5,
      attempts: 1,
      fellBack: false,
    },
  };
}

/** A generous budget so the model seam, not the budget, drives this case. */
function generousBudget(): SessionBudgetHandle {
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

/** A repair request over the given Spec, with a build-diagnostic hint and a prior source. */
function repairRequest(spec: Spec, previousSource: string): RepairTestbenchRequest {
  return {
    sessionId: newUlid(),
    spec,
    previousSource,
    hint: buildRepairHint({
      kind: 'precheck-build-failed',
      diagnostic: 'syntax error near line 4',
    }),
  };
}

describe('repairTestbench applies the same coverage gate as a first draft (Req 6.3)', () => {
  it('returns coverage-incomplete and produces no Testbench when a check line is missing', async () => {
    const spec = approvedCounterSpec();
    const checks = requiredChecks(spec);
    // Drop the last required check from the revised source, exactly as the
    // generateTestbench sibling case does.
    const partial = sourceCovering(checks.slice(0, checks.length - 1));
    const router = new FakeModelRouter(routed(JSON.stringify({ source: partial })));
    const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
    const retriever = new EmptyKnowledgeRetriever();
    const agent = new TestbenchAgent({
      router,
      recorder,
      retriever,
      now: () => 1_700_000_000_000,
    });

    const outcome = await agent.repairTestbench(
      repairRequest(spec, sourceCovering(checks)),
      generousBudget(),
    );

    // The identical discriminant and field shape generateTestbench's own under-coverage
    // case returns: 'coverage-incomplete', the missing check(s), and the rejected source.
    expect(outcome.status).toBe('coverage-incomplete');
    if (outcome.status !== 'coverage-incomplete') {
      return;
    }
    expect(outcome.missingChecks).toHaveLength(1);
    expect(outcome.missingChecks[0]?.name).toBe(checks[checks.length - 1]?.name);
    expect(outcome.source).toBe(partial);
  });
});
