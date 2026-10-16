// formal-gate-first-light, Property 26: a record without provenance is labelled, never quietly
// reported (task 11.4).
//
// WHAT IS CLAIMED, OVER WHAT
//   1. CARRIED. A design result cannot be decoded without its Toolchain_Provenance, its two
//      measured token counts, or its measured elapsed wall clock: removing any one of them from
//      the encoded document decodes to nothing (Req 8.5, 12.7). The three legacy members are the
//      one exception, and a named one: absent and null are the same unknown there, which is the
//      only way a DECODABLE record can carry no provenance at all, and so the only way the label
//      of claim 2 is reachable in production.
//   2. LABELLED, BOTH DIRECTIONS. A model whose designs carry no answered toolchain member is
//      labelled NOT REPRODUCIBLE, and the label names how many of how many designs (Req 8.6). A
//      model whose designs did answer renders no such line. So the label is a statement about
//      provenance, not a banner on every report, and a renderer that labelled everything or
//      nothing fails here.
//   3. PROVENANCE, NEVER A FIGURE. Criterion 12.7 has the record carry the token counts and the
//      wall clock AS PROVENANCE. Read off `app/eval/property-only/report.ts`: no line of the
//      report reads any of the three. That is asserted rather than assumed - one record is
//      rendered twice under two different figure sets and the two reports are identical, with the
//      record shown to carry the new figures. This file therefore claims nothing about a rendered
//      token count, because there is none to claim anything about.
//
// PARTIAL PROVENANCE IS THE NORMAL CASE HERE, NOT AN EDGE CASE
//   Measured on this host by tasks 4.5 and 11.18: `workerPython` holds the bare string `python`,
//   which is the BINARY NAME and not a version, and `yosysSmtBmcVersion` holds `not-measured`
//   because yosys-smtbmc prints usage instead of a version, while the other six members read a
//   real version. So the shipped record is a PARTIAL toolchain, and a property that only told
//   "all read" from "none read" would say nothing about the records this spec produces.
//   What this file claims about the middle: the renderer's predicate asks whether ANY member
//   answered, so every partial toolchain - down to a single legacy member holding a binary name -
//   counts as carrying provenance and is NOT labelled. The label is reserved for a toolchain
//   where nothing answered at all. The measured host shape and the one-binary-name shape are each
//   generated as their own asserted row, so the claim is made over them and not around them.
//   Note what this means and what it does not: the predicate cannot tell a version from a binary
//   name, so `workerPython: 'python'` clears the bar. That is the shipped behaviour, measured,
//   not an endorsement of it.
//
// WHY THE POPULATION VARIES BEYOND THE TOOLCHAIN
//   The label's count is taken over the model's WHOLE recorded population, both populations,
//   while every sibling figure in the block filters to the admitted or the decided designs. A
//   population whose unprovenanced designs were all admitted and all decided would make those
//   filters the identity, and a count taken over the wrong one would be invisible
//   (`chipAgent/_inbox/gotcha-an-aggregation-property-whose-population-holds-every-other-field-constant-cannot-see-a-count-taken-over-a-sub-population.md`).
//   So an unprovenanced design is drawn in each of the three roles - proved, undecided, refused -
//   and each is an asserted row.
//
// NOT CLAIMED HERE
//   That the label belongs to its own Authoring_Model's block rather than another's: that is
//   Property 14 (`property-only-per-model.property.test.ts`). That the record round-trips at all:
//   Property 15 (`property-only-record-roundtrip.property.test.ts`). The empty record, which has
//   no block to label, is an example test in `app/eval/property-only/report.test.ts`.
//
// The tag is a literal because `propertyTag` hardcodes another spec's slug.
//
// **Validates: Requirements 8.5, 8.6, 12.7**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DECLARED_LIMITS,
  decodePropertyOnlyMeasurement,
  encodePropertyOnlyMeasurement,
  PROPERTY_ONLY_MEASUREMENT_KIND,
  PROPERTY_ONLY_SCHEMA_VERSION,
  renderPropertyOnlyReport,
  type ManifestToolchain,
  type MeasurementLimit,
  type ProbedVersion,
  type PropertyOnlyDesignResult,
  type PropertyOnlyMeasurement,
  type PropertyOnlyPropertyResult,
} from '@app/eval';
import type { ProofConditions } from '@app/tools';

import { propertyParameters } from './property.js';

// Feature: formal-gate-first-light, Property 26: A record without provenance is labelled, never quietly reported
const PROPERTY =
  'formal-gate-first-light, Property 26: A record without provenance is labelled, never quietly reported';

/**
 * Sized to the rarest required row, a model every design of which carries no provenance.
 *
 * An unread toolchain is a third of the draws per design, so a wholly unprovenanced model is
 * about 1/9 of two-design models and 1/27 of three-design ones, about 0.07 per model and about
 * 0.14 per draw over the two. At 200 runs the row is missed with probability about 0.86^200,
 * which is below 1e-12. Every other row is at least a sixth of designs drawn.
 */
const NUM_RUNS = 200;

// ---------------------------------------------------------------------------
// The toolchain, member by member
// ---------------------------------------------------------------------------

/** The three members the record still holds as `string | null`, from before the probe existed. */
const LEGACY_MEMBERS = ['iverilogVersion', 'vvpVersion', 'workerPython'] as const;

/** The five members that carry their own reason where no version could be read (Req 8.3). */
const PROBED_MEMBERS = [
  'yosysVersion',
  'yosysBuildId',
  'yosysSmtBmcVersion',
  'bitwuzlaVersion',
  'z3Version',
] as const;

type LegacyMember = (typeof LEGACY_MEMBERS)[number];
type ProbedMember = (typeof PROBED_MEMBERS)[number];
type ToolchainMember = LegacyMember | ProbedMember;

const ALL_MEMBERS: readonly ToolchainMember[] = [...LEGACY_MEMBERS, ...PROBED_MEMBERS];

/**
 * What each legacy member holds where it answered.
 *
 * `workerPython` is this host's measured value: the binary NAME, not a version. The record has
 * nowhere to say which it is, and the renderer's predicate does not ask - see the header.
 */
const LEGACY_READINGS: Readonly<Record<LegacyMember, string>> = {
  iverilogVersion: '13.0',
  vvpVersion: '13.0',
  workerPython: 'python',
};

/** What each probed member reads where it answered, as measured on this host. */
const PROBED_READINGS: Readonly<Record<ProbedMember, string>> = {
  yosysVersion: '0.69+post',
  yosysBuildId: '143eb14f',
  yosysSmtBmcVersion: '0.69+post',
  bitwuzlaVersion: '0.9.1',
  z3Version: '4.15.4',
};

/** Why a probe read nothing; the yosys-smtbmc reason is the one this host actually records. */
const PROBE_REFUSALS: Readonly<Record<ProbedMember, string>> = {
  yosysVersion: 'not on PATH',
  yosysBuildId: 'not on PATH',
  yosysSmtBmcVersion: 'yosys-smtbmc printed usage rather than a version',
  bitwuzlaVersion: 'not on PATH',
  z3Version: 'not on PATH',
};

/** A whole toolchain in which exactly `answered` responded, and every other member did not. */
function toolchainFrom(answered: readonly ToolchainMember[]): ManifestToolchain {
  const legacy = (member: LegacyMember): string | null =>
    answered.includes(member) ? LEGACY_READINGS[member] : null;
  const probed = (member: ProbedMember): ProbedVersion =>
    answered.includes(member)
      ? { kind: 'read', value: PROBED_READINGS[member] }
      : { kind: 'not-measured', reason: PROBE_REFUSALS[member] };
  return {
    iverilogVersion: legacy('iverilogVersion'),
    vvpVersion: legacy('vvpVersion'),
    workerPython: legacy('workerPython'),
    yosysVersion: probed('yosysVersion'),
    yosysBuildId: probed('yosysBuildId'),
    yosysSmtBmcVersion: probed('yosysSmtBmcVersion'),
    bitwuzlaVersion: probed('bitwuzlaVersion'),
    z3Version: probed('z3Version'),
  };
}

/**
 * The five provenance shapes drawn, three of which are the partial middle.
 *
 * `host` is this host's measured shape and `binary-name-only` is the weakest shape that still
 * clears the renderer's bar; `partial` is any other proper non-empty subset of the members.
 */
const TOOLCHAIN_SHAPES = ['unread', 'binary-name-only', 'host', 'partial', 'all'] as const;

type ToolchainShape = (typeof TOOLCHAIN_SHAPES)[number];

/** No member answered: the record that carries no Toolchain_Provenance at all (Req 8.6). */
const NONE_ANSWERED: readonly ToolchainMember[] = [];

/** One legacy member answered, and with a binary name rather than a version. */
const BINARY_NAME_ONLY: readonly ToolchainMember[] = ['workerPython'];

/** This host's measured shape: every member but yosys-smtbmc answered (tasks 4.5, 11.18). */
const HOST_ANSWERED: readonly ToolchainMember[] = ALL_MEMBERS.filter(
  (member) => member !== 'yosysSmtBmcVersion',
);

/** Which members answered, for one shape; `fc.subarray` needs a mutable array of its own. */
function answeredArbitrary(shape: ToolchainShape): fc.Arbitrary<readonly ToolchainMember[]> {
  if (shape === 'unread') {
    return fc.constant(NONE_ANSWERED);
  }
  if (shape === 'binary-name-only') {
    return fc.constant(BINARY_NAME_ONLY);
  }
  if (shape === 'host') {
    return fc.constant(HOST_ANSWERED);
  }
  if (shape === 'all') {
    return fc.constant(ALL_MEMBERS);
  }
  return fc
    .subarray([...ALL_MEMBERS])
    .filter((members) => members.length > 0 && members.length < ALL_MEMBERS.length);
}

// ---------------------------------------------------------------------------
// The generated plan
// ---------------------------------------------------------------------------

/** The two Authoring_Models every draw routes to, so one report holds two blocks. */
const MODELS = ['zai.glm-5', 'moonshotai.kimi-k2.5'] as const;

const DESIGN_IDS = [
  'rtllm/arithmetic/adder_8bit',
  'rtllm/control/fsm_binary',
  'rtllm/miscellaneous/freq_divbyodd',
] as const;

/**
 * The three roles a design comes in, each leaving one more filter the block's other figures use.
 *
 * `undecided` is admitted with nothing the oracle decided, so it is outside the rate's
 * denominator; `refused` is outside the Admitted_Population entirely.
 */
const ROLES = ['proved', 'undecided', 'refused'] as const;

type Role = (typeof ROLES)[number];

/** Two designs is the fewest that can render a count strictly between zero and the population. */
const MIN_DESIGNS = 2;

/** The declared design-count bound, so a short block is a bound reached and not a stopped run. */
const MAX_DESIGNS = DESIGN_IDS.length;

/** How much likelier an unread toolchain is than any one of the four that answered something. */
const UNREAD_WEIGHT = 2;

interface DesignPlan {
  readonly shape: ToolchainShape;
  readonly answered: readonly ToolchainMember[];
  readonly role: Role;
}

interface ModelPlan {
  readonly model: string;
  readonly designs: readonly DesignPlan[];
}

/** The measured token counts and wall clock every design of a draw carries (Req 12.7). */
interface ProvenanceFigures {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly elapsedMs: number;
}

interface Draw {
  readonly plans: readonly ModelPlan[];
  readonly figures: ProvenanceFigures;
}

const MAX_TOKENS = 100_000;
const MAX_ELAPSED_MS = 600_000;

function figuresArbitrary(): fc.Arbitrary<ProvenanceFigures> {
  return fc.record<ProvenanceFigures>({
    promptTokens: fc.nat({ max: MAX_TOKENS }),
    completionTokens: fc.nat({ max: MAX_TOKENS }),
    elapsedMs: fc.nat({ max: MAX_ELAPSED_MS }),
  });
}

/**
 * A second figure set that differs from the first in both token figures, by construction.
 *
 * Shifted rather than drawn independently: two independent draws are equal once in about 1e16
 * draws, and an invariance claim whose positive control can go red by coincidence is a flake.
 *
 * `elapsedMs` is held constant because it is no longer an unrendered figure: the report prints
 * each design's measured wall clock beside the Per_Design_Extrapolation (Req 5.22), so shifting
 * it changes the document by design. The token figures remain carried and unrendered.
 */
function shiftedBy(figures: ProvenanceFigures, delta: number): ProvenanceFigures {
  return {
    promptTokens: figures.promptTokens + delta,
    completionTokens: figures.completionTokens + delta,
    elapsedMs: figures.elapsedMs,
  };
}

/** One design: a provenance shape, and a role drawn independently of it. */
function designPlanArbitrary(): fc.Arbitrary<DesignPlan> {
  const shaped = (shape: ToolchainShape): fc.Arbitrary<DesignPlan> =>
    fc
      .record({ answered: answeredArbitrary(shape), role: fc.constantFrom(...ROLES) })
      .map(({ answered, role }): DesignPlan => ({ shape, answered, role }));
  return fc.oneof(
    { weight: UNREAD_WEIGHT, arbitrary: shaped('unread') },
    { weight: 1, arbitrary: shaped('binary-name-only') },
    { weight: 1, arbitrary: shaped('host') },
    { weight: 1, arbitrary: shaped('partial') },
    { weight: 1, arbitrary: shaped('all') },
  );
}

function modelPlanArbitrary(model: string): fc.Arbitrary<ModelPlan> {
  return fc
    .array(designPlanArbitrary(), { minLength: MIN_DESIGNS, maxLength: MAX_DESIGNS })
    .map((designs): ModelPlan => ({ model, designs }));
}

function drawArbitrary(): fc.Arbitrary<Draw> {
  return fc.record<Draw>({
    plans: fc.tuple(modelPlanArbitrary(MODELS[0]), modelPlanArbitrary(MODELS[1])),
    figures: figuresArbitrary(),
  });
}

// ---------------------------------------------------------------------------
// The record a plan becomes
// ---------------------------------------------------------------------------

/** The one limit the run declares, read from the registry so it owns its name and reason. */
const LIMITS: readonly MeasurementLimit[] = Object.values(DECLARED_LIMITS).filter(
  (limit) => limit.name === 'cost-pilot-design-count',
);

/** The five Proof_Conditions behind a verdict; no figure in this report reads them. */
const CONDITIONS: ProofConditions = {
  assertionCount: 1,
  presat: 'satisfiable',
  cover: { reached: true, step: 3 },
  base: 'passed',
  induction: 'successful',
};

/** The cause a pre-pass refusal carries; no figure in this report reads it either. */
const CAUSE = 'clock-contract-unsupported';

const FORMAL_ORACLE_VERSION = 2;

const PROVED_PROPERTY: PropertyOnlyPropertyResult = {
  propertyId: 'p1',
  outcome: {
    kind: 'measured',
    conditions: CONDITIONS,
    verdict: 'proved',
    couldNotVerifyCause: null,
    crossCheckDisagreed: false,
  },
};

/** The property of a design no Deterministic_Oracle invocation reached (Req 11.2). */
const UNDECIDED_PROPERTY: PropertyOnlyPropertyResult = {
  propertyId: 'p1',
  outcome: { kind: 'not-measured', reason: 'no oracle invocation decided this property' },
};

/** One design result in the population, outcome, and toolchain shape its plan names. */
function designFor(
  design: DesignPlan,
  designId: string,
  model: string,
  figures: ProvenanceFigures,
): PropertyOnlyDesignResult {
  const refused = design.role === 'refused';
  return {
    designId,
    authoringModel: model,
    population: refused ? 'refused' : 'admitted',
    prepassRefusalCause: refused ? CAUSE : null,
    properties: [design.role === 'proved' ? PROVED_PROPERTY : UNDECIDED_PROPERTY],
    unexpressedCriteria: [],
    ...figures,
    // Absent on purpose: this property reads provenance labelling, not the guard's arm.
    proofSpanMs: null,
    toolchain: toolchainFrom(design.answered),
    formalOracleVersion: FORMAL_ORACLE_VERSION,
  };
}

function designsOf(
  plan: ModelPlan,
  figures: ProvenanceFigures,
): readonly PropertyOnlyDesignResult[] {
  return plan.designs.flatMap((design, index) => {
    const designId = DESIGN_IDS[index];
    return designId === undefined ? [] : [designFor(design, designId, plan.model, figures)];
  });
}

function measurementOf({ plans, figures }: Draw): PropertyOnlyMeasurement {
  return {
    schemaVersion: PROPERTY_ONLY_SCHEMA_VERSION,
    runName: 'measurement-provenance-labelled',
    measurementKind: PROPERTY_ONLY_MEASUREMENT_KIND,
    omittedStudentPathSteps: ['Testbench_Agent', 'Instrument_Admission'],
    results: plans.flatMap((plan) => designsOf(plan, figures)),
    limits: LIMITS,
  };
}

/** How many of a model's designs carry no answered member, derived without the renderer. */
function unprovenancedCount(plan: ModelPlan): number {
  return plan.designs.filter((design) => design.answered.length === 0).length;
}

// ---------------------------------------------------------------------------
// Removing one provenance field from the encoded document
// ---------------------------------------------------------------------------

/** The provenance fields that sit on the design result itself (Req 8.5, 12.7). */
const DESIGN_PROVENANCE_FIELDS = [
  'promptTokens',
  'completionTokens',
  'elapsedMs',
  'toolchain',
] as const;

/** One key the removal half takes out, and where it sits. */
type Removal =
  | { readonly kind: 'design-field'; readonly field: (typeof DESIGN_PROVENANCE_FIELDS)[number] }
  | { readonly kind: 'probed'; readonly field: ProbedMember }
  | { readonly kind: 'legacy'; readonly field: LegacyMember };

/** Every provenance key of one design result, the three tolerated ones included. */
const REMOVALS: readonly Removal[] = [
  ...DESIGN_PROVENANCE_FIELDS.map((field): Removal => ({ kind: 'design-field', field })),
  ...PROBED_MEMBERS.map((field): Removal => ({ kind: 'probed', field })),
  ...LEGACY_MEMBERS.map((field): Removal => ({ kind: 'legacy', field })),
];

/** The design result at `index` of the parsed document, which every draw has. */
function designAt(document: unknown, index: number): Record<string, unknown> {
  const { results } = document as { results?: unknown };
  const design = Array.isArray(results) ? (results[index] as unknown) : undefined;
  if (typeof design !== 'object' || design === null) {
    throw new Error(`the encoded document holds no design result at ${index}`);
  }
  return design as Record<string, unknown>;
}

/** The toolchain of that design result, which the decoder refuses a record without. */
function toolchainAt(design: Record<string, unknown>): Record<string, unknown> {
  const { toolchain } = design;
  if (typeof toolchain !== 'object' || toolchain === null) {
    throw new Error('every generated design result carries a toolchain');
  }
  return toolchain as Record<string, unknown>;
}

/** Take one provenance key out of the parsed document, in place. */
function removeFrom(document: unknown, index: number, removal: Removal): void {
  const design = designAt(document, index);
  const container = removal.kind === 'design-field' ? design : toolchainAt(design);
  Reflect.deleteProperty(container, removal.field);
}

// ---------------------------------------------------------------------------
// Reading the label off the rendered report
// ---------------------------------------------------------------------------

const BLOCK_HEADER = /^authoring model: (.+)$/;

/** The label, which names a count over a denominator; the wrapped sentence follows it. */
const REPRODUCIBLE = /^ {2}reproducible: +NOT REPRODUCIBLE - (\d+) of (\d+) design\(s\) carry no$/;

/** The token the label is found by, so a label rendered in any other shape still fails. */
const NOT_REPRODUCIBLE = 'NOT REPRODUCIBLE';

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

/**
 * Assert one block's label against the plan it was rendered from, and name the row it is.
 *
 * `label:middle` is the row that gives claim 2 its teeth: a count strictly inside the
 * population is a value neither a renderer that labels everything nor one that labels nothing
 * can produce.
 */
function labelRowOf(block: RenderedBlock, plan: ModelPlan): string {
  const expected = unprovenancedCount(plan);
  const recorded = plan.designs.length;
  const labels = block.lines.filter((line) => line.includes(NOT_REPRODUCIBLE));
  if (expected === 0) {
    expect(labels, `${block.model} answered on every design, so nothing is labelled`).toEqual([]);
    return 'label:absent';
  }
  expect(labels.length, `${block.model} rendered ${labels.length} label(s)`).toBe(1);
  const label = labels[0] ?? '';
  const match = REPRODUCIBLE.exec(label);
  expect(match, `${block.model} label does not name a count: ${label}`).not.toBeNull();
  expect(Number(match?.[1]), `${block.model} label count`).toBe(expected);
  expect(Number(match?.[2]), `${block.model} label denominator`).toBe(recorded);
  return expected === recorded ? 'label:whole' : 'label:middle';
}

// ---------------------------------------------------------------------------
// The rows the run must exercise
// ---------------------------------------------------------------------------

const REQUIRED_ROWS: readonly string[] = [
  ...TOOLCHAIN_SHAPES.map((shape) => `shape:${shape}`),
  ...ROLES.map((role) => `unprovenanced:${role}`),
  'label:absent',
  'label:middle',
  'label:whole',
  'report:labelled-and-unlabelled',
];

/** The rows one draw's designs exercise, so a claim made over a narrower record is visible. */
function designRowsOf(plans: readonly ModelPlan[]): readonly string[] {
  return plans.flatMap((plan) =>
    plan.designs.flatMap((design) => [
      `shape:${design.shape}`,
      ...(design.answered.length === 0 ? [`unprovenanced:${design.role}`] : []),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Property 26
// ---------------------------------------------------------------------------

describe(PROPERTY, () => {
  it('given any record, when a provenance field is removed, then the record does not decode', () => {
    const seen = new Set<string>();

    fc.assert(
      fc.property(
        drawArbitrary(),
        fc.nat({ max: 999 }),
        fc.constantFrom(...REMOVALS),
        (draw, offset, removal) => {
          seen.add(`removal:${removal.kind}:${removal.field}`);

          const measurement = measurementOf(draw);
          const index = offset % measurement.results.length;
          const encoded = encodePropertyOnlyMeasurement(measurement);

          // The POSITIVE CONTROL, asserted first: the untouched document decodes, so the
          // refusal below is the removal's doing rather than something else about the draw.
          // `toEqual`, never `toStrictEqual`: `fc.record` builds null-prototype objects.
          expect(decodePropertyOnlyMeasurement(encoded)).toEqual(measurement);

          const document = JSON.parse(encoded) as unknown;
          removeFrom(document, index, removal);
          const decoded = decodePropertyOnlyMeasurement(document);

          if (removal.kind !== 'legacy') {
            expect(
              decoded,
              `${removal.kind} ${removal.field} removed at results.${index}`,
            ).toBeNull();
            return;
          }

          // The one tolerated absence, and the reason claim 2 has anything to label: for the
          // three legacy members absent and null are the same unknown, so a record can decode
          // while carrying no Toolchain_Provenance at all.
          expect(decoded, `legacy ${removal.field} removed at results.${index}`).not.toBeNull();
          expect(decoded?.results[index]?.toolchain[removal.field]).toBeNull();
        },
      ),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    for (const removal of REMOVALS) {
      const row = `removal:${removal.kind}:${removal.field}`;
      expect(seen.has(row), `no draw removed ${row}`).toBe(true);
    }
  });

  it('given any report, when a record carries no provenance, then it is labelled and no other is', () => {
    const seen = new Set<string>();

    fc.assert(
      fc.property(drawArbitrary(), (draw) => {
        const { plans } = draw;
        for (const row of designRowsOf(plans)) {
          seen.add(row);
        }

        const { preamble, blocks } = splitBlocks(renderPropertyOnlyReport(measurementOf(draw)));

        // The label never sits outside a block, where it would read as a banner over the whole
        // report rather than as a statement about one model's own records.
        expect(preamble.filter((line) => line.includes(NOT_REPRODUCIBLE))).toEqual([]);
        expect(blocks.map((block) => block.model)).toEqual(plans.map((plan) => plan.model));

        const rows = blocks.map((block) => {
          const plan = plans.find((one) => one.model === block.model);
          if (plan === undefined) {
            throw new Error(`the block titled ${block.model} names no routed model`);
          }
          return labelRowOf(block, plan);
        });
        for (const row of rows) {
          seen.add(row);
        }
        if (rows.includes('label:absent') && rows.some((row) => row !== 'label:absent')) {
          seen.add('report:labelled-and-unlabelled');
        }
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    for (const row of REQUIRED_ROWS) {
      expect(seen.has(row), `no draw exercised ${row}`).toBe(true);
    }
  });

  it('given any record, when its token figures change, then the report is unchanged', () => {
    fc.assert(
      fc.property(drawArbitrary(), fc.integer({ min: 1, max: MAX_TOKENS }), (draw, delta) => {
        const other = shiftedBy(draw.figures, delta);
        const shifted: Draw = { ...draw, figures: other };

        // The POSITIVE CONTROL for an invariance claim: the two figure sets are different, and
        // the record built from the second carries that second set on every design (Req 12.7).
        expect(other).not.toEqual(draw.figures);
        for (const result of measurementOf(shifted).results) {
          expect({
            promptTokens: result.promptTokens,
            completionTokens: result.completionTokens,
            elapsedMs: result.elapsedMs,
          }).toEqual(other);
        }

        // So the token figures travel as provenance and no figure in the report reads them.
        expect(renderPropertyOnlyReport(measurementOf(shifted))).toEqual(
          renderPropertyOnlyReport(measurementOf(draw)),
        );
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );
  });
});
