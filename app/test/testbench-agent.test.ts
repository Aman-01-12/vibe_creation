// Example unit tests for the RTL-isolated Testbench_Agent (S6, task 13.3; Req
// 7.1-7.7).
//
// These drive the agent through a FAKE ModelRouter (the injected model seam) and a
// fake KnowledgeRetriever (OKF hints only), plus a real Trace recorder over
// in-memory persistence, so the anti-circular generation path is exercised without
// any provider or network call. The universal Property 4 (RTL isolation, task 13.4)
// and Property 6 (criterion coverage, task 13.5) are separate fast-check properties;
// these examples complement them and pin the signalling format, known-answer checks,
// coverage enforcement, and Spec-version attribution behaviors.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  TestbenchAgent,
  buildTestbenchModelInput,
  detectStandardBlocks,
  formatCheckLine,
  parseTestbenchDraft,
  requiredChecks,
  simulationCriteria,
  sourceEmitsCheck,
  InMemorySessionBudgetHandle,
  InMemoryTracePersistence,
  TraceActionRecorder,
  type GenerateTestbenchRequest,
  type ModelRequest,
  type ModelRouter,
  type ModelRouterFailure,
  type ModelTask,
  type RequiredCheck,
  type RoutedModelResult,
  type RoutingDiagnostics,
  type SessionBudgetHandle,
} from '@app/agent';
import {
  makeSessionBudget,
  newUlid,
  type AcceptanceCriterion,
  type Port,
  type PortDirection,
  type Result,
  type Spec,
} from '@app/core';
import { MUTATION_OPERATORS } from '@app/eval';
import type { KnowledgeQuery, KnowledgeRetriever, RetrievalResult } from '@app/knowledge';
import { propertyParameters, routedModelIdFor } from '@app/test';
import { readCheckSignals } from '@app/tools';

/** Build one measurable, simulation-verifiable acceptance criterion. */
function criterion(text: string): AcceptanceCriterion {
  return { id: newUlid(), text, measurable: true, method: 'simulation' };
}

/** An approved 4-bit up-counter Spec with two simulation criteria (a standard block). */
function approvedCounterSpec(): Spec {
  return {
    id: newUlid(),
    projectId: newUlid(),
    goal: 'A 4-bit synchronous up counter with reset',
    constraints: ['synchronous active-high reset'],
    architecture: 'A single clocked always block increments q on each rising clk edge.',
    moduleInterface: {
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

/**
 * An approved combinational adder Spec of the given data width, with no reset.
 *
 * Declares no clock, no reset, and no ready qualifier, so it exercises the
 * unconditional branch of both the anchoring and the timing rule. The width is a
 * parameter because a multi-bit interface is what makes a bit-level known-answer
 * truth table unjustifiable.
 */
function combinationalAdderSpec(width: number): Spec {
  return {
    id: newUlid(),
    projectId: newUlid(),
    goal: `A ${width}-bit full adder in combinational logic`,
    constraints: ['purely combinational'],
    architecture: 'A ripple-carry chain of full adders.',
    moduleInterface: {
      moduleName: `adder_${width}bit`,
      ports: [
        { name: 'a', direction: 'input', width },
        { name: 'b', direction: 'input', width },
        { name: 'cin', direction: 'input', width: 1 },
        { name: 'sum', direction: 'output', width },
        { name: 'cout', direction: 'output', width: 1 },
      ],
      clocking: { clockName: null, resetName: null, resetActiveLow: false },
    },
    acceptanceCriteria: [criterion('sum and carry-out match the arithmetic sum of a, b and cin')],
    approved: true,
    version: 1,
  };
}

/** An approved accumulator Spec that declares a single-bit `valid_out` qualifier. */
function handshakeAccumulatorSpec(): Spec {
  return {
    id: newUlid(),
    projectId: newUlid(),
    goal: 'Accumulate four serial 8-bit inputs and output their sum',
    constraints: ['active-low reset'],
    architecture: 'A clocked accumulator that pulses valid_out for one cycle per result.',
    moduleInterface: {
      moduleName: 'accu',
      ports: [
        { name: 'clk', direction: 'input', width: 1 },
        { name: 'rst_n', direction: 'input', width: 1 },
        { name: 'data_in', direction: 'input', width: 8 },
        { name: 'valid_in', direction: 'input', width: 1 },
        { name: 'valid_out', direction: 'output', width: 1 },
        { name: 'data_out', direction: 'output', width: 10 },
      ],
      clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
    },
    acceptanceCriteria: [criterion('data_out equals the sum of the four accumulated inputs')],
    approved: true,
    version: 1,
  };
}

/** A generous budget so the model seam, not the budget, drives these cases. */
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

/** A successful routed result carrying the given output text as the model reply. */
function routed(outputText: string): Result<RoutedModelResult, ModelRouterFailure> {
  return {
    ok: true,
    value: {
      task: 'generation',
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

/** A fake Model_Router: returns a scripted result and captures each prompt. */
class FakeModelRouter implements ModelRouter {
  readonly prompts: string[] = [];

  constructor(private readonly script: Result<RoutedModelResult, ModelRouterFailure>) {}

  invoke(
    task: ModelTask,
    request: ModelRequest,
    budget: SessionBudgetHandle,
  ): Promise<Result<RoutedModelResult, ModelRouterFailure>> {
    void task;
    this.prompts.push(request.prompt);
    budget.charge({ tokens: 1, costCents: 0, wallClockMs: 1 });
    return Promise.resolve(this.script);
  }

  describeRouting(): RoutingDiagnostics {
    return { tasks: [], providers: [] };
  }
}

/** A fake Knowledge_Retriever that returns no passages (OKF hints are optional). */
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

/** Build a testbench source that emits a passing CHECK line for every required check. */
function sourceCovering(checks: readonly RequiredCheck[]): string {
  const lines = checks.map((check) => `      $display("${formatCheckLine(check.name, true)}");`);
  return ['module tb;', '  initial begin', ...lines, '    $finish;', '  end', 'endmodule'].join(
    '\n',
  );
}

/** Wire a Testbench_Agent around a scripted fake router + fresh recorder + fake retriever. */
function agentReturning(script: Result<RoutedModelResult, ModelRouterFailure>): {
  agent: TestbenchAgent;
  router: FakeModelRouter;
  retriever: EmptyKnowledgeRetriever;
  recorder: TraceActionRecorder;
} {
  const router = new FakeModelRouter(script);
  const retriever = new EmptyKnowledgeRetriever();
  const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
  const agent = new TestbenchAgent({ router, recorder, retriever, now: () => 1_700_000_000_000 });
  return { agent, router, retriever, recorder };
}

/** A generate request for a fresh session against the given Spec. */
function request(spec: Spec): GenerateTestbenchRequest {
  return {
    sessionId: newUlid(),
    spec,
    intentSummary: 'Build a 4-bit synchronous up counter with active-high reset.',
  };
}

/**
 * Wrap a JSON envelope in the code fence real providers emit, leading space included.
 *
 * Kept faithful to the observed reply rather than tidied: the leading space before
 * the fence is exactly what made a strict `JSON.parse` reject a conforming envelope.
 */
function fencedLikeProvider(envelopeJson: string): string {
  return ` \`\`\`json\n${envelopeJson}\n\`\`\``;
}

/**
 * The observed bedrock-mantle (`moonshotai.kimi-k2.5`) reply, shape-for-shape.
 *
 * Recorded from a live probe that returned HTTP 200 with `finish_reason: "stop"`:
 * the envelope is well formed and correctly escaped, wrapped in a ```json fence
 * with a leading space. Every eval sample failed on this payload with
 * `testbench-unavailable: model output was not valid JSON`, so this fixture pins
 * the regression against a real observed reply rather than an invented one.
 */
const KIMI_FENCED_REPLY = [
  ' ```json',
  '{',
  '  "source": "`timescale 1ns/1ps\\n\\nmodule tb_right_shifter;\\n  reg clk;\\n  reg rst_n;\\n  reg [7:0] d;\\n  wire [7:0] q;\\n\\n  right_shifter dut (.clk(clk), .rst_n(rst_n), .d(d), .q(q));\\n\\n  initial begin\\n    clk = 0;\\n    forever #5 clk = ~clk;\\n  end\\n\\n  initial begin\\n    rst_n = 0;\\n    d = 8\'hA5;\\n    @(posedge clk);\\n    rst_n = 1;\\n    @(posedge clk);\\n    $display(\\"CHECK shifts_right PASS\\");\\n    $finish;\\n  end\\nendmodule"',
  '}',
  '```',
].join('\n');

describe('per-check signalling format matches the oracle (Req 7.6)', () => {
  it('formats CHECK lines the Simulator oracle parses back as pass/fail', () => {
    const passLine = formatCheckLine('reset_clears_output', true);
    const failLine = formatCheckLine('counts_up', false);
    expect(passLine).toBe('CHECK reset_clears_output PASS');
    expect(failLine).toBe('CHECK counts_up FAIL');

    // Round-trip through the real oracle reader: the format cannot drift.
    const reading = readCheckSignals(`banner text\n${passLine}\n${failLine}\n`);
    expect(reading.checks).toEqual([
      { name: 'reset_clears_output', passed: true },
      { name: 'counts_up', passed: false },
    ]);
    // Nothing the formatter emits is ever unreadable to the oracle.
    expect(reading.unreadableSignals).toBe(0);
  });

  it('rejects a check name that is not a single whitespace-free token', () => {
    expect(() => formatCheckLine('has spaces', true)).toThrow();
  });
});

describe('known-answer checks for standard blocks (Req 7.5)', () => {
  it('detects a standard block from the Spec and adds a known-answer check', () => {
    const spec = approvedCounterSpec();
    const blocks = detectStandardBlocks(spec);
    expect(blocks.map((block) => block.block)).toContain('up-counter');

    const checks = requiredChecks(spec);
    const knownAnswer = checks.filter((check) => check.kind === 'known-answer');
    expect(knownAnswer).toHaveLength(1);
    expect(knownAnswer[0]?.name).toBe('known_answer_counter_increments');
  });

  it('adds no known-answer check for a non-standard design', () => {
    const spec: Spec = {
      ...approvedCounterSpec(),
      goal: 'A bespoke protocol arbiter for a custom bus',
      architecture: 'A custom priority arbiter with round-robin tie-breaking.',
      moduleInterface: { ...approvedCounterSpec().moduleInterface, moduleName: 'bus_arbiter' },
    };
    const checks = requiredChecks(spec);
    expect(checks.every((check) => check.kind === 'criterion')).toBe(true);
  });
});

describe('coverage mapping over acceptance criteria (Req 7.3)', () => {
  it('derives one check per simulation-verifiable criterion, traceable to its id', () => {
    const spec = approvedCounterSpec();
    const checks = requiredChecks(spec).filter((check) => check.kind === 'criterion');
    const criteriaIds = simulationCriteria(spec).map((c) => c.id);
    expect(checks).toHaveLength(criteriaIds.length);
    expect(checks.map((check) => check.criterionId)).toEqual(criteriaIds);
    expect(checks.every((check) => /^ac\d+_/.test(check.name))).toBe(true);
  });

  it('excludes criteria not verifiable by simulation', () => {
    const spec: Spec = {
      ...approvedCounterSpec(),
      acceptanceCriteria: [
        criterion('q increments each clock'),
        {
          id: newUlid(),
          text: 'code is well documented',
          measurable: true,
          method: 'manual-inspection',
        },
      ],
    };
    const criterionChecks = requiredChecks(spec).filter((check) => check.kind === 'criterion');
    expect(criterionChecks).toHaveLength(1);
  });
});

describe('TestbenchAgent generation from the Spec (Req 7.1, 7.3, 7.7)', () => {
  it('produces a Testbench that emits a CHECK line for every criterion, attributed to the Spec version', async () => {
    const spec = approvedCounterSpec();
    const checks = requiredChecks(spec);
    const { agent, recorder } = agentReturning(
      routed(JSON.stringify({ source: sourceCovering(checks) })),
    );
    const req = request(spec);

    const outcome = await agent.generateTestbench(req, generousBudget());

    expect(outcome.status).toBe('generated');
    if (outcome.status !== 'generated') {
      throw new Error('expected generated');
    }
    // sourceAttribution is fixed to "spec" by makeTestbench (Req 7.2, 7.7).
    expect(outcome.testbench.sourceAttribution).toBe('spec');
    expect(outcome.testbench.specVersion).toBe(spec.version);
    expect(outcome.testbench.coversCriteria).toEqual(spec.acceptanceCriteria.map((c) => c.id));
    // Every criterion has a CHECK line in the produced source.
    for (const check of checks) {
      expect(sourceEmitsCheck(outcome.testbench.source, check.name)).toBe(true);
    }

    // The span is recorded and attributed to the Spec version (Req 7.7).
    const trace = await recorder.getTrace(req.sessionId);
    expect(trace.spans).toHaveLength(1);
    expect(trace.spans[0]?.stageOrTool).toBe('Testbench_Agent');
    expect(trace.spans[0]?.outputs).toMatchObject({
      status: 'generated',
      sourceAttribution: 'spec',
      specVersion: spec.version,
    });
  });

  it('returns coverage-incomplete and produces no Testbench when a check line is missing', async () => {
    const spec = approvedCounterSpec();
    const checks = requiredChecks(spec);
    // Drop the last required check from the emitted source.
    const partial = sourceCovering(checks.slice(0, checks.length - 1));
    const { agent } = agentReturning(routed(JSON.stringify({ source: partial })));

    const outcome = await agent.generateTestbench(request(spec), generousBudget());

    expect(outcome.status).toBe('coverage-incomplete');
    if (outcome.status === 'coverage-incomplete') {
      expect(outcome.missingChecks).toHaveLength(1);
      expect(outcome.missingChecks[0]?.name).toBe(checks[checks.length - 1]?.name);
    }
  });
});

describe('TestbenchAgent fails closed (Req 7.1, untrusted output)', () => {
  it('refuses to generate from an unapproved Spec', async () => {
    const spec: Spec = { ...approvedCounterSpec(), approved: false };
    const { agent } = agentReturning(routed('unused'));

    const outcome = await agent.generateTestbench(request(spec), generousBudget());

    expect(outcome.status).toBe('generation-failed');
    if (outcome.status === 'generation-failed') {
      expect(outcome.failure.reason).toBe('spec-not-approved');
    }
  });

  it('fails when the Spec has no simulation-verifiable criteria', async () => {
    const spec: Spec = {
      ...approvedCounterSpec(),
      goal: 'A bespoke arbiter',
      architecture: 'custom',
      moduleInterface: { ...approvedCounterSpec().moduleInterface, moduleName: 'arb' },
      acceptanceCriteria: [
        {
          id: newUlid(),
          text: 'reviewed by a human',
          measurable: true,
          method: 'manual-inspection',
        },
      ],
    };
    const { agent } = agentReturning(routed('unused'));

    const outcome = await agent.generateTestbench(request(spec), generousBudget());

    expect(outcome.status).toBe('generation-failed');
    if (outcome.status === 'generation-failed') {
      expect(outcome.failure.reason).toBe('no-simulation-criteria');
    }
  });

  it('treats a malformed model reply as untrusted and fails safe', async () => {
    const { agent, recorder } = agentReturning(routed('not json at all'));
    const req = request(approvedCounterSpec());

    const outcome = await agent.generateTestbench(req, generousBudget());

    expect(outcome.status).toBe('generation-failed');
    if (outcome.status === 'generation-failed') {
      expect(outcome.failure.reason).toBe('unparseable-output');
    }
    const trace = await recorder.getTrace(req.sessionId);
    expect(trace.spans[0]?.failureClass).toBe('tool-error');
  });

  it('fails safe when the Model_Router gives up', async () => {
    const failure: Result<RoutedModelResult, ModelRouterFailure> = {
      ok: false,
      error: { code: 'ALL_PROVIDERS_FAILED', task: 'generation', attempts: 2 },
    };
    const { agent } = agentReturning(failure);

    const outcome = await agent.generateTestbench(request(approvedCounterSpec()), generousBudget());

    expect(outcome.status).toBe('generation-failed');
    if (outcome.status === 'generation-failed') {
      expect(outcome.failure.reason).toBe('model-call-failed');
      expect(outcome.failure.routerFailure?.code).toBe('ALL_PROVIDERS_FAILED');
    }
  });
});

describe('a conforming envelope wrapped in a markdown code fence (Req 7.6 boundary)', () => {
  it('given the real kimi reply when parsed then the fence is stripped and the source decodes verbatim', () => {
    const draft = parseTestbenchDraft(KIMI_FENCED_REPLY);

    expect(draft.ok).toBe(true);
    if (!draft.ok) {
      throw new Error('expected the observed provider reply to parse');
    }
    // The escaped newlines decoded to real ones, so the Simulator sees real Verilog.
    expect(draft.value.source.startsWith('`timescale 1ns/1ps')).toBe(true);
    expect(draft.value.source).toContain('\nmodule tb_right_shifter;\n');
    expect(draft.value.source.trimEnd().endsWith('endmodule')).toBe(true);
    // No fence characters leaked into the payload handed downstream.
    expect(draft.value.source).not.toContain('```');
  });

  it('given a genuinely malformed reply when parsed then it fails with the unchanged reason', () => {
    const draft = parseTestbenchDraft('not json at all');

    expect(draft).toEqual({ ok: false, error: { reason: 'model output was not valid JSON' } });
  });

  it('given a fenced envelope missing the source field when parsed then field validation still rejects it', () => {
    const draft = parseTestbenchDraft(fencedLikeProvider('{"testbench":"module tb; endmodule"}'));

    expect(draft).toEqual({
      ok: false,
      error: { reason: 'model output was missing a non-empty testbench source' },
    });
  });

  it('given bare RTL in a fence with no envelope when parsed then it fails, so a non-conforming model is not masked', () => {
    const draft = parseTestbenchDraft('```verilog\nmodule tb; initial $finish; endmodule\n```');

    expect(draft).toEqual({ ok: false, error: { reason: 'model output was not valid JSON' } });
  });

  it('given a fenced envelope when the agent runs then it generates a Testbench', async () => {
    const spec = approvedCounterSpec();
    const checks = requiredChecks(spec);
    const { agent } = agentReturning(
      routed(fencedLikeProvider(JSON.stringify({ source: sourceCovering(checks) }))),
    );

    const outcome = await agent.generateTestbench(request(spec), generousBudget());

    expect(outcome.status).toBe('generated');
  });
});

/** Build the model input for a Spec, with the checks the Spec itself derives. */
function promptFor(spec: Spec): string {
  return buildTestbenchModelInput(
    { spec, intentSummary: 'a design under test', okfPassages: [] },
    requiredChecks(spec),
  ).prompt;
}

describe('state anchoring is conditioned on the declared interface (Req 7.1, 7.4)', () => {
  it('given an interface with NO reset when the prompt is built then it forbids re-anchoring to an unreachable state', () => {
    const spec: Spec = {
      ...approvedCounterSpec(),
      goal: 'An 8-bit right shifter clocked on the rising edge',
      architecture: 'A single clocked always block shifts q right and inserts d at the MSB.',
      constraints: [],
      moduleInterface: {
        moduleName: 'right_shifter',
        ports: [
          { name: 'clk', direction: 'input', width: 1 },
          { name: 'd', direction: 'input', width: 1 },
          { name: 'q', direction: 'output', width: 8 },
        ],
        clocking: { clockName: 'clk', resetName: null, resetActiveLow: false },
      },
    };

    const prompt = promptFor(spec);

    expect(prompt).toContain('State anchoring:');
    expect(prompt).toContain('do NOT re-anchor an expected value to a state the declared');
    expect(prompt).toContain('derive it from the OBSERVED outputs');
    // The reset-free variant states the capability the interface genuinely lacks.
    expect(prompt).toContain('This interface declares NO reset');
    expect(prompt).toContain('nothing you can drive that returns the design to a known state');
    // ...and never invites the model to reason about a reset this module has no port for.
    expect(prompt).not.toContain('the state reached by');
  });

  it('given an interface WITH a reset when the prompt is built then it names the reset as the reachable anchor', () => {
    const prompt = promptFor(approvedCounterSpec());

    expect(prompt).toContain('State anchoring:');
    expect(prompt).toContain('The only states you may assume outright are time 0 and the state');
    // Named with its polarity, matching how the interface block renders it.
    expect(prompt).toContain('asserting rst (active-high)');
    expect(prompt).not.toContain('declares NO reset');
  });

  it('given an active-low reset when the prompt is built then the anchor carries that polarity', () => {
    const base = approvedCounterSpec();
    const spec: Spec = {
      ...base,
      moduleInterface: {
        ...base.moduleInterface,
        clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
      },
    };

    const prompt = promptFor(spec);

    expect(prompt).toContain('asserting rst_n (active-low)');
    expect(prompt).toContain('Reset: rst_n (active-low)');
  });
});

describe('expected values must be computed, never precomputed (Req 7.1, 7.4)', () => {
  it('given any Spec when the prompt is built then it requires a run-time Verilog expression over the driven stimulus', () => {
    const prompt = promptFor(approvedCounterSpec());

    expect(prompt).toContain('Expected values: COMPUTE each one in the testbench');
    expect(prompt).toContain('Verilog expression over');
    expect(prompt).toContain('the same stimulus you drive');
  });

  it('given any Spec when the prompt is built then it forbids a hand-computed literal for any arithmetic or bit-manipulation result', () => {
    const prompt = promptFor(approvedCounterSpec());

    expect(prompt).toContain('Do NOT write in a constant you worked out by');
    expect(prompt).toContain('hand while composing the testbench');
    // Stated over the general class, so it does not read as one operator's special case.
    expect(prompt).toContain('for any arithmetic or bit-manipulation result');
  });

  it('given two different interfaces when their prompts are built then the rule is identical in both', () => {
    const clocked = promptFor(approvedCounterSpec());
    const combinational = promptFor(combinationalAdderSpec(8));

    // Unconditional: unlike anchoring and timing, it depends on no interface detail.
    for (const prompt of [clocked, combinational]) {
      expect(prompt).toContain('Expected values: COMPUTE each one in the testbench');
    }
  });
});

describe('timing is never assumed, and the rule is conditioned on the interface (Req 7.1, 7.4)', () => {
  it('given any interface when the prompt is built then the Spec is the only source of latency', () => {
    const prompt = promptFor(approvedCounterSpec());

    expect(prompt).toContain('Timing: the Spec is the only source of latency, pipeline depth');
    expect(prompt).toContain('Where it states none, do NOT assume one');
    // The reason, so the rule is a heuristic rather than an unexplained prohibition.
    expect(prompt).toContain('events settle on a single clock edge');
  });

  it('given an interface that declares a valid qualifier when the prompt is built then it names that signal as the timing source', () => {
    const prompt = promptFor(handshakeAccumulatorSpec());

    expect(prompt).toContain("Wait on the design's own valid_out to tell you when a result");
    expect(prompt).toContain('instead of counting cycles to it');
    // The no-qualifier wording is withheld, exactly as the anchoring rule withholds
    // its reset-free wording when a reset exists.
    expect(prompt).not.toContain('declares no such qualifier');
  });

  it('given a declared qualifier when the prompt is built then the qualifier is an observation, not a predicted expected value', () => {
    const prompt = promptFor(handshakeAccumulatorSpec());

    // The carve-out from the compute-every-expected-value rule: predicting the
    // qualifier per cycle is how an unstated latency re-enters as an expectation.
    expect(prompt).toContain('Treat that signal as an OBSERVATION');
    expect(prompt).toContain('never as an expected value you predict');
    expect(prompt).toContain('a per-cycle expectation for it asserts a');
  });

  it('given NO declared qualifier when the prompt is built then the observation carve-out is withheld', () => {
    const prompt = promptFor(combinationalAdderSpec(8));

    // Nothing to observe, so the carve-out would name a control this module lacks.
    expect(prompt).not.toContain('Treat that signal as an OBSERVATION');
    // The unconditional compute rule therefore applies without exception.
    expect(prompt).toContain('Expected values: COMPUTE each one in the testbench');
  });

  it('given an interface with NO qualifier when the prompt is built then it allows only a Spec-pinned sampling point', () => {
    const prompt = promptFor(combinationalAdderSpec(8));

    expect(prompt).toContain('This interface declares no such qualifier');
    expect(prompt).toContain('Spec itself pins the moment down, never at a cycle number you chose');
    expect(prompt).not.toContain("Wait on the design's own");
  });

  it('given a multi-bit qualifier-named output when the prompt is built then it is not offered as a timing source', () => {
    const base = handshakeAccumulatorSpec();
    const spec: Spec = {
      ...base,
      moduleInterface: {
        ...base.moduleInterface,
        // A wide bus whose name happens to contain a qualifier keyword is not a
        // single-bit signal a testbench can wait on.
        ports: base.moduleInterface.ports.map((port) =>
          port.name === 'valid_out' ? { ...port, width: 4 } : port,
        ),
      },
    };

    const prompt = promptFor(spec);

    expect(prompt).toContain('This interface declares no such qualifier');
    expect(prompt).not.toContain("Wait on the design's own valid_out");
  });

  it('given a reset-free interface when the prompt is built then the anchoring and timing rules both appear', () => {
    const prompt = promptFor(combinationalAdderSpec(8));

    // The two rules compose: one governs WHICH state, the other WHEN to sample.
    expect(prompt).toContain('State anchoring:');
    expect(prompt).toContain('Timing:');
    expect(prompt.indexOf('State anchoring:')).toBeLessThan(prompt.indexOf('Timing:'));
  });
});

// -- Input-window alignment (Req 9.1-9.4) ------------------------------------

/**
 * The two markers that identify WHICH input-window derivation the prompt offered.
 *
 * Read from the rendered prompt rather than re-derived here: which branch is legal
 * for an interface is the prompt's decision, and a test that recomputed it would
 * pass while agreeing with the same mistake.
 */
const QUALIFIED_WINDOW_MARKER = "Accept one input per assertion of the design's own ";
const UNQUALIFIED_WINDOW_MARKER = 'This interface declares NO input qualifier';

/** The qualifier names the prompt itself stated, or none when it offered no qualifier. */
function statedInputQualifiers(prompt: string): readonly string[] {
  const start = prompt.indexOf(QUALIFIED_WINDOW_MARKER);
  if (start < 0) {
    return [];
  }
  const from = start + QUALIFIED_WINDOW_MARKER.length;
  const end = prompt.indexOf(':', from);
  return prompt.slice(from, end).split(' / ');
}

describe('input windows are never invented, and the rule is conditioned on the interface (Req 9.1-9.4)', () => {
  it('given any interface when the prompt is built then the Spec is the only source of the sampling edge', () => {
    const prompt = promptFor(approvedCounterSpec());

    expect(prompt).toContain(
      'Input windows: the Spec is the only source of the edge on which a data input is',
    );
    expect(prompt).toContain('sampled. Where it pins none, do NOT decide');
    // The harm named, so the rule reads as a heuristic rather than a prohibition.
    expect(prompt).toContain('which of the inputs');
    expect(prompt).toContain('belong to one result');
  });

  it('given a declared input qualifier when the prompt is built then one window derivation is offered over that qualifier', () => {
    const prompt = promptFor(handshakeAccumulatorSpec());

    expect(prompt).toContain(`${QUALIFIED_WINDOW_MARKER}valid_in`);
    expect(prompt).toContain('hold');
    expect(prompt).toContain('stable for the whole clock period in which you assert the qualifier');
    // The expectation is built from what the testbench itself drove, which is the one
    // derivation that cannot encode a window the Spec never stated.
    expect(prompt).toContain('build the expected result from the inputs YOU drove under an');
    expect(prompt).toContain('one contribution per assertion');
    expect(prompt).toContain('Never from a count of cycles, and never from a window');
    expect(prompt).not.toContain(UNQUALIFIED_WINDOW_MARKER);
  });

  it('given NO declared input qualifier when the prompt is built then a window needs a Spec-pinned moment', () => {
    const prompt = promptFor(combinationalAdderSpec(8));

    expect(prompt).toContain(UNQUALIFIED_WINDOW_MARKER);
    expect(prompt).toContain('ONLY where the Spec pins the sampling moment');
    // The fallback is one input, one result - never a count of inputs sent.
    expect(prompt).toContain('rather than from how many inputs you had sent');
    expect(prompt).not.toContain(QUALIFIED_WINDOW_MARKER);
  });

  it('given an input named like a qualifier but wider than one bit then it is not offered as a window source', () => {
    const base = handshakeAccumulatorSpec();
    const spec: Spec = {
      ...base,
      moduleInterface: {
        ...base.moduleInterface,
        // A multi-bit input is not a qualifier a testbench can assert per input.
        ports: base.moduleInterface.ports.map((port) =>
          port.name === 'valid_in' ? { ...port, width: 2 } : port,
        ),
      },
    };

    const prompt = promptFor(spec);

    expect(prompt).toContain(UNQUALIFIED_WINDOW_MARKER);
    expect(prompt).not.toContain(`${QUALIFIED_WINDOW_MARKER}valid_in`);
  });

  it('given a clock and reset only when the prompt is built then neither is offered as an input qualifier', () => {
    // The declared clock and reset are control, not a handshake: a testbench waiting on
    // one of them would be counting cycles under another name.
    const base = approvedCounterSpec();
    const spec: Spec = {
      ...base,
      moduleInterface: {
        ...base.moduleInterface,
        clocking: { clockName: 'clk_valid', resetName: 'rst_done', resetActiveLow: false },
        ports: [
          { name: 'clk_valid', direction: 'input', width: 1 },
          { name: 'rst_done', direction: 'input', width: 1 },
          { name: 'q', direction: 'output', width: 4 },
        ],
      },
    };

    const prompt = promptFor(spec);

    expect(prompt).toContain(UNQUALIFIED_WINDOW_MARKER);
    expect(statedInputQualifiers(prompt)).toEqual([]);
  });
});

// -- Stimulus adequacy (Req 10.1, 10.2) --------------------------------------

describe('stimulus must be able to tell a wrong design from a right one (Req 10.1, 10.2)', () => {
  it('given any Spec when the prompt is built then the rule is derived from the ports and the criteria', () => {
    const prompt = promptFor(approvedCounterSpec());

    expect(prompt).toContain(
      'Stimulus adequacy: for each required check, choose stimulus that a WRONG design',
    );
    // The reason, stated as the failure it prevents: a check that cannot fail measures
    // nothing, which is how an instrument mints a false `Verified`.
    expect(prompt).toContain('agree passes both, so it proves nothing');
    // Its two sources, named: the declared interface and the Spec's own criteria.
    expect(prompt).toContain('Derive the values from the declared ports');
    expect(prompt).toContain('what each acceptance criterion below asserts');
  });

  it('given any Spec when the prompt is built then it requires stimulus that distinguishes each defect shape', () => {
    const prompt = promptFor(handshakeAccumulatorSpec());

    // A negated condition.
    expect(prompt).toContain('drive both sides of every condition a criterion implies');
    expect(prompt).toContain('the wrong way round');
    // A relaxed equality.
    expect(prompt).toContain('compare each equality at the value itself and at both of its');
    expect(prompt).toContain('comparison relaxed to admit one more value');
    // An altered constant and an inverted arithmetic sign.
    expect(prompt).toContain('a changed constant or a flipped');
    expect(prompt).toContain('arithmetic sign moves the value you compare against');
    // A boundary shifted by one.
    expect(prompt).toContain('drive the lowest and the highest value each declared port can carry');
    expect(prompt).toContain('boundary that sits one position off the specified one');
  });

  it('given a declared vector when the prompt is built then it requires the ends of that vector', () => {
    const prompt = promptFor(combinationalAdderSpec(8));

    expect(prompt).toContain('address the first and the last element of every declared vector');
    expect(prompt).toContain('a width that is off by one');
  });

  it('given a single-bit-only interface when the prompt is built then the vector rule is withheld', () => {
    const prompt = promptFor(combinationalAdderSpec(1));

    // Nothing to index, so demanding the ends of a vector would assert a structure the
    // declared ports cannot justify - the Class 3 mistake in another guise.
    expect(prompt).not.toContain('address the first and the last element');
    // The rest of the rule still applies, because it depends on no width.
    expect(prompt).toContain('Stimulus adequacy:');
    expect(prompt).toContain('drive the lowest and the highest value each declared port can carry');
  });

  it('given any Spec when the prompt is built then it names NO defect class the negative control injects', () => {
    // The circularity guard, and the reason the rule is stated at the altitude of what a
    // check must distinguish. A prompt that named the mutation operators would produce a
    // testbench tuned to the exam rather than to the Spec, and its verdict would stop
    // being independent evidence about anything else.
    const prompts = [
      promptFor(approvedCounterSpec()),
      promptFor(handshakeAccumulatorSpec()),
      promptFor(combinationalAdderSpec(8)),
    ];

    for (const prompt of prompts) {
      const lowercase = prompt.toLowerCase();
      for (const operator of MUTATION_OPERATORS) {
        const spaced = operator.toLowerCase().replace(/_/g, ' ');
        expect(lowercase).not.toContain(operator.toLowerCase());
        expect(lowercase).not.toContain(spaced);
      }
    }
  });
});

/** Port names that name a handshake qualifier, and names that deliberately do not. */
const QUALIFIER_PORT_NAMES: readonly string[] = [
  'valid_in',
  'ready',
  'ack_in',
  'src_valid',
  'done_in',
];
const PLAIN_PORT_NAMES: readonly string[] = ['data_in', 'a', 'b', 'sel', 'mode', 'q', 'sum'];

/** A declared port drawn from both name pools, both directions, and both width classes. */
function portArbitrary(): fc.Arbitrary<Port> {
  return fc.record({
    name: fc.constantFrom(...QUALIFIER_PORT_NAMES, ...PLAIN_PORT_NAMES),
    direction: fc.constantFrom<PortDirection>('input', 'output'),
    width: fc.constantFrom(1, 1, 4, 8),
  });
}

/**
 * An approved Spec whose declared interface is generated, names deduplicated.
 *
 * The name pools mix qualifier-named and plain ports across both directions and both
 * width classes, so the generator reaches an interface with an input qualifier, one
 * without, and the traps in between (a wide `valid_in`, a qualifier-named output only).
 */
function generatedInterfaceSpecArbitrary(): fc.Arbitrary<Spec> {
  return fc
    .record({
      ports: fc.array(portArbitrary(), { minLength: 1, maxLength: 6 }),
      clocked: fc.boolean(),
      resetName: fc.constantFrom<string | null>(null, 'rst', 'rst_n'),
    })
    .map(({ ports, clocked, resetName }) => {
      const named = new Map<string, Port>();
      for (const port of ports) {
        named.set(port.name, port);
      }
      const declared: Port[] = [...named.values()];
      if (clocked) {
        declared.unshift({ name: 'clk', direction: 'input', width: 1 });
      }
      if (resetName !== null) {
        declared.unshift({ name: resetName, direction: 'input', width: 1 });
      }
      const base = approvedCounterSpec();
      return {
        ...base,
        moduleInterface: {
          moduleName: 'generated_dut',
          ports: declared,
          clocking: {
            clockName: clocked ? 'clk' : null,
            resetName,
            resetActiveLow: resetName === 'rst_n',
          },
        },
      };
    });
}

// Feature: eval-campaign-readiness, Property 14: The testbench prompt offers exactly
// one input-window derivation
describe('Property 14: the testbench prompt offers exactly one input-window derivation', () => {
  it('offers exactly one derivation, and names only declared ports of the interface', () => {
    fc.assert(
      fc.property(generatedInterfaceSpecArbitrary(), (spec) => {
        const prompt = promptFor(spec);

        // The prohibition is unconditional, so it is present for every interface.
        expect(prompt).toContain('Input windows: the Spec is the only source of the edge');

        // Exactly one of the two derivations, asserted WITHOUT recomputing which: the
        // branch stays owned by the prompt.
        const offersQualifier = prompt.includes(QUALIFIED_WINDOW_MARKER);
        const withholdsQualifier = prompt.includes(UNQUALIFIED_WINDOW_MARKER);
        expect(offersQualifier).not.toBe(withholdsQualifier);

        // Every qualifier the prompt STATED is a single-bit input this interface really
        // declares, and is neither the clock nor the reset.
        const { clockName, resetName } = spec.moduleInterface.clocking;
        for (const stated of statedInputQualifiers(prompt)) {
          const declared = spec.moduleInterface.ports.find((port) => port.name === stated);
          expect(declared).toBeDefined();
          expect(declared?.direction).toBe('input');
          expect(declared?.width).toBe(1);
          expect(stated).not.toBe(clockName);
          expect(stated).not.toBe(resetName);
        }
      }),
      propertyParameters(),
    );
  });
});

describe('anti-circular guarantee: RTL cannot enter the model input (Req 7.1, 7.2)', () => {
  it('assembles the model input from Spec + intent + OKF only, never RTL', () => {
    const spec = approvedCounterSpec();
    const checks = requiredChecks(spec);
    // A representative RTL implementation string that must never reach the model input.
    const rtl =
      'module up_counter(input clk, input rst, output reg [3:0] q); always @(posedge clk) q <= q + 1; endmodule';

    const modelInput = buildTestbenchModelInput(
      { spec, intentSummary: 'a counter', okfPassages: [] },
      checks,
    );

    // The generation input type has no field to hold RTL, so the assembled prompt
    // is built from the Spec, intent, and OKF only and cannot contain the RTL body.
    expect(modelInput.prompt).not.toContain('q <= q + 1');
    expect(modelInput.prompt).not.toContain(rtl);
    // It does carry the Spec-derived contract the testbench must satisfy.
    expect(modelInput.prompt).toContain('up_counter');
    for (const check of checks) {
      expect(modelInput.prompt).toContain(check.name);
    }
  });
});
