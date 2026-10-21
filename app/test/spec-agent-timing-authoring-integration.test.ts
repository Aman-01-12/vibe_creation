// **Feature: timing-contract-inference, task 8.12: the four authoring integration
// cases** (Req 4.1, 4.3, 4.6, 10.4, 10.5).
//
// WHY produceSpec AND NOT presentDraft
//   Every other test in this increment (8.3, 8.5, 8.6, 8.8, 8.9, 8.11) drives
//   `presentDraft` directly with a hand-built `SpecDraft` object, which proves the
//   validation and escalation LOGIC is correct but never exercises the boundary a
//   real model reply crosses: raw JSON text in through the Model_Router, through
//   the real `parseSpecDraft`, into the real `validateSpecDraft`. This file drives
//   `produceSpec` with a scripted `ModelRouter` returning a JSON STRING (the shape
//   of a real provider reply), so a defect in the serialization boundary itself -
//   not just in the validation logic - would be caught here and nowhere else in
//   this increment.
//
// WHY FOUR SCENARIOS, NOT FIVE
//   The task names five fault shapes across three paragraphs, but the third
//   paragraph is explicit that the last two ("an invalid timing value AND an entry
//   naming a non-output port") are read together: both reach the same outcome
//   shape (`needs-revision`, `issues.signalIssues` naming the fault, no contract),
//   through the same `validateTimingEntry` function and the same aggregate.
//   Splitting them into two tests would duplicate the assertions for no added
//   signal, so this file states them as ONE scenario carrying both sub-faults at
//   once, named accordingly below.
//
// WHY SCENARIOS 3 AND 4 ARE THE LOAD-BEARING ONES
//   Per the task text: these are the two input shapes a model produces if the task
//   8.1 prompt edit did NOT take (an omitted field) or if the model emits a field
//   the prompt asked for but gets the content wrong (bad vocabulary, wrong port).
//   A suite that only ever hand-builds a complete, well-formed `timingContractEntries`
//   array (as the unit/property tests do) cannot distinguish "the prompt change
//   worked" from "the test never fed it a non-conforming reply" - these two
//   scenarios are what make that distinction testable.

import {
  InMemorySessionBudgetHandle,
  InMemoryTracePersistence,
  SpecAgent,
  TraceActionRecorder,
  type ModelRequest,
  type ModelRouter,
  type ModelRouterFailure,
  type ModelTask,
  type RoutedModelResult,
  type RoutingDiagnostics,
  type SessionBudgetHandle,
} from '@app/agent';
import { makeSessionBudget, newUlid, type Result } from '@app/core';
import { routedModelIdFor } from '@app/test';
import { describe, expect, it } from 'vitest';

/**
 * The untrusted shape a Spec_Agent model reply takes on the wire, before parsing.
 *
 * `timingContractEntries` is optional here (unlike `SpecDraft`) so scenario 3 can
 * build a literal object that omits the key entirely, which is what `JSON.stringify`
 * must see to produce a reply carrying no `timingContractEntries` field at all.
 */
interface RawSpecReply {
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly moduleInterface: {
    readonly moduleName: string;
    readonly ports: ReadonlyArray<{ name: string; direction: string; width: number }>;
    readonly clocking: {
      readonly clockName: string | null;
      readonly resetName: string | null;
      readonly resetActiveLow: boolean;
    };
  };
  readonly timingContractEntries?: ReadonlyArray<{ portName: string; timing: string }>;
  readonly acceptanceCriteria: ReadonlyArray<{
    text: string;
    measurable: boolean;
    method: string;
  }>;
  readonly architecture: string;
}

/**
 * A two-output-port envelope held constant across every scenario.
 *
 * Two output ports (not one) are required: a partial `timingContractEntries` list
 * is representable only when more than one output port exists, and scenario 4's
 * non-output-port fault needs an input port name (`clk`) to point at that is
 * distinct from either declared output.
 */
const BASE_REPLY: Omit<RawSpecReply, 'timingContractEntries'> = {
  goal: 'A 4-bit synchronous up counter with a carry flag',
  constraints: ['synchronous active-high reset'],
  architecture: 'A single clocked always block increments q and derives carry combinationally.',
  moduleInterface: {
    moduleName: 'counter',
    ports: [
      { name: 'clk', direction: 'input', width: 1 },
      { name: 'q', direction: 'output', width: 4 },
      { name: 'carry', direction: 'output', width: 1 },
    ],
    clocking: { clockName: 'clk', resetName: null, resetActiveLow: false },
  },
  acceptanceCriteria: [
    {
      text: 'q increments by one each clock while not in reset',
      measurable: true,
      method: 'simulation',
    },
  ],
};

/** A generous budget so the model seam, not the budget, drives every scenario. */
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

/** A successful routed result carrying the given raw text as the model's reply. */
function routed(outputText: string): Result<RoutedModelResult, ModelRouterFailure> {
  return {
    ok: true,
    value: {
      task: 'hard-planning',
      provider: 'claude',
      modelId: routedModelIdFor('claude'),
      outputText,
      tokensUsed: 42,
      costCents: 7,
      attempts: 1,
      fellBack: false,
    },
  };
}

/** A fake Model_Router returning one scripted result, charging the budget like the real one. */
class ScriptedRouter implements ModelRouter {
  constructor(private readonly script: Result<RoutedModelResult, ModelRouterFailure>) {}

  invoke(
    _task: ModelTask,
    _request: ModelRequest,
    budget: SessionBudgetHandle,
  ): Promise<Result<RoutedModelResult, ModelRouterFailure>> {
    budget.charge({ tokens: 1, costCents: 0, wallClockMs: 1 });
    return Promise.resolve(this.script);
  }

  describeRouting(): RoutingDiagnostics {
    return { tasks: [], providers: [] };
  }
}

/** Wire a fresh Spec_Agent whose model reply is the literal JSON STRING `outputText`. */
function agentReceiving(outputText: string): SpecAgent {
  const router = new ScriptedRouter(routed(outputText));
  const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
  return new SpecAgent({ router, recorder, now: () => 1_700_000_000_000 });
}

/** A produceSpec request for a fresh session/project. */
function produceInput(): {
  sessionId: ReturnType<typeof newUlid>;
  projectId: ReturnType<typeof newUlid>;
  confirmedIntent: string;
} {
  return {
    sessionId: newUlid(),
    projectId: newUlid(),
    confirmedIntent: 'Build a 4-bit synchronous up counter with a carry flag.',
  };
}

describe('Spec_Agent authoring, end to end through the raw model reply (task 8.12)', () => {
  it('a complete valid entry set approves with the stated contract (Req 4.1, 4.3)', async () => {
    const reply: RawSpecReply = {
      ...BASE_REPLY,
      timingContractEntries: [
        { portName: 'q', timing: 'registered' },
        { portName: 'carry', timing: 'combinational' },
      ],
    };
    const agent = agentReceiving(JSON.stringify(reply));

    const presentation = await agent.produceSpec(produceInput(), generousBudget());

    expect(presentation.status).toBe('awaiting-approval');
    if (presentation.status !== 'awaiting-approval') {
      throw new Error('expected awaiting-approval');
    }
    expect(presentation.spec.timingContract.entries).toEqual([
      { portName: 'q', timing: 'registered' },
      { portName: 'carry', timing: 'combinational' },
    ]);
  });

  it('a partially populated list escalates for exactly the missing ports (Req 4.6)', async () => {
    const reply: RawSpecReply = {
      ...BASE_REPLY,
      timingContractEntries: [{ portName: 'q', timing: 'registered' }],
    };
    const agent = agentReceiving(JSON.stringify(reply));

    const presentation = await agent.produceSpec(produceInput(), generousBudget());

    expect(presentation.status).toBe('needs-revision');
    if (presentation.status !== 'needs-revision') {
      throw new Error('expected needs-revision');
    }
    expect(presentation.issues.timingUnstated).toEqual(['carry']);
    expect(presentation.issues.signalIssues).toEqual([]);
    expect(presentation.timingQuestion).not.toBeNull();
  });

  it('an omitted timingContractEntries field escalates rather than defaulting (Req 4.3, 4.6)', async () => {
    // No `timingContractEntries` key at all: the reply a model produces if the
    // task 8.1 prompt edit did not take. This must NOT fabricate an all-registered
    // contract; it must escalate for every declared output port.
    const reply: Omit<RawSpecReply, 'timingContractEntries'> = { ...BASE_REPLY };
    const agent = agentReceiving(JSON.stringify(reply));

    const presentation = await agent.produceSpec(produceInput(), generousBudget());

    expect(presentation.status).toBe('needs-revision');
    if (presentation.status !== 'needs-revision') {
      throw new Error('expected needs-revision');
    }
    expect(presentation.issues.timingUnstated).toEqual(['q', 'carry']);
    expect(presentation.issues.signalIssues).toEqual([]);
    expect(presentation.timingQuestion).not.toBeNull();
  });

  it('an invalid timing value and an entry naming a non-output port each yield validation issues and no contract (Req 10.4, 10.5)', async () => {
    // Both sub-faults in one reply (see header): `q` carries an out-of-vocabulary
    // value, `clk` (an input, not a declared output port) carries a statement, and
    // `carry` is stated validly so only the two faults - not an unstated port -
    // reach the aggregate.
    const reply: RawSpecReply = {
      ...BASE_REPLY,
      timingContractEntries: [
        { portName: 'q', timing: 'maybe' },
        { portName: 'carry', timing: 'combinational' },
        { portName: 'clk', timing: 'registered' },
      ],
    };
    const agent = agentReceiving(JSON.stringify(reply));

    const presentation = await agent.produceSpec(produceInput(), generousBudget());

    expect(presentation.status).toBe('needs-revision');
    if (presentation.status !== 'needs-revision') {
      throw new Error('expected needs-revision');
    }
    expect(presentation.issues.signalIssues.map((issue) => issue.signalName)).toEqual(['q', 'clk']);
    expect(presentation.issues.signalIssues[0]?.reason).toContain('maybe');
    expect(presentation.issues.signalIssues[1]?.reason).toContain('not a declared output port');
    // No port is left unstated: both q and carry were named by some entry.
    expect(presentation.issues.timingUnstated).toEqual([]);
  });
});
