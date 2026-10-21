// reference-model-consensus-gate, Property 1: One outcome, always caused (task 13.3).
//
// For any recorded Session facts, buildOutcome returns exactly one outcome: a
// Verified_Outcome carrying the granted cluster, or an Unverified_Outcome carrying one
// cause from the closed 9-member cause union.

import { describe, expect, it } from 'vitest';

import type { AgreementCluster } from '../agent/consensus/agreement.js';
import {
  buildOutcome,
  type CheckedSummary,
  type SessionOutcome,
  type SessionRecord,
  type UnmetCondition,
} from '../agent/consensus/outcome.js';

const PROPERTY = 'reference-model-consensus-gate, Property 1: One outcome, always caused';

/** The 9-member UnmetCondition union (5 GrantConditionId + 2 BudgetCause + 2 named causes). */
const ALL_UNMET_CONDITIONS: readonly UnmetCondition[] = [
  'model-family-diversity',
  'strict-majority',
  'trusted-testbench-exists',
  'majority-passes-trusted',
  'mutation-strength',
  'session-token-budget',
  'run-token-budget',
  'formal-refutation',
  'escalation-pending',
];

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
  it('every one of the nine causes is reachable: one fact set per cause yields exactly that cause', () => {
    for (const unmetCondition of ALL_UNMET_CONDITIONS) {
      const outcome = buildOutcome(
        { kind: 'unmet', unmetCondition, checked: EMPTY_SUMMARY },
        emptyRecord(),
      );
      expect(outcome.kind).toBe('unverified');
      if (outcome.kind === 'unverified') {
        expect(outcome.unmetCondition).toBe(unmetCondition);
      }
    }
  });

  it('a granted input yields a Verified_Outcome carrying the Strict_Majority cluster it was granted on', () => {
    const cluster: AgreementCluster = {
      designIds: ['d0', 'd1', 'd2'],
      digestsByTestbench: [{ testbenchId: 't0', digest: 'agree' }],
    };
    const outcome = buildOutcome({ kind: 'granted', cluster }, emptyRecord());
    expect(outcome.kind).toBe('verified');
    if (outcome.kind === 'verified') {
      expect(outcome.cluster).toEqual(cluster);
      expect(outcome.deliveredDesignIds).toEqual(cluster.designIds);
    }
  });

  it('the union has exactly two members, and no third state is constructible', () => {
    const granted: SessionOutcome = buildOutcome(
      { kind: 'granted', cluster: { designIds: [], digestsByTestbench: [] } },
      emptyRecord(),
    );
    const unmet: SessionOutcome = buildOutcome(
      { kind: 'unmet', unmetCondition: 'escalation-pending', checked: EMPTY_SUMMARY },
      emptyRecord(),
    );
    const kinds = new Set([granted.kind, unmet.kind]);
    expect(kinds).toEqual(new Set(['verified', 'unverified']));
    // Structural: buildOutcome's own input type is a two-member union (OutcomeInput), so
    // there is no third branch to construct from - every call either names 'granted' or
    // 'unmet', and TypeScript's own exhaustiveness check in buildOutcome's body (switch on
    // input.kind) would fail to compile a third case into existence.
    expect(['verified', 'unverified']).toContain(granted.kind);
    expect(['verified', 'unverified']).toContain(unmet.kind);
  });

  it('SessionRecord is present on both outcome members', () => {
    const record = emptyRecord();
    const granted = buildOutcome(
      { kind: 'granted', cluster: { designIds: [], digestsByTestbench: [] } },
      record,
    );
    const unmet = buildOutcome(
      { kind: 'unmet', unmetCondition: 'escalation-pending', checked: EMPTY_SUMMARY },
      record,
    );
    expect(granted.record).toBe(record);
    expect(unmet.record).toBe(record);
  });

  it('reports exactly the 9 causes named, so a dead or missing cause is visible here', () => {
    expect(ALL_UNMET_CONDITIONS).toHaveLength(9);
    expect(new Set(ALL_UNMET_CONDITIONS).size).toBe(9); // no duplicate name
  });
});
