// reference-model-consensus-gate, Property 5: Clusters partition on exact cross-testbench digest
// equality (task 2.6).
//
// THE ORACLE
//   The planted partition: every design carries a label, and its digest at one testbench is a
//   deterministic function of that label and the testbench id alone (`${label}::${testbenchId}`).
//   Two designs land in the same digest tuple if and only if they share a label, so the expected
//   clusters are exactly the label classes. `agreementClusters` is checked against that plant,
//   never against its own grouping restated.
//
// THE THREE SHAPES, FORCED TOGETHER IN EVERY RUN
//   Four designs are forced into fixed roles so every run exercises all three shapes at once,
//   not just across the run set: two share a label (a guaranteed cluster of size 2), one is
//   missing its signature under exactly one randomly chosen testbench, and one is missing it
//   under every testbench - the half a fully random draw would rarely reach. A variable 0-5
//   extra designs, each independently shaped, add further collisions and exclusions on top.
//
// Validates: Requirements 2.1, 2.6, 7.7

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  makeModuleInterface,
  makePort,
  type ModuleInterface,
  type Port,
  type PortDirection,
} from '@app/core';

import {
  agreementClusters,
  strictMajority,
  type AgreementCluster,
} from '../agent/consensus/agreement.js';
import { evaluateGrant, type SessionFacts } from '../agent/consensus/grant.js';
import { MIN_MODEL_FAMILIES } from '../agent/consensus/model-family.js';
import type { RunCell, RunMatrix } from '../agent/consensus/run-matrix.js';
import { reduceSignature, type WaveformSignature } from '../agent/consensus/signature.js';
import type { TestbenchTrust } from '../agent/consensus/trust-vote.js';

import { ASCII_IDENT_CHARS, stringFromChars } from './generators/chars.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'reference-model-consensus-gate, Property 5: Clusters partition on exact cross-testbench ' +
  'digest equality';

/** Three labels, used verbatim inside the digest so two designs collide iff they share one. */
const LABEL_POOL: readonly [string, string, string] = ['alpha', 'bravo', 'charlie'];

type Shape = 'full' | 'missing-one' | 'missing-all';

/**
 * One planted design: its shape, the label its digest tuple derives from (irrelevant for
 * `missing-one`/`missing-all`, which never join a cluster regardless of label), and which
 * testbench index a `missing-one` design has no signature under.
 */
interface DesignSpec {
  readonly id: string;
  readonly shape: Shape;
  readonly label: string;
  readonly missingTestbenchIndex: number;
}

function designIdArbitrary(): fc.Arbitrary<string> {
  return stringFromChars(ASCII_IDENT_CHARS, 1, 12);
}

function testbenchIdsArbitrary(): fc.Arbitrary<readonly string[]> {
  return fc
    .integer({ min: 2, max: 4 })
    .map((count) => Array.from({ length: count }, (_, index) => `testbench-${index}`));
}

/** The deterministic digest a `full` design produces at one testbench, from its label alone. */
function digestFor(label: string, testbenchId: string): string {
  return `${label}::${testbenchId}`;
}

function signatureFor(label: string, testbenchId: string): WaveformSignature {
  return { digest: digestFor(label, testbenchId), trace: [], sampleCount: 0 };
}

function extraSpecArbitrary(testbenchCount: number): fc.Arbitrary<Omit<DesignSpec, 'id'>> {
  return fc.record<Omit<DesignSpec, 'id'>>({
    shape: fc.constantFrom<Shape>('full', 'missing-one', 'missing-all'),
    label: fc.constantFrom(...LABEL_POOL),
    missingTestbenchIndex: fc.nat({ max: testbenchCount - 1 }),
  });
}

interface Scenario {
  readonly testbenchIds: readonly string[];
  readonly designSpecs: readonly DesignSpec[];
}

/** `ids[index]`, or throw: the generator's own `uniqueArray` length must cover every role. */
function idAt(ids: readonly string[], index: number): string {
  const id = ids[index];
  if (id === undefined) {
    throw new Error(`generator produced fewer design ids than roles need (missing index ${index})`);
  }
  return id;
}

/**
 * Four designs forced into fixed roles (two sharing a label, one missing exactly one testbench's
 * signature, one missing every testbench's signature) plus 0-5 independently shaped extras.
 */
function scenarioArbitrary(): fc.Arbitrary<Scenario> {
  const [sharedLabel, missingOneLabel, missingAllLabel] = LABEL_POOL;
  return testbenchIdsArbitrary().chain((testbenchIds) => {
    const testbenchCount = testbenchIds.length;
    return fc.integer({ min: 0, max: 5 }).chain((extraCount) => {
      const totalCount = 4 + extraCount;
      return fc
        .uniqueArray(designIdArbitrary(), { minLength: totalCount, maxLength: totalCount })
        .chain((ids) =>
          fc
            .record({
              forcedMissingOneIndex: fc.nat({ max: testbenchCount - 1 }),
              extraSpecs: fc.array(extraSpecArbitrary(testbenchCount), {
                minLength: extraCount,
                maxLength: extraCount,
              }),
            })
            .map(({ forcedMissingOneIndex, extraSpecs }) => {
              const forced: DesignSpec[] = [
                { id: idAt(ids, 0), shape: 'full', label: sharedLabel, missingTestbenchIndex: 0 },
                { id: idAt(ids, 1), shape: 'full', label: sharedLabel, missingTestbenchIndex: 0 },
                {
                  id: idAt(ids, 2),
                  shape: 'missing-one',
                  label: missingOneLabel,
                  missingTestbenchIndex: forcedMissingOneIndex,
                },
                {
                  id: idAt(ids, 3),
                  shape: 'missing-all',
                  label: missingAllLabel,
                  missingTestbenchIndex: 0,
                },
              ];
              const extras: DesignSpec[] = extraSpecs.map((spec, index) => ({
                id: idAt(ids, 4 + index),
                ...spec,
              }));
              return { testbenchIds, designSpecs: [...forced, ...extras] };
            }),
        );
    });
  });
}

/**
 * One `RunCell` per (design, testbench) pair, `signature: null` exactly where `spec.shape` says
 * the design's run was incomplete under that testbench.
 */
function cellsFor(designSpecs: readonly DesignSpec[], testbenchIds: readonly string[]): RunCell[] {
  const cells: RunCell[] = [];
  for (const spec of designSpecs) {
    testbenchIds.forEach((testbenchId, index) => {
      const missing =
        spec.shape === 'missing-all' ||
        (spec.shape === 'missing-one' && index === spec.missingTestbenchIndex);
      const signature = missing ? null : signatureFor(spec.label, testbenchId);
      cells.push({
        designId: spec.id,
        testbenchId,
        passed: signature !== null,
        signature,
        failureCause: signature === null ? 'timed-out' : 'none',
      });
    });
  }
  return cells;
}

function matrixFor(scenario: Scenario): RunMatrix {
  return {
    designIds: scenario.designSpecs.map((spec) => spec.id),
    testbenchIds: scenario.testbenchIds,
    cells: cellsFor(scenario.designSpecs, scenario.testbenchIds),
  };
}

describe(PROPERTY, () => {
  it(
    'partitions exactly the designs with a full digest tuple, by exact cross-testbench tuple ' +
      'equality, and excludes every design missing a signature under any one testbench',
    () => {
      let testbenchCountTwoCases = 0;
      let testbenchCountWiderCases = 0;

      fc.assert(
        fc.property(scenarioArbitrary(), (scenario) => {
          const { testbenchIds, designSpecs } = scenario;
          const matrix = matrixFor(scenario);
          const specById = new Map(designSpecs.map((spec) => [spec.id, spec]));
          const fullIds = designSpecs
            .filter((spec) => spec.shape === 'full')
            .map((spec) => spec.id);
          const missingIds = designSpecs
            .filter((spec) => spec.shape !== 'full')
            .map((spec) => spec.id);

          const clusters = agreementClusters(matrix);

          // No cluster is empty.
          for (const cluster of clusters) {
            expect(cluster.designIds.length).toBeGreaterThan(0);
          }

          // Pairwise disjoint.
          for (let i = 0; i < clusters.length; i += 1) {
            for (let j = i + 1; j < clusters.length; j += 1) {
              const earlier = new Set(clusters[i]?.designIds ?? []);
              const overlap = (clusters[j]?.designIds ?? []).filter((id) => earlier.has(id));
              expect(overlap).toEqual([]);
            }
          }

          // The union is exactly the designs with a full tuple; a missing-signature design is in
          // no cluster at all.
          const unionIds = clusters.flatMap((cluster) => cluster.designIds);
          expect([...unionIds].sort()).toEqual([...fullIds].sort());
          for (const id of missingIds) {
            expect(unionIds).not.toContain(id);
          }

          // Exact cross-testbench digest equality, both directions: two full designs share a
          // cluster if and only if they share a label (equivalently, their digest tuples match).
          const clusterIndexOf = new Map<string, number>();
          clusters.forEach((cluster, index) => {
            for (const id of cluster.designIds) {
              clusterIndexOf.set(id, index);
            }
          });
          for (let i = 0; i < fullIds.length; i += 1) {
            for (let j = i + 1; j < fullIds.length; j += 1) {
              const idA = fullIds[i] as string;
              const idB = fullIds[j] as string;
              const specA = specById.get(idA);
              const specB = specById.get(idB);
              if (specA === undefined || specB === undefined) {
                throw new Error('full-tuple design id missing from the generated spec map');
              }
              const sameCluster = clusterIndexOf.get(idA) === clusterIndexOf.get(idB);
              expect(sameCluster).toBe(specA.label === specB.label);
            }
          }

          // Each cluster's recorded digest tuple matches every member's planted digest exactly.
          for (const cluster of clusters) {
            const representativeId = cluster.designIds[0] as string;
            const representativeSpec = specById.get(representativeId);
            if (representativeSpec === undefined) {
              throw new Error('cluster referenced a design id absent from the generated specs');
            }
            const expectedDigests = testbenchIds.map((testbenchId) => ({
              testbenchId,
              digest: digestFor(representativeSpec.label, testbenchId),
            }));
            expect(cluster.digestsByTestbench).toEqual(expectedDigests);
            for (const id of cluster.designIds) {
              expect(specById.get(id)?.label).toBe(representativeSpec.label);
            }
          }

          if (testbenchIds.length === 2) {
            testbenchCountTwoCases += 1;
          } else {
            testbenchCountWiderCases += 1;
          }
        }),
        propertyParameters(),
      );

      // NON-VACUITY: the cross-testbench clause is checked at more than one testbench width.
      expect({
        testbenchCountTwoCases: testbenchCountTwoCases > 0,
        testbenchCountWiderCases: testbenchCountWiderCases > 0,
      }).toEqual({
        testbenchCountTwoCases: true,
        testbenchCountWiderCases: true,
      });
    },
  );
});

// reference-model-consensus-gate, Property 6: Strict_Majority is strict, and unknown values cannot
// manufacture one (task 2.7).
//
// Serial with task 2.6 on this file: appended as a second `describe` block below. Property 5's
// block above is untouched.
//
// CLAUSE 1: STRICTNESS
//   `strictMajority` is restated independently (the first cluster whose cardinality strictly
//   exceeds poolSize / 2, else null) over randomly sized cluster lists, plus the two decisive
//   points a random draw reaches too rarely: a single cluster of exactly N / 2, and two clusters
//   tied at exactly N / 2 each, both constructed at N = 2, 4, 6, 8, 10 rather than only at one width.
//
// CLAUSE 2: UNKNOWN VALUES CANNOT MANUFACTURE A MAJORITY
//   Random hex tokens almost never collide on the harness's own unknown token ('x'), so the
//   collision is planted: two traces differing at one Sample_Point by two distinct hex tokens are
//   shown NOT to merge, then both differing tokens are replaced with 'x' and shown TO merge - the
//   only way `reduceSignature`'s digest equality (plain string equality per position) can make two
//   otherwise-differing signatures equal. A second check shows the normalization can only merge,
//   never separate: an already-identical pair stays identical after the same per-position
//   replacement is applied to both. A third shows a merge needs the unknown at the SAME position on
//   both sides, not just one. Last, the Grant-level consequence: because 'x' is disjoint from the
//   legitimate hex alphabet, the harness's own `===` check on that Sample_Point can never pass, so
//   the RunCell fixture built from this merged pair carries `passed: false`, and feeding it through
//   the real `agreementClusters` -> `strictMajority` -> `evaluateGrant` pipeline shows the merged
//   cluster still cannot satisfy the Grant_Conditions: `evaluateGrant` reports
//   `majority-passes-trusted` unmet, naming exactly that cell.
//
// Validates: Requirements 2.2, 2.3, 2.4, 3.7

const PROPERTY_6 =
  'reference-model-consensus-gate, Property 6: Strict_Majority is strict, and unknown values ' +
  'cannot manufacture one';

/** Hex digits only, matching the harness's own `%0h` nibble rendering (this property's premise). */
const HEX_CHARS: readonly string[] = '0123456789abcdef'.split('');

/**
 * The harness's own unknown-nibble token, disjoint from `HEX_CHARS` by construction: no legitimate
 * sample value can ever read as this literal, which is what grounds "any unknown at a Sample_Point
 * already fails its check" below.
 */
const UNKNOWN_TOKEN = 'x';

function hexTokenArbitrary(): fc.Arbitrary<string> {
  return fc.constantFrom(...HEX_CHARS);
}

/** Two hex tokens guaranteed distinct, so a pair drawn from this never merges on its own. */
function distinctHexTokenPairArbitrary(): fc.Arbitrary<readonly [string, string]> {
  return fc.tuple(hexTokenArbitrary(), hexTokenArbitrary()).filter(([a, b]) => a !== b);
}

/** A non-empty run of shared hex tokens, so there is always at least one position both designs
 * genuinely agree on before any differing or mutated position is appended. */
function sharedPrefixArbitrary(): fc.Arbitrary<readonly string[]> {
  return fc.array(hexTokenArbitrary(), { minLength: 1, maxLength: 4 });
}

/** Build a `Port` through the validating constructor, or fail the generator loudly. */
function singleOutputPortOrThrow(name: string, direction: PortDirection): Port {
  const built = makePort({ name, direction, width: 1 });
  if (!built.ok) {
    throw new Error(`generator produced an invalid port: ${built.error.code}`);
  }
  return built.value;
}

/** A `ModuleInterface` with exactly one output port and no Validity_Output, which keeps every
 * sample line in this clause down to a single value column. */
function singleOutputInterface(moduleName: string, outputName: string): ModuleInterface {
  const built = makeModuleInterface({
    moduleName,
    ports: [singleOutputPortOrThrow(outputName, 'output')],
    clocking: { clockName: null, resetName: null, resetActiveLow: false },
    validityOutputName: null,
  });
  if (!built.ok) {
    throw new Error(`generator produced an invalid module interface: ${built.error.code}`);
  }
  return built.value;
}

/** Render `tokens` as the harness's own `ECE_SAMPLE` / `ECE_SAMPLE_END` stream, one value column. */
function renderSingleOutputStdout(nonce: string, tokens: readonly string[]): string {
  const sampleLines = tokens.map((token, index) =>
    ['ECE_SAMPLE', nonce, String(index), token].join(' '),
  );
  const endLine = ['ECE_SAMPLE_END', nonce, String(tokens.length)].join(' ');
  return [...sampleLines, endLine].join('\n');
}

/** A throwaway `AgreementCluster` of `size` designs; `strictMajority` reads only cardinality, so
 * `digestsByTestbench` is left empty here. */
function clusterOfSize(label: string, size: number): AgreementCluster {
  return {
    designIds: Array.from({ length: size }, (_, index) => `${label}-${index}`),
    digestsByTestbench: [],
  };
}

describe(PROPERTY_6, () => {
  it(
    'returns the cluster whose cardinality strictly exceeds N / 2, by independent restatement ' +
      'over drawn cluster-size lists',
    () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 20 }).chain((poolSize) =>
            fc.record({
              poolSize: fc.constant(poolSize),
              sizes: fc.array(fc.integer({ min: 1, max: poolSize }), {
                minLength: 0,
                maxLength: 5,
              }),
            }),
          ),
          ({ poolSize, sizes }) => {
            const clusters = sizes.map((size, index) => clusterOfSize(`cluster-${index}`, size));
            const expected =
              clusters.find((cluster) => cluster.designIds.length > poolSize / 2) ?? null;
            expect(strictMajority(clusters, poolSize)).toEqual(expected);
          },
        ),
        propertyParameters(),
      );
    },
  );

  it(
    'yields none at a cardinality of exactly N / 2, and none when the two largest clusters tie ' +
      'at exactly N / 2 each, constructed at N = 2, 4, 6, 8, and 10',
    () => {
      for (const n of [2, 4, 6, 8, 10]) {
        // The exact-half case: the whole content of the strictness claim.
        const exactHalf = [clusterOfSize('half', n / 2)];
        expect(strictMajority(exactHalf, n)).toBeNull();

        // Two clusters tied at exactly N / 2 each: Req 2.4's equal-cardinality case, which is the
        // same boundary seen from the "two largest tie" side rather than the "one cluster" side.
        const tied = [clusterOfSize('tie-a', n / 2), clusterOfSize('tie-b', n / 2)];
        expect(strictMajority(tied, n)).toBeNull();
      }
    },
  );

  it(
    'merges two signatures into one digest only through a shared unknown token at one ' +
      'Sample_Point, never separates a pair that already agrees, and needs the unknown on both ' +
      'sides rather than one',
    () => {
      let casesRun = 0;

      // The unknown token can never be mistaken for a legitimate sample value: this is what
      // grounds "any unknown at a Sample_Point already fails its check because the harness
      // compares with ===" below, since no `===` comparison against it can ever read as a match.
      expect(HEX_CHARS).not.toContain(UNKNOWN_TOKEN);

      fc.assert(
        fc.property(
          stringFromChars(ASCII_IDENT_CHARS, 1, 8),
          stringFromChars(ASCII_IDENT_CHARS, 1, 8),
          stringFromChars(ASCII_IDENT_CHARS, 1, 8),
          stringFromChars(ASCII_IDENT_CHARS, 1, 8),
          sharedPrefixArbitrary(),
          distinctHexTokenPairArbitrary(),
          (moduleName, outputName, nonceA, nonceB, prefix, [tokenA, tokenB]) => {
            const moduleInterface = singleOutputInterface(moduleName, outputName);

            const sigOf = (nonce: string, tokens: readonly string[]): WaveformSignature => {
              const signature = reduceSignature(
                renderSingleOutputStdout(nonce, tokens),
                nonce,
                moduleInterface,
              );
              if (signature === null) {
                throw new Error('generator produced an incomplete stream');
              }
              return signature;
            };

            // Distinct hex tokens at the one differing Sample_Point never merge on their own.
            const originalA = sigOf(nonceA, [...prefix, tokenA]);
            const originalB = sigOf(nonceB, [...prefix, tokenB]);
            expect(originalA.digest).not.toBe(originalB.digest);

            // Plant the collision: random values almost never collide on the unknown token, so
            // both differing positions are forced to it, which is the only way they merge.
            const mergedA = sigOf(nonceA, [...prefix, UNKNOWN_TOKEN]);
            const mergedB = sigOf(nonceB, [...prefix, UNKNOWN_TOKEN]);
            expect(mergedA.digest).toBe(mergedB.digest);

            // Never separates a pair that already agrees: an identical trace replicated for both
            // designs stays identical after the SAME position is replaced with the unknown token
            // on both sides, because the replacement is a function of one value, never of the
            // other trace it is being compared against.
            const agreeingA = sigOf(nonceA, prefix);
            const agreeingB = sigOf(nonceB, prefix);
            expect(agreeingA.digest).toBe(agreeingB.digest);
            const mutatedPrefix = [UNKNOWN_TOKEN, ...prefix.slice(1)];
            const stillAgreeingA = sigOf(nonceA, mutatedPrefix);
            const stillAgreeingB = sigOf(nonceB, mutatedPrefix);
            expect(stillAgreeingA.digest).toBe(stillAgreeingB.digest);

            // A merge needs the unknown at the SAME Sample_Point on both sides: replacing only
            // one side's differing token leaves it unequal to the other side's untouched token,
            // since the unknown token can never equal a real hex digit.
            expect(mergedA.digest).not.toBe(originalB.digest);

            casesRun += 1;
          },
        ),
        propertyParameters(),
      );

      // NON-VACUITY: the property loop actually ran rather than being skipped.
      expect(casesRun).toBeGreaterThan(0);
    },
  );

  it(
    'cannot let an unknown-induced merge satisfy the Grant_Conditions: evaluateGrant still ' +
      'reports majority-passes-trusted unmet, naming the non-passing cell the unknown token forced',
    () => {
      const moduleInterface = singleOutputInterface('consensus_dut', 'result');
      const sharedToken = '4';
      const nonceA = 'nonce-design-a';
      const nonceB = 'nonce-design-b';

      // Both designs' streams agree everywhere except the one Sample_Point they share only
      // through the unknown token (the harness's own %0h fold of a partially unknown nibble).
      const signatureA = reduceSignature(
        renderSingleOutputStdout(nonceA, [sharedToken, UNKNOWN_TOKEN]),
        nonceA,
        moduleInterface,
      );
      const signatureB = reduceSignature(
        renderSingleOutputStdout(nonceB, [sharedToken, UNKNOWN_TOKEN]),
        nonceB,
        moduleInterface,
      );
      if (signatureA === null || signatureB === null) {
        throw new Error('fixture stream must reduce to a complete signature');
      }
      expect(signatureA.digest).toBe(signatureB.digest);

      const designAId = 'design-a';
      const designBId = 'design-b';
      const testbenchId = 'testbench-0';
      const matrix: RunMatrix = {
        designIds: [designAId, designBId],
        testbenchIds: [testbenchId],
        cells: [
          // `passed: false` on both: the unknown token at this Sample_Point can never equal the
          // harness's expected value under `===` (UNKNOWN_TOKEN is disjoint from HEX_CHARS,
          // checked above), so the harness's own CHECK line reports FAIL regardless of what
          // digest-level clustering decides. `failureCause: 'none'` because this is a functional
          // check failure, not an infra one.
          {
            designId: designAId,
            testbenchId,
            passed: false,
            signature: signatureA,
            failureCause: 'none',
          },
          {
            designId: designBId,
            testbenchId,
            passed: false,
            signature: signatureB,
            failureCause: 'none',
          },
        ],
      };

      // The merge happens at the real clustering layer: both designs land in one cluster.
      const clusters = agreementClusters(matrix);
      expect(clusters).toHaveLength(1);
      expect(clusters[0]?.designIds).toEqual([designAId, designBId]);

      const poolSize = 2;
      // The merged cluster clears the Strict_Majority bar by cardinality alone.
      expect(strictMajority(clusters, poolSize)).not.toBeNull();

      const testbenchTrust: readonly TestbenchTrust[] = [
        {
          testbenchId,
          passingDesignCount: 0,
          votedTrusted: true,
          mutationOutcome: { kind: 'passed' },
          trusted: true,
        },
      ];

      const facts: SessionFacts = {
        poolSize,
        designPoolDistinctFamilyCount: MIN_MODEL_FAMILIES,
        clusters,
        testbenchTrust,
        runMatrix: matrix,
      };

      // No cluster containing an unknown-induced merge can satisfy the Grant_Conditions: the
      // majority-passes-trusted condition catches the non-passing cell the unknown token forced.
      expect(evaluateGrant(facts)).toEqual({
        kind: 'unmet',
        condition: 'majority-passes-trusted',
        evidence: { kind: 'majority-passes-trusted', designId: designAId, testbenchId },
      });
    },
  );
});
