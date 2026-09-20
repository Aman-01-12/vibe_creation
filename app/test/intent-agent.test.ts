// Example unit tests for the Intent_Agent (S0) (task 11.1; Req 4.1, 4.2, 4.4, 4.5, 4.7).
//
// Concrete checks of the agent's core behaviors, driven through a FAKE
// ModelRouter (no real provider) and a real Trace recorder:
//   - a structured restatement is produced (Req 4.1);
//   - clarification stops at the bound and proposes a default scope (Req 4.3, 4.4);
//   - an out-of-scope idea yields a single-module reduction and blocks confirmation
//     until the scope is reduced (Req 4.4, 4.5);
//   - generation stays blocked until explicit confirmation (Req 4.5, 4.6);
//   - every produced artifact is labeled Not_Applicable (Req 4.7).
//
// The universal Property 14 (clarification rounds are bounded) is a separate
// fast-check property in task 11.2; these examples complement it.

import { describe, expect, it } from 'vitest';

import {
  InMemorySessionBudgetHandle,
  InMemoryTracePersistence,
  IntentAgent,
  TraceActionRecorder,
  isIntentConfirmed,
  parseIntentAnalysis,
  MAX_CLARIFICATION_ROUNDS,
  type ModelRequest,
  type ModelRouter,
  type ModelRouterFailure,
  type ModelTask,
  type RoutedModelResult,
  type RoutingDiagnostics,
  type SessionBudgetHandle,
} from '@app/agent';
import { isErr, isOk, makeSessionBudget, newUlid, ok, type Result, type Ulid } from '@app/core';
import { routedModelIdFor } from '@app/test';

/** A fake ModelRouter that replays a scripted reply per call, recording prompts. */
class FakeModelRouter implements ModelRouter {
  readonly prompts: string[] = [];
  #replies: readonly Result<RoutedModelResult, ModelRouterFailure>[];
  #index = 0;

  constructor(replies: readonly Result<RoutedModelResult, ModelRouterFailure>[]) {
    this.#replies = replies;
  }

  invoke(
    _task: ModelTask,
    request: ModelRequest,
    budget: SessionBudgetHandle,
  ): Promise<Result<RoutedModelResult, ModelRouterFailure>> {
    this.prompts.push(request.prompt);
    // Honor the threaded budget as a real router would: refuse when exhausted.
    if (!budget.canAfford()) {
      return Promise.resolve({
        ok: false,
        error: { code: 'BUDGET_EXHAUSTED', task: 'orchestration', attempts: 0 },
      });
    }
    const nextReply = this.#replies[Math.min(this.#index, this.#replies.length - 1)];
    if (nextReply === undefined) {
      throw new Error('FakeModelRouter was constructed with no scripted replies');
    }
    this.#index += 1;
    return Promise.resolve(nextReply);
  }

  describeRouting(): RoutingDiagnostics {
    return { tasks: [], providers: [] };
  }
}

/** A successful routed result carrying the given JSON text as the model output. */
function reply(json: unknown): Result<RoutedModelResult, ModelRouterFailure> {
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

/** A successful routed result carrying the given text verbatim as the model output. */
function textReply(outputText: string): Result<RoutedModelResult, ModelRouterFailure> {
  return ok({
    task: 'orchestration',
    provider: 'gemini',
    modelId: routedModelIdFor('gemini'),
    outputText,
    tokensUsed: 42,
    costCents: 3,
    attempts: 1,
    fellBack: false,
  });
}

/**
 * A JSON envelope wrapped in the markdown fence real providers emit.
 *
 * The leading space before the fence is faithful to the observed provider reply,
 * which a strict `JSON.parse` rejected even though the envelope inside was correct.
 */
function fenced(json: unknown): string {
  return ` \`\`\`json\n${JSON.stringify(json)}\n\`\`\``;
}

/** A generous budget so routing, not the budget, drives these cases. */
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
function agentWith(replies: readonly Result<RoutedModelResult, ModelRouterFailure>[]): {
  readonly agent: IntentAgent;
  readonly router: FakeModelRouter;
  readonly persistence: InMemoryTracePersistence;
} {
  const router = new FakeModelRouter(replies);
  const persistence = new InMemoryTracePersistence();
  const recorder = new TraceActionRecorder(persistence);
  const agent = new IntentAgent({ router, recorder, now: () => 0 });
  return { agent, router, persistence };
}

/** Unwrap an ok result or fail the test with the error. */
function expectOk<T, E>(result: Result<T, E>): T {
  if (!isOk(result)) {
    throw new Error(`expected ok, got error: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

const SESSION_ID: Ulid = newUlid();

describe('IntentAgent.begin (Req 4.1, 4.7)', () => {
  it('produces a structured restatement labeled Not_Applicable', async () => {
    const { agent } = agentWith([
      reply({
        summary: 'A 4-bit synchronous up counter with enable and async reset.',
        constraints: ['4-bit output', 'synchronous clock'],
        assumptions: ['active-high reset'],
        clarifyingQuestions: [],
        scope: 'single-module',
        proposedReduction: '',
      }),
    ]);

    const session = expectOk(
      await agent.begin({ sessionId: SESSION_ID, description: 'a counter' }, generousBudget()),
    );

    expect(session.restatement.summary).toContain('counter');
    expect(session.restatement.constraints).toContain('4-bit output');
    expect(session.artifact.tier).toBe('Not_Applicable');
    expect(session.artifact.artifactRef.kind).toBe('intent');
    expect(session.outcome.kind).toBe('ready-for-confirmation');
  });

  it('rejects an empty description without calling the model', async () => {
    const { agent, router } = agentWith([reply({ summary: 'unused' })]);

    const result = await agent.begin(
      { sessionId: SESSION_ID, description: '   ' },
      generousBudget(),
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('EMPTY_DESCRIPTION');
    }
    expect(router.prompts).toHaveLength(0);
  });

  it('asks focused clarifying questions when the intent is ambiguous (Req 4.2)', async () => {
    const { agent } = agentWith([
      reply({
        summary: 'A counter of unspecified width.',
        clarifyingQuestions: ['How many bits wide?', 'Synchronous or async reset?'],
        scope: 'single-module',
      }),
    ]);

    const session = expectOk(
      await agent.begin({ sessionId: SESSION_ID, description: 'a counter' }, generousBudget()),
    );

    expect(session.outcome.kind).toBe('clarifying');
    if (session.outcome.kind === 'clarifying') {
      expect(session.outcome.questions).toHaveLength(2);
    }
    expect(session.clarificationRounds).toBe(1);
  });

  it('records the turn as a Not_Applicable Trace span (Req 3.1, 4.7)', async () => {
    const { agent, persistence } = agentWith([
      reply({ summary: 'A counter.', scope: 'single-module' }),
    ]);

    await agent.begin({ sessionId: SESSION_ID, description: 'a counter' }, generousBudget());

    const trace = await persistence.loadTrace(SESSION_ID);
    const spans = trace.spans.filter((span) => span.stageOrTool === 'Intent_Agent');
    expect(spans).toHaveLength(1);
    expect(spans[0]?.outputs).toMatchObject({ trustTier: 'Not_Applicable', provider: 'gemini' });
  });
});

describe('IntentAgent clarification bound (Req 4.3, 4.4)', () => {
  it('stops asking at the bound and proposes a default scope', async () => {
    // The model keeps returning questions; the agent must stop at the bound.
    const questioning = reply({
      summary: 'A counter, still ambiguous.',
      clarifyingQuestions: ['One more thing?'],
      scope: 'single-module',
    });
    const { agent } = agentWith([questioning]);
    const budget = generousBudget();

    let session = expectOk(
      await agent.begin({ sessionId: SESSION_ID, description: 'a counter' }, budget),
    );
    // Drive clarify turns until the bound is reached.
    for (let round = 0; round < MAX_CLARIFICATION_ROUNDS + 2; round += 1) {
      session = expectOk(await agent.clarify(session, [], budget));
    }

    expect(session.clarificationRounds).toBe(MAX_CLARIFICATION_ROUNDS);
    expect(session.outcome.kind).toBe('default-scope-proposed');
    if (session.outcome.kind === 'default-scope-proposed') {
      expect(session.outcome.defaultScope.summary).toContain('counter');
    }
  });

  it('never exceeds the clarification bound across many turns', async () => {
    const { agent } = agentWith([
      reply({ summary: 'ambiguous', clarifyingQuestions: ['q?'], scope: 'single-module' }),
    ]);
    const budget = generousBudget();

    let session = expectOk(await agent.begin({ sessionId: SESSION_ID, description: 'x' }, budget));
    for (let i = 0; i < 10; i += 1) {
      session = expectOk(await agent.clarify(session, [], budget));
      expect(session.clarificationRounds).toBeLessThanOrEqual(MAX_CLARIFICATION_ROUNDS);
    }
  });
});

describe('IntentAgent scope reduction (Req 4.4)', () => {
  it('proposes a single-module reduction when scope is exceeded', async () => {
    const { agent } = agentWith([
      reply({
        summary: 'A full RISC CPU with cache, MMU, and UART.',
        scope: 'exceeds-single-module',
        proposedReduction: 'Start with just the ALU as one module.',
      }),
    ]);

    const session = expectOk(
      await agent.begin({ sessionId: SESSION_ID, description: 'build a CPU' }, generousBudget()),
    );

    expect(session.scope).toBe('exceeds-single-module');
    expect(session.outcome.kind).toBe('single-module-reduction-proposed');
    if (session.outcome.kind === 'single-module-reduction-proposed') {
      expect(session.outcome.reduction).toContain('ALU');
    }
  });

  it('supplies a default reduction message when the model offers none', async () => {
    const { agent } = agentWith([
      reply({ summary: 'A whole SoC.', scope: 'exceeds-single-module' }),
    ]);

    const session = expectOk(
      await agent.begin({ sessionId: SESSION_ID, description: 'an SoC' }, generousBudget()),
    );

    if (session.outcome.kind === 'single-module-reduction-proposed') {
      expect(session.outcome.reduction.length).toBeGreaterThan(0);
    } else {
      throw new Error('expected a single-module-reduction-proposed outcome');
    }
  });
});

describe('IntentAgent confirmation gate (Req 4.5, 4.6)', () => {
  it('starts unconfirmed and confirms only on an explicit confirm call', async () => {
    const { agent } = agentWith([reply({ summary: 'A counter.', scope: 'single-module' })]);

    const session = expectOk(
      await agent.begin({ sessionId: SESSION_ID, description: 'a counter' }, generousBudget()),
    );
    expect(isIntentConfirmed(session)).toBe(false);

    const confirmed = expectOk(agent.confirm(session));
    expect(isIntentConfirmed(confirmed)).toBe(true);
    expect(confirmed.confirmation).toBe('confirmed');
  });

  it('refuses to confirm an out-of-scope intent until it is reduced (Req 4.4, 4.5)', async () => {
    const { agent } = agentWith([
      reply({ summary: 'A CPU.', scope: 'exceeds-single-module', proposedReduction: 'ALU first.' }),
    ]);

    const session = expectOk(
      await agent.begin({ sessionId: SESSION_ID, description: 'a CPU' }, generousBudget()),
    );
    const result = agent.confirm(session);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('SCOPE_EXCEEDS_SINGLE_MODULE');
    }
  });

  it('refuses a second confirmation and refuses clarifying after confirm', async () => {
    const { agent } = agentWith([reply({ summary: 'A counter.', scope: 'single-module' })]);

    const session = expectOk(
      await agent.begin({ sessionId: SESSION_ID, description: 'a counter' }, generousBudget()),
    );
    const confirmed = expectOk(agent.confirm(session));

    const twice = agent.confirm(confirmed);
    expect(isErr(twice)).toBe(true);
    if (isErr(twice)) {
      expect(twice.error.code).toBe('ALREADY_CONFIRMED');
    }

    const clarifyAfter = await agent.clarify(confirmed, [], generousBudget());
    expect(isErr(clarifyAfter)).toBe(true);
    if (isErr(clarifyAfter)) {
      expect(clarifyAfter.error.code).toBe('ALREADY_CONFIRMED');
    }
  });
});

describe('IntentAgent untrusted model output (Req 4.2 boundary)', () => {
  it('fails closed when the model returns non-JSON output', async () => {
    const badReply: Result<RoutedModelResult, ModelRouterFailure> = ok({
      task: 'orchestration',
      provider: 'gemini',
      modelId: routedModelIdFor('gemini'),
      outputText: 'not json at all',
      tokensUsed: 1,
      costCents: 1,
      attempts: 1,
      fellBack: false,
    });
    const { agent } = agentWith([badReply]);

    const result = await agent.begin(
      { sessionId: SESSION_ID, description: 'a counter' },
      generousBudget(),
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('INVALID_MODEL_OUTPUT');
    }
  });

  it('surfaces a MODEL_UNAVAILABLE error when the router fails', async () => {
    const failure: Result<RoutedModelResult, ModelRouterFailure> = {
      ok: false,
      error: { code: 'ALL_PROVIDERS_FAILED', task: 'orchestration', attempts: 2 },
    };
    const { agent } = agentWith([failure]);

    const result = await agent.begin(
      { sessionId: SESSION_ID, description: 'a counter' },
      generousBudget(),
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('MODEL_UNAVAILABLE');
    }
  });
});

describe('parseIntentAnalysis - a conforming envelope wrapped in a markdown code fence', () => {
  it('given a fenced analysis when parsed then the fence is stripped and the summary is read', () => {
    const raw = fenced({ summary: 'A 4-bit up counter with reset.', constraints: ['active high'] });

    const parsed = parseIntentAnalysis(raw, newUlid);

    expect(expectOk(parsed).restatement).toEqual({
      summary: 'A 4-bit up counter with reset.',
      constraints: ['active high'],
      assumptions: [],
    });
  });

  it('given a genuinely malformed reply when parsed then it fails with the unchanged reason', () => {
    const parsed = parseIntentAnalysis('not json at all', newUlid);

    expect(parsed).toEqual({ ok: false, error: { reason: 'model output was not valid JSON' } });
  });

  it('given a fenced analysis with no summary when parsed then field validation still rejects it', () => {
    const parsed = parseIntentAnalysis(fenced({ constraints: ['active high'] }), newUlid);

    expect(parsed).toEqual({
      ok: false,
      error: { reason: 'model output was missing a non-empty summary' },
    });
  });

  it('given a fenced analysis when the agent runs then it returns a restatement', async () => {
    const summary = 'A 4-bit synchronous up counter with reset.';
    const { agent } = agentWith([textReply(fenced({ summary }))]);

    const result = await agent.begin(
      { sessionId: SESSION_ID, description: 'a counter' },
      generousBudget(),
    );

    expect(expectOk(result).restatement.summary).toBe(summary);
  });
});
