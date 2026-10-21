// timing-contract-inference, Property 12: The published population figures reconcile (task 1.4).
//
// WHAT THE ORACLE IS
//   `summarizeTimingPopulations` is total and pure, so this file restates the reconciliation
//   independently of the implementation: it re-partitions the same outcome list by hand
//   (exclusion dominant), then checks the six published figures against that partition rather
//   than against a remembered literal. The unit test beside the module pins the measured
//   figures; this file pins the arithmetic that relates them for ANY outcome set.
//
// THE BUG THIS EXISTS TO CATCH
//   Double subtraction. An earlier draft took `clkgenerator` off the scored cohort even though
//   `RTLLM_SCORED_DESIGN_COUNT` is already the universe minus the four Stage-0 entries, and
//   `clkgenerator` is one of them. So the decisive clause below is generated, not exampled:
//   excluding a design that is ALREADY outside the Scoring_Cohort - any Stage-0 id, or a
//   frontend-rejected id, which is subtracted unconditionally - must leave
//   `timingAwareScoringCohort` untouched.
//
// WHY THE ID POOL IS THE COMMITTED SETS
//   Free-form id strings would almost never land on a quarantined or frontend-rejected design,
//   so the membership arithmetic would go untested and every clause here would be vacuous. The
//   pool is therefore `STAGE0_QUARANTINED_PROBLEM_IDS` + `YOSYS_FRONTEND_REJECTED_PROBLEM_IDS`
//   + three ordinary Derivable_Scoring_Cohort ids, drawn WITH replacement so one design can be
//   reported twice, plus an optional constructed derived-plus-excluded pair so the
//   contradictory shape is reached on its own rather than by luck.
//
// Validates: Requirements 3.4, 3.5, 3.6

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  inDerivationPopulation,
  summarizeTimingPopulations,
  YOSYS_FRONTEND_REJECTED_PROBLEM_IDS,
  type DerivationExclusion,
  type DesignDerivationOutcome,
} from '../eval/corpus/timing-populations.js';
import { STAGE0_QUARANTINED_PROBLEM_IDS } from '../eval/corpus/stage0-quarantine.js';

import { propertyParameters } from './property.js';

// **Feature: timing-contract-inference, Property 12: The published population figures reconcile**
const PROPERTY =
  'timing-contract-inference, Property 12: The published population figures reconcile';

/** Ordinary ids: inside the Scoring_Cohort and the Derivation_Population, so fully derivable. */
const DERIVABLE_IDS: readonly string[] = [
  'rtllm/arithmetic/adder_8bit',
  'rtllm/control/fsm',
  'rtllm/miscellaneous/alu',
];

/**
 * The five id shapes a scenario can draw, as one pool: derivable, Stage-0 quarantined (outside
 * the Scoring_Cohort), and frontend-rejected (outside the Derivation_Population). Duplicates and
 * contradictory pairs come from how the pool is sampled, below.
 */
const ID_POOL: readonly string[] = [
  ...DERIVABLE_IDS,
  ...STAGE0_QUARANTINED_PROBLEM_IDS,
  ...YOSYS_FRONTEND_REJECTED_PROBLEM_IDS,
];

/** The designs already outside the Scoring_Cohort before this feature subtracts anything. */
const ALREADY_OUTSIDE_COHORT_IDS: readonly string[] = [
  ...STAGE0_QUARANTINED_PROBLEM_IDS,
  ...YOSYS_FRONTEND_REJECTED_PROBLEM_IDS,
];

/** The `<design>` segment of a `rtllm/<category>/<design>` id, restated so a rename there fails here. */
function designNameOf(problemId: string): string {
  return problemId.slice(problemId.lastIndexOf('/') + 1);
}

/**
 * One cause per design, a function of the id.
 *
 * Deliberately not independently generated: the module breaks a contradictory pair by keeping the
 * FIRST recorded cause, which is order dependent by construction, so drawing two different causes
 * for one design would falsify the order-independence clause for a reason that is not the bug
 * under test. Causes still differ BETWEEN designs, so a mispaired row is still caught.
 */
function causeFor(problemId: string): string {
  return `UNDRIVEN_OUTPUT: ${designNameOf(problemId)}_out`;
}

/** Non-blank free text, for the one place an arbitrary cause string must survive pass-through. */
const causeArbitrary: fc.Arbitrary<string> = fc
  .string({ maxLength: 40 })
  .map((text) => `DERIVATION_FAILED: ${text}`);

function outcomeFor(problemId: string, derived: boolean): DesignDerivationOutcome {
  return derived
    ? { problemId, outcome: 'derived' }
    : { problemId, outcome: 'excluded', cause: causeFor(problemId) };
}

/**
 * An outcome list over the real id pool: sampled with replacement, so a design can be reported
 * twice, and optionally carrying a constructed derived-plus-excluded pair for one design.
 */
const scenarioArbitrary: fc.Arbitrary<readonly DesignDerivationOutcome[]> = fc
  .record({
    draws: fc.array(fc.tuple(fc.constantFrom(...ID_POOL), fc.boolean()), { maxLength: 14 }),
    contradictory: fc.option(fc.constantFrom(...ID_POOL), { nil: null }),
  })
  .map(({ draws, contradictory }) => {
    const outcomes = draws.map(([problemId, derived]) => outcomeFor(problemId, derived));
    if (contradictory === null) return outcomes;
    return [...outcomes, outcomeFor(contradictory, true), outcomeFor(contradictory, false)];
  });

/** The same list in a drawn permutation; an empty list has only itself. */
const permutedScenarioArbitrary: fc.Arbitrary<{
  readonly outcomes: readonly DesignDerivationOutcome[];
  readonly permuted: readonly DesignDerivationOutcome[];
}> = scenarioArbitrary.chain((outcomes) =>
  (outcomes.length === 0
    ? fc.constant<readonly DesignDerivationOutcome[]>([])
    : fc.shuffledSubarray([...outcomes], {
        minLength: outcomes.length,
        maxLength: outcomes.length,
      })
  ).map((permuted) => ({ outcomes, permuted })),
);

/**
 * The hand-rolled oracle for the success count: the distinct ids reported derived and never
 * reported excluded. Exclusion dominant, so a design reported both ways is not a derivation.
 */
function derivedIdsByHand(outcomes: readonly DesignDerivationOutcome[]): readonly string[] {
  const excludedIds = new Set(
    outcomes.filter((o) => o.outcome === 'excluded').map((o) => o.problemId),
  );
  return [
    ...new Set(outcomes.filter((o) => o.outcome === 'derived').map((o) => o.problemId)),
  ].filter((problemId) => !excludedIds.has(problemId));
}

/** Exclusion rows in a canonical order, so two summaries can be compared as sets of rows. */
function sortedRows(rows: readonly DerivationExclusion[]): readonly DerivationExclusion[] {
  return [...rows].sort(
    (a, b) => a.design.localeCompare(b.design) || a.cause.localeCompare(b.cause),
  );
}

describe(PROPERTY, () => {
  it('reconciles classified plus excluded against the population, with every exclusion caused and counted once', () => {
    fc.assert(
      fc.property(scenarioArbitrary, (outcomes) => {
        const summary = summarizeTimingPopulations(outcomes);
        const derivedNames = derivedIdsByHand(outcomes)
          .filter(inDerivationPopulation)
          .map(designNameOf);
        const excludedNames = summary.derivationExclusions.map((row) => row.design);

        // Req 3.4: the classified and the excluded together never overrun the population they
        // are over, and the success count is exactly the designs that derived inside it.
        expect(summary.derivedContracts + summary.derivationExclusions.length).toBeLessThanOrEqual(
          summary.derivationPopulation,
        );
        expect(summary.derivedContracts).toBe(derivedNames.length);

        // No design is in both a classification count and an exclusion count, and none is
        // excluded twice - the shape that let a denominator be subtracted from twice.
        expect(excludedNames.filter((name) => derivedNames.includes(name))).toEqual([]);
        expect(new Set(excludedNames).size).toBe(excludedNames.length);

        // Req 3.5: every excluded design carries its own recorded cause, never blank and never
        // another design's.
        const reportedExclusions = outcomes.filter((o) => o.outcome === 'excluded');
        for (const row of summary.derivationExclusions) {
          expect(row.cause.trim()).not.toBe('');
          expect(row.cause).toBe(
            reportedExclusions.find((o) => designNameOf(o.problemId) === row.design)?.cause,
          );
        }

        // Req 3.6: the timing-aware cohort is a subset of the cohort it narrows, never negative.
        expect(summary.timingAwareScoringCohort).toBeLessThanOrEqual(summary.scoringCohort);
        expect(summary.timingAwareScoringCohort).toBeGreaterThanOrEqual(0);
      }),
      propertyParameters(),
    );
  });

  it('leaves the timing-aware cohort unchanged when a design already outside it is excluded', () => {
    fc.assert(
      fc.property(
        scenarioArbitrary,
        fc.constantFrom(...ALREADY_OUTSIDE_COHORT_IDS),
        causeArbitrary,
        (outcomes, problemId, cause) => {
          const before = summarizeTimingPopulations(outcomes);
          const after = summarizeTimingPopulations([
            ...outcomes,
            { problemId, outcome: 'excluded', cause },
          ]);

          // The anti-double-subtraction invariant: a Stage-0 id is not in the cohort to begin
          // with, and a frontend-rejected id is already subtracted, so neither moves the figure.
          expect(after.timingAwareScoringCohort).toBe(before.timingAwareScoringCohort);
          expect(after.scoringCohort).toBe(before.scoringCohort);
          expect(after.derivationPopulation).toBe(before.derivationPopulation);
        },
      ),
      propertyParameters(),
    );
  });

  it('publishes the same figures however the outcomes are ordered', () => {
    fc.assert(
      fc.property(permutedScenarioArbitrary, ({ outcomes, permuted }) => {
        const summary = summarizeTimingPopulations(outcomes);
        const reordered = summarizeTimingPopulations(permuted);

        // Row ORDER follows the input, which is fine; the row SET may not.
        expect({
          ...reordered,
          derivationExclusions: sortedRows(reordered.derivationExclusions),
        }).toEqual({
          ...summary,
          derivationExclusions: sortedRows(summary.derivationExclusions),
        });
      }),
      propertyParameters(),
    );
  });
});
