// Example unit tests for the Spec_Agent (S1, task 11.3; Req 5.1-5.4, 5.8, 5.9).
//
// These drive the agent through a FAKE ModelRouter (the injected model seam) plus a
// real Trace recorder over in-memory persistence, so the deterministic Spec gates
// and the approve/edit cycle are exercised without any provider call. The universal
// Property 15 (positive-width approval) and Property 16 (unmeasurable flagging) are
// separate fast-check properties in tasks 11.4 and 11.5; these examples complement
// them and pin the production, edit, and approval behaviors.

import { describe, expect, it } from 'vitest';

import {
  InMemorySessionBudgetHandle,
  InMemoryTracePersistence,
  SpecAgent,
  TraceActionRecorder,
  parseSpecDraft,
  type EditablePresentation,
  type ModelRequest,
  type ModelRouter,
  type ModelRouterFailure,
  type ModelTask,
  type RoutedModelResult,
  type RoutingDiagnostics,
  type SessionBudgetHandle,
  type SpecDraft,
  type SpecRevisionContext,
} from '@app/agent';
import { isErr, isOk, makeSessionBudget, newUlid, type Result, type Ulid } from '@app/core';
import { routedModelIdFor } from '@app/test';

/** A well-formed Spec draft: every port positive-width, every criterion measurable. */
const GOOD_DRAFT: SpecDraft = {
  timingContractEntries: [{ portName: 'q', timing: 'registered' }],
  goal: 'A 4-bit synchronous up counter',
  constraints: ['synchronous active-high reset'],
  architecture: 'A single clocked always block increments q on each rising clk edge.',
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

/**
 * A fake Model_Router: returns a single scripted result and records each call.
 *
 * It charges the threaded budget like the real router would, so the injected seam
 * is faithful without reaching any provider.
 */
class FakeModelRouter implements ModelRouter {
  readonly prompts: string[] = [];

  constructor(private readonly script: Result<RoutedModelResult, ModelRouterFailure>) {}

  invoke(
    task: ModelTask,
    request: ModelRequest,
    budget: SessionBudgetHandle,
  ): Promise<Result<RoutedModelResult, ModelRouterFailure>> {
    this.prompts.push(`${task}:${request.prompt.length}`);
    budget.charge({ tokens: 1, costCents: 0, wallClockMs: 1 });
    return Promise.resolve(this.script);
  }

  describeRouting(): RoutingDiagnostics {
    return { tasks: [], providers: [] };
  }
}

/** Wire a Spec_Agent around a scripted fake router plus a fresh in-memory recorder. */
function agentReturning(script: Result<RoutedModelResult, ModelRouterFailure>): {
  agent: SpecAgent;
  router: FakeModelRouter;
  recorder: TraceActionRecorder;
} {
  const router = new FakeModelRouter(script);
  const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
  const agent = new SpecAgent({ router, recorder, now: () => 1_700_000_000_000 });
  return { agent, router, recorder };
}

/** A Spec_Agent whose model reply is the JSON of the given draft. */
function agentForDraft(draft: SpecDraft): {
  agent: SpecAgent;
  recorder: TraceActionRecorder;
} {
  const { agent, recorder } = agentReturning(routed(JSON.stringify(draft)));
  return { agent, recorder };
}

/** A produce request for a fresh session/project. */
function produceInput(): { sessionId: Ulid; projectId: Ulid; confirmedIntent: string } {
  return {
    sessionId: newUlid(),
    projectId: newUlid(),
    confirmedIntent: 'Build a 4-bit synchronous up counter with reset.',
  };
}

/** A revision context for driving the pure presentDraft/approveSpec path directly. */
function context(): SpecRevisionContext {
  return { sessionId: newUlid(), projectId: newUlid(), specId: newUlid(), version: 1 };
}

/**
 * Wrap a JSON envelope in the markdown fence real providers emit.
 *
 * The leading space before the fence is faithful to the observed provider reply,
 * which a strict `JSON.parse` rejected even though the envelope inside was correct.
 */
function fencedReply(envelopeJson: string): string {
  return ` \`\`\`json\n${envelopeJson}\n\`\`\``;
}

describe('SpecAgent production (Req 5.1, 5.2)', () => {
  it('produces a Spec with interface, criteria, and architecture from the model', async () => {
    const { agent, recorder } = agentForDraft(GOOD_DRAFT);
    const input = produceInput();

    const presentation = await agent.produceSpec(input, generousBudget());

    expect(presentation.status).toBe('awaiting-approval');
    if (presentation.status !== 'awaiting-approval') {
      throw new Error('expected awaiting-approval');
    }
    const { spec } = presentation;
    expect(spec.approved).toBe(false);
    expect(spec.version).toBe(1);
    expect(spec.goal).toBe(GOOD_DRAFT.goal);
    expect(spec.architecture).toBe(GOOD_DRAFT.architecture);
    expect(spec.moduleInterface.moduleName).toBe('counter');
    expect(spec.moduleInterface.ports).toHaveLength(3);
    expect(spec.acceptanceCriteria).toHaveLength(2);
    expect(spec.acceptanceCriteria.every((c) => c.measurable)).toBe(true);

    // The production was recorded as a Spec_Agent span.
    const trace = await recorder.getTrace(input.sessionId);
    expect(trace.spans).toHaveLength(1);
    expect(trace.spans[0]?.stageOrTool).toBe('Spec_Agent');
    expect(trace.spans[0]?.outputs).toMatchObject({ status: 'awaiting-approval', portCount: 3 });
  });

  it('treats a malformed model reply as untrusted and fails safe', async () => {
    const { agent, recorder } = agentReturning(routed('not json at all'));
    const input = produceInput();

    const presentation = await agent.produceSpec(input, generousBudget());

    expect(presentation.status).toBe('production-failed');
    if (presentation.status === 'production-failed') {
      expect(presentation.failure.reason).toBe('unparseable-output');
    }
    const trace = await recorder.getTrace(input.sessionId);
    expect(trace.spans[0]?.failureClass).toBe('tool-error');
  });

  it('fails safe when the Model_Router gives up', async () => {
    const failure: Result<RoutedModelResult, ModelRouterFailure> = {
      ok: false,
      error: { code: 'ALL_PROVIDERS_FAILED', task: 'hard-planning', attempts: 2 },
    };
    const { agent } = agentReturning(failure);

    const presentation = await agent.produceSpec(produceInput(), generousBudget());

    expect(presentation.status).toBe('production-failed');
    if (presentation.status === 'production-failed') {
      expect(presentation.failure.reason).toBe('model-call-failed');
      expect(presentation.failure.routerFailure?.code).toBe('ALL_PROVIDERS_FAILED');
    }
  });
});

describe('parseSpecDraft - a conforming envelope wrapped in a markdown code fence', () => {
  it('given a fenced draft when parsed then the fence is stripped and the draft is returned', () => {
    const parsed = parseSpecDraft(fencedReply(JSON.stringify(GOOD_DRAFT)));

    expect(parsed).toEqual({ ok: true, value: GOOD_DRAFT });
  });

  it('given a genuinely malformed reply when parsed then it fails with the unchanged reason', () => {
    const parsed = parseSpecDraft('not json at all');

    expect(parsed).toEqual({ ok: false, error: 'model output was not valid JSON' });
  });

  it('given a fenced draft with an empty goal when parsed then field validation still rejects it', () => {
    const parsed = parseSpecDraft(fencedReply(JSON.stringify({ ...GOOD_DRAFT, goal: '  ' })));

    expect(parsed).toEqual({ ok: false, error: 'field "goal" must be a non-empty string' });
  });

  it('given a draft omitting timingContractEntries when parsed then the entries are empty', () => {
    const withoutEntries: Record<string, unknown> = { ...GOOD_DRAFT };
    delete withoutEntries['timingContractEntries'];

    const parsed = parseSpecDraft(JSON.stringify(withoutEntries));

    expect(parsed).toEqual({ ok: true, value: { ...withoutEntries, timingContractEntries: [] } });
  });

  it('given an out-of-vocabulary timing string when parsed then it survives the parse', () => {
    const entries = [{ portName: 'q', timing: 'eventually-maybe' }];

    const parsed = parseSpecDraft(
      JSON.stringify({ ...GOOD_DRAFT, timingContractEntries: entries }),
    );

    expect(parsed).toEqual({ ok: true, value: { ...GOOD_DRAFT, timingContractEntries: entries } });
  });

  it('given a timing contract entry with a blank portName when parsed then it is rejected', () => {
    const entries = [{ portName: '  ', timing: 'registered' }];

    const parsed = parseSpecDraft(
      JSON.stringify({ ...GOOD_DRAFT, timingContractEntries: entries }),
    );

    expect(parsed).toEqual({
      ok: false,
      error: 'timing contract entry field "portName" must be a non-empty string',
    });
  });

  it('given a fenced draft when the agent runs then it presents a Spec awaiting approval', async () => {
    const { agent } = agentReturning(routed(fencedReply(JSON.stringify(GOOD_DRAFT))));

    const presentation = await agent.produceSpec(produceInput(), generousBudget());

    expect(presentation.status).toBe('awaiting-approval');
  });
});

describe('SpecAgent interface validation (Req 5.3, 5.9)', () => {
  it('rejects a zero-width port and names the offending signal', async () => {
    const draft: SpecDraft = {
      ...GOOD_DRAFT,
      moduleInterface: {
        ...GOOD_DRAFT.moduleInterface,
        ports: [{ name: 'q', direction: 'output', width: 0 }],
      },
    };
    const { agent } = agentForDraft(draft);

    const presentation = await agent.produceSpec(produceInput(), generousBudget());

    expect(presentation.status).toBe('needs-revision');
    if (presentation.status !== 'needs-revision') {
      throw new Error('expected needs-revision');
    }
    expect(presentation.issues.signalIssues).toHaveLength(1);
    const issue = presentation.issues.signalIssues[0];
    expect(issue?.signalName).toBe('q');
    expect(issue?.reason).toContain('not a positive integer');
    expect(issue?.request).toContain('positive integer bit width');
  });

  it('rejects a negative-width port through the pure presentDraft path', () => {
    const { agent } = agentForDraft(GOOD_DRAFT);
    const draft: SpecDraft = {
      ...GOOD_DRAFT,
      moduleInterface: {
        ...GOOD_DRAFT.moduleInterface,
        ports: [{ name: 'data', direction: 'output', width: -8 }],
      },
    };

    const presentation = agent.presentDraft(context(), draft);

    expect(presentation.status).toBe('needs-revision');
    if (presentation.status === 'needs-revision') {
      expect(presentation.issues.signalIssues[0]?.signalName).toBe('data');
    }
  });
});

describe('SpecAgent acceptance-criteria validation (Req 5.4)', () => {
  it('flags a non-measurable criterion and requests a measurable replacement', async () => {
    const draft: SpecDraft = {
      ...GOOD_DRAFT,
      acceptanceCriteria: [
        { text: 'q increments each clock', measurable: true, method: 'simulation' },
        { text: 'the design should feel elegant', measurable: false, method: 'simulation' },
      ],
    };
    const { agent } = agentForDraft(draft);

    const presentation = await agent.produceSpec(produceInput(), generousBudget());

    expect(presentation.status).toBe('needs-revision');
    if (presentation.status !== 'needs-revision') {
      throw new Error('expected needs-revision');
    }
    expect(presentation.issues.unmeasurableCriteria).toHaveLength(1);
    const flag = presentation.issues.unmeasurableCriteria[0];
    expect(flag?.criterionText).toBe('the design should feel elegant');
    expect(flag?.replacementRequest).toContain('measurable');
  });

  it('flags a criterion whose method is not a rigorous method', () => {
    const draft: SpecDraft = {
      ...GOOD_DRAFT,
      acceptanceCriteria: [
        { text: 'looks good on the waveform', measurable: true, method: 'vibes' },
      ],
    };
    const { agent } = agentForDraft(GOOD_DRAFT);

    const presentation = agent.presentDraft(context(), draft);

    expect(presentation.status).toBe('needs-revision');
    if (presentation.status === 'needs-revision') {
      expect(presentation.issues.unmeasurableCriteria[0]?.reason).toContain('vibes');
    }
  });
});

describe('SpecAgent approval gate (Req 5.5, 5.6 at the Spec level)', () => {
  it('approves a valid Spec, marking it approved with all ports positive-width', async () => {
    const { agent } = agentForDraft(GOOD_DRAFT);
    const presentation = await agent.produceSpec(produceInput(), generousBudget());
    expect(presentation.status).toBe('awaiting-approval');

    const approval = await agent.approveSpec(presentation as EditablePresentation);

    expect(isOk(approval)).toBe(true);
    if (isOk(approval)) {
      expect(approval.value.approved).toBe(true);
      expect(approval.value.moduleInterface.ports.every((p) => p.width > 0)).toBe(true);
    }
  });

  it('refuses to approve a Spec with a non-positive-width port', async () => {
    const draft: SpecDraft = {
      ...GOOD_DRAFT,
      moduleInterface: {
        ...GOOD_DRAFT.moduleInterface,
        ports: [{ name: 'bus', direction: 'output', width: 0 }],
      },
    };
    const { agent } = agentForDraft(GOOD_DRAFT);
    const presentation = agent.presentDraft(context(), draft);

    const approval = await agent.approveSpec(presentation);

    expect(isErr(approval)).toBe(true);
    if (isErr(approval)) {
      expect(approval.error.signalIssues[0]?.signalName).toBe('bus');
    }
  });
});

describe('SpecAgent edit-then-re-present cycle (Req 5.8)', () => {
  it('incorporates an edit, re-presents at a new version, and then approves', async () => {
    // Start from a rejected draft (zero-width port), then edit to fix it.
    const badDraft: SpecDraft = {
      ...GOOD_DRAFT,
      moduleInterface: {
        ...GOOD_DRAFT.moduleInterface,
        ports: [
          { name: 'clk', direction: 'input', width: 1 },
          { name: 'q', direction: 'output', width: 0 },
        ],
      },
    };
    const { agent } = agentForDraft(badDraft);
    const first = await agent.produceSpec(produceInput(), generousBudget());
    expect(first.status).toBe('needs-revision');

    const editable = first as EditablePresentation;
    const rePresented = await agent.applyEdits(editable, {
      moduleInterface: {
        ...GOOD_DRAFT.moduleInterface,
        ports: [
          { name: 'clk', direction: 'input', width: 1 },
          { name: 'q', direction: 'output', width: 4 },
        ],
      },
    });

    expect(rePresented.status).toBe('awaiting-approval');
    if (rePresented.status !== 'awaiting-approval') {
      throw new Error('expected awaiting-approval after edit');
    }
    // Same Spec identity, incremented version, still unapproved until approval.
    expect(rePresented.context.specId).toBe(editable.context.specId);
    expect(rePresented.spec.version).toBe(2);
    expect(rePresented.spec.approved).toBe(false);

    const approval = await agent.approveSpec(rePresented);
    expect(isOk(approval)).toBe(true);
    if (isOk(approval)) {
      expect(approval.value.approved).toBe(true);
      expect(approval.value.version).toBe(2);
    }
  });

  it('preserves untouched fields when an edit patches only one field', async () => {
    const { agent } = agentForDraft(GOOD_DRAFT);
    const first = await agent.produceSpec(produceInput(), generousBudget());
    const editable = first as EditablePresentation;

    const edited = await agent.applyEdits(editable, { goal: 'A 4-bit down counter' });

    expect(edited.status).toBe('awaiting-approval');
    if (edited.status === 'awaiting-approval') {
      expect(edited.spec.goal).toBe('A 4-bit down counter');
      // The interface and criteria came through untouched from the original draft.
      expect(edited.spec.moduleInterface.ports).toHaveLength(3);
      expect(edited.spec.acceptanceCriteria).toHaveLength(2);
    }
  });
});

// The Port_Timing outcomes of assembly (task 8.7; Req 4.4-4.11).
//
// A two-output draft is used because the deleted all-`registered` fabrication and a
// contract sourced from the draft are indistinguishable on a draft whose only
// statement is `registered`: one port must state `combinational`, and a partial
// statement list is only representable with more than one output port.
describe('SpecAgent Port_Timing sourcing and escalation (Req 4.4-4.11)', () => {
  const TWO_OUTPUT_DRAFT: SpecDraft = {
    ...GOOD_DRAFT,
    moduleInterface: {
      ...GOOD_DRAFT.moduleInterface,
      ports: [
        { name: 'clk', direction: 'input', width: 1 },
        { name: 'q', direction: 'output', width: 4 },
        { name: 'carry', direction: 'output', width: 1 },
      ],
    },
    timingContractEntries: [
      { portName: 'q', timing: 'registered' },
      { portName: 'carry', timing: 'combinational' },
    ],
  };

  it('given a draft stating every output port when presented then the Spec carries the stated contract', () => {
    const { agent } = agentForDraft(GOOD_DRAFT);

    const presentation = agent.presentDraft(context(), TWO_OUTPUT_DRAFT);

    expect(presentation.status).toBe('awaiting-approval');
    if (presentation.status !== 'awaiting-approval') {
      throw new Error('expected awaiting-approval');
    }
    expect(presentation.spec.timingContract.entries).toEqual(
      TWO_OUTPUT_DRAFT.timingContractEntries,
    );
  });

  it('given a draft stating only one output port when presented then it escalates for exactly the missing port', () => {
    const { agent } = agentForDraft(GOOD_DRAFT);
    const partial: SpecDraft = {
      ...TWO_OUTPUT_DRAFT,
      timingContractEntries: [{ portName: 'q', timing: 'registered' }],
    };

    const presentation = agent.presentDraft(context(), partial);

    expect(presentation.status).toBe('needs-revision');
    if (presentation.status !== 'needs-revision') {
      throw new Error('expected needs-revision');
    }
    expect(presentation.issues.timingUnstated).toEqual(['carry']);
    expect(presentation.issues.signalIssues).toEqual([]);
    expect(presentation.timingQuestion?.tokens).toEqual([
      { kind: 'signal', name: 'carry' },
      { kind: 'frame', id: 'output-settles-at-cycle' },
    ]);
    expect(presentation.timingQuestion?.alternatives).toEqual([]);
  });
});
