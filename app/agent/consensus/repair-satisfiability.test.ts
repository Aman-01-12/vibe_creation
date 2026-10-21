// Can `shouldTriggerRepair` fire at all? Measured over every CONSISTENT Session state.
//
// WHY THIS TEST EXISTS
//   `shouldTriggerRepair` conjoins `!hasTrustedTestbench` (Requirement 11.1, "WHEN a Session has
//   no Trusted_Testbench") with `attributionStatus === 'actionable'` (Requirement 10, via
//   `poolCorrectness >= ATTRIBUTION_POOL_CORRECTNESS_GATE`). But `poolCorrectness` IS the trusted
//   share, so `actionable` requires a Trusted_Testbench to exist, which falsifies the first
//   conjunct. The two are satisfied by disjoint regions and the conjunction is unsatisfiable from
//   any state a real Session can reach.
//
//   That went unnoticed because `shouldTriggerRepair` has no callers: an unwired branch never
//   reports that it cannot fire. This test is the standing witness, so the contradiction cannot
//   return unnoticed once the branch IS wired - whichever way DQ4-01 is resolved.
//
// WHAT IT DOES NOT ASSERT
//   It does not assert the function is WRONG. Fed inconsistent inputs it returns `true` perfectly
//   well, and the last case below pins exactly that, so a reader can see the defect is in the
//   conjunction of two requirements rather than in this function's body.

import { describe, expect, it } from 'vitest';

import { shouldTriggerRepair } from './repair.js';
import {
  ATTRIBUTION_POOL_CORRECTNESS_GATE,
  attributionStatus,
  poolCorrectness,
  type TestbenchTrust,
} from './trust-vote.js';

/** A trust array with `trustedCount` of `size` members trusted; only `trusted` is read here. */
function trustOf(size: number, trustedCount: number): readonly TestbenchTrust[] {
  return Array.from(
    { length: size },
    (_, index) => ({ trusted: index < trustedCount }) as TestbenchTrust,
  );
}

describe('shouldTriggerRepair over every consistent Session state (DQ4-01)', () => {
  it('fires for no consistent state: the trusted-share gate and the no-trusted trigger are disjoint', () => {
    const fired: string[] = [];
    let statesChecked = 0;
    let sawAdvisory = false;
    let sawActionable = false;

    for (let size = 1; size <= 8; size += 1) {
      for (let trustedCount = 0; trustedCount <= size; trustedCount += 1) {
        const trust = trustOf(size, trustedCount);
        // Both fields derive from ONE trust array, exactly as a real Session derives them -
        // which is what makes these states consistent rather than merely type-valid.
        const status = attributionStatus(poolCorrectness(trust));
        const hasTrusted = trust.some((testbench) => testbench.trusted);
        if (status === 'advisory') sawAdvisory = true;
        else sawActionable = true;

        statesChecked += 1;
        // The most favourable remaining inputs: a wide family span and a TESTBENCH verdict.
        if (
          shouldTriggerRepair({
            hasTrustedTestbench: hasTrusted,
            majorityFamilyCount: 8,
            attributionStatus: status,
            faultVerdict: 'TESTBENCH',
          })
        ) {
          fired.push(`size ${String(size)} trusted ${String(trustedCount)}`);
        }
      }
    }

    expect(statesChecked).toBe(44);
    // Non-vacuity: both arms of the attribution gate were actually reached, so this is not
    // passing because every state happened to land on one side.
    expect(sawAdvisory).toBe(true);
    expect(sawActionable).toBe(true);
    expect(fired).toEqual([]);
  });

  it('shows the gate and the trigger are satisfied by disjoint trusted-counts', () => {
    const pool = 8;
    // Zero trusted is the only state satisfying the trigger, and it is advisory.
    const none = trustOf(pool, 0);
    expect(none.some((t) => t.trusted)).toBe(false);
    expect(attributionStatus(poolCorrectness(none))).toBe('advisory');

    // The gate first opens at half the pool, where a Trusted_Testbench necessarily exists.
    const atGate = trustOf(pool, pool * ATTRIBUTION_POOL_CORRECTNESS_GATE);
    expect(attributionStatus(poolCorrectness(atGate))).toBe('actionable');
    expect(atGate.some((t) => t.trusted)).toBe(true);
  });

  it('is satisfiable from INCONSISTENT inputs, so the defect is the conjunction, not the body', () => {
    expect(
      shouldTriggerRepair({
        hasTrustedTestbench: false,
        majorityFamilyCount: 3,
        attributionStatus: 'actionable',
        faultVerdict: 'TESTBENCH',
      }),
    ).toBe(true);
  });
});
