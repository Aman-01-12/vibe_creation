// Unit tests for the harness's POSITIVE CONTROL path: the sibling of the agreement suite.
//
// WHAT THESE PIN DOWN
//   1. The control receives OUR generated testbench - the exact instrument that produced the
//      loop's verdict - under the SAME sandbox caps, for the right problem.
//   2. Every sample carries an instrument verdict; a sample nothing could be checked for is
//      `unchecked`, never absent and never silently valid.
//   3. A control that throws degrades to `unchecked` and the run completes, with the loop's
//      own verdict and the golden verdict untouched.
//   4. The control cannot perturb a measured number: the same run with and without it
//      produces identical verdicts, iterations, costs and seeds.
//
// Driven through fakes: no provider SDK, no real oracle, no toolchain.

import { describe, expect, it } from 'vitest';

import type { VerificationOutcome } from '@app/agent';
import type { ResourceLimits } from '@app/tools';

import type { GoldenJudge, RecordedGoldenVerdict } from './golden-judge.js';
import { createEvalHarness } from './harness.js';
import type {
  InstrumentControl,
  InstrumentControlRequest,
  InstrumentControlResult,
} from './instrument-control.js';
import { NO_MUTATION_CONTROL_MEASURED, type MutationProbeReport } from './mutation-control.js';
import type { EvalLoopRunner, EvalSampleRequest, StudentSessionCaps } from './loop-runner.js';
import { makeReproducibilityConfig, type ReproducibilityConfig } from './reproducibility.js';
import type { EvalRunReport, SampleResult } from './report.js';
import { FIXED_EVAL_SUBSET } from './subset.js';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5000 };

const CAPS: StudentSessionCaps = {
  maxIterations: 20,
  maxTokens: 1_000_000,
  maxWallClockMs: 1_000_000,
  maxCostCents: 1_000_000,
};

/** OUR generated testbench, as the loop's outcome carries it. */
const TESTBENCH_SOURCE = 'module right_shifter_tb; endmodule\n';

/** A `verified` outcome carrying both the candidate and the testbench that judged it. */
function verifiedOutcome(): VerificationOutcome {
  return {
    status: 'verified',
    iterations: 2,
    moduleVersion: { rtl: 'module candidate(); endmodule\n' },
    testbench: { source: TESTBENCH_SOURCE },
  } as unknown as VerificationOutcome;
}

/** An `unverified` outcome, which still carries the testbench that rejected the candidate. */
function unverifiedOutcome(): VerificationOutcome {
  return {
    status: 'unverified',
    iterations: 6,
    candidate: { rtl: 'module candidate(); endmodule\n' },
    testbench: { source: TESTBENCH_SOURCE },
  } as unknown as VerificationOutcome;
}

/** A `setup-failed` outcome: no candidate and no testbench, so no instrument to validate. */
function setupFailedOutcome(): VerificationOutcome {
  return {
    status: 'setup-failed',
    reason: 'generation-unavailable',
    detail: 'the host declined every attempt',
  } as unknown as VerificationOutcome;
}

/** A loop runner returning a scripted outcome per sample index. */
class ScriptedRunner implements EvalLoopRunner {
  constructor(private readonly outcomes: readonly VerificationOutcome[]) {}

  runSample(request: EvalSampleRequest): Promise<VerificationOutcome> {
    const outcome = this.outcomes[request.sampleIndex];
    if (outcome === undefined) {
      throw new Error(`no scripted outcome for sample ${request.sampleIndex}`);
    }
    return Promise.resolve(outcome);
  }
}

/** A control returning a scripted result and recording every request. */
class ScriptedControl implements InstrumentControl {
  readonly requests: InstrumentControlRequest[] = [];

  constructor(
    private readonly result: (request: InstrumentControlRequest) => InstrumentControlResult | null,
  ) {}

  check(request: InstrumentControlRequest): Promise<InstrumentControlResult | null> {
    this.requests.push(request);
    return Promise.resolve(this.result(request));
  }
}

/** A control result with the given verdict and no interesting streams. */
function result(
  verdict: InstrumentControlResult['verdict'],
  mutation: InstrumentControlResult['mutation'] = null,
): InstrumentControlResult {
  return { verdict, stdout: '', stderr: '', exitCode: 0, mutation };
}

/** A control that always throws, to exercise the fail-safe path. */
const THROWING_CONTROL: InstrumentControl = {
  check(): Promise<InstrumentControlResult | null> {
    return Promise.reject(new Error('the control toolchain fell over at /private/var/tmp/x'));
  },
};

/** A judge that always passes the candidate, so the golden verdict is observable. */
const PASSING_JUDGE: GoldenJudge = {
  judge(): Promise<RecordedGoldenVerdict | null> {
    return Promise.resolve({ kind: 'passed', failureCount: 0 });
  },
};

function config(sampleCount: number): ReproducibilityConfig {
  const built = makeReproducibilityConfig({ seed: 7, temperature: 0, sampleCount });
  if (!built.ok) {
    throw new Error(built.error.message);
  }
  return built.value;
}

/** Run one problem through the harness with the given runner and optional collaborators. */
async function run(
  outcomes: readonly VerificationOutcome[],
  parts: {
    readonly instrumentControl?: InstrumentControl;
    readonly goldenJudge?: GoldenJudge;
  } = {},
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
    ...(parts.instrumentControl === undefined
      ? {}
      : { instrumentControl: parts.instrumentControl }),
    ...(parts.goldenJudge === undefined ? {} : { goldenJudge: parts.goldenJudge }),
  });
  if (!built.ok) {
    throw new Error(built.error.code);
  }
  return built.value.run([problem]);
}

/** The samples of the single problem in a report. */
function samplesOf(report: EvalRunReport): readonly SampleResult[] {
  return report.problems[0]?.samples ?? [];
}

/**
 * Every MEASURED field of a sample: the ones a control may never move.
 *
 * `instrumentVerdict` and `mutationProbe` are deliberately absent - they are what the controls
 * are FOR. Everything else here is either an oracle verdict, a student-budget measurement, or a
 * reproducibility input, and a control that moved any of them would be charging the model for
 * our own diagnostics.
 */
function measuredFields(sample: SampleResult): unknown {
  return {
    sampleIndex: sample.sampleIndex,
    seed: sample.seed,
    passed: sample.passed,
    outcomeStatus: sample.outcomeStatus,
    iterations: sample.iterations,
    costCents: sample.costCents,
    stopReason: sample.stopReason,
    failureNote: sample.failureNote,
    goldenVerdict: sample.goldenVerdict,
  };
}

/**
 * A probe that let two mutants of eight VALID ones live, one in each survivor bucket.
 *
 * Both buckets are populated on purpose: the harness must carry them through to the report
 * SEPARATELY, because a definite coverage gap and a mutant nobody has shown to be killable are
 * different work items and pooling them would report the second as the first.
 */
const SURVIVED_PROBE: MutationProbeReport = Object.freeze({
  validCount: 8,
  killedCount: 6,
  noVerdictKills: 1,
  coverageGapSurvivors: Object.freeze([
    {
      mutantId: 'ARITH_PLUS_TO_MINUS@12:9',
      operator: 'ARITH_PLUS_TO_MINUS' as const,
      site: { line: 12, column: 9, before: '+', after: '-' },
    },
  ]),
  candidateEquivalentSurvivors: Object.freeze([
    {
      mutantId: 'RESET_BRANCH_DISABLED@26:10',
      operator: 'RESET_BRANCH_DISABLED' as const,
      site: { line: 26, column: 10, before: '(!rst_n)', after: "(1'b0)" },
    },
  ]),
  goldenKilledCount: 5,
  goldenTimeoutCount: 0,
  nonCompilingCount: 2,
  goldenErroredCount: 0,
  generatedCount: 10,
  elapsedMs: 6_000,
});

describe('EvalHarness - what the positive control is handed', () => {
  it('hands the control OUR generated testbench, not the candidate RTL', async () => {
    const control = new ScriptedControl(() => result({ validity: 'valid' }));

    await run([verifiedOutcome(), unverifiedOutcome()], { instrumentControl: control });

    expect(control.requests.map((request) => request.testbench)).toEqual([
      TESTBENCH_SOURCE,
      TESTBENCH_SOURCE,
    ]);
  });

  it("controls under the SAME sandbox caps the loop's own oracle ran under", async () => {
    const control = new ScriptedControl(() => result({ validity: 'valid' }));

    await run([verifiedOutcome()], { instrumentControl: control });

    expect(control.requests[0]?.limits).toEqual(LIMITS);
  });

  it('passes the problem id so the control can find the right reference design', async () => {
    const control = new ScriptedControl(() => result({ validity: 'valid' }));

    await run([verifiedOutcome()], { instrumentControl: control });

    expect(control.requests[0]?.problemId).toBe(FIXED_EVAL_SUBSET[0]?.id);
  });
});

describe('EvalHarness - every sample carries an instrument verdict', () => {
  it('records valid when the reference design passes our testbench', async () => {
    const report = await run([verifiedOutcome()], {
      instrumentControl: new ScriptedControl(() => result({ validity: 'valid' })),
    });

    expect(samplesOf(report)[0]?.instrumentVerdict).toEqual({ validity: 'valid' });
    expect(report.instrument.validSamples).toBe(1);
    expect(report.instrument.countedSamples).toBe(1);
  });

  it('records invalid with its defect, and drops the sample from the counted set', async () => {
    const report = await run([unverifiedOutcome()], {
      instrumentControl: new ScriptedControl(() =>
        result({ validity: 'invalid', defect: 'TESTBENCH_FAILED_REFERENCE' }),
      ),
    });

    expect(samplesOf(report)[0]?.instrumentVerdict).toEqual({
      validity: 'invalid',
      defect: 'TESTBENCH_FAILED_REFERENCE',
    });
    expect(report.instrument.invalidSamples).toBe(1);
    expect(report.instrument.failedReferenceSamples).toBe(1);
    // Excluded from the pass@k denominator: it measured our testbench, not the model.
    expect(report.instrument.countedSamples).toBe(0);
  });

  it('records unchecked / control-absent when no control is wired', async () => {
    const report = await run([verifiedOutcome()]);

    expect(samplesOf(report)[0]?.instrumentVerdict).toEqual({
      validity: 'unchecked',
      reason: 'control-absent',
    });
    // Zeroed reads as "not measured", never as every instrument being sound.
    expect(report.instrument.checkedSamples).toBe(0);
  });

  it('records unchecked / no-testbench when the loop produced no instrument at all', async () => {
    const control = new ScriptedControl(() => result({ validity: 'valid' }));

    const report = await run([setupFailedOutcome()], { instrumentControl: control });

    expect(samplesOf(report)[0]?.instrumentVerdict).toEqual({
      validity: 'unchecked',
      reason: 'no-testbench',
    });
    // Nothing was submitted, so nothing was run for it.
    expect(control.requests).toHaveLength(0);
  });

  it('records unchecked / no-reference when the control holds none for the problem', async () => {
    const report = await run([verifiedOutcome()], {
      instrumentControl: new ScriptedControl(() => null),
    });

    expect(samplesOf(report)[0]?.instrumentVerdict).toEqual({
      validity: 'unchecked',
      reason: 'no-reference',
    });
  });
});

describe('EvalHarness - a broken control degrades, it never crashes a campaign', () => {
  it('records unchecked / control-unavailable and completes the run', async () => {
    const report = await run([verifiedOutcome(), unverifiedOutcome()], {
      instrumentControl: THROWING_CONTROL,
    });

    expect(samplesOf(report).map((sample) => sample.instrumentVerdict)).toEqual([
      { validity: 'unchecked', reason: 'control-unavailable' },
      { validity: 'unchecked', reason: 'control-unavailable' },
    ]);
    // Both samples were still measured, so the campaign lost nothing.
    expect(samplesOf(report)).toHaveLength(2);
  });

  it("leaves the loop's own oracle verdict and the golden verdict untouched", async () => {
    const report = await run([verifiedOutcome(), unverifiedOutcome()], {
      instrumentControl: THROWING_CONTROL,
      goldenJudge: PASSING_JUDGE,
    });

    expect(samplesOf(report).map((sample) => sample.passed)).toEqual([true, false]);
    expect(samplesOf(report).map((sample) => sample.goldenVerdict?.kind)).toEqual([
      'passed',
      'passed',
    ]);
  });

  it('records nothing from the thrown error, not even in the failure note', async () => {
    const report = await run([verifiedOutcome()], { instrumentControl: THROWING_CONTROL });

    expect(JSON.stringify(samplesOf(report))).not.toContain('/private/var/tmp');
  });
});

describe('EvalHarness - the control cannot perturb a measured number', () => {
  it('produces identical measured fields with and without a control', async () => {
    const outcomes = [verifiedOutcome(), unverifiedOutcome()];

    const uncontrolled = await run(outcomes);
    const controlled = await run(outcomes, {
      // The most disruptive answer available: every instrument is condemned.
      instrumentControl: new ScriptedControl(() =>
        result({ validity: 'invalid', defect: 'TESTBENCH_FAILED_REFERENCE' }),
      ),
    });

    expect(samplesOf(controlled).map(measuredFields)).toEqual(
      samplesOf(uncontrolled).map(measuredFields),
    );
    // And the cost envelope - the student-budget assertion - is untouched.
    expect(controlled.costEnvelope).toEqual(uncontrolled.costEnvelope);
  });

  it('produces identical measured fields with and without the NEGATIVE control', async () => {
    // The same guarantee the positive control already carries, asserted separately because the
    // negative control runs many more simulations: it must not consume the student session
    // budget, must not be charged as model cost, and must not count as a sample or an
    // iteration. Only `instrumentVerdict` and `mutationProbe` may differ.
    const outcomes = [verifiedOutcome(), unverifiedOutcome()];

    const positiveOnly = await run(outcomes, {
      instrumentControl: new ScriptedControl(() => result({ validity: 'valid' })),
    });
    const withMutants = await run(outcomes, {
      // The most disruptive answer available: every testbench is condemned for letting a
      // mutant live, which is the verdict that removes the sample from the denominator.
      instrumentControl: new ScriptedControl(() =>
        result({ validity: 'invalid', defect: 'TESTBENCH_SURVIVED_MUTANTS' }, SURVIVED_PROBE),
      ),
    });

    expect(samplesOf(withMutants).map(measuredFields)).toEqual(
      samplesOf(positiveOnly).map(measuredFields),
    );
    expect(withMutants.costEnvelope).toEqual(positiveOnly.costEnvelope);
    expect(samplesOf(withMutants).map((sample) => sample.iterations)).toEqual([2, 6]);
  });

  it('records the probe evidence and aggregates it, without touching the oracle verdict', async () => {
    const report = await run([verifiedOutcome()], {
      instrumentControl: new ScriptedControl(() =>
        result({ validity: 'invalid', defect: 'TESTBENCH_SURVIVED_MUTANTS' }, SURVIVED_PROBE),
      ),
    });

    expect(samplesOf(report)[0]?.passed).toBe(true);
    expect(samplesOf(report)[0]?.mutationProbe?.coverageGapSurvivors[0]?.operator).toBe(
      'ARITH_PLUS_TO_MINUS',
    );
    expect(report.mutation.validMutants).toBe(8);
    expect(report.mutation.killedMutants).toBe(6);
    expect(report.mutation.noVerdictKills).toBe(1);
    expect(report.mutation.goldenSurvivedMutants).toBe(3);
    // The two buckets reach the run report apart, not pooled into one survivor tally.
    expect(report.mutation.coverageGapOperators).toEqual([
      { operator: 'ARITH_PLUS_TO_MINUS', count: 1 },
    ]);
    expect(report.mutation.candidateEquivalentOperators).toEqual([
      { operator: 'RESET_BRANCH_DISABLED', count: 1 },
    ]);
    // Excluded from the denominator: the sample was judged by an under-powered instrument.
    expect(report.instrument.survivedMutantsSamples).toBe(1);
    expect(report.instrument.countedSamples).toBe(0);
  });

  it('reports the negative control as NOT MEASURED when it never probed', async () => {
    const report = await run([verifiedOutcome()], {
      instrumentControl: new ScriptedControl(() => result({ validity: 'valid' })),
    });

    expect(report.mutation).toEqual(NO_MUTATION_CONTROL_MEASURED);
    expect(samplesOf(report)[0]?.mutationProbe).toBeNull();
  });

  it('does not change the per-problem pass count or iterations-to-pass', async () => {
    const outcomes = [verifiedOutcome(), unverifiedOutcome()];

    const uncontrolled = await run(outcomes);
    const controlled = await run(outcomes, {
      instrumentControl: new ScriptedControl(() =>
        result({ validity: 'invalid', defect: 'TESTBENCH_REFERENCE_UNBUILDABLE' }),
      ),
    });

    expect(controlled.problems[0]?.passCount).toBe(uncontrolled.problems[0]?.passCount);
    expect(controlled.problems[0]?.iterationsToPass).toBe(
      uncontrolled.problems[0]?.iterationsToPass,
    );
  });
});
