// Unit tests for the harness's dual-verdict recording path.
//
// The Eval_Harness reads pass/fail from the loop's own oracle, which runs the AGENT'S
// spec-derived testbench. That verdict alone is self-graded. These examples pin down
// that when an independent judge is wired the harness records BOTH verdicts per sample
// and reports their agreement, that it judges the candidate the loop actually produced
// under the SAME sandbox caps, and that a judge which is absent or broken degrades to
// "not measured" without ever changing the loop's own recorded verdict.
//
// Driven through fakes: no provider SDK, no real oracle, no toolchain.

import { describe, expect, it } from 'vitest';

import type { VerificationOutcome } from '@app/agent';
import type { ResourceLimits } from '@app/tools';

import type { GoldenJudge, GoldenJudgeRequest, RecordedGoldenVerdict } from './golden-judge.js';
import { createEvalHarness } from './harness.js';
import type { EvalLoopRunner, EvalSampleRequest, StudentSessionCaps } from './loop-runner.js';
import { makeReproducibilityConfig, type ReproducibilityConfig } from './reproducibility.js';
import { FIXED_EVAL_SUBSET } from './subset.js';
import type { EvalRunReport } from './report.js';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5000 };

const CAPS: StudentSessionCaps = {
  maxIterations: 20,
  maxTokens: 1_000_000,
  maxWallClockMs: 1_000_000,
  maxCostCents: 1_000_000,
};

/** The RTL each fake outcome carries, so the judge has something to score. */
const VERIFIED_RTL = 'module verified_candidate(); endmodule\n';
const UNVERIFIED_RTL = 'module unverified_candidate(); endmodule\n';

/** A loop outcome carrying only the fields the harness reads. */
function verifiedOutcome(): VerificationOutcome {
  return {
    status: 'verified',
    iterations: 2,
    moduleVersion: { rtl: VERIFIED_RTL },
  } as unknown as VerificationOutcome;
}

function unverifiedOutcome(): VerificationOutcome {
  return {
    status: 'unverified',
    iterations: 4,
    candidate: { rtl: UNVERIFIED_RTL },
  } as unknown as VerificationOutcome;
}

function blockedOutcome(): VerificationOutcome {
  return { status: 'blocked' } as unknown as VerificationOutcome;
}

/** A loop runner returning a scripted outcome per sample index. */
class ScriptedRunner implements EvalLoopRunner {
  readonly #outcomes: readonly VerificationOutcome[];

  constructor(outcomes: readonly VerificationOutcome[]) {
    this.#outcomes = outcomes;
  }

  runSample(request: EvalSampleRequest): Promise<VerificationOutcome> {
    const outcome = this.#outcomes[request.sampleIndex];
    if (outcome === undefined) {
      throw new Error(`no scripted outcome for sample ${request.sampleIndex}`);
    }
    return Promise.resolve(outcome);
  }
}

/** A judge returning a scripted verdict and recording every request. */
class ScriptedJudge implements GoldenJudge {
  readonly requests: GoldenJudgeRequest[] = [];
  readonly #verdict: (request: GoldenJudgeRequest) => RecordedGoldenVerdict | null;

  constructor(verdict: (request: GoldenJudgeRequest) => RecordedGoldenVerdict | null) {
    this.#verdict = verdict;
  }

  judge(request: GoldenJudgeRequest): Promise<RecordedGoldenVerdict | null> {
    this.requests.push(request);
    return Promise.resolve(this.#verdict(request));
  }
}

/** A judge that always throws, to exercise the fail-safe path. */
const THROWING_JUDGE: GoldenJudge = {
  judge(): Promise<RecordedGoldenVerdict | null> {
    return Promise.reject(new Error('the golden toolchain fell over'));
  },
};

function config(sampleCount: number): ReproducibilityConfig {
  const built = makeReproducibilityConfig({ seed: 7, temperature: 0, sampleCount });
  if (!built.ok) {
    throw new Error(built.error.message);
  }
  return built.value;
}

/** Run one problem through the harness with the given runner and optional judge. */
async function run(
  outcomes: readonly VerificationOutcome[],
  goldenJudge?: GoldenJudge,
): Promise<EvalRunReport> {
  const problem = FIXED_EVAL_SUBSET[0];
  if (problem === undefined) {
    throw new Error('subset is empty');
  }
  const built = createEvalHarness({
    loopRunner: new ScriptedRunner(outcomes),
    caps: CAPS,
    limits: LIMITS,
    config: config(outcomes.length),
    costEnvelopeCents: 5,
    ks: [1],
    ...(goldenJudge === undefined ? {} : { goldenJudge }),
  });
  if (!built.ok) {
    throw new Error(built.error.code);
  }
  return built.value.run([problem]);
}

describe('EvalHarness - recording both verdicts', () => {
  it('records the loop verdict and the independent verdict on every sample', async () => {
    const judge = new ScriptedJudge(() => ({ kind: 'passed', failureCount: 0 }));
    const report = await run([verifiedOutcome(), unverifiedOutcome()], judge);
    const samples = report.problems[0]?.samples ?? [];

    expect(samples.map((sample) => sample.passed)).toEqual([true, false]);
    expect(samples.map((sample) => sample.goldenVerdict?.kind)).toEqual(['passed', 'passed']);
  });

  it('judges the candidate RTL the loop actually produced', async () => {
    const judge = new ScriptedJudge(() => ({ kind: 'passed', failureCount: 0 }));
    await run([verifiedOutcome(), unverifiedOutcome()], judge);

    expect(judge.requests.map((request) => request.rtl)).toEqual([VERIFIED_RTL, UNVERIFIED_RTL]);
  });

  it("judges under the SAME sandbox caps the loop's own oracle ran under", async () => {
    // Student-session parity: the judge never gets a widened cap.
    const judge = new ScriptedJudge(() => ({ kind: 'passed', failureCount: 0 }));
    await run([verifiedOutcome()], judge);

    expect(judge.requests[0]?.limits).toEqual(LIMITS);
  });

  it('passes the problem id so the judge can find the right golden testbench', async () => {
    const judge = new ScriptedJudge(() => ({ kind: 'passed', failureCount: 0 }));
    await run([verifiedOutcome()], judge);

    expect(judge.requests[0]?.problemId).toBe(FIXED_EVAL_SUBSET[0]?.id);
  });
});

describe('EvalHarness - the agreement report', () => {
  it('surfaces a loop pass the independent judge failed', async () => {
    // The self-graded case made visible: our testbench passed a design the benchmark's
    // testbench rejects.
    const judge = new ScriptedJudge(() => ({ kind: 'failed', failureCount: 4 }));
    const report = await run([verifiedOutcome()], judge);

    expect(report.agreement.judgedSamples).toBe(1);
    expect(report.agreement.loopPassGoldenFail).toBe(1);
    expect(report.agreement.agreementRate).toBe(0);
    // The loop's own verdict is untouched: pass@k from the loop still reads 1.
    expect(report.problems[0]?.passCount).toBe(1);
  });

  it('reports full agreement when both judges agree on every sample', async () => {
    const judge = new ScriptedJudge((request) => ({
      kind: request.rtl === VERIFIED_RTL ? 'passed' : 'failed',
      failureCount: null,
    }));
    const report = await run([verifiedOutcome(), unverifiedOutcome()], judge);

    expect(report.agreement.judgedSamples).toBe(2);
    expect(report.agreement.agreementRate).toBe(1);
  });
});

describe('EvalHarness - degrading honestly when there is nothing to judge', () => {
  it('records no golden verdict and a zeroed agreement when no judge is wired', async () => {
    const report = await run([verifiedOutcome(), unverifiedOutcome()]);

    expect(report.problems[0]?.samples.map((sample) => sample.goldenVerdict)).toEqual([null, null]);
    expect(report.agreement.judgedSamples).toBe(0);
    // Zero, not one: an unjudged run must never read as perfect agreement.
    expect(report.agreement.agreementRate).toBe(0);
  });

  it('does not call the judge for an outcome that produced no candidate', async () => {
    const judge = new ScriptedJudge(() => ({ kind: 'passed', failureCount: 0 }));
    const report = await run([blockedOutcome()], judge);

    expect(judge.requests).toHaveLength(0);
    expect(report.problems[0]?.samples[0]?.goldenVerdict).toBeNull();
    expect(report.agreement.judgedSamples).toBe(0);
  });

  it('records no golden verdict when the judge has none for that problem', async () => {
    const judge = new ScriptedJudge(() => null);
    const report = await run([verifiedOutcome()], judge);

    expect(report.problems[0]?.samples[0]?.goldenVerdict).toBeNull();
    expect(report.agreement.judgedSamples).toBe(0);
  });

  it('leaves a sample unjudged when the loop runner returns an outcome carrying no RTL', async () => {
    // The outcome crosses a port boundary, so its shape is validated rather than
    // trusted: a runner that reports `verified` with no module version must not abort
    // the whole eval run.
    const malformed = { status: 'verified', iterations: 1 } as unknown as VerificationOutcome;
    const judge = new ScriptedJudge(() => ({ kind: 'passed', failureCount: 0 }));
    const report = await run([malformed], judge);

    expect(judge.requests).toHaveLength(0);
    expect(report.problems[0]?.samples[0]?.passed).toBe(true);
    expect(report.problems[0]?.samples[0]?.goldenVerdict).toBeNull();
  });

  it('leaves the loop verdict intact when the judge throws', async () => {
    // A failure to obtain the second opinion must never abort the run or rewrite the
    // first opinion.
    const report = await run([verifiedOutcome()], THROWING_JUDGE);

    expect(report.problems[0]?.samples[0]?.passed).toBe(true);
    expect(report.problems[0]?.samples[0]?.goldenVerdict).toBeNull();
    expect(report.agreement.judgedSamples).toBe(0);
  });
});
