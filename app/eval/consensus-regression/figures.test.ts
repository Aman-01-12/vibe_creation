// Fakes-only unit tests for `reduceGatedFigures` (task 18.2's reduction function) and for
// `reduceQualitySignals`/`renderQualitySignals` (task 11.2's printed Quality_Signals, C9).

import { describe, expect, it } from 'vitest';

import type { SessionOutcome, TestbenchTrust, WaveformSignature } from '@app/agent';

import {
  BASELINE_SWEEP_COMPARABILITY_SENTENCE,
  QUALITY_SIGNAL_LABEL,
  reduceGatedFigures,
  reduceQualitySignals,
  renderQualitySignals,
} from './figures.js';
import type { ConsensusRegressionSample } from './harness.js';

/** A minimal Unverified_Outcome carrying one Run_Matrix cell and one Fault_Verdict. */
function outcomeWith(
  cellPassed: boolean,
  faultVerdict: 'RTL' | 'TESTBENCH' | 'ABSTAIN' | null,
): SessionOutcome {
  return {
    kind: 'unverified',
    unmetCondition: 'strict-majority',
    checked: {
      poolSize: 1,
      distinctModelFamilyCount: 1,
      trustedTestbenchCount: 0,
      consensusRunCount: 1,
      largestClusterCardinality: 0,
      structuralGateChecks: [],
    },
    nextActions: ['request-another-attempt', 'accept-unverified'],
    record: {
      clusters: [],
      signaturesByDesign: [],
      modelFamilyByArtifact: [],
      roleDeclarations: [],
      testbenchTrust: [],
      mutantCensus: [],
      poolCorrectness: {
        poolCorrectness: 0,
        attributionStatus: 'advisory',
        faultVerdicts:
          faultVerdict === null
            ? []
            : [{ designId: 'd1', testbenchId: 't1', verdict: faultVerdict }],
      },
      repairAttempts: [],
      tokensSpent: 0,
      runMatrix: {
        designIds: ['d1'],
        testbenchIds: ['t1'],
        cells: [
          {
            designId: 'd1',
            testbenchId: 't1',
            passed: cellPassed,
            signature: null,
            failureCause: cellPassed ? 'none' : 'tool-failed',
          },
        ],
      },
    },
  };
}

function sampleWith(overrides: Partial<ConsensusRegressionSample>): ConsensusRegressionSample {
  return {
    problemId: 'rtllm/control/counter_12',
    outcome: outcomeWith(false, null),
    goldenVerdict: null,
    designGroundTruth: [],
    testbenchGroundTruth: [],
    ...overrides,
  };
}

describe('reduceGatedFigures - no samples', () => {
  it('reports every figure as null rather than a silent zero', () => {
    const figures = reduceGatedFigures([]);
    expect(figures).toEqual({
      wrongLabelShare: null,
      verifiedCorrectShare: null,
      attributionAccuracyTestbench: null,
      attributionAccuracyRtl: null,
      misattributionShare: null,
    });
  });
});

describe('reduceGatedFigures - Wrong_Label_Share and Verified_Correct_Share', () => {
  it('reads only the delivered-design golden verdict', () => {
    const grantedOutcome: SessionOutcome = {
      kind: 'verified',
      deliveredDesignIds: ['d1'],
      cluster: { designIds: ['d1'], digestsByTestbench: [] },
      record: outcomeWith(true, null).record,
    };
    const samples: ConsensusRegressionSample[] = [
      sampleWith({ outcome: grantedOutcome, goldenVerdict: { kind: 'passed', failureCount: 0 } }),
      sampleWith({ outcome: grantedOutcome, goldenVerdict: { kind: 'failed', failureCount: 1 } }),
      // An Unverified_Outcome contributes to neither share's numerator or denominator.
      sampleWith({ outcome: outcomeWith(false, null), goldenVerdict: null }),
    ];

    const figures = reduceGatedFigures(samples);

    expect(figures.wrongLabelShare).toBe(0.5); // 1 of 2 Verified_Outcomes wrong
    expect(figures.verifiedCorrectShare).toBeCloseTo(1 / 3); // 1 of 3 Sessions correct
  });
});

describe('reduceGatedFigures - Attribution_Accuracy and Misattribution_Share', () => {
  it('scores a TESTBENCH verdict correct when ground truth says the testbench alone is wrong', () => {
    const samples: ConsensusRegressionSample[] = [
      sampleWith({
        outcome: outcomeWith(false, 'TESTBENCH'),
        designGroundTruth: [{ id: 'd1', wrong: false }],
        testbenchGroundTruth: [{ id: 't1', wrong: true }],
      }),
    ];

    const figures = reduceGatedFigures(samples);

    expect(figures.attributionAccuracyTestbench).toBe(1);
    expect(figures.attributionAccuracyRtl).toBeNull(); // no RTL-verdict pairs at all
    expect(figures.misattributionShare).toBe(0); // the one testbench-only fault was not called RTL
  });

  it('counts a misattribution when an RTL verdict lands on a testbench-only fault', () => {
    const samples: ConsensusRegressionSample[] = [
      sampleWith({
        outcome: outcomeWith(false, 'RTL'),
        designGroundTruth: [{ id: 'd1', wrong: false }],
        testbenchGroundTruth: [{ id: 't1', wrong: true }],
      }),
    ];

    const figures = reduceGatedFigures(samples);

    expect(figures.attributionAccuracyRtl).toBe(0); // called RTL, but the design was fine
    expect(figures.misattributionShare).toBe(1); // the only testbench-only fault was called RTL
  });

  it('excludes a pair from Attribution_Accuracy when ground truth has no verdict on one side', () => {
    const samples: ConsensusRegressionSample[] = [
      sampleWith({
        outcome: outcomeWith(false, 'TESTBENCH'),
        designGroundTruth: [{ id: 'd1', wrong: null }], // unjudged design
        testbenchGroundTruth: [{ id: 't1', wrong: true }],
      }),
    ];

    const figures = reduceGatedFigures(samples);

    expect(figures.attributionAccuracyTestbench).toBeNull();
  });

  it('excludes a pair from Attribution_Accuracy when both sides agree (not exactly one at fault)', () => {
    const samples: ConsensusRegressionSample[] = [
      sampleWith({
        outcome: outcomeWith(false, 'TESTBENCH'),
        designGroundTruth: [{ id: 'd1', wrong: true }], // BOTH sides wrong, not "exactly one"
        testbenchGroundTruth: [{ id: 't1', wrong: true }],
      }),
    ];

    const figures = reduceGatedFigures(samples);

    expect(figures.attributionAccuracyTestbench).toBeNull();
  });

  it('an ABSTAIN verdict is never scored for either Attribution_Accuracy figure', () => {
    const samples: ConsensusRegressionSample[] = [
      sampleWith({
        outcome: outcomeWith(false, 'ABSTAIN'),
        designGroundTruth: [{ id: 'd1', wrong: false }],
        testbenchGroundTruth: [{ id: 't1', wrong: true }],
      }),
    ];

    const figures = reduceGatedFigures(samples);

    expect(figures.attributionAccuracyTestbench).toBeNull();
    expect(figures.attributionAccuracyRtl).toBeNull();
  });
});

// -- reduceQualitySignals / renderQualitySignals (C9, Req 6.1-6.5, 9.6) -------------------------

/** A `WaveformSignature` whose trace has exactly `distinctCount` distinct output tuples. */
function signatureWithDistinctCount(distinctCount: number): WaveformSignature {
  const trace = Array.from({ length: Math.max(distinctCount, 1) }, (_, index) => ({
    step: index,
    values: [index < distinctCount ? String(index) : '0'],
  }));
  return { digest: 'fake-digest', trace, sampleCount: trace.length };
}

/** A minimal `TestbenchTrust` entry carrying only the mutation-outcome kind this file checks. */
function trustWith(
  testbenchId: string,
  mutationKind: 'not-run' | 'passed' | 'failed',
): TestbenchTrust {
  return {
    testbenchId,
    passingDesignCount: 0,
    votedTrusted: false,
    mutationOutcome: { kind: mutationKind },
    trusted: false,
  };
}

/** One sample whose record carries a single testbench's signature, mutation outcome, and roles. */
function qualitySignalSample(
  problemId: string,
  testbenchId: string,
  distinctCount: number,
  mutationKind: 'not-run' | 'passed' | 'failed',
  roles: ConsensusRegressionSample['outcome']['record']['roleDeclarations'][number]['roles'] = [],
): ConsensusRegressionSample {
  const base = outcomeWith(true, null);
  return sampleWith({
    problemId,
    outcome: {
      ...base,
      record: {
        ...base.record,
        testbenchTrust: [trustWith(testbenchId, mutationKind)],
        roleDeclarations: [{ testbenchId, roles }],
        runMatrix: {
          designIds: ['d1'],
          testbenchIds: [testbenchId],
          cells: [
            {
              designId: 'd1',
              testbenchId,
              passed: true,
              signature: signatureWithDistinctCount(distinctCount),
              failureCause: 'none',
            },
          ],
        },
      },
    },
  });
}

describe('reduceQualitySignals - distinctOutputByMutationOutcome', () => {
  it('buckets a constant-output, mutation-gate-failed testbench into the "1" row', () => {
    const samples = [qualitySignalSample('p1', 't1', 1, 'failed')];

    const signals = reduceQualitySignals(samples);

    expect(signals.distinctOutputByMutationOutcome).toEqual([
      { bucket: '1', mutationFailed: 1, mutationPassed: 0 },
      { bucket: '2', mutationFailed: 0, mutationPassed: 0 },
      { bucket: '3-4', mutationFailed: 0, mutationPassed: 0 },
      { bucket: '5-16', mutationFailed: 0, mutationPassed: 0 },
      { bucket: '>16', mutationFailed: 0, mutationPassed: 0 },
    ]);
  });

  it('sorts a 20-distinct-tuple, mutation-gate-passed testbench into the ">16" row', () => {
    const samples = [qualitySignalSample('p1', 't1', 20, 'passed')];

    const signals = reduceQualitySignals(samples);

    const row = signals.distinctOutputByMutationOutcome.find((entry) => entry.bucket === '>16');
    expect(row).toEqual({ bucket: '>16', mutationFailed: 0, mutationPassed: 1 });
  });

  it('excludes a testbench with no signature anywhere in its own Run_Matrix row', () => {
    const base = outcomeWith(true, null);
    const sample = sampleWith({
      outcome: {
        ...base,
        record: {
          ...base.record,
          testbenchTrust: [trustWith('t1', 'failed')],
          runMatrix: {
            designIds: ['d1'],
            testbenchIds: ['t1'],
            cells: [
              {
                designId: 'd1',
                testbenchId: 't1',
                passed: false,
                signature: null,
                failureCause: 'tool-failed',
              },
            ],
          },
        },
      },
    });

    const signals = reduceQualitySignals([sample]);

    expect(signals.distinctOutputByMutationOutcome.every((row) => row.mutationFailed === 0)).toBe(
      true,
    );
  });

  it('excludes a testbench with a signature but no recorded mutation outcome (not-run)', () => {
    const samples = [qualitySignalSample('p1', 't1', 5, 'not-run')];

    const signals = reduceQualitySignals(samples);

    expect(signals.distinctOutputByMutationOutcome.every((row) => row.mutationPassed === 0)).toBe(
      true,
    );
  });
});

describe('reduceQualitySignals - roleAssignments', () => {
  it("pairs each testbench's rendered roles with the problem it was drafted for", () => {
    const samples = [
      qualitySignalSample('rtllm/control/counter_12', 't1', 2, 'passed', [
        { portName: 'a', role: 'data' },
        { portName: 'start', role: 'enable' },
      ]),
    ];

    const signals = reduceQualitySignals(samples);

    expect(signals.roleAssignments).toEqual([
      {
        problemId: 'rtllm/control/counter_12',
        testbenchId: 't1',
        roles: [
          { portName: 'a', role: 'data' },
          { portName: 'start', role: 'enable' },
        ],
      },
    ]);
  });
});

describe('renderQualitySignals', () => {
  it('labels both blocks QUALITY SIGNAL (does not gate) and prints the comparability sentence', () => {
    const signals = reduceQualitySignals([
      qualitySignalSample('rtllm/control/counter_12', 't1', 1, 'failed', [
        { portName: 'a', role: 'data' },
      ]),
    ]);

    const text = renderQualitySignals(signals);

    expect(text).toContain(QUALITY_SIGNAL_LABEL);
    expect(text.split(QUALITY_SIGNAL_LABEL)).toHaveLength(3); // appears exactly twice
    expect(text).toContain(BASELINE_SWEEP_COMPARABILITY_SENTENCE);
    expect(text).toContain('t1');
    expect(text).toContain('a=data');
  });

  it('prints all five bucket rows even when every count is zero (Req 6.4: reproducible rows)', () => {
    const text = renderQualitySignals(reduceQualitySignals([]));

    for (const bucket of ['1', '2', '3-4', '5-16', '>16']) {
      expect(text).toContain(bucket);
    }
  });
});
