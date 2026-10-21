// reference-model-consensus-gate, Property 24: The Unverified_Outcome states what was
// checked and leaks nothing (task 12.2).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  buildOutcome,
  type CheckedSummary,
  type OutcomeInput,
  type SessionRecord,
  type UnmetCondition,
} from '../agent/consensus/outcome.js';
import type { AgreementCluster } from '../agent/consensus/agreement.js';

import { propertyParameters } from './property.js';

const PROPERTY =
  'reference-model-consensus-gate, Property 24: The Unverified_Outcome states what was ' +
  'checked and leaks nothing';

/** The 9-member UnmetCondition union (5 GrantConditionId + 2 BudgetCause + 2 named causes). */
const UNMET_CONDITIONS: readonly UnmetCondition[] = [
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

function summaryFrom(record: SessionRecord): CheckedSummary {
  return {
    poolSize: record.runMatrix.designIds.length,
    distinctModelFamilyCount: new Set(record.modelFamilyByArtifact.map((entry) => entry.family))
      .size,
    trustedTestbenchCount: record.testbenchTrust.filter((testbench) => testbench.trusted).length,
    consensusRunCount: record.runMatrix.cells.length,
    largestClusterCardinality: record.clusters.reduce(
      (max, cluster) => Math.max(max, cluster.designIds.length),
      0,
    ),
    structuralGateChecks: record.runMatrix.designIds.map((designId) => ({
      designId,
      admitted: true,
    })),
  };
}

describe(PROPERTY, () => {
  it('the summary figures equal those recomputed from the record, for every unmet condition', () => {
    for (const unmetCondition of UNMET_CONDITIONS) {
      const record = emptyRecord();
      const summary = summaryFrom(record);
      const input: OutcomeInput = { kind: 'unmet', unmetCondition, checked: summary };
      const outcome = buildOutcome(input, record);
      expect(outcome.kind).toBe('unverified');
      if (outcome.kind === 'unverified') {
        expect(outcome.checked).toEqual(summaryFrom(outcome.record));
      }
    }
  });

  it('the next-action set is exactly what each of the nine causes permits', () => {
    const budgetExhausted: ReadonlySet<UnmetCondition> = new Set([
      'session-token-budget',
      'run-token-budget',
    ]);
    for (const unmetCondition of UNMET_CONDITIONS) {
      const record = emptyRecord();
      const outcome = buildOutcome(
        { kind: 'unmet', unmetCondition, checked: summaryFrom(record) },
        record,
      );
      expect(outcome.kind).toBe('unverified');
      if (outcome.kind !== 'unverified') {
        continue;
      }
      expect(outcome.nextActions.length).toBeGreaterThan(0);
      if (budgetExhausted.has(unmetCondition)) {
        expect(outcome.nextActions).toEqual(['accept-unverified']);
      } else if (unmetCondition === 'escalation-pending') {
        expect(outcome.nextActions).toEqual(['answer-behaviour-question', 'accept-unverified']);
      } else {
        expect(outcome.nextActions).toEqual(['request-another-attempt', 'accept-unverified']);
      }
    }
  });

  it('no field of either outcome member can hold a claim that a design is incorrect', () => {
    const record = emptyRecord();
    const unverified = buildOutcome(
      { kind: 'unmet', unmetCondition: 'escalation-pending', checked: summaryFrom(record) },
      record,
    );
    const cluster: AgreementCluster = { designIds: [], digestsByTestbench: [] };
    const verified = buildOutcome({ kind: 'granted', cluster }, record);
    // Absence check: the key sets of both members name no "incorrect"/"wrong"/"invalid design" field.
    const unverifiedKeys = Object.keys(unverified);
    const verifiedKeys = Object.keys(verified);
    for (const key of [...unverifiedKeys, ...verifiedKeys]) {
      expect(key.toLowerCase()).not.toMatch(/incorrect|wrong|invalid/);
    }
  });

  it('planted hostile strings in legitimate id/family fields do not leak beyond what was placed', () => {
    const hostileStrings = [
      '/etc/passwd',
      'internal-host.corp.example',
      '\u001b[31mred\u001b[0m',
      'line one\nline two',
      'x'.repeat(10_000),
    ];
    fc.assert(
      fc.property(fc.constantFrom(...hostileStrings), (hostile) => {
        const record: SessionRecord = {
          ...emptyRecord(),
          modelFamilyByArtifact: [{ artifactId: hostile, family: hostile }],
          mutantCensus: [
            { testbenchId: hostile, killedMutantIds: [hostile], survivingMutantIds: [] },
          ],
        };
        const outcome = buildOutcome(
          { kind: 'unmet', unmetCondition: 'escalation-pending', checked: summaryFrom(record) },
          record,
        );
        const serialized = JSON.stringify(outcome);
        // Count occurrences of the JSON-ENCODED form, since a control character (e.g. a
        // newline) round-trips through JSON.stringify as an escape sequence, not literally.
        const encodedFragment = JSON.stringify(hostile).slice(1, -1);
        expect(serialized).toContain(encodedFragment);
        const occurrences = serialized.split(encodedFragment).length - 1;
        // artifactId, family, testbenchId, and killedMutantIds[0] each use the hostile string.
        expect(occurrences).toBe(4);
      }),
      propertyParameters(),
    );
  });
});
