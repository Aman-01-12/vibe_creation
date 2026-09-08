// Unit tests for the Generation_Agent (S4, task 13.1).
//
// Driven through a FAKE Model_Router and (for the compiler seam) both a fake
// compiler and a real Simulator adapter backed by the FakeSandboxRuntime, these
// examples exercise the behaviors Req 6.1-6.7 and 17.6 demand: a candidate whose
// interface matches the Spec exactly; a candidate with an extra/missing port that
// is revised rather than accepted; reading a compiler error and issuing a repair
// call; budget exhaustion presenting the last failing candidate labeled
// `Unverified`; and progress streaming incrementally without blocking. Property 17
// (the numbered exact-interface property) is task 13.2, not here.

import { describe, expect, it } from 'vitest';

import { err, newUlid, ok, type Result, type SessionBudget, type Spec, type Ulid } from '@app/core';
import {
  FakeSandboxRuntime,
  IcarusSimulatorAdapter,
  SandboxToolRunner,
  type RawRunCapture,
  type ResourceLimits,
  type SourceFile,
} from '@app/tools';

import { InMemoryTracePersistence, TraceActionRecorder } from '../../action-recorder/index.js';
import {
  InMemorySessionBudgetHandle,
  type ModelRequest,
  type ModelRouter,
  type ModelRouterFailure,
  type ModelTask,
  type RoutedModelResult,
  type RoutingDiagnostics,
  type SessionBudgetHandle,
} from '../../model-router/index.js';

import { GenerationAgent } from './generation-agent.js';
import { SimulatorCandidateCompiler } from './candidate-compiler.js';
import { parseCandidateRtl } from './model-output.js';
import type { CandidateCompiler, CompileOutcome, GenerationProgressEvent } from './types.js';

const COMPILE_LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5000 };

/** The model id the fake router reports as the routed selection (a fake, not config). */
const FAKE_ROUTED_MODEL_ID = 'fake-routed-model';

/** An approved byte-register Spec: two data ports plus a clock/reset contract. */
function approvedSpec(overrides: Partial<Spec> = {}): Spec {
  return {
    id: newUlid(),
    projectId: newUlid(),
    goal: 'A byte register that captures d on the clock edge.',
    constraints: [],
    moduleInterface: {
      moduleName: 'byte_reg',
      ports: [
        { name: 'd', direction: 'input', width: 8 },
        { name: 'q', direction: 'output', width: 8 },
      ],
      clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
    },
    acceptanceCriteria: [],
    architecture: 'Single always block latching d into q.',
    approved: true,
    version: 1,
    ...overrides,
  };
}

/** RTL whose ANSI header matches the Spec interface exactly. */
const MATCHING_RTL = [
  'module byte_reg (',
  '  input  wire        clk,',
  '  input  wire        rst_n,',
  '  input  wire [7:0]  d,',
  '  output reg  [7:0]  q',
  ');',
  "  always @(posedge clk) q <= rst_n ? d : 8'b0;",
  'endmodule',
].join('\n');

/** RTL that introduces an `en` port absent from the Spec (Req 6.4 violation). */
const EXTRA_PORT_RTL = [
  'module byte_reg (',
  '  input  wire        clk,',
  '  input  wire        rst_n,',
  '  input  wire        en,',
  '  input  wire [7:0]  d,',
  '  output reg  [7:0]  q',
  ');',
  'endmodule',
].join('\n');

/** Wrap RTL in the JSON envelope the model is instructed to emit. */
function reply(rtl: string): string {
  return JSON.stringify({ rtl });
}
/**
 * The same envelope wrapped in the markdown fence real providers emit.
 *
 * The leading space before the fence is faithful to the observed provider reply,
 * which a strict `JSON.parse` rejected even though the envelope inside was correct.
 */
function fencedReply(rtl: string): string {
  return ` \`\`\`json\n${reply(rtl)}\n\`\`\``;
}

/** A Model_Router test double that scripts outputs and threads the budget like the real router. */
class FakeModelRouter implements ModelRouter {
  readonly calls: { task: ModelTask; prompt: string }[] = [];
  readonly #outputs: readonly string[];
  #index = 0;

  constructor(outputs: readonly string[]) {
    this.#outputs = outputs;
  }

  invoke(
    task: ModelTask,
    request: ModelRequest,
    budget: SessionBudgetHandle,
  ): Promise<Result<RoutedModelResult, ModelRouterFailure>> {
    this.calls.push({ task, prompt: request.prompt });
    if (!budget.canAfford()) {
      const budgetStopReason = budget.stopReason() ?? 'max-iterations';
      return Promise.resolve(
        err({ code: 'BUDGET_EXHAUSTED', task, attempts: 0, budgetStopReason }),
      );
    }
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    const outputText = this.#outputs[Math.min(this.#index, this.#outputs.length - 1)] as string;
    this.#index += 1;
    return Promise.resolve(
      ok({
        task,
        provider: 'deepseek',
        modelId: FAKE_ROUTED_MODEL_ID,
        outputText,
        tokensUsed: 1,
        costCents: 1,
        attempts: 1,
        fellBack: false,
      }),
    );
  }

  describeRouting(): RoutingDiagnostics {
    return { tasks: [], providers: [] };
  }
}

/** A compiler test double that scripts per-call compile outcomes and records its inputs. */
class FakeCandidateCompiler implements CandidateCompiler {
  readonly calls: SourceFile[][] = [];
  readonly #outcomes: readonly CompileOutcome[];
  #index = 0;

  constructor(outcomes: readonly CompileOutcome[]) {
    this.#outcomes = outcomes;
  }

  compile(rtl: readonly SourceFile[]): Promise<CompileOutcome> {
    this.calls.push([...rtl]);
    const outcome = this.#outcomes[
      Math.min(this.#index, this.#outcomes.length - 1)
    ] as CompileOutcome;
    this.#index += 1;
    return Promise.resolve(outcome);
  }
}

/** Open an in-memory budget handle with the given iteration cap and generous other caps. */
function budgetWithIterations(maxIterations: number): InMemorySessionBudgetHandle {
  const budget: SessionBudget = {
    sessionId: newUlid(),
    maxIterations,
    maxTokens: 1_000_000,
    maxWallClockMs: 1_000_000,
    maxCostCents: 1_000_000,
    consumedIterations: 0,
    consumedTokens: 0,
    consumedMs: 0,
    consumedCostCents: 0,
  };
  return new InMemorySessionBudgetHandle(budget);
}

/** Assemble an agent over the given fakes with a fresh in-memory Action_Recorder. */
function makeAgent(router: ModelRouter, compiler: CandidateCompiler): GenerationAgent {
  const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
  return new GenerationAgent({ router, compiler, recorder });
}

/** A generation input for the given spec with fresh session/project ids. */
function inputFor(spec: Spec): { sessionId: Ulid; projectId: Ulid; spec: Spec } {
  return { sessionId: newUlid(), projectId: newUlid(), spec };
}

describe('GenerationAgent.run - exact interface (Req 6.1, 6.4)', () => {
  it('produces a compiling candidate whose interface matches the Spec, labeled Unverified', async () => {
    const router = new FakeModelRouter([reply(MATCHING_RTL)]);
    const compiler = new FakeCandidateCompiler([{ compiled: true, diagnostics: '' }]);
    const agent = makeAgent(router, compiler);

    const outcome = await agent.generate(inputFor(approvedSpec()), budgetWithIterations(8));

    expect(outcome.status).toBe('ready-for-verification');
    if (outcome.status !== 'ready-for-verification') return;
    expect(outcome.candidate.interfaceMatch.matches).toBe(true);
    expect(outcome.candidate.label.tier).toBe('Unverified');
    expect(router.calls).toHaveLength(1);
    expect(router.calls[0]?.task).toBe('generation');
    expect(compiler.calls).toHaveLength(1);
  });

  it('revises a candidate that introduces an extra port instead of accepting it', async () => {
    const router = new FakeModelRouter([reply(EXTRA_PORT_RTL), reply(MATCHING_RTL)]);
    const compiler = new FakeCandidateCompiler([{ compiled: true, diagnostics: '' }]);
    const agent = makeAgent(router, compiler);

    const outcome = await agent.generate(inputFor(approvedSpec()), budgetWithIterations(8));

    expect(outcome.status).toBe('ready-for-verification');
    // The extra-port candidate never reached the compiler; only the corrected one did.
    expect(compiler.calls).toHaveLength(1);
    expect(router.calls[1]?.task).toBe('repair');
    expect(router.calls[1]?.prompt).toContain('Remove port "en"');
  });
});

describe('GenerationAgent.run - compiler-driven revision (Req 6.2, 6.3)', () => {
  it('reads a compiler error and issues a repair call carrying the diagnostics', async () => {
    const router = new FakeModelRouter([reply(MATCHING_RTL), reply(MATCHING_RTL)]);
    const compiler = new FakeCandidateCompiler([
      { compiled: false, diagnostics: 'byte_reg.v:7: syntax error, unexpected ;' },
      { compiled: true, diagnostics: '' },
    ]);
    const agent = makeAgent(router, compiler);

    const outcome = await agent.generate(inputFor(approvedSpec()), budgetWithIterations(8));

    expect(outcome.status).toBe('ready-for-verification');
    if (outcome.status !== 'ready-for-verification') return;
    expect(outcome.iterations).toBe(2);
    expect(router.calls[1]?.task).toBe('repair');
    expect(router.calls[1]?.prompt).toContain('syntax error');
    expect(compiler.calls).toHaveLength(2);
  });
});

describe('GenerationAgent.run - budget exhaustion (Req 6.5)', () => {
  it('presents the last failing candidate and its errors labeled Unverified, never Verified', async () => {
    const router = new FakeModelRouter([reply(MATCHING_RTL)]);
    const compiler = new FakeCandidateCompiler([{ compiled: false, diagnostics: 'still broken' }]);
    const agent = makeAgent(router, compiler);

    const outcome = await agent.generate(inputFor(approvedSpec()), budgetWithIterations(2));

    expect(outcome.status).toBe('budget-exhausted');
    if (outcome.status !== 'budget-exhausted') return;
    expect(outcome.candidate).not.toBeNull();
    expect(outcome.candidate?.label.tier).toBe('Unverified');
    expect(outcome.diagnostics).toBe('still broken');
    expect(outcome.stopReason).toBe('max-iterations');
    expect(outcome.iterations).toBe(2);
  });
});

describe('GenerationAgent.run - streaming and gating (Req 6.6, 6.7, 17.6)', () => {
  it('emits a progress event before the run completes and never labels a candidate Verified', async () => {
    const router = new FakeModelRouter([reply(MATCHING_RTL)]);
    const compiler = new FakeCandidateCompiler([{ compiled: true, diagnostics: '' }]);
    const agent = makeAgent(router, compiler);

    const iterator = agent.run(inputFor(approvedSpec()), budgetWithIterations(8));
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect((first.value as GenerationProgressEvent).phase).toBe('generating');

    const phases: string[] = [(first.value as GenerationProgressEvent).phase];
    let step = await iterator.next();
    while (!step.done) {
      phases.push(step.value.phase);
      step = await iterator.next();
    }
    expect(phases).toContain('compiling');
    expect(step.value.status).toBe('ready-for-verification');
    if (step.value.status !== 'ready-for-verification') return;
    expect(step.value.candidate.label.tier).not.toBe('Verified');
  });

  it('fails safe without any model call when the Spec is not approved', async () => {
    const router = new FakeModelRouter([reply(MATCHING_RTL)]);
    const compiler = new FakeCandidateCompiler([{ compiled: true, diagnostics: '' }]);
    const agent = makeAgent(router, compiler);

    const outcome = await agent.generate(
      inputFor(approvedSpec({ approved: false })),
      budgetWithIterations(8),
    );

    expect(outcome.status).toBe('generation-failed');
    if (outcome.status !== 'generation-failed') return;
    expect(outcome.reason).toBe('spec-not-approved');
    expect(router.calls).toHaveLength(0);
  });
});

describe('parseCandidateRtl - a conforming envelope wrapped in a markdown code fence', () => {
  it('given a fenced envelope when parsed then the fence is stripped and the RTL is returned verbatim', () => {
    const parsed = parseCandidateRtl(fencedReply(MATCHING_RTL));

    expect(parsed).toEqual({ ok: true, value: MATCHING_RTL });
  });

  it('given a genuinely malformed reply when parsed then it fails with the unchanged reason', () => {
    const parsed = parseCandidateRtl('not json at all');

    expect(parsed).toEqual({ ok: false, error: { reason: 'model output was not valid JSON' } });
  });

  it('given a fenced envelope with an empty rtl field when parsed then field validation still rejects it', () => {
    const parsed = parseCandidateRtl(fencedReply('   '));

    expect(parsed).toEqual({
      ok: false,
      error: { reason: 'model output was missing a non-empty "rtl" string' },
    });
  });

  it('given bare RTL in a fence with no envelope when parsed then it fails, so a non-conforming model is not masked', () => {
    const parsed = parseCandidateRtl(`\`\`\`verilog\n${MATCHING_RTL}\n\`\`\``);

    expect(parsed).toEqual({ ok: false, error: { reason: 'model output was not valid JSON' } });
  });

  it('given a fenced envelope when the agent runs then it reaches verification', async () => {
    const router = new FakeModelRouter([fencedReply(MATCHING_RTL)]);
    const compiler = new FakeCandidateCompiler([{ compiled: true, diagnostics: '' }]);
    const agent = makeAgent(router, compiler);

    const outcome = await agent.generate(inputFor(approvedSpec()), budgetWithIterations(8));

    expect(outcome.status).toBe('ready-for-verification');
  });
});

describe('GenerationAgent.run - compiler seam over the Simulator + FakeSandboxRuntime', () => {
  /** A raw capture for a run that failed to compile: no VCD, compiler error on stderr. */
  function compileErrorCapture(): RawRunCapture {
    return {
      timedOut: false,
      infraFailure: false,
      exitCode: 1,
      stdout: '',
      stderr: 'byte_reg.v:7: syntax error, unexpected ;',
      stdoutTruncated: false,
      stderrTruncated: false,
      diskLimitExceeded: false,
      artifacts: {},
      deniedOperations: [],
      resourceUsage: { wallMs: 10, maxMemMb: 8, cpuMs: 8 },
    };
  }

  /** A raw capture for a clean compile: the harness emits its passing check and a VCD. */
  function cleanCompileCapture(): RawRunCapture {
    return {
      timedOut: false,
      infraFailure: false,
      exitCode: 0,
      stdout: 'CHECK compile_ok PASS\n',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      diskLimitExceeded: false,
      artifacts: { vcd: { name: 'dump.vcd', sizeBytes: 8, sha256: 'a'.repeat(64) } },
      deniedOperations: [],
      resourceUsage: { wallMs: 12, maxMemMb: 8, cpuMs: 10 },
    };
  }

  it('reads a real compiler error from the sandbox-backed Simulator and revises to a clean compile', async () => {
    const spec = approvedSpec();
    let runCount = 0;
    const runtime = new FakeSandboxRuntime(() =>
      runCount++ === 0 ? compileErrorCapture() : cleanCompileCapture(),
    );
    const simulator = new IcarusSimulatorAdapter(new SandboxToolRunner(runtime));
    const compiler = new SimulatorCandidateCompiler(
      simulator,
      spec.moduleInterface,
      COMPILE_LIMITS,
    );
    const router = new FakeModelRouter([reply(MATCHING_RTL), reply(MATCHING_RTL)]);
    const agent = makeAgent(router, compiler);

    const outcome = await agent.generate(inputFor(spec), budgetWithIterations(8));

    expect(outcome.status).toBe('ready-for-verification');
    if (outcome.status !== 'ready-for-verification') return;
    expect(outcome.iterations).toBe(2);
    expect(router.calls[1]?.task).toBe('repair');
    expect(router.calls[1]?.prompt).toContain('syntax error');
  });
});
