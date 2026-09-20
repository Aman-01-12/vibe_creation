// Property 14: Clarification rounds are bounded (task 11.2; Req 4.3).
//
// This is the universal complement to the concrete "stops at the bound" example
// in `intent-agent.test.ts`. It drives the REAL Intent_Agent (S0) across an
// arbitrary intent dialog - a `begin` turn followed by a generated sequence of
// `clarify` turns, each fed a generated model reply through a fake Model_Router -
// and asserts the guarantee the design binds to Property 14 (Design: Property 14;
// Req 4.3):
//
//   For any intent dialog, the number of clarification ROUNDS never exceeds the
//   configured maximum (`MAX_CLARIFICATION_ROUNDS`), and once that bound is
//   reached the agent proposes a default scope for the Student to adjust instead
//   of asking a further round of questions.
//
// Concretely, after every turn:
//   1. Boundedness: `0 <= clarificationRounds <= MAX_CLARIFICATION_ROUNDS`.
//   2. One round at a time: the count rises by at most one per turn and never
//      decreases, so it is monotonic and cannot skip past the bound.
//   3. At-bound behaviour: when a turn yields in-scope outstanding questions and
//      the prior count already sat at the bound, the outcome is
//      `default-scope-proposed` (never a further `clarifying` round), holding the
//      count at the cap.
//   4. Branch consistency: a `clarifying` outcome only ever appears strictly
//      under the bound and carries at least one question; an out-of-scope reply
//      yields a single-module reduction and consumes no round.
//
// The expected outcome per turn is derived INDEPENDENTLY from the generated reply
// plan and the prior round count (a direct restatement of Req 4.3), not read from
// any tag carried out of the agent, so the assertions cannot silently agree with
// a defect in the decision logic. A second property forces the dialog to actually
// reach and sit at the bound, so the default-scope branch is exercised
// non-vacuously. A fresh agent + in-memory recorder per run keeps runs
// independent (each turn records a Trace span).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  InMemorySessionBudgetHandle,
  InMemoryTracePersistence,
  IntentAgent,
  MAX_CLARIFICATION_ROUNDS,
  TraceActionRecorder,
  type IntentSession,
  type ModelRequest,
  type ModelRouter,
  type ModelRouterFailure,
  type ModelTask,
  type RoutedModelResult,
  type RoutingDiagnostics,
  type ScopeAssessment,
  type SessionBudgetHandle,
} from '@app/agent';
import { isOk, makeSessionBudget, newUlid, ok, type Result, type Ulid } from '@app/core';
import { propertyParameters, propertyTag, routedModelIdFor } from '@app/test';

const PROPERTY = propertyTag(14, 'Clarification rounds are bounded');

// -- Bounds for the generated dialog -----------------------------------------

/** The longest dialog (begin plus clarify turns) a single run explores. */
const MAX_DIALOG_TURNS = 10;

/**
 * The most questions a generated reply may carry. Chosen above the agent's
 * per-round question cap so the boundary that clamps questions is exercised too;
 * it does not affect the ROUND bound, which is what this property pins down.
 */
const MAX_QUESTIONS_PER_REPLY = 8;

/** The longest generated free-text field, kept small so runs stay fast. */
const MAX_TEXT_LENGTH = 16;

/** Extra clarify turns driven past the bound in the saturation property. */
const MIN_EXTRA_TURNS_PAST_BOUND = 1;
const MAX_EXTRA_TURNS_PAST_BOUND = 5;

// -- A generated model reply plan --------------------------------------------

/** The shape of one generated model turn, before it is rendered to JSON. */
interface ReplyPlan {
  readonly summary: string;
  readonly scope: ScopeAssessment;
  readonly questions: readonly string[];
  readonly proposedReduction: string;
}

/**
 * A non-empty, length-bounded text field. The prefix guarantees the value is
 * non-empty after trimming regardless of the (possibly whitespace-only or
 * combining) grapheme suffix, so the model-output parser always accepts it and
 * the generated questions are never silently dropped.
 */
function nonEmptyText(prefix: string): fc.Arbitrary<string> {
  return fc
    .string({ unit: 'grapheme', minLength: 0, maxLength: MAX_TEXT_LENGTH })
    .map((suffix) => `${prefix}${suffix}`);
}

/** Scope skewed toward single-module so clarifying dialogs are well covered. */
function scopeArbitrary(): fc.Arbitrary<ScopeAssessment> {
  return fc.oneof(
    { weight: 4, arbitrary: fc.constant<ScopeAssessment>('single-module') },
    { weight: 1, arbitrary: fc.constant<ScopeAssessment>('exceeds-single-module') },
  );
}

/** An arbitrary model reply plan: any scope, any (bounded) number of questions. */
function replyPlanArbitrary(): fc.Arbitrary<ReplyPlan> {
  return fc.record<ReplyPlan>({
    summary: nonEmptyText('module '),
    scope: scopeArbitrary(),
    questions: fc.array(nonEmptyText('q '), { maxLength: MAX_QUESTIONS_PER_REPLY }),
    proposedReduction: fc.constantFrom('', 'Start with the core datapath as one module.'),
  });
}

/** A whole dialog: the `begin` reply followed by the `clarify` replies. */
function dialogArbitrary(): fc.Arbitrary<readonly ReplyPlan[]> {
  return fc.array(replyPlanArbitrary(), { minLength: 1, maxLength: MAX_DIALOG_TURNS });
}

// -- Fakes and fixtures (mirroring intent-agent.test.ts) ---------------------

/** Render a reply plan as the JSON contract the Intent_Agent parses. */
function jsonForPlan(plan: ReplyPlan): string {
  return JSON.stringify({
    summary: plan.summary,
    constraints: [],
    assumptions: [],
    clarifyingQuestions: plan.questions,
    scope: plan.scope,
    proposedReduction: plan.proposedReduction,
  });
}

/** A successful routed result carrying the given output text as the model reply. */
function reply(outputText: string): Result<RoutedModelResult, ModelRouterFailure> {
  return ok({
    task: 'orchestration',
    provider: 'gemini',
    modelId: routedModelIdFor('gemini'),
    outputText,
    tokensUsed: 1,
    costCents: 1,
    attempts: 1,
    fellBack: false,
  });
}

/** A fake Model_Router that replays one scripted reply per call, in order. */
class ScriptedModelRouter implements ModelRouter {
  readonly #replies: readonly Result<RoutedModelResult, ModelRouterFailure>[];
  #index = 0;

  constructor(replies: readonly Result<RoutedModelResult, ModelRouterFailure>[]) {
    if (replies.length === 0) {
      throw new Error('ScriptedModelRouter requires at least one scripted reply');
    }
    this.#replies = replies;
  }

  invoke(
    _task: ModelTask,
    _request: ModelRequest,
    budget: SessionBudgetHandle,
  ): Promise<Result<RoutedModelResult, ModelRouterFailure>> {
    if (!budget.canAfford()) {
      return Promise.resolve({
        ok: false,
        error: { code: 'BUDGET_EXHAUSTED', task: 'orchestration', attempts: 0 },
      });
    }
    const next = this.#replies[Math.min(this.#index, this.#replies.length - 1)];
    if (next === undefined) {
      throw new Error('ScriptedModelRouter exhausted its scripted replies');
    }
    this.#index += 1;
    return Promise.resolve(next);
  }

  describeRouting(): RoutingDiagnostics {
    return { tasks: [], providers: [] };
  }
}

/** A generous budget so routing, not the Session_Budget, drives every dialog. */
function generousBudget(): SessionBudgetHandle {
  const built = makeSessionBudget({
    sessionId: newUlid(),
    maxIterations: 1_000,
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

/** A fresh Intent_Agent over a fresh in-memory Trace recorder, fixed clock. */
function freshAgent(
  replies: readonly Result<RoutedModelResult, ModelRouterFailure>[],
): IntentAgent {
  return new IntentAgent({
    router: new ScriptedModelRouter(replies),
    recorder: new TraceActionRecorder(new InMemoryTracePersistence()),
    now: () => 0,
  });
}

/** Unwrap an ok result or fail the test with the sanitized error. */
function expectOk<T, E>(result: Result<T, E>): T {
  if (!isOk(result)) {
    throw new Error(`expected ok, got error: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

const SESSION_ID: Ulid = newUlid();
const DESCRIPTION = 'a single hardware module';

// -- Independent per-turn oracle (a direct restatement of Req 4.3) -----------

/** Whether a reply leaves in-scope questions outstanding (the only round-consuming case). */
function hasInScopeQuestions(plan: ReplyPlan): boolean {
  return plan.scope === 'single-module' && plan.questions.length > 0;
}

/**
 * Assert every Property 14 invariant for one completed turn, given the reply that
 * drove it and the round count that held BEFORE it. `priorRounds` is 0 for the
 * `begin` turn and the previous session's `clarificationRounds` for each clarify.
 */
function assertTurnInvariants(plan: ReplyPlan, priorRounds: number, session: IntentSession): void {
  const rounds = session.clarificationRounds;

  // (1) Boundedness and (2) one-round-at-a-time monotonicity.
  expect(rounds).toBeGreaterThanOrEqual(0);
  expect(rounds).toBeLessThanOrEqual(MAX_CLARIFICATION_ROUNDS);
  expect(rounds - priorRounds === 0 || rounds - priorRounds === 1).toBe(true);

  if (plan.scope === 'exceeds-single-module') {
    // An out-of-scope idea proposes a reduction and consumes no round.
    expect(session.outcome.kind).toBe('single-module-reduction-proposed');
    expect(rounds).toBe(priorRounds);
    return;
  }

  if (!hasInScopeQuestions(plan)) {
    // In scope with nothing left to ask: ready for the explicit confirmation.
    expect(session.outcome.kind).toBe('ready-for-confirmation');
    expect(rounds).toBe(priorRounds);
    return;
  }

  // In scope with outstanding questions: ask another round only UNDER the bound,
  // otherwise (3) propose a default scope and hold the count at the cap.
  if (priorRounds < MAX_CLARIFICATION_ROUNDS) {
    expect(session.outcome.kind).toBe('clarifying');
    expect(rounds).toBe(priorRounds + 1);
    if (session.outcome.kind === 'clarifying') {
      expect(session.outcome.questions.length).toBeGreaterThan(0);
    }
  } else {
    expect(session.outcome.kind).toBe('default-scope-proposed');
    expect(rounds).toBe(MAX_CLARIFICATION_ROUNDS);
  }
}

// -- The properties ----------------------------------------------------------

describe(PROPERTY, () => {
  it('keeps clarification rounds within the bound across any dialog', async () => {
    await fc.assert(
      fc.asyncProperty(dialogArbitrary(), async (dialog) => {
        const agent = freshAgent(dialog.map((plan) => reply(jsonForPlan(plan))));
        const budget = generousBudget();

        const [beginPlan, ...clarifyPlans] = dialog;
        if (beginPlan === undefined) {
          throw new Error('dialogArbitrary must yield at least one turn');
        }

        // The begin turn always starts from a prior round count of zero.
        let session = expectOk(
          await agent.begin({ sessionId: SESSION_ID, description: DESCRIPTION }, budget),
        );
        assertTurnInvariants(beginPlan, 0, session);

        // Each clarify turn is judged against the count that held before it.
        for (const plan of clarifyPlans) {
          const priorRounds = session.clarificationRounds;
          session = expectOk(await agent.clarify(session, [], budget));
          assertTurnInvariants(plan, priorRounds, session);
        }
      }),
      propertyParameters(),
    );
  });

  it('proposes a default scope instead of a further round once the bound is reached', async () => {
    // A reply that always leaves one in-scope question outstanding forces the
    // dialog to climb to the bound; the agent must then switch to a default-scope
    // proposal for every subsequent turn rather than ever asking again.
    const alwaysQuestioning: ReplyPlan = {
      summary: 'module still ambiguous',
      scope: 'single-module',
      questions: ['q one more thing'],
      proposedReduction: '',
    };

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: MIN_EXTRA_TURNS_PAST_BOUND, max: MAX_EXTRA_TURNS_PAST_BOUND }),
        async (extraTurns) => {
          const totalTurns = MAX_CLARIFICATION_ROUNDS + extraTurns;
          const replies = Array.from({ length: totalTurns + 1 }, () =>
            reply(jsonForPlan(alwaysQuestioning)),
          );
          const agent = freshAgent(replies);
          const budget = generousBudget();

          let session = expectOk(
            await agent.begin({ sessionId: SESSION_ID, description: DESCRIPTION }, budget),
          );

          // Climb to the bound: each turn under the cap is a clarifying round.
          for (let round = 0; round < MAX_CLARIFICATION_ROUNDS; round += 1) {
            expect(session.clarificationRounds).toBe(round + 1);
            expect(session.outcome.kind).toBe('clarifying');
            session = expectOk(await agent.clarify(session, [], budget));
          }

          // At and beyond the bound: never another clarifying round.
          for (let extra = 0; extra < extraTurns; extra += 1) {
            expect(session.clarificationRounds).toBe(MAX_CLARIFICATION_ROUNDS);
            expect(session.outcome.kind).toBe('default-scope-proposed');
            session = expectOk(await agent.clarify(session, [], budget));
          }

          expect(session.clarificationRounds).toBe(MAX_CLARIFICATION_ROUNDS);
          expect(session.outcome.kind).toBe('default-scope-proposed');
        },
      ),
      propertyParameters(),
    );
  });
});

// Referenced so the exact Property 14 tag is asserted, not only written in a
// comment: `Feature: hdl-creation-loop, Property 14: Clarification rounds are bounded`.
describe('Property 14 tag', () => {
  it('uses the canonical feature tag', () => {
    expect(propertyTag(14, 'Clarification rounds are bounded')).toBe(
      'Feature: hdl-creation-loop, Property 14: Clarification rounds are bounded',
    );
  });
});
