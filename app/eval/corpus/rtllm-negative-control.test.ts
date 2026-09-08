// Unit tests for the RTLLM-backed NEGATIVE CONTROL.
//
// WHAT THESE PIN DOWN
//   1. Our testbench is run against every VALID mutant - every mutant that COMPILES - and not
//      only the ones the independent golden testbench kills. A golden pass may no longer shrink
//      the denominator, because it is evidence about the judge's stimulus and not proof of
//      equivalence, and the mutants the judge is blind to are the population a missed bug comes
//      from.
//   2. A PASS on a mutant is a SURVIVOR, identified by operator and site, and bucketed by the
//      golden verdict on the SAME mutant: `coverageGapSurvivors` when the judge killed it (a
//      definite gap in ours), `candidateEquivalentSurvivors` when it did not (flagged, still
//      counted). That identification is the actionable output; a bare kill rate is not.
//   3. Any NON-PASS is a kill, and the two kill kinds are counted APART. A `fail` is a reported
//      failure. An `error` - a timeout, a crash, an empty capture - is still a kill, because the
//      mutant produced an observable behavioural difference, but it is recorded as
//      `noVerdictKills` so a timeout-heavy result cannot read as coverage.
//   4. Every degenerate case is reported with its OWN reason: no reference, no mutants, and -
//      the important one - no VALID mutants, where the probe proves nothing and must not be
//      reportable as a success.
//   5. It never throws. A probe that falls over degrades to `probe-errored` and can only move a
//      sample out of the pass@k denominator.
//
// Driven through fakes: no toolchain, no disk, no model.

import { describe, expect, it } from 'vitest';

import type { ResourceLimits, SimulationVerdict, SimulatorAdapter, SourceFile } from '@app/tools';

import type { MutationConfig, MutationProbeOutcome } from '../mutation-control.js';
import type { GoldenTestbench, ReferenceDesign } from './corpus-types.js';
import type { GoldenScore, GoldenTestbenchScorer } from './golden-scorer.js';
import { RtllmMutationCalibrator } from './mutation-calibration.js';
import {
  MUTANT_WORKSPACE_FILENAME,
  NEGATIVE_CONTROL_TESTBENCH_FILENAME,
  RtllmMutationNegativeControl,
} from './rtllm-negative-control.js';
import {
  allSurvivors,
  DEFAULT_MUTATION_CONFIG,
  reportedFailureKills,
} from '../mutation-control.js';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5_000 };

const PROBLEM_ID = 'rtllm/control/counter';

/** OUR generated testbench, as the loop's outcome carries it. */
const TESTBENCH = 'module counter_tb; endmodule\n';

const REFERENCE_RTL = `module counter (input clk, input rst_n, output reg [7:0] q);
  always @(posedge clk or negedge rst_n)
    if (!rst_n)
      q <= 8'd0;
    else
      q <= q + 1;
endmodule
`;

/** Four mutants, so a partial kill is expressible without a long fixture. */
const CONFIG: MutationConfig = {
  maxMutantsPerProblem: 4,
  operators: DEFAULT_MUTATION_CONFIG.operators,
};

/** The mutant wall cap, deliberately far below `LIMITS.wallMs` so the substitution is visible. */
const MUTANT_WALL_MS = 500;

/** The calibration cache key these tests calibrate under; no cache is wired, so it only keys. */
const CACHE_KEY = {
  corpusCommit: 'commit1',
  mutationConfigHash: 'hash1',
  mutantWallMs: MUTANT_WALL_MS,
} as const;

/** A simulation verdict with the given outcome and no interesting diagnostics. */
function simulation(verdict: SimulationVerdict['verdict']): SimulationVerdict {
  return {
    verdict,
    checks: [],
    vcd: null,
    stdout: '',
    stderr: '',
    exitCode: verdict === 'error' ? null : 0,
    resourceUsage: { cpuMs: 1, wallMs: 1, maxMemMb: 1 },
  };
}

/** A simulator answering per the RTL it is handed, and recording every call. */
class SpySimulator implements SimulatorAdapter {
  readonly calls: {
    readonly rtl: readonly SourceFile[];
    readonly testbench: SourceFile;
    readonly limits: ResourceLimits;
  }[] = [];

  constructor(private readonly answer: (callIndex: number) => SimulationVerdict) {}

  simulate(
    rtl: readonly SourceFile[],
    testbench: SourceFile,
    limits: ResourceLimits,
  ): Promise<SimulationVerdict> {
    const callIndex = this.calls.length;
    this.calls.push({ rtl, testbench, limits });
    return Promise.resolve(this.answer(callIndex));
  }
}

/** One golden score with the given verdict kind. */
function goldenScore(kind: GoldenScore['verdict']['kind']): GoldenScore {
  return {
    problemId: PROBLEM_ID,
    verdict: { kind, failureCount: kind === 'failed' ? 1 : null, banners: [] },
    timedOut: false,
    diskLimitExceeded: false,
    exitCode: 0,
    diagnostics: kind === 'error' ? 'dut_mutant.v:4: syntax error' : '',
  };
}

/** A golden scorer with one fixed verdict for every mutant. */
function fixedScorer(kind: GoldenScore['verdict']['kind']): GoldenTestbenchScorer {
  return scriptedScorer(() => kind);
}

/**
 * A golden scorer answering per mutant index, so the two survivor buckets are separable.
 *
 * The buckets are the point of this module now, and they can only be exercised by a judge that
 * kills SOME mutants and passes others - a single fixed verdict collapses them.
 */
function scriptedScorer(
  kindAt: (callIndex: number) => GoldenScore['verdict']['kind'],
): GoldenTestbenchScorer {
  let callIndex = 0;
  return {
    score: (): Promise<GoldenScore> => Promise.resolve(goldenScore(kindAt(callIndex++))),
  };
}

function reference(): ReferenceDesign {
  return {
    problemId: PROBLEM_ID,
    rtl: { path: 'dut_reference.v', contents: REFERENCE_RTL },
    topModuleRenamedFrom: 'verified_counter',
  };
}

function golden(): GoldenTestbench {
  return {
    problemId: PROBLEM_ID,
    moduleName: 'counter',
    testbench: { path: 'testbench.v', contents: 'module tb; endmodule\n' },
    dataFiles: [],
    overriddenParameters: [],
  };
}

/**
 * A control over the fakes.
 *
 * `goldenKind` is the INDEPENDENT judge's answer - a single kind, or a function of the mutant
 * index when a test needs the survivor buckets to differ. It no longer decides which mutants are
 * scored; it decides only how a survivor is bucketed.
 */
function control(
  goldenKind:
    GoldenScore['verdict']['kind'] | ((callIndex: number) => GoldenScore['verdict']['kind']),
  ourAnswer: (callIndex: number) => SimulationVerdict,
  parts: { readonly references?: ReadonlyMap<string, ReferenceDesign> } = {},
): { readonly subject: RtllmMutationNegativeControl; readonly simulator: SpySimulator } {
  const simulator = new SpySimulator(ourAnswer);
  let tick = 0;
  return {
    simulator,
    subject: new RtllmMutationNegativeControl({
      simulator,
      calibrator: new RtllmMutationCalibrator({
        scorer:
          typeof goldenKind === 'function' ? scriptedScorer(goldenKind) : fixedScorer(goldenKind),
        golden: new Map([[PROBLEM_ID, golden()]]),
        references: parts.references ?? new Map([[PROBLEM_ID, reference()]]),
        config: CONFIG,
        mutantWallMs: MUTANT_WALL_MS,
        cacheKey: CACHE_KEY,
      }),
      now: () => {
        tick += 250;
        return tick;
      },
    }),
  };
}

/** One probe against the controlled problem. */
function probe(
  subject: RtllmMutationNegativeControl,
  testbench = TESTBENCH,
): Promise<MutationProbeOutcome> {
  return subject.probe({ problemId: PROBLEM_ID, testbench, limits: LIMITS });
}

describe('RtllmMutationNegativeControl - what a kill and a survivor are', () => {
  it('kills a mutant our testbench FAILS, and reports a full kill rate', async () => {
    const { subject } = control('failed', () => simulation('fail'));

    const outcome = await probe(subject);

    expect(outcome.kind).toBe('measured');
    if (outcome.kind !== 'measured') {
      return;
    }
    expect(outcome.report.validCount).toBe(4);
    expect(outcome.report.killedCount).toBe(4);
    expect(outcome.report.noVerdictKills).toBe(0);
    expect(allSurvivors(outcome.report)).toEqual([]);
  });

  it('counts an ERROR on a mutant as a kill, recorded DISTINCTLY as no-verdict', async () => {
    // Both `fail` and `error` refuse to certify, and the Verification_Loop can mint `Verified`
    // from neither, so both are kills - Stryker counts a mutant that hangs the run as detected
    // for the same reason. But an absent verdict is weaker evidence than a reported failure, so
    // it is counted apart: a run whose kills are all timeouts must not read as coverage.
    const { subject } = control('failed', () => simulation('error'));

    const outcome = await probe(subject);

    expect(outcome.kind).toBe('measured');
    if (outcome.kind !== 'measured') {
      return;
    }
    expect(outcome.report.killedCount).toBe(4);
    expect(outcome.report.noVerdictKills).toBe(4);
    expect(reportedFailureKills(outcome.report)).toBe(0);
  });

  it('keeps the two kill kinds apart within one probe', async () => {
    const { subject } = control('failed', (index) =>
      simulation(index % 2 === 0 ? 'fail' : 'error'),
    );

    const outcome = await probe(subject);

    expect(outcome.kind).toBe('measured');
    if (outcome.kind !== 'measured') {
      return;
    }
    expect(outcome.report.killedCount).toBe(4);
    expect(outcome.report.noVerdictKills).toBe(2);
    expect(reportedFailureKills(outcome.report)).toBe(2);
  });

  it('records a mutant our testbench PASSES as a survivor, with its operator and site', async () => {
    const { subject } = control('failed', (index) => simulation(index === 1 ? 'pass' : 'fail'));

    const outcome = await probe(subject);

    expect(outcome.kind).toBe('measured');
    if (outcome.kind !== 'measured') {
      return;
    }
    expect(outcome.report.killedCount).toBe(3);
    const survivors = allSurvivors(outcome.report);
    expect(survivors).toHaveLength(1);
    const survivor = survivors[0];
    expect(survivor?.operator).toBeDefined();
    expect(survivor?.site.line).toBeGreaterThan(0);
    expect(survivor?.mutantId).toBe(
      `${survivor?.operator ?? ''}@${survivor?.site.line ?? 0}:${survivor?.site.column ?? 0}`,
    );
  });

  it('accounts for every valid mutant as either a kill or a survivor', async () => {
    // The report's stated invariant. If it ever failed, the kill rate would be a fraction of a
    // population that does not add up, which is the class of defect this whole fix is about.
    const { subject } = control(
      (index) => (index < 2 ? 'failed' : 'passed'),
      (index) => simulation(index < 3 ? 'fail' : 'pass'),
    );

    const outcome = await probe(subject);

    expect(outcome.kind).toBe('measured');
    if (outcome.kind !== 'measured') {
      return;
    }
    const { validCount, killedCount } = outcome.report;
    expect(killedCount + allSurvivors(outcome.report).length).toBe(validCount);
  });

  it('does not short-circuit once the threshold is provably missed', async () => {
    // Stopping early would save wall clock and destroy the only actionable output: the FULL
    // list of defect classes our testbench does not notice.
    const { subject, simulator } = control('failed', () => simulation('pass'));

    const outcome = await probe(subject);

    expect(simulator.calls).toHaveLength(4);
    expect(outcome.kind === 'measured' && allSurvivors(outcome.report)).toHaveLength(4);
  });

  it('drives OUR testbench against the MUTANT rtl, under the caller-supplied caps', async () => {
    const { subject, simulator } = control('failed', () => simulation('fail'));

    await probe(subject);

    for (const call of simulator.calls) {
      expect(call.testbench).toEqual({
        path: NEGATIVE_CONTROL_TESTBENCH_FILENAME,
        contents: TESTBENCH,
      });
      expect(call.rtl[0]?.path).toBe(MUTANT_WORKSPACE_FILENAME);
      expect(call.rtl[0]?.contents).not.toBe(REFERENCE_RTL);
    }
  });

  it('carries the calibration facts through, so the summary can report them', async () => {
    const { subject } = control('failed', () => simulation('fail'));

    const outcome = await probe(subject);

    expect(outcome.kind === 'measured' && outcome.report.generatedCount).toBe(4);
    expect(outcome.kind === 'measured' && outcome.report.nonCompilingCount).toBe(0);
    expect(outcome.kind === 'measured' && outcome.report.goldenKilledCount).toBe(4);
  });

  it('measures the wall clock it added, so the per-sample cost is reportable', async () => {
    const { subject } = control('failed', () => simulation('fail'));

    const outcome = await probe(subject);

    expect(outcome.kind === 'measured' && outcome.report.elapsedMs).toBeGreaterThan(0);
  });
});

describe('RtllmMutationNegativeControl - the golden verdict buckets survivors, nothing more', () => {
  it('scores our testbench over mutants the golden testbench PASSED, not only the ones it kills', async () => {
    // The regression this suite was rewritten around. Under the old rule this probe reported
    // `no-detectable-mutants` and our testbench was never run - so a testbench that passes
    // everything the judge is blind to came back unchecked instead of caught.
    const { subject, simulator } = control('passed', () => simulation('pass'));

    const outcome = await probe(subject);

    expect(outcome.kind).toBe('measured');
    if (outcome.kind !== 'measured') {
      return;
    }
    expect(simulator.calls).toHaveLength(4);
    expect(outcome.report.validCount).toBe(4);
    expect(outcome.report.killedCount).toBe(0);
    expect(outcome.report.goldenKilledCount).toBe(0);
  });

  it('puts a survivor the judge KILLED in the coverage-gap bucket', async () => {
    // The actionable half: the independent judge has demonstrated this bug is catchable, and
    // ours did not catch it. Nothing else in the run is this directly a work item.
    const { subject } = control('failed', () => simulation('pass'));

    const outcome = await probe(subject);

    expect(outcome.kind).toBe('measured');
    if (outcome.kind !== 'measured') {
      return;
    }
    expect(outcome.report.coverageGapSurvivors).toHaveLength(4);
    expect(outcome.report.candidateEquivalentSurvivors).toEqual([]);
  });

  it('puts a survivor the judge ALSO passed in the candidate-equivalent bucket', async () => {
    const { subject } = control('passed', () => simulation('pass'));

    const outcome = await probe(subject);

    expect(outcome.kind).toBe('measured');
    if (outcome.kind !== 'measured') {
      return;
    }
    expect(outcome.report.candidateEquivalentSurvivors).toHaveLength(4);
    expect(outcome.report.coverageGapSurvivors).toEqual([]);
  });

  it('splits the two buckets within one probe, by the verdict on EACH mutant', async () => {
    // The pairing has to hold per mutant. A bucket assignment driven by an aggregate would put
    // a definite coverage gap in the "maybe equivalent" list, or the reverse.
    const { subject } = control(
      (index) => (index < 2 ? 'failed' : 'passed'),
      () => simulation('pass'),
    );

    const outcome = await probe(subject);

    expect(outcome.kind).toBe('measured');
    if (outcome.kind !== 'measured') {
      return;
    }
    expect(outcome.report.coverageGapSurvivors).toHaveLength(2);
    expect(outcome.report.candidateEquivalentSurvivors).toHaveLength(2);
    expect(outcome.report.goldenKilledCount).toBe(2);
  });

  it('reports no-valid-mutants when every mutant failed to build', async () => {
    // The one remaining degenerate case, and it must never read as valid: with nothing valid,
    // our failing to kill anything says nothing at all.
    const { subject, simulator } = control('error', () => simulation('pass'));

    expect(await probe(subject)).toEqual({ kind: 'unavailable', reason: 'no-valid-mutants' });
    // And our testbench was never run, so the probe cost nothing beyond calibration.
    expect(simulator.calls).toEqual([]);
  });
});

describe('RtllmMutationNegativeControl - degenerate cases each get their own reason', () => {
  it('reports no-reference when the corpus holds no reference design to mutate', async () => {
    const { subject } = control('failed', () => simulation('fail'), { references: new Map() });

    expect(await probe(subject)).toEqual({ kind: 'unavailable', reason: 'no-reference' });
  });

  it('reports no-mutants-generated when no operator finds a site in the reference', async () => {
    const shapeless = new Map([
      [
        PROBLEM_ID,
        {
          problemId: PROBLEM_ID,
          rtl: { path: 'dut_reference.v', contents: 'module m; endmodule\n' },
          topModuleRenamedFrom: null,
        },
      ],
    ]);
    const { subject } = control('failed', () => simulation('fail'), { references: shapeless });

    expect(await probe(subject)).toEqual({
      kind: 'unavailable',
      reason: 'no-mutants-generated',
    });
  });

  it('reports probe-errored for a testbench it will not submit', async () => {
    const { subject } = control('failed', () => simulation('fail'));

    expect(await probe(subject, '')).toEqual({ kind: 'unavailable', reason: 'probe-errored' });
  });
});

describe('RtllmMutationNegativeControl - mutant runs get the MUTANT wall cap', () => {
  it('given a student wall clock, when our testbench probes a mutant, then only wallMs is replaced', async () => {
    // GIVEN a student session at 30s and a mutant cap far below it.
    const studentLimits: ResourceLimits = { ...LIMITS, wallMs: 30_000 };
    const { subject, simulator } = control('failed', () => simulation('fail'));

    // WHEN the probe runs our testbench against every valid mutant.
    await subject.probe({ problemId: PROBLEM_ID, testbench: TESTBENCH, limits: studentLimits });

    // THEN a mutant that hangs OUR testbench costs the mutant cap, not the session's - and every
    // other cap is the session's, because only the RTL under the testbench may differ.
    expect(simulator.calls).toHaveLength(4);
    for (const call of simulator.calls) {
      expect(call.limits.wallMs).toBe(MUTANT_WALL_MS);
      expect(call.limits.cpu).toBe(studentLimits.cpu);
      expect(call.limits.memMb).toBe(studentLimits.memMb);
      expect(call.limits.procs).toBe(studentLimits.procs);
      expect(call.limits.diskMb).toBe(studentLimits.diskMb);
    }
    // And the loop's own cap is untouched, so the sample's other simulations are unaffected.
    expect(studentLimits.wallMs).toBe(30_000);
  });

  it('reads the cap from the CALIBRATOR, so judge and testbench share one clock', async () => {
    // A second copy of the knob could drift, and then the independent judge and our own testbench
    // would be answering "does this mutant hang?" under different caps - which would make a
    // coverage gap a wall-clock artefact.
    const calibratorAtOneSecond = new RtllmMutationCalibrator({
      scorer: fixedScorer('failed'),
      golden: new Map([[PROBLEM_ID, golden()]]),
      references: new Map([[PROBLEM_ID, reference()]]),
      config: CONFIG,
      mutantWallMs: 1_000,
      cacheKey: { ...CACHE_KEY, mutantWallMs: 1_000 },
    });
    const simulator = new SpySimulator(() => simulation('fail'));

    await new RtllmMutationNegativeControl({
      simulator,
      calibrator: calibratorAtOneSecond,
    }).probe({ problemId: PROBLEM_ID, testbench: TESTBENCH, limits: LIMITS });

    expect(calibratorAtOneSecond.mutantWallMs).toBe(1_000);
    expect(simulator.calls.map((call) => call.limits.wallMs)).toEqual([1_000, 1_000, 1_000, 1_000]);
  });
});

describe('RtllmMutationNegativeControl - it never throws', () => {
  it('degrades to probe-errored when the simulator falls over', async () => {
    const throwing: SimulatorAdapter = {
      simulate: () => Promise.reject(new Error('the sandbox died at /private/var/tmp/x')),
    };
    const subject = new RtllmMutationNegativeControl({
      simulator: throwing,
      calibrator: new RtllmMutationCalibrator({
        scorer: fixedScorer('failed'),
        golden: new Map([[PROBLEM_ID, golden()]]),
        references: new Map([[PROBLEM_ID, reference()]]),
        config: CONFIG,
        mutantWallMs: MUTANT_WALL_MS,
        cacheKey: CACHE_KEY,
      }),
    });

    const outcome = await probe(subject);

    expect(outcome).toEqual({ kind: 'unavailable', reason: 'probe-errored' });
    // Sanitized: the thrown detail names a sandbox path and never reaches the outcome.
    expect(JSON.stringify(outcome)).not.toContain('/private/var/tmp');
  });

  it('degrades to probe-errored when the calibrator falls over', async () => {
    const throwingScorer: GoldenTestbenchScorer = {
      score: () => Promise.reject(new Error('the golden scorer died')),
    };
    const subject = new RtllmMutationNegativeControl({
      simulator: new SpySimulator(() => simulation('fail')),
      calibrator: new RtllmMutationCalibrator({
        scorer: throwingScorer,
        golden: new Map([[PROBLEM_ID, golden()]]),
        references: new Map([[PROBLEM_ID, reference()]]),
        config: CONFIG,
        mutantWallMs: MUTANT_WALL_MS,
        cacheKey: CACHE_KEY,
      }),
    });

    expect(await probe(subject)).toEqual({ kind: 'unavailable', reason: 'probe-errored' });
  });
});
