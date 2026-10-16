// The Property_Author's runnable checks (task 9.1).
//
// Four claims the role makes structurally, each checked here against the smallest thing
// that would fail if the structure broke:
//
//   1. A criterion the dialect CANNOT express lands in `unexpressedCriteria` and emits
//      NO property - never a weaker one in its place (Req 6.17).
//   2. Every emitted property carries a `criterionRef` naming a criterion of THIS Spec
//      (Req 6.14), and a draft naming an unknown id reaches neither set.
//   3. The expressed and unexpressed sets PARTITION the Spec's criteria: every criterion
//      exactly once, no overlap, no loss (Req 6.15, 6.17). Task 9.2's Property 17 states
//      the same invariant over generated Specs; these are the example-level anchors.
//   4. Model text the Property_Validator refuses cannot reach the set at all - the
//      refused text appears in no emitted expression (Req 6.8).
//
// The model call goes through an injected `ModelRouter` double that returns scripted
// text, the way `ScriptedTestbench` and `ScriptedOracle` already do: no provider is
// reached, and the budget is charged exactly as the real router charges it.

import { describe, expect, it } from 'vitest';

import {
  makeSessionBudget,
  makeTimingContract,
  newUlid,
  type AcceptanceCriterion,
  type ModuleInterface,
  type Result,
  type Spec,
  type TimingContract,
  type Ulid,
} from '@app/core';

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
import type { PropertySetSource } from '../../orchestrator/verification-loop.js';

import { PropertyAgent, derivePropertySet, type PropertySetOutcome } from './property-agent.js';
import { buildPropertyModelInput } from './prompt.js';

/** A model id the double reports; never a credential and never routed anywhere. */
const SCRIPTED_MODEL_ID = 'scripted-property-author';

/** One measurable, formally-verifiable acceptance criterion. */
function criterion(text: string): AcceptanceCriterion {
  return { id: newUlid(), text, measurable: true, method: 'formal' };
}

/** A placeholder Timing_Contract placing every output port at `registered`; nothing here reads it. */
function timingContractFor(moduleInterface: ModuleInterface): TimingContract {
  const entries = moduleInterface.ports
    .filter((port) => port.direction === 'output')
    .map((port) => ({ portName: port.name, timing: 'registered' as const }));
  const built = makeTimingContract(moduleInterface, entries);
  if (!built.ok) {
    throw new Error(`fixture built an invalid timing contract: ${built.error.message}`);
  }
  return built.value;
}

/** An approved clocked Spec carrying the given acceptance criteria. */
function approvedSpec(criteria: readonly AcceptanceCriterion[], clockName: string | null): Spec {
  const moduleInterface: ModuleInterface = {
    validityOutputName: null,
    moduleName: 'byte_reg',
    ports: [
      { name: 'd', direction: 'input', width: 8 },
      { name: 'q', direction: 'output', width: 8 },
    ],
    clocking: { clockName, resetName: 'rst_n', resetActiveLow: true },
  };
  return {
    id: newUlid(),
    projectId: newUlid(),
    goal: 'A byte register that captures d on the clock edge.',
    constraints: ['synchronous reset'],
    moduleInterface,
    timingContract: timingContractFor(moduleInterface),
    acceptanceCriteria: criteria,
    architecture: 'One 8-bit register.',
    approved: true,
    version: 3,
  };
}

/** A Model_Router double returning one scripted reply and capturing the prompt. */
class ScriptedPropertyRouter implements ModelRouter {
  readonly prompts: string[] = [];
  readonly tasks: ModelTask[] = [];
  readonly #reply: Result<RoutedModelResult, ModelRouterFailure>;

  constructor(reply: Result<RoutedModelResult, ModelRouterFailure>) {
    this.#reply = reply;
  }

  invoke(
    task: ModelTask,
    request: ModelRequest,
    budget: SessionBudgetHandle,
  ): Promise<Result<RoutedModelResult, ModelRouterFailure>> {
    this.tasks.push(task);
    this.prompts.push(request.prompt);
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve(this.#reply);
  }

  describeRouting(): RoutingDiagnostics {
    return { tasks: [], providers: [] };
  }
}

/** A scripted successful reply carrying the given raw model text. */
function replyWith(outputText: string): Result<RoutedModelResult, ModelRouterFailure> {
  return {
    ok: true,
    value: {
      task: 'testbench',
      provider: 'bedrock-mantle',
      modelId: SCRIPTED_MODEL_ID,
      outputText,
      tokensUsed: 32,
      costCents: 1,
      attempts: 1,
      fellBack: false,
    },
  };
}

/** A generous budget, so the model seam and not the budget drives the derivation. */
function generousBudget(): SessionBudgetHandle {
  const built = makeSessionBudget({
    sessionId: newUlid(),
    maxIterations: 1000,
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

/** Drive the real role through the scripted router, returning the outcome and the seams. */
async function derive(
  spec: Spec,
  reply: Result<RoutedModelResult, ModelRouterFailure>,
): Promise<{
  readonly outcome: PropertySetOutcome;
  readonly router: ScriptedPropertyRouter;
  readonly recorder: TraceActionRecorder;
  readonly budget: SessionBudgetHandle;
}> {
  const router = new ScriptedPropertyRouter(reply);
  const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
  const budget = generousBudget();
  const outcome = await derivePropertySet(spec, { router, recorder, budget, now: () => 1_700_000 });
  return { outcome, router, recorder, budget };
}

/** The criterion ids the two halves of the partition name, concatenated. */
function partitionedIds(outcome: PropertySetOutcome): readonly Ulid[] {
  return [
    ...outcome.properties.map((property) => property.criterionRef),
    ...outcome.unexpressedCriteria,
  ];
}

/**
 * Assert the two sets partition the Spec's criteria: each criterion exactly once,
 * nothing extra, no overlap.
 */
function expectPartition(spec: Spec, outcome: PropertySetOutcome): void {
  const named = partitionedIds(outcome);
  const expected = spec.acceptanceCriteria.map((entry) => entry.id);
  expect([...named].sort()).toEqual([...expected].sort());
  expect(new Set(named).size).toBe(named.length);
}

describe('Property_Author derivation', () => {
  it('reports a criterion the dialect cannot express as unexpressed, emitting no property', async () => {
    const expressible = criterion('q holds its value while the register is not loaded');
    const inexpressible = criterion('q eventually equals d after an unbounded delay');
    const spec = approvedSpec([expressible, inexpressible], 'clk');

    // The second draft is written in SVA the dialect refuses (`|->` is a measured Yosys
    // rejection), and the model offered it rather than omitting the criterion.
    const { outcome } = await derive(
      spec,
      replyWith(
        JSON.stringify({
          properties: [
            {
              criterionId: expressible.id,
              kind: 'clocked',
              antecedent: null,
              consequent: '!$past(rst_n) || q == $past(q)',
            },
            {
              criterionId: inexpressible.id,
              kind: 'clocked',
              antecedent: null,
              consequent: '$rose(d) |-> q == d',
            },
          ],
        }),
      ),
    );

    expect(outcome.properties).toHaveLength(1);
    expect(outcome.properties[0]?.criterionRef).toBe(expressible.id);
    expect(outcome.unexpressedCriteria).toEqual([inexpressible.id]);
    // Reported, never approximated: no weaker property stands in for the refused one.
    expect(outcome.properties.map((property) => property.criterionRef)).not.toContain(
      inexpressible.id,
    );
    // The refusal names the construct, so the report is attributable (Req 6.7).
    expect(outcome.unexpressed).toEqual([
      {
        criterionId: inexpressible.id,
        reason: 'dialect-refused',
        rejection: { reason: 'unaccepted-construct', construct: '|->' },
      },
    ]);
    expectPartition(spec, outcome);
  });

  it('reports a combinational $past or $stable draft as unexpressed, naming the construct', async () => {
    const past = criterion('q equals the value d held one clock earlier');
    const stable = criterion('q does not change while the register is idle');
    const spec = approvedSpec([past, stable], 'clk');

    // Neither shape is emittable in the module-level `assert property (...)` form: a `$past`
    // has no clocking event to count its Warm_Up_Gate on, and `$stable` is a hard Yosys error
    // outside a clocked block. So the boundary refuses them by name rather than letting the
    // sample land on `zero-assertions`, where the author would learn nothing (Req 13.18).
    const { outcome } = await derive(
      spec,
      replyWith(
        JSON.stringify({
          properties: [
            {
              criterionId: past.id,
              kind: 'combinational',
              antecedent: null,
              consequent: 'q == $past(d)',
            },
            {
              criterionId: stable.id,
              kind: 'combinational',
              antecedent: null,
              consequent: '$stable(q)',
            },
          ],
        }),
      ),
    );

    expect(outcome.properties).toEqual([]);
    const byCriterion = new Map(outcome.unexpressed.map((entry) => [entry.criterionId, entry]));
    expect(byCriterion.get(past.id)).toEqual({
      criterionId: past.id,
      reason: 'dialect-refused',
      rejection: { reason: 'unaccepted-construct', construct: '$past in combinational' },
    });
    expect(byCriterion.get(stable.id)).toEqual({
      criterionId: stable.id,
      reason: 'dialect-refused',
      rejection: { reason: 'unaccepted-construct', construct: '$stable in combinational' },
    });
    expectPartition(spec, outcome);
  });

  it('lets no refused model text reach an emitted expression', async () => {
    const hierarchical = criterion('the internal counter never exceeds eight');
    const spec = approvedSpec([hierarchical], 'clk');

    // A hierarchical path is a MEASURED silent false proof: Yosys binds `dut.count` to a
    // fresh net. The validator holds `.` outside its operator set, so this is refused.
    const { outcome } = await derive(
      spec,
      replyWith(
        JSON.stringify({
          properties: [
            {
              criterionId: hierarchical.id,
              kind: 'clocked',
              antecedent: 'rst_n',
              consequent: 'dut.count <= 8',
            },
          ],
        }),
      ),
    );

    expect(outcome.properties).toEqual([]);
    expect(outcome.unexpressedCriteria).toEqual([hierarchical.id]);
    const emitted = JSON.stringify(outcome.properties);
    expect(emitted).not.toContain('dut.count');
    expectPartition(spec, outcome);
  });

  it('names a criterion of the Spec on every emitted property and drops an unknown id', async () => {
    const known = criterion('q equals d one clock after load');
    const spec = approvedSpec([known], 'clk');
    const foreignId = newUlid();

    const { outcome } = await derive(
      spec,
      replyWith(
        JSON.stringify({
          properties: [
            {
              criterionId: known.id,
              kind: 'clocked',
              antecedent: 'rst_n',
              consequent: 'q == $past(d)',
            },
            {
              criterionId: foreignId,
              kind: 'combinational',
              antecedent: null,
              consequent: 'q == 0',
            },
          ],
        }),
      ),
    );

    const criterionIds = new Set(spec.acceptanceCriteria.map((entry) => entry.id));
    for (const property of outcome.properties) {
      expect(criterionIds.has(property.criterionRef)).toBe(true);
    }
    // An unattributable property is a verdict about nothing, so it reaches neither set.
    expect(partitionedIds(outcome)).not.toContain(foreignId);
    expectPartition(spec, outcome);
  });

  it('partitions the criteria across omitted, duplicated, and malformed drafts', async () => {
    const first = criterion('q equals d one clock after load');
    const second = criterion('q is zero while reset is asserted');
    const third = criterion('the output is registered, never combinational');
    const spec = approvedSpec([first, second, third], 'clk');

    const { outcome } = await derive(
      spec,
      replyWith(
        JSON.stringify({
          properties: [
            // Two drafts for one criterion: the first wins, so the criterion cannot
            // appear in the expressed set twice.
            { criterionId: first.id, kind: 'clocked', consequent: 'q == $past(d)' },
            { criterionId: first.id, kind: 'clocked', consequent: 'q != $past(d)' },
            // A combinational draft carrying an antecedent is not a form the dialect has,
            // so the boundary refuses the entry rather than stripping the antecedent.
            {
              criterionId: second.id,
              kind: 'combinational',
              antecedent: 'rst_n',
              consequent: 'q == 0',
            },
            // `third` is omitted entirely.
          ],
        }),
      ),
    );

    expect(outcome.properties).toHaveLength(1);
    expect(outcome.properties[0]?.criterionRef).toBe(first.id);
    expect([...outcome.unexpressedCriteria].sort()).toEqual([second.id, third.id].sort());
    expectPartition(spec, outcome);
  });

  it('reports a clocked property as unexpressed where the interface declares no clock', async () => {
    const combinational = criterion('q equals d at all times');
    const spec = approvedSpec([combinational], null);

    const { outcome } = await derive(
      spec,
      replyWith(
        JSON.stringify({
          properties: [
            { criterionId: combinational.id, kind: 'clocked', consequent: 'q == $past(d)' },
          ],
        }),
      ),
    );

    // Not downgraded to a combinational property, which would assert the consequent at
    // every instant rather than at a clock edge.
    expect(outcome.properties).toEqual([]);
    expect(outcome.unexpressed).toEqual([
      { criterionId: combinational.id, reason: 'no-clock-declared' },
    ]);
    expectPartition(spec, outcome);
  });

  it('partitions every criterion as unexpressed when the model call fails', async () => {
    const only = criterion('q equals d one clock after load');
    const spec = approvedSpec([only], 'clk');

    const { outcome, recorder, budget } = await derive(spec, {
      ok: false,
      error: { code: 'ALL_PROVIDERS_FAILED', task: 'testbench', attempts: 3 },
    });

    expect(outcome.properties).toEqual([]);
    expect(outcome.unexpressedCriteria).toEqual([only.id]);
    expectPartition(spec, outcome);

    // The failure is on the record, attributed to the Spec version.
    const trace = await recorder.getTrace(budget.sessionId);
    expect(trace.spans).toHaveLength(1);
    expect(trace.spans[0]?.stageOrTool).toBe('Property_Author');
    expect(trace.spans[0]?.failureClass).toBe('tool-error');
    expect(trace.spans[0]?.outputs).toMatchObject({
      sourceAttribution: 'spec',
      specVersion: spec.version,
      propertyCount: 0,
    });
  });

  it('partitions every criterion as unexpressed when the reply cannot be read', async () => {
    const only = criterion('q equals d one clock after load');
    const spec = approvedSpec([only], 'clk');

    const { outcome } = await derive(spec, replyWith('not json at all'));

    expect(outcome.properties).toEqual([]);
    expect(outcome.unexpressedCriteria).toEqual([only.id]);
    expectPartition(spec, outcome);
  });

  it('never gates its own output', async () => {
    const only = criterion('q equals d one clock after load');
    const spec = approvedSpec([only], 'clk');

    const { outcome } = await derive(
      spec,
      replyWith(
        JSON.stringify({
          properties: [{ criterionId: only.id, kind: 'clocked', consequent: 'q == $past(d)' }],
        }),
      ),
    );

    // Admission reads a reference design; a student session has none, and `app/agent`
    // must not import `app/eval`. Group 10 owns the decision. `'not-gated'` rather than
    // `'no-gate-set'`: no gate ran here, and the latter would claim one ran with an empty
    // gate set.
    expect(outcome.propertySetAdmitted).toBe('not-gated');
  });

  it('charges the model call to the caller budget and routes one call', async () => {
    const only = criterion('q equals d one clock after load');
    const spec = approvedSpec([only], 'clk');

    const { router, budget } = await derive(
      spec,
      replyWith(
        JSON.stringify({
          properties: [{ criterionId: only.id, kind: 'clocked', consequent: 'q == $past(d)' }],
        }),
      ),
    );

    expect(router.tasks).toEqual(['testbench']);
    expect(router.prompts).toHaveLength(1);
    expect(budget.canAfford()).toBe(true);
  });
});

describe('Property_Author model input', () => {
  it('is a pure function of the Spec that states the closed dialect', () => {
    const only = criterion('q equals d one clock after load');
    const spec = approvedSpec([only], 'clk');

    const builtOnce = buildPropertyModelInput(spec);
    expect(buildPropertyModelInput(spec)).toEqual(builtOnce);

    // Non-vacuous: the prompt is built FROM the Spec, so a criterion the model is asked
    // about is named by the id a property must carry back.
    expect(builtOnce.prompt).toContain(only.id);
    expect(builtOnce.prompt).toContain('byte_reg');
    // The dialect is stated as the closed accepted set, and the rejected forms with it.
    expect(builtOnce.prompt).toContain('Dialect: the accepted set below is CLOSED');
    expect(builtOnce.prompt).toContain('Write implication as `!a || b`');
    expect(builtOnce.prompt).toContain('no `|->`');
    // And the unexpressed rule, which is the one a weaker property would violate.
    expect(builtOnce.prompt).toContain('Unexpressed criteria:');
    expect(builtOnce.prompt).toContain('Do NOT emit a weaker, partial, or approximate property');
  });
});

describe('Property_Author as the loop property source', () => {
  it('satisfies PropertySetSource structurally', async () => {
    const only = criterion('q equals d one clock after load');
    const spec = approvedSpec([only], 'clk');
    const router = new ScriptedPropertyRouter(
      replyWith(
        JSON.stringify({
          properties: [{ criterionId: only.id, kind: 'clocked', consequent: 'q == $past(d)' }],
        }),
      ),
    );
    const recorder = new TraceActionRecorder(new InMemoryTracePersistence());

    // The assignment is the check: `PropertyAgent` is accepted where the loop's port is
    // required, with no `implements` clause and no adapter in between.
    const source: PropertySetSource = new PropertyAgent({ router, recorder });
    const set = await source.propertySetFor(spec, generousBudget());

    expect(set.properties).toHaveLength(1);
    expect(set.properties[0]?.criterionRef).toBe(only.id);
    expect(set.unexpressedCriteria).toEqual([]);
    expect(set.propertySetAdmitted).toBe('not-gated');
  });
});
