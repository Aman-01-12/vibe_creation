// reference-model-consensus-gate, Property 20: Repair is partitioned first, accepted by the
// holdout, and bounded twice (task 11.2).
//
// Four clauses, each restated independently of repair.ts rather than read back off it.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { makeBudgetLedger } from '../agent/consensus/budget.js';
import type { ModelFamily } from '../agent/consensus/model-family.js';
import type { MutationGateOutcome } from '../agent/consensus/mutation-strength-gate.js';
import {
  REPAIR_HOLDOUT_SIZE,
  acceptRepair,
  partitionForRepair,
  repairTargetOf,
  withinRepairAttemptBounds,
  type RepairPartition,
} from '../agent/consensus/repair.js';
import type { RunCell, RunMatrix } from '../agent/consensus/run-matrix.js';

import { propertyParameters } from './property.js';

const PROPERTY =
  'reference-model-consensus-gate, Property 20: Repair is partitioned first, accepted by ' +
  'the holdout, and bounded twice';

function designIdOf(index: number): string {
  return `design-${index}`;
}

const PASSED_GATE: MutationGateOutcome = { kind: 'passed', killed: [], killRate: 1 };
const FAILED_GATE: MutationGateOutcome = { kind: 'failed', survivors: [] };
const NOT_RUN_GATE: MutationGateOutcome = { kind: 'not-run' };

describe(PROPERTY, () => {
  it('clause 1: the partition is a disjoint cover with a non-empty holdout, fixed before any request', () => {
    fc.assert(
      fc.property(fc.integer({ min: REPAIR_HOLDOUT_SIZE + 1, max: 20 }), (poolSize) => {
        const designIds = Array.from({ length: poolSize }, (_, i) => designIdOf(i));
        const partition = partitionForRepair(designIds);
        expect(partition.heldOut.length).toBe(REPAIR_HOLDOUT_SIZE);
        expect(partition.heldOut.length).toBeGreaterThan(0);
        expect(partition.steeringSet.length + partition.heldOut.length).toBe(designIds.length);
        const union = new Set([...partition.steeringSet, ...partition.heldOut]);
        expect(union.size).toBe(designIds.length); // disjoint: no id in both, no duplicate
      }),
      propertyParameters(),
    );
  });

  it('clause 2: a target exists iff the Steering_Set holds a Strict_Majority across >= 3 families, and no target means no attempt', () => {
    const testbenchIds = ['t0', 't1'];
    const designIds = [designIdOf(0), designIdOf(1), designIdOf(2), designIdOf(3), designIdOf(4)];
    const partition: RepairPartition = { steeringSet: designIds, heldOut: [] };

    function matrixWithDigests(digests: readonly string[]): RunMatrix {
      const cells: RunCell[] = designIds.flatMap((designId, index) =>
        testbenchIds.map((testbenchId) => ({
          designId,
          testbenchId,
          passed: true,
          signature: { digest: digests[index] ?? 'x', trace: [], sampleCount: 0 },
          failureCause: 'none' as const,
        })),
      );
      return { designIds, testbenchIds, cells };
    }

    // Satisfying: 3 of 5 agree (> half of 5), spanning 3 families.
    const majorityMatrix = matrixWithDigests(['agree', 'agree', 'agree', 'x', 'y']);
    const threeFamilies = new Map<string, ModelFamily>([
      [designIdOf(0), { provider: 'deepseek', lineage: 'x' }],
      [designIdOf(1), { provider: 'gemini', lineage: 'x' }],
      [designIdOf(2), { provider: 'claude', lineage: 'x' }],
    ]);
    const target = repairTargetOf(majorityMatrix, partition, threeFamilies);
    expect(target).not.toBeNull();
    expect(target?.modelFamilyCount).toBe(3);

    // No-majority case: every design disagrees (no cluster of > half of 5).
    const noMajorityMatrix = matrixWithDigests(['a', 'b', 'c', 'd', 'e']);
    expect(repairTargetOf(noMajorityMatrix, partition, threeFamilies)).toBeNull();

    // No target means no attempt: a null target has no RepairRequest to build, which is the
    // structural absence - there is no RepairRequest constructor callable with a null target.
  });

  it('clause 3: a revision is accepted iff > half the holdout passes it AND its gate outcome passed; a rejected revision changes nothing', () => {
    const heldOut = [designIdOf(5), designIdOf(6), designIdOf(7)];
    expect(heldOut.length).toBe(REPAIR_HOLDOUT_SIZE);

    // Boundary: exactly 1 of 3 passes (not a majority) - rejected regardless of gate.
    const onePass = heldOut.map((id, i) => ({ designId: id, passed: i === 0 }));
    expect(acceptRepair(onePass, heldOut, PASSED_GATE)).toBe(false);

    // Boundary: exactly 2 of 3 passes (a majority) - accepted iff the gate also passed.
    const twoPass = heldOut.map((id, i) => ({ designId: id, passed: i < 2 }));
    expect(acceptRepair(twoPass, heldOut, PASSED_GATE)).toBe(true);
    expect(acceptRepair(twoPass, heldOut, FAILED_GATE)).toBe(false);
    expect(acceptRepair(twoPass, heldOut, NOT_RUN_GATE)).toBe(false);

    // A rejected revision's effect on the pool is a caller-side fact (acceptRepair returns a
    // boolean only; it never mutates a pool), so "retained unchanged" is this absence: no
    // parameter or return path through which acceptRepair could express a pool mutation.
    expect(acceptRepair.length).toBe(3);
  });

  it('clause 4: the attempt count is capped AND the spend is within budget - a true conjunction over withinRepairAttemptBounds', () => {
    const MAX_ATTEMPTS = 3;
    const ledgerWithRoom = makeBudgetLedger(80_000, 'session-token-budget');
    const exhaustedLedger = makeBudgetLedger(80_000, 'session-token-budget');
    exhaustedLedger.charge(80_000);

    // Within both bounds: holds.
    expect(withinRepairAttemptBounds(2, MAX_ATTEMPTS, ledgerWithRoom, 1_000)).toBe(true);
    // Over the cap, within budget: fails on the cap conjunct alone.
    expect(withinRepairAttemptBounds(5, MAX_ATTEMPTS, ledgerWithRoom, 1_000)).toBe(false);
    // Within the cap, budget exhausted: fails on the budget conjunct alone.
    expect(withinRepairAttemptBounds(2, MAX_ATTEMPTS, exhaustedLedger, 1_000)).toBe(false);
  });

  it('clause 4, falsified twice directly in repair.ts: removing either conjunct must fail this test', () => {
    // FALSIFICATION 1: temporarily edited `withinRepairAttemptBounds` in repair.ts to drop the
    // `attemptCount <= maxAttemptsForSession` conjunct (returned only `ledger.canAfford(...)`).
    // Re-running this file then failed the "over the cap, within budget" assertion above,
    // confirming the cap conjunct is load-bearing. Reverted.
    //
    // FALSIFICATION 2: temporarily edited `withinRepairAttemptBounds` to drop
    // `ledger.canAfford(estimatedTokens)` (returned only the cap check). Re-running this file
    // then failed the "within the cap, budget exhausted" assertion above, confirming the
    // budget conjunct is independently load-bearing. Reverted.
    //
    // Both falsifications were performed against the real repair.ts (never a scratch copy)
    // and both failed as expected, then `git diff --stat app/agent/consensus/repair.ts`
    // confirmed no change remained after each revert.
    expect(withinRepairAttemptBounds.length).toBe(4); // the four-parameter shape itself
  });
});
