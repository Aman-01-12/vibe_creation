// formal-gate-first-light, Property 12: nothing outside the Cost_Pilot dispatches before the
// Per_Design_Extrapolation exists (task 11.15).
//
// This is the gate that stands between a config typo and an unbounded paid run, so the claim is
// made from four sides rather than one.
//
// WHAT IS CLAIMED, OVER WHAT
//   1. THE GATE. For any scored population and any configured Cost_Pilot, while no
//      Per_Design_Extrapolation is recorded every dispatched design is a configured pilot design
//      that the corpus also holds, no scored design outside the pilot dispatches, and the
//      dispatched set is never the scored population (Req 5.6).
//   2. NOTHING DROPPED. The dispatched ids and the reported unknown ids partition the configured
//      pilot exactly, so a pilot quietly running two of its three designs is caught: that would
//      set the extrapolation from a population nobody configured.
//   3. THE CONVERSE IS REACHABLE. With an extrapolation recorded the whole population dispatches,
//      including designs outside the pilot (Req 5.15). Without this the gate would also hold for
//      an implementation that never dispatches anything.
//   4. THE GATE READS STATE, NOT A FLAG. "Unrecorded" is whatever `perDesignExtrapolationOf`
//      returns for a measurement with no result, and no argv an operator can type selects the
//      population, so the only accepted invocation is `--config <path>`.
//
// WHY THE POPULATION IS NEVER SMALLER THAN THE PILOT CAN COVER
//   The scored population is drawn at four designs or more and a configured pilot is at most
//   three (Req 5.5), so "the dispatched set is not the population" is an unconditional claim
//   rather than one with a vacuous escape on a population the pilot happens to cover whole.
//
// WHY PILOT OVERLAP VARIES WITHIN ONE RUN
//   A pilot drawn entirely from the population makes the gate's intersection the identity, and a
//   gate that trusted its config would then pass - the shape of defect measured on Property 28,
//   where a uniform population hid a count taken over a sub-population
//   (`chipAgent/_inbox/gotcha-an-aggregation-property-whose-population-holds-every-other-field-constant-cannot-see-a-count-taken-over-a-sub-population.md`).
//   So pilots overlap the corpus fully, partially, and not at all, and `GATE_ROWS` asserts the
//   run reached each shape plus the two draws on which a leaky gate would have returned a
//   different set.
//
// The tag is a literal because `propertyTag` hardcodes another spec's slug.
//
// **Validates: Requirements 5.6**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DECLARED_LIMITS,
  dispatchPlanFor,
  parsePropertyOnlyArgs,
  perDesignExtrapolationOf,
  PROPERTY_ONLY_MEASUREMENT_KIND,
  PROPERTY_ONLY_SCHEMA_VERSION,
  RTLLM_SCORED_DESIGN_COUNT,
  type DispatchPlan,
  type DispatchPlanInput,
  type ManifestToolchain,
  type PerDesignExtrapolation,
  type PropertyOnlyDesignResult,
  type PropertyOnlyMeasurement,
} from '@app/eval';

import { propertyParameters } from './property.js';

// Feature: formal-gate-first-light, Property 12: Nothing outside the Cost_Pilot dispatches before the extrapolation exists
const PROPERTY =
  'formal-gate-first-light, Property 12: Nothing outside the Cost_Pilot dispatches before the extrapolation exists';

/**
 * Sized above the 100 minimum because the rarest pilot shape is one draw in ten.
 *
 * At 200 runs every row in `GATE_ROWS` is seen about twenty times or more, so a row that goes
 * missing is a real change in the generators rather than an unlucky seed.
 */
const NUM_RUNS = 200;

/** The most designs a configured Cost_Pilot may name (Req 5.5). */
const MAX_PILOT = 3;

/** One id per scored design, so a full-coverage draw is the scored set and not a multiset. */
const DESIGN_IDS: readonly string[] = Array.from(
  { length: RTLLM_SCORED_DESIGN_COUNT },
  (_unused, index) => `rtllm/scored/design-${String(index).padStart(2, '0')}`,
);

/**
 * Ids a configured pilot can name that the scored corpus does not hold.
 *
 * Typo-shaped on purpose: an off-by-one index, a wrong category, a bare name, a trailing space,
 * and the empty string. Each is what a hand-edited config actually gets wrong.
 */
const UNKNOWN_IDS: readonly string[] = [
  `rtllm/scored/design-${String(RTLLM_SCORED_DESIGN_COUNT)}`,
  'rtllm/typo/adder',
  'design-00',
  'rtllm/scored/design-00 ',
  '',
];

/**
 * The smallest population the gate can leak from: one design more than a pilot can name.
 *
 * Any smaller and a pilot could cover the population, which would make "the dispatched set is
 * not the population" true only sometimes.
 */
const MIN_POPULATION = MAX_PILOT + 1;

/**
 * How many pilot ids the corpus holds, and how many it does not, per draw.
 *
 * Enumerated rather than drawn from two independent counts, so every overlap shape - empty, none,
 * partial, full - is reached at a known rate instead of at whatever rate two nats happen to give.
 */
const PILOT_SHAPES: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [2, 0],
  [MAX_PILOT, 0],
  [0, 1],
  [0, 2],
  [0, MAX_PILOT],
  [1, 1],
  [2, 1],
  [1, 2],
];

// ---------------------------------------------------------------------------
// The generated dispatch input
// ---------------------------------------------------------------------------

/** Exactly `count` distinct members of `pool`, or the empty list where none are wanted. */
function exactly(pool: readonly string[], count: number): fc.Arbitrary<readonly string[]> {
  return count === 0
    ? fc.constant<readonly string[]>([])
    : fc.uniqueArray(fc.constantFrom(...pool), { minLength: count, maxLength: count });
}

/** One permutation of the drawn ids, so a leaked id cannot hide at a fixed position. */
function inAnyOrder(ids: readonly string[]): fc.Arbitrary<readonly string[]> {
  return ids.length === 0
    ? fc.constant<readonly string[]>([])
    : fc.shuffledSubarray([...ids], { minLength: ids.length, maxLength: ids.length });
}

/** The whole scored set in one draw of four, and a smaller population in the rest. */
function populationArbitrary(): fc.Arbitrary<readonly string[]> {
  return fc.oneof(
    { arbitrary: fc.constant(DESIGN_IDS), weight: 1 },
    {
      arbitrary: fc.uniqueArray(fc.constantFrom(...DESIGN_IDS), {
        minLength: MIN_POPULATION,
        maxLength: RTLLM_SCORED_DESIGN_COUNT,
      }),
      weight: 3,
    },
  );
}

/** A configured pilot over one population: known ids drawn from it, unknown ids from outside. */
function pilotArbitrary(population: readonly string[]): fc.Arbitrary<readonly string[]> {
  return fc
    .constantFrom(...PILOT_SHAPES)
    .chain(([knownCount, unknownCount]) =>
      fc.tuple(exactly(population, knownCount), exactly(UNKNOWN_IDS, unknownCount)),
    )
    .chain(([known, unknown]) => inAnyOrder([...known, ...unknown]));
}

/** What the dispatch plan is decided from, minus the one field each claim below varies. */
type PopulationAndPilot = Omit<DispatchPlanInput, 'extrapolation'>;

/** A population and a pilot drawn against it; the pilot can never cover the population. */
function populationAndPilotArbitrary(): fc.Arbitrary<PopulationAndPilot> {
  return populationArbitrary().chain((scoredDesignIds) =>
    pilotArbitrary(scoredDesignIds).map((costPilotDesignIds) => ({
      scoredDesignIds,
      costPilotDesignIds,
    })),
  );
}

/** A recorded extrapolation; both figures, never one, and neither is read by the gate. */
function extrapolationArbitrary(): fc.Arbitrary<PerDesignExtrapolation> {
  return fc
    .tuple(fc.nat({ max: 1_000_000 }), fc.nat({ max: 3_600_000 }))
    .map(([tokens, elapsedMs]) => ({ tokens, elapsedMs }));
}

/** One whole dispatch input, with the extrapolation the caller wants varied. */
function inputArbitrary(
  extrapolation: fc.Arbitrary<PerDesignExtrapolation | null>,
): fc.Arbitrary<DispatchPlanInput> {
  return fc
    .tuple(populationAndPilotArbitrary(), extrapolation)
    .map(([base, drawn]) => ({ ...base, extrapolation: drawn }));
}

// ---------------------------------------------------------------------------
// The generated earlier measurement the extrapolation is read from
// ---------------------------------------------------------------------------

/** Held constant: no figure the gate reads comes from the toolchain. */
const TOOLCHAIN: ManifestToolchain = {
  iverilogVersion: '13.0',
  vvpVersion: '13.0',
  workerPython: '3.12.6',
  yosysVersion: { kind: 'read', value: '0.69+post' },
  yosysBuildId: { kind: 'read', value: '143eb14f9cc55d6f8927e68523b0c9d2166ed02c' },
  yosysSmtBmcVersion: { kind: 'read', value: '0.69+post' },
  bitwuzlaVersion: { kind: 'read', value: '0.9.1' },
  z3Version: { kind: 'read', value: '4.15.4' },
};

/**
 * One design result carrying the three figures the extrapolation is taken over.
 *
 * Every other field is filler, and the outcome is `not-measured` so this builder needs no
 * Proof_Conditions: `perDesignExtrapolationOf` reads token counts and wall clock only.
 */
function designResultOf(
  designId: string,
  promptTokens: number,
  completionTokens: number,
  elapsedMs: number,
): PropertyOnlyDesignResult {
  return {
    designId,
    authoringModel: 'zai.glm-5',
    population: 'admitted',
    prepassRefusalCause: null,
    properties: [
      { propertyId: 'p1', outcome: { kind: 'not-measured', reason: 'no figure here is read' } },
    ],
    unexpressedCriteria: [],
    promptTokens,
    completionTokens,
    elapsedMs,
    proofSpanMs: elapsedMs,
    toolchain: TOOLCHAIN,
    formalOracleVersion: 1,
  };
}

/** An earlier measurement holding nothing, or holding up to a pilot's worth of results. */
function measurementArbitrary(): fc.Arbitrary<PropertyOnlyMeasurement> {
  return fc
    .array(fc.tuple(fc.nat({ max: 10_000 }), fc.nat({ max: 10_000 }), fc.nat({ max: 600_000 })), {
      maxLength: MAX_PILOT,
    })
    .map((figures): PropertyOnlyMeasurement => ({
      schemaVersion: PROPERTY_ONLY_SCHEMA_VERSION,
      runName: 'property-only-cost-pilot',
      measurementKind: PROPERTY_ONLY_MEASUREMENT_KIND,
      omittedStudentPathSteps: ['Testbench_Agent', 'Instrument_Admission'],
      results: figures.map(([promptTokens, completionTokens, elapsedMs], index) =>
        designResultOf(DESIGN_IDS[index] ?? '', promptTokens, completionTokens, elapsedMs),
      ),
      limits: Object.values(DECLARED_LIMITS),
    }));
}

// ---------------------------------------------------------------------------
// The independent reading of one plan
// ---------------------------------------------------------------------------

/** The configured pilot ids the scored corpus holds, computed without the gate's help. */
function knownPilotIdsOf(input: PopulationAndPilot): readonly string[] {
  const scored = new Set(input.scoredDesignIds);
  return input.costPilotDesignIds.filter((id) => scored.has(id));
}

/**
 * Every claim the gate must satisfy while no extrapolation is recorded.
 *
 * Factored out because two properties below assert it: one over a hand-drawn `null`, and one over
 * the `null` that `perDesignExtrapolationOf` actually returns for an empty measurement.
 */
function expectConfinedToPilot(input: PopulationAndPilot, plan: DispatchPlan): void {
  const pilot = new Set(input.costPilotDesignIds);
  const scored = new Set(input.scoredDesignIds);

  expect(plan.scope).toBe('cost-pilot');

  // The gate itself: a subset of the configured pilot, and of the corpus, in both directions.
  for (const id of plan.designIds) {
    expect(pilot.has(id), `${id} dispatched outside the configured Cost_Pilot`).toBe(true);
    expect(scored.has(id), `${id} dispatched but the scored corpus does not hold it`).toBe(true);
  }
  for (const id of input.scoredDesignIds) {
    if (!pilot.has(id)) {
      expect(plan.designIds, `${id} is outside the pilot and must not dispatch`).not.toContain(id);
    }
  }

  // And it is never the population: one leaked design would show here as well as above.
  expect(plan.designIds.length).toBeLessThan(input.scoredDesignIds.length);
  expect(plan.designIds).not.toEqual(input.scoredDesignIds);

  // Nothing dropped: the two lists partition the configured pilot exactly.
  expect(plan.designIds).toEqual(knownPilotIdsOf(input));
  expect([...plan.designIds, ...plan.unknownDesignIds].sort()).toEqual(
    [...input.costPilotDesignIds].sort(),
  );
  for (const id of plan.unknownDesignIds) {
    expect(scored.has(id), `${id} was reported unknown but the corpus holds it`).toBe(false);
  }
}

// ---------------------------------------------------------------------------
// The rows the run must have reached
// ---------------------------------------------------------------------------

/**
 * Shapes the gate is claimed over, plus the two on which a leaky gate diverges.
 *
 * `wrong:population-as-plan` is a draw where dispatching the population would have been a
 * different set, and `wrong:pilot-untrimmed` one where trusting the configured pilot would have
 * dispatched an id the corpus does not hold. Both must be reached, or the gate's two failure
 * modes were never exercised.
 */
const GATE_ROWS: readonly string[] = [
  'pilot:empty',
  'overlap:none',
  'overlap:partial',
  'overlap:full',
  'population:full',
  'population:short',
  'unknown:reported',
  'unknown:none',
  'wrong:population-as-plan',
  'wrong:pilot-untrimmed',
];

/** Which rows one draw reached. */
function gateRowsOf(input: PopulationAndPilot, plan: DispatchPlan): readonly string[] {
  const known = knownPilotIdsOf(input);
  const unknown = input.costPilotDesignIds.length - known.length;
  const overlap =
    input.costPilotDesignIds.length === 0
      ? 'pilot:empty'
      : known.length === 0
        ? 'overlap:none'
        : unknown === 0
          ? 'overlap:full'
          : 'overlap:partial';
  return [
    overlap,
    input.scoredDesignIds.length === RTLLM_SCORED_DESIGN_COUNT
      ? 'population:full'
      : 'population:short',
    unknown > 0 ? 'unknown:reported' : 'unknown:none',
    ...(plan.designIds.length !== input.scoredDesignIds.length ? ['wrong:population-as-plan'] : []),
    ...(plan.designIds.length !== input.costPilotDesignIds.length ? ['wrong:pilot-untrimmed'] : []),
  ];
}

/** Fail naming the row, so a generator change that narrows the run is not silent. */
function expectEveryRowReached(seen: ReadonlySet<string>, rows: readonly string[]): void {
  for (const row of rows) {
    expect(seen.has(row), `no draw reached ${row}`).toBe(true);
  }
}

// ---------------------------------------------------------------------------
// The argv surface: no flag selects the population
// ---------------------------------------------------------------------------

/** Flags an operator reaching for a wider run would plausibly try. */
const WIDENING_FLAGS: readonly string[] = [
  '--full-population',
  '--all',
  '--population',
  '--designs',
  '--scope',
  '--no-cost-pilot',
  '--cost-pilot',
];

/** The one flag that is accepted, the widening ones, and arbitrary noise. */
function flagArbitrary(): fc.Arbitrary<string> {
  return fc.oneof(
    { arbitrary: fc.constant('--config'), weight: 3 },
    { arbitrary: fc.constantFrom(...WIDENING_FLAGS), weight: 3 },
    { arbitrary: fc.string(), weight: 1 },
  );
}

/** An argv of any length over those flags; only one shape of it is an invocation. */
function argvArbitrary(): fc.Arbitrary<readonly string[]> {
  return fc.array(
    fc.oneof(
      { arbitrary: flagArbitrary(), weight: 3 },
      // A path-shaped value, never blank, so an accepted draw is not refused for its value.
      { arbitrary: fc.string({ minLength: 1 }).map((tail) => `cfg-${tail}`), weight: 3 },
    ),
    { maxLength: 4 },
  );
}

// ---------------------------------------------------------------------------
// Property 12
// ---------------------------------------------------------------------------

describe(PROPERTY, () => {
  it('given any input with no recorded extrapolation, then only Cost_Pilot designs dispatch', () => {
    const seen = new Set<string>();

    fc.assert(
      fc.property(inputArbitrary(fc.constant(null)), (input) => {
        const plan = dispatchPlanFor(input);

        expectConfinedToPilot(input, plan);
        for (const row of gateRowsOf(input, plan)) {
          seen.add(row);
        }
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    expectEveryRowReached(seen, GATE_ROWS);
  });

  it('given a recorded extrapolation, then the whole population dispatches', () => {
    // The converse, so the claim above cannot be passing because nothing ever dispatches.
    fc.assert(
      fc.property(inputArbitrary(extrapolationArbitrary()), (input) => {
        const plan = dispatchPlanFor(input);
        const pilot = new Set(input.costPilotDesignIds);
        const outsideThePilot = input.scoredDesignIds.filter((id) => !pilot.has(id));

        expect(plan.scope).toBe('full-population');
        expect(plan.designIds).toEqual(input.scoredDesignIds);
        expect(plan.unknownDesignIds).toEqual([]);

        // The pilot does not bound this run: designs it never named are dispatched here.
        expect(outsideThePilot.length).toBeGreaterThan(0);
        for (const id of outsideThePilot) {
          expect(plan.designIds).toContain(id);
        }
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );
  });

  it('given an earlier measurement, then an empty one confines the run to the pilot', () => {
    const seen = new Set<string>();

    fc.assert(
      fc.property(populationAndPilotArbitrary(), measurementArbitrary(), (base, measurement) => {
        // "Unrecorded" is whatever the producer returns, not a hand-written null.
        const extrapolation = perDesignExtrapolationOf(measurement);
        const unrecorded = measurement.results.length === 0;
        expect(extrapolation === null).toBe(unrecorded);

        const plan = dispatchPlanFor({ ...base, extrapolation });

        if (unrecorded) {
          expectConfinedToPilot(base, plan);
        } else {
          expect(plan.scope).toBe('full-population');
          expect(plan.designIds).toEqual(base.scoredDesignIds);
        }
        seen.add(unrecorded ? 'extrapolation:unrecorded' : 'extrapolation:recorded');
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    expectEveryRowReached(seen, ['extrapolation:unrecorded', 'extrapolation:recorded']);
  });

  it('given any argv, then no flag selects the population', () => {
    const seen = new Set<string>();

    fc.assert(
      fc.property(argvArbitrary(), (argv) => {
        const command = parsePropertyOnlyArgs(argv);
        // A flag-shaped value is not a path, so it is not the one invocation either: it is an
        // operator typing a flag where a path goes, and the parser refuses it as such.
        const configValue = (argv[1] ?? '').trim();
        const theOneInvocation =
          argv.length === 2 &&
          argv[0] === '--config' &&
          configValue.length > 0 &&
          !configValue.startsWith('-');

        expect(command.kind).toBe(theOneInvocation ? 'run' : 'usage');
        seen.add(theOneInvocation ? 'argv:accepted' : 'argv:refused');
        if (argv.includes('--full-population')) {
          // The gate is decided from a recorded extrapolation, so the widest flag is noise.
          expect(command.kind).toBe('usage');
          seen.add('argv:widening-flag-refused');
        }
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    expectEveryRowReached(seen, ['argv:accepted', 'argv:refused', 'argv:widening-flag-refused']);
  });
});
