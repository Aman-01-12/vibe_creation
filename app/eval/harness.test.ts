// Unit tests for the Eval_Harness (task 19.3).
//
// Driven through a FAKE EvalLoopRunner (no provider SDK, no real oracle - those are
// task 19.4's integration concern), these examples pin down the behaviors Req 15.1,
// 15.2, 15.3, 15.5, 15.6, 15.10, and 17.3 demand: pass@k / iterations-to-pass /
// per-session cost computed from oracle-decided outcomes, the pennies-per-session
// cost envelope, reproducibility across two runs, the student-caps budget threaded
// unchanged, fail-safe handling of a throwing runner, recording of each run, and
// up-front config validation.

import { describe, expect, it } from 'vitest';

import type { SetupFailureCause, VerificationOutcome, VerificationSetupFailed } from '@app/agent';
import type { ResourceLimits } from '@app/tools';

import {
  ARTIFACT_CAPS,
  type EvalArtifactDescriptor,
  type EvalArtifactSink,
  type EvalSampleArtifacts,
} from './artifact-sink.js';
import { createEvalHarness, type EvalHarnessDeps } from './harness.js';
import {
  makeReproducibilityConfig,
  sampleSeed,
  type ReproducibilityConfig,
} from './reproducibility.js';
import { FIXED_EVAL_SUBSET } from './subset.js';
import type { EvalLoopRunner, EvalSampleRequest, StudentSessionCaps } from './loop-runner.js';
import type { EvalRunRecorder, EvalRunReport } from './report.js';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5000 };

const CAPS: StudentSessionCaps = {
  maxIterations: 20,
  maxTokens: 1_000_000,
  maxWallClockMs: 1_000_000,
  maxCostCents: 1_000_000,
};

/** One sample's scripted result: pass/fail with iterations and cost, a setup failure, or a throw. */
type Decision =
  | { readonly kind: 'pass' | 'fail'; readonly iterations: number; readonly costCents: number }
  | { readonly kind: 'setup-failed'; readonly detail: string }
  /** Return a caller-supplied outcome verbatim, for the evidence the artifacts capture. */
  | { readonly kind: 'outcome'; readonly outcome: VerificationOutcome }
  | { readonly kind: 'throw' };

/** Build a minimal VerificationOutcome carrying only the fields the harness reads. */
function outcome(status: 'verified' | 'unverified', iterations: number): VerificationOutcome {
  return { status, iterations } as unknown as VerificationOutcome;
}

/**
 * The loop's setup-failure outcome, fully typed: reason, sanitized detail, and CAUSE.
 *
 * The cause defaults to a FINDING (`model-output-unusable`) rather than to the
 * infrastructure reading, so a fixture that does not care cannot accidentally assert the
 * deferrable branch; the tests that care pass it explicitly.
 */
function setupFailedOutcome(
  detail: string,
  cause: SetupFailureCause = 'model-output-unusable',
): VerificationSetupFailed {
  return { status: 'setup-failed', reason: 'generation-unavailable', detail, cause };
}

/** One per-check verdict, as a simulation reports it. */
interface CheckFixture {
  readonly name: string;
  readonly passed: boolean;
}

/** The oracle-run evidence a terminal outcome carries. */
interface SimulationFixture {
  readonly verdict: 'pass' | 'fail' | 'error';
  readonly checks: readonly CheckFixture[];
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * A `verified` outcome carrying the evidence the artifact capture reads.
 *
 * Cast rather than fully constructed because the real outcome also carries a Trust_Labeler
 * label, a recorded `VerificationResult`, and an oracle span id that this test neither
 * supplies nor asserts on; the fields below are exactly the ones capture reads.
 */
function verifiedWithEvidence(parts: {
  readonly rtl: string;
  readonly testbench: string;
  readonly simulation: SimulationFixture;
}): VerificationOutcome {
  return {
    status: 'verified',
    iterations: 1,
    moduleVersion: { rtl: parts.rtl },
    testbench: { source: parts.testbench },
    simulation: { ...parts.simulation, exitCode: 0 },
  } as unknown as VerificationOutcome;
}

/** An `unverified` outcome carrying the last candidate, the failing case, and the run's output. */
function unverifiedWithEvidence(parts: {
  readonly rtl: string;
  readonly testbench: string;
  readonly simulation: SimulationFixture;
  readonly failingCase: Record<string, unknown> | null;
}): VerificationOutcome {
  return {
    status: 'unverified',
    iterations: 6,
    candidate: { rtl: parts.rtl },
    testbench: { source: parts.testbench },
    simulation: { ...parts.simulation, exitCode: 1 },
    failingCase: parts.failingCase,
    stopReason: 'max-iterations',
  } as unknown as VerificationOutcome;
}

/** A sink that keeps everything it was handed, so a test can assert on the capture. */
class CapturingArtifactSink implements EvalArtifactSink {
  readonly writes: {
    readonly descriptor: EvalArtifactDescriptor;
    readonly artifacts: EvalSampleArtifacts;
  }[] = [];

  write(descriptor: EvalArtifactDescriptor, artifacts: EvalSampleArtifacts): Promise<void> {
    this.writes.push({ descriptor, artifacts });
    return Promise.resolve();
  }
}

/** A sink that always fails, the way a full disk or a read-only mount does. */
class ThrowingArtifactSink implements EvalArtifactSink {
  calls = 0;

  write(): Promise<void> {
    this.calls += 1;
    return Promise.reject(
      new Error('ENOSPC: no space left on device, open /private/var/run/x/candidate.v'),
    );
  }
}

/** The first problem of the fixed subset, failing loudly if the subset is empty. */
function firstProblem() {
  const problem = FIXED_EVAL_SUBSET[0];
  if (problem === undefined) throw new Error('subset is empty');
  return problem;
}

/** A deterministic fake loop runner scripted by a per-request decision function. */
class FakeLoopRunner implements EvalLoopRunner {
  readonly calls: EvalSampleRequest[] = [];
  readonly #decide: (request: EvalSampleRequest) => Decision;

  constructor(decide: (request: EvalSampleRequest) => Decision) {
    this.#decide = decide;
  }

  runSample(request: EvalSampleRequest): Promise<VerificationOutcome> {
    this.calls.push(request);
    const decision = this.#decide(request);
    if (decision.kind === 'throw') {
      return Promise.reject(new Error('sandbox contract failure'));
    }
    if (decision.kind === 'setup-failed') {
      return Promise.resolve(setupFailedOutcome(decision.detail));
    }
    if (decision.kind === 'outcome') {
      return Promise.resolve(decision.outcome);
    }
    request.budget.charge({ tokens: 1, costCents: decision.costCents, wallClockMs: 1 });
    return Promise.resolve(
      outcome(decision.kind === 'pass' ? 'verified' : 'unverified', decision.iterations),
    );
  }
}

/** A recorder that captures the reports it is handed. */
class CapturingRecorder implements EvalRunRecorder {
  readonly recorded: EvalRunReport[] = [];
  record(report: EvalRunReport): Promise<void> {
    this.recorded.push(report);
    return Promise.resolve();
  }
}

function config(overrides: Partial<ReproducibilityConfig> = {}): ReproducibilityConfig {
  const built = makeReproducibilityConfig({
    seed: 42,
    temperature: 0,
    sampleCount: 4,
    ...overrides,
  });
  if (!built.ok) {
    throw new Error(built.error.message);
  }
  return built.value;
}

function harness(overrides: Partial<EvalHarnessDeps> & { readonly loopRunner: EvalLoopRunner }) {
  const built = createEvalHarness({
    caps: CAPS,
    limits: LIMITS,
    config: config(),
    costEnvelopeCents: 5,
    ...overrides,
  });
  if (!built.ok) {
    throw new Error(built.error.code);
  }
  return built.value;
}

describe('EvalHarness.run - pass@k, iterations-to-pass, and cost (Req 15.2)', () => {
  it('computes oracle-decided pass@k, iterations-to-pass, and per-session cost', async () => {
    // Pass samples 1 and 3 of 4; passing runs take 5 iterations, failing 3.
    const runner = new FakeLoopRunner((request) =>
      request.sampleIndex % 2 === 1
        ? { kind: 'pass', iterations: 5, costCents: 3 }
        : { kind: 'fail', iterations: 3, costCents: 3 },
    );
    const problem = FIXED_EVAL_SUBSET[0];
    if (problem === undefined) throw new Error('subset is empty');
    const evalHarness = harness({
      loopRunner: runner,
      config: config({ sampleCount: 4 }),
      ks: [1, 4],
    });

    const report = await evalHarness.run([problem]);
    const result = report.problems[0];
    if (result === undefined) throw new Error('no problem result');

    expect(result.passCount).toBe(2);
    expect(result.passAtK[1]).toBeCloseTo(0.5, 12);
    expect(result.passAtK[4]).toBe(1);
    expect(result.iterationsToPass).toBe(5);
    expect(result.maxCostCents).toBe(3);
    expect(result.samples.map((sample) => sample.passed)).toEqual([false, true, false, true]);
    expect(result.samples.every((sample) => sample.costCents === 3)).toBe(true);
    expect(report.aggregatePassAtK[1]).toBeCloseTo(0.5, 12);
  });

  it('carries the MEASURED token counts, not just the rate-card cost, onto each sample', async () => {
    // Cost in cents needs an external price table; the token counts do not. The harness
    // used to meter tokens and then discard them at this boundary, which left an unpriced
    // campaign with no cost metric at all.
    class MeteringRunner implements EvalLoopRunner {
      runSample(request: EvalSampleRequest): Promise<VerificationOutcome> {
        // A metered model call, a model call the provider said nothing about, and a
        // simulate step that genuinely spent no tokens.
        request.budget.charge({
          tokens: 1_500,
          costCents: 1,
          wallClockMs: 10,
          tokenUsage: { kind: 'reported', promptTokens: 1_200, completionTokens: 300 },
        });
        request.budget.charge({
          tokens: 0,
          costCents: 0,
          wallClockMs: 5,
          tokenUsage: { kind: 'unreported' },
        });
        request.budget.charge({ tokens: 0, costCents: 0, wallClockMs: 20 });
        return Promise.resolve(outcome('verified', 1));
      }
    }
    const evalHarness = harness({
      loopRunner: new MeteringRunner(),
      config: config({ sampleCount: 1 }),
      ks: [1],
    });

    const report = await evalHarness.run([firstProblem()]);
    const sample = report.problems[0]?.samples[0];

    expect(sample?.promptTokens).toBe(1_200);
    expect(sample?.completionTokens).toBe(300);
    expect(sample?.totalTokens).toBe(1_500);
    // The silent call is counted, and the simulate step is not: the third charge spent zero
    // tokens and that is a measurement, not a gap.
    expect(sample?.unreportedUsageCalls).toBe(1);
  });

  it('reports iterationsToPass as null when no sample passes', async () => {
    const runner = new FakeLoopRunner(() => ({ kind: 'fail', iterations: 2, costCents: 1 }));
    const problem = FIXED_EVAL_SUBSET[0];
    if (problem === undefined) throw new Error('subset is empty');
    const evalHarness = harness({
      loopRunner: runner,
      config: config({ sampleCount: 3 }),
      ks: [1],
    });

    const report = await evalHarness.run([problem]);
    expect(report.problems[0]?.iterationsToPass).toBeNull();
    expect(report.problems[0]?.passCount).toBe(0);
  });
});

describe('EvalHarness.run - reproducibility (Req 15.10)', () => {
  it('produces byte-identical reports across two runs of the same subset and config', async () => {
    const decide = (request: EvalSampleRequest): Decision =>
      request.seed % 2 === 0
        ? { kind: 'pass', iterations: 4, costCents: 2 }
        : { kind: 'fail', iterations: 6, costCents: 2 };

    const first = await harness({ loopRunner: new FakeLoopRunner(decide) }).run(FIXED_EVAL_SUBSET);
    const second = await harness({ loopRunner: new FakeLoopRunner(decide) }).run(FIXED_EVAL_SUBSET);

    expect(first).toEqual(second);
  });
});

describe('EvalHarness.run - student caps and threading (Req 15.6, 17.3)', () => {
  it('threads the fixed temperature, derived seed, and sandbox limits into every sample', async () => {
    const runner = new FakeLoopRunner(() => ({ kind: 'pass', iterations: 1, costCents: 1 }));
    const problem = FIXED_EVAL_SUBSET[0];
    if (problem === undefined) throw new Error('subset is empty');
    const cfg = config({ sampleCount: 2, temperature: 0.5 });
    await harness({ loopRunner: runner, config: cfg, ks: [1] }).run([problem]);

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls.every((call) => call.limits === LIMITS)).toBe(true);
    expect(runner.calls.every((call) => call.temperature === 0.5)).toBe(true);
    expect(runner.calls[0]?.seed).toBe(sampleSeed(cfg, problem.id, 0));
  });

  it('runs each sample under the student iteration cap and records the stop reason', async () => {
    // maxIterations 1: the single charge inside the runner trips the cap.
    const runner = new FakeLoopRunner(() => ({ kind: 'fail', iterations: 1, costCents: 1 }));
    const problem = FIXED_EVAL_SUBSET[0];
    if (problem === undefined) throw new Error('subset is empty');
    const evalHarness = harness({
      loopRunner: runner,
      caps: { ...CAPS, maxIterations: 1 },
      config: config({ sampleCount: 1 }),
      ks: [1],
    });

    const report = await evalHarness.run([problem]);
    expect(report.problems[0]?.samples[0]?.stopReason).toBe('max-iterations');
  });
});

describe('EvalHarness.run - cost envelope (Req 15.6, 17.3)', () => {
  it('flags a session that breaches the pennies-per-session envelope', async () => {
    const runner = new FakeLoopRunner(() => ({ kind: 'pass', iterations: 1, costCents: 10 }));
    const problem = FIXED_EVAL_SUBSET[0];
    if (problem === undefined) throw new Error('subset is empty');
    const evalHarness = harness({
      loopRunner: runner,
      config: config({ sampleCount: 1 }),
      ks: [1],
      costEnvelopeCents: 5,
    });

    const report = await evalHarness.run([problem]);
    expect(report.costEnvelope.withinEnvelope).toBe(false);
    expect(report.costEnvelope.maxObservedCents).toBe(10);
    expect(report.costEnvelope.violations).toHaveLength(1);
  });

  it('reports the envelope as held when every session stays within it', async () => {
    const runner = new FakeLoopRunner(() => ({ kind: 'pass', iterations: 1, costCents: 2 }));
    const report = await harness({
      loopRunner: runner,
      config: config({ sampleCount: 2 }),
      ks: [1],
    }).run(FIXED_EVAL_SUBSET);
    expect(report.costEnvelope.withinEnvelope).toBe(true);
  });
});

describe('EvalHarness.run - fail safe and recording (Req 15.5)', () => {
  it('classifies a throwing runner as runner-error without aborting the run', async () => {
    const runner = new FakeLoopRunner(() => ({ kind: 'throw' }));
    const problem = FIXED_EVAL_SUBSET[0];
    if (problem === undefined) throw new Error('subset is empty');
    const report = await harness({
      loopRunner: runner,
      config: config({ sampleCount: 2 }),
      ks: [1],
    }).run([problem]);

    const sample = report.problems[0]?.samples[0];
    expect(sample?.outcomeStatus).toBe('runner-error');
    expect(sample?.passed).toBe(false);
    expect(sample?.iterations).toBe(0);
    // The thrown detail is never read, so there is no note it could be leaked through.
    expect(sample?.failureNote).toBeNull();
    expect(report.problems[0]?.passCount).toBe(0);
  });

  it('records WHY a sample produced no verdict, so a setup failure is diagnosable', async () => {
    // Given a loop that cannot obtain a candidate, the outcome's reason and detail are the
    // only account of the failure - keeping just the status makes a whole run opaque.
    const runner = new FakeLoopRunner(() => ({
      kind: 'setup-failed',
      detail: 'the model host declined every attempt',
    }));
    const problem = FIXED_EVAL_SUBSET[0];
    if (problem === undefined) throw new Error('subset is empty');

    const report = await harness({
      loopRunner: runner,
      config: config({ sampleCount: 1 }),
      ks: [1],
    }).run([problem]);

    const sample = report.problems[0]?.samples[0];
    expect(sample?.outcomeStatus).toBe('setup-failed');
    expect(sample?.failureNote).toBe(
      'generation-unavailable: the model host declined every attempt',
    );
  });

  it('records no note for a verified sample, because there is nothing to explain', async () => {
    const runner = new FakeLoopRunner(() => ({ kind: 'pass', iterations: 1, costCents: 1 }));
    const problem = FIXED_EVAL_SUBSET[0];
    if (problem === undefined) throw new Error('subset is empty');

    const report = await harness({
      loopRunner: runner,
      config: config({ sampleCount: 1 }),
      ks: [1],
    }).run([problem]);

    expect(report.problems[0]?.samples[0]?.failureNote).toBeNull();
  });

  it('records the run through the injected recorder', async () => {
    const runner = new FakeLoopRunner(() => ({ kind: 'pass', iterations: 1, costCents: 1 }));
    const recorder = new CapturingRecorder();
    const report = await harness({
      loopRunner: runner,
      config: config({ sampleCount: 1 }),
      ks: [1],
      recorder,
    }).run(FIXED_EVAL_SUBSET);

    expect(recorder.recorded).toHaveLength(1);
    expect(recorder.recorded[0]).toBe(report);
  });
});

describe('EvalHarness.run - per-sample artifact capture', () => {
  /** Run one sample of one problem through the given runner, capturing its artifacts. */
  async function captureOne(
    runner: EvalLoopRunner,
    sink: CapturingArtifactSink,
  ): Promise<EvalSampleArtifacts> {
    await harness({
      loopRunner: runner,
      config: config({ sampleCount: 1 }),
      ks: [1],
      artifactSink: sink,
    }).run([firstProblem()]);
    const written = sink.writes[0];
    if (written === undefined) throw new Error('no artifacts were captured');
    return written.artifacts;
  }

  it('captures the candidate RTL, our testbench, and the per-check verdicts of a verified sample', async () => {
    // Given a sample the oracle passed, the artifacts must still hold both inputs: a
    // campaign compares passing and failing candidates, and only one side being kept makes
    // the comparison impossible.
    const runner = new FakeLoopRunner(() => ({
      kind: 'outcome',
      outcome: verifiedWithEvidence({
        rtl: 'module shifter(input a, output y); assign y = a; endmodule',
        testbench: 'module shifter_tb; initial $display("CHECK shift PASS"); endmodule',
        simulation: {
          verdict: 'pass',
          checks: [
            { name: 'shift', passed: true },
            { name: 'reset', passed: true },
          ],
          stdout: 'CHECK shift PASS\nCHECK reset PASS\n',
          stderr: '',
        },
      }),
    }));
    const sink = new CapturingArtifactSink();

    const artifacts = await captureOne(runner, sink);

    expect(artifacts.outcomeStatus).toBe('verified');
    expect(artifacts.passed).toBe(true);
    expect(artifacts.candidateRtl?.text).toContain('assign y = a');
    expect(artifacts.testbenchSource?.text).toContain('shifter_tb');
    expect(artifacts.simulation?.verdict).toBe('pass');
    expect(artifacts.simulation?.checks).toEqual([
      { name: 'shift', passed: true },
      { name: 'reset', passed: true },
    ]);
    expect(artifacts.simulation?.stdout?.text).toContain('CHECK shift PASS');
    // An empty stream is absent, not a blank artifact.
    expect(artifacts.simulation?.stderr).toBeNull();
    expect(artifacts.failingCase).toBeNull();
  });

  it('identifies the sample by problem id, index, and seed, without inventing an arm', async () => {
    const runner = new FakeLoopRunner(() => ({ kind: 'pass', iterations: 1, costCents: 1 }));
    const sink = new CapturingArtifactSink();
    const cfg = config({ sampleCount: 2 });
    const problem = firstProblem();

    await harness({ loopRunner: runner, config: cfg, ks: [1], artifactSink: sink }).run([problem]);

    expect(sink.writes.map((written) => written.descriptor)).toEqual([
      { problemId: problem.id, sampleIndex: 0, seed: sampleSeed(cfg, problem.id, 0) },
      { problemId: problem.id, sampleIndex: 1, seed: sampleSeed(cfg, problem.id, 1) },
    ]);
  });

  it('captures which checks FAILED and the localized failing case of an unverified sample', async () => {
    // This is the case the smoke sweep could not explain: our own testbench rejected a
    // candidate the independent judge passed, and the record could not say which check did it.
    const runner = new FakeLoopRunner(() => ({
      kind: 'outcome',
      outcome: unverifiedWithEvidence({
        rtl: 'module m(input clk, output q); endmodule',
        testbench: 'module m_tb; endmodule',
        simulation: {
          verdict: 'fail',
          checks: [
            { name: 'reset_clears_output', passed: true },
            { name: 'shift_by_three', passed: false },
          ],
          stdout: 'CHECK reset_clears_output PASS\nCHECK shift_by_three FAIL\n',
          stderr: 'Test failed: expected 8b00000111',
        },
        failingCase: {
          checkName: 'shift_by_three',
          description: 'Spec-derived check "shift_by_three" did not pass.',
          expected: 'the check to report PASS',
          observed: 'the check reported FAIL',
          atSimTimeNs: 40,
        },
      }),
    }));

    const artifacts = await captureOne(runner, new CapturingArtifactSink());

    expect(artifacts.outcomeStatus).toBe('unverified');
    expect(artifacts.passed).toBe(false);
    expect(artifacts.simulation?.verdict).toBe('fail');
    expect(
      artifacts.simulation?.checks.filter((check) => !check.passed).map((check) => check.name),
    ).toEqual(['shift_by_three']);
    expect(artifacts.simulation?.checksTruncated).toBe(false);
    expect(artifacts.simulation?.stderr?.text).toContain('expected 8b00000111');
    expect(artifacts.failingCase?.checkName).toBe('shift_by_three');
    expect(artifacts.failingCase?.atSimTimeNs).toBe(40);
    expect(artifacts.candidateRtl?.text).toContain('module m(');
  });

  it('records the absent evidence of a setup-failed sample as absent, not as empty', async () => {
    // A setup failure produced no RTL, no testbench, and no simulation. Empty strings here
    // would read as "the model wrote nothing", which is a different and wrong story.
    const runner = new FakeLoopRunner(() => ({
      kind: 'setup-failed',
      detail: 'the model host declined every attempt',
    }));

    const artifacts = await captureOne(runner, new CapturingArtifactSink());

    expect(artifacts.outcomeStatus).toBe('setup-failed');
    expect(artifacts.candidateRtl).toBeNull();
    expect(artifacts.testbenchSource).toBeNull();
    expect(artifacts.simulation).toBeNull();
    expect(artifacts.failingCase).toBeNull();
    // The one thing a no-verdict sample CAN say is why, so that must survive.
    expect(artifacts.failureNote).toBe(
      'generation-unavailable: the model host declined every attempt',
    );
  });

  it('records the absent evidence of a blocked sample, keeping the refusal reason', async () => {
    const runner = new FakeLoopRunner(() => ({
      kind: 'outcome',
      outcome: {
        status: 'blocked',
        refusal: { reason: 'spec-unapproved', message: 'never approved' },
      } as unknown as VerificationOutcome,
    }));

    const artifacts = await captureOne(runner, new CapturingArtifactSink());

    expect(artifacts.outcomeStatus).toBe('blocked');
    expect(artifacts.candidateRtl).toBeNull();
    expect(artifacts.testbenchSource).toBeNull();
    expect(artifacts.simulation).toBeNull();
    expect(artifacts.failureNote).toContain('spec-unapproved');
  });

  it('keeps the HEAD of an over-long source and marks it truncated', async () => {
    // The module header and port list identify a candidate, so the head is the useful end.
    const filler = 'x'.repeat(ARTIFACT_CAPS.maxSourceChars);
    const runner = new FakeLoopRunner(() => ({
      kind: 'outcome',
      outcome: verifiedWithEvidence({
        rtl: `HEAD${filler}TAIL`,
        testbench: 'module m_tb; endmodule',
        simulation: { verdict: 'pass', checks: [], stdout: '', stderr: '' },
      }),
    }));

    const captured = (await captureOne(runner, new CapturingArtifactSink())).candidateRtl;

    expect(captured?.truncated).toBe(true);
    expect(captured?.text).toHaveLength(ARTIFACT_CAPS.maxSourceChars);
    expect(captured?.originalChars).toBe(filler.length + 'HEADTAIL'.length);
    expect(captured?.keptEnd).toBe('head');
    expect(captured?.text.startsWith('HEAD')).toBe(true);
    expect(captured?.text.endsWith('TAIL')).toBe(false);
  });

  it('keeps the TAIL of over-long simulator output, because the error is at the end', async () => {
    const filler = 'y'.repeat(ARTIFACT_CAPS.maxDiagnosticsChars);
    const runner = new FakeLoopRunner(() => ({
      kind: 'outcome',
      outcome: unverifiedWithEvidence({
        rtl: 'module m; endmodule',
        testbench: 'module m_tb; endmodule',
        simulation: {
          verdict: 'fail',
          checks: [],
          stdout: `HEAD${filler}TAIL`,
          stderr: '',
        },
        failingCase: null,
      }),
    }));

    const captured = (await captureOne(runner, new CapturingArtifactSink())).simulation?.stdout;

    expect(captured?.truncated).toBe(true);
    expect(captured?.text).toHaveLength(ARTIFACT_CAPS.maxDiagnosticsChars);
    expect(captured?.keptEnd).toBe('tail');
    expect(captured?.text.endsWith('TAIL')).toBe(true);
    expect(captured?.text.startsWith('HEAD')).toBe(false);
  });

  it('caps the number of captured checks and says the list was cut', async () => {
    const checks = Array.from({ length: ARTIFACT_CAPS.maxChecks + 5 }, (_unused, index) => ({
      name: `check_${index}`,
      passed: true,
    }));
    const runner = new FakeLoopRunner(() => ({
      kind: 'outcome',
      outcome: verifiedWithEvidence({
        rtl: 'module m; endmodule',
        testbench: 'module m_tb; endmodule',
        simulation: { verdict: 'pass', checks, stdout: '', stderr: '' },
      }),
    }));

    const simulation = (await captureOne(runner, new CapturingArtifactSink())).simulation;

    expect(simulation?.checks).toHaveLength(ARTIFACT_CAPS.maxChecks);
    expect(simulation?.checksTruncated).toBe(true);
  });

  it('does not fail the sample when the sink throws, so a run survives a full disk', async () => {
    // The verdict was already measured when the write was attempted. Losing the evidence
    // must cost the evidence and nothing else - a campaign with hours in it cannot die here.
    const runner = new FakeLoopRunner(() => ({ kind: 'pass', iterations: 3, costCents: 2 }));
    const sink = new ThrowingArtifactSink();

    const report = await harness({
      loopRunner: runner,
      config: config({ sampleCount: 2 }),
      ks: [1],
      artifactSink: sink,
    }).run([firstProblem()]);

    expect(sink.calls).toBe(2);
    const problem = report.problems[0];
    expect(problem?.passCount).toBe(2);
    expect(problem?.samples.map((sample) => sample.outcomeStatus)).toEqual([
      'verified',
      'verified',
    ]);
    expect(problem?.iterationsToPass).toBe(3);
  });

  it('leaves every measured number identical whether a sink is wired or not', async () => {
    // Capture is additive observability: the report is the contract, and it must not move.
    const decide = (request: EvalSampleRequest): Decision =>
      request.sampleIndex % 2 === 0
        ? { kind: 'pass', iterations: 2, costCents: 3 }
        : { kind: 'fail', iterations: 4, costCents: 3 };

    const without = await harness({ loopRunner: new FakeLoopRunner(decide) }).run(
      FIXED_EVAL_SUBSET,
    );
    const withSink = await harness({
      loopRunner: new FakeLoopRunner(decide),
      artifactSink: new CapturingArtifactSink(),
    }).run(FIXED_EVAL_SUBSET);

    expect(withSink).toEqual(without);
  });
});

describe('createEvalHarness - configuration validation', () => {
  const runner = new FakeLoopRunner(() => ({ kind: 'pass', iterations: 1, costCents: 1 }));

  it('rejects a k outside [1, sampleCount]', () => {
    const built = createEvalHarness({
      loopRunner: runner,
      caps: CAPS,
      limits: LIMITS,
      config: config({ sampleCount: 4 }),
      costEnvelopeCents: 5,
      ks: [5],
    });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.error.code).toBe('EVAL_K_OUT_OF_RANGE');
  });

  it('rejects a negative cost envelope', () => {
    const built = createEvalHarness({
      loopRunner: runner,
      caps: CAPS,
      limits: LIMITS,
      config: config(),
      costEnvelopeCents: -1,
    });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.error.code).toBe('EVAL_COST_ENVELOPE_INVALID');
  });

  it('rejects caps that do not form a valid budget', () => {
    const built = createEvalHarness({
      loopRunner: runner,
      caps: { ...CAPS, maxIterations: -1 },
      limits: LIMITS,
      config: config(),
      costEnvelopeCents: 5,
    });
    expect(built.ok).toBe(false);
  });

  it('defaults the reported k set to [sampleCount]', async () => {
    const report = await harness({ loopRunner: runner, config: config({ sampleCount: 3 }) }).run(
      [],
    );
    expect(report.ks).toEqual([3]);
  });
});
