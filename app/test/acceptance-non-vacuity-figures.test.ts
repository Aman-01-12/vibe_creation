//
// Criterion 7.10 obliges a REPORTING path to carry particular content: every figure the
// Acceptance_Measurement driver reports for a design whose Total_Role_Declaration names a
// Strobe or a Held_Input stands beside that design's Non_Vacuity_Check result, so no reported
// figure rests on a Consensus_Run whose hold was never held and whose pulse never pulsed.
// That is an obligation over what the table emits for a given input, not over a measured value
// coming out a particular way, so this is a unit test over a constructed WitnessDesignReport -
// task 12.3's framing, for the same reason. No Session and no simulator run: free.
//
// The negative direction is what makes the obligation meaningful. The glossary defines the
// check as reporting whether a hold held and a pulse pulsed, so an all-`data` or all-`enable`
// declaration has neither and is asked for no check at all - asserted here both at the filter
// that selects candidates and at the rendered report that omits the line.

import { describe, expect, it } from 'vitest';

import { REFERENCE_MODEL_PROMPT_VERSION } from '@app/agent';
import type { NonVacuityOutcome, RoleDeclaration } from '@app/tools';

import {
  buildOutcome,
  type CheckedSummary,
  type SessionOutcome,
  type SessionRecord,
} from '../agent/consensus/outcome.js';
import {
  nonVacuityCandidateDeclarations,
  renderWitnessDesignReport,
} from '../eval/scripts/stimulus-transaction-acceptance.js';

type DesignReport = Parameters<typeof renderWitnessDesignReport>[0];
type SessionReport = DesignReport['sessions'][number];
type NonVacuityForDeclaration = SessionReport['nonVacuity'][number];

const WITNESS_ID = 'rtllm/miscellaneous/square_wave';

/** Names both a Strobe and a Held_Input: the case criterion 7.10 asks a Non_Vacuity_Check for. */
const STROBE_AND_HOLD: RoleDeclaration = [
  { portName: 'valid', role: 'strobe' },
  { portName: 'payload', role: 'hold' },
  { portName: 'mode', role: 'data' },
];

/** Nothing to hold and nothing to pulse, so the check has nothing to report. */
const DATA_AND_ENABLE_ONLY: RoleDeclaration = [
  { portName: 'payload', role: 'data' },
  { portName: 'go', role: 'enable' },
];

const PROBE_REFUSAL_REASON = 'probe render refused (role-not-total): port mode carries no role';

/** The `incomplete` arm of the union: a reason, and no reading behind it (Req 7.8). */
const INCOMPLETE_READING: NonVacuityOutcome = {
  kind: 'incomplete',
  reason: PROBE_REFUSAL_REASON,
};

/** The complete arm: one whole Hold_Window and one reset-free Strobe_Period, read. */
function completeReading(demonstratesTransactionStructure: boolean): NonVacuityOutcome {
  return {
    kind: 'read',
    holdWindowsByPort: [
      {
        portName: 'payload',
        windows: [{ windowIndex: 0, firstStep: 0, changeCount: 0, changeSteps: [] }],
        distinctHoldValueCount: 2,
        portWidth: 8,
      },
    ],
    strobePeriodsByPort: [
      {
        portName: 'valid',
        periods: [{ periodIndex: 0, assertedStepCount: 1, assertedSteps: [4] }],
      },
    ],
    wholeHoldWindowCount: 1,
    resetFreeStrobePeriodCount: 1,
    strobePeriod: 20,
    holdFramePeriod: 20,
    demonstratesTransactionStructure,
  };
}

/** A measured Session reporting every figure of C15's table. The Role_Adoption_Share numerator
 * tracks the declarations carried, so a Session asked for no check also reports no adoption. */
function measuredSession(
  index: number,
  nonVacuity: readonly NonVacuityForDeclaration[],
): SessionReport {
  return {
    index,
    outcomeKind: 'unverified',
    unmetCondition: 'strict-majority',
    incompleteReason: null,
    passingCells: 12,
    totalCells: 64,
    trustedTestbenchCount: 1,
    roleAdoptionShare: {
      problemId: WITNESS_ID,
      role: 'hold',
      numerator: nonVacuity.length,
      denominator: 8,
      refusedReplyCount: 0,
      referenceModelPromptVersion: REFERENCE_MODEL_PROMPT_VERSION,
      floorMeasurable: true,
    },
    nonVacuity,
    cliquePartition: null,
  };
}

function designReporting(sessions: readonly SessionReport[]): DesignReport {
  return { problemId: WITNESS_ID, sessions };
}

/** The reported figures of C15's own table; the `square_wave` and `multi_16bit` arms of
 * `renderWitnessDesignReport` emit different ones, so both markers are listed. */
const FIGURE_MARKERS = [
  'Role_Adoption_Share',
  'Verified_Outcome count',
  'passing matrix cells',
  'mean Trusted_Testbench count',
] as const;

function linesContaining(rendered: string, marker: string): readonly string[] {
  return rendered.split('\n').filter((line) => line.includes(marker));
}

function figureLines(rendered: string): readonly string[] {
  return rendered
    .split('\n')
    .filter((line) => FIGURE_MARKERS.some((marker) => line.includes(marker)));
}

/** One Session's accepted Role_Declarations, as a real `SessionOutcome` built by the production
 * `buildOutcome`; `nonVacuityCandidateDeclarations` reads them and nothing else. */
function outcomeDeclaring(declarations: readonly RoleDeclaration[]): SessionOutcome {
  const nothingChecked: CheckedSummary = {
    poolSize: 0,
    distinctModelFamilyCount: 0,
    trustedTestbenchCount: 0,
    consensusRunCount: 0,
    largestClusterCardinality: 0,
    structuralGateChecks: [],
  };
  const record: SessionRecord = {
    clusters: [],
    signaturesByDesign: [],
    modelFamilyByArtifact: [],
    roleDeclarations: declarations.map((roles, index) => ({
      testbenchId: `tb${String(index)}`,
      roles,
    })),
    testbenchTrust: [],
    mutantCensus: [],
    poolCorrectness: { poolCorrectness: 0, attributionStatus: 'advisory', faultVerdicts: [] },
    repairAttempts: [],
    tokensSpent: 0,
    runMatrix: { designIds: [], testbenchIds: [], cells: [] },
  };
  return buildOutcome(
    { kind: 'unmet', unmetCondition: 'strict-majority', checked: nothingChecked },
    record,
  );
}

describe('renderWitnessDesignReport - every figure carries its Non_Vacuity_Check result', () => {
  it('given a Session declaring a Strobe and a Held_Input, when the design report renders, then its Non_Vacuity_Check result stands beside the reported figures, on both Witness_Design arms', () => {
    const report = designReporting([
      measuredSession(0, [{ roles: STROBE_AND_HOLD, outcome: completeReading(true) }]),
    ]);

    for (const isSquareWave of [true, false]) {
      const rendered = renderWitnessDesignReport(report, isSquareWave);
      // Guards the assertion below against passing on a report that reported no figure at all.
      expect(figureLines(rendered).length).toBeGreaterThan(0);

      const checks = linesContaining(rendered, 'Non_Vacuity_Check');
      expect(checks).toHaveLength(1);
      expect(checks[0]).toContain('session 0');
      expect(checks[0]).toContain('demonstratesTransactionStructure=true');
    }
  });

  it('given two Sessions whose checks took the two different arms of the outcome union, when the design report renders, then each figure carries its own Session result and the incomplete arm states its reason', () => {
    const rendered = renderWitnessDesignReport(
      designReporting([
        measuredSession(0, [{ roles: STROBE_AND_HOLD, outcome: completeReading(false) }]),
        measuredSession(1, [{ roles: STROBE_AND_HOLD, outcome: INCOMPLETE_READING }]),
      ]),
      true,
    );

    expect(linesContaining(rendered, 'Non_Vacuity_Check')).toEqual([
      '    session 0 Non_Vacuity_Check: demonstratesTransactionStructure=false',
      `    session 1 Non_Vacuity_Check: incomplete (${PROBE_REFUSAL_REASON})`,
    ]);
  });

  it('given a Session asked for no Non_Vacuity_Check, when the design report renders, then it reports its figures and no Non_Vacuity_Check line', () => {
    const rendered = renderWitnessDesignReport(designReporting([measuredSession(0, [])]), true);

    expect(figureLines(rendered).length).toBeGreaterThan(0);
    expect(linesContaining(rendered, 'Non_Vacuity_Check')).toEqual([]);
  });
});

describe('nonVacuityCandidateDeclarations - which declarations are asked for a check', () => {
  it('given an accepted declaration naming neither a Strobe nor a Held_Input, when the candidates are selected, then it is not among them', () => {
    expect(nonVacuityCandidateDeclarations(outcomeDeclaring([DATA_AND_ENABLE_ONLY]))).toEqual([]);
  });

  it('given one declaration naming a Strobe and a Held_Input beside one naming neither, when the candidates are selected, then only the first is asked for a check', () => {
    const outcome = outcomeDeclaring([DATA_AND_ENABLE_ONLY, STROBE_AND_HOLD]);

    expect(nonVacuityCandidateDeclarations(outcome)).toEqual([STROBE_AND_HOLD]);
  });
});
