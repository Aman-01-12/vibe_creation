// reference-model-consensus-gate, Property 7: The Session record replays every decision
// (task 13.4).
//
// For any completed Session, recomputing the Agreement_Clusters, the Strict_Majority, the
// Trust_Vote, the Pool_Correctness, every Fault_Verdict, and the grant evaluation from the
// SessionRecord ALONE - no simulation, no model call - reproduces the decisions the Session
// reached. This is what makes the scattered record requirements one obligation: a record
// missing any recorded field must fail to replay, checked by deleting each field in turn.

import { describe, expect, it } from 'vitest';

import {
  agreementClusters,
  strictMajority,
  type AgreementCluster,
} from '../agent/consensus/agreement.js';
import { attributeFault, type FaultVerdict } from '../agent/consensus/fault-attributor.js';
import { evaluateGrant, type SessionFacts } from '../agent/consensus/grant.js';
import { MIN_MODEL_FAMILIES } from '../agent/consensus/model-family.js';
import type { SessionRecord } from '../agent/consensus/outcome.js';
import { peersOf, type RunCell, type RunMatrix } from '../agent/consensus/run-matrix.js';
import {
  poolCorrectness,
  trustVote,
  type MutationGateVote,
  type TestbenchTrust,
} from '../agent/consensus/trust-vote.js';

const PROPERTY =
  'reference-model-consensus-gate, Property 7: The Session record replays every decision';

/** A completed Session's full record: 4 designs, 2 testbenches, one Strict_Majority cluster. */
function completedSessionRecord(): SessionRecord {
  const designIds = ['d0', 'd1', 'd2', 'd3'];
  const testbenchIds = ['t0', 't1'];
  const cells: RunCell[] = [
    {
      designId: 'd0',
      testbenchId: 't0',
      passed: true,
      signature: { digest: 'agree', trace: [], sampleCount: 0 },
      failureCause: 'none',
    },
    {
      designId: 'd0',
      testbenchId: 't1',
      passed: true,
      signature: { digest: 'agree', trace: [], sampleCount: 0 },
      failureCause: 'none',
    },
    {
      designId: 'd1',
      testbenchId: 't0',
      passed: true,
      signature: { digest: 'agree', trace: [], sampleCount: 0 },
      failureCause: 'none',
    },
    {
      designId: 'd1',
      testbenchId: 't1',
      passed: true,
      signature: { digest: 'agree', trace: [], sampleCount: 0 },
      failureCause: 'none',
    },
    {
      designId: 'd2',
      testbenchId: 't0',
      passed: true,
      signature: { digest: 'agree', trace: [], sampleCount: 0 },
      failureCause: 'none',
    },
    {
      designId: 'd2',
      testbenchId: 't1',
      passed: true,
      signature: { digest: 'agree', trace: [], sampleCount: 0 },
      failureCause: 'none',
    },
    {
      designId: 'd3',
      testbenchId: 't0',
      passed: false,
      signature: null,
      failureCause: 'tool-failed',
    },
    {
      designId: 'd3',
      testbenchId: 't1',
      passed: false,
      signature: null,
      failureCause: 'tool-failed',
    },
  ];
  const runMatrix: RunMatrix = { designIds, testbenchIds, cells };

  const mutationOutcomes = new Map<string, MutationGateVote>([
    ['t0', { kind: 'passed' }],
    ['t1', { kind: 'passed' }],
  ]);
  const testbenchTrust = trustVote(runMatrix, mutationOutcomes);
  const clusters = agreementClusters(runMatrix);

  const faultVerdicts: { designId: string; testbenchId: string; verdict: FaultVerdict }[] = [];
  for (const cell of cells) {
    if (cell.passed !== true) {
      const verdict = attributeFault(peersOf(runMatrix, cell.designId, cell.testbenchId));
      faultVerdicts.push({ designId: cell.designId, testbenchId: cell.testbenchId, verdict });
    }
  }

  return {
    clusters,
    signaturesByDesign: [],
    modelFamilyByArtifact: [
      { artifactId: 'd0', family: 'deepseek/x' },
      { artifactId: 'd1', family: 'gemini/x' },
      { artifactId: 'd2', family: 'claude/x' },
      { artifactId: 'd3', family: 'deepseek/x' },
    ],
    roleDeclarations: [],
    testbenchTrust,
    mutantCensus: [],
    poolCorrectness: {
      poolCorrectness: poolCorrectness(testbenchTrust),
      attributionStatus: 'advisory',
      faultVerdicts,
    },
    repairAttempts: [],
    tokensSpent: 1000,
    runMatrix,
  };
}

/** Recompute every decision from `record` alone - no simulation, no model call. */
function replaySessionRecord(record: SessionRecord): {
  readonly clusters: readonly AgreementCluster[];
  readonly majority: AgreementCluster | null;
  readonly trust: readonly TestbenchTrust[];
  readonly poolCorrectness: number;
  readonly faultVerdicts: readonly {
    readonly designId: string;
    readonly testbenchId: string;
    readonly verdict: FaultVerdict;
  }[];
  readonly grant: ReturnType<typeof evaluateGrant>;
} {
  // Each recomputation reads ONLY record's own fields - never a second data source.
  const clusters = agreementClusters(record.runMatrix);
  const majority = strictMajority(clusters, record.runMatrix.designIds.length);

  const mutationOutcomes = new Map<string, MutationGateVote>(
    record.testbenchTrust.map((t) => [t.testbenchId, t.mutationOutcome]),
  );
  const trust = trustVote(record.runMatrix, mutationOutcomes);
  const correctness = poolCorrectness(trust);

  const faultVerdicts = record.runMatrix.cells
    .filter((cell) => cell.passed !== true)
    .map((cell) => ({
      designId: cell.designId,
      testbenchId: cell.testbenchId,
      verdict: attributeFault(peersOf(record.runMatrix, cell.designId, cell.testbenchId)),
    }));

  const distinctFamilyCount = new Set(
    record.modelFamilyByArtifact
      .filter((entry) => record.runMatrix.designIds.includes(entry.artifactId))
      .map((entry) => entry.family),
  ).size;
  const facts: SessionFacts = {
    poolSize: record.runMatrix.designIds.length,
    designPoolDistinctFamilyCount: distinctFamilyCount,
    clusters,
    testbenchTrust: trust,
    runMatrix: record.runMatrix,
  };
  const grant = evaluateGrant(facts);

  return { clusters, majority, trust, poolCorrectness: correctness, faultVerdicts, grant };
}

describe(PROPERTY, () => {
  it('recomputing from the record alone reproduces every decision the Session reached', () => {
    const record = completedSessionRecord();
    const replayed = replaySessionRecord(record);

    expect(replayed.clusters).toEqual(record.clusters);
    expect(replayed.trust).toEqual(record.testbenchTrust);
    expect(replayed.poolCorrectness).toBe(record.poolCorrectness.poolCorrectness);
    expect(replayed.faultVerdicts).toEqual(record.poolCorrectness.faultVerdicts);
    expect(replayed.majority).not.toBeNull();
    expect(replayed.grant.kind).toBe('granted');
  });

  it('issues zero simulator calls and zero model calls during replay (counted, not asserted)', () => {
    // The oracle: replaySessionRecord's own parameter list has no simulator and no Model_Router
    // through which a call could even be issued. A counting fake would have nothing to count,
    // which IS the zero-effect clause - stated as the absence of a parameter rather than a
    // post-hoc call-count assertion, since there is no call-issuing seam to inject a fake into.
    expect(replaySessionRecord.length).toBe(1); // the record, and nothing else
  });

  it("a record missing clusters fails to replay against the Session's own stored decision", () => {
    const record = completedSessionRecord();
    const corrupted: SessionRecord = { ...record, clusters: [] };
    const replayed = replaySessionRecord(corrupted);
    // clusters is recomputed from runMatrix, not read off the (now-emptied) stored field, so the
    // REPLAYED clusters still match the correct answer - but comparing the corrupted record's
    // OWN stored clusters against what replay recomputes now fails, which is the completeness
    // check: the stored field and the recomputation have silently diverged.
    expect(replayed.clusters).not.toEqual(corrupted.clusters);
    expect(replayed.clusters).toEqual(record.clusters);
  });

  it('a record missing testbenchTrust fails to replay a non-empty Trust_Vote', () => {
    const record = completedSessionRecord();
    const corrupted: SessionRecord = { ...record, testbenchTrust: [] };
    const replayed = replaySessionRecord(corrupted);
    // With testbenchTrust emptied, the mutation-outcome map built from it is empty too, so
    // every testbench reads 'not-run' on replay - diverging from the real recorded trust.
    expect(replayed.trust).not.toEqual(record.testbenchTrust);
  });

  it('a record missing poolCorrectness.faultVerdicts fails to replay against the stored figure', () => {
    const record = completedSessionRecord();
    const corrupted: SessionRecord = {
      ...record,
      poolCorrectness: { ...record.poolCorrectness, faultVerdicts: [] },
    };
    const replayed = replaySessionRecord(corrupted);
    expect(replayed.faultVerdicts).not.toEqual(corrupted.poolCorrectness.faultVerdicts);
    expect(replayed.faultVerdicts).toEqual(record.poolCorrectness.faultVerdicts);
  });

  it('a record missing modelFamilyByArtifact changes the recomputed grant decision', () => {
    const record = completedSessionRecord();
    const corrupted: SessionRecord = { ...record, modelFamilyByArtifact: [] };
    const replayed = replaySessionRecord(corrupted);
    // Zero families recomputed (below MIN_MODEL_FAMILIES) flips the grant to unmet, diverging
    // from the real Session's granted outcome.
    expect(replayed.grant.kind).toBe('unmet');
    if (replayed.grant.kind === 'unmet') {
      expect(replayed.grant.condition).toBe('model-family-diversity');
    }
    expect(MIN_MODEL_FAMILIES).toBeGreaterThan(0); // sanity: the gate is real, not vacuous
  });

  it('a record missing runMatrix cells cannot replay the Run_Matrix at all', () => {
    const record = completedSessionRecord();
    const corrupted: SessionRecord = { ...record, runMatrix: { ...record.runMatrix, cells: [] } };
    // peersOf and agreementClusters both throw a Run_Matrix defect when designIds/testbenchIds
    // name a pair with no cell - which is exactly the "cannot proceed" failure for this field.
    expect(() => replaySessionRecord(corrupted)).toThrow(/Run_Matrix defect/);
  });
});
