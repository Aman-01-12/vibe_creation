// formal-property-oracle, Property 23: A property set that proves a judge-killed mutant is refused,
// and one that meets only unscorable mutants is not (task 10.5).
//
// WHAT IS CLAIMED, OVER WHAT
//   Over every population `arbCalibratedMutantPopulation()` generates - empty, wholly unscorable,
//   wholly scorable, and mixed, with the independent judge's verdict drawn apart from the formal
//   one - `admitPropertySet` satisfies three clauses, checked in this order:
//
//     1. AN EMPTY SCORABLE SET NEVER REFUSES. A population in which the formal oracle scored no
//        mutant - no mutants at all, or only `formal-could-not-verify` ones - is not refused,
//        however many of its mutants the judge killed (Req 10.5).
//     2. REFUSED IF AND ONLY IF A SURVIVOR EXISTS. The Property_Set is refused exactly when at
//        least one mutant the independent judge killed was scored `formal-proved` (Req 10.1, 10.2,
//        10.5).
//     3. EXACTLY THOSE SURVIVORS ARE NAMED. A refusal names every survivor once, with the identity
//        the population gave it, and nothing else: no unscorable mutant, no mutant the judge did
//        not kill, and no mutant the Property_Set refuted (Req 10.6).
//
//   Clause 1 follows from clause 2 whenever this file's oracle is right, and is checked FIRST and
//   on its own anyway: it reads no judge-kill rule, only whether any mutant was scored, so it is
//   Req 10.5's `counter_12` row with none of this file's own oracle in it. Checked after clause 2,
//   it could never be the clause that fails.
//
//   Req 10.1 is carried in its DECISION half: what the gate decides is read off how the
//   Property_Set fared on a population of single-operator mutants, every judge-killed one of them
//   consulted. Its ORDERING half is not observable in a pure function; see the last section.
//
// THE ORACLE IS AN INDEPENDENT COMPUTATION
//   The expected survivors are read straight off the population: killed by the judge under this
//   file's own `JUDGE_KILLED` table, AND `formal-proved`, which is a scored calibration, so
//   "formally scored" is part of that test rather than a third one. They are copied BEFORE the
//   admitter runs, so an admitter that rewrote a mutant in place could not drag the expectation
//   along with its answer. No production selection helper builds an expectation:
//   `mutantIsInPropertySetGateSet`, `mutantWasGoldenKilled`, `formalMutantIsScorable`, and
//   `FORMAL_CALIBRATION_ADMITS_TO_DENOMINATOR` are not imported, so the test cannot agree with
//   itself.
//
//   `JUDGE_KILLED` counts a golden TIMEOUT as a kill. That is Req 10.2's "a mutant the independent
//   judge killed" read under Req 10.4's "the same rule the Negative_Control already applies",
//   whose gate set holds a mutant that hung the golden testbench as killed on weaker evidence. It
//   is also the fail-safe reading: the larger gate set refuses more, and a refusal only sends the
//   sample to the Simulation_Fallback.
//
// RUN COUNT: 1000, not the shared 100
//   The rarest required row is clause 1's sharpest case: a NON-EMPTY population holding only
//   `formal-could-not-verify` mutants, at least one of them judge-killed. Measured over 20 seeds of
//   1000 draws each - the distribution a 1000-run property sees, early-run bias included - it was
//   473 of 20,000, about 2.4%. At 100 runs the chance of drawing none is (1 - 0.024)^100, about 9%,
//   a flake rather than a claim; at 1000 it is about 4e-11. The wholly unscorable population is
//   5.1% (about 3e-23 at 1000 runs) and the empty one 10.1%; every other row is 14% or commoner.
//   Each row is a drawn-at-least-once check, so (1 - p)^runs is its whole miss bound.
//
// WHAT THIS FILE DOES NOT COVER
//   Which non-refusal member a population receives (`admitted` or `no-gate-set`), the order the
//   survivors are named in, and the refusal's field set (Req 10.10) are pinned by
//   `app/eval/property-set-admission.test.ts`. Req 10.1's ORDERING half - the gate decides before
//   the Property_Set decides any candidate's verdict - is pinned by
//   `app/eval/harness-property-set-admission.test.ts`, where the runner's request carries the
//   outcome. Req 10.4's predicate agreement is task 10.6's.
//
// The tag string is a literal, not `propertyTag(...)`, whose `FEATURE_TAG` is hardcoded to a
// different spec's property numbering
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// **Validates: Requirements 10.1, 10.2, 10.5, 10.6**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  admitPropertySet,
  type CalibratedFormalMutant,
  type FormalMutantCalibration,
  type MutantCalibration,
  type MutantIdentity,
  type PropertySetAdmission,
} from '@app/eval';

import { arbCalibratedMutantPopulation } from './formal-arbitraries.js';
import { propertyParameters } from './property.js';

// **Feature: formal-property-oracle, Property 23: A property set that proves a judge-killed mutant
// is refused, and one that meets only unscorable mutants is not**
const PROPERTY =
  'formal-property-oracle, Property 23: A property set that proves a judge-killed mutant is refused, and one that meets only unscorable mutants is not';

/** See the RUN COUNT note: the rarest required row is about 2.4% of draws. */
const NUM_RUNS = 1000;

/**
 * An admitter under test.
 *
 * A PARAMETER of the assertions rather than a call inside them, so a deliberately wrong admitter
 * can be handed to the very same clauses to show they fail - without editing the shared module,
 * which a killed tool call would leave mutated in the build every concurrent agent reads
 * (`chipAgent/_inbox/gotcha-a-scratch-script-exit-trap-does-not-run-when-the-agent-tool-kills-the-shell.md`).
 */
type PropertySetAdmitter = (population: readonly CalibratedFormalMutant[]) => PropertySetAdmission;

/** The calibration that MISSES a mutant. `satisfies`, so a rename of the member breaks here. */
const PROVED = 'formal-proved' satisfies FormalMutantCalibration;

/**
 * Whether the formal oracle SCORED a mutant, per calibration: a refutation and a proof are
 * measurements, and a refusal to reason is not one (Req 10.5).
 *
 * This file's own statement rather than `FORMAL_CALIBRATION_ADMITS_TO_DENOMINATOR`, so the test
 * cannot agree with itself. Total, so a fourth calibration is a compile error here rather than a
 * mutant silently scored or unscored.
 */
const FORMALLY_SCORED: Readonly<Record<FormalMutantCalibration, boolean>> = Object.freeze({
  'formal-refuted': true,
  'formal-proved': true,
  'formal-could-not-verify': false,
});

/**
 * Whether the INDEPENDENT judge killed a mutant, per judge calibration. A golden TIMEOUT is a kill,
 * for the reason the header gives.
 *
 * This file's own statement rather than `mutantWasGoldenKilled`, so the test cannot agree with
 * itself. Total, so a sixth judge calibration is a compile error here.
 */
const JUDGE_KILLED: Readonly<Record<MutantCalibration, boolean>> = Object.freeze({
  'golden-killed': true,
  'golden-timeout': true,
  'golden-survived': false,
  'non-compiling': false,
  'golden-errored': false,
});

/** Whether the formal oracle scored this mutant at all. */
function isScored(mutant: CalibratedFormalMutant): boolean {
  return FORMALLY_SCORED[mutant.formal];
}

/** A survivor: the judge killed it and the Property_Set PROVED it, so the property missed a kill. */
function isSurvivor(mutant: CalibratedFormalMutant): boolean {
  return JUDGE_KILLED[mutant.golden] && mutant.formal === PROVED;
}

/** A judge-killed mutant the formal oracle could NOT score: the `counter_12` row (Req 10.5). */
function isUnscorableKill(mutant: CalibratedFormalMutant): boolean {
  return JUDGE_KILLED[mutant.golden] && !isScored(mutant);
}

/** A proof of a mutant the judge did NOT kill, which demonstrates no weakness (Req 10.2). */
function isUnkilledProof(mutant: CalibratedFormalMutant): boolean {
  return !JUDGE_KILLED[mutant.golden] && mutant.formal === PROVED;
}

/** A copy of one identity, so an admitter that edits its input cannot move the expectation. */
function copyOf(identity: MutantIdentity): MutantIdentity {
  return { mutantId: identity.mutantId, operator: identity.operator, site: { ...identity.site } };
}

/**
 * Identities in one canonical order, so "the same survivors" is a comparison of multisets.
 *
 * Ids are unique across a generated population, so a dropped, extra, or repeated name changes the
 * sorted list. The ORDER a refusal names its survivors in is the unit tests' claim, not this one's.
 */
function inIdOrder(identities: readonly MutantIdentity[]): readonly MutantIdentity[] {
  return [...identities].sort((left, right) => left.mutantId.localeCompare(right.mutantId));
}

/** What the oracle expects of one population, fixed before any admitter sees it. */
interface ExpectedAdmission {
  /** The formal oracle scored no mutant: there were none, or every one is unscorable. */
  readonly scorableSetIsEmpty: boolean;
  /** Every survivor, copied, in canonical order. Non-empty exactly when a refusal is due. */
  readonly survivors: readonly MutantIdentity[];
}

function expectedAdmissionOf(population: readonly CalibratedFormalMutant[]): ExpectedAdmission {
  return {
    scorableSetIsEmpty: !population.some(isScored),
    survivors: inIdOrder(population.filter(isSurvivor).map((mutant) => copyOf(mutant.identity))),
  };
}

/** Clause 1: a population the formal oracle scored nothing in is never refused (Req 10.5). */
function assertEmptyScorableSetNeverRefuses(
  admission: PropertySetAdmission,
  expected: ExpectedAdmission,
): void {
  if (expected.scorableSetIsEmpty) {
    expect(admission.kind, 'clause 1: an empty scorable set is never refused').not.toBe('refused');
  }
}

/** Clause 2: refused exactly when at least one survivor exists (Req 10.1, 10.2, 10.5). */
function assertRefusedIffASurvivor(
  admission: PropertySetAdmission,
  expected: ExpectedAdmission,
): void {
  expect(admission.kind === 'refused', 'clause 2: refused iff a survivor exists').toBe(
    expected.survivors.length > 0,
  );
}

/** Clause 3: a refusal names exactly the survivors, each once, as the population had it (10.6). */
function assertNamesExactlyTheSurvivors(
  admission: PropertySetAdmission,
  expected: ExpectedAdmission,
): void {
  if (admission.kind === 'refused') {
    expect(
      inIdOrder(admission.survivors),
      'clause 3: a refusal names exactly the survivors',
    ).toEqual(expected.survivors);
  }
}

/**
 * Every clause of Property 23 for one population, against whichever admitter it is handed.
 *
 * The expectation is fixed from copies BEFORE the admitter runs, so an admitter that rewrote a
 * mutant in place cannot move it.
 */
function assertPropertySetAdmission(
  admitter: PropertySetAdmitter,
  population: readonly CalibratedFormalMutant[],
): void {
  const expected = expectedAdmissionOf(population);
  const admission = admitter(population);
  assertEmptyScorableSetNeverRefuses(admission, expected);
  assertRefusedIffASurvivor(admission, expected);
  assertNamesExactlyTheSurvivors(admission, expected);
}

/** What the run drew, so every clause above is shown to have met the case it is about. */
interface DrawnShapes {
  runs: number;
  oneSurvivor: number;
  severalSurvivors: number;
  unscorableKillWithNoSurvivor: number;
  unscorableKillBesideASurvivor: number;
  unkilledProofWithNoSurvivor: number;
  empty: number;
  whollyUnscorable: number;
  whollyUnscorableWithAKill: number;
  readonly survivorKillKinds: Set<MutantCalibration>;
}

function noShapesDrawn(): DrawnShapes {
  return {
    runs: 0,
    oneSurvivor: 0,
    severalSurvivors: 0,
    unscorableKillWithNoSurvivor: 0,
    unscorableKillBesideASurvivor: 0,
    unkilledProofWithNoSurvivor: 0,
    empty: 0,
    whollyUnscorable: 0,
    whollyUnscorableWithAKill: 0,
    survivorKillKinds: new Set(),
  };
}

/** Record one population's shape. A NON-VACUITY COUNTER, and never part of an expectation. */
function recordShape(drawn: DrawnShapes, population: readonly CalibratedFormalMutant[]): void {
  const survivors = population.filter(isSurvivor);
  const hasSurvivor = survivors.length > 0;
  const hasUnscorableKill = population.some(isUnscorableKill);
  const whollyUnscorable = population.length > 0 && !population.some(isScored);
  drawn.runs += 1;
  drawn.oneSurvivor += survivors.length === 1 ? 1 : 0;
  drawn.severalSurvivors += survivors.length > 1 ? 1 : 0;
  drawn.unscorableKillWithNoSurvivor += hasUnscorableKill && !hasSurvivor ? 1 : 0;
  drawn.unscorableKillBesideASurvivor += hasUnscorableKill && hasSurvivor ? 1 : 0;
  drawn.unkilledProofWithNoSurvivor += !hasSurvivor && population.some(isUnkilledProof) ? 1 : 0;
  drawn.empty += population.length === 0 ? 1 : 0;
  drawn.whollyUnscorable += whollyUnscorable ? 1 : 0;
  drawn.whollyUnscorableWithAKill += whollyUnscorable && hasUnscorableKill ? 1 : 0;
  for (const survivor of survivors) {
    drawn.survivorKillKinds.add(survivor.golden);
  }
}

describe(PROPERTY, () => {
  it('refuses exactly when a judge-killed mutant was proved, names exactly those, and never refuses an empty scorable set', () => {
    const drawn = noShapesDrawn();
    fc.assert(
      fc.property(arbCalibratedMutantPopulation(), (population) => {
        recordShape(drawn, population);
        assertPropertySetAdmission(admitPropertySet, population);
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );
    expect(drawn.runs).toBe(NUM_RUNS);
    // Clause 3 over one survivor and over several, where a dropped or a repeated name shows.
    expect(drawn.oneSurvivor).toBeGreaterThan(0);
    expect(drawn.severalSurvivors).toBeGreaterThan(0);
    // Both kinds of judge kill among the survivors - a reported failure and a hang - so the
    // timeout reading of `JUDGE_KILLED` was exercised rather than merely written down.
    expect(drawn.survivorKillKinds).toContain('golden-killed');
    expect(drawn.survivorKillKinds).toContain('golden-timeout');
    // Req 10.5: a judge-killed mutant the oracle could not score, where it must cause no refusal
    // (clause 2) and where it must not be named beside the real survivors (clause 3).
    expect(drawn.unscorableKillWithNoSurvivor).toBeGreaterThan(0);
    expect(drawn.unscorableKillBesideASurvivor).toBeGreaterThan(0);
    // Req 10.2's other half: a proof of a mutant the judge did NOT kill, which must not refuse.
    expect(drawn.unkilledProofWithNoSurvivor).toBeGreaterThan(0);
    // Clause 1's empty scorable set, as no mutants at all, as unscorable mutants only, and as
    // unscorable mutants at least one of which the judge killed.
    expect(drawn.empty).toBeGreaterThan(0);
    expect(drawn.whollyUnscorable).toBeGreaterThan(0);
    expect(drawn.whollyUnscorableWithAKill).toBeGreaterThan(0);
  });
});
