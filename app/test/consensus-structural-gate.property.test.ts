// reference-model-consensus-gate, Property 4: Admission is exactly the Structural_Gate (task 3.6).
//
// THE ORACLE
//   The admission mask is planted by the generator: each Candidate_Design is tagged with the
//   Structural_Gate result the generator chose, and the expected Design_Pool is exactly the
//   subset the generator marked admitted. `admittedPool` is checked against that planted set
//   directly, never against its own filtering restated.
//
// WHY THE N CLAUSE IS ASSERTED EXPLICITLY, AND WHY ITS THRESHOLD CHECK IS INLINE
//   Design C4's whole point is that the Pool_Size every later Grant_Condition and threshold reads
//   is the ADMITTED subset's cardinality, never the generated candidate count. `strictMajority`
//   (task 2.5) is not implemented yet, so this file restates its threshold oracle inline
//   (`Math.floor(poolSize / 2)`, the same slot-cap formula `budget.ts` and `model-family.ts`
//   already use) rather than importing it, and feeds the ADMITTED count into it. If task 2.5's
//   real `strictMajority` later disagrees with this restatement, that is 2.5/2.7's property
//   test's job to catch, not this one's.
//
// WHY THE DECISIVE SHAPES ARE CONSTRUCTED, NOT SAMPLED
//   A pool of 0 or 1 is where a cardinality bug (reading the generated count instead of the
//   admitted one) actually surfaces as a visible wrong answer, and a random admission mask drawn
//   over a handful of designs reaches an all-false or an exactly-one-true mask too rarely for the
//   default run count to cover it reliably. Each constructed shape uses a generated count whose
//   own `floor(count / 2)` stays nonzero, so its contrast with the admitted threshold is never
//   vacuous.
//
// Validates: Requirements 1.5, 14.3

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { admittedPool, type StructuralGateResult } from '../agent/consensus/structural-gate.js';

import { ASCII_IDENT_CHARS, stringFromChars } from './generators/chars.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'reference-model-consensus-gate, Property 4: Admission is exactly the Structural_Gate';

/** The strict-majority slot-cap formula `budget.ts`/`model-family.ts` already use, restated
 * here because `strictMajority` (task 2.5) does not exist yet. */
function strictMajorityThresholdFor(poolSize: number): number {
  return Math.floor(poolSize / 2);
}

/** A minimal `StructuralGateResult` carrying only the planted admission decision. */
function gateResult(admitted: boolean): StructuralGateResult {
  return { admitted, checks: [{ name: 'placeholder', passed: admitted }] };
}

interface Candidate {
  readonly design: string;
  readonly result: StructuralGateResult;
}

/** A design identity distinguishable from any other drawn into the same list. */
function designIdArbitrary(): fc.Arbitrary<string> {
  return stringFromChars(ASCII_IDENT_CHARS, 1, 12);
}

/**
 * `all-refused` and `exactly-one-admitted` are the decisive shapes (pool of 0 or 1); `random-mask`
 * is the general case checked at every pool size, including 0 and the one where the mask happens
 * to admit everything.
 */
type ScenarioKind = 'random-mask' | 'all-refused' | 'exactly-one-admitted';

interface Scenario {
  readonly designIds: readonly string[];
  readonly kind: ScenarioKind;
  readonly randomMask: readonly boolean[];
  readonly admittedIndex: number;
}

function scenarioArbitrary(): fc.Arbitrary<Scenario> {
  return fc
    .constantFrom<ScenarioKind>('random-mask', 'all-refused', 'exactly-one-admitted')
    .chain((kind) => {
      // The two decisive kinds need a generated count whose own floor(count / 2) is nonzero, or
      // the contrast with the admitted threshold (0, at a pool of 0 or 1) would be vacuous.
      const countRange = kind === 'random-mask' ? { min: 0, max: 10 } : { min: 2, max: 10 };
      return fc.integer(countRange).chain((count) =>
        fc
          .uniqueArray(designIdArbitrary(), { minLength: count, maxLength: count })
          .chain((designIds) =>
            fc.record<Scenario>({
              designIds: fc.constant(designIds),
              kind: fc.constant(kind),
              randomMask: fc.array(fc.boolean(), { minLength: count, maxLength: count }),
              admittedIndex: count > 0 ? fc.nat({ max: count - 1 }) : fc.constant(0),
            }),
          ),
      );
    });
}

/** The planted admission decision for one design index, per the scenario's kind. */
function isAdmitted(scenario: Scenario, index: number): boolean {
  switch (scenario.kind) {
    case 'random-mask':
      return scenario.randomMask[index] ?? false;
    case 'all-refused':
      return false;
    case 'exactly-one-admitted':
      return index === scenario.admittedIndex;
  }
}

/** Build the candidate list and the expected admitted-subset identity from one scenario. */
function candidatesFor(scenario: Scenario): {
  readonly candidates: readonly Candidate[];
  readonly expectedAdmittedIds: readonly string[];
} {
  const candidates = scenario.designIds.map((design, index) => ({
    design,
    result: gateResult(isAdmitted(scenario, index)),
  }));
  const expectedAdmittedIds = scenario.designIds.filter((_, index) => isAdmitted(scenario, index));
  return { candidates, expectedAdmittedIds };
}

describe(PROPERTY, () => {
  it(
    'admits exactly the planted Structural_Gate subset, and its cardinality (never the ' +
      'generated count) is what a strict-majority threshold reads',
    () => {
      let allRefusedCases = 0;
      let exactlyOneCases = 0;
      let randomMaskCases = 0;

      fc.assert(
        fc.property(scenarioArbitrary(), (scenario) => {
          const { candidates, expectedAdmittedIds } = candidatesFor(scenario);
          const generatedCount = candidates.length;

          const pool = admittedPool(candidates);

          // The Design_Pool is EXACTLY the planted admitted subset, in generated order.
          expect(pool).toEqual(expectedAdmittedIds);

          // The N clause: Pool_Size is the admitted subset's cardinality, not the generated count.
          const poolSize = pool.length;
          expect(poolSize).toBe(expectedAdmittedIds.length);

          // Feed the resulting N into the strict-majority threshold oracle and assert it moved
          // with N, not with the generated count.
          const thresholdFromAdmitted = strictMajorityThresholdFor(poolSize);
          expect(thresholdFromAdmitted).toBe(
            strictMajorityThresholdFor(expectedAdmittedIds.length),
          );

          if (scenario.kind === 'all-refused') {
            expect(poolSize).toBe(0);
            expect(thresholdFromAdmitted).toBe(0);
            // A cardinality bug reading the generated count instead would compute a nonzero
            // threshold here; the decisive shape exists precisely to catch that.
            expect(strictMajorityThresholdFor(generatedCount)).toBeGreaterThan(0);
            expect(thresholdFromAdmitted).not.toBe(strictMajorityThresholdFor(generatedCount));
            allRefusedCases += 1;
          }

          if (scenario.kind === 'exactly-one-admitted') {
            expect(poolSize).toBe(1);
            expect(thresholdFromAdmitted).toBe(0);
            expect(strictMajorityThresholdFor(generatedCount)).toBeGreaterThan(0);
            expect(thresholdFromAdmitted).not.toBe(strictMajorityThresholdFor(generatedCount));
            exactlyOneCases += 1;
          }

          if (scenario.kind === 'random-mask') {
            randomMaskCases += 1;
          }
        }),
        propertyParameters(),
      );

      // NON-VACUITY: every decisive shape the task names must actually have been exercised.
      expect({
        allRefusedCases: allRefusedCases > 0,
        exactlyOneCases: exactlyOneCases > 0,
        randomMaskCases: randomMaskCases > 0,
      }).toEqual({
        allRefusedCases: true,
        exactlyOneCases: true,
        randomMaskCases: true,
      });
    },
  );
});
