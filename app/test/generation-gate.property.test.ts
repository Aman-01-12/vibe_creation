// Property 13: Generation is gated on intent confirmation and spec approval (task 11.7).
//
// This is the universal complement to the concrete corner checks in
// `generation-gate.test.ts`. Over every combination of the two preconditions
// (intent confirmed?, Spec approved?) plus a persistence success/failure flag, it
// asserts the guarantees the Orchestrator generation gate must never break
// (Design: the generation gate, Property 13; Req 4.5, 4.6, 5.5, 5.6):
//
//   1. Biconditional (Req 4.5, 4.6, 5.5, 5.6): `openGenerationContext` mints a
//      `ConfirmedGenerationContext` capability token IF AND ONLY IF the intent is
//      confirmed AND the Spec is approved AND persistence succeeds. This is the
//      core anti-defect assertion: generation is NEVER admitted unless both
//      Student gates passed.
//   2. Reason precedence: for each refused corner the typed refusal carries the
//      correct reason, with `intent-unconfirmed` taking precedence over
//      `spec-unapproved`, and `persist-failed` only when both gates passed but the
//      sink failed (fail closed).
//   3. Runner isolation: `openGenerationContext` NEVER invokes the injected
//      `GenerationRunner`; `runGeneration` invokes it EXACTLY ONCE iff admitted and
//      never when refused.
//   4. Persistence discipline (Req 5.5, 5.6): the `SpecApprovalSink` is called at
//      most once, only when BOTH preconditions hold, and with the approved Spec;
//      when the sink fails the gate refuses `persist-failed` and the runner is
//      never touched.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ConfirmedGenerationContext,
  GenerationGate,
  InMemoryTracePersistence,
  TraceActionRecorder,
  intentArtifactLabel,
  type ApprovedSpecPersistInput,
  type GenerationGateRefusalReason,
  type GenerationRunner,
  type IntentConfirmationState,
  type IntentSession,
  type SessionBudgetHandle,
  type SpecApprovalReceipt,
  type SpecApprovalSink,
  type SpecApprovalSinkError,
} from '@app/agent';
import { err, newUlid, ok, type Result, type Spec, type Ulid } from '@app/core';
import { propertyParameters, propertyTag } from '@app/test';

const PROPERTY = propertyTag(13, 'Generation is gated on intent confirmation and spec approval');

// -- Fakes ------------------------------------------------------------------
// A counting runner and a configurable sink, plus a real TraceActionRecorder, so
// each generated scenario observes the exact seam interactions the gate performs.

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
  readonly #result: Result<SpecApprovalReceipt, SpecApprovalSinkError>;

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

// -- Builders (mirroring generation-gate.test.ts) ---------------------------

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

/** Build the configured sink result for a generated success/failure flag. */
function sinkResult(succeeds: boolean): Result<SpecApprovalReceipt, SpecApprovalSinkError> {
  return succeeds
    ? ok({ checkpointWritten: true })
    : err({ code: 'PERSIST_FAILED', message: 'could not persist approved Spec' });
}

// -- Scenario ---------------------------------------------------------------
// The full input space of the gate decision: the two Student gates plus the
// persistence outcome. Booleans are generated so every corner (including
// unconfirmed+unapproved, which pins reason precedence) is reachable.

interface Scenario {
  readonly intentConfirmed: boolean;
  readonly specApproved: boolean;
  readonly sinkSucceeds: boolean;
}

const scenarioArbitrary: fc.Arbitrary<Scenario> = fc.record({
  intentConfirmed: fc.boolean(),
  specApproved: fc.boolean(),
  sinkSucceeds: fc.boolean(),
});

/** The refusal reason the gate must return for a non-admitted scenario (precedence order). */
function expectedRefusalReason(scenario: Scenario): GenerationGateRefusalReason {
  if (!scenario.intentConfirmed) {
    return 'intent-unconfirmed';
  }
  if (!scenario.specApproved) {
    return 'spec-unapproved';
  }
  return 'persist-failed';
}

/** A freshly wired gate plus its observable fakes for one scenario. */
interface GateFixture {
  readonly gate: GenerationGate<FakeGenerationOutcome>;
  readonly runner: FakeGenerationRunner;
  readonly sink: FakeSpecApprovalSink;
  readonly intent: IntentSession;
  readonly spec: Spec;
}

/** Build a fresh gate, fakes, intent, and Spec for a scenario (no shared state across runs). */
function buildFixture(scenario: Scenario): GateFixture {
  const runner = new FakeGenerationRunner();
  const sink = new FakeSpecApprovalSink(sinkResult(scenario.sinkSucceeds));
  const gate = new GenerationGate({
    runner,
    approvalSink: sink,
    recorder: new TraceActionRecorder(new InMemoryTracePersistence()),
  });
  return {
    gate,
    runner,
    sink,
    intent: intentSession(scenario.intentConfirmed ? 'confirmed' : 'unconfirmed'),
    spec: spec(scenario.specApproved),
  };
}

// -- Properties -------------------------------------------------------------

describe(PROPERTY, () => {
  it('mints a token IFF intent is confirmed AND the Spec is approved AND persistence succeeds', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async (scenario) => {
        const { gate, runner, sink, intent, spec: subject } = buildFixture(scenario);
        const bothPreconditions = scenario.intentConfirmed && scenario.specApproved;
        const admitted = bothPreconditions && scenario.sinkSucceeds;

        const result = await gate.openGenerationContext({ intent, spec: subject });

        // Biconditional: admission happens exactly when both gates passed and the
        // source of truth persisted. This is the anti-defect assertion - a token
        // minted without both preconditions is a hard failure.
        expect(result.ok).toBe(admitted);

        // `openGenerationContext` alone never drives the runner.
        expect(runner.calls).toHaveLength(0);

        // The sink is touched only when both Student gates passed, at most once,
        // and always with the approved Spec (Req 5.5, 5.6).
        expect(sink.calls).toHaveLength(bothPreconditions ? 1 : 0);
        if (bothPreconditions) {
          expect(sink.calls[0]?.spec).toBe(subject);
          expect(sink.calls[0]).toMatchObject({
            sessionId: intent.sessionId,
            projectId: subject.projectId,
          });
        }

        if (result.ok) {
          expect(result.value).toBeInstanceOf(ConfirmedGenerationContext);
          expect(result.value.approvedSpec).toBe(subject);
          expect(result.value.confirmedIntent).toBe(intent.restatement);
          expect(result.value.sessionId).toBe(intent.sessionId);
        } else {
          // Reason precedence: intent-unconfirmed before spec-unapproved before
          // persist-failed.
          expect(result.error.reason).toBe(expectedRefusalReason(scenario));
        }
      }),
      propertyParameters(),
    );
  });

  it('invokes the runner exactly once when admitted and never when refused', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async (scenario) => {
        const { gate, runner, intent, spec: subject } = buildFixture(scenario);
        const admitted = scenario.intentConfirmed && scenario.specApproved && scenario.sinkSucceeds;

        const result = await gate.runGeneration({ intent, spec: subject }, STUB_BUDGET);

        // The wired path admits and runs iff both gates passed and persistence
        // succeeded; otherwise it returns the typed refusal untouched.
        expect(result.ok).toBe(admitted);
        expect(runner.calls).toHaveLength(admitted ? 1 : 0);
        if (admitted) {
          expect(runner.calls[0]?.approvedSpec).toBe(subject);
        } else if (!result.ok) {
          expect(result.error.reason).toBe(expectedRefusalReason(scenario));
        }
      }),
      propertyParameters(),
    );
  });
});
