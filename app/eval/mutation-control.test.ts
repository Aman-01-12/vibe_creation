// Unit tests for the NEGATIVE CONTROL's vocabulary, its threshold, and its aggregation.
//
// THE FOUR RULES THAT MATTER MOST HERE
//   1. The GATE is zero coverage-gap survivors: our testbench must kill every valid mutant the
//      INDEPENDENT golden testbench killed. Those are proven catchable by a third party, so a
//      survivor among them is provably our defect - and a genuine equivalent mutant can never
//      enter the requirement, because the judge did not kill it either.
//   2. The KILL RATE's denominator is every VALID mutant - every mutant that compiles - and NOT
//      the subset the golden testbench kills, because scoring ourselves on the judge's own reach
//      excuses us for whatever it is blind to. That width is also why it informs and never
//      gates: it necessarily contains mutants no testbench can kill.
//   3. Both VACUOUS cases read as unproven, never as a pass. An empty valid set and an empty
//      golden-killed set each make "killed everything catchable" true by saying nothing, which
//      is the exact false claim the whole seam exists to prevent.
//   4. The per-PROBLEM calibration facts are counted ONCE PER PROBLEM. Summing them per sample
//      would multiply a corpus fact by the sample count and report a mutant total that never
//      existed.

import { describe, expect, it } from 'vitest';

import type { ResourceLimits } from '@app/tools';

import {
  allSurvivors,
  canonicalMutationConfig,
  DEFAULT_MUTANT_WALL_MS,
  DEFAULT_MUTATION_CONFIG,
  describeMutationUnavailable,
  judgeCoverageGaps,
  killRateOf,
  MAX_MUTANT_WALL_MS,
  MIN_MUTANT_WALL_MS,
  mutantIdOf,
  mutantIsValid,
  mutantRunLimits,
  mutantWasGoldenKilled,
  MUTATION_OPERATORS,
  mutationControlMeasured,
  NO_MUTATION_CONTROL_MEASURED,
  recordedMutationCounts,
  reportedFailureKills,
  summarizeMutationControl,
  type MutantCalibration,
  type MutantIdentity,
  type MutationOperatorId,
  type MutationProbeReport,
  type MutationSample,
  tallySurvivedOperators,
  type MutationSampleCounts,
  type MutationUnavailableReason,
} from './mutation-control.js';

/** One survivor identity for a named operator, so a bucket can be checked by operator. */
function survivor(operator: MutationOperatorId, line: number): MutantIdentity {
  const site = { line, column: 7, before: '+', after: '-' };
  return { mutantId: mutantIdOf(operator, site), operator, site };
}

/** One probe report; each test states only the part it is about. */
function probe(overrides: Partial<MutationProbeReport> = {}): MutationProbeReport {
  return {
    validCount: 10,
    killedCount: 10,
    noVerdictKills: 0,
    coverageGapSurvivors: [],
    candidateEquivalentSurvivors: [],
    goldenKilledCount: 6,
    goldenTimeoutCount: 0,
    nonCompilingCount: 2,
    goldenErroredCount: 0,
    generatedCount: 12,
    elapsedMs: 5_000,
    ...overrides,
  };
}

/** One persisted per-sample count block; each test states only what it is about. */
function counts(overrides: Partial<MutationSampleCounts> = {}): MutationSampleCounts {
  return {
    validCount: 10,
    killedCount: 10,
    noVerdictKills: 0,
    coverageGapOperators: [],
    candidateEquivalentOperators: [],
    goldenSurvivedCount: 4,
    goldenTimeoutCount: 0,
    nonCompilingCount: 2,
    goldenErroredCount: 0,
    elapsedMs: 5_000,
    ...overrides,
  };
}

describe('judgeCoverageGaps - THE gate: zero independently-proven-catchable survivors', () => {
  it('given no coverage-gap survivor, when judged, then the gate is closed', () => {
    // Our testbench killed every valid mutant the independent judge killed. That is the whole
    // requirement, and nothing about the rate enters it.
    expect(judgeCoverageGaps(probe({ validCount: 10, killedCount: 10 }))).toBe('closed');
  });

  it('given ONE coverage-gap survivor, when judged, then the gate is open', () => {
    // One mutant the golden testbench killed and ours did not. A third party has demonstrated
    // the bug is catchable at the ports, so missing it is unambiguously our defect - and one is
    // enough, because each survivor is a defect class that can mint a false `Verified`.
    expect(
      judgeCoverageGaps(
        probe({
          validCount: 10,
          killedCount: 9,
          coverageGapSurvivors: [survivor('ARITH_PLUS_TO_MINUS', 69)],
        }),
      ),
    ).toBe('open');
  });

  it('given a LOW kill rate with zero coverage gaps, when judged, then the gate is closed', () => {
    // THE CASE THE OLD GATE GOT WRONG, in the shape it was measured in. On
    // `rtllm/arithmetic/multi_pipe_8bit` the discriminating testbench kills 4 of 6 valid mutants
    // - including two the golden judge itself misses - and survives two `RESET_BRANCH_DISABLED`
    // mutants the judge also passed, at least one of which is very likely a TRUE equivalent. The
    // 0.95 rate bar called that instrument INVALID at 0.667. It is not: it missed nothing anyone
    // has shown is catchable.
    const goodInstrument = probe({
      validCount: 6,
      killedCount: 4,
      goldenKilledCount: 2,
      coverageGapSurvivors: [],
      candidateEquivalentSurvivors: [
        survivor('RESET_BRANCH_DISABLED', 26),
        survivor('RESET_BRANCH_DISABLED', 39),
      ],
    });

    expect(killRateOf(goodInstrument)).toBeCloseTo(0.667, 2);
    expect(judgeCoverageGaps(goodInstrument)).toBe('closed');
  });

  it('given zero valid mutants, when judged, then the gate has nothing to say', () => {
    // The first vacuity trap: with nothing compiling, "killed every catchable mutant" is
    // vacuously true. It must read as unproven, never as closed.
    expect(judgeCoverageGaps(probe({ validCount: 0, killedCount: 0, goldenKilledCount: 0 }))).toBe(
      'no-valid-mutants',
    );
  });

  it('given zero GOLDEN-KILLED mutants, when judged, then the gate is vacuous', () => {
    // The same trap one level in, and the reason it needs its own reason: the independent judge
    // killed nothing here, so the requirement "kill everything the judge kills" is EMPTY and a
    // testbench that kills nothing at all would satisfy it. Nothing was proven catchable, so
    // nothing about our instrument was proven.
    const blindJudge = probe({
      validCount: 6,
      killedCount: 0,
      goldenKilledCount: 0,
      candidateEquivalentSurvivors: [
        survivor('ARITH_PLUS_TO_MINUS', 69),
        survivor('RESET_BRANCH_DISABLED', 26),
      ],
    });

    expect(blindJudge.coverageGapSurvivors).toEqual([]);
    expect(judgeCoverageGaps(blindJudge)).toBe('no-golden-killed-mutants');
  });

  it('given ANY gate outcome, when the rate is read, then it is still reported', () => {
    // The kill rate did not go away when it stopped gating - it is the quality signal an
    // operator tunes the Testbench_Agent against, and it must be available for every outcome
    // including the two vacuous ones. `null` only ever means "no denominator", never "zero".
    const cases: readonly MutationProbeReport[] = [
      probe({ validCount: 10, killedCount: 10 }),
      probe({
        validCount: 10,
        killedCount: 9,
        coverageGapSurvivors: [survivor('ARITH_PLUS_TO_MINUS', 69)],
      }),
      probe({ validCount: 6, killedCount: 0, goldenKilledCount: 0 }),
    ];

    for (const report of cases) {
      expect(killRateOf(report)).toBe(report.killedCount / report.validCount);
    }
    // The one case with no rate to report is the one with no denominator, and it says so.
    expect(killRateOf(probe({ validCount: 0, killedCount: 0, goldenKilledCount: 0 }))).toBeNull();
  });

  it('given a timeout-only kill of the catchable mutants, when judged, then the gate closes', () => {
    // Stryker's precedent: a mutant that hangs the run produced an observable behavioural
    // difference, so it is detected. Weaker evidence, so it is counted apart - not discounted.
    const timeouts = probe({ validCount: 4, killedCount: 4, noVerdictKills: 4 });

    expect(judgeCoverageGaps(timeouts)).toBe('closed');
    expect(reportedFailureKills(timeouts)).toBe(0);
  });
});

describe('reportedFailureKills - the two kill kinds stay separable', () => {
  it('derives the reported-failure kills as the complement of the no-verdict ones', () => {
    expect(reportedFailureKills(probe({ killedCount: 9, noVerdictKills: 4 }))).toBe(5);
  });

  it('never reports a negative count from an inconsistent report', () => {
    // Unreachable from the probe, which counts both from the same loop; total anyway, because
    // this feeds a rendered line and a negative kill count would be nonsense on a report.
    expect(reportedFailureKills(probe({ killedCount: 2, noVerdictKills: 5 }))).toBe(0);
  });
});

describe('killRateOf - a rate is only a rate when it has a denominator', () => {
  it('reports the fraction of VALID mutants killed', () => {
    expect(killRateOf(probe({ validCount: 8, killedCount: 6 }))).toBeCloseTo(0.75, 10);
  });

  it('reports null rather than 0 when nothing was valid', () => {
    // Zero would read as "killed nothing", which is a different and much worse claim.
    expect(killRateOf(probe({ validCount: 0, killedCount: 0 }))).toBeNull();
  });
});

describe('allSurvivors - both buckets, coverage gaps first', () => {
  it('concatenates the two buckets with the actionable one leading', () => {
    const gap = survivor('ARITH_PLUS_TO_MINUS', 69);
    const equivalent = survivor('RESET_BRANCH_DISABLED', 26);

    expect(
      allSurvivors(
        probe({ coverageGapSurvivors: [gap], candidateEquivalentSurvivors: [equivalent] }),
      ),
    ).toEqual([gap, equivalent]);
  });

  it('is empty when nothing survived', () => {
    expect(allSurvivors(probe())).toEqual([]);
  });
});

describe('recordedMutationCounts - one owner of the probe -> record projection', () => {
  it('derives the golden-survived count from the valid and golden-killed counts', () => {
    const projected = recordedMutationCounts(probe({ validCount: 10, goldenKilledCount: 6 }));

    expect(projected?.goldenSurvivedCount).toBe(4);
    expect(projected?.validCount).toBe(10);
  });

  it('keeps the two survivor buckets apart, as operator ids only', () => {
    const projected = recordedMutationCounts(
      probe({
        killedCount: 8,
        coverageGapSurvivors: [survivor('ARITH_PLUS_TO_MINUS', 69)],
        candidateEquivalentSurvivors: [survivor('RESET_BRANCH_DISABLED', 26)],
      }),
    );

    // Merged, a campaign could no longer tell a definite coverage gap from a mutant nobody has
    // shown to be killable, and those two are different work items.
    expect(projected?.coverageGapOperators).toEqual(['ARITH_PLUS_TO_MINUS']);
    expect(projected?.candidateEquivalentOperators).toEqual(['RESET_BRANCH_DISABLED']);
  });

  it('carries no site excerpt into the record', () => {
    const projected = recordedMutationCounts(
      probe({ coverageGapSurvivors: [survivor('ARITH_PLUS_TO_MINUS', 69)] }),
    );

    // The record is the artifact a number is cited from, so it holds closed-set ids only; the
    // line, column, and source excerpt stay in the per-sample artifacts.
    expect(JSON.stringify(projected)).not.toContain('line');
  });

  it('projects an unprobed sample to no evidence at all', () => {
    expect(recordedMutationCounts(null)).toBeNull();
  });
});

describe('canonicalMutationConfig - the cache key input', () => {
  it('is stable under the order the operators are listed in', () => {
    // Two configs naming the same operators must hash the same, or a hand-written config with
    // its list reordered would needlessly invalidate a whole corpus of cached calibrations.
    const forward = canonicalMutationConfig({
      maxMutantsPerProblem: 8,
      operators: ['ARITH_PLUS_TO_MINUS', 'CONST_ZERO_TO_ONE'],
    });
    const reversed = canonicalMutationConfig({
      maxMutantsPerProblem: 8,
      operators: ['CONST_ZERO_TO_ONE', 'ARITH_PLUS_TO_MINUS'],
    });

    expect(forward).toBe(reversed);
  });

  it('changes when the cap changes, because the cap changes which mutants exist', () => {
    const narrow = canonicalMutationConfig({ ...DEFAULT_MUTATION_CONFIG, maxMutantsPerProblem: 8 });
    const wide = canonicalMutationConfig({ ...DEFAULT_MUTATION_CONFIG, maxMutantsPerProblem: 24 });

    expect(narrow).not.toBe(wide);
  });

  it('changes when the operator set changes', () => {
    const every = canonicalMutationConfig(DEFAULT_MUTATION_CONFIG);
    const fewer = canonicalMutationConfig({
      ...DEFAULT_MUTATION_CONFIG,
      operators: MUTATION_OPERATORS.slice(0, 3),
    });

    expect(every).not.toBe(fewer);
  });
});

describe('mutantIdOf - one spelling, shared by the cache and the report', () => {
  it('derives the id from the operator and the site', () => {
    expect(
      mutantIdOf('ARITH_PLUS_TO_MINUS', { line: 12, column: 7, before: '+', after: '-' }),
    ).toBe('ARITH_PLUS_TO_MINUS@12:7');
  });
});

describe('summarizeMutationControl - the numbers an operator acts on', () => {
  it('sums kills and VALID mutants over probed samples and reports the rate', () => {
    const report = summarizeMutationControl([
      { problemId: 'p1', probe: counts({ validCount: 10, killedCount: 8 }) },
      { problemId: 'p2', probe: counts({ validCount: 10, killedCount: 10 }) },
    ]);

    expect(report.probedSamples).toBe(2);
    expect(report.validMutants).toBe(20);
    expect(report.killedMutants).toBe(18);
    expect(report.killRate).toBeCloseTo(0.9, 10);
  });

  it('sums the no-verdict kills, so a timeout-heavy run cannot hide in the rate', () => {
    const report = summarizeMutationControl([
      { problemId: 'p1', probe: counts({ killedCount: 10, noVerdictKills: 7 }) },
      { problemId: 'p2', probe: counts({ killedCount: 10, noVerdictKills: 1 }) },
    ]);

    expect(report.killedMutants).toBe(20);
    expect(report.noVerdictKills).toBe(8);
  });

  it('counts the per-PROBLEM calibration facts ONCE PER PROBLEM, not once per sample', () => {
    // Two samples of one problem share one calibration. Summing would report 8 golden-blind
    // mutants where 4 exist, describing the corpus as twice as blind as it is.
    const report = summarizeMutationControl([
      { problemId: 'p1', probe: counts({ goldenSurvivedCount: 4, nonCompilingCount: 2 }) },
      { problemId: 'p1', probe: counts({ goldenSurvivedCount: 4, nonCompilingCount: 2 }) },
      { problemId: 'p2', probe: counts({ goldenSurvivedCount: 5, nonCompilingCount: 1 }) },
    ]);

    expect(report.goldenSurvivedMutants).toBe(9);
    expect(report.nonCompilingMutants).toBe(3);
    // The kill counts, which ARE per sample, still sum over all three.
    expect(report.probedSamples).toBe(3);
  });

  it('tallies coverage-gap operators most-frequent-first, ties broken by name', () => {
    const gaps: readonly MutationOperatorId[][] = [
      ['ARITH_PLUS_TO_MINUS', 'CONST_ZERO_TO_ONE'],
      ['ARITH_PLUS_TO_MINUS'],
      ['ARITH_PLUS_TO_MINUS', 'RESET_BRANCH_DISABLED'],
    ];
    const report = summarizeMutationControl(
      gaps.map((coverageGapOperators, index) => ({
        problemId: `p${index}`,
        probe: counts({ coverageGapOperators, killedCount: 8 }),
      })),
    );

    expect(report.coverageGapOperators).toEqual([
      { operator: 'ARITH_PLUS_TO_MINUS', count: 3 },
      { operator: 'CONST_ZERO_TO_ONE', count: 1 },
      { operator: 'RESET_BRANCH_DISABLED', count: 1 },
    ]);
  });

  it('tallies the candidate-equivalent bucket SEPARATELY from the coverage gaps', () => {
    // The whole point of keeping two lists: a definite gap and a maybe-equivalent mutant must
    // never be pooled into one number an operator would read as a defect count.
    const report = summarizeMutationControl([
      {
        problemId: 'p1',
        probe: counts({
          killedCount: 8,
          coverageGapOperators: ['ARITH_PLUS_TO_MINUS'],
          candidateEquivalentOperators: ['RESET_BRANCH_DISABLED', 'INDEX_OFF_BY_ONE'],
        }),
      },
    ]);

    expect(report.coverageGapOperators).toEqual([{ operator: 'ARITH_PLUS_TO_MINUS', count: 1 }]);
    expect(report.candidateEquivalentOperators).toEqual([
      { operator: 'INDEX_OFF_BY_ONE', count: 1 },
      { operator: 'RESET_BRANCH_DISABLED', count: 1 },
    ]);
  });

  it('reports the mean and the worst added wall clock, so the cost is visible', () => {
    const report = summarizeMutationControl([
      { problemId: 'p1', probe: counts({ elapsedMs: 2_000 }) },
      { problemId: 'p2', probe: counts({ elapsedMs: 6_000 }) },
    ]);

    expect(report.meanElapsedMs).toBe(4_000);
    expect(report.maxElapsedMs).toBe(6_000);
  });

  it('excludes an unprobed sample from every number without dropping the run', () => {
    const report = summarizeMutationControl([
      { problemId: 'p1', probe: counts({ validCount: 4, killedCount: 4 }) },
      { problemId: 'p2', probe: null },
    ]);

    expect(report.probedSamples).toBe(1);
    expect(report.validMutants).toBe(4);
  });

  it('reports NOT MEASURED for a run where nothing was probed', () => {
    const samples: readonly MutationSample[] = [
      { problemId: 'p1', probe: null },
      { problemId: 'p2', probe: null },
    ];

    expect(summarizeMutationControl(samples)).toEqual(NO_MUTATION_CONTROL_MEASURED);
    expect(mutationControlMeasured(NO_MUTATION_CONTROL_MEASURED)).toBe(false);
  });

  it('yields the zeroed report for no samples at all', () => {
    expect(summarizeMutationControl([])).toEqual(NO_MUTATION_CONTROL_MEASURED);
  });

  it('reports MEASURED as soon as one sample was probed, even if it killed nothing', () => {
    const report = summarizeMutationControl([
      { problemId: 'p1', probe: counts({ validCount: 8, killedCount: 0 }) },
    ]);

    expect(mutationControlMeasured(report)).toBe(true);
    expect(report.killRate).toBe(0);
  });

  it('sums coverage-gap survivors over probed samples and rates them over valid mutants', () => {
    const report = summarizeMutationControl([
      {
        problemId: 'p1',
        probe: counts({ validCount: 10, coverageGapOperators: ['ARITH_PLUS_TO_MINUS'] }),
      },
      {
        problemId: 'p2',
        probe: counts({
          validCount: 10,
          coverageGapOperators: ['CONDITION_NEGATED', 'CONDITION_NEGATED'],
        }),
      },
      { problemId: 'p3', probe: null },
    ]);

    expect(report.coverageGapSurvivors).toBe(3);
    expect(report.coverageGapSurvivorRate).toBe(3 / 20);
  });

  it('lets an unprobed sample contribute no survivor', () => {
    const probed = {
      problemId: 'p1',
      probe: counts({ coverageGapOperators: ['CONST_INCREMENTED'] }),
    };

    const report = summarizeMutationControl([probed, { problemId: 'p2', probe: null }]);

    expect(report.coverageGapSurvivors).toBe(1);
    expect(report.coverageGapSurvivorRate).toBe(
      summarizeMutationControl([probed]).coverageGapSurvivorRate,
    );
  });

  it('gives a null survivor rate, never 0, when no mutant was valid', () => {
    // 0/0 is "not measured"; a 0 rate would claim a testbench with no gaps.
    const report = summarizeMutationControl([
      { problemId: 'p1', probe: counts({ validCount: 0, killedCount: 0 }) },
    ]);

    expect(report.coverageGapSurvivors).toBe(0);
    expect(report.coverageGapSurvivorRate).toBeNull();
    expect(NO_MUTATION_CONTROL_MEASURED.coverageGapSurvivorRate).toBeNull();
  });
});

describe('describeMutationUnavailable - the wording has exactly one owner', () => {
  it('gives every reason a non-empty operator-facing sentence', () => {
    const reasons: readonly MutationUnavailableReason[] = [
      'no-reference',
      'no-mutants-generated',
      'no-valid-mutants',
      'probe-errored',
    ];
    for (const reason of reasons) {
      expect(describeMutationUnavailable(reason).length).toBeGreaterThan(0);
    }
  });

  it('says plainly that an empty valid set proves nothing', () => {
    expect(describeMutationUnavailable('no-valid-mutants')).toContain('proves nothing');
  });
});

describe('mutantRunLimits - the mutant wall cap replaces the wall clock and NOTHING else', () => {
  const STUDENT: ResourceLimits = {
    cpu: 1,
    memMb: 512,
    procs: 128,
    diskMb: 128,
    wallMs: 30_000,
  };

  it('given a student session, when a mutant run is bounded, then only wallMs changes', () => {
    // The mutant runs on the SAME RAILS as the oracle: the negative control's whole claim is that
    // only the RTL under the testbench changed. A weakened cpu/mem/procs/disk cap would leave "it
    // behaved differently because it ran under different limits" as a live explanation.
    const bounded = mutantRunLimits(STUDENT, 5_000);

    expect(bounded).toEqual({ ...STUDENT, wallMs: 5_000 });
    expect(bounded.cpu).toBe(STUDENT.cpu);
    expect(bounded.memMb).toBe(STUDENT.memMb);
    expect(bounded.procs).toBe(STUDENT.procs);
    expect(bounded.diskMb).toBe(STUDENT.diskMb);
  });

  it('given the caller-owned limits, when bounded, then the STUDENT cap is not mutated', () => {
    // The loop keeps its own wall clock. A mutant cap that edited the caller's object in place
    // would silently shorten every subsequent student simulation in the same sample.
    mutantRunLimits(STUDENT, 500);

    expect(STUDENT.wallMs).toBe(30_000);
  });

  it('states a default that is far above the measured real-run band and far below 30s', () => {
    // The default is a measurement, not a guess: real mutant runs cost 137-237ms and a hang costs
    // the whole cap, so the default is ~20x the worst real run and 6x cheaper than 30s on a hang.
    expect(DEFAULT_MUTANT_WALL_MS).toBe(5_000);
    expect(DEFAULT_MUTANT_WALL_MS).toBeGreaterThan(MIN_MUTANT_WALL_MS);
    expect(DEFAULT_MUTANT_WALL_MS).toBeLessThan(MAX_MUTANT_WALL_MS);
    // Comfortably above the slowest run measured on the real toolchain.
    expect(DEFAULT_MUTANT_WALL_MS).toBeGreaterThan(20 * 237);
  });
});

describe('the calibration vocabulary - five causes, and none folded into another', () => {
  /** Every calibration state, enumerated so a sixth member fails to compile here. */
  const EVERY_CALIBRATION: Readonly<Record<MutantCalibration, true>> = {
    'golden-killed': true,
    'golden-timeout': true,
    'golden-survived': true,
    'non-compiling': true,
    'golden-errored': true,
  };

  it('admits exactly the two verdicts that came from a completed judgement, plus the hang', () => {
    // A timeout is VALID: the mutant compiled, ran, and failed to terminate, which is an
    // observable behavioural difference. A build failure and a crash are not measurements at all.
    const valid = Object.keys(EVERY_CALIBRATION).filter((calibration) =>
      mutantIsValid(calibration as MutantCalibration),
    );

    expect(valid.sort()).toEqual(['golden-killed', 'golden-survived', 'golden-timeout']);
  });

  it('counts a HANG as a golden kill, so it enters the GATE set', () => {
    // Established practice (Stryker counts an infinite-loop mutant as detected) and the rule this
    // layer already applies to our own testbench via `no-verdict`. It ENLARGES the gate set, which
    // is the intended consequence: the defect demonstrably changes observable behaviour.
    expect(mutantWasGoldenKilled('golden-timeout')).toBe(true);
    expect(mutantWasGoldenKilled('golden-killed')).toBe(true);
  });

  it('does NOT count a survivor, a build failure, or a crash as a golden kill', () => {
    expect(mutantWasGoldenKilled('golden-survived')).toBe(false);
    expect(mutantWasGoldenKilled('non-compiling')).toBe(false);
    expect(mutantWasGoldenKilled('golden-errored')).toBe(false);
  });

  it('keeps a build failure and a crash as two states, so three causes are not folded into two', () => {
    // The three `error` causes are timeout, build failure, and crash. Splitting only the timeout
    // out would leave a crash misdescribed as "did not compile", attributing our own
    // infrastructure fault to the corpus.
    expect(mutantIsValid('non-compiling')).toBe(false);
    expect(mutantIsValid('golden-errored')).toBe(false);
    expect('non-compiling' === ('golden-errored' as string)).toBe(false);
  });
});

describe('tallySurvivedOperators - the tally reads persisted counts, not whole samples', () => {
  it('ignores an unprobed entry rather than counting it as a sample with no survivors', () => {
    const tally = tallySurvivedOperators(
      [counts({ coverageGapOperators: ['ARITH_PLUS_TO_MINUS'] }), null, null],
      'coverageGapOperators',
    );

    expect(tally).toEqual([{ operator: 'ARITH_PLUS_TO_MINUS', count: 1 }]);
  });

  it('orders most frequent first and breaks a tie by operator name', () => {
    const tally = tallySurvivedOperators(
      [
        counts({ coverageGapOperators: ['CONST_ZERO_TO_ONE', 'ARITH_PLUS_TO_MINUS'] }),
        counts({ coverageGapOperators: ['ARITH_PLUS_TO_MINUS', 'INDEX_OFF_BY_ONE'] }),
      ],
      'coverageGapOperators',
    );

    expect(tally).toEqual([
      { operator: 'ARITH_PLUS_TO_MINUS', count: 2 },
      { operator: 'CONST_ZERO_TO_ONE', count: 1 },
      { operator: 'INDEX_OFF_BY_ONE', count: 1 },
    ]);
  });

  it('agrees with the report the run summary renders from the same samples', () => {
    // The generalized signature must leave `summarizeMutationControl` byte-identical, so the
    // tally is checked against the report rather than only against itself.
    const samples = [
      { problemId: 'p1', probe: counts({ coverageGapOperators: ['ARITH_PLUS_TO_MINUS'] }) },
      { problemId: 'p2', probe: null },
      { problemId: 'p3', probe: counts({ coverageGapOperators: ['ARITH_PLUS_TO_MINUS'] }) },
    ];

    const report = summarizeMutationControl(samples);

    expect(report.coverageGapOperators).toEqual(
      tallySurvivedOperators(
        samples.map((sample) => sample.probe),
        'coverageGapOperators',
      ),
    );
  });
});
