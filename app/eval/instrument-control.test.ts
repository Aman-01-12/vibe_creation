// Unit tests for the POSITIVE CONTROL's vocabulary, aggregation, and the ONE invariant it
// exists to enforce.
//
// The invariant under test: a sample counts in the pass@k denominator if and only if the
// loop reached an oracle verdict AND the control proved its testbench valid. Every other
// combination is excluded, and every exclusion is reported rather than dropped - because the
// defect that motivated this whole seam was a number that silently measured our own
// testbench and called it a model failure.

import { describe, expect, it } from 'vitest';

import {
  combineInstrumentControls,
  countsInPassAtK,
  describeInstrumentVerdict,
  instrumentControlMeasured,
  invalidInstrument,
  NO_INSTRUMENT_CONTROL_MEASURED,
  reachedOracleVerdict,
  summarizeInstrumentControl,
  uncheckedInstrument,
  VALID_INSTRUMENT,
  type InstrumentDefectCode,
  type InstrumentSample,
  type InstrumentUncheckedReason,
  type RecordedInstrumentVerdict,
} from './instrument-control.js';
import {
  judgeCoverageGaps,
  type CoverageGapVerdict,
  type MutantIdentity,
  type MutationProbeReport,
  type MutationUnavailableReason,
} from './mutation-control.js';
import type { SampleOutcomeStatus } from './report.js';

/** Every outcome status, so a new one cannot slip past the eligibility tests. */
const ALL_STATUSES: readonly SampleOutcomeStatus[] = [
  'verified',
  'unverified',
  'blocked',
  'setup-failed',
  'runner-error',
];

/** One aggregation input; each test states only the part it is about. */
function sample(overrides: Partial<InstrumentSample> = {}): InstrumentSample {
  return {
    outcomeStatus: 'unverified',
    instrument: VALID_INSTRUMENT,
    loopPassed: false,
    golden: null,
    ...overrides,
  };
}

describe('countsInPassAtK - THE denominator invariant', () => {
  it('counts a sample when the oracle judged it AND the instrument is proven valid', () => {
    expect(countsInPassAtK({ outcomeStatus: 'verified', instrument: VALID_INSTRUMENT })).toBe(true);
    expect(countsInPassAtK({ outcomeStatus: 'unverified', instrument: VALID_INSTRUMENT })).toBe(
      true,
    );
  });

  it('excludes an INVALID instrument even though the oracle reached a verdict', () => {
    // The measured `right_shifter` case: our testbench rejects the reference design, so
    // `passed` says nothing about the model and must not enter the denominator.
    expect(
      countsInPassAtK({
        outcomeStatus: 'unverified',
        instrument: invalidInstrument('TESTBENCH_FAILED_REFERENCE'),
      }),
    ).toBe(false);
  });

  it('excludes an UNCHECKED instrument, because unproven is not the same as sound', () => {
    const reasons: readonly InstrumentUncheckedReason[] = [
      'control-absent',
      'no-testbench',
      'no-reference',
      'testbench-unsubmittable',
      'control-unavailable',
    ];
    for (const reason of reasons) {
      expect(
        countsInPassAtK({ outcomeStatus: 'verified', instrument: uncheckedInstrument(reason) }),
      ).toBe(false);
    }
  });

  it('excludes every no-verdict status, whatever the instrument says', () => {
    const noVerdict = ALL_STATUSES.filter((status) => !reachedOracleVerdict(status));
    expect(noVerdict).toEqual(['blocked', 'setup-failed', 'runner-error']);
    for (const outcomeStatus of noVerdict) {
      expect(countsInPassAtK({ outcomeStatus, instrument: VALID_INSTRUMENT })).toBe(false);
    }
  });

  it('treats exactly verified and unverified as verdict-bearing', () => {
    expect(ALL_STATUSES.filter(reachedOracleVerdict)).toEqual(['verified', 'unverified']);
  });
});

/** One negative-control probe report; each test states only the part it is about. */
function probeReport(overrides: Partial<MutationProbeReport> = {}): MutationProbeReport {
  return {
    validCount: 8,
    killedCount: 8,
    noVerdictKills: 0,
    coverageGapSurvivors: [],
    candidateEquivalentSurvivors: [],
    goldenKilledCount: 5,
    goldenTimeoutCount: 0,
    nonCompilingCount: 1,
    goldenErroredCount: 0,
    generatedCount: 9,
    elapsedMs: 4_000,
    ...overrides,
  };
}

/** One survivor identity, so a coverage gap can be stated concretely. */
function resetSurvivor(line: number): MutantIdentity {
  return {
    mutantId: `RESET_BRANCH_DISABLED@${line}:10`,
    operator: 'RESET_BRANCH_DISABLED',
    site: { line, column: 10, before: '(!rst_n)', after: "(1'b0)" },
  };
}

describe('combineInstrumentControls - validity requires BOTH controls', () => {
  it('given zero coverage gaps, when combined, then the instrument is valid', () => {
    const verdict = combineInstrumentControls({
      positive: VALID_INSTRUMENT,
      negative: { kind: 'measured', report: probeReport() },
    });

    expect(verdict).toEqual({ validity: 'valid' });
  });

  it('given ONE coverage-gap survivor, when combined, then the instrument is invalid', () => {
    // The `multi_pipe_8bit` class: the testbench passes the reference AND passes a design the
    // INDEPENDENT judge rejects, so it is under-powered rather than over-strict. One is enough:
    // the bug is proven catchable, so missing it is proven to be our gap.
    const verdict = combineInstrumentControls({
      positive: VALID_INSTRUMENT,
      negative: {
        kind: 'measured',
        report: probeReport({ killedCount: 7, coverageGapSurvivors: [resetSurvivor(26)] }),
      },
    });

    expect(verdict).toEqual({ validity: 'invalid', defect: 'TESTBENCH_SURVIVED_MUTANTS' });
  });

  it('given a LOW kill rate with zero coverage gaps, when combined, then it is still VALID', () => {
    // THE FALSE NEGATIVE THE OLD GATE PRODUCED, in the shape it was measured in. This is the
    // `multi_pipe_8bit` discriminating testbench: 4 of 6 valid mutants killed - two of them
    // mutants the golden judge itself misses - and both survivors are ones the judge also
    // passed, at least one very likely a TRUE equivalent. The 0.95 rate bar marked this
    // demonstrably good instrument INVALID at 0.667. A rate over a set containing unkillable
    // mutants cannot be a gate.
    const verdict = combineInstrumentControls({
      positive: VALID_INSTRUMENT,
      negative: {
        kind: 'measured',
        report: probeReport({
          validCount: 6,
          killedCount: 4,
          goldenKilledCount: 2,
          candidateEquivalentSurvivors: [resetSurvivor(26), resetSurvivor(39)],
        }),
      },
    });

    expect(verdict).toEqual({ validity: 'valid' });
  });

  it('given zero GOLDEN-KILLED mutants, when combined, then the vacuous gate reads unchecked', () => {
    // Nothing was proven catchable on this problem, so the requirement is empty and a testbench
    // that killed nothing would clear it. That is the same vacuity trap as an empty valid set,
    // one level in, and it gets its own reason rather than a silent `valid`.
    const verdict = combineInstrumentControls({
      positive: VALID_INSTRUMENT,
      negative: {
        kind: 'measured',
        report: probeReport({
          validCount: 6,
          killedCount: 0,
          goldenKilledCount: 0,
          candidateEquivalentSurvivors: [resetSurvivor(26), resetSurvivor(39)],
        }),
      },
    });

    expect(verdict).toEqual({ validity: 'unchecked', reason: 'no-golden-killed-mutants' });
  });

  it('maps every coverage-gap verdict, and lets exactly ONE of them reach valid', () => {
    // The structural guard on the gate. `judgeCoverageGaps` has four outcomes and only `closed`
    // is a pass; the other three are an accusation and two admissions of vacuity. Enumerated here
    // so a fifth outcome added later cannot quietly join the `valid` side - which is exactly how
    // a vacuous gate would ship as a validated instrument.
    const byVerdict: Readonly<Record<CoverageGapVerdict, MutationProbeReport>> = {
      closed: probeReport(),
      open: probeReport({ killedCount: 7, coverageGapSurvivors: [resetSurvivor(26)] }),
      'no-valid-mutants': probeReport({ validCount: 0, killedCount: 0, goldenKilledCount: 0 }),
      'no-golden-killed-mutants': probeReport({ killedCount: 0, goldenKilledCount: 0 }),
    };
    const validVerdicts: CoverageGapVerdict[] = [];

    for (const [verdict, report] of Object.entries(byVerdict) as [
      CoverageGapVerdict,
      MutationProbeReport,
    ][]) {
      // Each fixture really does produce the verdict it is filed under, so the enumeration is a
      // statement about the gate and not just about this table.
      expect(judgeCoverageGaps(report)).toBe(verdict);
      const combined = combineInstrumentControls({
        positive: VALID_INSTRUMENT,
        negative: { kind: 'measured', report },
      });
      if (combined.validity === 'valid') {
        validVerdicts.push(verdict);
      }
    }

    expect(validVerdicts).toEqual(['closed']);
  });

  it('keeps a POSITIVE-control failure as-is, under its own more specific defect code', () => {
    // A testbench that cannot pass the correct design has already been falsified; re-labelling
    // it as a mutation failure would lose the more actionable diagnosis.
    for (const defect of [
      'TESTBENCH_FAILED_REFERENCE',
      'TESTBENCH_REFERENCE_UNBUILDABLE',
      'CONTROL_RUN_ERRORED',
    ] as const) {
      expect(
        combineInstrumentControls({ positive: invalidInstrument(defect), negative: null }),
      ).toEqual({ validity: 'invalid', defect });
    }
  });

  it('applies the positive-control-only standard when no negative control is wired', () => {
    // A legitimate configuration, not a failure. The summary labels the arm so the weaker
    // standard is never cited as the full one.
    expect(combineInstrumentControls({ positive: VALID_INSTRUMENT, negative: null })).toEqual({
      validity: 'valid',
    });
  });

  it('maps every unavailable probe onto its own unchecked reason, never onto valid', () => {
    const expected: Readonly<Record<MutationUnavailableReason, InstrumentUncheckedReason>> = {
      'no-reference': 'no-reference',
      'no-mutants-generated': 'no-mutants-generated',
      'no-valid-mutants': 'no-valid-mutants',
      'probe-errored': 'mutation-probe-unavailable',
    };
    for (const [reason, expectedReason] of Object.entries(expected)) {
      expect(
        combineInstrumentControls({
          positive: VALID_INSTRUMENT,
          negative: { kind: 'unavailable', reason: reason as MutationUnavailableReason },
        }),
      ).toEqual({ validity: 'unchecked', reason: expectedReason });
    }
  });

  it('never reports valid for a probe with an EMPTY valid set', () => {
    // Normally reached as `unavailable` / `no-valid-mutants` from the probe itself; pinned here
    // too, because "killed all zero of them" reading as validated is the exact lie this seam
    // exists to prevent, and the combination rule must not depend on an upstream guard for it.
    const verdict = combineInstrumentControls({
      positive: VALID_INSTRUMENT,
      negative: {
        kind: 'measured',
        report: probeReport({ validCount: 0, killedCount: 0, goldenKilledCount: 0 }),
      },
    });

    expect(verdict).toEqual({ validity: 'unchecked', reason: 'no-valid-mutants' });
  });

  it('leaves a survived-mutants sample OUT of the pass@k denominator', () => {
    expect(
      countsInPassAtK({
        outcomeStatus: 'verified',
        instrument: invalidInstrument('TESTBENCH_SURVIVED_MUTANTS'),
      }),
    ).toBe(false);
  });

  it('leaves every new unchecked reason OUT of the pass@k denominator', () => {
    for (const reason of [
      'no-mutants-generated',
      'no-valid-mutants',
      'no-golden-killed-mutants',
      'mutation-probe-unavailable',
    ] as const) {
      expect(
        countsInPassAtK({ outcomeStatus: 'verified', instrument: uncheckedInstrument(reason) }),
      ).toBe(false);
    }
  });
});

describe('summarizeInstrumentControl - the counts an operator acts on', () => {
  it('splits valid, invalid and unchecked, and counts the denominator from the invariant', () => {
    const report = summarizeInstrumentControl([
      sample({ outcomeStatus: 'verified', loopPassed: true }),
      sample({ outcomeStatus: 'unverified' }),
      sample({
        outcomeStatus: 'unverified',
        instrument: invalidInstrument('TESTBENCH_FAILED_REFERENCE'),
      }),
      sample({
        outcomeStatus: 'setup-failed',
        instrument: uncheckedInstrument('no-testbench'),
      }),
    ]);

    expect(report.validSamples).toBe(2);
    expect(report.invalidSamples).toBe(1);
    expect(report.uncheckedSamples).toBe(1);
    expect(report.checkedSamples).toBe(3);
    expect(report.countedSamples).toBe(2);
  });

  it('separates a verdict-bearing unchecked sample from one that had no verdict at all', () => {
    const report = summarizeInstrumentControl([
      sample({ outcomeStatus: 'unverified', instrument: uncheckedInstrument('no-reference') }),
      sample({ outcomeStatus: 'setup-failed', instrument: uncheckedInstrument('no-testbench') }),
    ]);

    expect(report.uncheckedSamples).toBe(2);
    // Only the first had a verdict that cannot be cited; the second was never judged.
    expect(report.uncheckedWithVerdict).toBe(1);
  });

  it('tallies the defect codes, so did-not-build is never blended with rejected', () => {
    const defects: readonly InstrumentDefectCode[] = [
      'TESTBENCH_FAILED_REFERENCE',
      'TESTBENCH_FAILED_REFERENCE',
      'TESTBENCH_REFERENCE_UNBUILDABLE',
      'CONTROL_RUN_ERRORED',
      'TESTBENCH_SURVIVED_MUTANTS',
      'TESTBENCH_SURVIVED_MUTANTS',
      'TESTBENCH_SURVIVED_MUTANTS',
    ];
    const report = summarizeInstrumentControl(
      defects.map((defect) => sample({ instrument: invalidInstrument(defect) })),
    );

    expect(report.failedReferenceSamples).toBe(2);
    expect(report.unbuildableSamples).toBe(1);
    expect(report.erroredSamples).toBe(1);
    // Distinct from `failedReferenceSamples` on purpose: the repair is the opposite one, so
    // blending them would send a reviewer to fix over-strictness in an under-powered testbench.
    expect(report.survivedMutantsSamples).toBe(3);
  });

  it('attributes an over-strict disagreement on a broken instrument to OUR testbench', () => {
    const report = summarizeInstrumentControl([
      // Our testbench failed it, the independent judge passed it - and our testbench also
      // rejects the reference design. Not a disagreement to chase.
      sample({
        outcomeStatus: 'unverified',
        loopPassed: false,
        golden: { kind: 'passed', failureCount: 0 },
        instrument: invalidInstrument('TESTBENCH_FAILED_REFERENCE'),
      }),
      // A missed bug on a broken instrument is separated the same way.
      sample({
        outcomeStatus: 'verified',
        loopPassed: true,
        golden: { kind: 'failed', failureCount: 2 },
        instrument: invalidInstrument('TESTBENCH_FAILED_REFERENCE'),
      }),
      // The same over-strict shape on a VALID instrument is not counted here at all.
      sample({
        outcomeStatus: 'unverified',
        loopPassed: false,
        golden: { kind: 'passed', failureCount: 0 },
      }),
    ]);

    expect(report.invalidOverStrict).toBe(1);
    expect(report.invalidMissedBug).toBe(1);
  });

  it('reports NOT MEASURED for a run where the control never spoke', () => {
    const report = summarizeInstrumentControl([
      sample({ instrument: uncheckedInstrument('control-absent') }),
      sample({ instrument: uncheckedInstrument('control-absent') }),
    ]);

    expect(instrumentControlMeasured(report)).toBe(false);
    expect(report.checkedSamples).toBe(0);
  });

  it('reports MEASURED as soon as one sample was checked, even if it was invalid', () => {
    const report = summarizeInstrumentControl([
      sample({ instrument: invalidInstrument('TESTBENCH_FAILED_REFERENCE') }),
    ]);

    expect(instrumentControlMeasured(report)).toBe(true);
  });

  it('yields the zeroed report for no samples, and that report reads as NOT MEASURED', () => {
    expect(summarizeInstrumentControl([])).toEqual(NO_INSTRUMENT_CONTROL_MEASURED);
    expect(instrumentControlMeasured(NO_INSTRUMENT_CONTROL_MEASURED)).toBe(false);
  });
});

describe('describeInstrumentVerdict - the wording has exactly one owner', () => {
  it('gives every verdict a non-empty operator-facing sentence', () => {
    const verdicts: readonly RecordedInstrumentVerdict[] = [
      VALID_INSTRUMENT,
      invalidInstrument('TESTBENCH_FAILED_REFERENCE'),
      invalidInstrument('TESTBENCH_REFERENCE_UNBUILDABLE'),
      invalidInstrument('CONTROL_RUN_ERRORED'),
      invalidInstrument('TESTBENCH_SURVIVED_MUTANTS'),
      uncheckedInstrument('control-absent'),
      uncheckedInstrument('no-testbench'),
      uncheckedInstrument('no-reference'),
      uncheckedInstrument('testbench-unsubmittable'),
      uncheckedInstrument('control-unavailable'),
      uncheckedInstrument('no-mutants-generated'),
      uncheckedInstrument('no-valid-mutants'),
      uncheckedInstrument('no-golden-killed-mutants'),
      uncheckedInstrument('mutation-probe-unavailable'),
    ];
    for (const verdict of verdicts) {
      expect(describeInstrumentVerdict(verdict).length).toBeGreaterThan(0);
    }
  });

  it('says the testbench rejects the reference for the defect the smoke run hit', () => {
    expect(describeInstrumentVerdict(invalidInstrument('TESTBENCH_FAILED_REFERENCE'))).toContain(
      'REJECTS the reference design',
    );
  });

  it('says the testbench passes independently-caught broken designs for the mutation defect', () => {
    expect(describeInstrumentVerdict(invalidInstrument('TESTBENCH_SURVIVED_MUTANTS'))).toContain(
      'PASSES broken designs the independent judge catches',
    );
  });

  it('says the vacuous-gate reason is about nothing being proven catchable', () => {
    // The wording has to distinguish "we found no gap" from "there was no gap to find", because
    // the two look identical in a coverage-gap count of zero.
    expect(describeInstrumentVerdict(uncheckedInstrument('no-golden-killed-mutants'))).toContain(
      'vacuous',
    );
  });
});
