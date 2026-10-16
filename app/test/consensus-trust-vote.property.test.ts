// reference-model-consensus-gate, Property 17: The Trust_Vote and the Run_Matrix are exhaustive
// and strict (task 2.9).
//
// Serial with task 2.10 on this file: task 2.10 appends Property 19 below as its own `describe`
// block once it lands, so nothing here should be restructured in a way that would block that
// append.
//
// THE ORACLE
//   Two rules, each restated independently of `trust-vote.ts` rather than read back off it:
//     1. Exhaustive: a `RunMatrix` built from an N x N pass table carries exactly the Cartesian
//        product of its design and testbench ids as cells, N squared of them, with no duplicate
//        and no omission (Req 8.5, 8.6, 15.4).
//     2. Strict: a testbench's `votedTrusted` is true if and only if its passing design count is
//        strictly greater than N / 2, and `trusted` is that vote conjoined with the supplied
//        Mutation_Strength_Gate outcome being `passed` (Req 8.1, 8.2).
//   Every scenario below builds its own pass table and its own mutation-outcome map, computes
//   both rules independently in the test, and checks `trustVote`'s output against that
//   independent computation - never against a second call to `trustVote` itself.
//
// WHY THE DISAGREEING CASES ARE CONSTRUCTED, NOT SAMPLED
//   The conjunction in rule 2 only has something to prove where its two conjuncts disagree. A
//   mutation outcome drawn independently of the vote would make `kind: 'passed'` land on a
//   voted-trusted testbench, and `kind: 'not-run'` at all, only rarely - so three scenario kinds
//   each force one testbench's vote and gate outcome into a specific disagreement: vote-true
//   gate-failed, vote-false gate-passed, and vote-true gate-missing (which `trustVote` must read
//   as `not-run`). A fourth scenario kind forces a passing count of exactly N / 2 at an even N,
//   the one point the strictness claim is actually about, drawn across several widths (2, 4, 6,
//   8, 10) rather than only at one.
//
// Validates: Requirements 8.1, 8.2, 8.5, 8.6, 12.1, 12.3, 15.4

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { FailingPairPeers } from '../agent/consensus/fault-attributor.js';
import { PEER_FLOOR, attributeFault } from '../agent/consensus/fault-attributor.js';
import type { RunCell, RunMatrix } from '../agent/consensus/run-matrix.js';
import {
  attributionStatus,
  poolCorrectness,
  trustVote,
  type MutationGateVote,
  type TestbenchTrust,
} from '../agent/consensus/trust-vote.js';

import { propertyParameters } from './property.js';

const PROPERTY =
  'reference-model-consensus-gate, Property 17: The Trust_Vote and the Run_Matrix are exhaustive and strict';

/** A design id, numbered so a fixed pass-table row index maps to a fixed id. */
function designIdOf(index: number): string {
  return `design-${index}`;
}

/** A testbench id, numbered so a fixed pass-table column index maps to a fixed id. */
function testbenchIdOf(index: number): string {
  return `testbench-${index}`;
}

/**
 * The five decisive scenario kinds. `general` exercises the exhaustive-Cartesian and
 * strict-majority rules alone, with every mutation outcome fixed to `passed` so the vote is the
 * only thing deciding `trusted`. The other four each force testbench column 0 into one disagreeing
 * or boundary shape the general case reaches too rarely to rely on.
 */
type ScenarioKind =
  'general' | 'vote-pass-gate-fail' | 'vote-fail-gate-pass' | 'gate-not-run' | 'exact-half';

interface Scenario {
  readonly kind: ScenarioKind;
  readonly n: number;
  readonly passTable: readonly (readonly boolean[])[];
}

/** An N x N table of independent pass/fail draws, one row per design and one column per testbench. */
function passTableArbitrary(n: number): fc.Arbitrary<readonly (readonly boolean[])[]> {
  return fc.array(fc.array(fc.boolean(), { minLength: n, maxLength: n }), {
    minLength: n,
    maxLength: n,
  });
}

/** Replace column 0 of `passTable` with `columnValues`, one entry per design row. */
function overrideColumnZero(
  passTable: readonly (readonly boolean[])[],
  columnValues: readonly boolean[],
): readonly (readonly boolean[])[] {
  return passTable.map((row, design) =>
    row.map((value, testbench) => (testbench === 0 ? (columnValues[design] ?? false) : value)),
  );
}

/** A column of `n` designs with exactly `n / 2` passing, the boundary the strictness claim is about. */
function exactHalfColumn(n: number): readonly boolean[] {
  const half = n / 2;
  return Array.from({ length: n }, (_, design) => design < half);
}

function scenarioArbitrary(): fc.Arbitrary<Scenario> {
  return fc
    .constantFrom<ScenarioKind>(
      'general',
      'vote-pass-gate-fail',
      'vote-fail-gate-pass',
      'gate-not-run',
      'exact-half',
    )
    .chain((kind): fc.Arbitrary<Scenario> => {
      if (kind === 'general') {
        return fc
          .integer({ min: 0, max: 10 })
          .chain((n) =>
            passTableArbitrary(n).map((passTable): Scenario => ({ kind, n, passTable })),
          );
      }
      if (kind === 'exact-half') {
        // Drawn across several widths, per the task body, so the boundary is hit at more than
        // one N rather than only at the first even number fast-check happens to try.
        return fc.constantFrom(2, 4, 6, 8, 10).chain((n) =>
          passTableArbitrary(n).map((passTable): Scenario => ({
            kind,
            n,
            passTable: overrideColumnZero(passTable, exactHalfColumn(n)),
          })),
        );
      }
      // The three gate-disagreement kinds need at least one design to make column 0's forced
      // all-true or all-false vote outcome meaningful.
      const allTrue = (n: number): readonly boolean[] => Array.from({ length: n }, () => true);
      const allFalse = (n: number): readonly boolean[] => Array.from({ length: n }, () => false);
      const columnFor = kind === 'vote-fail-gate-pass' ? allFalse : allTrue;
      return fc.integer({ min: 1, max: 10 }).chain((n) =>
        passTableArbitrary(n).map((passTable): Scenario => ({
          kind,
          n,
          passTable: overrideColumnZero(passTable, columnFor(n)),
        })),
      );
    });
}

/** Build the Cartesian-product `RunMatrix` for an N x N pass table; `passed` drives `failureCause` only incidentally. */
function matrixFor(n: number, passTable: readonly (readonly boolean[])[]): RunMatrix {
  const designIds = Array.from({ length: n }, (_, index) => designIdOf(index));
  const testbenchIds = Array.from({ length: n }, (_, index) => testbenchIdOf(index));
  const cells: RunCell[] = [];
  designIds.forEach((designId, design) => {
    testbenchIds.forEach((testbenchId, testbench) => {
      const passed = passTable[design]?.[testbench] ?? false;
      cells.push({
        designId,
        testbenchId,
        passed,
        signature: null,
        failureCause: passed ? 'none' : 'tool-failed',
      });
    });
  });
  return { designIds, testbenchIds, cells };
}

/**
 * The mutation outcome map for one scenario: testbench 0 carries the kind's own decisive gate
 * outcome (or is omitted entirely for `gate-not-run`, so `trustVote` must read that absence as
 * `not-run` itself rather than this map pre-computing it); every other testbench is fixed to
 * `passed` so only the vote decides its `trusted` value.
 */
function mutationOutcomesFor(
  kind: ScenarioKind,
  testbenchIds: readonly string[],
): ReadonlyMap<string, MutationGateVote> {
  const outcomes = new Map<string, MutationGateVote>();
  const decisiveTestbenchId = testbenchIds[0];
  for (const testbenchId of testbenchIds) {
    if (testbenchId !== decisiveTestbenchId) {
      outcomes.set(testbenchId, { kind: 'passed' });
      continue;
    }
    switch (kind) {
      case 'vote-pass-gate-fail':
        outcomes.set(testbenchId, { kind: 'failed' });
        break;
      case 'gate-not-run':
        // Deliberately not set: a testbench absent from the map must read as `not-run`.
        break;
      case 'vote-fail-gate-pass':
      case 'exact-half':
      case 'general':
      default:
        outcomes.set(testbenchId, { kind: 'passed' });
        break;
    }
  }
  return outcomes;
}

describe(PROPERTY, () => {
  it(
    'builds the exact Cartesian product of cells at N squared, votes a testbench trusted iff ' +
      'its passing count strictly exceeds N / 2, and conjoins that vote with the supplied ' +
      'Mutation_Strength_Gate outcome',
    () => {
      let generalCases = 0;
      let votePassGateFailCases = 0;
      let voteFailGatePassCases = 0;
      let gateNotRunCases = 0;
      let exactHalfCases = 0;
      const exactHalfWidthsSeen = new Set<number>();

      fc.assert(
        fc.property(scenarioArbitrary(), (scenario) => {
          const { kind, n, passTable } = scenario;
          const matrix = matrixFor(n, passTable);
          const mutationOutcomes = mutationOutcomesFor(kind, matrix.testbenchIds);

          // Rule 1 (Req 8.5, 15.4): the cells are exactly the Cartesian product, N squared of them.
          expect(matrix.cells).toHaveLength(n * n);
          const seenPairs = new Set(
            matrix.cells.map((cell) => `${cell.designId}\u0000${cell.testbenchId}`),
          );
          expect(seenPairs.size).toBe(n * n);
          for (const designId of matrix.designIds) {
            for (const testbenchId of matrix.testbenchIds) {
              expect(seenPairs.has(`${designId}\u0000${testbenchId}`)).toBe(true);
            }
          }

          const trust = trustVote(matrix, mutationOutcomes);

          // Exhaustive (Req 8.6): one TestbenchTrust per testbench of the matrix, no omission.
          expect(trust.map((entry) => entry.testbenchId)).toEqual(matrix.testbenchIds);

          trust.forEach((entry, testbenchIndex) => {
            const passingCount = matrix.designIds.filter(
              (_, designIndex) => passTable[designIndex]?.[testbenchIndex] ?? false,
            ).length;
            const expectedVotedTrusted = passingCount > n / 2;
            const outcomeKind = mutationOutcomes.get(entry.testbenchId)?.kind ?? 'not-run';
            const expectedTrusted = expectedVotedTrusted && outcomeKind === 'passed';

            // Rule 2 (Req 8.1): strictly more than half, never at or below half.
            expect(entry.passingDesignCount).toBe(passingCount);
            expect(entry.votedTrusted).toBe(expectedVotedTrusted);
            // Rule 2's conjunction (Req 8.2, 12.1, 12.3): the vote alone never sets `trusted`.
            expect(entry.mutationOutcome.kind).toBe(outcomeKind);
            expect(entry.trusted).toBe(expectedTrusted);
          });

          const decisive = trust[0];
          switch (kind) {
            case 'vote-pass-gate-fail':
              if (decisive === undefined) {
                throw new Error('expected a decisive testbench at index 0');
              }
              expect(decisive.votedTrusted).toBe(true);
              expect(decisive.trusted).toBe(false);
              votePassGateFailCases += 1;
              break;
            case 'vote-fail-gate-pass':
              if (decisive === undefined) {
                throw new Error('expected a decisive testbench at index 0');
              }
              expect(decisive.votedTrusted).toBe(false);
              expect(decisive.trusted).toBe(false);
              voteFailGatePassCases += 1;
              break;
            case 'gate-not-run':
              if (decisive === undefined) {
                throw new Error('expected a decisive testbench at index 0');
              }
              expect(decisive.votedTrusted).toBe(true);
              expect(decisive.mutationOutcome.kind).toBe('not-run');
              expect(decisive.trusted).toBe(false);
              gateNotRunCases += 1;
              break;
            case 'exact-half':
              if (decisive === undefined) {
                throw new Error('expected a decisive testbench at index 0');
              }
              expect(n % 2).toBe(0);
              expect(decisive.passingDesignCount).toBe(n / 2);
              expect(decisive.votedTrusted).toBe(false);
              expect(decisive.trusted).toBe(false);
              exactHalfCases += 1;
              exactHalfWidthsSeen.add(n);
              break;
            case 'general':
              generalCases += 1;
              break;
          }
        }),
        propertyParameters(),
      );

      // NON-VACUITY: every decisive shape the task names must actually have been exercised,
      // and the exact-half boundary must have been hit at more than one width.
      expect({
        generalCases: generalCases > 0,
        votePassGateFailCases: votePassGateFailCases > 0,
        voteFailGatePassCases: voteFailGatePassCases > 0,
        gateNotRunCases: gateNotRunCases > 0,
        exactHalfCases: exactHalfCases > 0,
        exactHalfMultipleWidths: exactHalfWidthsSeen.size > 1,
      }).toEqual({
        generalCases: true,
        votePassGateFailCases: true,
        voteFailGatePassCases: true,
        gateNotRunCases: true,
        exactHalfCases: true,
        exactHalfMultipleWidths: true,
      });
    },
  );
});

// reference-model-consensus-gate, Property 19: Attribution below the Pool_Correctness gate
// changes nothing (task 2.10).
//
// SCOPE DEVIATION FROM THE TASK TEXT (read this before touching the trigger assertion below)
//   The task text asks this property to assert "zero Repair_Attempts are started" below the gate
//   and that "a TESTBENCH verdict may start one" at or above it. Task 11.1, the repair trigger
//   that reads a Fault_Verdict and an AttributionStatus together and decides whether to start a
//   Repair_Attempt, has not landed yet (it is group 11, several waves after this one). There is no
//   function to call for that join, and inventing a stub for it would test a fabrication rather
//   than the real repair trigger task 11.1 will add. So this property is scoped to the two
//   pieces that ARE real and callable today, which jointly cover the oracle without that join:
//     1. `attributionStatus` restated over drawn Pool_Correctness values, strictly below 50%
//        reads `advisory` and at 50% or above reads `actionable` (Req 10.2, 10.3), with the exact
//        50% boundary constructed at several even Testbench_Pool widths (Req 10.1).
//     2. `attributeFault` over a Session's worth of failing pairs constructed so EVERY pair
//        attributes `ABSTAIN`, which is the one Fault_Verdict Req 9.11 forbids editing anything
//        from: an all-ABSTAIN Session has nothing non-ABSTAIN to steer a repair with, independent
//        of whichever AttributionStatus its Pool_Correctness happens to carry.
//   Once task 11.1 lands, this property gets a third `describe` sibling (or a new case inside this
//   one) that drives the real trigger function and checks the "zero started" / "may start one"
//   halves directly, per the task text's own instruction to append rather than rewrite.
//
// THE ORACLE
//   `poolCorrectness` restated: the trusted share of a drawn `TestbenchTrust` list, 0 for an empty
//   pool (Req 10.1). `attributionStatus` restated: `advisory` strictly below 0.5, `actionable` at
//   0.5 or above (Req 10.2, 10.3). `attributeFault`'s ABSTAIN clause restated independently of
//   `fault-attributor.ts` from Req 9.2, 9.3, 9.4, 9.6: ABSTAIN is whatever neither the RTL nor the
//   TESTBENCH condition reaches, which includes every pair below the Peer_Floor of 3 on either
//   side and every pair whose two shares do not strictly clear 0.5 in opposite directions.
//   Both halves also check that calling the function does not mutate the pool/peers value it was
//   handed, which is the "both pools unchanged" clause the task asks for: these are pure
//   functions, so the only pool-mutation path left for a Session built on them is the one task
//   11.1 has not added yet.
//
// Validates: Requirements 9.11, 10.1, 10.2, 10.3

const PROPERTY_19 =
  'reference-model-consensus-gate, Property 19: Attribution below the Pool_Correctness gate changes nothing';

/** A minimal `TestbenchTrust` carrying only the `trusted` flag `poolCorrectness` and nothing else reads. */
function testbenchTrustOf(index: number, trusted: boolean): TestbenchTrust {
  return {
    testbenchId: `testbench-${index}`,
    passingDesignCount: 0,
    votedTrusted: trusted,
    mutationOutcome: { kind: trusted ? 'passed' : 'not-run' },
    trusted,
  };
}

/** A Testbench_Pool of `n` entries with exactly `trustedCount` of them trusted, trusted entries first. */
function trustListOf(n: number, trustedCount: number): readonly TestbenchTrust[] {
  return Array.from({ length: n }, (_, index) => testbenchTrustOf(index, index < trustedCount));
}

/**
 * The ABSTAIN clause of `attributeFault` restated from Req 9.2, 9.3, 9.4, 9.6, independently of
 * `fault-attributor.ts`'s own `attributeFault` body.
 */
function expectedAbstainVerdict(peers: FailingPairPeers): boolean {
  if (peers.peerDesignCount < PEER_FLOOR || peers.peerTestbenchCount < PEER_FLOOR) {
    return true;
  }
  const peerPassShare = peers.peerPassCount / peers.peerDesignCount;
  const peerTestbenchShare = peers.peerTestbenchPassCount / peers.peerTestbenchCount;
  const isRtl = peerPassShare > 0.5 && peerTestbenchShare < 0.5;
  const isTestbench = peerPassShare < 0.5 && peerTestbenchShare > 0.5;
  return !isRtl && !isTestbench;
}

/** Every `FailingPairPeers` field drawn independently, counts small enough to reach the Peer_Floor boundary often. */
function failingPairPeersArbitrary(): fc.Arbitrary<FailingPairPeers> {
  return fc
    .record({
      peerDesignCount: fc.integer({ min: 0, max: 10 }),
      peerTestbenchCount: fc.integer({ min: 0, max: 10 }),
    })
    .chain(({ peerDesignCount, peerTestbenchCount }) =>
      fc.record({
        peerDesignCount: fc.constant(peerDesignCount),
        peerTestbenchCount: fc.constant(peerTestbenchCount),
        peerPassCount: fc.integer({ min: 0, max: peerDesignCount }),
        peerTestbenchPassCount: fc.integer({ min: 0, max: peerTestbenchCount }),
      }),
    );
}

describe(PROPERTY_19, () => {
  it(
    'reads attributionStatus as advisory strictly below 50% Pool_Correctness and actionable at ' +
      '50% or above, including at the exact 50% boundary, without mutating the pool it was handed',
    () => {
      let belowGateCases = 0;
      let atOrAboveGateCases = 0;
      const exactHalfWidthsSeen = new Set<number>();

      fc.assert(
        fc.property(
          fc
            .integer({ min: 0, max: 20 })
            .chain((n) =>
              fc
                .integer({ min: 0, max: n })
                .map((trustedCount): readonly TestbenchTrust[] => trustListOf(n, trustedCount)),
            ),
          (trust) => {
            const beforeCall = JSON.stringify(trust);

            const trustedCount = trust.filter((entry) => entry.trusted).length;
            const expectedCorrectness = trust.length === 0 ? 0 : trustedCount / trust.length;
            const correctness = poolCorrectness(trust);
            expect(correctness).toBe(expectedCorrectness);

            const expectedStatus = correctness >= 0.5 ? 'actionable' : 'advisory';
            expect(attributionStatus(correctness)).toBe(expectedStatus);

            // "Both pools unchanged": neither function mutates the Testbench_Pool it reads.
            expect(JSON.stringify(trust)).toBe(beforeCall);

            if (expectedStatus === 'advisory') {
              belowGateCases += 1;
            } else {
              atOrAboveGateCases += 1;
            }
          },
        ),
        propertyParameters(),
      );

      // Req 10.1, 10.3: the exact 50% boundary at several even Testbench_Pool widths, which is one
      // specific point a share-generic draw above reaches only rarely.
      for (const n of [2, 4, 6, 8, 10]) {
        const trust = trustListOf(n, n / 2);
        const correctness = poolCorrectness(trust);
        expect(correctness).toBe(0.5);
        expect(attributionStatus(correctness)).toBe('actionable');
        exactHalfWidthsSeen.add(n);
      }

      // NON-VACUITY: both sides of the gate, and more than one exact-half width, were exercised.
      expect({
        belowGateCases: belowGateCases > 0,
        atOrAboveGateCases: atOrAboveGateCases > 0,
        exactHalfMultipleWidths: exactHalfWidthsSeen.size > 1,
      }).toEqual({
        belowGateCases: true,
        atOrAboveGateCases: true,
        exactHalfMultipleWidths: true,
      });
    },
  );

  it(
    'attributes every pair of an all-ABSTAIN Session to ABSTAIN, leaving nothing non-ABSTAIN to ' +
      'steer a repair with regardless of the Session Pool_Correctness, without mutating the peer ' +
      'counts it was handed',
    () => {
      let belowFloorCases = 0;
      let nonClearingShareCases = 0;

      fc.assert(
        fc.property(
          fc.array(failingPairPeersArbitrary(), { minLength: 1, maxLength: 8 }),
          (candidatePeers) => {
            const abstainPeers = candidatePeers.filter(expectedAbstainVerdict);
            fc.pre(abstainPeers.length > 0);

            for (const peers of abstainPeers) {
              const beforeCall = JSON.stringify(peers);
              expect(attributeFault(peers)).toBe('ABSTAIN');
              // "Both pools unchanged": attributeFault is a pure read of the four counts.
              expect(JSON.stringify(peers)).toBe(beforeCall);

              if (peers.peerDesignCount < PEER_FLOOR || peers.peerTestbenchCount < PEER_FLOOR) {
                belowFloorCases += 1;
              } else {
                nonClearingShareCases += 1;
              }
            }

            // Req 9.11: an all-ABSTAIN Session's failing pairs carry no RTL or TESTBENCH verdict
            // at all, so there is nothing for a (not-yet-built) repair trigger to act on here
            // regardless of whichever AttributionStatus the Session's Pool_Correctness carries.
            const nonAbstainVerdicts = abstainPeers
              .map((peers) => attributeFault(peers))
              .filter((verdict) => verdict !== 'ABSTAIN');
            expect(nonAbstainVerdicts).toHaveLength(0);
          },
        ),
        propertyParameters(),
      );

      // NON-VACUITY: both ABSTAIN causes (Peer_Floor and a non-clearing share pair) were reached.
      expect({
        belowFloorCases: belowFloorCases > 0,
        nonClearingShareCases: nonClearingShareCases > 0,
      }).toEqual({
        belowFloorCases: true,
        nonClearingShareCases: true,
      });
    },
  );
});
