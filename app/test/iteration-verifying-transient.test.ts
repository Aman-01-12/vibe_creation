// Example/edge-case unit tests for the Iteration_Agent's intermediate `verifying`
// transient treatment (task 16.6; Req 10.6, 10.8).
//
// These concrete, example-based checks complement the numbered fast-check
// properties for iteration (Property 20 edit-demotion, task 16.2; Property 21
// spec-consistent re-verification, task 16.3). They pin the streaming/presentation
// phrasing the design's Testing Strategy calls out as example/edge-case coverage:
//
//   - Req 10.8: while an iteration re-verifies, the agent streams progress WITHOUT
//     blocking, and the intermediate module is shown with a transient `verifying`
//     status carried on a `verifying`-phase progress event.
//   - Req 10.6 (as it bears on the transient): the intermediate module is shown
//     under the `Unverified` treatment during re-verification - the `verifying`
//     event carries `tier: 'Unverified'`, never `Verified` - and the terminal
//     outcome presents a diff together with the NEW verdict.
//
// The transient is asserted to be identical (`verifying` under `Unverified`, before
// any terminal event) whether re-verification ultimately passes or fails, so the
// intermediate presentation never pre-announces a verdict the oracle has not given.
//
// Re-verification and the Spec update run through scripted in-memory fakes (no
// provider, no oracle, no network) so the streamed sequence is exercised through
// the real Iteration_Agent generator.

import { describe, expect, it } from 'vitest';

import {
  InMemorySessionBudgetHandle,
  InMemoryTracePersistence,
  IterationAgent,
  TraceActionRecorder,
  type IntentSession,
  type IterationOutcome,
  type IterationProgressEvent,
  type IterationReVerifier,
  type IterationRequest,
  type IterationSpecUpdater,
  type ReVerifyResult,
  type SessionBudgetHandle,
  type SpecChangeRequest,
} from '@app/agent';
import type { ResourceLimits } from '@app/tools';
import {
  isOk,
  makeVerificationResult,
  newUlid,
  ok,
  unverified,
  verified,
  type ArtifactRef,
  type LabeledArtifact,
  type ModuleVersion,
  type Spec,
  type Testbench,
  type Ulid,
  type Verdict,
  type VerificationResult,
} from '@app/core';
import { timingContractFor } from '@app/test';

// --- Fixtures ----------------------------------------------------------------

const MODULE_NAME = 'up_counter';

/** Generous caps; the scripted fakes, not the budget, drive every case. */
const LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };

/** An approved single-module Spec whose interface is held constant across the edit. */
function counterSpec(): Spec {
  return {
    timingContract: timingContractFor({
      validityOutputName: null,
      moduleName: MODULE_NAME,
      ports: [
        { name: 'clk', direction: 'input', width: 1 },
        { name: 'rst', direction: 'input', width: 1 },
        { name: 'count', direction: 'output', width: 4 },
      ],
      clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
    }),
    id: newUlid(),
    projectId: newUlid(),
    goal: 'A 4-bit synchronous up-counter that clears to zero on reset.',
    constraints: [],
    architecture: 'Single always block incrementing count on the clock edge.',
    moduleInterface: {
      validityOutputName: null,
      moduleName: MODULE_NAME,
      ports: [
        { name: 'clk', direction: 'input', width: 1 },
        { name: 'rst', direction: 'input', width: 1 },
        { name: 'count', direction: 'output', width: 4 },
      ],
      clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
    },
    acceptanceCriteria: [
      {
        id: newUlid(),
        text: 'reset clears the output to zero',
        measurable: true,
        method: 'simulation',
      },
    ],
    approved: true,
    version: 1,
  };
}

/** A fresh module version for the changed design (a NEW version). */
function moduleVersion(spec: Spec): ModuleVersion {
  return {
    id: newUlid(),
    projectId: spec.projectId,
    specVersion: spec.version,
    rtl: 'module up_counter(input clk, input rst, output reg [3:0] count); endmodule',
    createdAt: new Date(0).toISOString(),
  };
}

/** The independent, spec-derived Testbench for the current Spec. */
function testbenchFor(spec: Spec): Testbench {
  return {
    id: newUlid(),
    specId: spec.id,
    specVersion: spec.version,
    source: '// testbench emitting CHECK reset_clears_output',
    sourceAttribution: 'spec',
    coversCriteria: spec.acceptanceCriteria.map((criterion) => criterion.id),
  };
}

/** Build a recorded `VerificationResult` for a verdict, or throw on setup error. */
function verificationResult(verdict: Verdict, oracleSpanId: Ulid): VerificationResult {
  const built = makeVerificationResult({
    id: newUlid(),
    moduleVersionId: newUlid(),
    testbenchId: newUlid(),
    verdict,
    allChecksPassed: verdict === 'pass',
    iterations: 1,
    costCents: 0,
    oracleSpanId,
  });
  if (!isOk(built)) {
    throw new Error(`test setup: could not build a ${verdict} VerificationResult`);
  }
  return built.value;
}

/** A scripted re-verification result: a fresh pass, or a fail with no baseline. */
function reVerifyResult(kind: 'verified' | 'unverified', spec: Spec): ReVerifyResult {
  const mv = moduleVersion(spec);
  const newRef: ArtifactRef = { kind: 'module-version', id: mv.id, version: 1 };
  if (kind === 'verified') {
    const span = newUlid();
    const label = verified(newRef, span);
    if (!isOk(label)) {
      throw new Error('test setup: could not build a Verified label');
    }
    return {
      status: 'verified',
      label: label.value,
      moduleVersion: mv,
      testbench: testbenchFor(spec),
      result: verificationResult('pass', span),
    };
  }
  return {
    status: 'unverified',
    label: unverified(newRef),
    moduleVersion: mv,
    testbench: testbenchFor(spec),
    result: verificationResult('fail', newUlid()),
    failingCase: null,
  };
}

/** A Spec updater that re-approves the Spec at the next version, interface unchanged. */
class SteadySpecUpdater implements IterationSpecUpdater {
  applyChange(
    request: SpecChangeRequest,
    budget: SessionBudgetHandle,
  ): ReturnType<IterationSpecUpdater['applyChange']> {
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    const next: Spec = { ...request.currentSpec, version: request.currentSpec.version + 1 };
    return Promise.resolve(ok(next));
  }
}

/** A re-verifier that returns a fixed, scripted re-verification result. */
class ScriptedReVerifier implements IterationReVerifier {
  readonly #result: ReVerifyResult;
  constructor(result: ReVerifyResult) {
    this.#result = result;
  }
  reVerify(): Promise<ReVerifyResult> {
    return Promise.resolve(this.#result);
  }
}

/** The current `Unverified` label of the edited module (no baseline to revert to). */
function editedLabel(): LabeledArtifact {
  return unverified({ kind: 'module-version', id: newUlid(), version: 1 });
}

/** Build the iteration request for an edit with no prior Verified baseline. */
function iterationRequest(spec: Spec): IterationRequest {
  return {
    sessionId: newUlid(),
    projectId: spec.projectId,
    intent: {} as unknown as IntentSession,
    currentSpec: spec,
    edited: editedLabel(),
    requestedChange: 'widen the counter behavior to 8 bits without changing the interface',
    lastVerified: null,
  };
}

/** An in-memory budget with generous caps. */
function generousBudget(): InMemorySessionBudgetHandle {
  return new InMemorySessionBudgetHandle({
    sessionId: newUlid(),
    maxIterations: 100,
    maxTokens: 1_000_000,
    maxWallClockMs: 1_000_000_000,
    maxCostCents: 1_000_000,
    consumedIterations: 0,
    consumedTokens: 0,
    consumedMs: 0,
    consumedCostCents: 0,
  });
}

/** Wire a fresh Iteration_Agent over the scripted re-verifier and a real recorder. */
function agentReturning(result: ReVerifyResult): IterationAgent {
  return new IterationAgent({
    specUpdater: new SteadySpecUpdater(),
    reVerifier: new ScriptedReVerifier(result),
    recorder: new TraceActionRecorder(new InMemoryTracePersistence()),
    now: () => 1_700_000_000_000,
  });
}

/** Drain the streamed run, collecting progress events and the terminal outcome. */
async function runIteration(
  agent: IterationAgent,
  request: IterationRequest,
  budget: SessionBudgetHandle,
): Promise<{ events: IterationProgressEvent[]; outcome: IterationOutcome }> {
  const events: IterationProgressEvent[] = [];
  const iterator = agent.run(request, budget, LIMITS);
  let step = await iterator.next();
  while (!step.done) {
    events.push(step.value);
    step = await iterator.next();
  }
  return { events, outcome: step.value };
}

/** The single progress event of the given phase, or throw if absent. */
function eventOfPhase(
  events: readonly IterationProgressEvent[],
  phase: IterationProgressEvent['phase'],
): IterationProgressEvent {
  const found = events.find((event) => event.phase === phase);
  if (found === undefined) {
    throw new Error(`expected a "${phase}" progress event`);
  }
  return found;
}

// --- Req 10.8: the intermediate `verifying` transient ------------------------

describe('the intermediate module is streamed with a transient verifying status (Req 10.8)', () => {
  it('emits a verifying-phase event under Unverified with a human-readable status', async () => {
    const spec = counterSpec();
    const agent = agentReturning(reVerifyResult('verified', spec));

    const { events } = await runIteration(agent, iterationRequest(spec), generousBudget());

    const verifying = eventOfPhase(events, 'verifying');
    // The transient status is `verifying`, shown under the Unverified treatment
    // (the changed design has no fresh passing verdict yet).
    expect(verifying.kind).toBe('progress');
    expect(verifying.tier).toBe('Unverified');
    expect(verifying.message.trim().length).toBeGreaterThan(0);
    // The transient never carries a verdict - none exists mid-run.
    expect(verifying.verdict).toBeUndefined();
  });

  it('demotes the edited module to Unverified before the verifying transient', async () => {
    const spec = counterSpec();
    const agent = agentReturning(reVerifyResult('verified', spec));

    const { events } = await runIteration(agent, iterationRequest(spec), generousBudget());

    // Both the immediate demotion and the verifying transient are shown under
    // Unverified (Req 10.7, 10.8), and demotion is streamed before verifying.
    expect(eventOfPhase(events, 'demoting').tier).toBe('Unverified');
    const demotingIndex = events.findIndex((event) => event.phase === 'demoting');
    const verifyingIndex = events.findIndex((event) => event.phase === 'verifying');
    expect(demotingIndex).toBeGreaterThanOrEqual(0);
    expect(verifyingIndex).toBeGreaterThan(demotingIndex);
  });

  it('shows the same Unverified verifying transient whether re-verification passes or fails', async () => {
    for (const kind of ['verified', 'unverified'] as const) {
      const spec = counterSpec();
      const agent = agentReturning(reVerifyResult(kind, spec));

      const { events } = await runIteration(agent, iterationRequest(spec), generousBudget());

      // The transient is identical regardless of the eventual verdict: it never
      // pre-announces a pass the oracle has not yet given.
      expect(eventOfPhase(events, 'verifying').tier).toBe('Unverified');
      expect(eventOfPhase(events, 'verifying').verdict).toBeUndefined();
    }
  });
});

// --- Req 10.6: the transient precedes a diff-with-verdict terminal -----------

describe('the verifying transient precedes the diff-with-verdict outcome (Req 10.6)', () => {
  it('never carries the Verified tier on the transient; only the terminal verified event may', async () => {
    const spec = counterSpec();
    const agent = agentReturning(reVerifyResult('verified', spec));

    const { events, outcome } = await runIteration(agent, iterationRequest(spec), generousBudget());

    // The Verified tier appears only on the terminal `verified` event, after the
    // oracle-derived pass - never on the intermediate transient.
    const verifiedTierPhases = events
      .filter((event) => event.tier === 'Verified')
      .map((event) => event.phase);
    expect(verifiedTierPhases).toEqual(['verified']);
    expect(outcome.status).toBe('verified');
    // The verifying transient is strictly before the terminal event.
    const verifyingIndex = events.findIndex((event) => event.phase === 'verifying');
    const verifiedIndex = events.findIndex((event) => event.phase === 'verified');
    expect(verifiedIndex).toBeGreaterThan(verifyingIndex);
  });

  it('presents a diff carrying the new verdict once the transient resolves to a pass', async () => {
    const spec = counterSpec();
    const agent = agentReturning(reVerifyResult('verified', spec));

    const { outcome } = await runIteration(agent, iterationRequest(spec), generousBudget());

    expect(outcome.status).toBe('verified');
    if (outcome.status !== 'verified') {
      return;
    }
    // The diff is presented together with the new verdict (Req 10.6).
    expect(outcome.diff.verdict).toBe('pass');
    expect(outcome.diff.interfaceChanged).toBe(false);
    expect(outcome.diff.newModuleVersionId).toBe(outcome.moduleVersion.id);
  });

  it('resolves the transient to an Unverified outcome with a failing verdict on a non-pass', async () => {
    const spec = counterSpec();
    const agent = agentReturning(reVerifyResult('unverified', spec));

    const { events, outcome } = await runIteration(agent, iterationRequest(spec), generousBudget());

    // The transient was still Unverified, and no event ever claimed Verified.
    expect(eventOfPhase(events, 'verifying').tier).toBe('Unverified');
    expect(events.some((event) => event.tier === 'Verified')).toBe(false);
    // With no prior baseline the outcome is Unverified, carrying the failing verdict.
    expect(outcome.status).toBe('unverified');
    if (outcome.status !== 'unverified') {
      return;
    }
    expect(outcome.label.tier).toBe('Unverified');
    expect(outcome.diff.verdict).toBe('fail');
  });
});
