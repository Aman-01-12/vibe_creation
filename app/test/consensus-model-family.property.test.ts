// reference-model-consensus-gate, Property 8: Model_Family diversity gates the Design_Pool only,
// and no family can hold a majority of slots (task 3.2).
//
// THE ORACLE
//   Both halves are the planner's own four constraints restated independently of its
//   implementation, over drawn available-family lists and pool sizes:
//     - callCount = min(poolSize, distinctFamilies * perFamilyCap), where perFamilyCap is
//       Math.floor(poolSize / 2) for the Design_Pool and Infinity for the Testbench_Pool.
//     - achievedDistinctFamilyCount = callCount === 0 ? 0 : min(distinctFamilies, callCount).
//     - every call's own family never exceeds perFamilyCap slots.
//   The cap is computed independently here, not imported from `model-family.ts`, so a planner
//   defect in the cap arithmetic itself cannot also infect the oracle that checks it.
//
// WHY THE DECISIVE LENGTHS ARE CONSTRUCTED, NOT LEFT TO A GENERAL LIST GENERATOR
//   A general "N available selections" draw almost never lands on a SHORT distinct-family list,
//   because the model router's six vendors mean a few random selections usually collapse to
//   several families already. The refusal half of the diversity condition - too few families to
//   reach MIN_MODEL_FAMILIES, or too few to fill the pool without one family exceeding its cap -
//   is checked only when the available list is short, so lengths 1, 2, 3, and "more than 3" are
//   drawn explicitly as named cases rather than hoped for from a single general arbitrary.
//
// THE ROUTING-CHAIN CLAUSE (Req 3.5)
//   Asserted as a structural fact over every call the planner builds, for both pools: the chain's
//   `taskRoute` resolves every `ModelTask` to the one assigned selection (so there is no second
//   provider for the Model_Router's existing escalation to fall back to), and `maxAttempts` is 1.
//
// THE Q-11 INVERSION (Req 5.9) - ASSERTED AS AN ABSENCE
//   A `FamilyPlan` has no `refused`/`ok` field and no Grant_Condition value anywhere in its shape:
//   it is `{ calls, distinctFamilyCount }` and nothing else. So "no Session is refused and no
//   Grant_Condition value changes" is checked by asserting the Testbench_Pool plan NEVER grows a
//   field beyond that shape and ALWAYS returns exactly `poolSize` calls, even at a single available
//   family - which is the shape the Design_Pool planner is explicitly permitted to fall short of.
//   A test that only drew the Design_Pool side would pass under the symmetric design Q-11
//   overturned, because the two planners share one call-building helper and a design-side-only
//   check cannot tell "capped" apart from "always capped".
//
// Validates: Requirements 3.1, 3.2, 3.4, 3.5, 3.7, 5.9

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  modelFamilyOf,
  planDesignPoolFamilies,
  planTestbenchPoolFamilies,
  type FamilyPlan,
  type FamilyRoutedCall,
} from '../agent/consensus/model-family.js';

import { MODEL_TASKS, type ModelSelection, type ProviderName } from '@app/agent';
import { propertyParameters } from './property.js';

const PROPERTY =
  'reference-model-consensus-gate, Property 8: Model_Family diversity gates the Design_Pool ' +
  'only, and no family can hold a majority of slots';

/** One available selection per distinct family, built so `modelFamilyOf` never collapses two of
 * them. Each uses a distinct provider, which is always a distinct family regardless of model id. */
const DISTINCT_FAMILY_PROVIDERS: readonly ProviderName[] = [
  'deepseek',
  'gemini',
  'claude',
  'bedrock-mantle',
];

/**
 * Words (never digits) distinguishing a second, third, ... pass over
 * `DISTINCT_FAMILY_PROVIDERS` once its 4 providers are exhausted.
 *
 * `modelFamilyOf` strips a trailing version marker, so a NUMERIC cycle suffix
 * (`-v1`, `-v2`) would collapse back into one lineage - the exact rule the
 * design states for `deepseek-v3.2` versus `deepseek-v4-pro`. A word has no
 * trailing digit, so `stripVersionTail` leaves it untouched and each cycle
 * stays its own lineage.
 */
const CYCLE_WORDS: readonly string[] = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];

/** A selection for the Nth distinct-family provider in `DISTINCT_FAMILY_PROVIDERS`, cycling with a
 * word suffix once providers run out, so "more than 4" distinct families is still reachable. */
function selectionForFamilyIndex(index: number): ModelSelection {
  const providerIndex = index % DISTINCT_FAMILY_PROVIDERS.length;
  const provider = DISTINCT_FAMILY_PROVIDERS[providerIndex] as ProviderName;
  const cycle = Math.floor(index / DISTINCT_FAMILY_PROVIDERS.length);
  const word = CYCLE_WORDS[cycle];
  if (word === undefined) {
    throw new Error(`fixture needs a cycle word for cycle ${cycle}; CYCLE_WORDS is too short`);
  }
  if (provider === 'bedrock-mantle') {
    return { provider, modelId: `vendor-${word}.model-alpha` };
  }
  return { provider, modelId: `${provider}-model-${word}` };
}

/** `count` available selections, one per distinct family, built from `selectionForFamilyIndex`. */
function distinctFamilySelections(count: number): readonly ModelSelection[] {
  return Array.from({ length: count }, (_, index) => selectionForFamilyIndex(index));
}

/** The distinct `ModelFamily` count a selection list actually resolves to, via the production
 * `modelFamilyOf`, so the test's own fixture-construction assumption is checked rather than
 * trusted blindly. */
function distinctFamilyCountOf(selections: readonly ModelSelection[]): number {
  const keys = new Set(
    selections.map((selection) => {
      const family = modelFamilyOf(selection);
      return `${family.provider}\u0000${family.lineage}`;
    }),
  );
  return keys.size;
}

/** The independent slot-cap formula the design states: `floor(poolSize / 2)` for the Design_Pool,
 * uncapped for the Testbench_Pool. Restated here rather than imported, so a planner defect in the
 * cap arithmetic cannot also infect the oracle checking it. */
function perFamilyCapFor(poolSize: number, pool: 'design' | 'testbench'): number {
  return pool === 'design' ? Math.floor(poolSize / 2) : Number.POSITIVE_INFINITY;
}

/** The independent oracle for how many calls a round-robin planner builds and how many distinct
 * families it reaches, from the available family count and the per-family cap alone. */
function expectedPlan(
  availableFamilyCount: number,
  poolSize: number,
  perFamilyCap: number,
): { readonly callCount: number; readonly distinctFamilyCount: number } {
  const callCount =
    perFamilyCap === 0 ? 0 : Math.min(poolSize, availableFamilyCount * perFamilyCap);
  const distinctFamilyCount = callCount === 0 ? 0 : Math.min(availableFamilyCount, callCount);
  return { callCount, distinctFamilyCount };
}

/** Every call in a plan carries a single-entry, single-attempt chain naming its own family's
 * selection for every `ModelTask`, so the Model_Router's existing escalation cannot fall back
 * across families (Req 3.5). */
function assertSingleEntryNoFallbackChain(call: FamilyRoutedCall): void {
  expect(call.routingPolicy.maxAttempts).toBe(1);
  for (const task of MODEL_TASKS) {
    const chain = call.routingPolicy.taskRoute[task];
    expect(chain).toHaveLength(1);
    expect(chain[0]).toEqual(call.selection);
  }
}

/** A `FamilyPlan`'s own shape carries no refusal flag and no Grant_Condition field: it is exactly
 * `{ calls, distinctFamilyCount }`, checked by its own key set rather than by a cast. */
function assertNoRefusalShape(plan: FamilyPlan): void {
  expect(Object.keys(plan).sort()).toEqual(['calls', 'distinctFamilyCount']);
}

// --- Design_Pool: the diversity Grant_Condition, drawn at available-family lengths that reach
// the refusal half (1, 2, 3, and more than 3), the cases a wider available list never reaches. ---

describe(PROPERTY, () => {
  describe('Design_Pool: the slot cap and achieved count, over short and long available lists', () => {
    it('caps every family at floor(poolSize / 2) design slots and reports the achieved family count', () => {
      let availableLengthOne = 0;
      let availableLengthTwo = 0;
      let availableLengthThree = 0;
      let availableLengthMoreThanThree = 0;

      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 6 }),
          fc.integer({ min: 1, max: 16 }),
          (availableFamilyCount, poolSize) => {
            const available = distinctFamilySelections(availableFamilyCount);
            // Guard the fixture's own assumption: each constructed selection is its own family.
            expect(distinctFamilyCountOf(available)).toBe(availableFamilyCount);

            const plan = planDesignPoolFamilies(available, poolSize);
            const cap = perFamilyCapFor(poolSize, 'design');
            const expected = expectedPlan(availableFamilyCount, poolSize, cap);

            assertNoRefusalShape(plan);
            expect(plan.calls).toHaveLength(expected.callCount);
            expect(plan.distinctFamilyCount).toBe(expected.distinctFamilyCount);

            // No single family is ever assigned more than the cap, independent of achieved count.
            const perFamilyCount = new Map<string, number>();
            for (const call of plan.calls) {
              const key = `${call.family.provider}\u0000${call.family.lineage}`;
              perFamilyCount.set(key, (perFamilyCount.get(key) ?? 0) + 1);
              assertSingleEntryNoFallbackChain(call);
            }
            for (const count of perFamilyCount.values()) {
              expect(count).toBeLessThanOrEqual(cap);
            }

            // No cluster of a Strict_Majority (more than half the admitted pool) or more can ever
            // be single-family: the cap structurally pre-empts it (Req 3.2, 3.7).
            const strictMajority = Math.floor(poolSize / 2) + 1;
            for (const count of perFamilyCount.values()) {
              expect(count).toBeLessThan(strictMajority);
            }

            if (availableFamilyCount === 1) {
              availableLengthOne += 1;
            } else if (availableFamilyCount === 2) {
              availableLengthTwo += 1;
            } else if (availableFamilyCount === 3) {
              availableLengthThree += 1;
            } else {
              availableLengthMoreThanThree += 1;
            }
          },
        ),
        propertyParameters(),
      );

      // NON-VACUITY: the refusal half is checked only at a short available list, so every named
      // length must actually have been drawn.
      expect({
        availableLengthOne: availableLengthOne > 0,
        availableLengthTwo: availableLengthTwo > 0,
        availableLengthThree: availableLengthThree > 0,
        availableLengthMoreThanThree: availableLengthMoreThanThree > 0,
      }).toEqual({
        availableLengthOne: true,
        availableLengthTwo: true,
        availableLengthThree: true,
        availableLengthMoreThanThree: true,
      });
    });

    it('falls short of the Grant_Condition when too few families are available to reach MIN_MODEL_FAMILIES', () => {
      // A decisive, constructed case: 2 available families can never achieve 3 distinct families
      // across the Design_Pool, at any pool size, because the planner invents no family. This is
      // the shape the diversity Grant_Condition actually refuses on (Req 3.1, 3.3), and a wider
      // available list (6 vendors) never reaches it.
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 16 }), (poolSize) => {
          const available = distinctFamilySelections(2);
          const plan = planDesignPoolFamilies(available, poolSize);
          expect(plan.distinctFamilyCount).toBeLessThan(3);
        }),
        propertyParameters(),
      );
    });
  });

  // --- Testbench_Pool: the Q-11 inversion, asserted as an absence. ---

  describe('Testbench_Pool: family spread is a routing target only, never a refusal (Q-11)', () => {
    it('fills every slot and never carries a refusal or Grant_Condition field, including at a single available family', () => {
      let singleFamilyCases = 0;
      let multiFamilyCases = 0;

      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 6 }),
          fc.integer({ min: 1, max: 16 }),
          (availableFamilyCount, poolSize) => {
            const available = distinctFamilySelections(availableFamilyCount);
            expect(distinctFamilyCountOf(available)).toBe(availableFamilyCount);

            const plan = planTestbenchPoolFamilies(available, poolSize);
            const expected = expectedPlan(
              availableFamilyCount,
              poolSize,
              perFamilyCapFor(poolSize, 'testbench'),
            );

            // The absence under test: no refusal/ok field, no Grant_Condition value anywhere in
            // the shape - the same shape the Design_Pool plan has, with no extra field added or
            // removed to signal that this pool's spread is merely a target.
            assertNoRefusalShape(plan);

            // Every slot is filled regardless of how few families are available: there is no cap
            // to fall short of, so a single-family available list still yields a full pool.
            expect(plan.calls).toHaveLength(poolSize);
            expect(plan.calls).toHaveLength(expected.callCount);
            expect(plan.distinctFamilyCount).toBe(expected.distinctFamilyCount);

            for (const call of plan.calls) {
              assertSingleEntryNoFallbackChain(call);
            }

            if (availableFamilyCount === 1) {
              expect(plan.distinctFamilyCount).toBe(1);
              singleFamilyCases += 1;
            } else {
              multiFamilyCases += 1;
            }
          },
        ),
        propertyParameters(),
      );

      // NON-VACUITY: the single-family case is the one a design-side-only test would never draw,
      // because the Design_Pool planner's cap makes a 1-family available list behave differently
      // from a 1-family Testbench_Pool plan; both must actually have been exercised here.
      expect({
        singleFamilyCases: singleFamilyCases > 0,
        multiFamilyCases: multiFamilyCases > 0,
      }).toEqual({
        singleFamilyCases: true,
        multiFamilyCases: true,
      });
    });

    it('never refuses and never changes shape even when the achieved family count stays well below MIN_MODEL_FAMILIES', () => {
      // Decisive case: a single available family can never reach MIN_MODEL_FAMILIES (3), yet the
      // Testbench_Pool plan still fills the pool and still carries no refusal field. This is the
      // exact inversion of the Design_Pool's refusal case above: the same shortfall that caps and
      // shrinks a Design_Pool plan changes nothing about a Testbench_Pool plan's shape or size.
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 16 }), (poolSize) => {
          const available = distinctFamilySelections(1);
          const plan = planTestbenchPoolFamilies(available, poolSize);
          expect(plan.distinctFamilyCount).toBe(1);
          expect(plan.distinctFamilyCount).toBeLessThan(3);
          expect(plan.calls).toHaveLength(poolSize);
          assertNoRefusalShape(plan);
        }),
        propertyParameters(),
      );
    });
  });
});
