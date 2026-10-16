// reference-model-consensus-gate, Property 2: Each Grant_Condition is necessary and the five
// together are sufficient (task 2.14).
//
// WHAT IS UNDER TEST
//   `evaluateGrant` in `app/agent/consensus/grant.ts`, the sole function that reads a Session's
//   five Grant_Conditions in their fixed order and reports either the granted Strict_Majority
//   cluster or the first unmet condition. Necessity and sufficiency are both load-bearing here: a
//   grant that does not actually require all five would admit on partial evidence, and a condition
//   that does not actually block a grant when violated is dead text.
//
// THE ORACLE: A PLANTED VIOLATION, KNOWN BY CONSTRUCTION
//   `arbSatisfyingGrantFixture` builds a `SessionFacts` that satisfies all five conditions at once -
//   a Design_Pool of at least 8 across at least 3 Model_Families, a Strict_Majority cluster of at
//   least 5 of them agreeing, at least one Trusted_Testbench, every cluster member passing every
//   Trusted_Testbench, and no vote-winning testbench failing its Mutation_Strength_Gate. The test
//   never calls `evaluateGrant` on the base fixture to decide what "satisfying" means; it is true by
//   the way the fixture is built. `applyViolations` then starts from that SAME base and overrides
//   only the field(s) one named condition reads, which is what makes "violates exactly one and
//   nothing else" a fact about the input rather than a hope about the implementation.
//
// WHY THE FIVE OVERRIDES ARE COMPUTED FROM THE BASE, NEVER CHAINED
//   `applyViolations` takes a SET of conditions and, for each one, overrides its field directly from
//   `fixture.facts` - it never applies one violation's result as the input to the next. A sequential
//   chain would let one violation's edit (e.g. marking every testbench untrusted) interact with
//   another's anchor (e.g. "the first Trusted_Testbench's id") in a way that depends on application
//   order. Computed independently and merged, the two-condition case below is order-independent by
//   construction, which is what makes "the earlier one is reported" a property of
//   `evaluateGrant`'s fixed order and not an artifact of how the test happened to build its input.
//
// FALSIFICATION: EACH OF THE FIVE CLAUSES WAS WEAKENED IN `grant.ts` AND REVERTED, AND THIS
// PROPERTY WAS CONFIRMED TO FAIL AGAINST EACH WEAKENING
//   Per the house discipline that a necessity property which has never failed has not been shown to
//   check necessity, each clause below was temporarily disabled directly in `grant.ts` (never in a
//   scratch copy, so the real evaluation order was exercised) and restored from the exact original
//   text captured before any edit, with the restoration verified by `git diff --stat` reporting no
//   change before moving to the next clause:
//     - `model-family-diversity`: the guard's condition replaced with `false` -> this test's first
//       loop iteration failed on the unmet-condition assertion, reverted.
//     - `strict-majority`: `strictMajority(...)` call's result forced to the input cluster instead
//       of its real return -> failed on the same assertion for this condition, reverted.
//     - `trusted-testbench-exists`: the `trustedTestbenches.length === 0` guard replaced with
//       `false` -> failed, reverted.
//     - `majority-passes-trusted`: `firstFailingMajorityPair`'s result forced to `null` -> failed,
//       reverted.
//     - `mutation-strength`: `firstVotedTrustedWithoutMutationPass`'s result forced to `null` ->
//       failed, reverted.
//   `git diff --stat app/agent/consensus/grant.ts` reported no changes after the last revert.
//
// Validates: Requirements 1.2, 1.3, 1.4, 3.3, 8.4

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { AgreementCluster } from '../agent/consensus/agreement.js';
import {
  applyFormalOverride,
  evaluateGrant,
  type GrantConditionId,
  type GrantEvidence,
  type SessionFacts,
} from '../agent/consensus/grant.js';
import { MIN_MODEL_FAMILIES } from '../agent/consensus/model-family.js';
import type { RunCell, RunMatrix } from '../agent/consensus/run-matrix.js';
import type { TestbenchTrust } from '../agent/consensus/trust-vote.js';

import type { Ulid } from '@app/core';
import { propertyParameters } from './property.js';

const PROPERTY =
  'reference-model-consensus-gate, Property 2: Each Grant_Condition is necessary and the five ' +
  'together are sufficient';

/** The five Grant_Conditions in `evaluateGrant`'s own fixed evaluation order (grant.ts). */
const CONDITION_ORDER: readonly GrantConditionId[] = [
  'model-family-diversity',
  'strict-majority',
  'trusted-testbench-exists',
  'majority-passes-trusted',
  'mutation-strength',
];

/** A testbench this fixture never admits to the Trust_Vote, reused only by the `mutation-strength`
 * violation below, so its id never collides with a generated `testbenchId(index)`. */
const UNSTRENGTHENED_TESTBENCH_ID: Ulid = 'testbench-unstrengthened-extra';

function designId(index: number): Ulid {
  return `design-${index}`;
}

function testbenchId(index: number): Ulid {
  return `testbench-${index}`;
}

/**
 * A fully satisfying `SessionFacts`, plus the anchors both this task's violations and task 2.15's
 * formal-override property need: the granted cluster itself, its first member, and a testbench the
 * fixture already marked trusted.
 *
 * Exported so task 2.15 (serial with this one on this same file) reuses this fixture rather than
 * building a second one.
 */
export interface SatisfyingGrantFixture {
  readonly facts: SessionFacts;
  readonly majorityCluster: AgreementCluster;
  readonly anchorClusterDesignId: Ulid;
  readonly anchorTrustedTestbenchId: Ulid;
}

interface FixtureShape {
  readonly poolSize: number;
  readonly testbenchCount: number;
  readonly distinctFamilyCount: number;
  readonly clusterSize: number;
  readonly trustedTestbenchCount: number;
}

/** Build a `SatisfyingGrantFixture` from five already-valid shape numbers. Pure and deterministic,
 * so the same shape always yields the same facts; the variation is in what `arbSatisfyingGrantFixture`
 * draws for `FixtureShape`, not in this function. */
function buildSatisfyingFixture(shape: FixtureShape): SatisfyingGrantFixture {
  const { poolSize, testbenchCount, distinctFamilyCount, clusterSize, trustedTestbenchCount } =
    shape;

  const designIds = Array.from({ length: poolSize }, (_, index) => designId(index));
  const testbenchIds = Array.from({ length: testbenchCount }, (_, index) => testbenchId(index));
  const clusterDesignIds = designIds.slice(0, clusterSize);

  const majorityCluster: AgreementCluster = {
    designIds: clusterDesignIds,
    digestsByTestbench: testbenchIds.map((id) => ({ testbenchId: id, digest: 'agree' })),
  };

  const testbenchTrust: TestbenchTrust[] = testbenchIds.map((id, index) => {
    const trusted = index < trustedTestbenchCount;
    return {
      testbenchId: id,
      passingDesignCount: trusted ? poolSize : 0,
      votedTrusted: trusted,
      mutationOutcome: { kind: trusted ? 'passed' : 'not-run' },
      trusted,
    };
  });

  // Every cell passes. The cluster members' passing cells are what satisfies
  // `majority-passes-trusted`; the non-cluster members' outcomes are never read by `evaluateGrant`
  // (Req 8.4's majority check only scans the granted cluster), so they are set the same way for a
  // single, easy-to-read matrix rather than left to vary pointlessly.
  const cells: RunCell[] = designIds.flatMap((design) =>
    testbenchIds.map((testbench) => ({
      designId: design,
      testbenchId: testbench,
      passed: true,
      signature: null,
      failureCause: 'none' as const,
    })),
  );

  const runMatrix: RunMatrix = { designIds, testbenchIds, cells };

  const facts: SessionFacts = {
    poolSize,
    designPoolDistinctFamilyCount: distinctFamilyCount,
    clusters: [majorityCluster],
    testbenchTrust,
    runMatrix,
  };

  const anchorClusterDesignId = clusterDesignIds[0];
  const anchorTrustedTestbenchId = testbenchIds[0];
  if (anchorClusterDesignId === undefined || anchorTrustedTestbenchId === undefined) {
    // Unreachable given the arbitrary's bounds (poolSize and testbenchCount are always >= 8), but
    // stated rather than asserted away so a future bound change fails loudly here instead of
    // silently handing `undefined` to a Ulid-typed field.
    throw new Error('fixture builder requires at least one cluster design and one testbench');
  }

  return { facts, majorityCluster, anchorClusterDesignId, anchorTrustedTestbenchId };
}

/**
 * A `SessionFacts` that satisfies all five Grant_Conditions at once, varied across runs rather than
 * fixed to one example (the task's own stated reason: "a single fixture would make the sufficiency
 * half one example").
 *
 * The bounds are the fixed point of the task's own numbers - a pool of 8 across 3 families, a
 * cluster of 5, 8 testbenches, 1 trusted - with every bound free to grow larger, so the floor case
 * and larger shapes are both drawn.
 */
export function arbSatisfyingGrantFixture(): fc.Arbitrary<SatisfyingGrantFixture> {
  return fc
    .record({
      poolSize: fc.integer({ min: 8, max: 12 }),
      testbenchCount: fc.integer({ min: 8, max: 12 }),
      distinctFamilyCount: fc.integer({ min: MIN_MODEL_FAMILIES, max: MIN_MODEL_FAMILIES + 3 }),
    })
    .chain(({ poolSize, testbenchCount, distinctFamilyCount }) =>
      fc.record({
        poolSize: fc.constant(poolSize),
        testbenchCount: fc.constant(testbenchCount),
        distinctFamilyCount: fc.constant(distinctFamilyCount),
        // Strictly more than half of poolSize, so the base cluster is always the Strict_Majority.
        clusterSize: fc.integer({ min: Math.floor(poolSize / 2) + 1, max: poolSize }),
        trustedTestbenchCount: fc.integer({ min: 1, max: testbenchCount }),
      }),
    )
    .map(buildSatisfyingFixture);
}

/** Shrink the majority cluster to exactly half the pool (never more), the single point at which
 * `strictMajority`'s own strict inequality switches from granting to refusing. */
function shrunkToNonMajority(cluster: AgreementCluster, poolSize: number): AgreementCluster {
  const nonMajoritySize = Math.floor(poolSize / 2);
  return { ...cluster, designIds: cluster.designIds.slice(0, nonMajoritySize) };
}

/** A testbench that won the Trust_Vote but failed its Mutation_Strength_Gate, and is itself
 * untrusted - so adding it violates `mutation-strength` alone, never `trusted-testbench-exists`. */
function unstrengthenedTestbench(): TestbenchTrust {
  return {
    testbenchId: UNSTRENGTHENED_TESTBENCH_ID,
    passingDesignCount: 0,
    votedTrusted: true,
    mutationOutcome: { kind: 'failed' },
    trusted: false,
  };
}

/** `matrix` with the single (designId, testbenchId) cell's `passed` flipped to `false`. */
function flipCell(matrix: RunMatrix, designId: Ulid, testbenchId: Ulid): RunMatrix {
  return {
    ...matrix,
    cells: matrix.cells.map((cell) =>
      cell.designId === designId && cell.testbenchId === testbenchId
        ? { ...cell, passed: false }
        : cell,
    ),
  };
}

/**
 * `fixture`'s satisfying facts, with every condition named in `violated` overridden from the base
 * and every other field left untouched.
 *
 * Each override reads `fixture.facts` directly rather than a previous override's result, so calling
 * this with a two-element set produces the same facts regardless of the set's iteration order - see
 * the header note on why that independence is what makes the reporting-order assertion meaningful.
 */
function applyViolations(
  fixture: SatisfyingGrantFixture,
  violated: ReadonlySet<GrantConditionId>,
): SessionFacts {
  const base = fixture.facts;

  const designPoolDistinctFamilyCount = violated.has('model-family-diversity')
    ? MIN_MODEL_FAMILIES - 1
    : base.designPoolDistinctFamilyCount;

  const clusters = violated.has('strict-majority')
    ? [shrunkToNonMajority(fixture.majorityCluster, base.poolSize)]
    : base.clusters;

  let testbenchTrust = base.testbenchTrust;
  if (violated.has('trusted-testbench-exists')) {
    testbenchTrust = testbenchTrust.map((testbench) => ({ ...testbench, trusted: false }));
  }
  if (violated.has('mutation-strength')) {
    testbenchTrust = [...testbenchTrust, unstrengthenedTestbench()];
  }

  const runMatrix = violated.has('majority-passes-trusted')
    ? flipCell(base.runMatrix, fixture.anchorClusterDesignId, fixture.anchorTrustedTestbenchId)
    : base.runMatrix;

  return {
    poolSize: base.poolSize,
    designPoolDistinctFamilyCount,
    clusters,
    testbenchTrust,
    runMatrix,
  };
}

/** The exact `GrantEvidence` `evaluateGrant` reports when `condition` is the only one violated by
 * `applyViolations`, restated independently from the implementation's evidence-construction code. */
function expectedEvidenceFor(
  condition: GrantConditionId,
  fixture: SatisfyingGrantFixture,
): GrantEvidence {
  switch (condition) {
    case 'model-family-diversity':
      return { kind: condition, distinctFamilyCount: MIN_MODEL_FAMILIES - 1 };
    case 'strict-majority':
      return { kind: condition, poolSize: fixture.facts.poolSize };
    case 'trusted-testbench-exists':
      return { kind: condition, testbenchPoolSize: fixture.facts.testbenchTrust.length };
    case 'majority-passes-trusted':
      return {
        kind: condition,
        designId: fixture.anchorClusterDesignId,
        testbenchId: fixture.anchorTrustedTestbenchId,
      };
    case 'mutation-strength':
      return { kind: condition, testbenchId: UNSTRENGTHENED_TESTBENCH_ID };
  }
}

/** Every unordered pair of distinct conditions, in `(earlier, later)` fixed-order form - 10 pairs
 * over 5 conditions, enumerated exhaustively rather than sampled, since the decisive case ("the
 * earlier one wins") is a single point per pair and a random pair draw would reach all 10 only
 * eventually rather than reliably. */
const CONDITION_PAIRS: readonly (readonly [GrantConditionId, GrantConditionId])[] =
  CONDITION_ORDER.flatMap((earlier, index) =>
    CONDITION_ORDER.slice(index + 1).map((later): readonly [GrantConditionId, GrantConditionId] => [
      earlier,
      later,
    ]),
  );

describe(PROPERTY, () => {
  it('grants on the unviolated facts, and names exactly the one condition violated by itself', () => {
    let grantedCases = 0;
    let unmetCases = 0;
    fc.assert(
      fc.property(arbSatisfyingGrantFixture(), (fixture) => {
        // Sufficiency: nothing violated, so the five conditions all hold and the Session grants
        // exactly the majority cluster this fixture built.
        const granted = evaluateGrant(applyViolations(fixture, new Set()));
        expect(granted).toEqual({ kind: 'granted', cluster: fixture.majorityCluster });
        grantedCases += 1;

        // Necessity: violating exactly one condition and nothing else reports that condition, with
        // the exact evidence `evaluateGrant` would compute for it.
        for (const condition of CONDITION_ORDER) {
          const evaluation = evaluateGrant(applyViolations(fixture, new Set([condition])));
          expect(evaluation).toEqual({
            kind: 'unmet',
            condition,
            evidence: expectedEvidenceFor(condition, fixture),
          });
          unmetCases += 1;
        }
      }),
      propertyParameters(),
    );
    expect(grantedCases).toBeGreaterThan(0);
    // 5 unmet cases per fixture draw, so this is 5x the fixture count; it is tracked to confirm the
    // inner loop actually ran rather than being skipped by an empty `CONDITION_ORDER`.
    expect(unmetCases).toBeGreaterThan(0);
  });

  it('reports the earlier of two violated conditions, for every pair in the fixed order', () => {
    expect(CONDITION_PAIRS).toHaveLength(10);
    const pairsSeen = new Set<string>();
    fc.assert(
      fc.property(
        arbSatisfyingGrantFixture(),
        fc.constantFrom(...CONDITION_PAIRS),
        (fixture, [earlier, later]) => {
          pairsSeen.add(`${earlier}+${later}`);
          const evaluation = evaluateGrant(applyViolations(fixture, new Set([earlier, later])));
          expect(evaluation.kind).toBe('unmet');
          if (evaluation.kind === 'unmet') {
            expect(evaluation.condition).toBe(earlier);
          }
        },
      ),
      propertyParameters(),
    );
    // Non-vacuity: every one of the 10 pairs must actually have been drawn, not just a lucky subset.
    expect(pairsSeen.size).toBe(10);
  });
});

// reference-model-consensus-gate, Property 3: A formal refutation overrides a grant (task 2.15).
//
// WHAT IS UNDER TEST
//   `applyFormalOverride` in `app/agent/consensus/grant.ts`, the one-way override applied to an
//   already-granted `GrantEvaluation` after the formal gate runs. It reads `evaluation` and
//   `refutedDesignIds` only, which is the fact this property turns into three checks: a refutation
//   of a granted cluster member always wins, a refutation of a design elsewhere in the pool never
//   does, and there is nowhere in the signature for a formal proof to enter at all.
//
// REUSED FIXTURE
//   `arbSatisfyingGrantFixture` (task 2.14, this same file) already builds a Session that grants,
//   plus the cluster and anchors needed here. This task adds no second generator; the `designId`
//   outside the cluster for the second clause comes from `fixture.facts.runMatrix.designIds`, which
//   lists the whole Design_Pool, filtered against `fixture.majorityCluster.designIds`.
//
// THE THIRD CLAUSE IS AN ABSENCE, ASSERTED AS ONE
//   `applyFormalOverride` takes exactly two parameters; there is no third argument through which a
//   caller could pass "this design is proved". So "a grant with every design proved is byte-identical
//   to the same grant with none proved" is checked by confirming the arity directly, then confirming
//   the only call shape that exists, an empty or non-member `refutedDesignIds`, leaves the grant
//   unchanged. There is no fabricated proof parameter anywhere in this file.
//
// Validates: Requirements 1.7

const PROPERTY_3 =
  'reference-model-consensus-gate, Property 3: A formal refutation overrides a grant';

describe(PROPERTY_3, () => {
  it('converts a grant to Unverified, naming the refutation as the cause, when the refuted design is any member of the granted cluster', () => {
    fc.assert(
      fc.property(arbSatisfyingGrantFixture(), fc.nat(), (fixture, rawIndex) => {
        const evaluation = evaluateGrant(fixture.facts);
        const members = fixture.majorityCluster.designIds;
        const member = members[rawIndex % members.length];
        if (member === undefined) {
          // Unreachable: `arbSatisfyingGrantFixture` always draws a cluster of at least 5 designs.
          throw new Error('expected the granted cluster to have at least one member');
        }
        expect(applyFormalOverride(evaluation, [member])).toEqual({
          kind: 'unmet',
          condition: 'formal-refutation',
          refutedDesignId: member,
        });
      }),
      propertyParameters(),
    );
  });

  it('leaves a grant unchanged when the refuted design is outside the granted cluster', () => {
    let nonVacuousCases = 0;
    fc.assert(
      fc.property(arbSatisfyingGrantFixture(), (fixture) => {
        const evaluation = evaluateGrant(fixture.facts);
        const clusterMembers = new Set(fixture.majorityCluster.designIds);
        const outsiderDesignIds = fixture.facts.runMatrix.designIds.filter(
          (candidateId) => !clusterMembers.has(candidateId),
        );
        const outsider = outsiderDesignIds[0];
        if (outsider === undefined) {
          // This draw's cluster happens to span the whole pool, so there is no outsider to refute
          // this time; the non-vacuity check below confirms other draws do supply one.
          return;
        }
        nonVacuousCases += 1;
        expect(applyFormalOverride(evaluation, [outsider])).toEqual(evaluation);
      }),
      propertyParameters(),
    );
    // Non-vacuity: `clusterSize` can equal `poolSize`, so at least one draw having an outsider must
    // be confirmed rather than assumed.
    expect(nonVacuousCases).toBeGreaterThan(0);
  });

  it('has no parameter for a formal proof, so a grant with every design proved is byte-identical to the same grant with none proved', () => {
    // The structural absence: two parameters only, `evaluation` and `refutedDesignIds`. There is no
    // third slot through which "this design is proved" could ever be passed.
    expect(applyFormalOverride.length).toBe(2);

    fc.assert(
      fc.property(arbSatisfyingGrantFixture(), (fixture) => {
        const evaluation = evaluateGrant(fixture.facts);
        // "None proved" is the only call this signature can express, an empty refutedDesignIds list.
        // There is no "every design proved" call to compare it against, which is the point itself.
        expect(applyFormalOverride(evaluation, [])).toEqual(evaluation);
      }),
      propertyParameters(),
    );
  });
});
