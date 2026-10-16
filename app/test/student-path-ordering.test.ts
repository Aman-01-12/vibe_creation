// formal-gate-first-light, Component 11b: the Student_Path ordering, pinned as behaviour.
//
// THE NON-GOAL, WRITTEN AS A TEST
//   Requirement 10 protects an ordering: the Verification_Loop consults the Instrument_Admission
//   step BEFORE it submits anything to the Formal_Oracle. Nothing in this spec edits the loop's
//   source, so the risk is not that someone changes the order deliberately - it is that a later
//   change reorders it incidentally and no test notices, because every existing test asserts what
//   the loop DECIDED rather than the sequence it decided in.
//
// ASSERTED OVER OBSERVED CALLS, NEVER OVER THE SOURCE TEXT
//   A test that grepped `verification-loop.ts` for the two call sites would pass on a file where
//   the calls sit in that order inside branches that run the other way round. So both ports here
//   append to ONE shared log and the assertion reads that log. The claim is about what happened.
//
// WHY THE ADMISSION STEP MATTERS TO THE FORMAL GATE AT ALL
//   An inadmissible instrument means the sample's own testbench was never shown to be a usable
//   measuring stick. Submitting a Property_Set to the oracle before that is known would spend
//   proof time on a sample whose verdict cannot be trusted either way, and - worse - could mint a
//   `Verified` label on an instrument a control would have refused.
//
// Validates: Requirements 10.1, 10.5

import { describe, expect, it } from 'vitest';

import {
  InMemoryTracePersistence,
  TraceActionRecorder,
  VerificationLoop,
  type CandidateEval,
  type CandidateGenerator,
  type ConfirmedGenerationContext,
  type FormalPropertySet,
  type GenerationAdmissionRequest,
  type GenerationContextOpener,
  type IndependentTestbenchGenerator,
  type InstrumentAdmission,
  type InstrumentAdmissionDecision,
  type PropertySetSource,
} from '@app/agent';
import { newUlid, ok, oracleTrustLabeler, type Spec, type Testbench } from '@app/core';
import {
  FakeSandboxRuntime,
  IcarusSimulatorAdapter,
  SandboxToolRunner,
  validateExpression,
  type FormalOraclePort,
  type FormalOutcome,
  type RawRunCapture,
  type ResourceLimits,
} from '@app/tools';
import { timingContractFor } from '@app/test';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5_000 };
const REQUEST = {} as unknown as GenerationAdmissionRequest;

/** What each port appends to the shared log; the order between them is the claim. */
type CallName = 'instrument-admission' | 'formal-oracle';

/** An approved single-module Spec; its contents are not what this test reads. */
function approvedSpec(): Spec {
  return {
    timingContract: timingContractFor({
      validityOutputName: null,
      moduleName: 'byte_reg',
      ports: [
        { name: 'd', direction: 'input', width: 8 },
        { name: 'q', direction: 'output', width: 8 },
      ],
      clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
    }),
    id: newUlid(),
    projectId: newUlid(),
    goal: 'A byte register that captures d on the clock edge.',
    constraints: [],
    moduleInterface: {
      validityOutputName: null,
      moduleName: 'byte_reg',
      ports: [
        { name: 'd', direction: 'input', width: 8 },
        { name: 'q', direction: 'output', width: 8 },
      ],
      clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
    },
    acceptanceCriteria: [
      {
        id: newUlid(),
        text: 'q equals d one clock after load',
        measurable: true,
        method: 'formal',
      },
    ],
    architecture: 'One 8-bit register.',
    approved: true,
    version: 1,
  };
}

function confirmedContext(spec: Spec): ConfirmedGenerationContext {
  return {
    sessionId: newUlid(),
    projectId: spec.projectId,
    confirmedIntent: { summary: 'A byte register.', constraints: [], assumptions: [] },
    approvedSpec: spec,
  } as unknown as ConfirmedGenerationContext;
}

/** A gate opener that always admits. */
class AdmittingGate implements GenerationContextOpener {
  constructor(private readonly context: ConfirmedGenerationContext) {}

  openGenerationContext() {
    return Promise.resolve(ok(this.context));
  }
}

/** A generator handing back one fixed candidate. */
class OneCandidate implements CandidateGenerator {
  constructor(private readonly spec: Spec) {}

  generateCandidate() {
    return Promise.resolve(ok(this.candidate()));
  }

  reviseFromErrors() {
    // Unreached: every check in this fixture passes, so the loop never revises.
    return Promise.resolve(ok(this.candidate()));
  }

  /** A `CandidateEval`: the candidate plus the interface check the loop reads. */
  private candidate() {
    return {
      candidate: {
        id: newUlid(),
        specId: this.spec.id,
        files: [{ path: 'byte_reg.v', contents: 'module byte_reg; endmodule\n' }],
        topModule: 'byte_reg',
      },
      // Empty: the interface matches, so nothing here diverts the loop before the formal gate.
      interfaceDiagnostics: [],
    } as unknown as CandidateEval;
  }
}

/** A testbench port handing back one fixed testbench. */
class OneTestbench implements IndependentTestbenchGenerator {
  readonly #testbench: Testbench;

  constructor(spec: Spec) {
    this.#testbench = {
      id: newUlid(),
      specId: spec.id,
      // A STRING, not a SourceFile: the precheck scans it, and the admission port is handed
      // this same value.
      source: 'module byte_reg_tb;\n  initial $display("CHECK q_follows_d PASS");\nendmodule\n',
      derivedFrom: 'spec',
    } as unknown as Testbench;
  }

  generateTestbench() {
    return Promise.resolve({
      status: 'generated' as const,
      checkingApproach: 'cycle-timed' as const,
      testbench: this.#testbench,
      checks: [],
    });
  }

  repairTestbench() {
    // Unreached: the fixture's checks pass, so no repair is asked for.
    return Promise.resolve({
      status: 'generated' as const,
      checkingApproach: 'cycle-timed' as const,
      testbench: this.#testbench,
      checks: [],
    });
  }
}

/** An admission port that logs when it was consulted. */
class RecordingAdmission implements InstrumentAdmission {
  constructor(
    private readonly log: CallName[],
    private readonly decision: InstrumentAdmissionDecision,
  ) {}

  admit(): Promise<InstrumentAdmissionDecision> {
    this.log.push('instrument-admission');
    return Promise.resolve(this.decision);
  }
}

/** A Formal_Oracle port that logs every submission and decides nothing. */
class RecordingOracle implements FormalOraclePort {
  constructor(private readonly log: CallName[]) {}

  prove(): Promise<never> {
    this.log.push('formal-oracle');
    return Promise.reject(new Error('this oracle only records that it was reached'));
  }

  proveSet(): Promise<FormalOutcome> {
    this.log.push('formal-oracle');
    return Promise.reject(new Error('this oracle only records that it was reached'));
  }
}

/**
 * A property source handing back ONE REAL property.
 *
 * Non-empty deliberately: an empty set gives the loop nothing to prove, so it never submits and
 * the ordering claim below would be vacuous. That is not hypothetical - this test first read as
 * passing with an empty set, and the assertion that the oracle is actually reached is what caught
 * it.
 */
class OneProperty implements PropertySetSource {
  propertySetFor(): Promise<FormalPropertySet> {
    const consequent = validateExpression('q == $past(d)');
    if (!consequent.ok) {
      throw new Error('the pinned consequent must be inside the accepted dialect');
    }
    const clock = validateExpression('clk');
    if (!clock.ok) {
      throw new Error('the pinned clock must be inside the accepted dialect');
    }
    return Promise.resolve({
      properties: [
        {
          kind: 'clocked',
          id: 'p1',
          criterionRef: 'AC-1',
          clock: clock.value,
          antecedent: null,
          consequent: consequent.value,
        },
      ],
      unexpressedCriteria: [],
      propertySetAdmitted: 'not-gated',
      propertySetAuthoredUpFront: false,
    });
  }
}

/** A capture whose checks pass, so the loop reaches the formal gate rather than repairing. */
function passingCapture(): RawRunCapture {
  return {
    stdout: 'CHECK q_follows_d PASS\n',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    diskLimitExceeded: false,
    stdoutTruncated: false,
    artifacts: {},
    resourceUsage: { wallMs: 1, maxMemMb: 1, cpuMs: 1 },
  } as unknown as RawRunCapture;
}

/** Drive one real loop and return the order its two logged ports were reached in. */
async function observedOrder(decision: InstrumentAdmissionDecision): Promise<readonly CallName[]> {
  const spec = approvedSpec();
  const log: CallName[] = [];
  const runtime = new FakeSandboxRuntime(passingCapture());
  const loop = new VerificationLoop({
    gate: new AdmittingGate(confirmedContext(spec)),
    generator: new OneCandidate(spec),
    testbench: new OneTestbench(spec),
    simulator: new IcarusSimulatorAdapter(new SandboxToolRunner(runtime)),
    recorder: new TraceActionRecorder(new InMemoryTracePersistence()),
    trustLabeler: oracleTrustLabeler,
    instrumentAdmission: new RecordingAdmission(log, decision),
    formal: { oracle: new RecordingOracle(log), properties: new OneProperty() },
  });
  const budget = {
    sessionId: newUlid(),
    canAfford: () => true,
    charge: () => null,
    stopReason: () => null,
  };
  try {
    await loop.verify(REQUEST, budget, LIMITS);
  } catch {
    // The loop's own outcome is not what this test reads; the ORDER is.
  }
  return log;
}

describe('the Student_Path ordering (Req 10.1, 10.5)', () => {
  it('consults the Instrument_Admission step before it submits to the Formal_Oracle', async () => {
    const order = await observedOrder('admissible');

    // NON-VACUITY AS AN ASSERTION, not as a guard. An ordering claim is worthless if the
    // second event never happens, and a `if (provedAt !== -1)` guard would hide exactly that.
    // So both events are REQUIRED to have occurred before the order between them is read.
    expect(order).toContain('instrument-admission');
    expect(order).toContain('formal-oracle');

    // The claim, over the FIRST occurrence of each: the oracle may be reached more than once,
    // the admission step at most once.
    expect(order.indexOf('instrument-admission')).toBeLessThan(order.indexOf('formal-oracle'));

    // And consulted at most once per sample, which Req 4.12 also requires.
    expect(order.filter((name) => name === 'instrument-admission')).toHaveLength(1);
  });

  it('submits nothing to the Formal_Oracle when the instrument is inadmissible', async () => {
    // The ordering exists FOR this case: a refused instrument means the sample's testbench was
    // never shown to be a usable measuring stick, so spending proof time on it could mint a
    // Verified label on an instrument a control would have refused.
    const order = await observedOrder('inadmissible');

    expect(order).toContain('instrument-admission');
    expect(order).not.toContain('formal-oracle');
  });
});
