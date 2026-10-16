// formal-gate-first-light, Property 29: a property-only figure is labelled, scoped, and never
// merged (task 11.9).
//
// WHAT IS CLAIMED, OVER WHAT
//   LABELLED. The report names the record's own `measurementKind` and denies in the same line
//     that the figure is an End_To_End_Formal_Rate (Req 9.1).
//   SCOPED. The report names EVERY Student_Path step the record says this path omitted, in the
//     record's own order, and renders Not_Measured where the record names none (Req 9.2). A
//     renderer that printed only the first step, or dropped the line, fails here.
//   NEVER MERGED. Over a pair of a Property_Only_Measurement and an End_To_End_Formal_Rate, each
//     block renders exactly two figures - the property-only one over the Admitted_Population, and
//     the end-to-end one, Not_Measured, over the Student_Path's own - and no third (Req 9.3).
//
// HOW "NO THIRD FIGURE" IS GIVEN TEETH
//   Asserting that two figures EXIST is the weak form: a third one can sit beside them. So the
//   claim is an exact pin on three surfaces at once.
//     1. LABELS. Every figure label in every block comes from the closed set `FIGURE_LABELS`, with
//        no duplicate. A combined figure has to be labelled something, and anything it is labelled
//        fails this.
//     2. RATES, ORDERED, DOCUMENT-WIDE. Every three-decimal value the whole document prints, in
//        order, equals the list this file computes from the record over ONE population at a time.
//        A third figure that prints a number fails whatever it is called and wherever it sits, and
//        an honest figure that went missing fails too.
//     3. POPULATIONS. The property-only figure names the Admitted_Population, the end-to-end one
//        names the Student_Path, and no figure names both.
//
// THE THREE MERGE CANDIDATES, AND WHY A PAIR IS GENERATED
//   A merge is a denominator that spans two populations, so the test computes what each possible
//   merge WOULD print and requires it absent: the rate over a model's whole recorded population
//   (the Admitted_Population merged with the Refused_Population, which Req 9.12 forbids), the rate
//   pooled across the Authoring_Models, and the rate merging this record's decided population with
//   the generated End_To_End_Formal_Rate's own. The third is why the property is stated over a
//   PAIR. `renderPropertyOnlyReport` takes no sweep result, which is Component 9's structural
//   argument, so that candidate can only be printed by coincidence - and the exclusion is
//   therefore only asserted where the candidate is DISTINCT from every honest value, with the
//   distinctness itself asserted as a non-vacuity row rather than assumed.
//
// HOW EACH ROW IS MADE REACHABLE
//   One `DesignKind` per design, drawn independently, each leaving one more filter a sibling figure
//   uses: refused leaves the Admitted_Population, undecided leaves the rate's denominator while
//   staying admitted, refuted stays in the denominator and out of the numerator, and unprovenanced
//   leaves the reproducible set. A single base design would make every one of those filters the
//   identity and the figures indistinguishable
//   (`chipAgent/_inbox/gotcha-an-aggregation-property-whose-population-holds-every-other-field-constant-cannot-see-a-count-taken-over-a-sub-population.md`).
//
// NOT CLAIMED HERE
//   The empty record, which renders a header and one line and so has no block to hold two figures;
//   the full-corpus coverage branch, which needs 46 designs and prints no rate either way. Both
//   are example tests in `app/eval/property-only/report.test.ts`.
//
// The tag is a literal because `propertyTag` hardcodes another spec's slug.
//
// **Validates: Requirements 9.1, 9.2, 9.3**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DECLARED_LIMITS,
  PROPERTY_ONLY_MEASUREMENT_KIND,
  PROPERTY_ONLY_SCHEMA_VERSION,
  renderPropertyOnlyReport,
  type ManifestToolchain,
  type PropertyOnlyDesignResult,
  type PropertyOnlyMeasurement,
} from '@app/eval';

import { propertyParameters } from './property.js';

// Feature: formal-gate-first-light, Property 29: A property-only figure is labelled, scoped, and never merged
const PROPERTY =
  'formal-gate-first-light, Property 29: A property-only figure is labelled, scoped, and never merged';

/**
 * Sized to the rarest required row, the record that names no omitted step at all.
 *
 * `fc.subarray` over the two steps draws the empty subset on the order of a tenth of its draws, so
 * at 200 runs the row is missed with probability about 0.9^200 ~ 7e-10. Every other row is at least
 * a fifth of draws: a design kind is one in five per design, a two-model record one in three.
 */
const NUM_RUNS = 200;

/** The one token for a count nobody took, as `app/eval/property-only/report.ts` spells it. */
const NOT_MEASURED = 'NOT MEASURED';

/** The column every continuation line indents to; a line starting here continues the one above. */
const CONTINUATION = ' '.repeat(19);

/** How many decimal places a rendered rate carries, which is what makes it findable as one. */
const RATE_DIGITS = 3;

/** Every three-decimal value in the document, which is every rate and nothing else. */
const RATE_PATTERN = /\d+\.\d{3}(?!\d)/g;

/** Render a rate the way the renderer does, so a match is a byte comparison. */
function rate(value: number): string {
  return value.toFixed(RATE_DIGITS);
}

/** Every rate the given text prints, in the order it prints them. */
function ratesIn(text: string): readonly string[] {
  return [...text.matchAll(RATE_PATTERN)].map((match) => match[0]);
}

// ---------------------------------------------------------------------------
// The generated pair
// ---------------------------------------------------------------------------

const AUTHORING_MODELS = ['zai.glm-5', 'moonshotai.kimi-k2.5'] as const;

/** Every non-empty set of Authoring_Models, so a pooled figure has two blocks to pool across. */
const MODEL_SETS: readonly (readonly string[])[] = [
  [AUTHORING_MODELS[0]],
  [AUTHORING_MODELS[1]],
  [AUTHORING_MODELS[0], AUTHORING_MODELS[1]],
];

const DESIGN_IDS = [
  'rtllm/arithmetic/adder_8bit',
  'rtllm/control/fsm_binary',
  'rtllm/miscellaneous/freq_divbyodd',
] as const;

/** Kept at or below the `cost-pilot-design-count` of 3, so a short block is a bound, not a stop. */
const MAX_DESIGNS = DESIGN_IDS.length;

const RUN_NAMES = ['property-only-v1', 'property-only-cost-pilot'] as const;

/** The Student_Path steps a property-only run omits (Req 9.2). */
const OMITTED_STEPS = ['Testbench_Agent', 'Instrument_Admission'] as const;

/** The scored corpus size, which also bounds the generated end-to-end population. */
const MAX_POPULATION = 46;

/**
 * The five shapes one design comes in, each leaving one more filter a sibling figure uses.
 *
 * `undecided` is admitted with nothing the oracle decided, so it is out of the rate's denominator
 * but inside the Admitted_Population; `unprovenanced` is a decided design whose toolchain answered
 * nothing, so it is out of the reproducible set alone.
 */
const DESIGN_KINDS = ['proved', 'refuted', 'undecided', 'refused', 'unprovenanced'] as const;

type DesignKind = (typeof DESIGN_KINDS)[number];

/** A toolchain that answered, so a block over it is reproducible. */
const READ_TOOLCHAIN: ManifestToolchain = {
  iverilogVersion: '13.0',
  vvpVersion: '13.0',
  workerPython: null,
  yosysVersion: { kind: 'read', value: '0.69+post' },
  yosysBuildId: { kind: 'read', value: '143eb14f' },
  yosysSmtBmcVersion: { kind: 'not-measured', reason: 'answers --version with usage' },
  bitwuzlaVersion: { kind: 'read', value: '0.9.1' },
  z3Version: { kind: 'read', value: '4.15.4' },
};

/** A toolchain no member of which answered: a record carrying no Toolchain_Provenance. */
const UNREAD_TOOLCHAIN: ManifestToolchain = {
  iverilogVersion: null,
  vvpVersion: null,
  workerPython: null,
  yosysVersion: { kind: 'not-measured', reason: 'not on PATH' },
  yosysBuildId: { kind: 'not-measured', reason: 'not on PATH' },
  yosysSmtBmcVersion: { kind: 'not-measured', reason: 'not on PATH' },
  bitwuzlaVersion: { kind: 'not-measured', reason: 'not on PATH' },
  z3Version: { kind: 'not-measured', reason: 'not on PATH' },
};

/** The five Proof_Conditions behind a verdict; no figure in this report reads them. */
const CONDITIONS = {
  assertionCount: 1,
  presat: 'satisfiable',
  cover: { reached: true, step: 3 },
  base: 'passed',
  induction: 'successful',
} as const;

/** The provenance figures every design carries; integers, so none of them prints as a rate. */
const PROVENANCE = {
  unexpressedCriteria: [],
  promptTokens: 1200,
  completionTokens: 340,
  elapsedMs: 8123,
  proofSpanMs: 4100,
  formalOracleVersion: 2,
} as const;

/** One design in the shape its kind names. */
function designOf(
  kind: DesignKind,
  designId: string,
  authoringModel: string,
): PropertyOnlyDesignResult {
  const base = { ...PROVENANCE, designId, authoringModel };
  if (kind === 'refused') {
    return {
      ...base,
      population: 'refused',
      prepassRefusalCause: 'clock-contract-unsupported',
      properties: [
        {
          propertyId: 'p1',
          outcome: { kind: 'not-measured', reason: 'the pre-pass refused before any solver ran' },
        },
      ],
      toolchain: READ_TOOLCHAIN,
    };
  }
  if (kind === 'undecided') {
    return {
      ...base,
      population: 'admitted',
      prepassRefusalCause: null,
      properties: [
        {
          propertyId: 'p1',
          outcome: { kind: 'not-measured', reason: 'the toolchain was unavailable' },
        },
      ],
      toolchain: READ_TOOLCHAIN,
    };
  }
  return {
    ...base,
    population: 'admitted',
    prepassRefusalCause: null,
    properties: [
      {
        propertyId: 'p1',
        outcome: {
          kind: 'measured',
          verdict: kind === 'refuted' ? 'refuted' : 'proved',
          couldNotVerifyCause: null,
          crossCheckDisagreed: false,
          conditions: CONDITIONS,
        },
      },
    ],
    toolchain: kind === 'unprovenanced' ? UNREAD_TOOLCHAIN : READ_TOOLCHAIN,
  };
}

/** One model's designs, one per drawn kind. */
function designsOf(
  model: string,
  kinds: readonly DesignKind[],
): readonly PropertyOnlyDesignResult[] {
  return kinds.map((kind, index) => designOf(kind, DESIGN_IDS[index] ?? DESIGN_IDS[0], model));
}

/** Every design result, grouped by model in the order the blocks will be rendered in. */
function resultsArbitrary(): fc.Arbitrary<readonly PropertyOnlyDesignResult[]> {
  const kindsPerModel = fc.array(fc.constantFrom(...DESIGN_KINDS), {
    minLength: 1,
    maxLength: MAX_DESIGNS,
  });
  return fc
    .constantFrom(...MODEL_SETS)
    .chain((models) =>
      fc
        .array(kindsPerModel, { minLength: models.length, maxLength: models.length })
        .map((drawn) => models.flatMap((model, index) => designsOf(model, drawn[index] ?? []))),
    );
}

/** The whole measurement, its limits drawn from the declared registry rather than invented. */
function measurementArbitrary(): fc.Arbitrary<PropertyOnlyMeasurement> {
  return fc.record<PropertyOnlyMeasurement>({
    schemaVersion: fc.constant(PROPERTY_ONLY_SCHEMA_VERSION),
    runName: fc.constantFrom(...RUN_NAMES),
    measurementKind: fc.constant(PROPERTY_ONLY_MEASUREMENT_KIND),
    omittedStudentPathSteps: fc.subarray([...OMITTED_STEPS]),
    results: resultsArbitrary(),
    limits: fc.subarray(Object.values(DECLARED_LIMITS), { minLength: 1 }),
  });
}

/**
 * An End_To_End_Formal_Rate over the Student_Path's own population, as a rate with its denominator.
 *
 * This record holds none, which is the point: it exists here only to compute what a figure merging
 * the two populations would print.
 */
interface EndToEndFormalRate {
  readonly passed: number;
  readonly population: number;
}

function endToEndArbitrary(): fc.Arbitrary<EndToEndFormalRate> {
  return fc
    .integer({ min: 1, max: MAX_POPULATION })
    .chain((population) => fc.nat({ max: population }).map((passed) => ({ passed, population })));
}

// ---------------------------------------------------------------------------
// What the record says, computed here rather than read off the report
// ---------------------------------------------------------------------------

/** One model's populations, counted independently of the renderer that reports them. */
interface ModelFacts {
  readonly model: string;
  readonly recorded: number;
  readonly refused: number;
  /** Admitted designs holding at least one property a Deterministic_Oracle decided. */
  readonly decided: number;
  readonly proved: number;
}

/** Whether the oracle proved everything it decided on this design. */
function allMeasuredProved(design: PropertyOnlyDesignResult): boolean {
  const measured = design.properties.filter((one) => one.outcome.kind === 'measured');
  return (
    measured.length > 0 &&
    measured.every((one) => one.outcome.kind === 'measured' && one.outcome.verdict === 'proved')
  );
}

/** Each model's facts, in first-appearance order, which is the order the blocks come in. */
function factsOf(results: readonly PropertyOnlyDesignResult[]): readonly ModelFacts[] {
  return [...new Set(results.map((result) => result.authoringModel))].map((model) => {
    const own = results.filter((result) => result.authoringModel === model);
    const admitted = own.filter((result) => result.population === 'admitted');
    const decided = admitted.filter((result) =>
      result.properties.some((one) => one.outcome.kind === 'measured'),
    );
    return {
      model,
      recorded: own.length,
      refused: own.length - admitted.length,
      decided: decided.length,
      proved: decided.filter(allMeasuredProved).length,
    };
  });
}

/**
 * Every rate the report may print, in render order: each model's property-only figure over its
 * decided population, then its refusal floor over its whole recorded one.
 */
function honestRates(facts: readonly ModelFacts[]): readonly string[] {
  return facts.flatMap((model) => [
    ...(model.decided === 0 ? [] : [rate(model.proved / model.decided)]),
    rate(model.refused / model.recorded),
  ]);
}

/** One rate a merged figure would print, and the merge that would have produced it. */
interface MergeCandidate {
  readonly kind: 'recorded' | 'pooled' | 'end-to-end';
  readonly value: string;
}

/** What each possible merge of two populations would print. */
function mergeCandidates(
  facts: readonly ModelFacts[],
  endToEnd: EndToEndFormalRate,
): readonly MergeCandidate[] {
  const decided = facts.reduce((total, model) => total + model.decided, 0);
  const proved = facts.reduce((total, model) => total + model.proved, 0);
  return [
    // The Admitted_Population merged with the Refused_Population, which Req 9.12 forbids.
    ...facts
      .filter((model) => model.recorded !== model.decided)
      .map((model): MergeCandidate => ({
        kind: 'recorded',
        value: rate(model.proved / model.recorded),
      })),
    // One rate pooled across the Authoring_Models, which describes neither of them (Req 5.14).
    ...(facts.length > 1 && decided > 0
      ? [{ kind: 'pooled', value: rate(proved / decided) } as const]
      : []),
    // This record's population merged with the Student_Path's own, which Req 9.3 forbids.
    ...facts.map((model): MergeCandidate => ({
      kind: 'end-to-end',
      value: rate((model.proved + endToEnd.passed) / (model.decided + endToEnd.population)),
    })),
  ];
}

// ---------------------------------------------------------------------------
// The report, parsed back into its figures
// ---------------------------------------------------------------------------

/** Every label a figure line in a block carries; a label outside this set is a third figure. */
const FIGURE_LABELS: readonly string[] = [
  'population',
  'property-only',
  'end-to-end',
  'refusal floor',
  'properties',
  'no verdict',
  'reproducible',
  // The pilot comparison, which is a reported figure and stops no run (Req 5.22).
  'wall clock',
  'limit',
  'STOPPED',
];

/** One figure: its label, and its value together with every line continuing it. */
interface Figure {
  readonly label: string;
  readonly text: string;
}

/** One Authoring_Model's block. */
interface Block {
  readonly model: string;
  readonly figures: readonly Figure[];
}

const MODEL_PREFIX = 'authoring model: ';

/** The label and value a figure line carries, or null where the line is not one. */
function figureLineOf(line: string): Figure | null {
  const colon = line.indexOf(':');
  return colon === -1 ? null : { label: line.slice(2, colon), text: line.slice(colon + 1).trim() };
}

/**
 * The blocks the report rendered, with every line of the block region accounted for.
 *
 * Total on purpose: a line in a block region that is neither a model header, a figure line, nor a
 * continuation throws rather than being dropped, so a third figure cannot hide by being shaped
 * unlike the rest.
 */
function parseBlocks(lines: readonly string[]): readonly Block[] {
  const blocks: { model: string; figures: Figure[] }[] = [];
  for (const line of lines) {
    const current = blocks.at(-1);
    if (line.startsWith(MODEL_PREFIX)) {
      blocks.push({ model: line.slice(MODEL_PREFIX.length), figures: [] });
    } else if (current === undefined || line === '') {
      continue; // The header region, and the blank line opening each block.
    } else if (line.startsWith(CONTINUATION)) {
      const figure = current.figures.at(-1);
      if (figure === undefined) {
        throw new Error(`a continuation opened a block: ${line}`);
      }
      current.figures[current.figures.length - 1] = {
        label: figure.label,
        text: `${figure.text}\n${line.trim()}`,
      };
    } else {
      const figure = line.startsWith('  ') ? figureLineOf(line) : null;
      if (figure === null) {
        throw new Error(`a line inside a block is neither a figure nor a continuation: ${line}`);
      }
      current.figures.push(figure);
    }
  }
  return blocks;
}

/** The one figure carrying `label`, or a failure naming the label that went missing. */
function figure(block: Block, label: string): Figure {
  const found = block.figures.filter((one) => one.label === label);
  expect(found, `block ${block.model} renders one ${label} figure`).toHaveLength(1);
  return found[0] ?? { label, text: '' };
}

// ---------------------------------------------------------------------------
// Property 29
// ---------------------------------------------------------------------------

describe(PROPERTY, () => {
  it('given any measurement, when rendered, then it is labelled property-only and scoped to the steps it omitted', () => {
    const seen = new Set<string>();

    fc.assert(
      fc.property(measurementArbitrary(), (measurement) => {
        const lines = renderPropertyOnlyReport(measurement);
        const { measurementKind, omittedStudentPathSteps } = measurement;
        seen.add(omittedStudentPathSteps.length === 0 ? 'omitted:none' : 'omitted:named');

        // LABELLED: the kind is named, and the line denies the figure is the other one.
        expect(lines).toContain(
          `MEASUREMENT KIND: ${measurementKind} - this is NOT an End_To_End_Formal_Rate`,
        );

        // SCOPED: every omitted step, in the record's order, or the untaken token where none.
        expect(lines).toContain(
          `Student_Path steps this path omitted: ${
            omittedStudentPathSteps.length === 0
              ? `${NOT_MEASURED} - the record names no omitted step`
              : omittedStudentPathSteps.join(', ')
          }`,
        );
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    for (const row of ['omitted:none', 'omitted:named']) {
      expect(seen.has(row), `no measurement exercised ${row}`).toBe(true);
    }
  });

  it('given any pair of a property-only measurement and an end-to-end rate, when rendered, then two figures stay separate and no third is rendered', () => {
    const seen = new Set<string>();

    fc.assert(
      fc.property(measurementArbitrary(), endToEndArbitrary(), (measurement, endToEnd) => {
        const lines = renderPropertyOnlyReport(measurement);
        const facts = factsOf(measurement.results);
        const blocks = parseBlocks(lines);
        seen.add(facts.length > 1 ? 'models:two' : 'models:one');

        // One block per model and no aggregate block beside them.
        expect(blocks.map((block) => block.model)).toEqual(facts.map((model) => model.model));

        for (const [index, block] of blocks.entries()) {
          const model = facts[index];
          if (model === undefined) {
            throw new Error('a block was rendered for a model the record does not hold');
          }
          seen.add(model.decided === 0 ? 'figure:not-measured' : 'figure:rate');
          seen.add(model.refused === 0 ? 'refused:none' : 'refused:some');
          seen.add(
            block.figures.some((one) => one.label === 'reproducible')
              ? 'prov:missing'
              : 'prov:read',
          );
          seen.add(
            block.figures.some((one) => one.label === 'STOPPED')
              ? 'coverage:stopped'
              : 'coverage:bounded',
          );

          // 1. LABELS: every figure is one of the known ones, named once.
          const labels = block.figures.map((one) => one.label);
          expect(labels.filter((label) => !FIGURE_LABELS.includes(label))).toEqual([]);
          expect(new Set(labels).size).toBe(labels.length);

          // 3. POPULATIONS: each figure names its own, and no figure names both.
          const propertyOnly = figure(block, 'property-only');
          const endToEndFigure = figure(block, 'end-to-end');
          expect(propertyOnly.text).toContain('Admitted_Population');
          expect(endToEndFigure.text).toContain('Student_Path');
          expect(endToEndFigure.text).toContain(NOT_MEASURED);
          if (model.decided === 0) {
            expect(propertyOnly.text).toContain(NOT_MEASURED);
          }
          for (const one of block.figures) {
            expect(
              one.text.includes('Admitted_Population') && one.text.includes('Student_Path'),
              `the ${one.label} figure names both populations`,
            ).toBe(false);
          }
        }

        // 2. RATES: every rate the document prints, in order, over one population each.
        const rendered = ratesIn(lines.join('\n'));
        expect(rendered).toEqual(honestRates(facts));

        // No merge is printed. Only asserted where the merged value is distinct from every
        // honest one, because an equal value is a coincidence and not a merge.
        const honest = new Set(rendered);
        for (const candidate of mergeCandidates(facts, endToEnd)) {
          if (honest.has(candidate.value)) {
            continue;
          }
          seen.add(`merge-distinct:${candidate.kind}`);
          expect(rendered, `a ${candidate.kind} merge was printed`).not.toContain(candidate.value);
        }
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    for (const row of [
      'models:one',
      'models:two',
      'figure:rate',
      'figure:not-measured',
      'refused:none',
      'refused:some',
      'prov:missing',
      'prov:read',
      'coverage:stopped',
      'coverage:bounded',
      'merge-distinct:recorded',
      'merge-distinct:pooled',
      'merge-distinct:end-to-end',
    ]) {
      expect(seen.has(row), `no pair exercised ${row}`).toBe(true);
    }
  });
});
