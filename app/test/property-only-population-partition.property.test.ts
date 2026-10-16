// formal-gate-first-light, Property 13: every design carries a population, the two partition
// the scored set, and a rate over the Admitted_Population has that population's denominator
// (task 11.7).
//
// WHAT IS CLAIMED, OVER WHAT
//   1. MEMBERSHIP. Every decoded design carries exactly one member of the closed population
//      vocabulary, and a design whose population is absent, unknown, or two members at once
//      decodes to nothing - so no decoded measurement holds a design in neither or in both
//      (Req 5.16).
//   2. PARTITION. Filtering the recorded designs by the two members yields disjoint sets whose
//      union is the whole recorded set, and the rendered block names both sizes. A model that
//      recorded the scored corpus is reported as covering it; one short of it is reported as
//      short (Req 5.15).
//   3. DENOMINATOR. The rendered property-only rate counts admitted designs only, so every
//      design in the Refused_Population is outside that denominator and outside its numerator
//      (Req 9.12). Where no admitted design carries an oracle verdict the rate is NOT MEASURED
//      rather than a ratio.
//
// WHY `population` VARIES WITHIN ONE DRAW, AND WHY THE DECISION SHAPE IS INDEPENDENT OF IT
//   A uniform population makes every population filter the identity, and a count taken over any
//   sub-population then passes while almost nothing exercises it - measured on Property 28,
//   where `armFormal(passing)` passed because every generated record was a verified pass
//   (`chipAgent/_inbox/gotcha-an-aggregation-property-whose-population-holds-every-other-field-constant-cannot-see-a-count-taken-over-a-sub-population.md`).
//   So each design draws its population independently of its DECISION SHAPE, which is what the
//   denominator filters on next. Refused designs that carry verdicts, and admitted designs that
//   carry none, are what make a population-blind denominator a different number. The run asserts
//   it reached each of those shapes (`DENOMINATOR_ROWS`), so the distinguishability is proven
//   rather than asserted in a comment.
//
// WHAT IS HELD CONSTANT ON PURPOSE
//   The toolchain, the token counts, the wall clock, and the Proof_Conditions. No denominator in
//   this renderer filters on any of them, so varying them could not expose a population swap;
//   they belong to Property 26's provenance claim and Property 15's round trip.
//
// The tag is a literal because `propertyTag` hardcodes another spec's slug.
//
// **Validates: Requirements 5.15, 5.16, 9.12**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DECLARED_LIMITS,
  decodePropertyOnlyMeasurement,
  encodePropertyOnlyMeasurement,
  PROPERTY_ONLY_MEASUREMENT_KIND,
  PROPERTY_ONLY_SCHEMA_VERSION,
  renderPropertyOnlyReport,
  RTLLM_SCORED_DESIGN_COUNT,
  type DesignPopulation,
  type ManifestToolchain,
  type PropertyOnlyDesignResult,
  type PropertyOnlyMeasurement,
  type PropertyOnlyOutcome,
} from '@app/eval';
import type { ProofConditions } from '@app/tools';

import { propertyParameters } from './property.js';

// Feature: formal-gate-first-light, Property 13: Every design carries a population, and the two partition the scored set
const PROPERTY =
  'formal-gate-first-light, Property 13: Every design carries a population, and the two partition the scored set';

/**
 * Sized to the rarest required row rather than to the 100 minimum.
 *
 * The scarcest row is a model block covering the whole scored corpus whose designs are all
 * refused, which needs the full-coverage draw (1 in 4) and then 46 coin flips. The rows this
 * property actually rests on are each about a third of designs, so 200 runs leaves every one of
 * them seen many times over.
 */
const NUM_RUNS = 200;

/** Both populations, which no module exports as a list; a third member fails to compile here. */
const POPULATIONS: readonly DesignPopulation[] = ['admitted', 'refused'];

const AUTHORING_MODELS = ['zai.glm-5', 'moonshotai.kimi-k2.5'] as const;

/**
 * One id per scored design, so a full-coverage draw is the scored design set and not a multiset.
 *
 * Synthesized rather than read from `scoredRtllmCorpus`, which needs a corpus checkout this
 * suite does not require. The real fact the claim rests on is the scored count.
 */
const DESIGN_IDS: readonly string[] = Array.from(
  { length: RTLLM_SCORED_DESIGN_COUNT },
  (_unused, index) => `rtllm/scored/design-${String(index).padStart(2, '0')}`,
);

/** How many designs a short run records; small, so an all-refused block is reached often. */
const SHORT_MAX = 6;

/** The toolchain every design carries: read throughout, so no provenance line is rendered. */
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

/** The evidence behind every generated verdict; no denominator here reads a condition. */
const CONDITIONS: ProofConditions = {
  assertionCount: 1,
  presat: 'satisfiable',
  cover: { reached: false },
  base: 'passed',
  induction: 'successful',
};

// ---------------------------------------------------------------------------
// The generated measurement
// ---------------------------------------------------------------------------

/**
 * What the oracle made of one design, which is what the rate's denominator filters on next.
 *
 * `undecided` is a design no oracle invocation decided, so it is in the Admitted_Population and
 * outside the rate's denominator: the pair that tells an admitted-size denominator from a
 * decided-design one.
 */
const DECISION_SHAPES = ['proved', 'decided-not-proved', 'undecided'] as const;

type DecisionShape = (typeof DECISION_SHAPES)[number];

/** Each design's two independent draws: where it sits, and what came back for it. */
interface DesignSeed {
  readonly population: DesignPopulation;
  readonly shape: DecisionShape;
}

/** The outcome one decision shape records, with the cause its verdict demands. */
function outcomeFor(shape: DecisionShape): PropertyOnlyOutcome {
  if (shape === 'undecided') {
    return { kind: 'not-measured', reason: 'no solver invocation decided this property' };
  }
  if (shape === 'proved') {
    return {
      kind: 'measured',
      conditions: CONDITIONS,
      verdict: 'proved',
      couldNotVerifyCause: null,
      crossCheckDisagreed: false,
    };
  }
  return {
    kind: 'measured',
    conditions: CONDITIONS,
    verdict: 'refuted',
    couldNotVerifyCause: null,
    crossCheckDisagreed: false,
  };
}

/** One design result built from its id and its seed; everything else is fixed on purpose. */
function designOf(model: string, designId: string, seed: DesignSeed): PropertyOnlyDesignResult {
  return {
    designId,
    authoringModel: model,
    population: seed.population,
    prepassRefusalCause: null,
    properties: [{ propertyId: 'p1', outcome: outcomeFor(seed.shape) }],
    unexpressedCriteria: [],
    promptTokens: 0,
    completionTokens: 0,
    elapsedMs: 0,
    proofSpanMs: 0,
    toolchain: TOOLCHAIN,
    formalOracleVersion: 1,
  };
}

/** The population and the decision shape, drawn independently of each other. */
function seedArbitrary(): fc.Arbitrary<DesignSeed> {
  return fc.record<DesignSeed>({
    population: fc.constantFrom(...POPULATIONS),
    shape: fc.constantFrom(...DECISION_SHAPES),
  });
}

/** One model's designs over the given ids, one seed per id so no id repeats. */
function designsArbitrary(
  model: string,
  ids: readonly string[],
): fc.Arbitrary<readonly PropertyOnlyDesignResult[]> {
  return fc
    .tuple(...ids.map(() => seedArbitrary()))
    .map((seeds) => seeds.map((seed, index) => designOf(model, ids[index] ?? '', seed)));
}

/** A full run records every scored design; a short one records a distinct subset of them. */
function idsArbitrary(full: boolean): fc.Arbitrary<readonly string[]> {
  return full
    ? fc.constant(DESIGN_IDS)
    : fc.uniqueArray(fc.constantFrom(...DESIGN_IDS), { minLength: 1, maxLength: SHORT_MAX });
}

/** The whole measurement: one or two models over the same recorded design set. */
function measurementArbitrary(): fc.Arbitrary<PropertyOnlyMeasurement> {
  return fc
    .tuple(
      fc.subarray([...AUTHORING_MODELS], { minLength: 1 }),
      // One draw in four records the whole scored corpus; the rest are short of it.
      fc.constantFrom(true, false, false, false),
      fc.subarray(Object.values(DECLARED_LIMITS), { minLength: 1 }),
    )
    .chain(([models, full, limits]) =>
      idsArbitrary(full)
        .chain((ids) => fc.tuple(...models.map((model) => designsArbitrary(model, ids))))
        .map((blocks): PropertyOnlyMeasurement => ({
          schemaVersion: PROPERTY_ONLY_SCHEMA_VERSION,
          runName: 'property-only-partition',
          measurementKind: PROPERTY_ONLY_MEASUREMENT_KIND,
          omittedStudentPathSteps: ['Testbench_Agent', 'Instrument_Admission'],
          results: blocks.flat(),
          limits,
        })),
    );
}

// ---------------------------------------------------------------------------
// The independent oracle over the record
// ---------------------------------------------------------------------------

/** The designs one model recorded, in the order the record holds them. */
function designsOf(
  measurement: PropertyOnlyMeasurement,
  model: string,
): readonly PropertyOnlyDesignResult[] {
  return measurement.results.filter((design) => design.authoringModel === model);
}

/** Every model the record names, each exactly once, in first-appearance order. */
function modelsOf(measurement: PropertyOnlyMeasurement): readonly string[] {
  return [...new Set(measurement.results.map((design) => design.authoringModel))];
}

/** Designs an oracle invocation decided at least one property of. */
function decided(
  designs: readonly PropertyOnlyDesignResult[],
): readonly PropertyOnlyDesignResult[] {
  return designs.filter((design) =>
    design.properties.some((property) => property.outcome.kind === 'measured'),
  );
}

/**
 * Designs whose every decided property came back proved, read independently of the renderer.
 *
 * Restated here rather than imported: `report.ts` keeps this private, and a shared helper would
 * make the claim and the thing it checks the same code.
 */
function proved(designs: readonly PropertyOnlyDesignResult[]): readonly PropertyOnlyDesignResult[] {
  return decided(designs).filter((design) =>
    design.properties
      .filter((property) => property.outcome.kind === 'measured')
      .every(
        (property) => property.outcome.kind === 'measured' && property.outcome.verdict === 'proved',
      ),
  );
}

/** The admitted half of one model's designs, which is the rate's whole population. */
function admittedOf(
  designs: readonly PropertyOnlyDesignResult[],
): readonly PropertyOnlyDesignResult[] {
  return designs.filter((design) => design.population === 'admitted');
}

// ---------------------------------------------------------------------------
// Reading the rendered report
// ---------------------------------------------------------------------------

/** One Authoring_Model's rendered block, found by its own heading rather than by line number. */
function blockOf(lines: readonly string[], model: string): readonly string[] {
  const start = lines.indexOf(`authoring model: ${model}`);
  expect(start, `no rendered block for ${model}`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => line.startsWith('authoring model: '));
  return next === -1 ? rest : rest.slice(0, next);
}

/** The value of one labelled line, matched on the label so a new sibling row cannot shift it. */
function labelled(block: readonly string[], label: string): string {
  const line = block.find((entry) => entry.trimStart().startsWith(`${label}:`));
  expect(line, `no ${label} line in the rendered block`).toBeTypeOf('string');
  return (line ?? '')
    .trimStart()
    .slice(label.length + 1)
    .trim();
}

/** The two population sizes the block names, which is where a count states its population. */
const POPULATION_LINE =
  /^(\d+) design\(s\) recorded - (\d+) Admitted_Population, (\d+) Refused_Population$/;

/** The rendered ratio, where one was rendered at all. */
const RATE = /\((\d+)\/(\d+) decided design\(s\)\)/;

/** A ratio as the renderer printed it, or null where it rendered NOT MEASURED instead. */
function renderedRate(
  value: string,
): { readonly numerator: number; readonly denominator: number } | null {
  const match = RATE.exec(value);
  return match === null ? null : { numerator: Number(match[1]), denominator: Number(match[2]) };
}

// ---------------------------------------------------------------------------
// The rows the run must have reached
// ---------------------------------------------------------------------------

/** Rows proving the generated populations were mixed rather than uniform. */
const MIXED_ROWS: readonly string[] = [
  'population:admitted',
  'population:refused',
  'model:both-populations',
  'model:no-admitted-design',
  'coverage:full',
  'coverage:short',
];

/**
 * Rows proving a population-blind denominator would have been a DIFFERENT number.
 *
 * Each row is a draw on which one wrong denominator or numerator diverges from the rendered one,
 * so the membership assertions above would have gone red had the renderer used it.
 */
const DENOMINATOR_ROWS: readonly string[] = [
  'wrong:refused-in-denominator',
  'wrong:refused-in-numerator',
  'wrong:admitted-size-as-denominator',
  'wrong:recorded-size-as-denominator',
];

/** Which mixed rows one model's designs reached. */
function mixedRowsOf(
  designs: readonly PropertyOnlyDesignResult[],
  full: boolean,
): readonly string[] {
  const admitted = admittedOf(designs);
  return [
    ...designs.map((design) => `population:${design.population}`),
    ...(admitted.length > 0 && admitted.length < designs.length ? ['model:both-populations'] : []),
    ...(admitted.length === 0 ? ['model:no-admitted-design'] : []),
    full ? 'coverage:full' : 'coverage:short',
  ];
}

/** Which wrong-denominator rows one model's designs would expose. */
function wrongRowsOf(designs: readonly PropertyOnlyDesignResult[]): readonly string[] {
  const admitted = admittedOf(designs);
  const denominator = decided(admitted).length;
  const numerator = proved(admitted).length;
  return [
    ...(decided(designs).length !== denominator ? ['wrong:refused-in-denominator'] : []),
    ...(proved(designs).length !== numerator ? ['wrong:refused-in-numerator'] : []),
    ...(admitted.length !== denominator ? ['wrong:admitted-size-as-denominator'] : []),
    ...(designs.length !== denominator ? ['wrong:recorded-size-as-denominator'] : []),
  ];
}

// ---------------------------------------------------------------------------
// The generated departure from the population field
// ---------------------------------------------------------------------------

/** The three ways a design fails to carry exactly one population member. */
const DEPARTURES = ['absent', 'unknown-member', 'both-members'] as const;

type Departure = (typeof DEPARTURES)[number];

/** The encoded document with one design's population departed from, in place. */
function departPopulation(document: unknown, index: number, departure: Departure): void {
  const results = (document as { readonly results: Record<string, unknown>[] }).results;
  const design = results[index];
  if (design === undefined) {
    throw new Error(`no design at index ${index}`);
  }
  if (departure === 'absent') {
    Reflect.deleteProperty(design, 'population');
    return;
  }
  design.population = departure === 'unknown-member' ? 'partially-admitted' : [...POPULATIONS];
}

// ---------------------------------------------------------------------------
// Property 13
// ---------------------------------------------------------------------------

describe(PROPERTY, () => {
  it('given any measurement, then every decoded design carries exactly one population member', () => {
    fc.assert(
      fc.property(
        measurementArbitrary(),
        fc.nat(),
        fc.constantFrom(...DEPARTURES),
        (measurement, offset, departure) => {
          const encoded = encodePropertyOnlyMeasurement(measurement);

          // The positive control, asserted first: without the departure the record decodes, so
          // a draw that failed to depart would fail the refusal below rather than pass it.
          const decoded = decodePropertyOnlyMeasurement(encoded);
          expect(decoded).toEqual(measurement);
          for (const design of decoded?.results ?? []) {
            expect(POPULATIONS.filter((member) => member === design.population)).toHaveLength(1);
          }

          const document = JSON.parse(encoded) as unknown;
          departPopulation(document, offset % measurement.results.length, departure);

          expect(decodePropertyOnlyMeasurement(document), departure).toBeNull();
        },
      ),
      propertyParameters({ numRuns: NUM_RUNS }),
    );
  });

  it("given any measurement, then the two populations partition each model's recorded set", () => {
    const seen = new Set<string>();

    fc.assert(
      fc.property(measurementArbitrary(), (measurement) => {
        const lines = renderPropertyOnlyReport(measurement);

        for (const model of modelsOf(measurement)) {
          const designs = designsOf(measurement, model);
          const admitted = admittedOf(designs);
          const refused = designs.filter((design) => design.population === 'refused');
          for (const row of mixedRowsOf(designs, designs.length === RTLLM_SCORED_DESIGN_COUNT)) {
            seen.add(row);
          }

          // Disjoint and exhaustive: no design is in both halves, and none is in neither.
          expect(admitted.filter((design) => refused.includes(design))).toHaveLength(0);
          expect(admitted.length + refused.length).toBe(designs.length);
          expect(new Set(designs.map((design) => design.designId)).size).toBe(designs.length);

          const block = blockOf(lines, model);
          const match = POPULATION_LINE.exec(labelled(block, 'population'));
          expect(match, 'the block names both population sizes').not.toBeNull();
          expect(match?.slice(1, 4).map(Number)).toEqual([
            designs.length,
            admitted.length,
            refused.length,
          ]);

          // The union against the scored set: covered, or reported as short of it.
          const floor = labelled(block, 'refusal floor');
          const covered = block.join('\n').includes(', all recorded.');
          expect(covered).toBe(designs.length === RTLLM_SCORED_DESIGN_COUNT);
          expect(floor).toContain(`${refused.length}/${designs.length}`);
        }
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    for (const row of MIXED_ROWS) {
      expect(seen.has(row), `no draw reached ${row}`).toBe(true);
    }
  });

  it('given any measurement, then the rendered rate excludes every refused design', () => {
    const seen = new Set<string>();

    fc.assert(
      fc.property(measurementArbitrary(), (measurement) => {
        const lines = renderPropertyOnlyReport(measurement);

        for (const model of modelsOf(measurement)) {
          const designs = designsOf(measurement, model);
          const admitted = admittedOf(designs);
          for (const row of wrongRowsOf(designs)) {
            seen.add(row);
          }

          const value = labelled(blockOf(lines, model), 'property-only');
          const rendered = renderedRate(value);
          const denominator = decided(admitted).length;

          if (denominator === 0) {
            expect(rendered, 'an undecided population renders no ratio').toBeNull();
            expect(value).toContain('NOT MEASURED');
            continue;
          }
          expect(rendered).toEqual({ numerator: proved(admitted).length, denominator });
          expect(value).toContain((proved(admitted).length / denominator).toFixed(3));
        }
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    for (const row of DENOMINATOR_ROWS) {
      expect(seen.has(row), `no draw would have exposed ${row}`).toBe(true);
    }
  });
});
