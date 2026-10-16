// Feature: grounding-adoption-confirmatory, properties of the pre-registered criterion.
//
// Every oracle here is written from the requirement text and computes by a different route
// from the module under test: it builds the rate DIFFERENCE as a reduced fraction and compares
// that against the margin, where `nonInferior` scales each side instead. A sign or grouping
// error in one cannot hide in the other.
//
// Properties 5 and 8 live here. Properties 1, 2, 6, and 7 are appended by later tasks.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CLAUSE_OUTCOMES,
  PRE_REGISTERED_GROUNDING_CRITERION,
  evaluateGroundingCriterion,
  mcnemarUpperTailNumerator,
  nonInferior,
  type ClauseOutcome,
  type Fraction,
  type GroundingFigures,
  type GroundingVerdictReport,
  type GuardFigures,
  type MutantFigures,
  type NonInferiorityRule,
  type SlotPairOutcome,
} from './grounding-criterion.js';

const PROPERTY_5 =
  'Feature: grounding-adoption-confirmatory, Property 5: The non-inferiority comparison is exact at the boundary';
const PROPERTY_8 =
  'Feature: grounding-adoption-confirmatory, Property 8: A denominator below a clause floor yields not-decided, never not-held';

/** Greatest common divisor, so the oracle can reduce before it compares. */
function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a === 0n ? 1n : a;
}

/**
 * Whether `grounded - control <= margin/100` (or `>= -margin/100`), by an independent route.
 *
 * The difference is formed first and reduced by its gcd, then compared against the margin.
 * That is a different arrangement of the same exact arithmetic, which is what makes it an
 * oracle rather than a copy.
 */
function withinMargin(control: Fraction, grounded: Fraction, rule: NonInferiorityRule): boolean {
  const numerator =
    BigInt(grounded.numerator) * BigInt(control.denominator) -
    BigInt(control.numerator) * BigInt(grounded.denominator);
  const denominator = BigInt(grounded.denominator) * BigInt(control.denominator);
  const divisor = gcd(numerator, denominator);
  const reducedNumerator = numerator / divisor;
  const reducedDenominator = denominator / divisor;
  const margin = BigInt(rule.marginPercent);
  return rule.direction === 'not-higher'
    ? reducedNumerator * 100n <= margin * reducedDenominator
    : reducedNumerator * 100n >= -margin * reducedDenominator;
}

const arbRule: fc.Arbitrary<NonInferiorityRule> = fc.record({
  marginPercent: fc.nat({ max: 5 }),
  direction: fc.constantFrom<NonInferiorityRule['direction']>('not-higher', 'not-lower'),
  minDenominator: fc.constant(1),
});

/** A fraction with a denominator that always clears the floor these cases are about. */
const arbFraction: fc.Arbitrary<Fraction> = fc
  .record({ denominator: fc.integer({ min: 1, max: 400 }), part: fc.nat({ max: 400 }) })
  .map(({ denominator, part }) => ({ numerator: Math.min(part, denominator), denominator }));

describe(PROPERTY_5, () => {
  it('agrees with an independently reduced comparison of the rate difference', () => {
    fc.assert(
      fc.property(arbFraction, arbFraction, arbRule, (control, grounded, rule) => {
        const expected = withinMargin(control, grounded, rule) ? 'held' : 'not-held';

        expect(nonInferior(control, grounded, rule)).toBe(expected);
      }),
      { numRuns: 500 },
    );
  });

  it('holds at a difference exactly on the margin, and fails one mutant past it', () => {
    // Denominators are multiples of 100 so a difference of exactly `margin` points is an
    // integer numerator, which is the only way to land ON the boundary rather than near it.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9 }),
        fc.integer({ min: 1, max: 9 }),
        fc.nat({ max: 40 }),
        fc.integer({ min: 1, max: 5 }),
        (controlUnits, groundedUnits, rateUnits, marginPercent) => {
          const control = { numerator: rateUnits * controlUnits, denominator: 100 * controlUnits };
          const onMargin = {
            numerator: (rateUnits + marginPercent) * groundedUnits,
            denominator: 100 * groundedUnits,
          };
          const rule: NonInferiorityRule = {
            marginPercent,
            direction: 'not-higher',
            minDenominator: 1,
          };

          expect(nonInferior(control, onMargin, rule)).toBe('held');
          expect(
            nonInferior(control, { ...onMargin, numerator: onMargin.numerator + 1 }, rule),
          ).toBe('not-held');
        },
      ),
      { numRuns: 300 },
    );
  });

  it('is symmetric: the not-lower direction is the not-higher one with the arms swapped', () => {
    fc.assert(
      fc.property(
        arbFraction,
        arbFraction,
        fc.nat({ max: 5 }),
        (control, grounded, marginPercent) => {
          const notLower = nonInferior(control, grounded, {
            marginPercent,
            direction: 'not-lower',
            minDenominator: 1,
          });
          const swapped = nonInferior(grounded, control, {
            marginPercent,
            direction: 'not-higher',
            minDenominator: 1,
          });

          expect(notLower).toBe(swapped);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe(PROPERTY_8, () => {
  it('reports not-decided whenever either denominator is below the floor', () => {
    fc.assert(
      fc.property(
        fc.record({
          controlDenominator: fc.constantFrom(0, 1, 33, 34, 35, 200),
          groundedDenominator: fc.constantFrom(0, 1, 33, 34, 35, 200),
          controlNumerator: fc.nat({ max: 200 }),
          groundedNumerator: fc.nat({ max: 200 }),
          minDenominator: fc.constantFrom(1, 34),
          marginPercent: fc.nat({ max: 5 }),
          direction: fc.constantFrom<NonInferiorityRule['direction']>('not-higher', 'not-lower'),
        }),
        (drawn) => {
          const control = {
            numerator: Math.min(drawn.controlNumerator, drawn.controlDenominator),
            denominator: drawn.controlDenominator,
          };
          const grounded = {
            numerator: Math.min(drawn.groundedNumerator, drawn.groundedDenominator),
            denominator: drawn.groundedDenominator,
          };
          const rule: NonInferiorityRule = {
            marginPercent: drawn.marginPercent,
            direction: drawn.direction,
            minDenominator: drawn.minDenominator,
          };
          const belowFloor =
            control.denominator < rule.minDenominator || grounded.denominator < rule.minDenominator;

          const outcome = nonInferior(control, grounded, rule);

          expect(CLAUSE_OUTCOMES).toContain(outcome);
          expect(outcome === 'not-decided').toBe(belowFloor);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('never reports not-held on a floor failure, however bad the numerators look', () => {
    // The worst possible observation on too small a denominator is still no observation.
    const outcome = nonInferior(
      { numerator: 0, denominator: 33 },
      { numerator: 33, denominator: 33 },
      { marginPercent: 0, direction: 'not-higher', minDenominator: 34 },
    );

    expect(outcome).toBe('not-decided');
  });
});

// Property 1, 2, 6, and 7 follow. The oracle below re-states all six clauses and the verdict
// table from the requirement text: it counts discordant pairs by filtering, groups by building
// its own key map, compares every rate as an exact rational by the reduced-difference route
// above, applies each floor, and composes the verdict from its own decision table. Nothing in
// it is imported from the module under test.

const PROPERTY_1 =
  'Feature: grounding-adoption-confirmatory, Property 1: The criterion evaluator agrees with an independently written oracle';
const PROPERTY_2 =
  'Feature: grounding-adoption-confirmatory, Property 2: The clause outcome is total and three-valued';
const PROPERTY_6 =
  'Feature: grounding-adoption-confirmatory, Property 6: The exact McNemar tail decides clause 6.1 at the boundary';
const PROPERTY_7 =
  'Feature: grounding-adoption-confirmatory, Property 7: A per-group count never pools two groups and a tie is not greater';

const CRITERION = PRE_REGISTERED_GROUNDING_CRITERION;
const MODEL_ARMS = ['moonshotai.kimi-k2.5', 'zai.glm-5', 'zai.glm-4.7', 'deepseek.v3.2'] as const;
const DESIGNS = Array.from({ length: 19 }, (_, at) => `design-${String(at)}`);
const EXPECTED_PAIRS = 4 * 19 * 7;

/** The upper tail numerator of P(X >= b | n, 1/2), by an independent Pascal recurrence. */
function oracleTail(b: number, n: number): bigint {
  if (n < 0 || b > n) {
    return 0n;
  }
  let row: bigint[] = [1n];
  for (let level = 1; level <= n; level += 1) {
    const next: bigint[] = [1n];
    for (let at = 1; at < level; at += 1) {
      next.push((row[at - 1] ?? 0n) + (row[at] ?? 0n));
    }
    next.push(1n);
    row = next;
  }
  let total = 0n;
  for (let k = Math.max(0, b); k <= n; k += 1) {
    total += row[k] ?? 0n;
  }
  return total;
}

/** A clause outcome from the oracle's own floor rule and its own comparison. */
function oracleClause(
  control: Fraction,
  grounded: Fraction,
  rule: NonInferiorityRule,
): ClauseOutcome {
  if (control.denominator < rule.minDenominator || grounded.denominator < rule.minDenominator) {
    return 'not-decided';
  }
  return withinMargin(control, grounded, rule) ? 'held' : 'not-held';
}

/** Every clause outcome and the verdict, written from Requirements 6 to 9. */
function oracleReport(
  figures: GroundingFigures,
  deferredSlots: number,
): { readonly verdict: string; readonly outcomes: readonly ClauseOutcome[] } {
  let b = 0;
  let c = 0;
  for (const pair of figures.pairs) {
    if (pair.groundedValid && !pair.controlValid) b += 1;
    if (pair.controlValid && !pair.groundedValid) c += 1;
  }
  const n = b + c;
  const signHeld = b > c && 100n * oracleTail(b, n) <= 5n * 2n ** BigInt(n);

  const countGreater = (keyOf: (pair: SlotPairOutcome) => string): [number, number] => {
    const keys = [...new Set(figures.pairs.map(keyOf))];
    let greater = 0;
    let lower = 0;
    for (const key of keys) {
      const group = figures.pairs.filter((pair) => keyOf(pair) === key);
      const grounded = group.filter((pair) => pair.groundedValid).length;
      const control = group.filter((pair) => pair.controlValid).length;
      if (grounded > control) greater += 1;
      else if (grounded < control) lower += 1;
    }
    return [greater, lower];
  };
  const [modelGreater] = countGreater((pair) => pair.modelArm);
  const [designGreater, designLower] = countGreater((pair) => pair.problemId);

  const outcomes: readonly ClauseOutcome[] = [
    signHeld ? 'held' : 'not-held',
    modelGreater >= 3 ? 'held' : 'not-held',
    designGreater >= 5 && designGreater - designLower >= 3 ? 'held' : 'not-held',
    oracleClause(
      {
        numerator: figures.controlMutants.coverageGapSurvivors,
        denominator: figures.controlMutants.scoredMutants,
      },
      {
        numerator: figures.groundedMutants.coverageGapSurvivors,
        denominator: figures.groundedMutants.scoredMutants,
      },
      { marginPercent: 2, direction: 'not-higher', minDenominator: 1 },
    ),
    oracleClause(
      { numerator: figures.control.missedBug, denominator: figures.control.judged },
      { numerator: figures.grounded.missedBug, denominator: figures.grounded.judged },
      { marginPercent: 3, direction: 'not-higher', minDenominator: 34 },
    ),
    oracleClause(
      { numerator: figures.control.agreed, denominator: figures.control.judged },
      { numerator: figures.grounded.agreed, denominator: figures.grounded.judged },
      { marginPercent: 3, direction: 'not-lower', minDenominator: 34 },
    ),
  ];

  if (deferredSlots > 0 || figures.pairs.length !== EXPECTED_PAIRS) {
    return { verdict: 'not-decided', outcomes };
  }
  if (outcomes.includes('not-decided')) {
    return { verdict: 'not-decided', outcomes };
  }
  return {
    verdict: outcomes.every((outcome) => outcome === 'held') ? 'succeeded' : 'failed',
    outcomes,
  };
}

/** The clause outcomes of a report, in the oracle's order. */
function outcomesOf(criteria: GroundingVerdictReport['criteria']): readonly ClauseOutcome[] {
  return [
    criteria.pooledSignTest.outcome,
    criteria.modelArmsGreater.outcome,
    criteria.designsGreater.outcome,
    criteria.coverageGapNonInferior.outcome,
    criteria.missedBugNonInferior.outcome,
    criteria.agreementNonInferior.outcome,
  ];
}

/** A pair per slot, with each arm's validity drawn from a weight so ties and reversals occur. */
function pairsFrom(weights: readonly number[], controlAt: number, groundedAt: number) {
  return MODEL_ARMS.flatMap((modelArm, modelAt) =>
    DESIGNS.flatMap((problemId, designAt) =>
      Array.from({ length: 7 }, (_, sampleIndex) => {
        const at = modelAt * 133 + designAt * 7 + sampleIndex;
        const weight = weights[at] ?? 0;
        return {
          modelArm,
          problemId,
          sampleIndex,
          controlValid: weight < controlAt,
          groundedValid: weight < groundedAt,
        };
      }),
    ),
  );
}

const arbWeights = fc.array(fc.integer({ min: 0, max: 9 }), {
  minLength: EXPECTED_PAIRS,
  maxLength: EXPECTED_PAIRS,
});

/** Pairs that are neutral, favourable, or unfavourable, so all three verdicts are reachable. */
const arbPairs: fc.Arbitrary<readonly SlotPairOutcome[]> = fc.oneof(
  arbWeights.map((weights) => pairsFrom(weights, 5, 5)),
  arbWeights.map((weights) => pairsFrom(weights, 2, 7)),
  arbWeights.map((weights) => pairsFrom(weights, 7, 2)),
);

const arbGuard: fc.Arbitrary<GuardFigures> = fc
  .record({
    missedBug: fc.integer({ min: 0, max: 20 }),
    // Straddles the 34-sample floor deliberately, so the clause's third state is exercised.
    judged: fc.constantFrom(0, 1, 33, 34, 40, 81, 136),
    agreed: fc.integer({ min: 0, max: 140 }),
  })
  .map((guard) => ({
    ...guard,
    agreed: Math.min(guard.agreed, guard.judged),
    missedBug: Math.min(guard.missedBug, guard.judged),
  }));

const arbMutants: fc.Arbitrary<MutantFigures> = fc
  .record({
    coverageGapSurvivors: fc.integer({ min: 0, max: 200 }),
    scoredMutants: fc.constantFrom(0, 1, 100, 2090, 3122),
  })
  .map((mutants) => ({
    ...mutants,
    coverageGapSurvivors: Math.min(mutants.coverageGapSurvivors, mutants.scoredMutants),
  }));

const arbFigures: fc.Arbitrary<GroundingFigures> = fc.record({
  pairs: arbPairs,
  control: arbGuard,
  grounded: arbGuard,
  controlMutants: arbMutants,
  groundedMutants: arbMutants,
});

describe(PROPERTY_1, () => {
  it('agrees with the oracle on the verdict and on every clause outcome', () => {
    const seen = new Set<string>();
    fc.assert(
      fc.property(arbFigures, fc.constantFrom(0, 0, 0, 3), (figures, deferredSlots) => {
        const report = evaluateGroundingCriterion(CRITERION, figures, deferredSlots);
        const expected = oracleReport(figures, deferredSlots);

        expect(report.verdict).toBe(expected.verdict);
        expect(outcomesOf(report.criteria)).toEqual(expected.outcomes);
        expect(report.pairsExpected).toBe(EXPECTED_PAIRS);
        expect(report.pairsObserved).toBe(figures.pairs.length);
        seen.add(report.verdict);
      }),
      { numRuns: 200 },
    );

    // `succeeded` needs all six clauses to hold at once, which the random draw reaches far too
    // rarely to carry a non-vacuity row, so it is driven by a constructed figure through the same
    // oracle. Every pair favours the grounded arm and both guards sit at equal rates over a
    // denominator clearing the 34-sample floor.
    const allHeld: GroundingFigures = {
      pairs: pairsFrom(
        Array.from({ length: EXPECTED_PAIRS }, () => 3),
        2,
        7,
      ),
      control: { missedBug: 0, judged: 40, agreed: 40 },
      grounded: { missedBug: 0, judged: 40, agreed: 40 },
      controlMutants: { coverageGapSurvivors: 0, scoredMutants: 100 },
      groundedMutants: { coverageGapSurvivors: 0, scoredMutants: 100 },
    };
    const allHeldReport = evaluateGroundingCriterion(CRITERION, allHeld, 0);
    const allHeldExpected = oracleReport(allHeld, 0);
    expect(allHeldReport.verdict).toBe('succeeded');
    expect(allHeldReport.verdict).toBe(allHeldExpected.verdict);
    expect(outcomesOf(allHeldReport.criteria)).toEqual(allHeldExpected.outcomes);
    seen.add(allHeldReport.verdict);

    // Non-vacuity: every verdict was reached, so no branch of the table is untested.
    expect([...seen].sort()).toEqual(['failed', 'not-decided', 'succeeded']);
  });
});

describe(PROPERTY_2, () => {
  it('reports exactly six clauses, each in the closed outcome set, and never throws', () => {
    fc.assert(
      fc.property(arbFigures, fc.nat({ max: 2 }), (figures, deferredSlots) => {
        const report = evaluateGroundingCriterion(CRITERION, figures, deferredSlots);
        const outcomes = outcomesOf(report.criteria);

        expect(Object.keys(report.criteria)).toHaveLength(6);
        expect(outcomes).toHaveLength(6);
        for (const outcome of outcomes) {
          expect(CLAUSE_OUTCOMES).toContain(outcome);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('computes every clause under every verdict, including a deferred one', () => {
    const figures = fc.sample(arbFigures, 1)[0];
    if (figures === undefined) {
      throw new Error('the generator produced no figures');
    }
    const deferred = evaluateGroundingCriterion(CRITERION, figures, 5);

    expect(deferred.verdict).toBe('not-decided');
    expect(outcomesOf(deferred.criteria)).toEqual(
      outcomesOf(evaluateGroundingCriterion(CRITERION, figures, 0).criteria),
    );
  });
});

describe(PROPERTY_6, () => {
  it('agrees with an independent binomial summation, including at the smallest held b', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 60 }), (n) => {
        for (let b = 0; b <= n; b += 1) {
          expect(mcnemarUpperTailNumerator(b, n)).toBe(oracleTail(b, n));
        }
      }),
      { numRuns: 20 },
    );
  });

  it('holds at the smallest b that satisfies the level, and not one below it', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), (n) => {
        const level = 5n * 2n ** BigInt(n);
        let smallest = n + 1;
        for (let b = 0; b <= n; b += 1) {
          if (100n * oracleTail(b, n) <= level) {
            smallest = b;
            break;
          }
        }
        if (smallest > n) {
          return;
        }

        expect(100n * mcnemarUpperTailNumerator(smallest, n) <= level).toBe(true);
        if (smallest > 0) {
          expect(100n * mcnemarUpperTailNumerator(smallest - 1, n) <= level).toBe(false);
        }
      }),
      { numRuns: 40 },
    );
  });
});

describe(PROPERTY_7, () => {
  it('counts each group on its own records, with a tie counting as neither', () => {
    fc.assert(
      fc.property(arbPairs, (pairs) => {
        const figures: GroundingFigures = {
          pairs,
          control: { missedBug: 0, judged: 81, agreed: 81 },
          grounded: { missedBug: 0, judged: 136, agreed: 136 },
          controlMutants: { coverageGapSurvivors: 0, scoredMutants: 100 },
          groundedMutants: { coverageGapSurvivors: 0, scoredMutants: 100 },
        };
        const { criteria } = evaluateGroundingCriterion(CRITERION, figures, 0);

        // The oracle groups with a Map keyed differently from the implementation's, and a
        // group whose two arms tie is counted in neither direction.
        const tally = (keyOf: (pair: SlotPairOutcome) => string) => {
          const groups = new Map<string, SlotPairOutcome[]>();
          for (const pair of pairs) {
            groups.set(keyOf(pair), [...(groups.get(keyOf(pair)) ?? []), pair]);
          }
          let greater = 0;
          let lower = 0;
          for (const group of groups.values()) {
            const grounded = group.filter((pair) => pair.groundedValid).length;
            const control = group.filter((pair) => pair.controlValid).length;
            if (grounded > control) greater += 1;
            else if (grounded < control) lower += 1;
          }
          return { greater, lower, groups: groups.size };
        };
        const perModel = tally((pair) => pair.modelArm);
        const perDesign = tally((pair) => pair.problemId);

        expect(criteria.modelArmsGreater.observed).toBe(perModel.greater);
        expect(criteria.designsGreater.greater).toBe(perDesign.greater);
        expect(criteria.designsGreater.lower).toBe(perDesign.lower);
        // No group was pooled away: the declared counts are 4 Model_Arms and 19 designs.
        expect(perModel.groups).toBe(4);
        expect(perDesign.groups).toBe(19);
        expect(perModel.greater + perModel.lower).toBeLessThanOrEqual(4);
        expect(perDesign.greater + perDesign.lower).toBeLessThanOrEqual(19);
      }),
      { numRuns: 100 },
    );
  });

  it('counts a group as neither greater nor lower when the two arms tie exactly', () => {
    const tied = pairsFrom(
      Array.from({ length: EXPECTED_PAIRS }, () => 5),
      5,
      5,
    );
    const { criteria } = evaluateGroundingCriterion(
      CRITERION,
      {
        pairs: tied,
        control: { missedBug: 0, judged: 81, agreed: 81 },
        grounded: { missedBug: 0, judged: 136, agreed: 136 },
        controlMutants: { coverageGapSurvivors: 0, scoredMutants: 100 },
        groundedMutants: { coverageGapSurvivors: 0, scoredMutants: 100 },
      },
      0,
    );

    expect(criteria.modelArmsGreater.observed).toBe(0);
    expect(criteria.designsGreater.greater).toBe(0);
    expect(criteria.designsGreater.lower).toBe(0);
  });
});
