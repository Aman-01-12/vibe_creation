// Feature: formal-gate-first-light, Property 17: A gate that ran is counted and a gate that did
// not is Not_Measured.
//
// WHAT IS CLAIMED, AND WHY IT IS DRIVEN THROUGH THE HARNESS
//   The claim is about what the SAMPLE records rather than about what `formalMutationCounts`
//   returns, so every run drives the real `createEvalHarness` with one drawn GATE SCRIPT:
//
//     `ran`          - the sample's Formal_Mutation_Counts equal this file's own tally of the
//                      population the port returned, every member counted (criterion 6.2);
//     `no-reference` - the port answered `null`, so the gate could not run;
//     `threw`        - the gate broke, so no admission was established;
//     `unwired`      - no Property_Set_Gate was passed to the harness at all.
//
//   The last three record Not_Measured, which is `null`, and NOT the all-zero tally a gate that
//   RAN over an empty population records (criterion 6.6). That empty population is the
//   discriminating control for the second half: both report "nothing killed, nothing survived",
//   and only the shape tells a gate that scored nothing from a gate that never ran.
//
// THE DISCRIMINATING FIELDS ARE VARIED WITHIN ONE DRAW
//   `formalMutationCounts` tallies the WHOLE population, while `admitPropertySet` - read from the
//   same population in the same statement - filters it to the scorable mutants, then to the gate
//   set, then to the survivors. A population whose members shared one `formal` calibration and
//   one `golden` verdict would make all three filters the identity, so a count taken over any of
//   them would pass this property while being exercised by almost none of it
//   (`chipAgent/_inbox/gotcha-an-aggregation-property-whose-population-holds-every-other-field-constant-cannot-see-a-count-taken-over-a-sub-population.md`).
//   `arbCalibratedMutantPopulation` draws both fields per MUTANT, and the non-vacuity rows assert
//   that the run held draws where each of those three sub-population tallies DIFFERS from the
//   true one, so a sub-population-scoped count is demonstrably caught rather than assumed to be.
//
// THE ORACLE IS THIS FILE'S OWN TALLY
//   `CONTRIBUTION_OF` states what one mutant of each calibration contributes and every
//   expectation is summed from it, and the golden-kill table is written out rather than read from
//   `mutantWasGoldenKilled`, so the test cannot agree with itself.
//
// **Validates: Requirements 6.2, 6.6**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { FormalPropertySet, PropertySetSource, VerificationOutcome } from '@app/agent';
import type { ResourceLimits } from '@app/tools';
import {
  createEvalHarness,
  FIXED_EVAL_SUBSET,
  makeReproducibilityConfig,
  type CalibratedFormalMutant,
  type EvalLoopRunner,
  type FormalMutantCalibration,
  type FormalMutationCounts,
  type MutantCalibration,
  type PropertySetGate,
  type ReproducibilityConfig,
  type SampleResult,
  type StudentSessionCaps,
} from '@app/eval';

import { arbCalibratedMutantPopulation } from './formal-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'formal-gate-first-light, Property 17: A gate that ran is counted and a gate that did not is Not_Measured';

/**
 * Above the shared 100, because the rarest required shape is a gate that RAN over an EMPTY
 * population - the one draw that separates an all-zero tally from Not_Measured. The `ran` arm is
 * half the draws and about a sixth of its populations are empty, so that row is ~17 of 200.
 */
const NUM_RUNS = 200;

const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5000 };

const CAPS: StudentSessionCaps = {
  maxIterations: 20,
  maxTokens: 1_000_000,
  maxWallClockMs: 1_000_000,
  maxCostCents: 1_000_000,
};

/** The one calibration that leaves the denominator. `satisfies`, so a rename breaks here. */
const UNSCORABLE = 'formal-could-not-verify' satisfies FormalMutantCalibration;

/** Every formal calibration, so the non-vacuity row can ask for a population holding all three. */
const FORMAL_CALIBRATIONS = [
  'formal-refuted',
  'formal-proved',
  UNSCORABLE,
] as const satisfies readonly FormalMutantCalibration[];

/** Nothing counted: the identity the tally starts from, and what a gate that ran over nothing reports. */
const NOTHING_COUNTED: FormalMutationCounts = Object.freeze({
  totalCount: 0,
  denominator: 0,
  killedCount: 0,
  survivedCount: 0,
  couldNotVerifyCount: 0,
});

/**
 * What ONE mutant of each calibration contributes to every reported count: this file's own
 * statement of the rule, and the oracle every expectation is summed from.
 *
 * A total `Record`, so a fourth calibration is a compile error here rather than a mutant that
 * silently contributes nothing.
 */
const CONTRIBUTION_OF: Readonly<Record<FormalMutantCalibration, FormalMutationCounts>> =
  Object.freeze({
    'formal-refuted': { ...NOTHING_COUNTED, totalCount: 1, denominator: 1, killedCount: 1 },
    'formal-proved': { ...NOTHING_COUNTED, totalCount: 1, denominator: 1, survivedCount: 1 },
    'formal-could-not-verify': { ...NOTHING_COUNTED, totalCount: 1, couldNotVerifyCount: 1 },
  });

/**
 * Which golden verdicts are a KILL, stated here rather than read from `mutantWasGoldenKilled`.
 *
 * Used only by the non-vacuity bookkeeping, which has to know the gate-set sub-population
 * independently of the production predicate that filters on it.
 */
const GOLDEN_KILLS: Readonly<Record<MutantCalibration, boolean>> = Object.freeze({
  'golden-killed': true,
  'golden-timeout': true,
  'golden-survived': false,
  'non-compiling': false,
  'golden-errored': false,
});

/** Every counted member, so a field-wise comparison cannot miss one a rename adds. */
const TALLY_PARTS = [
  'totalCount',
  'denominator',
  'killedCount',
  'survivedCount',
  'couldNotVerifyCount',
] as const satisfies readonly (keyof FormalMutationCounts)[];

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

/** The independent tally: every mutant's contribution, summed by its own calibration. */
function tallyOf(population: readonly CalibratedFormalMutant[]): FormalMutationCounts {
  return population.reduce(
    (tally, mutant) => plus(tally, CONTRIBUTION_OF[mutant.formal]),
    NOTHING_COUNTED,
  );
}

function sameTally(left: FormalMutationCounts, right: FormalMutationCounts): boolean {
  return TALLY_PARTS.every((part) => left[part] === right[part]);
}

/** The sub-populations a SIBLING read of the same population filters down to. */
type SubPopulationName = 'scorable' | 'gate-set' | 'survivors';

function subPopulationsOf(
  population: readonly CalibratedFormalMutant[],
): ReadonlyMap<SubPopulationName, readonly CalibratedFormalMutant[]> {
  const scorable = population.filter((mutant) => mutant.formal !== UNSCORABLE);
  const gateSet = scorable.filter((mutant) => GOLDEN_KILLS[mutant.golden]);
  return new Map<SubPopulationName, readonly CalibratedFormalMutant[]>([
    ['scorable', scorable],
    ['gate-set', gateSet],
    ['survivors', gateSet.filter((mutant) => mutant.formal === 'formal-proved')],
  ]);
}

/** One run's gate wiring: what the port did, or that no port was wired at all. */
type GateScript =
  | { readonly kind: 'ran'; readonly population: readonly CalibratedFormalMutant[] }
  | { readonly kind: 'no-reference' }
  | { readonly kind: 'threw' }
  | { readonly kind: 'unwired' };

/** The three scripts under which nothing gated the sample, exhausted rather than sampled. */
const UNGATED_SCRIPTS = [
  { kind: 'no-reference' },
  { kind: 'threw' },
  { kind: 'unwired' },
] as const satisfies readonly GateScript[];

/**
 * A drawn script, with the `ran` arm weighted so populations are the common case and an empty one
 * is still common within it - that empty population is what the second half is measured by.
 */
function gateScriptArbitrary(): fc.Arbitrary<GateScript> {
  const population = fc.oneof(
    { weight: 1, arbitrary: fc.constant<readonly CalibratedFormalMutant[]>([]) },
    { weight: 5, arbitrary: arbCalibratedMutantPopulation() },
  );
  return fc.oneof(
    {
      weight: 3,
      arbitrary: population.map((drawn): GateScript => ({ kind: 'ran', population: drawn })),
    },
    { weight: 1, arbitrary: fc.constantFrom<GateScript>(...UNGATED_SCRIPTS) },
  );
}

/** The gate this script wires, or `null` where the script is "no gate at all". */
function gateFor(script: GateScript): PropertySetGate | null {
  switch (script.kind) {
    case 'ran':
      return { calibrate: () => Promise.resolve(script.population) };
    case 'no-reference':
      return { calibrate: () => Promise.resolve(null) };
    case 'threw':
      return { calibrate: () => Promise.reject(new Error('the formal toolchain fell over')) };
    case 'unwired':
      return null;
  }
}

/** The empty Property_Set the gate is handed: this property is about the counts, not the set. */
const AUTHORED_SET: FormalPropertySet = {
  properties: [],
  unexpressedCriteria: [],
  propertySetAdmitted: 'not-gated',
};

const AUTHOR: PropertySetSource = { propertySetFor: () => Promise.resolve(AUTHORED_SET) };

/**
 * The loop outcome, which cannot move these counts: the gate runs BEFORE the loop and the record
 * reads the counts from that one gate call. A `blocked` outcome is the cheapest real one.
 */
const BLOCKED_OUTCOME: VerificationOutcome = {
  status: 'blocked',
  refusal: { reason: 'spec-unapproved', message: 'this property never drives the loop' },
};

class BlockedRunner implements EvalLoopRunner {
  runSample(): Promise<VerificationOutcome> {
    return Promise.resolve(BLOCKED_OUTCOME);
  }
}

function fixedConfig(): ReproducibilityConfig {
  const built = makeReproducibilityConfig({ seed: 7, temperature: 0, sampleCount: 1 });
  if (!built.ok) {
    throw new Error(built.error.message);
  }
  return built.value;
}

const CONFIG = fixedConfig();

/** Run one sample through the harness under this script, and return what it recorded. */
async function recordedFor(script: GateScript): Promise<SampleResult> {
  const problem = FIXED_EVAL_SUBSET[0];
  if (problem === undefined) {
    throw new Error('the fixed subset is empty');
  }
  const gate = gateFor(script);
  const built = createEvalHarness({
    loopRunner: new BlockedRunner(),
    caps: CAPS,
    limits: LIMITS,
    config: CONFIG,
    costEnvelopeCents: 5,
    ks: [1],
    // A gated run requires an author, because the gate scores an authored set rather than
    // conjuring one; an unwired run must look exactly like the shipping path, so it gets neither.
    ...(gate === null ? {} : { propertySetGate: gate, propertySetSourceFor: () => AUTHOR }),
  });
  if (!built.ok) {
    throw new Error(built.error.code);
  }
  const sample = (await built.value.run([problem])).problems[0]?.samples[0];
  if (sample === undefined) {
    throw new Error('the run produced no sample');
  }
  return sample;
}

/** Both halves of the property, over one script's own recorded sample. */
function assertRecorded(sample: SampleResult, script: GateScript): void {
  if (script.kind !== 'ran') {
    // Criterion 6.6. Not_Measured, and so distinguishable from the all-zero tally below: a gate
    // that did not run calibrated no mutants, where every count at zero would read as a gate that
    // calibrated mutants and scored none of them.
    expect(sample.formalMutationCounts).toBeNull();
    return;
  }
  // Criterion 6.2. The counts tally to the population the gate scored - every member of it,
  // including the mutants the oracle could not reason about.
  expect(sample.formalMutationCounts).toEqual(tallyOf(script.population));
  expect(sample.formalMutationCounts?.totalCount).toBe(script.population.length);
  expect(sample.formalMutationCounts).not.toBeNull();
}

/** Every shape the run has to have met. NON-VACUITY COUNTERS, never part of an expectation. */
interface DrawnShapes {
  readonly scripts: Map<GateScript['kind'], number>;
  ranEmpty: number;
  everyCalibration: number;
  readonly subPopulationDiverged: Map<SubPopulationName, number>;
}

function noShapesDrawn(): DrawnShapes {
  return {
    scripts: new Map(),
    ranEmpty: 0,
    everyCalibration: 0,
    subPopulationDiverged: new Map(),
  };
}

function bump<TKey>(counts: Map<TKey, number>, key: TKey): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function recordShape(drawn: DrawnShapes, script: GateScript): void {
  bump(drawn.scripts, script.kind);
  if (script.kind !== 'ran') {
    return;
  }
  const population = script.population;
  if (population.length === 0) {
    drawn.ranEmpty += 1;
    return;
  }
  drawn.everyCalibration += FORMAL_CALIBRATIONS.every((calibration) =>
    population.some((mutant) => mutant.formal === calibration),
  )
    ? 1
    : 0;
  const truth = tallyOf(population);
  for (const [name, members] of subPopulationsOf(population)) {
    if (!sameTally(tallyOf(members), truth)) {
      bump(drawn.subPopulationDiverged, name);
    }
  }
}

describe(PROPERTY, () => {
  it('records a tally for a gate that ran and Not_Measured for one that did not, over any script', async () => {
    const drawn = noShapesDrawn();

    await fc.assert(
      fc.asyncProperty(gateScriptArbitrary(), async (script) => {
        recordShape(drawn, script);
        assertRecorded(await recordedFor(script), script);
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    // Non-vacuity. Every script was drawn, so the `null` clause is a statement about those three
    // paths rather than about a field nothing ever fills, and the tally clause met a gate that ran
    // over nothing - the draw that makes the all-zero tally distinct from Not_Measured.
    expect([...drawn.scripts.keys()].sort()).toEqual(
      ['ran', 'no-reference', 'threw', 'unwired'].sort(),
    );
    expect(drawn.ranEmpty).toBeGreaterThan(0);
    expect(drawn.everyCalibration).toBeGreaterThan(0);
    // The discriminating fields really discriminated: for each sub-population a sibling read of
    // the same population filters to, the run held draws whose tally over it DIFFERS from the
    // tally over the whole population. A count scoped to any of the three is therefore caught.
    for (const name of ['scorable', 'gate-set', 'survivors'] as const) {
      expect(drawn.subPopulationDiverged.get(name) ?? 0).toBeGreaterThan(0);
    }
  });

  it('separates a gate that scored nothing from a gate that never ran, as the two closed extremes', async () => {
    // The pair stated as fixtures rather than left to a draw, because this is the whole of
    // criterion 6.6: the all-zero tally and Not_Measured are the two readings of "no mutant was
    // killed and none survived", and a record that collapsed them would report a gate where none
    // ran.
    const ranOverNothing = await recordedFor({ kind: 'ran', population: [] });

    expect(ranOverNothing.formalMutationCounts).toEqual(NOTHING_COUNTED);

    for (const script of UNGATED_SCRIPTS) {
      const ungated = await recordedFor(script);

      expect(ungated.formalMutationCounts).toBeNull();
      expect(ungated.formalMutationCounts).not.toEqual(ranOverNothing.formalMutationCounts);
    }
  });
});
