// Example unit tests for the Orchestrator generation gate (task 11.6).
//
// These concrete examples pin the gate's behavior at the four corners of its
// decision table plus the persistence and recording side effects:
//   - generation is REFUSED when intent is unconfirmed (Req 4.6);
//   - generation is REFUSED when the Spec is unapproved (Req 5.6);
//   - generation is ADMITTED only when BOTH hold, minting a capability token whose
//     entry point the runner requires (Req 4.5, 4.6, 5.5, 5.6);
//   - on admission the approved Spec is persisted as the source of truth through
//     the injected port and a checkpoint is written (Req 5.7);
//   - every decision (blocked or allowed) is recorded via the Action_Recorder.
//
// The universal Property 13 (generation gated on confirmation + approval) is a
// separate fast-check property in task 11.7; it states directly over
// `GenerationGate.openGenerationContext`. These examples complement it with
// specific, readable cases and verify the injected seams (runner, persistence
// sink, recorder) are driven exactly as specified, using fakes for all three.

import { describe, expect, it } from 'vitest';

import {
  ConfirmedGenerationContext,
  GenerationGate,
  InMemoryTracePersistence,
  TraceActionRecorder,
  intentArtifactLabel,
  type ApprovedSpecPersistInput,
  type GenerationRunner,
  type IntentConfirmationState,
  type IntentSession,
  type SessionBudgetHandle,
  type SpecApprovalReceipt,
  type SpecApprovalSink,
  type SpecApprovalSinkError,
} from '@app/agent';
import { err, newUlid, ok, type Result, type Spec, type TraceSpan, type Ulid } from '@app/core';

/** The opaque outcome a fake runner returns; the gate treats it as a black box. */
interface FakeGenerationOutcome {
  readonly ran: true;
  readonly moduleName: string;
}

/** A fake generation runner that records every admitted context it is handed. */
class FakeGenerationRunner implements GenerationRunner<FakeGenerationOutcome> {
  readonly calls: ConfirmedGenerationContext[] = [];

  // The budget parameter is intentionally omitted: this fake ignores it, and a
  // method with fewer parameters still satisfies the `GenerationRunner` port.
  runGeneration(context: ConfirmedGenerationContext): Promise<FakeGenerationOutcome> {
    this.calls.push(context);
    return Promise.resolve({
      ran: true,
      moduleName: context.approvedSpec.moduleInterface.moduleName,
    });
  }
}

/** A fake persistence sink that records inputs and returns a configured result. */
class FakeSpecApprovalSink implements SpecApprovalSink {
  readonly calls: ApprovedSpecPersistInput[] = [];
  #result: Result<SpecApprovalReceipt, SpecApprovalSinkError>;

  constructor(result: Result<SpecApprovalReceipt, SpecApprovalSinkError>) {
    this.#result = result;
  }

  persistApprovedSpec(
    input: ApprovedSpecPersistInput,
  ): Promise<Result<SpecApprovalReceipt, SpecApprovalSinkError>> {
    this.calls.push(input);
    return Promise.resolve(this.#result);
  }
}

/** A trivial budget handle: the gate only forwards it to the runner, never reads it. */
const STUB_BUDGET: SessionBudgetHandle = {
  sessionId: newUlid(),
  canAfford: () => true,
  charge: () => null,
  stopReason: () => null,
};

/** Build a `RestatedIntent`-bearing intent session in the requested confirmation state. */
function intentSession(confirmation: IntentConfirmationState): IntentSession {
  return {
    sessionId: newUlid(),
    artifact: intentArtifactLabel(newUlid(), 1),
    restatement: {
      summary: 'A 4-bit synchronous up counter with active-low reset.',
      constraints: ['synchronous reset', '4-bit output'],
      assumptions: ['single clock domain'],
    },
    scope: 'single-module',
    clarificationRounds: 1,
    outcome: { kind: 'ready-for-confirmation' },
    confirmation,
  };
}

/** Build a minimal, structurally valid Spec in the requested approval state. */
function spec(approved: boolean, projectId: Ulid = newUlid()): Spec {
  return {
    id: newUlid(),
    projectId,
    goal: 'Count clock edges modulo 16.',
    constraints: ['synchronous'],
    moduleInterface: {
      moduleName: 'counter4',
      ports: [
        { name: 'clk', direction: 'input', width: 1 },
        { name: 'rst_n', direction: 'input', width: 1 },
        { name: 'count', direction: 'output', width: 4 },
      ],
      clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
    },
    acceptanceCriteria: [
      {
        id: newUlid(),
        text: 'count increments each clock',
        measurable: true,
        method: 'simulation',
      },
    ],
    architecture: 'A single always_ff register with a modulo-16 increment.',
    approved,
    version: 1,
  };
}

/** A sink that succeeds and reports a checkpoint written. */
function succeedingSink(): FakeSpecApprovalSink {
  return new FakeSpecApprovalSink(ok({ checkpointWritten: true }));
}

/** Read back the recorded gate decision spans for a session. */
async function recordedSpans(
  recorder: TraceActionRecorder,
  sessionId: Ulid,
): Promise<readonly TraceSpan[]> {
  const trace = await recorder.getTrace(sessionId);
  return trace.spans;
}

describe('GenerationGate refuses when intent is unconfirmed (Req 4.6)', () => {
  it('returns an intent-unconfirmed refusal and never touches the sink or runner', async () => {
    const runner = new FakeGenerationRunner();
    const sink = succeedingSink();
    const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
    const gate = new GenerationGate({ runner, approvalSink: sink, recorder });
    const intent = intentSession('unconfirmed');

    const result = await gate.openGenerationContext({ intent, spec: spec(true) });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('intent-unconfirmed');
    }
    expect(sink.calls).toHaveLength(0);
    expect(runner.calls).toHaveLength(0);
  });

  it('records a single blocked decision span', async () => {
    const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
    const gate = new GenerationGate({
      runner: new FakeGenerationRunner(),
      approvalSink: succeedingSink(),
      recorder,
    });
    const intent = intentSession('unconfirmed');

    await gate.openGenerationContext({ intent, spec: spec(true) });

    const spans = await recordedSpans(recorder, intent.sessionId);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.stageOrTool).toBe('Generation_Gate');
    expect(spans[0]?.outputs).toMatchObject({ decision: 'blocked', reason: 'intent-unconfirmed' });
  });
});

describe('GenerationGate refuses when the Spec is unapproved (Req 5.6)', () => {
  it('returns a spec-unapproved refusal even with confirmed intent', async () => {
    const runner = new FakeGenerationRunner();
    const sink = succeedingSink();
    const gate = new GenerationGate({
      runner,
      approvalSink: sink,
      recorder: new TraceActionRecorder(new InMemoryTracePersistence()),
    });
    const intent = intentSession('confirmed');

    const result = await gate.openGenerationContext({ intent, spec: spec(false) });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('spec-unapproved');
    }
    // The source of truth is only persisted once the Spec is actually approved.
    expect(sink.calls).toHaveLength(0);
    expect(runner.calls).toHaveLength(0);
  });
});

describe('GenerationGate admits only when intent is confirmed AND the Spec is approved', () => {
  it('mints a token carrying the approved Spec and confirmed intent (Req 4.5, 5.5)', async () => {
    const gate = new GenerationGate({
      runner: new FakeGenerationRunner(),
      approvalSink: succeedingSink(),
      recorder: new TraceActionRecorder(new InMemoryTracePersistence()),
    });
    const intent = intentSession('confirmed');
    const approved = spec(true);

    const result = await gate.openGenerationContext({ intent, spec: approved });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeInstanceOf(ConfirmedGenerationContext);
      expect(result.value.approvedSpec).toBe(approved);
      expect(result.value.confirmedIntent).toBe(intent.restatement);
      expect(result.value.sessionId).toBe(intent.sessionId);
      expect(result.value.projectId).toBe(approved.projectId);
    }
  });

  it('persists the approved Spec as the source of truth via the injected port (Req 5.7)', async () => {
    const sink = succeedingSink();
    const gate = new GenerationGate({
      runner: new FakeGenerationRunner(),
      approvalSink: sink,
      recorder: new TraceActionRecorder(new InMemoryTracePersistence()),
    });
    const intent = intentSession('confirmed');
    const approved = spec(true);

    await gate.openGenerationContext({ intent, spec: approved });

    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]).toMatchObject({
      sessionId: intent.sessionId,
      projectId: approved.projectId,
    });
    expect(sink.calls[0]?.spec).toBe(approved);
  });

  it('records an allowed decision noting the persisted source of truth and checkpoint', async () => {
    const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
    const gate = new GenerationGate({
      runner: new FakeGenerationRunner(),
      approvalSink: succeedingSink(),
      recorder,
    });
    const intent = intentSession('confirmed');

    await gate.openGenerationContext({ intent, spec: spec(true) });

    const spans = await recordedSpans(recorder, intent.sessionId);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.outputs).toMatchObject({
      decision: 'allowed',
      sourceOfTruthPersisted: true,
      checkpointWritten: true,
    });
  });
});

describe('GenerationGate fails closed when persistence fails', () => {
  it('refuses with persist-failed and never invokes the runner', async () => {
    const runner = new FakeGenerationRunner();
    const sink = new FakeSpecApprovalSink(
      err({ code: 'PERSIST_FAILED', message: 'could not persist' }),
    );
    const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
    const gate = new GenerationGate({ runner, approvalSink: sink, recorder });
    const intent = intentSession('confirmed');

    const result = await gate.openGenerationContext({ intent, spec: spec(true) });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('persist-failed');
    }
    expect(runner.calls).toHaveLength(0);
    const spans = await recordedSpans(recorder, intent.sessionId);
    expect(spans[0]?.outputs).toMatchObject({ decision: 'blocked', reason: 'persist-failed' });
    expect(spans[0]?.failureClass).toBe('tool-error');
  });
});

describe('GenerationGate.runGeneration wires admission to the runner', () => {
  it('invokes the runner exactly once with the minted token when admitted', async () => {
    const runner = new FakeGenerationRunner();
    const gate = new GenerationGate({
      runner,
      approvalSink: succeedingSink(),
      recorder: new TraceActionRecorder(new InMemoryTracePersistence()),
    });
    const intent = intentSession('confirmed');
    const approved = spec(true);

    const result = await gate.runGeneration({ intent, spec: approved }, STUB_BUDGET);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ ran: true, moduleName: 'counter4' });
    }
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.approvedSpec).toBe(approved);
  });

  it('never invokes the runner when generation is blocked', async () => {
    const runner = new FakeGenerationRunner();
    const gate = new GenerationGate({
      runner,
      approvalSink: succeedingSink(),
      recorder: new TraceActionRecorder(new InMemoryTracePersistence()),
    });

    const unconfirmed = await gate.runGeneration(
      { intent: intentSession('unconfirmed'), spec: spec(true) },
      STUB_BUDGET,
    );
    const unapproved = await gate.runGeneration(
      { intent: intentSession('confirmed'), spec: spec(false) },
      STUB_BUDGET,
    );

    expect(unconfirmed.ok).toBe(false);
    expect(unapproved.ok).toBe(false);
    expect(runner.calls).toHaveLength(0);
  });
});
