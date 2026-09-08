// Example unit tests for the Model_Router (task 9.1).
//
// Concrete checks of the router's core behavior: task -> provider routing, bounded
// fallback under the Session_Budget with the outcome recorded in the Trace, budget
// gating that stops the loop, and credential confinement (no synthetic credential
// value ever appears in the router's diagnostics or Trace). The universal
// Properties 19 (routing/fallback) and 11 (no secret escapes its adapter) are
// separate fast-check properties in tasks 9.2 and 9.3; these examples complement
// them.

import { describe, expect, it } from 'vitest';

import {
  InMemorySecretManager,
  InMemorySessionBudgetHandle,
  InMemoryTracePersistence,
  TaskModelRouter,
  TraceActionRecorder,
  createModelRouter,
  providerCredentialRef,
  FakeProviderAdapter,
  type ModelResult,
  type ModelTask,
  type ProviderAdapterMap,
  type ProviderCallError,
  type ProviderName,
  type ProviderTransportInput,
  type SessionBudgetHandle,
} from '@app/agent';
import { isErr, isOk, makeSessionBudget, newUlid, ok, type Result } from '@app/core';

/** A generous budget handle so routing (not the budget) drives these cases. */
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

/** A budget handle capped at a fixed number of iterations. */
function budgetWithIterations(maxIterations: number): SessionBudgetHandle {
  const built = makeSessionBudget({
    sessionId: newUlid(),
    maxIterations,
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

/** A scripted success result for a provider. */
function success(provider: ProviderName): Result<ModelResult, ProviderCallError> {
  return ok({ provider, outputText: `${provider}-output`, tokensUsed: 10, costCents: 2 });
}

/** Build a router over fully scripted fake adapters plus a real Trace recorder. */
function routerWithFakes(adapters: ProviderAdapterMap): {
  readonly router: TaskModelRouter;
  readonly persistence: InMemoryTracePersistence;
} {
  const persistence = new InMemoryTracePersistence();
  const recorder = new TraceActionRecorder(persistence);
  const router = new TaskModelRouter({ adapters, recorder, now: () => new Date(0) });
  return { router, persistence };
}

/**
 * All-succeeding fake adapters, one per provider.
 *
 * `bedrock-mantle` is wired and scripted to SUCCEED even though no default route
 * selects it, so "only the primary was called" is a real claim: an adapter the
 * policy never names must stay untouched however willing it is to answer.
 */
function allSucceedingAdapters(): {
  readonly map: ProviderAdapterMap;
  readonly deepseek: FakeProviderAdapter;
  readonly gemini: FakeProviderAdapter;
  readonly claude: FakeProviderAdapter;
  readonly bedrockMantle: FakeProviderAdapter;
} {
  const deepseek = new FakeProviderAdapter('deepseek', success('deepseek'));
  const gemini = new FakeProviderAdapter('gemini', success('gemini'));
  const claude = new FakeProviderAdapter('claude', success('claude'));
  const bedrockMantle = new FakeProviderAdapter('bedrock-mantle', success('bedrock-mantle'));
  return {
    map: { deepseek, gemini, claude, 'bedrock-mantle': bedrockMantle },
    deepseek,
    gemini,
    claude,
    bedrockMantle,
  };
}

describe('TaskModelRouter routing table (Req 12.2-12.4)', () => {
  const cases: ReadonlyArray<readonly [ModelTask, ProviderName]> = [
    ['generation', 'deepseek'],
    ['repair', 'deepseek'],
    ['orchestration', 'gemini'],
    ['teaching', 'gemini'],
    ['hard-planning', 'claude'],
  ];

  it.each(cases)('routes %s to the configured primary provider %s', async (task, provider) => {
    const adapters = allSucceedingAdapters();
    const { router } = routerWithFakes(adapters.map);

    const result = await router.invoke(task, { prompt: 'p' }, generousBudget());

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.provider).toBe(provider);
      expect(result.value.attempts).toBe(1);
      expect(result.value.fellBack).toBe(false);
    }
  });

  it('calls only the primary provider on success', async () => {
    const adapters = allSucceedingAdapters();
    const { router } = routerWithFakes(adapters.map);

    await router.invoke('generation', { prompt: 'p' }, generousBudget());

    expect(adapters.deepseek.callCount).toBe(1);
    expect(adapters.gemini.callCount).toBe(0);
    expect(adapters.claude.callCount).toBe(0);
    // A provider absent from every configured chain is never reached, even though
    // its adapter is wired and would have succeeded.
    expect(adapters.bedrockMantle.callCount).toBe(0);
  });

  it('exposes the routing table with redacted references only', () => {
    const adapters = allSucceedingAdapters();
    const { router } = routerWithFakes(adapters.map);

    const diagnostics = router.describeRouting();

    const generation = diagnostics.tasks.find((entry) => entry.task === 'generation');
    expect(generation?.providerChain[0]).toBe('deepseek');
    const deepseek = diagnostics.providers.find((entry) => entry.provider === 'deepseek');
    expect(deepseek?.credentialRef).toBe(providerCredentialRef('deepseek'));
  });
});

describe('TaskModelRouter bounded fallback under budget (Req 12.5)', () => {
  it('falls back to the next provider and records both attempts in the Trace', async () => {
    const deepseek = new FakeProviderAdapter('deepseek', {
      ok: false,
      error: { kind: 'provider-unavailable', reason: 'down' },
    });
    const gemini = new FakeProviderAdapter('gemini', success('gemini'));
    const claude = new FakeProviderAdapter('claude', success('claude'));
    const bedrockMantle = new FakeProviderAdapter('bedrock-mantle', success('bedrock-mantle'));
    const { router, persistence } = routerWithFakes({
      deepseek,
      gemini,
      claude,
      'bedrock-mantle': bedrockMantle,
    });
    const budget = generousBudget();

    const result = await router.invoke('generation', { prompt: 'p' }, budget);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.provider).toBe('claude');
      expect(result.value.fellBack).toBe(true);
      expect(result.value.attempts).toBe(2);
    }
    expect(deepseek.callCount).toBe(1);
    expect(claude.callCount).toBe(1);
    // Escalation follows the configured chain only; it does not fan out to every
    // wired adapter.
    expect(gemini.callCount).toBe(0);
    expect(bedrockMantle.callCount).toBe(0);

    const trace = await persistence.loadTrace(budget.sessionId);
    const spans = trace.spans.filter((span) => span.stageOrTool === 'Model_Router');
    expect(spans).toHaveLength(2);
    expect(spans[0]?.outputs).toMatchObject({ provider: 'deepseek', outcome: 'failure' });
    expect(spans[0]?.failureClass).toBe('tool-error');
    expect(spans[1]?.outputs).toMatchObject({ provider: 'claude', outcome: 'success' });
  });

  it('stops at the budget cap, charges each attempt, and does not try further providers', async () => {
    const deepseek = new FakeProviderAdapter('deepseek', {
      ok: false,
      error: { kind: 'timeout', reason: 'slow' },
    });
    const claude = new FakeProviderAdapter('claude', success('claude'));
    const gemini = new FakeProviderAdapter('gemini', success('gemini'));
    const bedrockMantle = new FakeProviderAdapter('bedrock-mantle', success('bedrock-mantle'));
    const { router, persistence } = routerWithFakes({
      deepseek,
      gemini,
      claude,
      'bedrock-mantle': bedrockMantle,
    });
    const budget = budgetWithIterations(1);

    const result = await router.invoke('generation', { prompt: 'p' }, budget);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('BUDGET_EXHAUSTED');
      expect(result.error.budgetStopReason).toBe('max-iterations');
    }
    // The single allowed attempt was charged, so the fallback was never reached.
    expect(deepseek.callCount).toBe(1);
    expect(claude.callCount).toBe(0);
    expect(gemini.callCount).toBe(0);
    expect(bedrockMantle.callCount).toBe(0);

    const trace = await persistence.loadTrace(budget.sessionId);
    const budgetStop = trace.spans.find((span) =>
      JSON.stringify(span.outputs).includes('budget-exhausted'),
    );
    expect(budgetStop).toBeDefined();
  });

  it('fails safe with ALL_PROVIDERS_FAILED when every provider in the chain fails', async () => {
    const failing = (provider: ProviderName): FakeProviderAdapter =>
      new FakeProviderAdapter(provider, {
        ok: false,
        error: { kind: 'provider-unavailable', reason: 'down' },
      });
    const { router } = routerWithFakes({
      deepseek: failing('deepseek'),
      gemini: failing('gemini'),
      claude: failing('claude'),
      'bedrock-mantle': failing('bedrock-mantle'),
    });

    const result = await router.invoke('generation', { prompt: 'p' }, generousBudget());

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('ALL_PROVIDERS_FAILED');
      // Exhaustion is bounded by the CONFIGURED chain (deepseek -> claude), not by
      // how many adapters are wired, so a fourth failing adapter adds no attempt.
      expect(result.error.attempts).toBe(2);
    }
  });
});

describe('Model_Router credential confinement (Req 12.6-12.9)', () => {
  // A synthetic, deliberately NOT secret-shaped token, so its absence from the
  // Trace proves the router never wrote it - not merely that redaction scrubbed it.
  const DEEPSEEK_TOKEN = 'SYNTHETIC-DEEPSEEK-CREDENTIAL-do-not-leak';
  const GEMINI_TOKEN = 'SYNTHETIC-GEMINI-CREDENTIAL-do-not-leak';
  const CLAUDE_TOKEN = 'SYNTHETIC-CLAUDE-CREDENTIAL-do-not-leak';

  function secretManager(): InMemorySecretManager {
    return new InMemorySecretManager({
      [providerCredentialRef('deepseek')]: DEEPSEEK_TOKEN,
      [providerCredentialRef('gemini')]: GEMINI_TOKEN,
      [providerCredentialRef('claude')]: CLAUDE_TOKEN,
    });
  }

  it('resolves only the routed provider credential and never leaks it', async () => {
    const secrets = secretManager();
    const persistence = new InMemoryTracePersistence();
    const recorder = new TraceActionRecorder(persistence);
    const seen: { credential?: string } = {};
    const router = createModelRouter({
      secretManager: secrets,
      recorder,
      now: () => new Date(0),
      transports: {
        // The transport receives the credential at the point of use only; it never
        // returns or echoes it. Test capture proves resolution happened.
        deepseek: ({ credential }: ProviderTransportInput) => {
          seen.credential = credential;
          return Promise.resolve(success('deepseek'));
        },
      },
    });
    const budget = generousBudget();

    const result = await router.invoke('generation', { prompt: 'p' }, budget);

    expect(isOk(result)).toBe(true);
    // Point-of-use resolution happened, and only the deepseek credential was read.
    expect(seen.credential).toBe(DEEPSEEK_TOKEN);
    expect(secrets.accessedRefs).toEqual([providerCredentialRef('deepseek')]);

    // No credential value appears anywhere in the Trace or the diagnostics.
    const trace = await persistence.loadTrace(budget.sessionId);
    const traceJson = JSON.stringify(trace);
    const diagnosticsJson = JSON.stringify(router.describeRouting());
    for (const token of [DEEPSEEK_TOKEN, GEMINI_TOKEN, CLAUDE_TOKEN]) {
      expect(traceJson).not.toContain(token);
      expect(diagnosticsJson).not.toContain(token);
    }
    // Diagnostics carry only the non-secret credential reference pointer.
    expect(diagnosticsJson).toContain(providerCredentialRef('deepseek'));
  });

  it('never resolves a credential when the vendor transport is unwired', async () => {
    const secrets = secretManager();
    const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
    const router = createModelRouter({ secretManager: secrets, recorder, now: () => new Date(0) });

    const result = await router.invoke('generation', { prompt: 'p' }, generousBudget());

    // Unwired transports fail safe; the secret manager is never consulted at all.
    expect(isErr(result)).toBe(true);
    expect(secrets.accessedRefs).toEqual([]);
  });
});
