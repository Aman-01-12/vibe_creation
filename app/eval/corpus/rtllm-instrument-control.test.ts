// Unit tests for the RTLLM-backed positive control, with a faked simulator: no toolchain.
//
// The real-toolchain proof is `app/test/eval-instrument-control.integration.test.ts`, which
// pins the actual observed regression. What is pinned HERE is the classification, which is
// where a subtle mistake would be invisible: "our testbench does not BUILD with the
// reference" and "our testbench BUILT and rejected the reference" point at different
// defects, and `SimulationVerdict` collapses both into one `error` verdict when the build
// fails.

import { describe, expect, it } from 'vitest';

import type { ResourceLimits, SimulationVerdict, SimulatorAdapter, SourceFile } from '@app/tools';

import type {
  MutationNegativeControl,
  MutationProbeOutcome,
  MutationProbeRequest,
} from '../mutation-control.js';
import type { ReferenceDesign } from './corpus-types.js';
import {
  CONTROL_TESTBENCH_WORKSPACE_FILENAME,
  RtllmInstrumentControl,
} from './rtllm-instrument-control.js';

/** Sandbox caps for the fake runs; never used, because no tool runs. */
const LIMITS: ResourceLimits = { cpu: 1, memMb: 64, procs: 8, diskMb: 8, wallMs: 5_000 };

/** One reference design, already top-module-renamed by the importer. */
function reference(problemId: string): ReferenceDesign {
  return {
    problemId,
    rtl: { path: 'dut_reference.v', contents: 'module right_shifter(clk, q, d); endmodule\n' },
    topModuleRenamedFrom: 'verified_right_shifter',
  };
}

/**
 * A `SimulationVerdict` shaped only as far as the control reads it.
 *
 * Pinned to `failureCause: 'none'` / `attributedFiles: []` by default: this fixture
 * isolates `classifyControlRun`'s own re-derivation from `verdict` and `stderr`
 * (task 1.2's territory, not the failure-cause narrowing), so tests that care about
 * a specific cause override it explicitly.
 */
function simulation(overrides: Partial<SimulationVerdict> = {}): SimulationVerdict {
  return {
    verdict: 'pass',
    checks: [],
    vcd: null,
    stdout: '',
    stderr: '',
    exitCode: 0,
    resourceUsage: { cpuMs: 1, maxMemMb: 1, wallMs: 1 },
    failureCause: 'none',
    attributedFiles: [],
    ...overrides,
  };
}

/** A simulator that answers with a fixed verdict and records what it was handed. */
class SpySimulator implements SimulatorAdapter {
  readonly calls: {
    readonly rtl: readonly SourceFile[];
    readonly testbench: SourceFile;
  }[] = [];

  constructor(private readonly answer: SimulationVerdict) {}

  simulate(rtl: readonly SourceFile[], testbench: SourceFile): Promise<SimulationVerdict> {
    this.calls.push({ rtl, testbench });
    return Promise.resolve(this.answer);
  }
}

/** The control over one problem, with the given simulator answer. */
function control(answer: SimulationVerdict): {
  readonly control: RtllmInstrumentControl;
  readonly simulator: SpySimulator;
} {
  const simulator = new SpySimulator(answer);
  return {
    simulator,
    control: new RtllmInstrumentControl({
      simulator,
      references: new Map([
        ['rtllm/memory/right_shifter', reference('rtllm/memory/right_shifter')],
      ]),
    }),
  };
}

/** One check request against the controlled problem. */
function request(testbench = 'module tb; endmodule\n'): {
  readonly problemId: string;
  readonly testbench: string;
  readonly limits: ResourceLimits;
} {
  return { problemId: 'rtllm/memory/right_shifter', testbench, limits: LIMITS };
}

describe('RtllmInstrumentControl - classifying the control run', () => {
  it('reports VALID when the reference design passes our testbench', async () => {
    const { control: subject } = control(simulation({ verdict: 'pass' }));

    const result = await subject.check(request());

    expect(result?.verdict).toEqual({ validity: 'valid' });
  });

  it('reports INVALID / rejected when our testbench built and then failed the reference', async () => {
    // The measured `right_shifter` shape: it compiles, it runs, and it reports a failing
    // check against the design upstream says is correct.
    const { control: subject } = control(
      simulation({
        verdict: 'fail',
        checks: [{ name: 'ac1_under_simulation_right_shifter_produces', passed: false }],
        stdout: 'CHECK ac1_under_simulation_right_shifter_produces FAIL\n',
      }),
    );

    const result = await subject.check(request());

    expect(result?.verdict).toEqual({
      validity: 'invalid',
      defect: 'TESTBENCH_FAILED_REFERENCE',
    });
  });

  it('reports INVALID / did-not-build when the pair does not compile, not merely errored', async () => {
    const { control: subject } = control(
      simulation({
        verdict: 'error',
        stderr: 'tb.v:7: error: Unknown module type: right_shifter\n',
        failureCause: 'build-failed',
        attributedFiles: [CONTROL_TESTBENCH_WORKSPACE_FILENAME],
      }),
    );

    const result = await subject.check(request());

    // The distinction that matters: a build failure is a structural mismatch, not a
    // disagreement about behaviour.
    expect(result?.verdict).toEqual({
      validity: 'invalid',
      defect: 'TESTBENCH_REFERENCE_UNBUILDABLE',
    });
  });

  it('reports INVALID / did-not-build off a stale failureCause, via the classifyNonPass fallback', async () => {
    // `failureCause` defaults to `'none'` here on purpose: this covers a run that reports no
    // failure but does carry build diagnostics, the one case still resolved by the
    // `classifyNonPass` fallback rather than by reading `failureCause` directly.
    const { control: subject } = control(
      simulation({
        verdict: 'error',
        stderr: 'tb.v:7: error: Unknown module type: right_shifter\n',
      }),
    );

    const result = await subject.check(request());

    expect(result?.verdict).toEqual({
      validity: 'invalid',
      defect: 'TESTBENCH_REFERENCE_UNBUILDABLE',
    });
  });

  it('reports UNCHECKED / resource-exhausted for a disk-capped run, never as a build defect', async () => {
    // The measured `multi_16bit` regression this task exists to fix: the control run's own
    // residual stderr line names a disk cap, not a build defect, and must be read off
    // `failureCause` BEFORE `classifyNonPass` ever sees that line.
    const { control: subject } = control(
      simulation({
        verdict: 'error',
        stderr: 'workspace reached its 134217728-byte disk cap\n',
        failureCause: 'disk-capped',
      }),
    );

    const result = await subject.check(request());

    expect(result?.verdict).toEqual({
      validity: 'unchecked',
      reason: 'control-resource-exhausted',
    });
  });

  it('reports UNCHECKED / resource-exhausted for a timed-out run, even with plausible build-looking stderr', async () => {
    const { control: subject } = control(
      simulation({
        verdict: 'error',
        // Deliberately plausible-looking build diagnostic residue, to prove the short-circuit
        // wins even when `classifyNonPass` would otherwise call this `did-not-build`.
        stderr: 'tb.v:7: error: Unknown module type: right_shifter\n',
        failureCause: 'timed-out',
      }),
    );

    const result = await subject.check(request());

    expect(result?.verdict).toEqual({
      validity: 'unchecked',
      reason: 'control-resource-exhausted',
    });
  });

  it('reports INVALID / no-verdict when the run produced neither a check nor diagnostics', async () => {
    const { control: subject } = control(simulation({ verdict: 'error', stderr: '' }));

    const result = await subject.check(request());

    expect(result?.verdict).toEqual({ validity: 'invalid', defect: 'CONTROL_RUN_ERRORED' });
  });

  it('carries the toolchain streams for the artifacts, and the exit code', async () => {
    const { control: subject } = control(
      simulation({ verdict: 'fail', stdout: 'CHECK a FAIL\n', stderr: 'a warning\n', exitCode: 3 }),
    );

    const result = await subject.check(request());

    expect(result?.stdout).toBe('CHECK a FAIL\n');
    expect(result?.stderr).toBe('a warning\n');
    expect(result?.exitCode).toBe(3);
  });
});

describe('RtllmInstrumentControl - what it refuses to run', () => {
  it('returns null for a problem it holds no reference for, rather than inventing a verdict', async () => {
    const { control: subject, simulator } = control(simulation());

    const result = await subject.check({ ...request(), problemId: 'rtllm/other/design' });

    expect(result).toBeNull();
    expect(simulator.calls).toHaveLength(0);
  });

  it('declines an oversized testbench as unchecked, never as a verdict', async () => {
    const { control: subject, simulator } = control(simulation());

    const result = await subject.check(request('x'.repeat(200_001)));

    expect(result?.verdict).toEqual({
      validity: 'unchecked',
      reason: 'testbench-unsubmittable',
    });
    expect(simulator.calls).toHaveLength(0);
  });

  it('declines an empty testbench as unchecked', async () => {
    const { control: subject, simulator } = control(simulation());

    const result = await subject.check(request(''));

    expect(result?.verdict).toEqual({
      validity: 'unchecked',
      reason: 'testbench-unsubmittable',
    });
    expect(simulator.calls).toHaveLength(0);
  });
});

describe('RtllmInstrumentControl - what it submits', () => {
  it('submits the ALREADY-RENAMED reference RTL, so no second rename exists on this path', async () => {
    const { control: subject, simulator } = control(simulation());

    await subject.check(request());

    // The importer applied `renameTopModule`, so the reference declares the module name our
    // testbench instantiates. This path adds nothing.
    expect(simulator.calls[0]?.rtl).toEqual([reference('rtllm/memory/right_shifter').rtl]);
    expect(simulator.calls[0]?.rtl[0]?.contents).toContain('module right_shifter');
  });

  it('submits OUR testbench verbatim, under the control workspace filename', async () => {
    const { control: subject, simulator } = control(simulation());

    await subject.check(request('module tb; initial $finish; endmodule\n'));

    expect(simulator.calls[0]?.testbench).toEqual({
      path: CONTROL_TESTBENCH_WORKSPACE_FILENAME,
      contents: 'module tb; initial $finish; endmodule\n',
    });
  });
});
describe('RtllmInstrumentControl - the NEGATIVE control, folded in', () => {
  /** A probe report with the given kill count over eight VALID mutants. */
  function probed(killedCount: number): MutationProbeOutcome {
    return {
      kind: 'measured',
      report: {
        validCount: 8,
        killedCount,
        noVerdictKills: 0,
        // A survivor the INDEPENDENT judge killed: the coverage-gap bucket, which is the
        // actionable one and the shape the `multi_pipe_8bit` regression produced.
        coverageGapSurvivors:
          killedCount >= 8
            ? []
            : [
                {
                  mutantId: 'ARITH_PLUS_TO_MINUS@12:9',
                  operator: 'ARITH_PLUS_TO_MINUS',
                  site: { line: 12, column: 9, before: '+', after: '-' },
                },
              ],
        candidateEquivalentSurvivors: [],
        goldenKilledCount: 5,
        goldenTimeoutCount: 0,
        nonCompilingCount: 2,
        goldenErroredCount: 0,
        generatedCount: 10,
        elapsedMs: 6_000,
      },
    };
  }

  /**
   * A probe report whose survivors are ALL candidate-equivalent, over eight valid mutants.
   *
   * The measured `multi_pipe_8bit` shape for a GOOD testbench: it kills every mutant the golden
   * judge kills and survives only ones the judge also passed, so its kill rate is well under the
   * retired 0.95 bar while its coverage-gap list is empty.
   */
  function probedEquivalents(killedCount: number): MutationProbeOutcome {
    return {
      kind: 'measured',
      report: {
        validCount: 8,
        killedCount,
        noVerdictKills: 0,
        coverageGapSurvivors: [],
        candidateEquivalentSurvivors: [26, 39].map((line) => ({
          mutantId: `RESET_BRANCH_DISABLED@${line}:10`,
          operator: 'RESET_BRANCH_DISABLED' as const,
          site: { line, column: 10, before: '(!rst_n)', after: "(1'b0)" },
        })),
        goldenKilledCount: 6,
        goldenTimeoutCount: 0,
        nonCompilingCount: 2,
        goldenErroredCount: 0,
        generatedCount: 10,
        elapsedMs: 6_000,
      },
    };
  }

  /** A negative control returning a scripted outcome and recording every request. */
  function negative(outcome: MutationProbeOutcome): MutationNegativeControl & {
    readonly requests: MutationProbeRequest[];
  } {
    const requests: MutationProbeRequest[] = [];
    return {
      requests,
      probe(request: MutationProbeRequest): Promise<MutationProbeOutcome> {
        requests.push(request);
        return Promise.resolve(outcome);
      },
    };
  }

  /** A control with both phases wired, over one problem. */
  function bothPhases(
    positive: SimulationVerdict,
    negativeControl: MutationNegativeControl,
  ): RtllmInstrumentControl {
    return new RtllmInstrumentControl({
      simulator: new SpySimulator(positive),
      references: new Map([
        ['rtllm/memory/right_shifter', reference('rtllm/memory/right_shifter')],
      ]),
      negativeControl,
    });
  }

  it('reports VALID only when the reference passes AND no catchable mutant survives', async () => {
    const subject = bothPhases(simulation({ verdict: 'pass' }), negative(probed(8)));

    const result = await subject.check(request());

    expect(result?.verdict).toEqual({ validity: 'valid' });
    expect(result?.mutation?.killedCount).toBe(8);
  });

  it('reports INVALID / survived-mutants when the reference passes but a mutant lives', async () => {
    // The measured `multi_pipe_8bit` shape: its testbench passes the reference design, so the
    // positive control alone read it `valid` - and it also passes designs the golden judge fails.
    const subject = bothPhases(simulation({ verdict: 'pass' }), negative(probed(7)));

    const result = await subject.check(request());

    expect(result?.verdict).toEqual({
      validity: 'invalid',
      defect: 'TESTBENCH_SURVIVED_MUTANTS',
    });
    expect(result?.mutation?.coverageGapSurvivors[0]?.operator).toBe('ARITH_PLUS_TO_MINUS');
  });

  it('does NOT probe mutants when the positive control already falsified the testbench', async () => {
    // Spending a mutant set of simulations to reach the same conclusion under a vaguer defect
    // code would trade wall clock for less information.
    const probe = negative(probed(8));
    const subject = bothPhases(simulation({ verdict: 'fail', stdout: 'CHECK a FAIL\n' }), probe);

    const result = await subject.check(request());

    expect(probe.requests).toEqual([]);
    expect(result?.verdict).toEqual({
      validity: 'invalid',
      defect: 'TESTBENCH_FAILED_REFERENCE',
    });
    expect(result?.mutation).toBeNull();
  });

  it('hands the negative control the same testbench, problem and caps', async () => {
    const probe = negative(probed(8));

    await bothPhases(simulation({ verdict: 'pass' }), probe).check(
      request('module tb; endmodule\n'),
    );

    expect(probe.requests).toEqual([
      {
        problemId: 'rtllm/memory/right_shifter',
        testbench: 'module tb; endmodule\n',
        limits: LIMITS,
      },
    ]);
  });

  it('degrades to UNCHECKED with the probe reason, never to valid', async () => {
    const subject = bothPhases(
      simulation({ verdict: 'pass' }),
      negative({
        kind: 'unavailable',
        reason: 'no-valid-mutants',
      }),
    );

    const result = await subject.check(request());

    expect(result?.verdict).toEqual({
      validity: 'unchecked',
      reason: 'no-valid-mutants',
    });
    expect(result?.mutation).toBeNull();
  });

  it('applies the positive-control-only standard when no negative control is wired', async () => {
    const { control: subject } = control(simulation({ verdict: 'pass' }));

    const result = await subject.check(request());

    expect(result?.verdict).toEqual({ validity: 'valid' });
    expect(result?.mutation).toBeNull();
  });

  it('reports VALID for a partial kill whose survivors are all candidate-equivalent', async () => {
    // The false negative the retired kill-rate bar produced: 6/8 is 0.75, well under 0.95, but
    // every survivor is one the INDEPENDENT judge also passed - so nothing anyone has shown to
    // be catchable was missed, and calling this instrument broken would be the accusation that
    // is wrong. The kill rate is still recorded beside the verdict as a quality signal.
    const partial = bothPhases(simulation({ verdict: 'pass' }), negative(probedEquivalents(6)));

    const result = await partial.check(request());

    expect(result?.verdict).toEqual({ validity: 'valid' });
    expect(result?.mutation?.killedCount).toBe(6);
    expect(result?.mutation?.coverageGapSurvivors).toEqual([]);
    expect(result?.mutation?.candidateEquivalentSurvivors).toHaveLength(2);
  });
});
