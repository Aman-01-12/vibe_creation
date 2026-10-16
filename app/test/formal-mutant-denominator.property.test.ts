// formal-property-oracle, Property 22: An unscorable mutant is counted and excluded from the
// denominator (task 10.4).
//
// WHAT IS CLAIMED, OVER WHAT
//   Over every population `arbCalibratedMutantPopulation()` generates - empty, wholly unscorable,
//   wholly scorable, and mixed, with the independent judge's verdict drawn apart from the formal
//   one - the formal reporter, which is `formalMutationCounts` together with `formalKillRateOf`
//   over the counts it returned, satisfies five clauses:
//
//     1. PARTITION. Killed + survived + could-not-verify = total = the population's size, and each
//        bucket holds exactly the mutants of its own calibration (Req 9.2, 9.4).
//     2. DENOMINATOR. It equals the count of members whose calibration admits them under
//        `FORMAL_CALIBRATION_ADMITS_TO_DENOMINATOR`, and it equals killed + survived (Req 9.3, 9.6).
//     3. PER MUTANT. Removing any one mutant moves exactly the counts of its own calibration, so no
//        mutant sits in two buckets - and a `formal-could-not-verify` mutant moves the total and its
//        own count and NOTHING else: in the total, outside the denominator, neither killed nor
//        survived (Req 9.2, 9.3, 9.4). Leave-one-out, because the reporter returns aggregates only,
//        so "this mutant was reported as neither" is observable only as what that mutant changes.
//     4. CAUSE. Every `formal-could-not-verify` mutant still carries its own Could_Not_Verify_Cause
//        after it was reported, a member of the closed vocabulary, and reporting rewrote no mutant's
//        calibration (Req 9.2, 9.5).
//     5. RATE. The kill rate is over the formal denominator - killed / denominator where that is
//        non-zero - and is no number at all where it is zero (Req 9.6).
//
// THE ORACLE IS AN INDEPENDENT TALLY
//   Every expected count is summed straight off the population from `CONTRIBUTION_OF`, this file's
//   own statement of what one mutant of each calibration contributes, and every expectation is fixed
//   from a snapshot taken BEFORE the reporter runs, so a reporter that rewrote a mutant in place
//   could not drag the expectation along with its answer. No production counting helper builds an
//   expectation - `formalMutationCounts` and `formalKillRateOf` appear only inside the reporter
//   under test - so the test cannot agree with itself. Clause 2 alone reads production's
//   `FORMAL_CALIBRATION_ADMITS_TO_DENOMINATOR`, because its claim is ABOUT that mapping; clause 1's
//   independent table is what catches the mapping itself admitting the wrong member.
//
// THE ZERO DENOMINATOR, AND WHAT REQUIREMENT 9 DOES AND DOES NOT SAY ABOUT IT
//   Requirement 9 states no rate VALUE for an empty denominator. What it does require there is
//   asserted: the mutants are still counted (9.4), none is killed or survived (9.2), the denominator
//   is reported as zero (9.3), and the rate is over that denominator (9.6) - so no number may stand
//   as the rate, since a 0 would read the excluded mutants as survived and a 1 as killed, the two
//   fictions the requirement's user story names. The reporter returns `null` there. That value is
//   task 10.1's choice, mirroring the simulation gate's `killRateOf`, and it is pinned by
//   `app/eval/property-set-admission.test.ts`; this property does not pin it, because no criterion
//   states it.
//
// RUN COUNT: 1000, not the shared 100
//   The rarest required shape is a NON-EMPTY population holding only `formal-could-not-verify`
//   mutants - the empty denominator with mutants in it. Measured over 20,000 draws of
//   `arbCalibratedMutantPopulation()` it was 1,021 of them, about 5.1%, so at 100 runs the chance of
//   drawing none is about 0.5%, a flake rather than a claim; at 1000 it is about 1e-23. Every other
//   row is far commoner: the empty population 9.5%, all three calibrations at once 49%, a formal
//   denominator differing from the simulation one 65%, and about 1.6 unscorable mutants per
//   population for the cause pair. The cause rows are two NAMED members of a closed vocabulary
//   rather than every member, so they are sampled rather than exhausted, at a miss chance below
//   1e-60 each. Sized to the rarest shape, never by weakening a clause to fit 100
//   (`chipAgent/_inbox/verification-recipe-every-row-coverage-needs-numruns-scaled-to-the-table.md`).
//
// WHAT THIS FILE DOES NOT COVER
//   Req 9.4's Sweep_Summary RENDERING of the excluded count is Property 28's. The closed vocabulary
//   and the mapping's totality (Req 9.1, 9.7) are task 10.6's unit tests.
//
// The tag string is a literal, not `propertyTag(...)`, whose `FEATURE_TAG` is hardcoded to a
// different spec's property numbering
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// **Validates: Requirements 9.2, 9.3, 9.4, 9.5, 9.6**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  formalKillRateOf,
  formalMutationCounts,
  mutantIsValid,
  FORMAL_CALIBRATION_ADMITS_TO_DENOMINATOR,
  type CalibratedFormalMutant,
  type FormalMutantCalibration,
  type FormalMutationCounts,
} from '@app/eval';
import { COULD_NOT_VERIFY_CAUSES, type CouldNotVerifyCause } from '@app/tools';

import { arbCalibratedMutantPopulation } from './formal-arbitraries.js';
import { propertyParameters } from './property.js';

// **Feature: formal-property-oracle, Property 22: An unscorable mutant is counted and excluded from
// the denominator**
const PROPERTY =
  'formal-property-oracle, Property 22: An unscorable mutant is counted and excluded from the denominator';

/** See the RUN COUNT note: the rarest required shape is ~5.1% of draws. */
const NUM_RUNS = 1000;

/** What a reporter states about one population: its counts, and the kill rate over them. */
interface FormalDenominatorReport {
  readonly counts: FormalMutationCounts;
  readonly killRate: number | null;
}

/**
 * A reporter under test.
 *
 * A PARAMETER of the assertions rather than a call inside them, so a deliberately wrong reporter
 * can be handed to the very same clauses to show they fail - without editing the shared module,
 * which a killed tool call would leave mutated in the build every concurrent agent reads
 * (`chipAgent/_inbox/gotcha-a-scratch-script-exit-trap-does-not-run-when-the-agent-tool-kills-the-shell.md`).
 */
type FormalDenominatorReporter = (
  population: readonly CalibratedFormalMutant[],
) => FormalDenominatorReport;

/** The production reporter: the module's own counts, and its own rate over exactly those counts. */
const PRODUCTION_REPORTER: FormalDenominatorReporter = (population) => {
  const counts = formalMutationCounts(population);
  return { counts, killRate: formalKillRateOf(counts) };
};

/** The one calibration that leaves the denominator. `satisfies`, so a rename breaks here. */
const UNSCORABLE = 'formal-could-not-verify' satisfies FormalMutantCalibration;

/** Nothing counted: the identity the independent tally starts from. */
const NOTHING_COUNTED: FormalMutationCounts = Object.freeze({
  totalCount: 0,
  denominator: 0,
  killedCount: 0,
  survivedCount: 0,
  couldNotVerifyCount: 0,
});

/**
 * Req 9.2, 9.3, and 9.4 for ONE unscorable mutant, as a value: in the total and in its own count,
 * OUT of the denominator, and neither killed nor survived.
 */
const COUNTED_AND_EXCLUDED: FormalMutationCounts = Object.freeze({
  totalCount: 1,
  denominator: 0,
  killedCount: 0,
  survivedCount: 0,
  couldNotVerifyCount: 1,
});

/**
 * What ONE mutant of each calibration contributes to every reported count: this file's own
 * statement of the rule, and the oracle every expectation below is summed from.
 *
 * Written out rather than read from production, so the test cannot agree with itself. A total
 * `Record`, so a fourth calibration is a compile error here rather than a mutant that silently
 * contributes nothing.
 */
const CONTRIBUTION_OF: Readonly<Record<FormalMutantCalibration, FormalMutationCounts>> =
  Object.freeze({
    'formal-refuted': Object.freeze({
      totalCount: 1,
      denominator: 1,
      killedCount: 1,
      survivedCount: 0,
      couldNotVerifyCount: 0,
    }),
    'formal-proved': Object.freeze({
      totalCount: 1,
      denominator: 1,
      killedCount: 0,
      survivedCount: 1,
      couldNotVerifyCount: 0,
    }),
    'formal-could-not-verify': COUNTED_AND_EXCLUDED,
  });

/** Field-wise sum of two tallies. */
function plus(left: FormalMutationCounts, right: FormalMutationCounts): FormalMutationCounts {
  return {
    totalCount: left.totalCount + right.totalCount,
    denominator: left.denominator + right.denominator,
    killedCount: left.killedCount + right.killedCount,
    survivedCount: left.survivedCount + right.survivedCount,
    couldNotVerifyCount: left.couldNotVerifyCount + right.couldNotVerifyCount,
  };
}

/** Field-wise difference of two tallies: what the mutants in `left` but not `right` contributed. */
function minus(left: FormalMutationCounts, right: FormalMutationCounts): FormalMutationCounts {
  return {
    totalCount: left.totalCount - right.totalCount,
    denominator: left.denominator - right.denominator,
    killedCount: left.killedCount - right.killedCount,
    survivedCount: left.survivedCount - right.survivedCount,
    couldNotVerifyCount: left.couldNotVerifyCount - right.couldNotVerifyCount,
  };
}

/** One mutant's calibration and cause as generated, read through the discriminant. */
interface CalibrationAndCause {
  readonly formal: FormalMutantCalibration;
  /** The Could_Not_Verify_Cause on the unscorable arm; `null` on a scorable one, which has none. */
  readonly cause: CouldNotVerifyCause | null;
}

function calibrationAndCauseOf(mutant: CalibratedFormalMutant): CalibrationAndCause {
  return { formal: mutant.formal, cause: mutant.formal === UNSCORABLE ? mutant.cause : null };
}

/** The independent tally: every mutant's contribution, summed by its own calibration. */
function independentTallyOf(generated: readonly CalibrationAndCause[]): FormalMutationCounts {
  return generated.reduce(
    (tally, entry) => plus(tally, CONTRIBUTION_OF[entry.formal]),
    NOTHING_COUNTED,
  );
}

/** Whether a reported kill rate is a number a reader would take as a rate. */
function isAReportedRate(killRate: number | null): boolean {
  return killRate !== null && Number.isFinite(killRate);
}

/** Clause 1: the counts partition the population, bucket by calibration (Req 9.2, 9.4). */
function assertPartition(
  counts: FormalMutationCounts,
  expected: FormalMutationCounts,
  populationSize: number,
): void {
  expect(counts).toEqual(expected);
  expect(counts.totalCount).toBe(populationSize);
  expect(counts.killedCount + counts.survivedCount + counts.couldNotVerifyCount).toBe(
    counts.totalCount,
  );
}

/** Clause 2: the denominator is the admitting subset and nothing else (Req 9.3, 9.6). */
function assertDenominator(
  counts: FormalMutationCounts,
  generated: readonly CalibrationAndCause[],
): void {
  const admitted = generated.filter(
    (entry) => FORMAL_CALIBRATION_ADMITS_TO_DENOMINATOR[entry.formal],
  );
  expect(counts.denominator).toBe(admitted.length);
  expect(counts.denominator).toBe(counts.killedCount + counts.survivedCount);
}

/**
 * Clause 3: removing any one mutant moves exactly its own calibration's counts (Req 9.2, 9.3, 9.4).
 *
 * For a `formal-could-not-verify` mutant the expected move is `COUNTED_AND_EXCLUDED`, which is the
 * per-mutant claim itself. Every mutant is checked, not only the unscorable ones, because "no
 * mutant in two buckets" is a claim about all of them.
 */
function assertEachMutantContribution(
  reporter: FormalDenominatorReporter,
  population: readonly CalibratedFormalMutant[],
  counts: FormalMutationCounts,
  generated: readonly CalibrationAndCause[],
): void {
  generated.forEach((entry, index) => {
    const withoutIt = reporter(population.filter((_, at) => at !== index)).counts;
    expect(minus(counts, withoutIt)).toEqual(CONTRIBUTION_OF[entry.formal]);
  });
}

/** Clause 4: reporting rewrote no calibration and stripped no cause (Req 9.2, 9.5). */
function assertCausesCarried(
  population: readonly CalibratedFormalMutant[],
  generated: readonly CalibrationAndCause[],
): void {
  expect(population.map(calibrationAndCauseOf)).toEqual(generated);
  for (const mutant of population) {
    if (mutant.formal === UNSCORABLE) {
      expect(COULD_NOT_VERIFY_CAUSES).toContain(mutant.cause);
    }
  }
}

/** Clause 5: the rate is over the FORMAL denominator, and is no number where it is zero (Req 9.6). */
function assertRate(killRate: number | null, expected: FormalMutationCounts): void {
  if (expected.denominator === 0) {
    expect(isAReportedRate(killRate)).toBe(false);
    return;
  }
  expect(killRate).toBe(expected.killedCount / expected.denominator);
}

/**
 * Every clause of Property 22 for one population, against whichever reporter it is handed.
 *
 * The snapshot is taken BEFORE the first reporter call and every expectation is computed from it,
 * so a reporter that rewrote or stripped a mutant in place cannot move the expectation with it.
 */
function assertFormalDenominatorArithmetic(
  reporter: FormalDenominatorReporter,
  population: readonly CalibratedFormalMutant[],
): void {
  const generated = population.map(calibrationAndCauseOf);
  const expected = independentTallyOf(generated);
  const report = reporter(population);
  assertPartition(report.counts, expected, generated.length);
  assertDenominator(report.counts, generated);
  assertEachMutantContribution(reporter, population, report.counts, generated);
  assertCausesCarried(population, generated);
  assertRate(report.killRate, expected);
}

/** What the run drew, so every clause above is shown to have met the case it is about. */
interface DrawnShapes {
  runs: number;
  readonly populationsHolding: Record<FormalMutantCalibration, number>;
  holdingAllThree: number;
  holdingOnlyUnscorable: number;
  empty: number;
  denominatorsDiverged: number;
  readonly causes: Set<CouldNotVerifyCause>;
}

function noShapesDrawn(): DrawnShapes {
  return {
    runs: 0,
    populationsHolding: { 'formal-refuted': 0, 'formal-proved': 0, 'formal-could-not-verify': 0 },
    holdingAllThree: 0,
    holdingOnlyUnscorable: 0,
    empty: 0,
    denominatorsDiverged: 0,
    causes: new Set(),
  };
}

/**
 * Record one population's shape. A NON-VACUITY COUNTER and never part of an expectation, which is
 * why it may call the simulation gate's own `mutantIsValid`: the question is only whether the
 * Negative_Control would have scored this population over a different number of mutants.
 */
function recordShape(drawn: DrawnShapes, population: readonly CalibratedFormalMutant[]): void {
  drawn.runs += 1;
  const generated = population.map(calibrationAndCauseOf);
  const tally = independentTallyOf(generated);
  const held: readonly (readonly [FormalMutantCalibration, number])[] = [
    ['formal-refuted', tally.killedCount],
    ['formal-proved', tally.survivedCount],
    ['formal-could-not-verify', tally.couldNotVerifyCount],
  ];
  for (const [calibration, count] of held) {
    drawn.populationsHolding[calibration] += count > 0 ? 1 : 0;
  }
  drawn.holdingAllThree += held.every(([, count]) => count > 0) ? 1 : 0;
  drawn.holdingOnlyUnscorable +=
    population.length > 0 && tally.couldNotVerifyCount === population.length ? 1 : 0;
  drawn.empty += population.length === 0 ? 1 : 0;
  const simulationDenominator = population.filter((mutant) => mutantIsValid(mutant.golden)).length;
  drawn.denominatorsDiverged += simulationDenominator === tally.denominator ? 0 : 1;
  for (const entry of generated) {
    if (entry.cause !== null) {
      drawn.causes.add(entry.cause);
    }
  }
}

describe(PROPERTY, () => {
  it('counts every unscorable mutant, excludes it from the denominator, and partitions the rest', () => {
    const drawn = noShapesDrawn();
    fc.assert(
      fc.property(arbCalibratedMutantPopulation(), (population) => {
        recordShape(drawn, population);
        assertFormalDenominatorArithmetic(PRODUCTION_REPORTER, population);
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );
    // Non-vacuity: each clause met the case it is about
    // (`chipAgent/_inbox/gotcha-golden-denominator-property-test-was-vacuous-for-new-status.md`).
    expect(drawn.runs).toBe(NUM_RUNS);
    expect(drawn.populationsHolding['formal-refuted']).toBeGreaterThan(0);
    expect(drawn.populationsHolding['formal-proved']).toBeGreaterThan(0);
    expect(drawn.populationsHolding['formal-could-not-verify']).toBeGreaterThan(0);
    // All three at once, where a reporter that misfiled an unscorable mutant only beside scorable
    // ones would show.
    expect(drawn.holdingAllThree).toBeGreaterThan(0);
    // The empty denominator WITH mutants in it: every one counted, none scored, and no rate.
    expect(drawn.holdingOnlyUnscorable).toBeGreaterThan(0);
    // The empty denominator with nothing in it at all.
    expect(drawn.empty).toBeGreaterThan(0);
    // Req 9.6: populations whose formal denominator differs from the Negative_Control's, so a
    // reporter that used the simulation denominator would have been caught by clause 2.
    expect(drawn.denominatorsDiverged).toBeGreaterThan(0);
    // Req 9.5's own pair: a frontend rejection and a timeout were both carried and checked.
    expect(drawn.causes).toContain('frontend-rejected');
    expect(drawn.causes).toContain('proof-timeout');
  });
});
