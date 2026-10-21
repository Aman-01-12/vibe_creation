// Example/edge-case unit tests for intent restatement and spec production
// (task 11.8; Req 4.1, 4.2, 4.4, 5.1, 5.2, 5.8).
//
// These concrete, example-based checks complement the broader agent suites
// (intent-agent.test.ts / spec-agent.test.ts) and the numbered fast-check
// properties (tasks 11.2, 11.4, 11.5, 11.7). They pin three behavior clusters the
// design's Testing Strategy calls out as example and edge-case coverage:
//   - restatement quality: a structured restatement carries the summary, every
//     constraint, and every assumption, is refined across a clarify turn, and is
//     shaped cleanly even from messy untrusted model output (Req 4.1, 4.2);
//   - the scope-reduction prompt: an over-scoped idea yields a single-module
//     reduction (at begin AND after a clarify turn), the prompt itself frames the
//     single-module scope decision, and confirmation is blocked until the idea is
//     reduced (Req 4.4);
//   - Spec + block-level architecture production: production yields the goal,
//     constraints, interface, testable criteria, and a non-empty architecture, is
//     driven by the escalated hard-planning model task, and a pre-approval edit to
//     the architecture re-presents at a new version with the rest preserved
//     (Req 5.1, 5.2, 5.8).
//
// Everything runs through a FAKE ModelRouter (no provider call) plus a real Trace
// recorder over in-memory persistence, so the deterministic behavior is exercised
// end to end without any network.

import { describe, expect, it } from 'vitest';

import {
  InMemorySessionBudgetHandle,
  InMemoryTracePersistence,
  IntentAgent,
  SpecAgent,
  TraceActionRecorder,
  buildBeginPrompt,
  buildClarifyPrompt,
  type EditablePresentation,
  type IntentSession,
  type ModelRequest,
  type ModelRouter,
  type ModelRouterFailure,
  type ModelTask,
  type RoutedModelResult,
  type RoutingDiagnostics,
  type SessionBudgetHandle,
  type SpecDraft,
} from '@app/agent';
import { isErr, isOk, makeSessionBudget, newUlid, ok, type Result, type Ulid } from '@app/core';
import { routedModelIdFor } from '@app/test';

/** One recorded model call: the task it was routed to and the prompt it carried. */
interface RecordedCall {
  readonly task: ModelTask;
  readonly prompt: string;
}

/**
 * A fake ModelRouter that replays a scripted reply per call and records each call.
 *
 * It honors the threaded Session_Budget like the real router (refusing when the
 * budget is exhausted) so the injected seam is faithful without reaching any
 * provider. Replies are consumed in order; the last reply is reused once the
 * script is exhausted, which keeps multi-turn intent drives simple.
 */
class FakeModelRouter implements ModelRouter {
  readonly calls: RecordedCall[] = [];
  readonly #replies: readonly Result<RoutedModelResult, ModelRouterFailure>[];
  #index = 0;

  constructor(replies: readonly Result<RoutedModelResult, ModelRouterFailure>[]) {
    if (replies.length === 0) {
      throw new Error('FakeModelRouter needs at least one scripted reply');
    }
    this.#replies = replies;
  }

  invoke(
    task: ModelTask,
    request: ModelRequest,
    budget: SessionBudgetHandle,
  ): Promise<Result<RoutedModelResult, ModelRouterFailure>> {
    this.calls.push({ task, prompt: request.prompt });
    if (!budget.canAfford()) {
      return Promise.resolve({
        ok: false,
        error: { code: 'BUDGET_EXHAUSTED', task, attempts: 0 },
      });
    }
    const reply = this.#replies[Math.min(this.#index, this.#replies.length - 1)];
    if (reply === undefined) {
      throw new Error('FakeModelRouter exhausted its scripted replies');
    }
    this.#index += 1;
    budget.charge({ tokens: 1, costCents: 0, wallClockMs: 1 });
    return Promise.resolve(reply);
  }

  describeRouting(): RoutingDiagnostics {
    return { tasks: [], providers: [] };
  }
}

/** A successful orchestration reply (intent stage) carrying the given JSON. */
function orchestrationReply(json: unknown): Result<RoutedModelResult, ModelRouterFailure> {
  return ok({
    task: 'orchestration',
    provider: 'gemini',
    modelId: routedModelIdFor('gemini'),
    outputText: JSON.stringify(json),
    tokensUsed: 42,
    costCents: 3,
    attempts: 1,
    fellBack: false,
  });
}

/** A successful hard-planning reply (spec stage) carrying the given output text. */
function hardPlanningReply(outputText: string): Result<RoutedModelResult, ModelRouterFailure> {
  return ok({
    task: 'hard-planning',
    provider: 'claude',
    modelId: routedModelIdFor('claude'),
    outputText,
    tokensUsed: 64,
    costCents: 9,
    attempts: 1,
    fellBack: false,
  });
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

/** Build an IntentAgent over a fake router and a real in-memory Trace recorder. */
function intentAgentWith(replies: readonly Result<RoutedModelResult, ModelRouterFailure>[]): {
  readonly agent: IntentAgent;
  readonly router: FakeModelRouter;
} {
  const router = new FakeModelRouter(replies);
  const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
  const agent = new IntentAgent({ router, recorder, now: () => 0 });
  return { agent, router };
}

/** Build a SpecAgent over a single scripted hard-planning reply. */
function specAgentReturning(reply: Result<RoutedModelResult, ModelRouterFailure>): {
  readonly agent: SpecAgent;
  readonly router: FakeModelRouter;
} {
  const router = new FakeModelRouter([reply]);
  const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
  const agent = new SpecAgent({ router, recorder, now: () => 1_700_000_000_000 });
  return { agent, router };
}

/** Unwrap an ok Result or fail the test with the sanitized error. */
function expectOk<T, E>(result: Result<T, E>): T {
  if (!isOk(result)) {
    throw new Error(`expected ok, got error: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

/** A well-formed Spec draft: every port positive-width, every criterion measurable. */
const GOOD_DRAFT: SpecDraft = {
  timingContractEntries: [{ portName: 'q', timing: 'registered' }],
  goal: 'A 4-bit synchronous up counter',
  constraints: ['synchronous active-high reset', 'wraps to zero after 15'],
  architecture:
    'One clocked always block increments q on each rising clk edge; a synchronous ' +
    'reset branch clears q to zero. No sub-blocks; a single register bank drives q.',
  moduleInterface: {
    moduleName: 'counter',
    ports: [
      { name: 'clk', direction: 'input', width: 1 },
      { name: 'rst', direction: 'input', width: 1 },
      { name: 'q', direction: 'output', width: 4 },
    ],
    clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
  },
  acceptanceCriteria: [
    {
      text: 'q increments by one on each clock while not in reset',
      measurable: true,
      method: 'simulation',
    },
    { text: 'q returns to zero when reset is asserted', measurable: true, method: 'simulation' },
  ],
};

const SESSION_ID: Ulid = newUlid();

describe('Intent restatement quality (Req 4.1, 4.2)', () => {
  it('captures the summary, every constraint, and every assumption in order', async () => {
    const { agent } = intentAgentWith([
      orchestrationReply({
        summary: 'An 8-bit synchronous shift register with load and enable.',
        constraints: ['8-bit width', 'synchronous clock', 'active-low reset'],
        assumptions: ['MSB-first shift', 'load has priority over shift'],
        clarifyingQuestions: [],
        scope: 'single-module',
        proposedReduction: '',
      }),
    ]);

    const session = expectOk(
      await agent.begin(
        { sessionId: SESSION_ID, description: 'a shift register' },
        generousBudget(),
      ),
    );

    expect(session.restatement.summary).toContain('shift register');
    // Every constraint is preserved, in the order the model supplied them.
    expect(session.restatement.constraints).toEqual([
      '8-bit width',
      'synchronous clock',
      'active-low reset',
    ]);
    // Assumptions are captured as a distinct part of the structured restatement.
    expect(session.restatement.assumptions).toEqual([
      'MSB-first shift',
      'load has priority over shift',
    ]);
    expect(session.outcome.kind).toBe('ready-for-confirmation');
  });

  it('shapes a clean restatement even from messy untrusted model output', async () => {
    // The model returns blank and non-string constraint entries alongside real
    // ones; the boundary must drop the junk while keeping the genuine content.
    const { agent } = intentAgentWith([
      orchestrationReply({
        summary: 'A parameterized FIFO buffer.',
        constraints: ['depth 16', '   ', 42, '', 'first-word fall-through'],
        assumptions: [null, 'synchronous single clock'],
        clarifyingQuestions: [],
        scope: 'single-module',
      }),
    ]);

    const session = expectOk(
      await agent.begin({ sessionId: SESSION_ID, description: 'a fifo' }, generousBudget()),
    );

    expect(session.restatement.summary).toBe('A parameterized FIFO buffer.');
    // Only the well-formed, non-empty string constraints survive shaping.
    expect(session.restatement.constraints).toEqual(['depth 16', 'first-word fall-through']);
    expect(session.restatement.assumptions).toEqual(['synchronous single clock']);
  });

  it('refines the restatement from the prior state and the student answers', async () => {
    const { agent, router } = intentAgentWith([
      orchestrationReply({
        summary: 'A counter of unspecified width.',
        constraints: [],
        clarifyingQuestions: ['How many bits wide?'],
        scope: 'single-module',
      }),
      orchestrationReply({
        summary: 'A 6-bit synchronous up counter.',
        constraints: ['6-bit output'],
        clarifyingQuestions: [],
        scope: 'single-module',
      }),
    ]);

    const first = expectOk(
      await agent.begin({ sessionId: SESSION_ID, description: 'a counter' }, generousBudget()),
    );
    expect(first.outcome.kind).toBe('clarifying');

    const refined = expectOk(
      await agent.clarify(
        first,
        [{ question: 'How many bits wide?', answer: '6 bits' }],
        generousBudget(),
      ),
    );

    // The refined restatement replaces the ambiguous one and picks up the answer.
    expect(refined.restatement.summary).toContain('6-bit');
    expect(refined.restatement.constraints).toEqual(['6-bit output']);
    expect(refined.outcome.kind).toBe('ready-for-confirmation');

    // The follow-up prompt carried the prior restatement and the student's answer,
    // so the model refined rather than restarted (Req 4.2).
    const clarifyPrompt = router.calls[1]?.prompt ?? '';
    expect(clarifyPrompt).toContain('A counter of unspecified width.');
    expect(clarifyPrompt).toContain('6 bits');
  });
});

describe('Intent prompt construction (Req 4.1, 4.2, 4.4)', () => {
  it('frames the single-module scope decision and requests the structured contract', () => {
    const prompt = buildBeginPrompt('an SPI master with a FIFO and an interrupt line');

    // The student description is embedded as delimited data, not instructions.
    expect(prompt).toContain('an SPI master with a FIFO and an interrupt line');
    // The single-module framing that drives the scope-reduction decision (Req 4.4).
    expect(prompt).toContain('ONE Verilog hardware module');
    // The structured restatement contract the reply is validated against (Req 4.1).
    expect(prompt).toContain('"summary"');
    expect(prompt).toContain('"constraints"');
    expect(prompt).toContain('"scope"');
    expect(prompt).toContain('"proposedReduction"');
  });

  it('carries the current restatement and answers into the refinement prompt', async () => {
    const { agent } = intentAgentWith([
      orchestrationReply({
        summary: 'A UART transmitter, baud rate unspecified.',
        constraints: ['8N1 framing'],
        clarifyingQuestions: ['What baud rate?'],
        scope: 'single-module',
      }),
    ]);
    const session: IntentSession = expectOk(
      await agent.begin({ sessionId: SESSION_ID, description: 'a uart tx' }, generousBudget()),
    );

    const prompt = buildClarifyPrompt(session, [{ question: 'What baud rate?', answer: '115200' }]);

    expect(prompt).toContain('A UART transmitter, baud rate unspecified.');
    expect(prompt).toContain('8N1 framing');
    expect(prompt).toContain('What baud rate?');
    expect(prompt).toContain('115200');
    expect(prompt).toContain('Refine the restatement');
    // The refinement still asks for the same contract, so the reply validates alike.
    expect(prompt).toContain('"scope"');
  });
});

describe('Scope-reduction prompt (Req 4.4)', () => {
  it('proposes a single-module reduction after a clarify turn reveals over-scope', async () => {
    const { agent } = intentAgentWith([
      orchestrationReply({
        summary: 'A data path of unclear extent.',
        clarifyingQuestions: ['Is this one block or several?'],
        scope: 'single-module',
      }),
      orchestrationReply({
        summary: 'A full RISC-V core with pipeline, cache, and CSR file.',
        scope: 'exceeds-single-module',
        proposedReduction: 'Start with just the register file as one module.',
      }),
    ]);

    const first = expectOk(
      await agent.begin({ sessionId: SESSION_ID, description: 'a datapath' }, generousBudget()),
    );
    const reduced = expectOk(
      await agent.clarify(
        first,
        [{ question: 'Is this one block or several?', answer: 'a whole CPU actually' }],
        generousBudget(),
      ),
    );

    expect(reduced.scope).toBe('exceeds-single-module');
    expect(reduced.outcome.kind).toBe('single-module-reduction-proposed');
    if (reduced.outcome.kind === 'single-module-reduction-proposed') {
      expect(reduced.outcome.reduction).toContain('register file');
    }
  });

  it('blocks confirmation until the idea is reduced, then confirms once single-module', async () => {
    const { agent } = intentAgentWith([
      orchestrationReply({
        summary: 'An entire SoC with CPU, memory controller, and peripherals.',
        scope: 'exceeds-single-module',
        proposedReduction: 'Begin with the memory controller alone.',
      }),
      orchestrationReply({
        summary: 'A single memory controller module.',
        constraints: ['single AXI-lite slave port'],
        clarifyingQuestions: [],
        scope: 'single-module',
      }),
    ]);

    const overScoped = expectOk(
      await agent.begin({ sessionId: SESSION_ID, description: 'an SoC' }, generousBudget()),
    );
    // Confirmation is refused while the intent exceeds the single-module slice.
    const blocked = agent.confirm(overScoped);
    expect(isErr(blocked)).toBe(true);
    if (isErr(blocked)) {
      expect(blocked.error.code).toBe('SCOPE_EXCEEDS_SINGLE_MODULE');
    }

    // The student accepts the reduction; the next turn is in scope and confirmable.
    const reduced = expectOk(
      await agent.clarify(
        overScoped,
        [{ question: 'Reduce scope?', answer: 'yes, just the memory controller' }],
        generousBudget(),
      ),
    );
    expect(reduced.scope).toBe('single-module');

    const confirmed = expectOk(agent.confirm(reduced));
    expect(confirmed.confirmation).toBe('confirmed');
  });
});

describe('Spec + block-level architecture production (Req 5.1, 5.2)', () => {
  it('produces the goal, constraints, interface, criteria, and a non-empty architecture', async () => {
    const { agent } = specAgentReturning(hardPlanningReply(JSON.stringify(GOOD_DRAFT)));

    const presentation = await agent.produceSpec(
      { sessionId: newUlid(), projectId: newUlid(), confirmedIntent: 'a 4-bit counter' },
      generousBudget(),
    );

    expect(presentation.status).toBe('awaiting-approval');
    if (presentation.status !== 'awaiting-approval') {
      throw new Error('expected awaiting-approval');
    }
    const { spec } = presentation;
    // The Spec content required by Req 5.1.
    expect(spec.goal).toBe(GOOD_DRAFT.goal);
    expect(spec.constraints).toEqual(GOOD_DRAFT.constraints);
    expect(spec.moduleInterface.ports).toHaveLength(3);
    expect(spec.acceptanceCriteria).toHaveLength(2);
    // The block-level architecture required alongside the Spec by Req 5.2.
    expect(spec.architecture).toBe(GOOD_DRAFT.architecture);
    expect(spec.architecture.trim().length).toBeGreaterThan(0);
    // The architecture is a distinct description, not a copy of the one-line goal.
    expect(spec.architecture).not.toBe(spec.goal);
  });

  it('drives production through the escalated hard-planning model task', async () => {
    const { agent, router } = specAgentReturning(hardPlanningReply(JSON.stringify(GOOD_DRAFT)));

    await agent.produceSpec(
      { sessionId: newUlid(), projectId: newUlid(), confirmedIntent: 'a 4-bit counter' },
      generousBudget(),
    );

    expect(router.calls).toHaveLength(1);
    expect(router.calls[0]?.task).toBe('hard-planning');
  });
});

describe('Spec architecture pre-approval edit (Req 5.8, 5.2)', () => {
  it('re-presents an edited architecture at a new version, preserving the rest', async () => {
    const { agent } = specAgentReturning(hardPlanningReply(JSON.stringify(GOOD_DRAFT)));
    const first = await agent.produceSpec(
      { sessionId: newUlid(), projectId: newUlid(), confirmedIntent: 'a 4-bit counter' },
      generousBudget(),
    );
    expect(first.status).toBe('awaiting-approval');
    const editable = first as EditablePresentation;

    const revisedArchitecture =
      'Two always blocks: a synchronous counter register and a separate ' +
      'combinational wrap-detect that forces q to zero at terminal count.';
    const rePresented = await agent.applyEdits(editable, { architecture: revisedArchitecture });

    expect(rePresented.status).toBe('awaiting-approval');
    if (rePresented.status !== 'awaiting-approval') {
      throw new Error('expected awaiting-approval after edit');
    }
    // The edited architecture is reflected, at a new version, same Spec identity.
    expect(rePresented.spec.architecture).toBe(revisedArchitecture);
    expect(rePresented.spec.version).toBe(2);
    expect(rePresented.spec.approved).toBe(false);
    expect(rePresented.context.specId).toBe(editable.context.specId);
    // The untouched interface and criteria carry through the edit unchanged.
    expect(rePresented.spec.moduleInterface.ports).toHaveLength(3);
    expect(rePresented.spec.acceptanceCriteria).toHaveLength(2);
    expect(rePresented.spec.goal).toBe(GOOD_DRAFT.goal);
  });
});
