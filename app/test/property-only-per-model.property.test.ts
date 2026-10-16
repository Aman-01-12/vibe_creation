// formal-gate-first-light, Property 14: every figure the property-only report renders belongs
// to exactly one Authoring_Model (task 11.8).
//
// WHAT IS CLAIMED, OVER WHAT
//   1. ATTRIBUTION IN THE RECORD. Every design result names its own Authoring_Model (Req 5.12),
//      and every design is covered by at least two distinct models, the two Req 5.11 names among
//      them.
//   2. ATTRIBUTION IN THE REPORT. `renderPropertyOnlyReport` opens exactly one block per model,
//      every figure a block renders is the figure derived from THAT model's designs alone
//      (Req 5.13), and no figure line sits outside a block.
//   3. NO POOLED FIGURE. Six of those figures also have a pooled form - the rate, the refusal
//      floor, and the four population counts - and no block renders the pooled value of any of
//      them (Req 5.14).
//
// HOW CLAIM 3 IS KEPT NON-VACUOUS
//   A pooled rate over models whose rates are EQUAL equals each model's own rate, and then "no
//   figure equals the pooled figure" holds for free while proving nothing. So `pooledIsDistinct`
//   filters the draw: a plan set whose pooled rate or pooled refusal floor renders as a string
//   some model also renders is rejected. The four pooled counts need no filter - every model
//   contributes at least one design to each, so each pooled count exceeds every model's own.
//   Every run then asserts that distinctness as its POSITIVE CONTROL before testing for absence,
//   so a filter that stopped working goes red rather than quiet.
//   The verdict tally and the no-verdict count are deliberately outside claim 3: a model may
//   legitimately render `proved 0`, which equals the pooled count when no other model proved
//   anything either, so an absence claim there would be unsound. Claim 2 covers them, and it
//   catches a pooled tally on every draw where another model contributed to it.
//
// WHAT THE GENERATOR VARIES, AND WHY ALL OF IT
//   The renderer filters its own population four ways - admitted against refused, measured
//   against not, each Formal_Verdict, and a toolchain that answered against one that did not -
//   and a figure taken over the wrong filter is invisible to a population that holds the other
//   fields constant
//   (`chipAgent/_inbox/gotcha-an-aggregation-property-whose-population-holds-every-other-field-constant-cannot-see-a-count-taken-over-a-sub-population.md`).
//   So each model's designs span all four, and each model keeps at least one refused design and
//   at least one decided one. The design count also crosses the renderer's two coverage shapes,
//   a run that reached its declared bound and a run short of the corpus without one, because
//   both name a per-model count. Token counts and wall clock are constant: no figure reads them.
//
// The tag is a literal because `propertyTag` hardcodes another spec's slug.
//
// **Validates: Requirements 5.11, 5.12, 5.13, 5.14**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DECLARED_LIMITS,
  PROPERTY_ONLY_MEASUREMENT_KIND,
  PROPERTY_ONLY_SCHEMA_VERSION,
  renderPropertyOnlyReport,
  type ManifestToolchain,
  type MeasurementLimit,
  type PropertyOnlyDesignResult,
  type PropertyOnlyMeasurement,
  type PropertyOnlyPropertyResult,
} from '@app/eval';
import { FORMAL_VERDICTS, type FormalVerdict, type ProofConditions } from '@app/tools';

import { propertyParameters } from './property.js';

// Feature: formal-gate-first-light, Property 14: Every figure belongs to exactly one Authoring_Model
const PROPERTY =
  'formal-gate-first-light, Property 14: Every figure belongs to exactly one Authoring_Model';

/**
 * Sized to the rarest required row.
 *
 * The bounded coverage shape needs the smallest design count, one draw in three, and a zero in
 * a given verdict's tally is about a quarter of models. At 200 runs, each is missed with
 * probability below 1e-30, and the pooled-distinctness control runs on every draw.
 */
const NUM_RUNS = 200;

/** How many decimal places the renderer reports a rate to. */
const RATE_DIGITS = 3;

// ---------------------------------------------------------------------------
// The population every draw is built from
// ---------------------------------------------------------------------------

/** The two Authoring_Models Req 5.11 names, which every generated measurement routes to. */
const REQUIRED_MODELS = ['zai.glm-5', 'moonshotai.kimi-k2.5'] as const;

/** A third model half the draws add, so no claim below is shaped around exactly two. */
const THIRD_MODEL = 'deepseek.v3.2';

/** The designs EVERY model covers, which is what makes each covered by at least two (Req 5.11). */
const DESIGN_IDS = [
  'rtllm/arithmetic/adder_8bit',
  'rtllm/arithmetic/multi_booth_8bit',
  'rtllm/control/fsm_binary',
  'rtllm/memory/LIFObuffer',
  'rtllm/miscellaneous/freq_divbyodd',
] as const;

/**
 * The design counts drawn, which straddle the declared design-count bound of 3.
 *
 * At the bound the renderer reports a run that reached a declared limit; above it, a run short
 * of the corpus with no such bound, which it reports as a suspected defect. Both shapes name a
 * per-model count, so both belong in this property's population.
 */
const MIN_DESIGNS = 3;
const MAX_DESIGNS = DESIGN_IDS.length;

/** The limits the run declares, the design-count bound among them so both shapes are reachable. */
const LIMITS: readonly MeasurementLimit[] = Object.values(DECLARED_LIMITS).filter(
  (limit) => limit.name === 'proof-depth' || limit.name === 'cost-pilot-design-count',
);

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

/** A toolchain no member of which answered: a record carrying no Toolchain_Provenance (Req 8.6). */
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

/** One set of Proof_Conditions, constant because no figure in the report reads them. */
const CONDITIONS: ProofConditions = {
  assertionCount: 1,
  presat: 'satisfiable',
  cover: { reached: true, step: 3 },
  base: 'passed',
  induction: 'successful',
};

/** The cause carried by a pre-pass refusal and by a `could-not-verify`; no figure reads it. */
const CAUSE = 'clock-contract-unsupported';

const PROMPT_TOKENS = 1200;
const COMPLETION_TOKENS = 340;
const ELAPSED_MS = 8123.5;
const FORMAL_ORACLE_VERSION = 2;

// ---------------------------------------------------------------------------
// The generated plan
// ---------------------------------------------------------------------------

/** What one design contributes to its model's figures. */
type Role = 'proved' | 'refuted' | 'could-not-verify' | 'undecided' | 'refused';

/** How many of one model's designs take each role, plus whether its toolchain answered. */
interface ModelPlan {
  readonly model: string;
  /** Admitted designs whose one property the oracle proved. */
  readonly proved: number;
  readonly refuted: number;
  readonly couldNotVerify: number;
  /** Admitted designs no oracle invocation decided, which leave the rate's denominator. */
  readonly undecided: number;
  /** Designs in the Refused_Population; at least one, so the refusal floor has a numerator. */
  readonly refused: number;
  /** When true, every design of this model carries no Toolchain_Provenance. */
  readonly unread: boolean;
}

type RoleCounts = Omit<ModelPlan, 'model' | 'unread'>;

/**
 * Split one model's designs across the five roles, constructively rather than by rejection.
 *
 * At least one design is refused and at least one is decided, so every model has a numerator for
 * its refusal floor and a denominator for its rate. The three verdicts are split by two cut
 * points over the decided designs, which reaches every one of the eight orderings of zero and
 * positive counts.
 */
function roleCountsArbitrary(designCount: number): fc.Arbitrary<RoleCounts> {
  return fc.integer({ min: 1, max: designCount - 1 }).chain((refused) => {
    const admitted = designCount - refused;
    return fc.integer({ min: 1, max: admitted }).chain((decided) =>
      fc
        .tuple(fc.integer({ min: 0, max: decided }), fc.integer({ min: 0, max: decided }))
        .map(([first, second]): RoleCounts => {
          const lower = Math.min(first, second);
          const upper = Math.max(first, second);
          return {
            proved: lower,
            refuted: upper - lower,
            couldNotVerify: decided - upper,
            undecided: admitted - decided,
            refused,
          };
        }),
    );
  });
}

/** One plan per model: the two required ones, and a third in about half the draws. */
function plansArbitrary(designCount: number): fc.Arbitrary<readonly ModelPlan[]> {
  const forModel = (model: string): fc.Arbitrary<ModelPlan> =>
    fc
      .record({ counts: roleCountsArbitrary(designCount), unread: fc.boolean() })
      .map(({ counts, unread }): ModelPlan => ({ model, unread, ...counts }));
  return fc
    .tuple(
      forModel(REQUIRED_MODELS[0]),
      forModel(REQUIRED_MODELS[1]),
      forModel(THIRD_MODEL),
      fc.boolean(),
    )
    .map(([first, second, third, withThird]) =>
      withThird ? [first, second, third] : [first, second],
    );
}

/** One run: the designs every model covers, and one plan per model. */
interface Draw {
  readonly designIds: readonly string[];
  readonly plans: readonly ModelPlan[];
}

/** A draw whose pooled rate and pooled refusal floor are values no model renders. */
function drawArbitrary(): fc.Arbitrary<Draw> {
  return fc
    .integer({ min: MIN_DESIGNS, max: MAX_DESIGNS })
    .chain((designCount) =>
      plansArbitrary(designCount).map((plans): Draw => ({
        designIds: DESIGN_IDS.slice(0, designCount),
        plans,
      })),
    )
    .filter(({ plans }) => pooledIsDistinct(plans));
}

// ---------------------------------------------------------------------------
// The figures, derived independently of the renderer
// ---------------------------------------------------------------------------

/** A rate as the renderer spells it, to its own three places. */
function rateText(numerator: number, denominator: number): string {
  return (numerator / denominator).toFixed(RATE_DIGITS);
}

/** Every figure one model's block renders, derived from that model's plan alone. */
interface BlockFigures {
  readonly recorded: number;
  readonly admitted: number;
  readonly refused: number;
  readonly rate: string;
  readonly provedDesigns: number;
  readonly decided: number;
  readonly floorNumerator: number;
  readonly floorDenominator: number;
  readonly floor: string;
  readonly tally: Readonly<Record<FormalVerdict, number>>;
  readonly noVerdict: number;
  readonly unprovenanced: number;
  readonly covered: number;
  readonly shortOf: number;
}

function figuresOf(plan: ModelPlan): BlockFigures {
  const decided = plan.proved + plan.refuted + plan.couldNotVerify;
  const admitted = decided + plan.undecided;
  const recorded = admitted + plan.refused;
  return {
    recorded,
    admitted,
    refused: plan.refused,
    rate: rateText(plan.proved, decided),
    provedDesigns: plan.proved,
    decided,
    floorNumerator: plan.refused,
    floorDenominator: recorded,
    floor: rateText(plan.refused, recorded),
    tally: { proved: plan.proved, refuted: plan.refuted, 'could-not-verify': plan.couldNotVerify },
    noVerdict: plan.undecided,
    unprovenanced: plan.unread ? recorded : 0,
    covered: recorded,
    shortOf: recorded,
  };
}

/** The six figures a renderer that pooled the models would produce, and none may render. */
interface PooledFigures {
  readonly recorded: number;
  readonly admitted: number;
  readonly refused: number;
  readonly decided: number;
  readonly rate: string;
  readonly floor: string;
}

function pooledFigures(plans: readonly ModelPlan[]): PooledFigures {
  const own = plans.map(figuresOf);
  const sum = (read: (figures: BlockFigures) => number): number =>
    own.reduce((total, figures) => total + read(figures), 0);
  const recorded = sum((figures) => figures.recorded);
  const refused = sum((figures) => figures.refused);
  const decided = sum((figures) => figures.decided);
  return {
    recorded,
    admitted: sum((figures) => figures.admitted),
    refused,
    decided,
    rate: rateText(
      sum((figures) => figures.provedDesigns),
      decided,
    ),
    floor: rateText(refused, recorded),
  };
}

/**
 * Whether the pooled rate and floor are strings no model renders.
 *
 * Checked at three places rather than on the raw ratio, because the claim is about what the
 * report EMITS: two rates that differ in the fourth place render as one string.
 */
function pooledIsDistinct(plans: readonly ModelPlan[]): boolean {
  const pooled = pooledFigures(plans);
  return plans.every((plan) => {
    const own = figuresOf(plan);
    return own.rate !== pooled.rate && own.floor !== pooled.floor;
  });
}

// ---------------------------------------------------------------------------
// The record a plan becomes
// ---------------------------------------------------------------------------

/** The one property an admitted design the oracle never reached carries (Req 11.2). */
const UNDECIDED_PROPERTY: PropertyOnlyPropertyResult = {
  propertyId: 'p1',
  outcome: { kind: 'not-measured', reason: 'no oracle invocation decided this property' },
};

/** One property the oracle decided, with the cause riding only on `could-not-verify`. */
function decidedProperty(verdict: FormalVerdict): PropertyOnlyPropertyResult {
  return {
    propertyId: 'p1',
    outcome:
      verdict === 'could-not-verify'
        ? {
            kind: 'measured',
            conditions: CONDITIONS,
            verdict,
            couldNotVerifyCause: CAUSE,
            crossCheckDisagreed: false,
          }
        : {
            kind: 'measured',
            conditions: CONDITIONS,
            verdict,
            couldNotVerifyCause: null,
            crossCheckDisagreed: false,
          },
  };
}

/** The property a design in `role` carries; the undecided and refused roles reach no oracle. */
function propertyFor(role: Role): PropertyOnlyPropertyResult {
  return role === 'undecided' || role === 'refused' ? UNDECIDED_PROPERTY : decidedProperty(role);
}

/** One design result, in the population and with the outcome its role gives it. */
function designFor(plan: ModelPlan, designId: string, role: Role): PropertyOnlyDesignResult {
  const isRefused = role === 'refused';
  return {
    designId,
    authoringModel: plan.model,
    population: isRefused ? 'refused' : 'admitted',
    prepassRefusalCause: isRefused ? CAUSE : null,
    properties: [propertyFor(role)],
    unexpressedCriteria: [],
    promptTokens: PROMPT_TOKENS,
    completionTokens: COMPLETION_TOKENS,
    elapsedMs: ELAPSED_MS,
    proofSpanMs: ELAPSED_MS,
    toolchain: plan.unread ? UNREAD_TOOLCHAIN : READ_TOOLCHAIN,
    formalOracleVersion: FORMAL_ORACLE_VERSION,
  };
}

/** One role per design, laid out in the order the plan's counts name them. */
function rolesOf(plan: ModelPlan): readonly Role[] {
  const repeated = (role: Role, count: number): readonly Role[] =>
    Array.from({ length: count }, () => role);
  return [
    ...repeated('proved', plan.proved),
    ...repeated('refuted', plan.refuted),
    ...repeated('could-not-verify', plan.couldNotVerify),
    ...repeated('undecided', plan.undecided),
    ...repeated('refused', plan.refused),
  ];
}

/** One model's design results, one per covered design. */
function designsOf(
  plan: ModelPlan,
  designIds: readonly string[],
): readonly PropertyOnlyDesignResult[] {
  const roles = rolesOf(plan);
  return designIds.flatMap((designId, position) => {
    const role = roles[position];
    return role === undefined ? [] : [designFor(plan, designId, role)];
  });
}

/**
 * Every design result of the run, INTERLEAVED across the models.
 *
 * One model's designs are deliberately not contiguous: a renderer that grouped by adjacency
 * rather than by `authoringModel` would still pass over a record laid out model by model.
 */
function resultsOf({ designIds, plans }: Draw): readonly PropertyOnlyDesignResult[] {
  const perModel = plans.map((plan) => designsOf(plan, designIds));
  return designIds.flatMap((_designId, position) =>
    perModel.flatMap((designs) => {
      const design = designs[position];
      return design === undefined ? [] : [design];
    }),
  );
}

function measurementOf(draw: Draw): PropertyOnlyMeasurement {
  return {
    schemaVersion: PROPERTY_ONLY_SCHEMA_VERSION,
    runName: 'property-only-per-model',
    measurementKind: PROPERTY_ONLY_MEASUREMENT_KIND,
    omittedStudentPathSteps: ['Testbench_Agent', 'Instrument_Admission'],
    results: resultsOf(draw),
    limits: LIMITS,
  };
}

// ---------------------------------------------------------------------------
// Reading the figures back off the rendered report
// ---------------------------------------------------------------------------

const BLOCK_HEADER = /^authoring model: (.+)$/;

const POPULATION =
  /^ {2}population: +(\d+) design\(s\) recorded - (\d+) Admitted_Population, (\d+) Refused_Population$/;
const RATE = /^ {2}property-only: +(\d\.\d{3}) {2}\((\d+)\/(\d+) decided design\(s\)\)$/;
const FLOOR =
  /^ {2}refusal floor: +(\d+)\/(\d+) = (\d\.\d{3}) refused by the Reset_Contract_Prepass/;
/** Built from the vocabulary, so a verdict added to it is read here rather than silently dropped. */
const TALLY = new RegExp(
  `^ {2}properties: +${FORMAL_VERDICTS.map((verdict) => `${verdict} (\\d+)`).join(' {2}')} over the Admitted_Population$`,
);
const NO_VERDICT = /^ {2}no verdict: +(\d+) property outcome\(s\)/;
const REPRODUCIBLE = /^ {2}reproducible: +NOT REPRODUCIBLE - (\d+) of (\d+) design\(s\) carry no$/;
/** Left-unanchored: this figure lands mid-sentence on a wrapped continuation line. */
const CORPUS = /The scored corpus is (\d+) design\(s\), so (\d+) is short of it\.$/;
const BOUNDED = /^ +why this block covers (\d+) design\(s\) and not (\d+)\.$/;
const STOPPED = /^ {2}STOPPED: +(\d+) of (\d+) design\(s\) covered/;

/** Every line shape that carries a per-model figure; none of them may sit outside a block. */
const FIGURE_PATTERNS: readonly RegExp[] = [
  POPULATION,
  RATE,
  FLOOR,
  TALLY,
  NO_VERDICT,
  REPRODUCIBLE,
  CORPUS,
  BOUNDED,
  STOPPED,
];

/** Which of the two shapes the renderer used to account for a population short of the corpus. */
type CoverageShape = 'bounded' | 'stopped';

interface RenderedBlock {
  readonly model: string;
  readonly lines: readonly string[];
}

/** The report split into the lines before the first block, and one block per header line. */
function splitBlocks(lines: readonly string[]): {
  readonly preamble: readonly string[];
  readonly blocks: readonly RenderedBlock[];
} {
  const preamble: string[] = [];
  const blocks: { model: string; lines: string[] }[] = [];
  let open: { model: string; lines: string[] } | null = null;
  for (const line of lines) {
    const header = BLOCK_HEADER.exec(line);
    if (header === null) {
      (open?.lines ?? preamble).push(line);
      continue;
    }
    open = { model: header[1] ?? '', lines: [] };
    blocks.push(open);
  }
  return { preamble, blocks };
}

/** The one line matching `pattern`, or null; two would mean one figure rendered twice. */
function onlyMatch(lines: readonly string[], pattern: RegExp): RegExpExecArray | null {
  const matches = lines.flatMap((line) => {
    const match = pattern.exec(line);
    return match === null ? [] : [match];
  });
  expect(matches.length, `${pattern.source} matched ${matches.length} lines`).toBeLessThan(2);
  return matches[0] ?? null;
}

/** The one line matching a pattern every block renders. */
function requiredMatch(lines: readonly string[], pattern: RegExp): RegExpExecArray {
  const match = onlyMatch(lines, pattern);
  if (match === null) {
    throw new Error(`no rendered line matched ${pattern.source}`);
  }
  return match;
}

/** One capture group as a number; an absent group reads as NaN, which fails every comparison. */
function count(match: RegExpExecArray, group: number): number {
  return Number(match[group]);
}

function text(match: RegExpExecArray, group: number): string {
  return match[group] ?? '';
}

/** The tally read in the vocabulary's own order, which is the order the renderer emits. */
function tallyIn(match: RegExpExecArray): Readonly<Record<FormalVerdict, number>> {
  const tally: Record<FormalVerdict, number> = { proved: 0, refuted: 0, 'could-not-verify': 0 };
  FORMAL_VERDICTS.forEach((verdict, index) => {
    tally[verdict] = count(match, index + 1);
  });
  return tally;
}

/** Which coverage shape this block rendered; exactly one of the two, never both or neither. */
function coverageShapeOf(lines: readonly string[]): CoverageShape {
  const bounded = onlyMatch(lines, BOUNDED);
  const stopped = onlyMatch(lines, STOPPED);
  if ((bounded === null) === (stopped === null)) {
    throw new Error('a population short of the corpus renders exactly one coverage shape');
  }
  return bounded === null ? 'stopped' : 'bounded';
}

/** Every figure one rendered block carries, read off the lines of that block alone. */
function figuresInBlock(lines: readonly string[]): BlockFigures {
  const population = requiredMatch(lines, POPULATION);
  const rate = requiredMatch(lines, RATE);
  const floor = requiredMatch(lines, FLOOR);
  const noVerdict = requiredMatch(lines, NO_VERDICT);
  const corpus = requiredMatch(lines, CORPUS);
  const reproducible = onlyMatch(lines, REPRODUCIBLE);
  const coverage =
    coverageShapeOf(lines) === 'bounded'
      ? requiredMatch(lines, BOUNDED)
      : requiredMatch(lines, STOPPED);
  return {
    recorded: count(population, 1),
    admitted: count(population, 2),
    refused: count(population, 3),
    rate: text(rate, 1),
    provedDesigns: count(rate, 2),
    decided: count(rate, 3),
    floorNumerator: count(floor, 1),
    floorDenominator: count(floor, 2),
    floor: text(floor, 3),
    tally: tallyIn(requiredMatch(lines, TALLY)),
    noVerdict: count(noVerdict, 1),
    unprovenanced: reproducible === null ? 0 : count(reproducible, 1),
    covered: count(coverage, 1),
    shortOf: count(corpus, 2),
  };
}

// ---------------------------------------------------------------------------
// The rows the run must exercise
// ---------------------------------------------------------------------------

const REQUIRED_ROWS: readonly string[] = [
  'models:2',
  'models:3',
  'coverage:bounded',
  'coverage:stopped',
  'provenance:read',
  'provenance:unread',
  ...FORMAL_VERDICTS.flatMap((verdict) => [`tally:${verdict}:zero`, `tally:${verdict}:positive`]),
  'no-verdict:zero',
  'no-verdict:positive',
];

/** The rows one draw exercises, so a claim over a narrower record than it names is visible. */
function rowsOf(plans: readonly ModelPlan[], shapes: readonly CoverageShape[]): readonly string[] {
  return [
    `models:${plans.length}`,
    ...shapes.map((shape) => `coverage:${shape}`),
    ...plans.flatMap((plan) => {
      const figures = figuresOf(plan);
      return [
        `provenance:${plan.unread ? 'unread' : 'read'}`,
        `no-verdict:${figures.noVerdict === 0 ? 'zero' : 'positive'}`,
        ...FORMAL_VERDICTS.map(
          (verdict) => `tally:${verdict}:${figures.tally[verdict] === 0 ? 'zero' : 'positive'}`,
        ),
      ];
    }),
  ];
}

// ---------------------------------------------------------------------------
// Property 14
// ---------------------------------------------------------------------------

describe(PROPERTY, () => {
  it('given any measurement, when its designs are read, then each names one model and each design has two', () => {
    fc.assert(
      fc.property(drawArbitrary(), (draw) => {
        const { results } = measurementOf(draw);

        // Every design names a model, and only the models the run routed to (Req 5.12).
        const named = [...new Set(results.map((result) => result.authoringModel))].sort();
        expect(named).toEqual([...draw.plans.map((plan) => plan.model)].sort());
        for (const required of REQUIRED_MODELS) {
          expect(named, `no design was authored by ${required}`).toContain(required);
        }

        // Every design is covered by at least two distinct models (Req 5.11).
        const byDesign = new Map<string, Set<string>>();
        for (const result of results) {
          const covering = byDesign.get(result.designId) ?? new Set<string>();
          byDesign.set(result.designId, covering.add(result.authoringModel));
        }
        expect(byDesign.size).toBe(draw.designIds.length);
        for (const [designId, covering] of byDesign) {
          expect(covering.size, `design ${designId}`).toBeGreaterThanOrEqual(2);
        }
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );
  });

  it('given any measurement, when rendered, then every figure is its own block model and none is pooled', () => {
    const seen = new Set<string>();

    fc.assert(
      fc.property(drawArbitrary(), (draw) => {
        const { plans } = draw;
        const pooled = pooledFigures(plans);

        // THE POSITIVE CONTROL for the pooling claim, asserted BEFORE the absence it makes
        // meaningful: a pooled figure equal to some model's own would satisfy that absence
        // while measuring nothing.
        for (const plan of plans) {
          const own = figuresOf(plan);
          expect(pooled.rate).not.toBe(own.rate);
          expect(pooled.floor).not.toBe(own.floor);
          expect(pooled.recorded).not.toBe(own.recorded);
          expect(pooled.admitted).not.toBe(own.admitted);
          expect(pooled.refused).not.toBe(own.refused);
          expect(pooled.decided).not.toBe(own.decided);
        }

        const { preamble, blocks } = splitBlocks(renderPropertyOnlyReport(measurementOf(draw)));

        // One block per model, in the order the record first names them (Req 5.13).
        expect(blocks.map((block) => block.model)).toEqual(plans.map((plan) => plan.model));

        // No figure sits outside a block, where it would belong to no model at all.
        for (const pattern of FIGURE_PATTERNS) {
          expect(
            preamble.filter((line) => pattern.test(line)),
            `${pattern.source} rendered outside every model block`,
          ).toEqual([]);
        }

        const rendered = blocks.map((block) => ({
          model: block.model,
          figures: figuresInBlock(block.lines),
          shape: coverageShapeOf(block.lines),
        }));

        // Every figure in a block is derived from that block's model alone (Req 5.13).
        for (const block of rendered) {
          const plan = plans.find((one) => one.model === block.model);
          expect(plan, `the block titled ${block.model} names no routed model`).toBeDefined();
          if (plan !== undefined) {
            expect(block.figures, `block for ${block.model}`).toEqual(figuresOf(plan));
          }
        }

        // The same claim stated as criterion 5.14 states it: no rendered figure is the pooled one.
        const figures = rendered.map((block) => block.figures);
        expect(figures.map((one) => one.rate)).not.toContain(pooled.rate);
        expect(figures.map((one) => one.floor)).not.toContain(pooled.floor);
        expect(figures.map((one) => one.recorded)).not.toContain(pooled.recorded);
        expect(figures.map((one) => one.admitted)).not.toContain(pooled.admitted);
        expect(figures.map((one) => one.refused)).not.toContain(pooled.refused);
        expect(figures.map((one) => one.decided)).not.toContain(pooled.decided);

        for (const row of rowsOf(
          plans,
          rendered.map((block) => block.shape),
        )) {
          seen.add(row);
        }
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    for (const row of REQUIRED_ROWS) {
      expect(seen.has(row), `no draw exercised ${row}`).toBe(true);
    }
  });
});
