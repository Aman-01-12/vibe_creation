// Property 19 for the Model_Router: routing selects the configured model per task
// and records fallback (task 9.2).
//
// This is the universal complement to the concrete examples in
// `model-router.test.ts`. Over generated tasks and per-provider success/failure
// scripts it asserts the three guarantees the design binds to Property 19
// (Requirements 12.2-12.5):
//
//   - Correct primary selection: for every ModelTask the FIRST attempted provider
//     is the configured primary (generation/repair -> deepseek, orchestration/
//     teaching -> gemini, hard-planning -> claude), checked against
//     `primaryProviderFor`/`providerChainFor` and against the provider that
//     actually produced the success when the primary succeeds (Req 12.2-12.4).
//   - Bounded fallback, recorded: when a routed call fails/times out the router
//     escalates along the configured chain; the result reports `fellBack`/
//     `attempts` consistent with the walk, every attempt is recorded as a
//     redacted `Model_Router` Trace span (span count == attempts, outcomes match),
//     and an all-fail chain fails safe with `ALL_PROVIDERS_FAILED` (Req 12.5).
//   - Bounded by the Session_Budget: under a tight iteration budget the loop stops
//     and records `budget-exhausted` (`BUDGET_EXHAUSTED`) rather than trying the
//     whole chain (Req 12.5).
//
// A fixed clock is injected so every attempt has zero measured wall-clock; that
// keeps the iteration cap the sole budget lever, so the generous runs are driven
// purely by routing and the tight run purely by the iteration cap.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ROUTING_POLICY,
  FakeProviderAdapter,
  InMemorySessionBudgetHandle,
  InMemoryTracePersistence,
  TaskModelRouter,
  TraceActionRecorder,
  primaryProviderFor,
  providerChainFor,
  type ModelResult,
  type ModelTask,
  type ProviderAdapterMap,
  type ProviderCallError,
  type ProviderFailureKind,
  type ProviderName,
  type SessionBudgetHandle,
} from '@app/agent';
import { isErr, isOk, makeSessionBudget, newUlid, ok, type Json, type Result } from '@app/core';
import { propertyParameters, propertyTag } from '@app/test';

// --- Domain-shaped generators ------------------------------------------------

/** Every task the router routes; the routing table has an entry for each. */
const MODEL_TASKS: readonly ModelTask[] = [
  'generation',
  'repair',
  'orchestration',
  'teaching',
  'hard-planning',
];

/** The closed set of provider failure kinds a scripted call may report. */
const FAILURE_KINDS: readonly ProviderFailureKind[] = [
  'timeout',
  'provider-unavailable',
  'invalid-response',
  'credential-unavailable',
];

/** The generated verdict for a single provider: succeed, or fail with a kind. */
type ProviderOutcome =
  { readonly ok: true } | { readonly ok: false; readonly kind: ProviderFailureKind };

/** A per-provider outcome map, one entry per provider the router knows. */
type ProviderOutcomes = Readonly<Record<ProviderName, ProviderOutcome>>;

/** An arbitrary single-provider outcome: success or a classified failure. */
function providerOutcomeArbitrary(): fc.Arbitrary<ProviderOutcome> {
  return fc.oneof(
    fc.constant<ProviderOutcome>({ ok: true }),
    fc.constantFrom(...FAILURE_KINDS).map((kind): ProviderOutcome => ({ ok: false, kind })),
  );
}

/** An arbitrary always-failing single-provider outcome (for the budget scenario). */
function providerFailureArbitrary(): fc.Arbitrary<ProviderOutcome> {
  return fc.constantFrom(...FAILURE_KINDS).map((kind): ProviderOutcome => ({ ok: false, kind }));
}

/**
 * A per-provider outcome map drawn from a single-provider generator.
 *
 * Every provider gets a generated outcome, including `bedrock-mantle`, which no
 * default route selects. That entry is not filler: it lets the property assert that
 * an unconfigured provider is never attempted even on the runs where it was scripted
 * to succeed, which is the other half of "routing selects the CONFIGURED model".
 */
function outcomesArbitrary(
  perProvider: () => fc.Arbitrary<ProviderOutcome>,
): fc.Arbitrary<ProviderOutcomes> {
  return fc.record<ProviderOutcomes>({
    deepseek: perProvider(),
    gemini: perProvider(),
    claude: perProvider(),
    'bedrock-mantle': perProvider(),
  });
}

// --- Router + budget wiring --------------------------------------------------

/** The scripted `ProviderAdapter` result for a provider under its outcome. */
function scriptFor(
  provider: ProviderName,
  outcome: ProviderOutcome,
): Result<ModelResult, ProviderCallError> {
  if (outcome.ok) {
    return ok({ provider, outputText: `${provider}-output`, tokensUsed: 5, costCents: 1 });
  }
  return { ok: false, error: { kind: outcome.kind, reason: 'scripted failure' } };
}

/** Build one fake adapter per provider, scripted to its generated outcome. */
function buildAdapters(outcomes: ProviderOutcomes): {
  readonly map: ProviderAdapterMap;
  readonly byProvider: Readonly<Record<ProviderName, FakeProviderAdapter>>;
} {
  const deepseek = new FakeProviderAdapter('deepseek', scriptFor('deepseek', outcomes.deepseek));
  const gemini = new FakeProviderAdapter('gemini', scriptFor('gemini', outcomes.gemini));
  const claude = new FakeProviderAdapter('claude', scriptFor('claude', outcomes.claude));
  const bedrockMantle = new FakeProviderAdapter(
    'bedrock-mantle',
    scriptFor('bedrock-mantle', outcomes['bedrock-mantle']),
  );
  const byProvider = { deepseek, gemini, claude, 'bedrock-mantle': bedrockMantle };
  return { map: byProvider, byProvider };
}

/** A router over fully scripted fakes plus a real Trace recorder, fixed clock. */
function routerWithFakes(map: ProviderAdapterMap): {
  readonly router: TaskModelRouter;
  readonly persistence: InMemoryTracePersistence;
} {
  const persistence = new InMemoryTracePersistence();
  const recorder = new TraceActionRecorder(persistence);
  const router = new TaskModelRouter({ adapters: map, recorder, now: () => new Date(0) });
  return { router, persistence };
}

/** A budget handle capped only by iterations; every other cap is effectively open. */
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

// --- Expected-walk oracle ----------------------------------------------------

/** One expected recorded attempt: the provider tried and how it resolved. */
interface ExpectedAttempt {
  readonly provider: ProviderName;
  readonly outcome: 'success' | 'failure';
  readonly failureKind?: ProviderFailureKind;
}

/** The full expected result of walking a task's chain under the outcomes. */
interface ExpectedWalk {
  readonly attempts: readonly ExpectedAttempt[];
  readonly winner: ProviderName | null;
  readonly winnerIndex: number;
}

/**
 * Walk a task's configured provider chain under the generated outcomes exactly as
 * the router does under a generous budget: attempt each provider in order, stop at
 * the first success, and otherwise attempt every entry in the finite chain.
 */
function walkChain(task: ModelTask, outcomes: ProviderOutcomes): ExpectedWalk {
  const chain = providerChainFor(DEFAULT_ROUTING_POLICY, task);
  const attempts: ExpectedAttempt[] = [];
  for (const [index, provider] of chain.entries()) {
    const outcome = outcomes[provider];
    if (outcome.ok) {
      attempts.push({ provider, outcome: 'success' });
      return { attempts, winner: provider, winnerIndex: index };
    }
    attempts.push({ provider, outcome: 'failure', failureKind: outcome.kind });
  }
  return { attempts, winner: null, winnerIndex: -1 };
}

/** The redacted failure classification a failure kind maps to in the Trace. */
function expectedFailureClass(kind: ProviderFailureKind): 'timeout' | 'tool-error' {
  return kind === 'timeout' ? 'timeout' : 'tool-error';
}

/** Read a span's `outputs` as a plain record for field-level assertions. */
function outputsRecord(outputs: Json): Record<string, unknown> {
  return typeof outputs === 'object' && outputs !== null && !Array.isArray(outputs)
    ? (outputs as Record<string, unknown>)
    : {};
}

// --- The properties ----------------------------------------------------------

describe('Model_Router routing and fallback (Property 19)', () => {
  // Feature: hdl-creation-loop, Property 19: Model routing selects the configured model per task and records fallback
  it('routes each task to its primary and records the bounded fallback walk', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...MODEL_TASKS),
        outcomesArbitrary(providerOutcomeArbitrary),
        async (task, outcomes) => {
          const { map, byProvider } = buildAdapters(outcomes);
          const { router, persistence } = routerWithFakes(map);
          const budget = budgetWithIterations(100);

          const result = await router.invoke(task, { prompt: 'p' }, budget);

          const chain = providerChainFor(DEFAULT_ROUTING_POLICY, task);
          const primary = primaryProviderFor(DEFAULT_ROUTING_POLICY, task);
          const walk = walkChain(task, outcomes);

          // The configured primary is always the head of the chain (Req 12.2-12.4).
          expect(primary).toBe(chain[0]);

          // Correct final result: first success wins, else fail safe (Req 12.5).
          if (walk.winner !== null) {
            expect(isOk(result)).toBe(true);
            if (isOk(result)) {
              expect(result.value.provider).toBe(walk.winner);
              expect(result.value.attempts).toBe(walk.attempts.length);
              expect(result.value.fellBack).toBe(walk.winnerIndex > 0);
            }
          } else {
            expect(isErr(result)).toBe(true);
            if (isErr(result)) {
              expect(result.error.code).toBe('ALL_PROVIDERS_FAILED');
              expect(result.error.attempts).toBe(chain.length);
            }
          }

          // Every attempt is recorded as a redacted Model_Router span, in order,
          // with span count == attempts and matching per-attempt outcomes.
          const trace = await persistence.loadTrace(budget.sessionId);
          const spans = trace.spans.filter((span) => span.stageOrTool === 'Model_Router');
          expect(spans).toHaveLength(walk.attempts.length);

          // The FIRST attempted provider is the configured primary.
          expect(spans[0]?.outputs).toMatchObject({
            provider: primary,
            attempt: 1,
            fellBack: false,
          });

          walk.attempts.forEach((attempt, index) => {
            expect(spans[index]?.outputs).toMatchObject({
              task,
              provider: attempt.provider,
              outcome: attempt.outcome,
              attempt: index + 1,
              fellBack: index > 0,
            });
            if (attempt.outcome === 'failure' && attempt.failureKind !== undefined) {
              expect(spans[index]?.outputs).toMatchObject({ failureKind: attempt.failureKind });
              expect(spans[index]?.failureClass).toBe(expectedFailureClass(attempt.failureKind));
            }
          });

          // Fallback is bounded: each adapter is called exactly as often as the
          // chain positions that resolved to it were attempted, and no further.
          const expectedCalls: Record<ProviderName, number> = {
            deepseek: 0,
            gemini: 0,
            claude: 0,
            'bedrock-mantle': 0,
          };
          for (const attempt of walk.attempts) {
            expectedCalls[attempt.provider] += 1;
          }
          expect(byProvider.deepseek.callCount).toBe(expectedCalls.deepseek);
          expect(byProvider.gemini.callCount).toBe(expectedCalls.gemini);
          expect(byProvider.claude.callCount).toBe(expectedCalls.claude);
          // `bedrock-mantle` is on no configured chain, so its expected count is
          // always 0: routing never reaches a provider the policy did not select,
          // however that provider was scripted to answer.
          expect(byProvider['bedrock-mantle'].callCount).toBe(expectedCalls['bedrock-mantle']);
        },
      ),
      propertyParameters(),
    );
  });

  it('stops on a tight iteration budget and records budget-exhausted', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...MODEL_TASKS),
        outcomesArbitrary(providerFailureArbitrary),
        async (task, outcomes) => {
          const { map, byProvider } = buildAdapters(outcomes);
          const { router, persistence } = routerWithFakes(map);
          // One iteration only: the loop can afford exactly one attempt, so with a
          // failing primary it must stop on the budget before trying the chain end.
          const budget = budgetWithIterations(1);

          const result = await router.invoke(task, { prompt: 'p' }, budget);

          const chain = providerChainFor(DEFAULT_ROUTING_POLICY, task);
          const primary = primaryProviderFor(DEFAULT_ROUTING_POLICY, task);

          // The loop terminates on the budget, fail safe, after one charged attempt.
          expect(isErr(result)).toBe(true);
          if (isErr(result)) {
            expect(result.error.code).toBe('BUDGET_EXHAUSTED');
            expect(result.error.budgetStopReason).toBe('max-iterations');
            expect(result.error.attempts).toBe(1);
          }

          // Exactly the primary was attempted; the rest of the chain was not tried.
          // The sum MUST span every wired adapter - including the unconfigured
          // `bedrock-mantle` - or `toBe(1)` would stop meaning "exactly one provider
          // call happened in total" and would tolerate an extra call off-chain.
          const totalCalls =
            byProvider.deepseek.callCount +
            byProvider.gemini.callCount +
            byProvider.claude.callCount +
            byProvider['bedrock-mantle'].callCount;
          expect(totalCalls).toBe(1);
          expect(totalCalls).toBeLessThan(chain.length);
          expect(byProvider[primary].callCount).toBe(1);

          // The stop is recorded as a redacted budget-exhausted span in the Trace.
          const trace = await persistence.loadTrace(budget.sessionId);
          const spans = trace.spans.filter((span) => span.stageOrTool === 'Model_Router');
          const stopSpan = spans.find(
            (span) => outputsRecord(span.outputs).outcome === 'budget-exhausted',
          );
          expect(stopSpan).toBeDefined();
          expect(stopSpan?.outputs).toMatchObject({
            task,
            outcome: 'budget-exhausted',
            budgetStopReason: 'max-iterations',
          });
        },
      ),
      propertyParameters(),
    );
  });
});

// Referenced so the exact Property 19 tag is asserted, not just written in a
// comment: `Feature: hdl-creation-loop, Property 19: Model routing selects the
// configured model per task and records fallback`.
describe('Property 19 tag', () => {
  it('uses the canonical feature tag', () => {
    expect(
      propertyTag(19, 'Model routing selects the configured model per task and records fallback'),
    ).toBe(
      'Feature: hdl-creation-loop, Property 19: Model routing selects the configured model per task and records fallback',
    );
  });
});
