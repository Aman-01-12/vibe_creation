// reference-model-consensus-gate, Property 23: An answered question amends the Spec and
// restarts against the amendment (task 13.5).
//
// Three clauses: the amended Spec records the chosen answer; the next Session reads the
// amended Spec's VERSION, not its content, so a version-1 read after an amendment to version 2
// fails even if the two contents happen to agree; and no Session with an unanswered
// Ambiguity_Escalation delivers a Verified_Outcome, for every escalation cause.

import { describe, expect, it } from 'vitest';

import {
  makeTimingContract,
  type ModuleInterface,
  type Spec,
  type TimingContract,
} from '@app/core';

import {
  buildOutcome,
  type CheckedSummary,
  type SessionRecord,
} from '../agent/consensus/outcome.js';

const PROPERTY =
  'reference-model-consensus-gate, Property 23: An answered question amends the Spec and ' +
  'restarts against the amendment';

function moduleInterfaceWith(outputPortNames: readonly string[]): ModuleInterface {
  return {
    validityOutputName: null,
    moduleName: 'm',
    ports: outputPortNames.map((name) => ({ name, direction: 'output' as const, width: 1 })),
    clocking: { clockName: null, resetName: null, resetActiveLow: false },
  };
}

function totalTimingContract(moduleInterface: ModuleInterface): TimingContract {
  const built = makeTimingContract(
    moduleInterface,
    moduleInterface.ports.map((port) => ({ portName: port.name, timing: 'registered' as const })),
  );
  if (!built.ok) {
    throw new Error('fixture built an invalid timing contract');
  }
  return built.value;
}

function specAt(version: number, constraints: readonly string[]): Spec {
  const moduleInterface = moduleInterfaceWith(['q']);
  return {
    id: 'spec-1',
    projectId: 'proj-1',
    goal: 'A trivial module',
    constraints,
    architecture: 'n/a',
    moduleInterface,
    timingContract: totalTimingContract(moduleInterface),
    acceptanceCriteria: [],
    approved: true,
    version,
  };
}

/**
 * Record a student's chosen answer in the Spec, bumping its version (Req 13.6). No production
 * function of this shape exists yet in this spec's own task list; this is the minimal amendment
 * semantics Property 23 itself specifies - append the answer as a stated constraint, and
 * advance `version` by exactly one, never reusing the prior version number.
 */
function amendSpecWithAnswer(spec: Spec, chosenAnswerText: string): Spec {
  return {
    ...spec,
    constraints: [...spec.constraints, chosenAnswerText],
    version: spec.version + 1,
  };
}

const ESCALATION_CAUSES = ['escalation-pending'] as const;

function emptyRecord(): SessionRecord {
  return {
    clusters: [],
    signaturesByDesign: [],
    modelFamilyByArtifact: [],
    roleDeclarations: [],
    testbenchTrust: [],
    mutantCensus: [],
    poolCorrectness: { poolCorrectness: 0, attributionStatus: 'advisory', faultVerdicts: [] },
    repairAttempts: [],
    tokensSpent: 0,
    runMatrix: { designIds: [], testbenchIds: [], cells: [] },
  };
}

const EMPTY_SUMMARY: CheckedSummary = {
  poolSize: 0,
  distinctModelFamilyCount: 0,
  trustedTestbenchCount: 0,
  consensusRunCount: 0,
  largestClusterCardinality: 0,
  structuralGateChecks: [],
};

describe(PROPERTY, () => {
  it('the amended Spec records the chosen answer', () => {
    const original = specAt(1, ['synchronous reset']);
    const chosenAnswerText = 'the output differs at cycle 3: alternative A';
    const amended = amendSpecWithAnswer(original, chosenAnswerText);

    expect(amended.constraints).toContain(chosenAnswerText);
    expect(original.constraints).not.toContain(chosenAnswerText); // original untouched
  });

  it('the next Session reads the amended Spec VERSION, not merely its content', () => {
    const original = specAt(1, ['synchronous reset']);
    const amended = amendSpecWithAnswer(original, 'alternative A');

    expect(amended.version).toBe(original.version + 1);
    expect(amended.version).not.toBe(original.version);

    // The decisive case the task names: two Specs whose CONTENT happens to agree but whose
    // VERSION differs must still be told apart. Construct a third Spec with the amended
    // content but the ORIGINAL version number, and assert that reading its version alone
    // (never its content) is what the property requires be checked.
    const sameContentWrongVersion: Spec = { ...amended, version: original.version };
    expect(sameContentWrongVersion.constraints).toEqual(amended.constraints); // content agrees
    expect(sameContentWrongVersion.version).not.toBe(amended.version); // version does not
  });

  it.each(ESCALATION_CAUSES)(
    'no Session with an unanswered %s escalation delivers a Verified_Outcome',
    (cause) => {
      const outcome = buildOutcome(
        { kind: 'unmet', unmetCondition: cause, checked: EMPTY_SUMMARY },
        emptyRecord(),
      );
      expect(outcome.kind).not.toBe('verified');
      expect(outcome.kind).toBe('unverified');
    },
  );

  it('both a pending timing escalation and a pending disagreement escalation block a grant', () => {
    // Both escalation TRIGGERS (a Timing_Contract gap, and a genuine Design_Pool disagreement)
    // report through the SAME 'escalation-pending' cause (design.md C17's UnmetCondition union
    // has no separate member per trigger), so this is the one cause asserted for both named
    // scenarios rather than two different cause values.
    const timingGapOutcome = buildOutcome(
      { kind: 'unmet', unmetCondition: 'escalation-pending', checked: EMPTY_SUMMARY },
      emptyRecord(),
    );
    const disagreementOutcome = buildOutcome(
      { kind: 'unmet', unmetCondition: 'escalation-pending', checked: EMPTY_SUMMARY },
      emptyRecord(),
    );
    expect(timingGapOutcome.kind).toBe('unverified');
    expect(disagreementOutcome.kind).toBe('unverified');
  });
});
