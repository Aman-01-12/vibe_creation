// Unit tests for the self-healing failure-recovery loop (S7 recovery layer, task
// 14.4; design "Error Handling (self-healing loop)"; Req 8.4, 12.5).
//
// These examples pin the failure-class -> targeted-recovery mapping the design
// mandates: a compile syntax error is fixed from diagnostics (never a blind
// re-run), a deterministic simulation timeout is re-planned (a fresh candidate,
// never the same run again), a transient tool crash is retried once with a bounded
// backoff then escalated to the fallback model, and malformed model output is
// re-planned then escalated to the fallback model. They also pin escalation: when a
// ladder is walked without an oracle pass the loop escalates (`ladder-exhausted`),
// and when the Session_Budget can afford no attempt the loop escalates
// (`budget-exhausted`) instead of looping forever. Every recovery is confirmed only
// by the Simulator oracle (a `pass` verdict), never by a model claiming success.
//
// Driven through a scripted RecoveryGenerator fake (which routes fix/re-plan/
// fallback exactly as the real Generation_Agent would and charges the budget), a
// scripted Simulator oracle fake, a real in-memory Action_Recorder, and a fake
// backoff clock so the bounded backoff is observable without real delay. The
// numbered property coverage is elsewhere; this file is the example-level mapping.

import { describe, expect, it } from 'vitest';

import {
  newUlid,
  ok,
  unverified,
  type ArtifactRef,
  type Result,
  type Spec,
  type Testbench,
  type SessionBudget,
} from '@app/core';
import type { ResourceLimits, SimulationVerdict, SimulatorAdapter, SourceFile } from '@app/tools';

import { InMemoryTracePersistence, TraceActionRecorder } from '../action-recorder/index.js';
import { InMemorySessionBudgetHandle } from '../model-router/index.js';
import type {
  CandidateEval,
  CandidateFailure,
  GeneratedCandidate,
  GenerationInput,
} from '../roles/generation/index.js';

import {
  SelfHealingLoop,
  backoffDelayMs,
  classifyFailure,
  coreFailureClass,
  recoveryLadderFor,
  type FailureSignal,
  type RecoveryContext,
  type RecoveryGenerator,
} from './self-healing.js';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5000 };

// --- Domain fixtures -------------------------------------------------------

/** An approved single-module Spec with one simulation-verifiable acceptance criterion. */
function approvedSpec(): Spec {
  return {
    id: newUlid(),
    projectId: newUlid(),
    goal: 'A byte register that captures d on the clock edge.',
    constraints: [],
    moduleInterface: {
      moduleName: 'byte_reg',
      ports: [
        { name: 'd', direction: 'input', width: 8 },
        { name: 'q', direction: 'output', width: 8 },
      ],
      clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
    },
    acceptanceCriteria: [
      { id: newUlid(), text: 'q captures d', measurable: true, method: 'simulation' },
    ],
    architecture: 'Single always block latching d into q.',
    approved: true,
    version: 1,
  };
}

/** A minimal generated candidate whose label carries a fresh module-version ref. */
function candidate(spec: Spec, rtl = 'module byte_reg; endmodule'): GeneratedCandidate {
  const id = newUlid();
  const moduleVersion = {
    id,
    projectId: spec.projectId,
    specVersion: spec.version,
    rtl,
    createdAt: new Date(0).toISOString(),
  };
  const artifactRef: ArtifactRef = { kind: 'module-version', id, version: 1 };
  return {
    rtl,
    parsedInterface: { moduleName: 'byte_reg', ports: [] },
    interfaceMatch: {
      matches: true,
      moduleNameMatches: true,
      expectedModuleName: 'byte_reg',
      actualModuleName: 'byte_reg',
      missingPorts: [],
      extraPorts: [],
      mismatchedPorts: [],
    },
    moduleVersion,
    label: unverified(artifactRef),
  };
}

/** A produced Testbench derived from the Spec, attributed to the Spec version. */
function testbenchFor(spec: Spec): Testbench {
  return {
    id: newUlid(),
    specId: spec.id,
    specVersion: spec.version,
    source: 'module byte_reg_tb; endmodule',
    sourceAttribution: 'spec',
    coversCriteria: spec.acceptanceCriteria.map((c) => c.id),
  };
}

/** The generation input every recovery regeneration is derived from. */
function genInputFor(spec: Spec): GenerationInput {
  return { sessionId: newUlid(), projectId: spec.projectId, spec };
}

/** Assemble the recovery context handed to `heal` from a failed verification run. */
function contextFor(spec: Spec): RecoveryContext {
  return {
    genInput: genInputFor(spec),
    failingCandidate: candidate(spec, 'module byte_reg; // failing'),
    testbench: testbenchFor(spec),
    diagnostics: 'compile error near q_captures_d',
    limits: LIMITS,
    failedSpanId: newUlid(),
  };
}

// --- Simulator verdict fixtures --------------------------------------------

/** A passing oracle verdict: the sole evidence that a recovery actually worked. */
function passVerdict(): SimulationVerdict {
  return {
    verdict: 'pass',
    checks: [{ name: 'q_captures_d', passed: true }],
    vcd: null,
    stdout: 'CHECK q_captures_d PASS\n',
    stderr: '',
    exitCode: 0,
    resourceUsage: { wallMs: 12, maxMemMb: 8, cpuMs: 10 },
  };
}

/** A functional-fail verdict: the candidate ran but a spec check failed. */
function failVerdict(): SimulationVerdict {
  return {
    verdict: 'fail',
    checks: [{ name: 'q_captures_d', passed: false }],
    vcd: null,
    stdout: 'CHECK q_captures_d FAIL\n',
    stderr: '',
    exitCode: 0,
    resourceUsage: { wallMs: 9, maxMemMb: 8, cpuMs: 7 },
  };
}

/** A timeout verdict: killed (no exit) with wall clock at the cap. */
function timeoutVerdict(): SimulationVerdict {
  return {
    verdict: 'error',
    checks: [],
    vcd: null,
    stdout: '',
    stderr: '',
    exitCode: null,
    resourceUsage: { wallMs: LIMITS.wallMs, maxMemMb: 8, cpuMs: LIMITS.wallMs },
  };
}

/** A compile-error verdict from simulation: non-zero exit with no waveform. */
function compileErrorVerdict(): SimulationVerdict {
  return {
    verdict: 'error',
    checks: [],
    vcd: null,
    stdout: '',
    stderr: 'syntax error',
    exitCode: 2,
    resourceUsage: { wallMs: 4, maxMemMb: 8, cpuMs: 3 },
  };
}

/** A generic (transient) tool-crash verdict: no exit, well under the wall cap. */
function toolCrashVerdict(): SimulationVerdict {
  return {
    verdict: 'error',
    checks: [],
    vcd: null,
    stdout: '',
    stderr: '',
    exitCode: null,
    resourceUsage: { wallMs: 3, maxMemMb: 8, cpuMs: 2 },
  };
}

// --- Fakes -----------------------------------------------------------------

/**
 * A scripted Simulator oracle: returns the queued verdicts in order and records
 * the RTL module names it was asked to simulate. Never throws (the loop treats a
 * throw as an `error` verdict, which would mask a scripting mistake).
 */
class ScriptedSimulator implements SimulatorAdapter {
  readonly rtlModules: string[] = [];
  readonly #verdicts: SimulationVerdict[];
  #index = 0;

  constructor(verdicts: readonly SimulationVerdict[]) {
    this.#verdicts = [...verdicts];
  }

  get calls(): number {
    return this.#index;
  }

  simulate(rtl: readonly SourceFile[]): Promise<SimulationVerdict> {
    this.rtlModules.push(rtl[0]?.contents ?? '');
    const verdict = this.#verdicts[Math.min(this.#index, this.#verdicts.length - 1)];
    this.#index += 1;
    return Promise.resolve(verdict ?? failVerdict());
  }
}

/** One scripted generator response keyed by the produce method it belongs to. */
type ProduceResult = Result<CandidateEval, CandidateFailure>;

/**
 * A scripted RecoveryGenerator: records which recovery method the loop invoked and
 * returns the scripted candidate for that method, charging the budget one iteration
 * per produce (mirroring the real Model_Router-backed agent). This makes the
 * failure-class -> recovery mapping observable through `calls`.
 */
class ScriptedRecoveryGenerator implements RecoveryGenerator {
  readonly calls: string[] = [];
  readonly #generate: ProduceResult;
  readonly #revise: ProduceResult;
  readonly #fallback: ProduceResult;

  constructor(scripts: {
    generate?: ProduceResult;
    revise?: ProduceResult;
    fallback?: ProduceResult;
  }) {
    this.#generate = scripts.generate ?? unavailable();
    this.#revise = scripts.revise ?? unavailable();
    this.#fallback = scripts.fallback ?? unavailable();
  }

  generateCandidate(
    _input: GenerationInput,
    budget: InMemorySessionBudgetHandle,
  ): Promise<ProduceResult> {
    this.calls.push('generateCandidate');
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve(this.#generate);
  }

  reviseFromErrors(
    _input: GenerationInput,
    _previousRtl: string,
    _diagnostics: string,
    budget: InMemorySessionBudgetHandle,
  ): Promise<ProduceResult> {
    this.calls.push('reviseFromErrors');
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve(this.#revise);
  }

  reviseWithFallbackModel(
    _input: GenerationInput,
    _previousRtl: string,
    _diagnostics: string,
    budget: InMemorySessionBudgetHandle,
  ): Promise<ProduceResult> {
    this.calls.push('reviseWithFallbackModel');
    budget.charge({ tokens: 1, costCents: 1, wallClockMs: 1 });
    return Promise.resolve(this.#fallback);
  }
}

/** A produce failure standing in for an unscripted branch (should not be reached). */
function unavailable(): ProduceResult {
  return { ok: false, error: { reason: 'model-unavailable', detail: 'not scripted' } };
}

/** Wrap a candidate as a successfully produced CandidateEval. */
function evalOf(cand: GeneratedCandidate): ProduceResult {
  return ok({ candidate: cand, interfaceDiagnostics: '' });
}

/** A budget with generous caps for the recovery-success paths. */
function budgetWithIterations(maxIterations: number): InMemorySessionBudgetHandle {
  const budget: SessionBudget = {
    sessionId: newUlid(),
    maxIterations,
    maxTokens: 1_000_000,
    maxWallClockMs: 1_000_000,
    maxCostCents: 1_000_000,
    consumedIterations: 0,
    consumedTokens: 0,
    consumedMs: 0,
    consumedCostCents: 0,
  };
  return new InMemorySessionBudgetHandle(budget);
}

/** Assemble the loop over the scripted fakes, a real recorder, and a fake backoff clock. */
function makeLoop(
  generator: RecoveryGenerator,
  simulator: SimulatorAdapter,
): { loop: SelfHealingLoop; waits: number[] } {
  const waits: number[] = [];
  const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
  const loop = new SelfHealingLoop({
    generator,
    simulator,
    recorder,
    wait: (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    },
    now: () => 0,
  });
  return { loop, waits };
}

// --- classifyFailure: every signal maps to exactly one class ---------------

describe('classifyFailure - each failure signal maps to exactly one class', () => {
  it('maps a compile signal to syntax-error', () => {
    const signal: FailureSignal = { source: 'compile', diagnostics: 'unexpected token' };
    expect(classifyFailure(signal)).toBe('syntax-error');
  });

  it('maps unparseable model output to malformed-model-output', () => {
    const signal: FailureSignal = {
      source: 'model-output',
      failure: { reason: 'unparseable', detail: 'no code block' },
    };
    expect(classifyFailure(signal)).toBe('malformed-model-output');
  });

  it('maps a model-unavailable failure to tool-crash', () => {
    const signal: FailureSignal = {
      source: 'model-output',
      failure: { reason: 'model-unavailable', detail: 'provider down' },
    };
    expect(classifyFailure(signal)).toBe('tool-crash');
  });

  it('maps a thrown exception to tool-crash (fail safe)', () => {
    expect(classifyFailure({ source: 'exception' })).toBe('tool-crash');
  });

  it('maps a killed-at-wall-cap simulation to simulation-timeout', () => {
    const signal: FailureSignal = { source: 'simulation', verdict: timeoutVerdict() };
    expect(classifyFailure(signal, LIMITS)).toBe('simulation-timeout');
  });

  it('maps a non-zero-exit no-waveform simulation to syntax-error', () => {
    const signal: FailureSignal = { source: 'simulation', verdict: compileErrorVerdict() };
    expect(classifyFailure(signal, LIMITS)).toBe('syntax-error');
  });

  it('maps an otherwise-unclassifiable simulation error to tool-crash', () => {
    const signal: FailureSignal = { source: 'simulation', verdict: toolCrashVerdict() };
    expect(classifyFailure(signal, LIMITS)).toBe('tool-crash');
  });
});

// --- recoveryLadderFor: the intended targeted ladder per class -------------

describe('recoveryLadderFor - each class maps to its targeted recovery ladder', () => {
  it('recovers a syntax error by fixing from diagnostics, then escalating', () => {
    expect(recoveryLadderFor('syntax-error')).toEqual(['fix-and-retry', 'escalate']);
  });

  it('recovers a simulation timeout by re-planning (never a blind re-run), then escalating', () => {
    expect(recoveryLadderFor('simulation-timeout')).toEqual(['re-plan', 'escalate']);
  });

  it('recovers a tool crash by one backoff retry, then the fallback model, then escalating', () => {
    expect(recoveryLadderFor('tool-crash')).toEqual(['backoff', 'fallback-model', 'escalate']);
  });

  it('recovers malformed model output by re-planning, then the fallback model, then escalating', () => {
    expect(recoveryLadderFor('malformed-model-output')).toEqual([
      're-plan',
      'fallback-model',
      'escalate',
    ]);
  });

  it('maps each recovery class to its recorded core FailureClass', () => {
    expect(coreFailureClass('syntax-error')).toBe('compile-error');
    expect(coreFailureClass('simulation-timeout')).toBe('timeout');
    expect(coreFailureClass('tool-crash')).toBe('tool-error');
    expect(coreFailureClass('malformed-model-output')).toBe('tool-error');
  });
});

// --- backoffDelayMs: bounded, never unbounded ------------------------------

describe('backoffDelayMs - bounded exponential backoff', () => {
  it('grows exponentially from the base and never exceeds the cap', () => {
    const schedule = { baseMs: 100, maxMs: 400 };
    expect(backoffDelayMs(1, schedule)).toBe(100);
    expect(backoffDelayMs(2, schedule)).toBe(200);
    expect(backoffDelayMs(3, schedule)).toBe(400);
    expect(backoffDelayMs(10, schedule)).toBe(400);
  });
});

// --- heal: failure class -> targeted recovery, oracle-confirmed ------------

describe('SelfHealingLoop.heal - syntax error recovers via fix-and-retry (Req 8.4)', () => {
  it('fixes from diagnostics and confirms recovery by an oracle pass, without a blind re-run', async () => {
    const spec = approvedSpec();
    const fixed = candidate(spec, 'module byte_reg; // fixed');
    const generator = new ScriptedRecoveryGenerator({ revise: evalOf(fixed) });
    const simulator = new ScriptedSimulator([passVerdict()]);
    const { loop } = makeLoop(generator, simulator);

    const outcome = await loop.heal(
      { source: 'compile', diagnostics: 'unexpected token' },
      contextFor(spec),
      budgetWithIterations(20),
    );

    expect(outcome.status).toBe('recovered');
    if (outcome.status !== 'recovered') return;
    expect(outcome.category).toBe('syntax-error');
    expect(outcome.action).toBe('fix-and-retry');
    expect(outcome.attempts).toBe(1);
    expect(outcome.simulation.verdict).toBe('pass');
    // The recovery is a targeted fix, never a re-plan or blind re-run of the same run.
    expect(generator.calls).toEqual(['reviseFromErrors']);
    expect(simulator.calls).toBe(1);
    expect(simulator.rtlModules[0]).toContain('fixed');
  });
});

describe('SelfHealingLoop.heal - simulation timeout re-plans, never blind-retries (Req 8.4)', () => {
  it('regenerates a fresh candidate after a bounded backoff rather than re-running the timed-out run', async () => {
    const spec = approvedSpec();
    const replanned = candidate(spec, 'module byte_reg; // replanned');
    const generator = new ScriptedRecoveryGenerator({ generate: evalOf(replanned) });
    const simulator = new ScriptedSimulator([passVerdict()]);
    const { loop, waits } = makeLoop(generator, simulator);

    const outcome = await loop.heal(
      { source: 'simulation', verdict: timeoutVerdict() },
      contextFor(spec),
      budgetWithIterations(20),
    );

    expect(outcome.status).toBe('recovered');
    if (outcome.status !== 'recovered') return;
    expect(outcome.category).toBe('simulation-timeout');
    expect(outcome.action).toBe('re-plan');
    // Re-plan regenerates; it never fixes-in-place and never re-runs the same run.
    expect(generator.calls).toEqual(['generateCandidate']);
    expect(simulator.rtlModules).toEqual([expect.stringContaining('replanned')]);
    // Re-plan waits a bounded backoff before regenerating.
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(0);
  });
});

describe('SelfHealingLoop.heal - tool crash retries once with backoff (Req 8.4, 12.5)', () => {
  it('re-runs the same candidate after a single bounded backoff and recovers on an oracle pass', async () => {
    const spec = approvedSpec();
    const generator = new ScriptedRecoveryGenerator({});
    const simulator = new ScriptedSimulator([passVerdict()]);
    const { loop, waits } = makeLoop(generator, simulator);
    const context = contextFor(spec);

    const outcome = await loop.heal({ source: 'exception' }, context, budgetWithIterations(20));

    expect(outcome.status).toBe('recovered');
    if (outcome.status !== 'recovered') return;
    expect(outcome.category).toBe('tool-crash');
    expect(outcome.action).toBe('backoff');
    // A backoff retry re-runs the SAME failing candidate; it produces no new candidate.
    expect(generator.calls).toEqual([]);
    expect(simulator.rtlModules).toEqual([context.failingCandidate.rtl]);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(0);
  });

  it('escalates to the fallback model when the backoff retry still fails (Req 12.5)', async () => {
    const spec = approvedSpec();
    const recovered = candidate(spec, 'module byte_reg; // via-fallback');
    const generator = new ScriptedRecoveryGenerator({ fallback: evalOf(recovered) });
    const simulator = new ScriptedSimulator([toolCrashVerdict(), passVerdict()]);
    const { loop } = makeLoop(generator, simulator);

    const outcome = await loop.heal(
      { source: 'exception' },
      contextFor(spec),
      budgetWithIterations(20),
    );

    expect(outcome.status).toBe('recovered');
    if (outcome.status !== 'recovered') return;
    expect(outcome.category).toBe('tool-crash');
    expect(outcome.action).toBe('fallback-model');
    expect(outcome.attempts).toBe(2);
    // Backoff first (re-run same), then the Model_Router fallback path.
    expect(generator.calls).toEqual(['reviseWithFallbackModel']);
    expect(simulator.rtlModules[1]).toContain('via-fallback');
  });
});

describe('SelfHealingLoop.heal - malformed model output re-plans then falls back (Req 12.5)', () => {
  it('re-plans on the primary model, then escalates to the fallback model that recovers', async () => {
    const spec = approvedSpec();
    const replanned = candidate(spec, 'module byte_reg; // replanned');
    const viaFallback = candidate(spec, 'module byte_reg; // via-fallback');
    const generator = new ScriptedRecoveryGenerator({
      generate: evalOf(replanned),
      fallback: evalOf(viaFallback),
    });
    const simulator = new ScriptedSimulator([failVerdict(), passVerdict()]);
    const { loop } = makeLoop(generator, simulator);

    const outcome = await loop.heal(
      { source: 'model-output', failure: { reason: 'unparseable', detail: 'no code block' } },
      contextFor(spec),
      budgetWithIterations(20),
    );

    expect(outcome.status).toBe('recovered');
    if (outcome.status !== 'recovered') return;
    expect(outcome.category).toBe('malformed-model-output');
    expect(outcome.action).toBe('fallback-model');
    expect(outcome.attempts).toBe(2);
    expect(generator.calls).toEqual(['generateCandidate', 'reviseWithFallbackModel']);
  });
});

// --- heal: escalation when a ladder is exhausted or the budget disallows ----

describe('SelfHealingLoop.heal - escalates when the recovery ladder is exhausted (Req 8.4)', () => {
  it('walks the whole ladder without an oracle pass and escalates instead of looping', async () => {
    const spec = approvedSpec();
    const replanned = candidate(spec, 'module byte_reg; // replanned');
    const viaFallback = candidate(spec, 'module byte_reg; // via-fallback');
    const generator = new ScriptedRecoveryGenerator({
      generate: evalOf(replanned),
      fallback: evalOf(viaFallback),
    });
    // Every attempt fails the oracle, so the ladder is exhausted.
    const simulator = new ScriptedSimulator([failVerdict(), failVerdict()]);
    const { loop } = makeLoop(generator, simulator);

    const outcome = await loop.heal(
      { source: 'model-output', failure: { reason: 'unparseable', detail: 'no code block' } },
      contextFor(spec),
      budgetWithIterations(20),
    );

    expect(outcome.status).toBe('escalated');
    if (outcome.status !== 'escalated') return;
    expect(outcome.category).toBe('malformed-model-output');
    expect(outcome.reason).toBe('ladder-exhausted');
    expect(outcome.lastSimulation?.verdict).toBe('fail');
    // Both recovery rungs were attempted; the terminal `escalate` rung is not an attempt.
    expect(outcome.attempts).toBe(2);
    expect(generator.calls).toEqual(['generateCandidate', 'reviseWithFallbackModel']);
  });
});

describe('SelfHealingLoop.heal - escalates when the Session_Budget disallows recovery (Req 8.4)', () => {
  it('takes no recovery attempt and escalates with a budget stop reason', async () => {
    const spec = approvedSpec();
    const generator = new ScriptedRecoveryGenerator({ revise: evalOf(candidate(spec)) });
    const simulator = new ScriptedSimulator([passVerdict()]);
    const { loop } = makeLoop(generator, simulator);

    // A zero-iteration budget can afford nothing: recovery must not even begin.
    const outcome = await loop.heal(
      { source: 'compile', diagnostics: 'unexpected token' },
      contextFor(spec),
      budgetWithIterations(0),
    );

    expect(outcome.status).toBe('escalated');
    if (outcome.status !== 'escalated') return;
    expect(outcome.category).toBe('syntax-error');
    expect(outcome.reason).toBe('budget-exhausted');
    expect(outcome.stopReason).toBe('max-iterations');
    expect(outcome.attempts).toBe(0);
    expect(generator.calls).toEqual([]);
    expect(simulator.calls).toBe(0);
  });
});
