// Unit tests for the sweep engine, driven entirely with fakes: no network, no toolchain,
// no real clock, no disk.
//
// WHAT THESE PIN DOWN
//   1. Every completed sample is APPENDED as it finishes, not buffered to the end.
//   2. A sample already recorded for this config is SKIPPED - no model call, no second
//      record - so a resumed run does not re-pay.
//   3. A sample that throws is recorded as a failed sample and the run CONTINUES.
//   4. Each bound (wall clock, sample cap, provider outage, unwritable log) stops dispatch
//      cleanly with everything already completed still on disk.
//   5. Concurrency never exceeds the configured bound.
//   6. Each sample is driven with the seed the harness derives for its OWN index, which is
//      what makes one-sample scheduling equivalent to running the whole problem.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { SetupFailureCause, VerificationOutcome, VerificationSetupFailed } from '@app/agent';
import {
  makePort,
  newUlid,
  type AcceptanceCriterion,
  type Port,
  type PortDirection,
  type Spec,
} from '@app/core';

import { sampleSeed } from '../reproducibility.js';
import type {
  EvalArtifactDescriptor,
  EvalArtifactSink,
  EvalSampleArtifacts,
} from '../artifact-sink.js';
import type { InstrumentControl, InstrumentControlResult } from '../instrument-control.js';
import type { EvalLoopRunner, EvalSampleRequest } from '../loop-runner.js';
import type { EvalProblem } from '../problem.js';
import { parseSweepConfig } from './config-parse.js';
import type { SweepConfig } from './config.js';
import { SweepKillSwitch, type KillSwitchBounds } from './kill-switch.js';
import {
  CompletedSampleIndex,
  decodeSampleRecord,
  RESULTS_SCHEMA_VERSION,
  type ResultsLogPort,
  type SweepSampleRecord,
} from './results-log.js';
import { SweepRunner } from './runner.js';
import { THROTTLE_GOVERNOR_LIMITS, ThrottleGovernor } from './throttle-governor.js';

/** Build a fixture `Port` through the validating constructor, failing loudly on a bad width. */
function port(name: string, direction: PortDirection, width: number): Port {
  const built = makePort({ name, direction, width });
  if (!built.ok) {
    throw new Error(`invalid fixture port "${name}": ${built.error.message}`);
  }
  return built.value;
}

/** One simulation-verifiable acceptance criterion. */
function criterion(text: string): AcceptanceCriterion {
  return { id: newUlid(), text, measurable: true, method: 'simulation' };
}

/**
 * A minimal approved Spec; the fake runner never reads it, the harness only passes it on.
 *
 * It is nevertheless a fully-formed `Spec` rather than a cast stub, so a change to the
 * model's shape breaks this fixture at compile time instead of at runtime.
 */
function spec(id: string): Spec {
  const moduleName = id.replace(/\W/g, '_');
  return {
    id: newUlid(),
    projectId: newUlid(),
    goal: `Build ${moduleName}.`,
    constraints: ['Purely combinational'],
    moduleInterface: {
      moduleName,
      ports: [port('a', 'input', 1), port('y', 'output', 1)],
      clocking: { clockName: null, resetName: null, resetActiveLow: false },
    },
    acceptanceCriteria: [criterion('the output tracks the input')],
    architecture: 'A single continuous assignment from the input to the output.',
    approved: true,
    version: 1,
  };
}

/** One eval problem. */
function problem(id: string): EvalProblem {
  return { id, title: id, source: 'RTLLM', spec: spec(id), intentSummary: `build ${id}` };
}

/** A validated config over the given arms/problem count knobs. */
function config(overrides: Record<string, unknown> = {}): SweepConfig {
  const parsed = parseSweepConfig({
    schemaVersion: 1,
    runName: 'test-run',
    arms: [{ name: 'armA', model: 'model.a' }],
    problems: { kind: 'all' },
    sampleCount: 2,
    ks: [1],
    seed: 7,
    temperature: 0,
    caps: {
      maxIterations: 4,
      maxTokens: 100_000,
      maxWallClockMs: 100_000,
      maxCostCents: 10_000,
    },
    limits: { cpu: 1, memMb: 64, procs: 8, diskMb: 8, wallMs: 5_000 },
    costEnvelopeCents: 100,
    modelHost: { region: 'us-east-1' },
    outputDir: '.eval-runs/test-run',
    concurrency: 1,
    ...overrides,
  });
  if (!parsed.ok) {
    throw new Error(`fixture config invalid: ${parsed.error.message} (${parsed.error.field})`);
  }
  return parsed.value;
}

/** An in-memory results log that records the order lines arrived in. */
class MemoryResultsLog implements ResultsLogPort {
  readonly lines: string[] = [];
  #failOnAppend = false;

  failNextAppends(): void {
    this.#failOnAppend = true;
  }

  appendLine(line: string): Promise<void> {
    if (this.#failOnAppend) {
      return Promise.reject(new Error('disk full at /private/var/run/results.jsonl'));
    }
    this.lines.push(line);
    return Promise.resolve();
  }

  readAll(): Promise<string> {
    return Promise.resolve(this.lines.join('\n'));
  }

  records(): readonly SweepSampleRecord[] {
    return this.lines
      .map((line) => decodeSampleRecord(JSON.parse(line)))
      .filter((record): record is SweepSampleRecord => record !== null);
  }
}

/** A `verified` outcome shaped only as far as the harness reads it. */
function verifiedOutcome(iterations: number, rtl: string): VerificationOutcome {
  return {
    status: 'verified',
    iterations,
    moduleVersion: { rtl },
  } as unknown as VerificationOutcome;
}

/** A `verified` outcome that also carries the testbench, so the control has an instrument. */
function verifiedWithTestbench(iterations: number, rtl: string): VerificationOutcome {
  return {
    status: 'verified',
    iterations,
    moduleVersion: { rtl },
    testbench: { source: 'module tb; endmodule' },
  } as unknown as VerificationOutcome;
}

/** A control that always returns the same verdict, with no toolchain behind it. */
function fixedControl(verdict: InstrumentControlResult['verdict']): InstrumentControl {
  return {
    check: () => Promise.resolve({ verdict, stdout: '', stderr: '', exitCode: 0, mutation: null }),
  };
}

/**
 * The loop's setup-failure outcome: no candidate, no verdict, and WHY.
 *
 * The cause defaults to a FINDING, so a fixture that only needs "this sample produced no
 * verdict" cannot silently exercise the deferrable branch and make a resume assertion pass
 * for the wrong reason. The deferral tests pass `provider-unreachable` explicitly.
 */
function setupFailedOutcome(
  detail: string,
  cause: SetupFailureCause = 'model-output-unusable',
): VerificationSetupFailed {
  return { status: 'setup-failed', reason: 'generation-unavailable', detail, cause };
}

/**
 * Records every request it saw, and answers per a supplied policy.
 *
 * `inFlightHistory` is the full sequence of in-flight counts observed at every entry and
 * exit, not just the running max: Property 12 needs to check the admission bound at every
 * instant a worker started or finished holding a unit, and the max alone cannot tell a
 * momentary breach from a sustained one.
 */
class SpyLoopRunner implements EvalLoopRunner {
  readonly seen: EvalSampleRequest[] = [];
  readonly inFlightHistory: number[] = [];
  #inFlight = 0;
  maxInFlight = 0;

  constructor(
    private readonly answer: (request: EvalSampleRequest) => Promise<VerificationOutcome>,
  ) {}

  async runSample(request: EvalSampleRequest): Promise<VerificationOutcome> {
    this.seen.push(request);
    this.#inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.#inFlight);
    this.inFlightHistory.push(this.#inFlight);
    try {
      return await this.answer(request);
    } finally {
      this.#inFlight -= 1;
      this.inFlightHistory.push(this.#inFlight);
    }
  }
}

/** An artifact sink that records which arm it was bound to and what it was handed. */
class SpyArtifactSink implements EvalArtifactSink {
  readonly writes: {
    readonly armName: string;
    readonly descriptor: EvalArtifactDescriptor;
    readonly artifacts: EvalSampleArtifacts;
  }[] = [];

  constructor(private readonly armName: string) {}

  write(descriptor: EvalArtifactDescriptor, artifacts: EvalSampleArtifacts): Promise<void> {
    this.writes.push({ armName: this.armName, descriptor, artifacts });
    return Promise.resolve();
  }
}

/** A sink whose every write fails, the way a full disk does. */
class FailingArtifactSink implements EvalArtifactSink {
  calls = 0;

  write(): Promise<void> {
    this.calls += 1;
    return Promise.reject(new Error('ENOSPC: no space left on device, open /var/x/candidate.v'));
  }
}

/** Build a runner over the given fakes; every seam injected. */
function buildRunner(parts: {
  readonly config: SweepConfig;
  readonly problems: readonly EvalProblem[];
  readonly loopRunner: EvalLoopRunner;
  readonly log: MemoryResultsLog;
  readonly completed?: CompletedSampleIndex;
  readonly bounds?: KillSwitchBounds;
  readonly outage?: () => boolean;
  readonly clock?: () => number;
  readonly artifactSinkFor?: (arm: { readonly name: string }) => EvalArtifactSink;
  readonly instrumentControl?: InstrumentControl;
  readonly governor?: ThrottleGovernor;
  readonly waitMs?: (ms: number) => Promise<void>;
}): { readonly runner: SweepRunner; readonly progress: string[] } {
  const progress: string[] = [];
  const clock = parts.clock ?? (() => 0);
  const runner = new SweepRunner({
    config: parts.config,
    configHash: 'cfg-test',
    problems: parts.problems,
    loopRunnerFor: () => parts.loopRunner,
    ...(parts.artifactSinkFor === undefined ? {} : { artifactSinkFor: parts.artifactSinkFor }),
    goldenJudge: null,
    instrumentControl: parts.instrumentControl ?? null,
    resultsLog: parts.log,
    completed: parts.completed ?? CompletedSampleIndex.fromRecords([], 'cfg-test'),
    killSwitch: new SweepKillSwitch(
      parts.bounds ?? { maxWallClockMs: 1_000_000, maxSamples: 1_000 },
      clock,
    ),
    outage: parts.outage ?? ((): boolean => false),
    // Quiet by construction: a governor built from the configured concurrency with no
    // recorded throttle observation always recommends exactly that ceiling (see
    // `ThrottleGovernor.recommendedConcurrency`), so the existing bounded-concurrency
    // tests see no admission gating unless a test opts into a governor of its own.
    governor: parts.governor ?? new ThrottleGovernor(parts.config.concurrency, clock),
    // No real timer in tests: a withheld worker's wait resolves immediately unless a test
    // needs to observe it, matching how `sleep` is faked in transport-retry.test.ts.
    waitMs: parts.waitMs ?? ((): Promise<void> => Promise.resolve()),
    now: clock,
    onProgress: (line) => progress.push(line),
  });
  return { runner, progress };
}

/** A loop runner that always verifies on the first iteration. */
function alwaysVerifies(): SpyLoopRunner {
  return new SpyLoopRunner((request) =>
    Promise.resolve(verifiedOutcome(1, `module ${request.problem.id} endmodule`)),
  );
}

describe('SweepRunner - the plan', () => {
  it('runs every arm x problem x sample exactly once', async () => {
    const problems = [problem('p1'), problem('p2')];
    const loopRunner = alwaysVerifies();
    const log = new MemoryResultsLog();
    const { runner } = buildRunner({
      config: config({
        arms: [
          { name: 'armA', model: 'model.a' },
          { name: 'armB', model: 'model.b' },
        ],
      }),
      problems,
      loopRunner,
      log,
    });
    const result = await runner.run();
    // 2 arms x 2 problems x 2 samples.
    expect(result.plannedSamples).toBe(8);
    expect(result.dispatchedSamples).toBe(8);
    expect(result.recordedSamples).toBe(8);
    expect(result.stopReason).toBe('completed');
    expect(loopRunner.seen).toHaveLength(8);
  });

  it('runs arm-major, so an interrupted campaign leaves complete arms', async () => {
    const log = new MemoryResultsLog();
    const { runner } = buildRunner({
      config: config({
        arms: [
          { name: 'armA', model: 'model.a' },
          { name: 'armB', model: 'model.b' },
        ],
      }),
      problems: [problem('p1')],
      loopRunner: alwaysVerifies(),
      log,
    });
    await runner.run();
    expect(log.records().map((record) => record.armName)).toEqual(['armA', 'armA', 'armB', 'armB']);
  });

  it('drives each sample with the seed derived for its OWN index', async () => {
    const loopRunner = alwaysVerifies();
    const cfg = config();
    const { runner } = buildRunner({
      config: cfg,
      problems: [problem('p1')],
      loopRunner,
      log: new MemoryResultsLog(),
    });
    await runner.run();
    expect(loopRunner.seen.map((request) => request.seed)).toEqual([
      sampleSeed(cfg.reproducibility, 'p1', 0),
      sampleSeed(cfg.reproducibility, 'p1', 1),
    ]);
    expect(loopRunner.seen.map((request) => request.sampleIndex)).toEqual([0, 1]);
  });

  it('threads the configured student caps and sandbox limits into every sample', async () => {
    const loopRunner = alwaysVerifies();
    const cfg = config();
    const { runner } = buildRunner({
      config: cfg,
      problems: [problem('p1')],
      loopRunner,
      log: new MemoryResultsLog(),
    });
    await runner.run();
    for (const request of loopRunner.seen) {
      expect(request.limits).toEqual(cfg.limits);
      expect(request.temperature).toBe(cfg.reproducibility.temperature);
    }
  });
});

describe('SweepRunner - streaming to disk', () => {
  it('appends each record as its sample finishes, not once at the end', async () => {
    const log = new MemoryResultsLog();
    const observed: number[] = [];
    const loopRunner = new SpyLoopRunner(() => {
      observed.push(log.lines.length);
      return Promise.resolve(verifiedOutcome(1, 'module m endmodule'));
    });
    const { runner } = buildRunner({
      config: config(),
      problems: [problem('p1'), problem('p2')],
      loopRunner,
      log,
    });
    await runner.run();
    // Each sample saw the count of lines already durable when it started: 0,1,2,3.
    expect(observed).toEqual([0, 1, 2, 3]);
  });

  it('records the oracle verdict, the iterations, and the seed for each sample', async () => {
    const log = new MemoryResultsLog();
    const { runner } = buildRunner({
      config: config(),
      problems: [problem('p1')],
      loopRunner: new SpyLoopRunner((request) =>
        Promise.resolve(verifiedOutcome(request.sampleIndex + 1, 'module m endmodule')),
      ),
      log,
    });
    await runner.run();
    const records = log.records();
    expect(records.map((record) => record.passed)).toEqual([true, true]);
    expect(records.map((record) => record.iterations)).toEqual([1, 2]);
    expect(records.map((record) => record.outcomeStatus)).toEqual(['verified', 'verified']);
  });

  it('records WHY a no-verdict sample produced none, so a campaign is diagnosable', async () => {
    // Given a host that refuses generation, an hours-long matrix would otherwise persist a
    // wall of `setup-failed` with nothing to act on.
    const log = new MemoryResultsLog();
    const { runner, progress } = buildRunner({
      config: config(),
      problems: [problem('p1')],
      loopRunner: new SpyLoopRunner(() =>
        Promise.resolve(setupFailedOutcome('the model host declined every attempt')),
      ),
      log,
    });

    await runner.run();

    const records = log.records();
    expect(records.map((record) => record.outcomeStatus)).toEqual(['setup-failed', 'setup-failed']);
    expect(records.map((record) => record.failureNote)).toEqual([
      'generation-unavailable: the model host declined every attempt',
      'generation-unavailable: the model host declined every attempt',
    ]);
    // The operator sees the reason DURING the run, not only in the file afterwards.
    expect(progress.some((line) => line.includes('generation-unavailable'))).toBe(true);
  });

  it('records no note for a verified sample, so `null` keeps meaning "nothing to explain"', async () => {
    const log = new MemoryResultsLog();
    const { runner, progress } = buildRunner({
      config: config(),
      problems: [problem('p1')],
      loopRunner: alwaysVerifies(),
      log,
    });

    await runner.run();

    expect(log.records().every((record) => record.failureNote === null)).toBe(true);
    const sampleLines = progress.filter((line) => line.includes('arm=armA'));
    expect(sampleLines).toHaveLength(2);
    // No parenthesized reason is appended when there is nothing to explain; the line ends
    // with the instrument state, which every sample always has.
    expect(sampleLines.every((line) => line.endsWith('instrument=unchecked'))).toBe(true);
    expect(sampleLines.every((line) => line.includes('unjudged'))).toBe(true);
  });

  it('marks cost as unknown when the arm has no configured price', async () => {
    const log = new MemoryResultsLog();
    const { runner } = buildRunner({
      config: config(),
      problems: [problem('p1')],
      loopRunner: alwaysVerifies(),
      log,
    });
    await runner.run();
    expect(log.records().every((record) => !record.costKnown)).toBe(true);
  });

  it('marks cost as known when every model of the arm is priced', async () => {
    const log = new MemoryResultsLog();
    const { runner } = buildRunner({
      config: config({
        prices: { 'model.a': { inputCentsPerMillionTokens: 10, outputCentsPerMillionTokens: 40 } },
      }),
      problems: [problem('p1')],
      loopRunner: alwaysVerifies(),
      log,
    });
    await runner.run();
    expect(log.records().every((record) => record.costKnown)).toBe(true);
  });
});

describe('SweepRunner - per-sample artifact capture', () => {
  /** The already-recorded sample 0 of p1 for this config, used by the resume test. */
  function recordedSampleZero(): SweepSampleRecord {
    return {
      schemaVersion: RESULTS_SCHEMA_VERSION,
      configHash: 'cfg-test',
      armName: 'armA',
      modelSignature: 'model.a',
      problemId: 'p1',
      sampleIndex: 0,
      seed: 1,
      passed: true,
      outcomeStatus: 'verified',
      iterations: 1,
      costCents: 2,
      costKnown: false,
      promptTokens: 100,
      completionTokens: 40,
      totalTokens: 140,
      unreportedUsageCalls: 0,
      stopReason: null,
      goldenVerdict: null,
      goldenFailureCount: null,
      instrumentValidity: 'unchecked',
      instrumentDefect: null,
      mutation: null,
      durationMs: 10,
      completedAtMs: 10,
      failureNote: null,
      // Verified, so no cause: the slot is finished by the strongest evidence there is and
      // resume must skip it. The deferral tests below carry a cause instead.
      noVerdictCause: null,
    };
  }

  it('captures every dispatched sample through the sink bound to its OWN arm', async () => {
    // The harness is never told which arm it is measuring, so the arm binding has to happen
    // here; a capture attributed to the wrong arm would be worse than no capture.
    const sinks = new Map<string, SpyArtifactSink>();
    const { runner } = buildRunner({
      config: config({
        arms: [
          { name: 'armA', model: 'model.a' },
          { name: 'armB', model: 'model.b' },
        ],
        sampleCount: 1,
        ks: [1],
      }),
      problems: [problem('p1')],
      loopRunner: alwaysVerifies(),
      log: new MemoryResultsLog(),
      artifactSinkFor: (arm) => {
        const sink = new SpyArtifactSink(arm.name);
        sinks.set(arm.name, sink);
        return sink;
      },
    });

    await runner.run();

    expect(sinks.get('armA')?.writes.map((written) => written.descriptor.problemId)).toEqual([
      'p1',
    ]);
    expect(sinks.get('armB')?.writes.map((written) => written.armName)).toEqual(['armB']);
    expect(sinks.get('armA')?.writes[0]?.artifacts.candidateRtl?.text).toContain('module p1');
  });

  it('does not touch the artifacts of a sample a previous run already recorded', async () => {
    // Resume safety: a skipped sample is not re-run, so its artifacts are never rewritten -
    // there is no path here that could duplicate or half-overwrite an existing capture.
    const sink = new SpyArtifactSink('armA');
    const { runner } = buildRunner({
      config: config(),
      problems: [problem('p1')],
      loopRunner: alwaysVerifies(),
      log: new MemoryResultsLog(),
      completed: CompletedSampleIndex.fromRecords([recordedSampleZero()], 'cfg-test'),
      artifactSinkFor: () => sink,
    });

    const result = await runner.run();

    expect(result.skippedSamples).toBe(1);
    expect(sink.writes.map((written) => written.descriptor.sampleIndex)).toEqual([1]);
  });

  it('records the sample normally when its artifacts cannot be written', async () => {
    const log = new MemoryResultsLog();
    const sink = new FailingArtifactSink();
    const { runner } = buildRunner({
      config: config(),
      problems: [problem('p1')],
      loopRunner: alwaysVerifies(),
      log,
      artifactSinkFor: () => sink,
    });

    const result = await runner.run();

    expect(sink.calls).toBe(2);
    expect(result.stopReason).toBe('completed');
    expect(result.recordedSamples).toBe(2);
    expect(log.records().every((record) => record.passed)).toBe(true);
  });

  it('records exactly the same lines whether artifacts are captured or not', async () => {
    // Capture is additive: the results file is what a number is cited from, and it must not
    // move because a diagnostic was switched on.
    const cfg = config();
    const withoutLog = new MemoryResultsLog();
    const withLog = new MemoryResultsLog();
    const { runner: without } = buildRunner({
      config: cfg,
      problems: [problem('p1')],
      loopRunner: alwaysVerifies(),
      log: withoutLog,
    });
    const { runner: withCapture } = buildRunner({
      config: cfg,
      problems: [problem('p1')],
      loopRunner: alwaysVerifies(),
      log: withLog,
      artifactSinkFor: (arm) => new SpyArtifactSink(arm.name),
    });

    expect(await without.run()).toEqual(await withCapture.run());
    expect(withLog.records()).toEqual(withoutLog.records());
  });
});

describe('SweepRunner - resume never re-pays', () => {
  it('skips a sample already recorded for this config and never calls the model for it', async () => {
    const loopRunner = alwaysVerifies();
    const log = new MemoryResultsLog();
    const already: SweepSampleRecord = {
      schemaVersion: RESULTS_SCHEMA_VERSION,
      configHash: 'cfg-test',
      armName: 'armA',
      modelSignature: 'model.a',
      problemId: 'p1',
      sampleIndex: 0,
      seed: 1,
      passed: true,
      outcomeStatus: 'verified',
      iterations: 1,
      costCents: 2,
      costKnown: false,
      promptTokens: 100,
      completionTokens: 40,
      totalTokens: 140,
      unreportedUsageCalls: 0,
      stopReason: null,
      goldenVerdict: null,
      goldenFailureCount: null,
      instrumentValidity: 'unchecked',
      instrumentDefect: null,
      mutation: null,
      durationMs: 10,
      completedAtMs: 10,
      failureNote: null,
      // Verified, so no cause: the slot is finished by the strongest evidence there is and
      // resume must skip it. The deferral tests below carry a cause instead.
      noVerdictCause: null,
    };
    const { runner } = buildRunner({
      config: config(),
      problems: [problem('p1')],
      loopRunner,
      log,
      completed: CompletedSampleIndex.fromRecords([already], 'cfg-test'),
    });
    const result = await runner.run();
    expect(result.skippedSamples).toBe(1);
    expect(result.dispatchedSamples).toBe(1);
    expect(loopRunner.seen.map((request) => request.sampleIndex)).toEqual([1]);
    expect(log.lines).toHaveLength(1);
  });

  it('re-runs everything when the recorded samples belong to a DIFFERENT config', async () => {
    const loopRunner = alwaysVerifies();
    const foreign: SweepSampleRecord = {
      schemaVersion: RESULTS_SCHEMA_VERSION,
      configHash: 'another-experiment',
      armName: 'armA',
      modelSignature: 'model.a',
      problemId: 'p1',
      sampleIndex: 0,
      seed: 1,
      passed: true,
      outcomeStatus: 'verified',
      iterations: 1,
      costCents: 2,
      costKnown: false,
      promptTokens: 100,
      completionTokens: 40,
      totalTokens: 140,
      unreportedUsageCalls: 0,
      stopReason: null,
      goldenVerdict: null,
      goldenFailureCount: null,
      instrumentValidity: 'unchecked',
      instrumentDefect: null,
      mutation: null,
      durationMs: 10,
      completedAtMs: 10,
      failureNote: null,
      // Verified, so no cause: the slot is finished by the strongest evidence there is and
      // resume must skip it. The deferral tests below carry a cause instead.
      noVerdictCause: null,
    };
    const { runner } = buildRunner({
      config: config(),
      problems: [problem('p1')],
      loopRunner,
      log: new MemoryResultsLog(),
      completed: CompletedSampleIndex.fromRecords([foreign], 'cfg-test'),
    });
    const result = await runner.run();
    expect(result.skippedSamples).toBe(0);
    expect(result.dispatchedSamples).toBe(2);
  });
});

describe('SweepRunner - fail safe', () => {
  it('records a throwing sample as a failure and keeps going', async () => {
    const log = new MemoryResultsLog();
    const loopRunner = new SpyLoopRunner((request) =>
      request.sampleIndex === 0
        ? Promise.reject(new Error('provider blew up at api.example.com'))
        : Promise.resolve(verifiedOutcome(1, 'module m endmodule')),
    );
    const { runner } = buildRunner({
      config: config(),
      problems: [problem('p1')],
      loopRunner,
      log,
    });
    const result = await runner.run();
    expect(result.recordedSamples).toBe(2);
    expect(result.stopReason).toBe('completed');
    const records = log.records();
    // The harness itself classifies a throwing runner as `runner-error`, a non-pass.
    expect(records[0]?.outcomeStatus).toBe('runner-error');
    expect(records[0]?.passed).toBe(false);
    expect(records[1]?.passed).toBe(true);
  });

  it('never lets a thrown error message reach a persisted record', async () => {
    const log = new MemoryResultsLog();
    const { runner } = buildRunner({
      config: config(),
      problems: [problem('p1')],
      loopRunner: new SpyLoopRunner(() =>
        Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:443 bearer=abc123')),
      ),
      log,
    });
    await runner.run();
    const text = log.lines.join('\n');
    expect(text).not.toContain('ECONNREFUSED');
    expect(text).not.toContain('10.0.0.5');
    expect(text).not.toContain('abc123');
  });

  it('counts a no-verdict sample separately from a measured non-pass', async () => {
    const log = new MemoryResultsLog();
    const { runner } = buildRunner({
      config: config(),
      problems: [problem('p1')],
      loopRunner: new SpyLoopRunner(() => Promise.reject(new Error('boom'))),
      log,
    });
    expect((await runner.run()).failedSamples).toBe(2);
  });
});

describe('SweepRunner - the bounds stop dispatch cleanly', () => {
  it('stops at the sample cap with every completed sample recorded', async () => {
    const log = new MemoryResultsLog();
    const { runner } = buildRunner({
      config: config(),
      problems: [problem('p1'), problem('p2'), problem('p3')],
      loopRunner: alwaysVerifies(),
      log,
      bounds: { maxWallClockMs: 1_000_000, maxSamples: 3 },
    });
    const result = await runner.run();
    expect(result.stopReason).toBe('sample-limit-reached');
    expect(result.dispatchedSamples).toBe(3);
    expect(log.records()).toHaveLength(3);
  });

  it('stops when the wall-clock bound is passed', async () => {
    let clock = 0;
    const log = new MemoryResultsLog();
    const { runner } = buildRunner({
      config: config(),
      problems: [problem('p1'), problem('p2')],
      loopRunner: new SpyLoopRunner(() => {
        clock += 600;
        return Promise.resolve(verifiedOutcome(1, 'module m endmodule'));
      }),
      log,
      bounds: { maxWallClockMs: 1_000, maxSamples: 1_000 },
      clock: () => clock,
    });
    const result = await runner.run();
    expect(result.stopReason).toBe('wall-clock-exhausted');
    expect(result.dispatchedSamples).toBeLessThan(4);
    expect(log.records().length).toBe(result.recordedSamples);
  });

  it('stops on a sustained provider outage rather than filling the matrix with failures', async () => {
    let outage = false;
    const log = new MemoryResultsLog();
    const { runner } = buildRunner({
      config: config(),
      problems: [problem('p1'), problem('p2')],
      loopRunner: new SpyLoopRunner(() => {
        outage = true;
        return Promise.resolve(verifiedOutcome(1, 'module m endmodule'));
      }),
      log,
      outage: () => outage,
    });
    const result = await runner.run();
    expect(result.stopReason).toBe('provider-outage');
    expect(result.dispatchedSamples).toBe(1);
    expect(log.records()).toHaveLength(1);
  });

  it('stops when a record cannot be persisted, rather than paying for lost samples', async () => {
    const log = new MemoryResultsLog();
    log.failNextAppends();
    const { runner } = buildRunner({
      config: config(),
      problems: [problem('p1'), problem('p2')],
      loopRunner: alwaysVerifies(),
      log,
    });
    const result = await runner.run();
    expect(result.stopReason).toBe('results-log-unwritable');
    expect(result.recordedSamples).toBe(0);
  });
});

describe('SweepRunner - bounded concurrency', () => {
  it('never exceeds the configured concurrency', async () => {
    const loopRunner = new SpyLoopRunner(
      () =>
        new Promise<VerificationOutcome>((resolve) => {
          setTimeout(() => resolve(verifiedOutcome(1, 'module m endmodule')), 1);
        }),
    );
    const { runner } = buildRunner({
      config: config({ concurrency: 3, sampleCount: 4, ks: [1] }),
      problems: [problem('p1'), problem('p2'), problem('p3')],
      loopRunner,
      log: new MemoryResultsLog(),
    });
    await runner.run();
    expect(loopRunner.maxInFlight).toBeGreaterThan(1);
    expect(loopRunner.maxInFlight).toBeLessThanOrEqual(3);
  });

  it('runs sequentially at concurrency 1', async () => {
    const loopRunner = new SpyLoopRunner(
      () =>
        new Promise<VerificationOutcome>((resolve) => {
          setTimeout(() => resolve(verifiedOutcome(1, 'module m endmodule')), 1);
        }),
    );
    const { runner } = buildRunner({
      config: config({ concurrency: 1 }),
      problems: [problem('p1'), problem('p2')],
      loopRunner,
      log: new MemoryResultsLog(),
    });
    await runner.run();
    expect(loopRunner.maxInFlight).toBe(1);
  });
});

describe('SweepRunner - throttled admission', () => {
  // Feature: eval-campaign-readiness, Property 12: Admission never exceeds either bound
  // and never starves.
  //
  // Validates: Requirements 7.4, 7.5, 7.6, 7.7, 7.8, 7.9
  //
  // The governor here is a REAL `ThrottleGovernor` over a fake clock, not a structural
  // fake: the class keeps its observation list in a private field, so nothing outside it
  // can report a recommendation the class itself did not derive. Each sample's answer
  // records zero or more throttle observations and advances the clock before resolving,
  // which is what lets one run's recommendation legitimately fall and later recover
  // without a real timer - the same technique `throttle-governor.test.ts` uses, applied
  // here to drive the runner rather than the governor directly.

  /** A mutable clock closure; nothing here waits on a real timer. */
  function fakeClock(startMs = 0): { readonly now: () => number; advance: (ms: number) => void } {
    let clock = startMs;
    return {
      now: () => clock,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  it('never holds more than the lesser of the configured and recommended concurrency, except the never-starve floor, and drops no unit', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 10 }),
        // Per-sample throttle observations, one entry per unit of work; padded/truncated
        // to the actual unit count once it is known below.
        fc.array(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 10 }),
        async (configuredConcurrency, problemCount, throttlesPerSample) => {
          const clock = fakeClock();
          const governor = new ThrottleGovernor(configuredConcurrency, clock.now);
          const problems = Array.from({ length: problemCount }, (_, index) => problem(`p${index}`));
          const checkpoints: { readonly holding: number; readonly recommended: number }[] = [];
          let holding = 0;
          let unitIndex = 0;
          const loopRunner = new SpyLoopRunner(() => {
            holding += 1;
            checkpoints.push({ holding, recommended: governor.recommendedConcurrency() });
            const throttles = throttlesPerSample[unitIndex % throttlesPerSample.length] ?? 0;
            unitIndex += 1;
            for (let i = 0; i < throttles; i += 1) {
              governor.recordThrottle();
            }
            clock.advance(1);
            const outcome = verifiedOutcome(1, 'module m endmodule');
            holding -= 1;
            checkpoints.push({ holding, recommended: governor.recommendedConcurrency() });
            return Promise.resolve(outcome);
          });
          const log = new MemoryResultsLog();
          const { runner } = buildRunner({
            config: config({ concurrency: configuredConcurrency, sampleCount: 1, ks: [1] }),
            problems,
            loopRunner,
            log,
            governor,
            clock: clock.now,
          });

          const result = await runner.run();

          // Property 12, admission bound: at every checkpoint, holding never exceeds the
          // lesser of the two ceilings, EXCEPT the floor case - `holding === 1` is always
          // allowed, because Requirement 7.5 forbids zero admitted workers while work
          // remains, so the floor concedes exactly one worker past a recommendation that
          // would otherwise withhold every worker and deadlock the run.
          for (const checkpoint of checkpoints) {
            const ceiling = Math.max(1, Math.min(configuredConcurrency, checkpoint.recommended));
            expect(checkpoint.holding).toBeLessThanOrEqual(ceiling);
          }

          // Property 12, never-starves: every planned unit was dispatched and recorded -
          // the pool never sat with nothing admitted while units remained.
          expect(result.plannedSamples).toBe(problemCount);
          expect(result.dispatchedSamples).toBe(problemCount);
          expect(result.recordedSamples).toBe(problemCount);
          expect(result.stopReason).toBe('completed');
        },
      ),
      { numRuns: 50 },
    );
  });

  // Feature: eval-campaign-readiness, Property 13: A reduced recommendation loses no
  // unit of work.
  //
  // Validates: Requirements 7.7, 7.8

  it('dispatches and records every unit exactly once regardless of how the recommendation moves', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 2, max: 8 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }),
        async (configuredConcurrency, problemCount, throttleAtSample) => {
          const clock = fakeClock();
          const governor = new ThrottleGovernor(configuredConcurrency, clock.now);
          const problems = Array.from({ length: problemCount }, (_, index) => problem(`p${index}`));
          const seenProblemIds: string[] = [];
          let sampleIndex = 0;
          const loopRunner = new SpyLoopRunner((request) => {
            seenProblemIds.push(request.problem.id);
            const shouldThrottle = throttleAtSample[sampleIndex % throttleAtSample.length] ?? false;
            sampleIndex += 1;
            if (shouldThrottle) {
              governor.recordThrottle();
            }
            return Promise.resolve(verifiedOutcome(1, `module ${request.problem.id} endmodule`));
          });
          const log = new MemoryResultsLog();
          const { runner } = buildRunner({
            config: config({ concurrency: configuredConcurrency, sampleCount: 1, ks: [1] }),
            problems,
            loopRunner,
            log,
            governor,
            clock: clock.now,
          });

          const result = await runner.run();

          // No unit silently skipped: the set of problems the loop runner actually saw is
          // exactly the planned set, with no duplicate and no omission, and every one of
          // them made it to disk.
          expect(seenProblemIds.slice().sort()).toEqual(
            problems
              .map((p) => p.id)
              .slice()
              .sort(),
          );
          expect(result.dispatchedSamples).toBe(problemCount);
          expect(result.recordedSamples).toBe(problemCount);
          expect(log.records()).toHaveLength(problemCount);
          // A reduced recommendation is never itself a failure (Requirement 7.8): nothing
          // here throttled the SAMPLE, only the governor's bookkeeping, so every record is
          // a pass.
          expect(log.records().every((record) => record.passed)).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('completes every unit one at a time when the recommendation is pinned at 1 throughout, and the progress line names the reduced recommendation', async () => {
    // Deterministic by design, not a property: forcing every random run to land on the
    // tightest possible pin - recommendation stuck at 1 under a configured concurrency
    // greater than 1 - for the whole run is exactly the edge case a generator would only
    // reach by chance. This proves it directly instead.
    const clock = fakeClock();
    const configuredConcurrency = 3;
    const governor = new ThrottleGovernor(configuredConcurrency, clock.now);
    // Saturate the window once, up front, and never let it age out: every sample's
    // answer re-records enough throttles to keep the recommendation floored at 1 for the
    // whole run, which is what "pinned" means here.
    const saturating =
      THROTTLE_GOVERNOR_LIMITS.observationsPerStep * THROTTLE_GOVERNOR_LIMITS.maxMultiplier;
    for (let i = 0; i < saturating; i += 1) {
      governor.recordThrottle();
    }
    expect(governor.recommendedConcurrency()).toBe(1);

    const problems = [problem('p1'), problem('p2'), problem('p3'), problem('p4')];
    const loopRunner = new SpyLoopRunner(() => {
      // Re-record on every sample so the pin survives however far the clock moves.
      for (let i = 0; i < saturating; i += 1) {
        governor.recordThrottle();
      }
      return Promise.resolve(verifiedOutcome(1, 'module m endmodule'));
    });
    const log = new MemoryResultsLog();
    const { runner, progress } = buildRunner({
      config: config({ concurrency: configuredConcurrency, sampleCount: 1, ks: [1] }),
      problems,
      loopRunner,
      log,
      governor,
      clock: clock.now,
    });

    const result = await runner.run();

    expect(result.stopReason).toBe('completed');
    expect(result.dispatchedSamples).toBe(4);
    expect(result.recordedSamples).toBe(4);
    expect(loopRunner.maxInFlight).toBe(1);
    expect(log.records()).toHaveLength(4);
    expect(log.records().every((record) => record.passed)).toBe(true);
    // The operator sees the reduced recommendation as it happens, not only in the summary.
    expect(progress.some((line) => line.includes('recommended concurrency 1'))).toBe(true);
  });
});

describe('SweepRunner - the positive control is recorded, never inferred', () => {
  /** A loop runner that verifies AND produces a testbench, so the control has an instrument. */
  function verifiesWithTestbench(): SpyLoopRunner {
    return new SpyLoopRunner((request) =>
      Promise.resolve(verifiedWithTestbench(1, `module ${request.problem.id} endmodule`)),
    );
  }

  it('records validity and no defect when the reference passes our testbench', async () => {
    const log = new MemoryResultsLog();
    const { runner } = buildRunner({
      config: config(),
      problems: [problem('p1')],
      loopRunner: verifiesWithTestbench(),
      log,
      instrumentControl: fixedControl({ validity: 'valid' }),
    });

    await runner.run();

    expect(log.records().map((record) => record.instrumentValidity)).toEqual(['valid', 'valid']);
    expect(log.records().every((record) => record.instrumentDefect === null)).toBe(true);
  });

  it('records the defect code so compile-versus-fail survives into the results file', async () => {
    const log = new MemoryResultsLog();
    const { runner, progress } = buildRunner({
      config: config(),
      problems: [problem('p1')],
      loopRunner: verifiesWithTestbench(),
      log,
      instrumentControl: fixedControl({
        validity: 'invalid',
        defect: 'TESTBENCH_REFERENCE_UNBUILDABLE',
      }),
    });

    await runner.run();

    const first = log.records()[0];
    expect(first?.instrumentValidity).toBe('invalid');
    expect(first?.instrumentDefect).toBe('TESTBENCH_REFERENCE_UNBUILDABLE');
    // An operator watching a multi-hour run must see it as it happens.
    expect(progress.join('\n')).toContain('INSTRUMENT-INVALID(TESTBENCH_REFERENCE_UNBUILDABLE)');
  });

  it('records unchecked, not valid, when no control is wired at all', async () => {
    const log = new MemoryResultsLog();
    const { runner } = buildRunner({
      config: config(),
      problems: [problem('p1')],
      loopRunner: verifiesWithTestbench(),
      log,
    });

    await runner.run();

    expect(log.records().map((record) => record.instrumentValidity)).toEqual([
      'unchecked',
      'unchecked',
    ]);
  });

  it('records unchecked when the loop produced no testbench to validate', async () => {
    const log = new MemoryResultsLog();
    const { runner } = buildRunner({
      config: config(),
      problems: [problem('p1')],
      // Verifies but carries no testbench, so there is no instrument to put under control.
      loopRunner: alwaysVerifies(),
      log,
      instrumentControl: fixedControl({ validity: 'valid' }),
    });

    await runner.run();

    expect(log.records().map((record) => record.instrumentValidity)).toEqual([
      'unchecked',
      'unchecked',
    ]);
  });

  it('degrades to unchecked and keeps the campaign running when the control throws', async () => {
    const log = new MemoryResultsLog();
    const throwing: InstrumentControl = {
      check: () => Promise.reject(new Error('worker died at /private/var/tmp/ctl')),
    };
    const { runner } = buildRunner({
      config: config(),
      problems: [problem('p1'), problem('p2')],
      loopRunner: verifiesWithTestbench(),
      log,
      instrumentControl: throwing,
    });

    const result = await runner.run();

    expect(result.stopReason).toBe('completed');
    expect(result.recordedSamples).toBe(4);
    // The loop's own verdict is untouched; only the instrument stays unproven.
    expect(log.records().every((record) => record.passed)).toBe(true);
    expect(log.records().every((record) => record.instrumentValidity === 'unchecked')).toBe(true);
    // Nothing from the thrown error reaches the persisted record.
    expect(log.lines.join('\n')).not.toContain('/private/var/tmp');
  });

  it('leaves the loop verdict, iterations and cost identical whatever the control says', async () => {
    const withoutLog = new MemoryResultsLog();
    const withLog = new MemoryResultsLog();
    const { runner: uncontrolled } = buildRunner({
      config: config(),
      problems: [problem('p1')],
      loopRunner: verifiesWithTestbench(),
      log: withoutLog,
    });
    const { runner: controlled } = buildRunner({
      config: config(),
      problems: [problem('p1')],
      loopRunner: verifiesWithTestbench(),
      log: withLog,
      instrumentControl: fixedControl({
        validity: 'invalid',
        defect: 'TESTBENCH_FAILED_REFERENCE',
      }),
    });

    await uncontrolled.run();
    await controlled.run();

    // Every MEASURED field matches; only the instrument fields differ, which is the proof
    // that a deterministic control cannot perturb a measured number.
    const measured = (record: SweepSampleRecord): unknown => ({
      passed: record.passed,
      outcomeStatus: record.outcomeStatus,
      iterations: record.iterations,
      costCents: record.costCents,
      seed: record.seed,
      stopReason: record.stopReason,
    });
    expect(withLog.records().map(measured)).toEqual(withoutLog.records().map(measured));
  });
});
