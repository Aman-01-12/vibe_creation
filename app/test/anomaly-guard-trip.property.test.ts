// formal-gate-first-light, Property 11: the Anomaly_Guard trips exactly above each of its two
// arms, and the breach it returns says why (tasks 11.6, 11.20). The generated form of the example
// cases in `app/eval/property-only/cli.test.ts`; see design.md, Component C7.
//
// WHAT IS CLAIMED, OVER WHAT
//   1. NEITHER ARM IS RESTATED HERE, AND THE TWO COME FROM DIFFERENT PLACES. The token arm is
//      the declared `anomaly-guard` limit's value times the Per_Design_Extrapolation, taken
//      through `perDesignExtrapolationOf` over a generated Cost_Pilot record. That function
//      takes the MAXIMUM of the per-design figures and never the mean, because the guard must
//      not trip on plausible variation between designs, so each draw checks the maximum against
//      an independent one and records whether the mean would have been a different number. The
//      wall-clock arm is the declared `shipped-property-time-budget` and is NOT a multiple of
//      anything (Req 5.20), so each draw also checks that a figure one past the pilot's own
//      multiple does not trip wherever that multiple sits below the budget. That assertion is
//      the whole of FL-26: two paid pilots put the old arm at 82270 ms and then 52740 ms, and
//      task 4.5 measured a design legitimately taking 149997 ms under the same budget.
//      THE WALL-CLOCK ARM IS READ AGAINST A PROOF_SPAN AND NEVER A DESIGN_TOTAL, which is
//      FL-27: the declared budget bounds the proof alone, so reading a design total against it
//      refused every design whose proof legitimately reached the budget, by however long that
//      design's authoring took. `DesignFigures` carries no Design_Total at all, so each draw
//      also checks that a design with no Proof_Span does not trip, an absence being a figure
//      the arm has nothing to compare rather than a zero (Req 5.20, 5.23).
//   2. EXACTLY ABOVE, ON EACH ARM SEPARATELY. Each figure is generated at five positions around
//      ITS OWN arm: well below it, one short of it, the arm itself, one past it, and well past
//      it, with the sibling figure held AT its own arm so the boundary under test is isolated
//      rather than masked. The `at` and `just-below` positions are what make the claim
//      falsifiable, since an arm written `>=` rather than `>` passes any test that only ever
//      generates far-above figures.
//   3. IT SAYS WHY, AND NAMES WHICH DECLARED LIMIT THE ARM CAME FROM. A breach names which
//      figure tripped, the measured value, the arm, and the declared Measurement_Limit that arm
//      was taken from with its Limit_Reason: `anomaly-guard` and `anomaly-detection` for tokens,
//      `shipped-property-time-budget` and `population-honesty` for wall clock. That is what the
//      stop statement is rendered from (Req 5.9, 12.5, 12.10).
//
// WHAT THIS FILE CANNOT REACH
//   The rendered stop text itself. `runReportLines` is private to `app/eval/property-only/cli.ts`
//   and reachable only through a full paid run, so this property pins the breach that every
//   field of that statement is read from, and the rendered report stays with Property 28.
//
// The tag is a literal because `propertyTag` hardcodes another spec's slug.
//
// **Validates: Requirements 5.8, 5.9, 5.20, 5.21, 12.5, 12.10**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  anomalyBreachOf,
  LIMIT_REASONS,
  limitOrRefuse,
  perDesignExtrapolationOf,
  PROPERTY_ONLY_MEASUREMENT_KIND,
  PROPERTY_ONLY_SCHEMA_VERSION,
  type AnomalyBreach,
  type DesignFigures,
  type ManifestToolchain,
  type MeasurementLimit,
  type PerDesignExtrapolation,
  type PropertyOnlyDesignResult,
  type PropertyOnlyMeasurement,
} from '@app/eval';

import { propertyParameters } from './property.js';

// Feature: formal-gate-first-light, Property 11: The Anomaly_Guard trips exactly above each of its two arms and says why
const PROPERTY =
  'formal-gate-first-light, Property 11: The Anomaly_Guard trips exactly above each of its two arms and says why';

/** The limit under `name`, failing the test rather than the property where it is undeclared. */
function declared(name: string): MeasurementLimit {
  const result = limitOrRefuse(name);
  if (!result.ok) {
    throw new Error(`the limit "${name}" is not declared: ${result.error.message}`);
  }
  return result.value;
}

/** The multiple the token arm is set at, read from the registry so nothing here restates it. */
const ANOMALY_GUARD = declared('anomaly-guard');

/** The wall-clock arm itself, which is this declared budget and not a multiple of it (Req 5.20). */
const PROPERTY_TIME_BUDGET = declared('shipped-property-time-budget');

/** The Cost_Pilot's own bound, which is how many designs an extrapolation is taken over. */
const COST_PILOT_DESIGNS = declared('cost-pilot-design-count');

// ---------------------------------------------------------------------------
// The generated Cost_Pilot record
// ---------------------------------------------------------------------------

/** One design's measured figures, which are the only fields the extrapolation reads. */
interface DesignSeed {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly elapsedMs: number;
}

/**
 * The toolchain every generated design carries.
 *
 * Fixed, with every other field below the figures: no function in this property reads a
 * toolchain, a population, a verdict, or a recorded limit, so varying them could not expose a
 * guard that reads the wrong figure. They belong to Property 26 and Property 15.
 */
const TOOLCHAIN: ManifestToolchain = {
  iverilogVersion: null,
  vvpVersion: null,
  workerPython: null,
  yosysVersion: { kind: 'not-measured', reason: 'fixture' },
  yosysBuildId: { kind: 'not-measured', reason: 'fixture' },
  yosysSmtBmcVersion: { kind: 'not-measured', reason: 'fixture' },
  bitwuzlaVersion: { kind: 'not-measured', reason: 'fixture' },
  z3Version: { kind: 'not-measured', reason: 'fixture' },
};

/** The token figure the guard reads off one design, which is both halves of its spend. */
function tokensOf(seed: DesignSeed): number {
  return seed.promptTokens + seed.completionTokens;
}

function designOf(seed: DesignSeed, index: number): PropertyOnlyDesignResult {
  return {
    designId: `rtllm/pilot/design-${String(index)}`,
    authoringModel: 'zai.glm-5',
    population: 'admitted',
    prepassRefusalCause: null,
    properties: [],
    unexpressedCriteria: [],
    promptTokens: seed.promptTokens,
    completionTokens: seed.completionTokens,
    elapsedMs: seed.elapsedMs,
    proofSpanMs: seed.elapsedMs,
    toolchain: TOOLCHAIN,
    formalOracleVersion: 1,
  };
}

function measurementOf(seeds: readonly DesignSeed[]): PropertyOnlyMeasurement {
  return {
    schemaVersion: PROPERTY_ONLY_SCHEMA_VERSION,
    runName: 'property-only-cost-pilot',
    measurementKind: PROPERTY_ONLY_MEASUREMENT_KIND,
    omittedStudentPathSteps: ['testbench-generation', 'instrument-admission'],
    results: seeds.map(designOf),
    limits: [COST_PILOT_DESIGNS],
  };
}

/**
 * Both figures strictly positive, so an arm taken from them has a boundary below it.
 *
 * The wall clock is drawn from two bands on purpose. The low band is the regime where the
 * pilot's own multiple lands BELOW the declared budget, which is the only regime in which a
 * reverted pilot-derived arm would differ from the budget and so be caught.
 */
const designSeed = fc.record<DesignSeed>({
  promptTokens: fc.integer({ min: 1, max: 20_000 }),
  completionTokens: fc.integer({ min: 0, max: 20_000 }),
  elapsedMs: fc.oneof(
    fc.integer({ min: 1, max: Math.floor(PROPERTY_TIME_BUDGET.value / ANOMALY_GUARD.value) - 1 }),
    fc.integer({ min: 1, max: 600_000 }),
  ),
});

/** A Cost_Pilot of at most its declared design count, which is where an extrapolation comes from. */
const costPilotSeeds = fc.array(designSeed, { minLength: 1, maxLength: COST_PILOT_DESIGNS.value });

// ---------------------------------------------------------------------------
// The positions around an arm
// ---------------------------------------------------------------------------

const POSITIONS = ['far-below', 'just-below', 'at', 'just-above', 'far-above'] as const;

type Position = (typeof POSITIONS)[number];

/** Which positions must trip. `at` is the one an off-by-one arm gets wrong. */
const TRIPS: Readonly<Record<Position, boolean>> = {
  'far-below': false,
  'just-below': false,
  at: false,
  'just-above': true,
  'far-above': true,
};

/**
 * Each position's figure, as an offset from the arm rather than from the multiple.
 *
 * `Math.max` keeps every arm total for an arm of zero, which no generated draw produces but
 * which an arm written against a positive threshold would read as a different position.
 */
const FIGURE_AT: Readonly<Record<Position, (arm: number, spread: number) => number>> = {
  'far-below': (arm, spread) => Math.max(0, arm - 1 - (spread % Math.max(1, arm))),
  'just-below': (arm) => Math.max(0, arm - 1),
  at: (arm) => arm,
  'just-above': (arm) => arm + 1,
  'far-above': (arm, spread) => arm + 1 + spread,
};

/** What a breach on one arm must say: which figure, against what, under which declared limit. */
interface ArmExpectation {
  readonly figure: AnomalyBreach['figure'];
  readonly arm: number;
  readonly limit: MeasurementLimit;
}

// ---------------------------------------------------------------------------
// The assertions
// ---------------------------------------------------------------------------

/** The function under test, with both declared limits supplied the way a run supplies them. */
function breachOf(
  figures: DesignFigures,
  extrapolation: PerDesignExtrapolation,
): AnomalyBreach | null {
  return anomalyBreachOf(figures, extrapolation, ANOMALY_GUARD, PROPERTY_TIME_BUDGET);
}

/** Asserts no breach, which is the claim for every position at or below an arm. */
function assertNoTrip(
  label: string,
  figures: DesignFigures,
  extrapolation: PerDesignExtrapolation,
): void {
  expect(breachOf(figures, extrapolation), label).toBeNull();
}

/** Asserts a breach, and that it says why: which figure, against what, under which limit. */
function assertTrips(
  label: string,
  figures: DesignFigures,
  extrapolation: PerDesignExtrapolation,
  expected: ArmExpectation,
): void {
  const breach = breachOf(figures, extrapolation);
  if (breach === null) {
    throw new Error(`expected ${label} to trip the Anomaly_Guard, but nothing was reported`);
  }
  expect(breach.figure, label).toBe(expected.figure);
  expect(breach.measured, label).toBe(figures[expected.figure]);
  expect(breach.guard, label).toBe(expected.arm);
  // The limit the report names beside the measured figure, with exactly one reason (Req 12.5,
  // 12.10). Which limit depends on the arm: the two no longer come from one place.
  expect(breach.limit, label).toEqual(expected.limit);
  expect(
    LIMIT_REASONS.filter((reason) => reason === breach.limit.reason),
    label,
  ).toHaveLength(1);
}

/** One position, asserted in whichever direction `TRIPS` says it falls. */
function assertPosition(
  label: string,
  position: Position,
  figures: DesignFigures,
  extrapolation: PerDesignExtrapolation,
  expected: ArmExpectation,
): void {
  if (TRIPS[position]) {
    assertTrips(label, figures, extrapolation, expected);
    return;
  }
  assertNoTrip(label, figures, extrapolation);
}

/**
 * Rows the run must have reached, or the assertions above checked less than they read as.
 *
 * The two mean rows are what make the maximum assertion falsifiable: on those draws the mean is
 * a different number, so an extrapolation taken from the mean would have failed there. The
 * `arm:pilot-multiple-below-budget` row is what makes the FL-26 move falsifiable: only on those
 * draws does a reverted pilot-derived wall-clock arm sit below the budget and so trip.
 */
const REQUIRED_ROWS: readonly string[] = [
  'pilot:several-designs',
  'extrapolation:mean-below-max-tokens',
  'extrapolation:mean-below-max-elapsed',
  'spread:far-below-strict',
  'spread:far-above-strict',
  'arm:pilot-multiple-below-budget',
];

// ---------------------------------------------------------------------------
// Property 11
// ---------------------------------------------------------------------------

describe(PROPERTY, () => {
  it('given any Cost_Pilot record, when a design is measured around each arm, then the guard trips exactly above that arm and the breach says which declared limit it came from', () => {
    const seen = new Set<string>();

    // The pairing the per-draw assertions below read as, pinned once and not derived from the
    // breach, so a breach carrying the other arm's limit cannot satisfy them (Req 12.10).
    expect(ANOMALY_GUARD.reason).toBe('anomaly-detection');
    expect(PROPERTY_TIME_BUDGET.reason).toBe('population-honesty');

    fc.assert(
      fc.property(costPilotSeeds, fc.nat({ max: 1_000_000 }), (seeds, spread) => {
        const extrapolation = perDesignExtrapolationOf(measurementOf(seeds));
        if (extrapolation === null) {
          throw new Error('a Cost_Pilot that measured a design records an extrapolation');
        }

        // The maximum, taken independently of the function under test. Both figures are still
        // recorded, because the elapsed one is the pilot's provenance (Req 5.7).
        const maxTokens = Math.max(...seeds.map(tokensOf));
        const maxElapsed = Math.max(...seeds.map((seed) => seed.elapsedMs));
        expect(extrapolation).toEqual({ tokens: maxTokens, elapsedMs: maxElapsed });

        const meanTokens = seeds.reduce((total, seed) => total + tokensOf(seed), 0) / seeds.length;
        const meanElapsed = seeds.reduce((total, seed) => total + seed.elapsedMs, 0) / seeds.length;
        if (seeds.length > 1) {
          seen.add('pilot:several-designs');
        }
        if (meanTokens < maxTokens) {
          seen.add('extrapolation:mean-below-max-tokens');
        }
        if (meanElapsed < maxElapsed) {
          seen.add('extrapolation:mean-below-max-elapsed');
        }

        const tokenArm = maxTokens * ANOMALY_GUARD.value;
        const proofArm = PROPERTY_TIME_BUDGET.value;
        const tokenExpectation: ArmExpectation = {
          figure: 'tokens',
          arm: tokenArm,
          limit: ANOMALY_GUARD,
        };
        const proofExpectation: ArmExpectation = {
          figure: 'proofSpanMs',
          arm: proofArm,
          limit: PROPERTY_TIME_BUDGET,
        };

        for (const position of POSITIONS) {
          const tokens = FIGURE_AT[position](tokenArm, spread);
          const proofSpanMs = FIGURE_AT[position](proofArm, spread);

          // Tokens moved alone, with the wall clock sitting AT its own arm: a figure at an arm
          // must not trip, so this isolates the token boundary rather than masking it.
          assertPosition(
            `tokens ${position}`,
            position,
            { tokens, proofSpanMs: proofArm },
            extrapolation,
            tokenExpectation,
          );

          // The wall clock moved alone, which also pins tokens as the figure checked first:
          // were the order reversed, the token figure at its arm would be reported instead.
          assertPosition(
            `proofSpanMs ${position}`,
            position,
            { tokens: tokenArm, proofSpanMs },
            extrapolation,
            proofExpectation,
          );

          if (TRIPS[position]) {
            // Both figures past their arms: the token figure is the one named, because it is
            // the one that names the cause (Req 5.8).
            assertTrips(
              `both ${position}`,
              { tokens, proofSpanMs },
              extrapolation,
              tokenExpectation,
            );
          }
        }

        // FL-26, made falsifiable: where the pilot's own multiple of the elapsed extrapolation
        // lands below the budget, a figure one past THAT number must not trip, because the arm
        // is the declared budget and is not derived from the pilot at all (Req 5.20).
        const pilotMultiple = maxElapsed * ANOMALY_GUARD.value;
        if (pilotMultiple < proofArm) {
          seen.add('arm:pilot-multiple-below-budget');
          assertNoTrip(
            'proofSpanMs one past the pilot-derived arm the budget replaced',
            { tokens: tokenArm, proofSpanMs: pilotMultiple + 1 },
            extrapolation,
          );
        }

        // FL-27, made falsifiable: a design that reached no proof has no Proof_Span, and the arm
        // has nothing to compare, so it must not trip however large its token figure is.
        assertNoTrip(
          'a design with no Proof_Span at all',
          { tokens: tokenArm, proofSpanMs: null },
          extrapolation,
        );

        if (FIGURE_AT['far-below'](tokenArm, spread) < tokenArm - 1) {
          seen.add('spread:far-below-strict');
        }
        if (FIGURE_AT['far-above'](tokenArm, spread) > tokenArm + 1) {
          seen.add('spread:far-above-strict');
        }
      }),
      propertyParameters(),
    );

    for (const row of REQUIRED_ROWS) {
      expect(seen.has(row), `no draw reached ${row}`).toBe(true);
    }
  });
});
