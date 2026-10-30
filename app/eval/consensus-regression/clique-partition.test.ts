// Fakes-only unit tests for `cliquePartitionOf` (task 11.7, C14; Req 10.6, 10.11).
//
// No toolchain, no simulator: every fixture supplies `record.clusters` and `record.runMatrix`
// directly, since the reducer is pure and reads only those two fields.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { AgreementCluster, RunCell, SessionRecord, WaveformSignature } from '@app/agent';

import { cliquePartitionOf } from './clique-partition.js';

/** A `SessionRecord` carrying only `clusters` and `runMatrix` - the two fields this reducer reads. */
function recordWith(
  clusters: readonly AgreementCluster[],
  designIds: readonly string[],
  testbenchIds: readonly string[],
  cells: readonly RunCell[],
): SessionRecord {
  return {
    clusters,
    signaturesByDesign: [],
    modelFamilyByArtifact: [],
    roleDeclarations: [],
    testbenchTrust: [],
    mutantCensus: [],
    poolCorrectness: { poolCorrectness: 0, attributionStatus: 'advisory', faultVerdicts: [] },
    repairAttempts: [],
    tokensSpent: 0,
    runMatrix: { designIds, testbenchIds, cells },
  };
}

/** A passed cell whose retained trace carries exactly `nonNullCount` non-null entries. */
function passedCell(designId: string, testbenchId: string, nonNullCount: number): RunCell {
  const signature: WaveformSignature = {
    digest: 'agree',
    trace: Array.from({ length: nonNullCount }, (_, step) => ({ step, values: ['1'] })),
    sampleCount: nonNullCount,
  };
  return { designId, testbenchId, passed: true, signature, failureCause: 'none' };
}

/** A failed cell, as every incomplete run's cell is (Req 7.7): no signature, no CHECK count. */
function failedCell(designId: string, testbenchId: string): RunCell {
  return { designId, testbenchId, passed: false, signature: null, failureCause: 'tool-failed' };
}

describe('cliquePartitionOf - a 2+ member clique with matching CHECK counts', () => {
  it('reports the shared count with no collision flagged, and groups the one testbench they both passed', () => {
    const record = recordWith(
      [{ designIds: ['d1', 'd2'], digestsByTestbench: [{ testbenchId: 't1', digest: 'agree' }] }],
      ['d1', 'd2'],
      ['t1'],
      [passedCell('d1', 't1', 4), passedCell('d2', 't1', 4)],
    );

    const partition = cliquePartitionOf(record);

    expect(partition.designCliques).toEqual([
      {
        designIds: ['d1', 'd2'],
        checkCountsByTestbench: [{ testbenchId: 't1', checkCount: 4 }],
        totalCheckCount: 4,
        digestCollisionSuspected: false,
      },
    ]);
    expect(partition.testbenchPartition).toEqual([
      { testbenchIds: ['t1'], passingDesignIds: ['d1', 'd2'] },
    ]);
  });
});

describe('cliquePartitionOf - digestCollisionSuspected', () => {
  it('flags the clique when two members report different counts, rather than silently taking the first', () => {
    const record = recordWith(
      [{ designIds: ['d1', 'd2'], digestsByTestbench: [{ testbenchId: 't1', digest: 'agree' }] }],
      ['d1', 'd2'],
      ['t1'],
      [passedCell('d1', 't1', 4), passedCell('d2', 't1', 7)],
    );

    const partition = cliquePartitionOf(record);

    const clique = partition.designCliques[0];
    expect(clique?.digestCollisionSuspected).toBe(true);
    // The count is still reported (the first member's own) - collision is flagged, not hidden.
    expect(clique?.checkCountsByTestbench).toEqual([{ testbenchId: 't1', checkCount: 4 }]);
  });
});

describe('cliquePartitionOf - singletons on both sides of the partition', () => {
  it('keeps a lone design in its own clique and each differently-passed testbench in its own group', () => {
    // d1 passes both testbenches; d2 fails t1 entirely, so d2 joins no cluster at all (an
    // incomplete run has no complete digest tuple), and t1/t2 end up with different passing sets.
    const record = recordWith(
      [
        {
          designIds: ['d1'],
          digestsByTestbench: [
            { testbenchId: 't1', digest: 'a' },
            { testbenchId: 't2', digest: 'a' },
          ],
        },
      ],
      ['d1', 'd2'],
      ['t1', 't2'],
      [
        passedCell('d1', 't1', 3),
        passedCell('d1', 't2', 3),
        failedCell('d2', 't1'),
        passedCell('d2', 't2', 3),
      ],
    );

    const partition = cliquePartitionOf(record);

    expect(partition.designCliques).toEqual([
      {
        designIds: ['d1'],
        checkCountsByTestbench: [
          { testbenchId: 't1', checkCount: 3 },
          { testbenchId: 't2', checkCount: 3 },
        ],
        totalCheckCount: 6,
        digestCollisionSuspected: false,
      },
    ]);
    expect(partition.testbenchPartition).toEqual([
      { testbenchIds: ['t1'], passingDesignIds: ['d1'] },
      { testbenchIds: ['t2'], passingDesignIds: ['d1', 'd2'] },
    ]);
  });
});

describe('cliquePartitionOf - CliquePartition carries no trust/verdict/precision field (Req 10.11)', () => {
  it('has exactly the two documented partition fields at the top level', () => {
    const record = recordWith([], ['d1'], ['t1'], [passedCell('d1', 't1', 1)]);

    const partition = cliquePartitionOf(record);

    expect(Object.keys(partition).sort()).toEqual(['designCliques', 'testbenchPartition']);
  });
});

// -- Property 24 (task 11.8, C14; Req 10.6, 10.11) --------------------------------------------
//
// **Feature: stimulus-transaction-structure, Property 24: The clique partition partitions both
// pools and its CHECK count reconciles**
//
// THE PRECONDITION THIS FIXTURE RESPECTS
//   `checkCountsOf` (clique-partition.ts) assumes every member of a `record.clusters` entry
//   carries a non-null signature at every testbench - exactly what `agreementClusters` already
//   guarantees before admitting a design to a cluster. This fixture keeps that contract by
//   construction: a design is built either "complete" (a cluster member, signature everywhere)
//   or "incomplete" (in no cluster, missing a signature at exactly one testbench), never a
//   half-formed cluster membership.
//
// THE ORACLE IS A RELATION, NOT A RESTATEMENT OF THE REDUCER'S OWN ALGORITHM
//   The Design_Pool check compares the reported cliques against the generator's own
//   complete/incomplete split. The Testbench_Pool check never rebuilds `testbenchPartitionOf`'s
//   grouping key; it instead checks the partition relation directly from the matrix's own
//   `passed` cells: two testbenches land in one reported group if and only if an independently
//   computed passing-design set agrees between them, and every group's `passingDesignIds`
//   matches that independent computation. The CHECK count check scans `cells` for the clique's
//   own members' retained traces, the literal text of Req 10.6, never `checkCountOf` itself.
//
// NON-VACUITY, FORCED
//   Two designs share a label so a 2+ member clique's CHECK reconciliation always runs; one
//   design is always built incomplete so "appears in no clique" is never left to a random draw
//   that happens not to produce one. A variable 0-4 extras, each independently shaped, add
//   further cliques, singletons, and testbench groupings on top.
//
// Validates: Requirements 10.6, 10.11

const PROPERTY_24 =
  'stimulus-transaction-structure, Property 24: The clique partition partitions both pools and ' +
  'its CHECK count reconciles';

const CLUSTER_LABELS = ['alpha', 'bravo', 'charlie'] as const;
type ClusterLabel = (typeof CLUSTER_LABELS)[number];

type Shape24 = 'complete' | 'incomplete';

/** One planted design: its shape, the label its cluster membership derives from (meaningful
 * only for a "complete" design), and which testbench a "incomplete" design has no signature
 * under. */
interface DesignSpec24 {
  readonly id: string;
  readonly shape: Shape24;
  readonly clusterLabel: ClusterLabel;
  readonly missingTestbenchIndex: number;
}

/** `array[index]`, or throw: the generator's own construction must cover every forced role. */
function at24<T>(array: readonly T[], index: number): T {
  const value = array[index];
  if (value === undefined) {
    throw new Error(`generator produced too few entries (missing index ${index})`);
  }
  return value;
}

function testbenchIdsArbitrary24(): fc.Arbitrary<readonly string[]> {
  return fc
    .integer({ min: 2, max: 4 })
    .map((count) => Array.from({ length: count }, (_, index) => `t${index}`));
}

function extraSpecArbitrary24(testbenchCount: number): fc.Arbitrary<Omit<DesignSpec24, 'id'>> {
  return fc.record<Omit<DesignSpec24, 'id'>>({
    shape: fc.constantFrom<Shape24>('complete', 'incomplete'),
    clusterLabel: fc.constantFrom(...CLUSTER_LABELS),
    missingTestbenchIndex: fc.nat({ max: testbenchCount - 1 }),
  });
}

/** Per label, the CHECK count every member sharing that label reports at each testbench, in
 * `testbenchIds` order - identical across members by construction, so reconciliation always
 * has a single value to agree on. */
function checkCountsByLabelArbitrary24(
  testbenchCount: number,
): fc.Arbitrary<Record<ClusterLabel, readonly number[]>> {
  const countsArbitrary = fc.array(fc.nat({ max: 5 }), {
    minLength: testbenchCount,
    maxLength: testbenchCount,
  });
  return fc.record({ alpha: countsArbitrary, bravo: countsArbitrary, charlie: countsArbitrary });
}

interface Scenario24 {
  readonly testbenchIds: readonly string[];
  readonly designSpecs: readonly DesignSpec24[];
  readonly checkCountsByLabel: Record<ClusterLabel, readonly number[]>;
}

/**
 * Three designs forced into fixed roles (two sharing a label, one missing exactly one
 * testbench's signature) plus 0-4 independently shaped extras.
 */
function scenarioArbitrary24(): fc.Arbitrary<Scenario24> {
  return testbenchIdsArbitrary24().chain((testbenchIds) => {
    const testbenchCount = testbenchIds.length;
    return fc.integer({ min: 0, max: 4 }).chain((extraCount) => {
      const totalCount = 3 + extraCount;
      const ids = Array.from({ length: totalCount }, (_, index) => `design-${index}`);
      return fc
        .record({
          forcedIncompleteMissingIndex: fc.nat({ max: testbenchCount - 1 }),
          extraSpecs: fc.array(extraSpecArbitrary24(testbenchCount), {
            minLength: extraCount,
            maxLength: extraCount,
          }),
          checkCountsByLabel: checkCountsByLabelArbitrary24(testbenchCount),
        })
        .map(({ forcedIncompleteMissingIndex, extraSpecs, checkCountsByLabel }) => {
          const sharedLabel = at24(CLUSTER_LABELS, 0);
          const forced: DesignSpec24[] = [
            {
              id: at24(ids, 0),
              shape: 'complete',
              clusterLabel: sharedLabel,
              missingTestbenchIndex: 0,
            },
            {
              id: at24(ids, 1),
              shape: 'complete',
              clusterLabel: sharedLabel,
              missingTestbenchIndex: 0,
            },
            {
              id: at24(ids, 2),
              shape: 'incomplete',
              clusterLabel: sharedLabel,
              missingTestbenchIndex: forcedIncompleteMissingIndex,
            },
          ];
          const extras: DesignSpec24[] = extraSpecs.map((spec, index) => ({
            id: at24(ids, 3 + index),
            ...spec,
          }));
          return { testbenchIds, designSpecs: [...forced, ...extras], checkCountsByLabel };
        });
    });
  });
}

/** One `RunCell` per (design, testbench) pair: `failedCell` only at the one testbench an
 * "incomplete" design is missing, `passedCell` everywhere else with the design's own label's
 * planted CHECK count at that testbench. */
function cellsFor24(
  designSpecs: readonly DesignSpec24[],
  testbenchIds: readonly string[],
  checkCountsByLabel: Record<ClusterLabel, readonly number[]>,
): RunCell[] {
  const cells: RunCell[] = [];
  for (const spec of designSpecs) {
    const counts = checkCountsByLabel[spec.clusterLabel];
    testbenchIds.forEach((testbenchId, index) => {
      const missing = spec.shape === 'incomplete' && index === spec.missingTestbenchIndex;
      cells.push(
        missing
          ? failedCell(spec.id, testbenchId)
          : passedCell(spec.id, testbenchId, counts[index] ?? 0),
      );
    });
  }
  return cells;
}

/** `record.clusters` for `designSpecs`: every "complete" design grouped by its own label, with
 * no cluster for a label no "complete" design carries. */
function clustersFor24(designSpecs: readonly DesignSpec24[]): AgreementCluster[] {
  const membersByLabel = new Map<ClusterLabel, string[]>();
  for (const spec of designSpecs) {
    if (spec.shape !== 'complete') {
      continue;
    }
    const members = membersByLabel.get(spec.clusterLabel) ?? [];
    members.push(spec.id);
    membersByLabel.set(spec.clusterLabel, members);
  }
  return [...membersByLabel.values()].map((designIds) => ({ designIds, digestsByTestbench: [] }));
}

/** `cells`'s own entry for (designId, testbenchId), or throw: a fixture defect, not a reading. */
function cellAt24(cells: readonly RunCell[], designId: string, testbenchId: string): RunCell {
  const cell = cells.find((c) => c.designId === designId && c.testbenchId === testbenchId);
  if (cell === undefined) {
    throw new Error(`fixture defect: no cell for ${designId} x ${testbenchId}`);
  }
  return cell;
}

/** The design ids, in `designIds` order, whose own cell passed `testbenchId` - the independent
 * restatement of what "the same Candidate_Designs passed" means, read straight from `cells`. */
function passingSetAt24(
  cells: readonly RunCell[],
  designIds: readonly string[],
  testbenchId: string,
): readonly string[] {
  return designIds.filter((id) => cellAt24(cells, id, testbenchId).passed === true);
}

/** The CHECK count Req 10.6 defines: the non-null entries across every sample of one cell's own
 * retained trace. Scans `cells` directly - never `checkCountOf` - so this is a second route to
 * the same number, not a second reading of the first. */
function nonNullTraceCountAt24(
  cells: readonly RunCell[],
  designId: string,
  testbenchId: string,
): number {
  const signature = cellAt24(cells, designId, testbenchId).signature;
  if (signature === null) {
    throw new Error(`fixture defect: ${designId} has no signature at ${testbenchId}`);
  }
  let count = 0;
  for (const sample of signature.trace) {
    for (const value of sample.values) {
      if (value !== null) {
        count += 1;
      }
    }
  }
  return count;
}

/** Every object key anywhere in `value`'s structure matching "trust", "verdict", or
 * "precision" (case-insensitively) - the runtime half of Req 10.11, complementing the
 * `CliquePartition` type's own absence of such a field. */
function forbiddenKeysIn(value: unknown): readonly string[] {
  const forbidden = /trust|verdict|precision/i;
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, entryValue] of Object.entries(node)) {
        if (forbidden.test(key)) {
          found.push(key);
        }
        walk(entryValue);
      }
    }
  };
  walk(value);
  return found;
}

describe(PROPERTY_24, () => {
  it(
    'partitions the Design_Pool into exactly the complete designs, partitions the ' +
      'Testbench_Pool exactly once each, reconciles every 2+ member clique CHECK count against ' +
      "the matrix's own retained traces, and carries no trust label, correctness verdict, or " +
      'Clique_Precision value',
    () => {
      let incompleteDesignCases = 0;
      let multiMemberCliqueCases = 0;

      fc.assert(
        fc.property(scenarioArbitrary24(), (scenario) => {
          const { testbenchIds, designSpecs, checkCountsByLabel } = scenario;
          const designIds = designSpecs.map((spec) => spec.id);
          const cells = cellsFor24(designSpecs, testbenchIds, checkCountsByLabel);
          const clusters = clustersFor24(designSpecs);
          const record = recordWith(clusters, designIds, testbenchIds, cells);

          const partition = cliquePartitionOf(record);

          const completeIds = designSpecs
            .filter((spec) => spec.shape === 'complete')
            .map((spec) => spec.id);
          const incompleteIds = designSpecs
            .filter((spec) => spec.shape === 'incomplete')
            .map((spec) => spec.id);

          // (a) Design_Pool partition: a complete design is in exactly one clique; an incomplete
          // one is in none.
          const cliqueCountOf = new Map<string, number>();
          for (const clique of partition.designCliques) {
            for (const id of clique.designIds) {
              cliqueCountOf.set(id, (cliqueCountOf.get(id) ?? 0) + 1);
            }
          }
          for (const id of completeIds) {
            expect(cliqueCountOf.get(id)).toBe(1);
          }
          for (const id of incompleteIds) {
            expect(cliqueCountOf.has(id)).toBe(false);
            incompleteDesignCases += 1;
          }
          const cliqueUnion = partition.designCliques.flatMap((clique) => clique.designIds);
          expect([...cliqueUnion].sort()).toEqual([...completeIds].sort());

          // (b) Testbench_Pool partition: exact coverage with no duplicate, and the partition
          // relation matches an independently read passing-design set per testbench.
          const reportedTestbenchIds = partition.testbenchPartition.flatMap(
            (group) => group.testbenchIds,
          );
          expect([...reportedTestbenchIds].sort()).toEqual([...testbenchIds].sort());
          expect(new Set(reportedTestbenchIds).size).toBe(reportedTestbenchIds.length);

          const reportedGroupIndexOf = new Map<string, number>();
          partition.testbenchPartition.forEach((group, groupIndex) => {
            for (const testbenchId of group.testbenchIds) {
              reportedGroupIndexOf.set(testbenchId, groupIndex);
            }
          });
          for (const group of partition.testbenchPartition) {
            const firstTestbenchId = at24(group.testbenchIds, 0);
            const expectedPassingSet = [
              ...passingSetAt24(cells, designIds, firstTestbenchId),
            ].sort();
            for (const testbenchId of group.testbenchIds) {
              expect([...passingSetAt24(cells, designIds, testbenchId)].sort()).toEqual(
                expectedPassingSet,
              );
            }
            expect([...group.passingDesignIds].sort()).toEqual(expectedPassingSet);
          }
          for (let i = 0; i < testbenchIds.length; i += 1) {
            for (let j = i + 1; j < testbenchIds.length; j += 1) {
              const testbenchIdA = at24(testbenchIds, i);
              const testbenchIdB = at24(testbenchIds, j);
              const sameGroup =
                reportedGroupIndexOf.get(testbenchIdA) === reportedGroupIndexOf.get(testbenchIdB);
              const samePassingSet =
                JSON.stringify([...passingSetAt24(cells, designIds, testbenchIdA)].sort()) ===
                JSON.stringify([...passingSetAt24(cells, designIds, testbenchIdB)].sort());
              expect(sameGroup).toBe(samePassingSet);
            }
          }

          // (c) Every 2+ member clique's CHECK count reconciles against the matrix's own
          // retained traces, for every member, not just a representative one.
          for (const clique of partition.designCliques) {
            if (clique.designIds.length < 2) {
              continue;
            }
            multiMemberCliqueCases += 1;
            expect(clique.digestCollisionSuspected).toBe(false);
            for (const entry of clique.checkCountsByTestbench) {
              for (const designId of clique.designIds) {
                expect(nonNullTraceCountAt24(cells, designId, entry.testbenchId)).toBe(
                  entry.checkCount,
                );
              }
            }
            expect(clique.totalCheckCount).toBe(
              clique.checkCountsByTestbench.reduce((sum, entry) => sum + entry.checkCount, 0),
            );
          }

          // (d) No trust label, correctness verdict, or Clique_Precision value anywhere in the
          // report (Req 10.11) - checked at the value level, on top of the type's own absence of
          // such a field.
          expect(forbiddenKeysIn(partition)).toEqual([]);
        }),
        // 200 runs, above the design's 100-iteration floor; `@app/eval` may not import the
        // shared `app/test/property.ts` helper (see the import-boundary rule in eslint.config.js).
        { numRuns: 200 },
      );

      // NON-VACUITY: both forced shapes, and the 2+ member CHECK-reconciliation branch, actually
      // ran at least once rather than being vacuously skipped every iteration.
      expect(incompleteDesignCases).toBeGreaterThan(0);
      expect(multiMemberCliqueCases).toBeGreaterThan(0);
    },
  );
});
