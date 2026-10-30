// Fakes-only unit tests for `reduceGatedFigures` (task 18.2's reduction function) and for
// `reduceQualitySignals`/`renderQualitySignals` (task 11.2's printed Quality_Signals, C9).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { SessionOutcome, TestbenchTrust, WaveformSignature } from '@app/agent';
import { REFERENCE_MODEL_PROMPT_VERSION } from '@app/agent';
import {
  CONSENSUS_HARNESS_VERSION,
  HOLD_FRAME_PERIOD,
  INPUT_ROLES,
  STROBE_PERIOD,
  type RoleDeclaration,
} from '@app/tools';

import {
  BASELINE_SWEEP_COMPARABILITY_SENTENCE,
  MEASUREMENT_REGIME_LABEL,
  QUALITY_SIGNAL_LABEL,
  reduceGatedFigures,
  reduceQualitySignals,
  renderBelowFloorAdoptionDiagnostic,
  renderMeasurementRegime,
  renderQualitySignals,
  roleAdoptionShareOf,
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

// -- roleAdoptionShareOf (C11, Req 8.6-8.8) ------------------------------------------------------

/** A sample whose Session accepted `roles` for each of `roles.length` replies drawn for `problemId`. */
function roleAdoptionSample(
  problemId: string,
  roles: readonly RoleDeclaration[],
): ConsensusRegressionSample {
  const base = outcomeWith(true, null);
  return sampleWith({
    problemId,
    outcome: {
      ...base,
      record: {
        ...base.record,
        roleDeclarations: roles.map((declaredRoles, index) => ({
          testbenchId: `t${String(index)}`,
          roles: declaredRoles,
        })),
      },
    },
  });
}

describe('roleAdoptionShareOf', () => {
  it('counts accepted replies naming the role as the numerator, over all accepted replies', () => {
    const sample = roleAdoptionSample('rtllm/arithmetic/multi_16bit', [
      [{ portName: 'en', role: 'enable' }],
      [{ portName: 'en', role: 'enable' }],
      [{ portName: 'en', role: 'data' }],
      [{ portName: 'en', role: 'data' }],
      [{ portName: 'en', role: 'data' }],
      [{ portName: 'en', role: 'data' }],
      [{ portName: 'en', role: 'data' }],
      [{ portName: 'en', role: 'data' }],
    ]);

    const share = roleAdoptionShareOf(sample, 'enable', 0, 10);

    expect(share).toEqual({
      problemId: 'rtllm/arithmetic/multi_16bit',
      role: 'enable',
      numerator: 2,
      denominator: 8,
      refusedReplyCount: 0,
      referenceModelPromptVersion: 10,
      floorMeasurable: true,
    });
  });

  it('excludes refused replies from both counts, reporting the supplied refusal count unchanged', () => {
    // Only the 8 ACCEPTED replies are ever in `roleDeclarations` (task 7.6: a refused reply
    // never reaches the pool), so the 3 refused replies affect nothing but the passed-through count.
    const sample = roleAdoptionSample(
      'rtllm/miscellaneous/square_wave',
      Array.from({ length: 8 }, () => [{ portName: 'd', role: 'hold' as const }]),
    );

    const share = roleAdoptionShareOf(sample, 'hold', 3, 10);

    expect(share.numerator).toBe(8);
    expect(share.denominator).toBe(8);
    expect(share.refusedReplyCount).toBe(3);
  });

  it('reports floorMeasurable false when fewer than 8 accepted replies were drawn', () => {
    const sample = roleAdoptionSample('rtllm/control/counter_12', [
      [{ portName: 'en', role: 'enable' }],
      [{ portName: 'en', role: 'data' }],
    ]);

    const share = roleAdoptionShareOf(sample, 'enable', 6, 10);

    expect(share.denominator).toBe(2);
    expect(share.floorMeasurable).toBe(false);
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

  it('prints the measurement regime beside the comparability sentence (Req 9.6)', () => {
    const text = renderQualitySignals(reduceQualitySignals([]));

    expect(text).toContain(renderMeasurementRegime());
  });
});

// -- Property 19 (C11; Req 8.6, 8.7, 8.8): the Role_Adoption_Share reconciles and excludes
// every refused reply. Recounted independently from the drawn declarations below, never by
// calling back into `roleAdoptionShareOf` for the expected figures. ---------------------------

const PROPERTY_19 =
  'Feature: stimulus-transaction-structure, Property 19: The Role_Adoption_Share reconciles ' +
  'and excludes every refused reply';

const PROPERTY_19_NUM_RUNS = 100;

/** One accepted reply's Role_Declaration: 0-4 ports, each independently any Role_Vocabulary
 * member. The port name plays no part in `roleAdoptionShareOf`, so it is held fixed. */
function acceptedRoleDeclarationArbitrary(): fc.Arbitrary<RoleDeclaration> {
  return fc.array(
    fc.record({ portName: fc.constant('p'), role: fc.constantFrom(...INPUT_ROLES) }),
    {
      minLength: 0,
      maxLength: 4,
    },
  );
}

describe(PROPERTY_19, () => {
  it('counts only the accepted declarations, and holds both counts fixed as the refusal count varies', () => {
    const floorStates = new Set<boolean>();
    const memberPresenceStates = new Set<boolean>();

    fc.assert(
      fc.property(
        fc.array(acceptedRoleDeclarationArbitrary(), { minLength: 0, maxLength: 16 }),
        fc.constantFrom(...INPUT_ROLES),
        fc.nat({ max: 20 }),
        fc.nat({ max: 20 }),
        fc.nat({ max: 50 }),
        (declarations, role, refusedReplyCountA, refusedReplyCountB, promptVersion) => {
          // `refusedReplyCountA`/`B` stand in for a Session's refused replies (Req 8.7's own
          // record shape: a refused reply never reaches `roleDeclarations`, so a drawn refusal
          // count is the only form a refused reply takes at this reducer's boundary).
          const sample = roleAdoptionSample('rtllm/property/role-adoption', declarations);

          const shareA = roleAdoptionShareOf(sample, role, refusedReplyCountA, promptVersion);
          const shareB = roleAdoptionShareOf(sample, role, refusedReplyCountB, promptVersion);

          // Independent recount straight from the drawn declarations (Req 8.6, 8.7).
          const expectedDenominator = declarations.length;
          const expectedNumerator = declarations.filter((declaration) =>
            declaration.some((entry) => entry.role === role),
          ).length;

          expect(shareA.denominator).toBe(expectedDenominator);
          expect(shareA.numerator).toBe(expectedNumerator);
          expect(shareA.floorMeasurable).toBe(expectedDenominator >= 8); // Req 8.8

          // Req 8.7: no refused reply is counted in either figure - the denominator and
          // numerator must not move when only the refusal count changes.
          expect(shareB.denominator).toBe(shareA.denominator);
          expect(shareB.numerator).toBe(shareA.numerator);
          expect(shareA.refusedReplyCount).toBe(refusedReplyCountA);
          expect(shareB.refusedReplyCount).toBe(refusedReplyCountB);

          floorStates.add(shareA.floorMeasurable);
          memberPresenceStates.add(expectedNumerator > 0);
        },
      ),
      { numRuns: PROPERTY_19_NUM_RUNS },
    );

    // NON-VACUITY: both floor outcomes and both member-presence outcomes must actually occur
    // across the sampled population, not just be possible.
    expect(floorStates).toEqual(new Set([true, false]));
    expect(memberPresenceStates).toEqual(new Set([true, false]));
  });
});

// -- Property 20 (C11; Req 8.11): the below-floor adoption diagnostic names the complete
// Role_Declaration of every accepted reply and the stated reason of every refused reply, and
// carries no Candidate_Design text. The sentinel below is kept in the test's closure and never
// passed to `renderBelowFloorAdoptionDiagnostic` - there is no parameter it could occupy - so
// the "never contains" check is sound by construction, not a containment check passing by luck
// (see the vault's credential-leak-containment gotcha for why that distinction matters). -------

const PROPERTY_20 =
  'Feature: stimulus-transaction-structure, Property 20: The adoption diagnostic names the ' +
  'declarations and no design';

const PROPERTY_20_NUM_RUNS = 100;

/** A distinctive marker standing in for Candidate_Design text; never an argument below. */
const CANDIDATE_DESIGN_SENTINEL = '__CANDIDATE_DESIGN_DO_NOT_LEAK_7F3A21E9__';

/** A refusal-reason-shaped phrase, drawn from a safe word pool that cannot collide with the sentinel. */
function refusalReasonArbitrary(): fc.Arbitrary<string> {
  const words = [
    'model',
    'output',
    'carried',
    'no',
    'roles',
    'array',
    'named',
    'a',
    'role',
    'outside',
    'the',
    'vocabulary',
    'omitted',
    'an',
    'input',
    'port',
    'malformed',
    'entry',
    'twice',
  ] as const;
  return fc
    .array(fc.constantFrom(...words), { minLength: 1, maxLength: 8 })
    .map((parts) => parts.join(' '));
}

describe(PROPERTY_20, () => {
  it('names every accepted declaration and refusal reason, and carries no Candidate_Design text', () => {
    // A Candidate_Design kept in scope but structurally unreachable: the function under test
    // has no second parameter for RTL source, only `refusalReasons: readonly string[]`.
    const candidateDesign = `module dut(input clk); // ${CANDIDATE_DESIGN_SENTINEL}\nendmodule`;
    expect(candidateDesign).toContain(CANDIDATE_DESIGN_SENTINEL);

    let sawAcceptedPortRole = false;
    let sawRefusalReason = false;

    fc.assert(
      fc.property(
        fc.array(acceptedRoleDeclarationArbitrary(), { minLength: 0, maxLength: 10 }),
        fc.array(refusalReasonArbitrary(), { minLength: 0, maxLength: 10 }),
        (acceptedDeclarations, refusalReasons) => {
          const text = renderBelowFloorAdoptionDiagnostic(acceptedDeclarations, refusalReasons);

          // Every accepted reply's COMPLETE Role_Declaration: every port name with its role.
          for (const declaration of acceptedDeclarations) {
            for (const entry of declaration) {
              expect(text).toContain(`${entry.portName}=${entry.role}`);
              sawAcceptedPortRole = true;
            }
          }

          // Every refused reply's stated reason, verbatim.
          for (const reason of refusalReasons) {
            expect(text).toContain(reason);
            sawRefusalReason = true;
          }

          // Req 8.11: no Candidate_Design text anywhere in the rendered diagnostic.
          expect(text).not.toContain(CANDIDATE_DESIGN_SENTINEL);
        },
      ),
      { numRuns: PROPERTY_20_NUM_RUNS },
    );

    // NON-VACUITY: both naming clauses actually fired across the sampled population.
    expect(sawAcceptedPortRole).toBe(true);
    expect(sawRefusalReason).toBe(true);
  });
});

// -- Property 22 (C13; Req 9.6): the regime block states every value its run used.
// `renderMeasurementRegime` takes no parameter (task 11.4: a pure function of the build's own
// identity, not of any sample), so there is no input to run `fc.assert` over for the
// single-valued facts - those are checked directly against each constant's own live value,
// never a second hardcoded literal. The Role_Vocabulary is the one fact with more than one
// value, so "every member" is checked by running INPUT_ROLES itself through `fc.constantFrom`
// rather than a second hardcoded member list - a future Role_Vocabulary member needs no edit
// here to stay covered. ------------------------------------------------------------------------

const PROPERTY_22 =
  'Feature: stimulus-transaction-structure, Property 22: The regime block states every value ' +
  'its run used';

describe(PROPERTY_22, () => {
  it('states the Strobe_Period, the Hold_Frame_Period, every Role_Vocabulary member, and both identity constants, each read live', () => {
    const text = renderMeasurementRegime();

    expect(text).toContain(MEASUREMENT_REGIME_LABEL);
    expect(text).toContain(`Strobe_Period: ${String(STROBE_PERIOD)}`);
    expect(text).toContain(`Hold_Frame_Period: ${String(HOLD_FRAME_PERIOD)}`);
    expect(text).toContain(`CONSENSUS_HARNESS_VERSION: ${String(CONSENSUS_HARNESS_VERSION)}`);
    expect(text).toContain(
      `REFERENCE_MODEL_PROMPT_VERSION: ${String(REFERENCE_MODEL_PROMPT_VERSION)}`,
    );

    fc.assert(
      fc.property(fc.constantFrom(...INPUT_ROLES), (role) => {
        expect(text).toContain(role);
      }),
    );
  });
});
