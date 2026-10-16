// formal-gate-first-light, Property 15: the Property_Only_Measurement round-trips, and a
// departure from its shape decodes to nothing (task 11.2).
//
// WHAT IS CLAIMED, OVER WHAT
//   1. ROUND TRIP. Over every generated measurement, encoding then decoding yields an equivalent
//      measurement, and every field rides on that one equality: the measured token counts and
//      wall clock (Req 5.7), the Reset_Contract_Prepass refusal cause in both of its states
//      (Req 5.17), each Formal_Verdict with its Could_Not_Verify_Cause exactly where the verdict
//      is `could-not-verify` (Req 5.18), and the criteria the Property_Author reported as
//      unexpressed, the empty list as well as a named one (Req 5.19). Each required value is
//      asserted as SEEN after the run, so a vocabulary the decoder restates incompletely cannot
//      pass by never being drawn.
//   2. DEPARTURE. One node of the encoded document is departed from - replaced by a foreign
//      object, or its key removed - and decoding yields `null`. The node is chosen from the
//      document's own paths, so the claim covers every field of the record rather than the
//      handful `app/eval/property-only/record.test.ts` names by hand.
//
// HOW THE DEPARTURE HALF IS KEPT NON-VACUOUS
//   Each run asserts its POSITIVE CONTROL first: the untampered document decodes to the
//   measurement. A generator that failed to depart would hand the property a document equal to
//   that control, and the `null` assertion would go red. So the pair is the proof, not a comment.
//   The path is drawn uniformly over the document's distinct field SIGNATURES rather than over
//   its paths, so a deep array cannot crowd out a scalar, and every region of the record is
//   departed from across the run (asserted as `REGIONS` below).
//
// TWO TRAPS THIS FILE IS SHAPED AROUND
//   `toEqual`, never `toStrictEqual`: `fc.record` builds null-prototype objects, so `toStrictEqual`
//   fails against the decoder's plain objects with "no visual difference"
//   (`chipAgent/_inbox/gotcha-fc-record-builds-null-prototype-objects-so-tostrictequal-fails-with-no-visual-difference.md`).
//   And `arbProofConditions()` is narrowed, not widened into the decoder: see
//   `reportableConditions`.
//
// NOT CLAIMED HERE
//   A SPARSE array. No document holds one - JSON has no hole - and `strList` reads one leniently,
//   which `kindsFor` states. Example departures by hand, an older `schemaVersion` and an
//   `end-to-end` `measurementKind` among them, stay in `app/eval/property-only/record.test.ts`.
//
// The tag is a literal because `propertyTag` hardcodes another spec's slug.
//
// **Validates: Requirements 5.7, 5.17, 5.18, 5.19**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DECLARED_LIMITS,
  decodePropertyOnlyMeasurement,
  encodePropertyOnlyMeasurement,
  PROPERTY_ONLY_MEASUREMENT_KIND,
  PROPERTY_ONLY_SCHEMA_VERSION,
  type DesignPopulation,
  type ManifestToolchain,
  type ProbedVersion,
  type PropertyOnlyDesignResult,
  type PropertyOnlyMeasurement,
  type PropertyOnlyOutcome,
  type PropertyOnlyPropertyResult,
} from '@app/eval';
import {
  COULD_NOT_VERIFY_CAUSES,
  FORMAL_VERDICTS,
  type CoverCondition,
  type ProofConditions,
} from '@app/tools';

import { arbProofConditions } from './formal-arbitraries.js';
import { propertyParameters } from './property.js';

// Feature: formal-gate-first-light, Property 15: The Property_Only_Measurement round-trips, and a departure decodes to nothing
const PROPERTY =
  'formal-gate-first-light, Property 15: The Property_Only_Measurement round-trips, and a departure decodes to nothing';

/**
 * Sized to the rarest required row: one of the eleven Could_Not_Verify_Causes.
 *
 * A cause needs a measured outcome (4 in 5) whose verdict is `could-not-verify` (1 in 3) carrying
 * that cause (1 in 11), so about 2.4% per property and about 7% per record over its roughly three
 * properties. At 300 runs a given cause is missed with probability about 0.93^300 ~ 3e-10, and all
 * eleven together about 3e-9. Every other required row is at least an eighth of records.
 *
 * The departure property runs at the same count for its own reason: the record offers roughly 55
 * field signatures, so each is departed from about five times and every region many times over.
 */
const NUM_RUNS = 300;

/** The verdict that carries a cause, and the only one a cross-check may disagree on. */
const COULD_NOT_VERIFY = 'could-not-verify';

/** Both populations, which no module exports as a list; a third member fails to compile here. */
const POPULATIONS: readonly DesignPopulation[] = ['admitted', 'refused'];

// ---------------------------------------------------------------------------
// The generated measurement
// ---------------------------------------------------------------------------

const DESIGN_IDS = [
  'rtllm/arithmetic/adder_8bit',
  'rtllm/control/fsm_binary',
  'rtllm/miscellaneous/freq_divbyodd',
] as const;

const AUTHORING_MODELS = ['zai.glm-5', 'moonshotai.kimi-k2.5'] as const;

const PROPERTY_IDS = ['p1', 'p2', 'prop_sum_exact'] as const;

/** Acceptance-criterion references as the Property_Author reports them unexpressed (Req 5.19). */
const CRITERION_REFS = ['2.4', '5.11', 'ac-3'] as const;

/** The Student_Path steps a property-only run omits (Req 9.2). */
const OMITTED_STEPS = ['Testbench_Agent', 'Instrument_Admission'] as const;

/** Why no Deterministic_Oracle invocation decided a property (Req 11.2). */
const NOT_MEASURED_REASONS = [
  'the pre-pass refused before any solver ran',
  'the toolchain was unavailable',
] as const;

const RUN_NAMES = ['property-only-v1', 'property-only-cost-pilot'] as const;

const PROBE_READINGS = ['0.69+post', '4.15.4', '13.0'] as const;

const PROBE_REFUSALS = ['answers --version with usage', 'not on PATH'] as const;

/** How much likelier a decided property is than one no oracle invocation reached. */
const MEASURED_WEIGHT = 4;

/** The largest wall clock generated; the value is provenance only (Req 5.7, 12.7). */
const MAX_ELAPSED_MS = 600_000;

const MAX_TOKENS = 100_000;

/** One probed tool version in either arm, both of which a record must carry (Req 8.3). */
function probedVersionArbitrary(): fc.Arbitrary<ProbedVersion> {
  return fc.oneof(
    fc.constantFrom(...PROBE_READINGS).map((value): ProbedVersion => ({ kind: 'read', value })),
    fc
      .constantFrom(...PROBE_REFUSALS)
      .map((reason): ProbedVersion => ({ kind: 'not-measured', reason })),
  );
}

/** A legacy `string | null` version, where null still conflates "not read" with "no reason". */
function legacyVersionArbitrary(): fc.Arbitrary<string | null> {
  return fc.option(fc.constantFrom(...PROBE_READINGS), { nil: null });
}

/** The Toolchain_Provenance that decided a design's verdicts, recorded path-free (Req 8.4, 8.5). */
function toolchainArbitrary(): fc.Arbitrary<ManifestToolchain> {
  return fc.record<ManifestToolchain>({
    iverilogVersion: legacyVersionArbitrary(),
    vvpVersion: legacyVersionArbitrary(),
    workerPython: legacyVersionArbitrary(),
    yosysVersion: probedVersionArbitrary(),
    yosysBuildId: probedVersionArbitrary(),
    yosysSmtBmcVersion: probedVersionArbitrary(),
    bitwuzlaVersion: probedVersionArbitrary(),
    z3Version: probedVersionArbitrary(),
  });
}

/**
 * The five Proof_Conditions, narrowed to the counts a persisted record can carry.
 *
 * `arbProofConditions()` is shaped for the GATE's own guard, so it yields `-1`, `0.5`, `NaN`,
 * `Infinity`, and `MAX_SAFE_INTEGER + 2`. The worker report schema holds `assertionCount` to a
 * non-negative integer, so none of them reaches a record, and the last one would not survive
 * `JSON.parse` even if it did. Narrowed here rather than admitted by the decoder: a record
 * carrying one is correctly refused as unreadable, it is simply unreachable
 * (`chipAgent/_inbox/gotcha-arbpropertyresult-yields-only-five-causes-and-arbproofconditions-yields-counts-no-record-can-carry.md`).
 */
function reportableConditions(): fc.Arbitrary<ProofConditions> {
  return arbProofConditions().filter(
    ({ assertionCount }) => Number.isSafeInteger(assertionCount) && assertionCount >= 0,
  );
}

/**
 * One property's outcome: a decided verdict with its evidence, or Not_Measured with its reason.
 *
 * The cause is drawn over ALL ELEVEN Could_Not_Verify_Causes rather than taken from the gate's
 * own range of five, because the interpreter and the pre-pass report the other six and every one
 * of them reaches a record (Req 5.18). The cause and the cross-check flag sit on the
 * `could-not-verify` arm only, which is what the record's own union already enforces.
 */
function outcomeArbitrary(): fc.Arbitrary<PropertyOnlyOutcome> {
  const measured = fc
    .tuple(
      fc.constantFrom(...FORMAL_VERDICTS),
      fc.constantFrom(...COULD_NOT_VERIFY_CAUSES),
      fc.boolean(),
      reportableConditions(),
    )
    .map(([verdict, cause, crossCheckDisagreed, conditions]): PropertyOnlyOutcome =>
      verdict === COULD_NOT_VERIFY
        ? {
            kind: 'measured',
            conditions,
            verdict,
            couldNotVerifyCause: cause,
            crossCheckDisagreed,
          }
        : {
            kind: 'measured',
            conditions,
            verdict,
            couldNotVerifyCause: null,
            crossCheckDisagreed: false,
          },
    );
  const notMeasured = fc
    .constantFrom(...NOT_MEASURED_REASONS)
    .map((reason): PropertyOnlyOutcome => ({ kind: 'not-measured', reason }));
  return fc.oneof(
    { weight: MEASURED_WEIGHT, arbitrary: measured },
    { weight: 1, arbitrary: notMeasured },
  );
}

function propertyResultArbitrary(): fc.Arbitrary<PropertyOnlyPropertyResult> {
  return fc.record<PropertyOnlyPropertyResult>({
    propertyId: fc.constantFrom(...PROPERTY_IDS),
    outcome: outcomeArbitrary(),
  });
}

/**
 * One design in one population, with the provenance figures Req 5.7 has it record.
 *
 * `population` and `prepassRefusalCause` are drawn INDEPENDENTLY: the population is the
 * Property_Set admission the design was scored under, the pre-pass cause is this run's own
 * refusal before any solver ran, and neither decides the other. `elapsedMs` excludes `-0`, which
 * encodes as `0` and which `toEqual` then reads as a different number.
 *
 * `proofSpanMs` draws `null` as well as a figure, because a design that reached no proof has no
 * Proof_Span and the round trip has to carry that absence back as an absence rather than a 0.
 */
function designResultArbitrary(): fc.Arbitrary<PropertyOnlyDesignResult> {
  return fc.record<PropertyOnlyDesignResult>({
    designId: fc.constantFrom(...DESIGN_IDS),
    authoringModel: fc.constantFrom(...AUTHORING_MODELS),
    population: fc.constantFrom(...POPULATIONS),
    prepassRefusalCause: fc.option(fc.constantFrom(...COULD_NOT_VERIFY_CAUSES), { nil: null }),
    properties: fc.array(propertyResultArbitrary(), { minLength: 1, maxLength: 3 }),
    unexpressedCriteria: fc.subarray([...CRITERION_REFS]),
    promptTokens: fc.nat({ max: MAX_TOKENS }),
    completionTokens: fc.nat({ max: MAX_TOKENS }),
    elapsedMs: fc
      .double({ min: 0, max: MAX_ELAPSED_MS, noNaN: true })
      .filter((ms) => !Object.is(ms, -0)),
    proofSpanMs: fc.option(
      fc.double({ min: 0, max: MAX_ELAPSED_MS, noNaN: true }).filter((ms) => !Object.is(ms, -0)),
      { nil: null },
    ),
    toolchain: toolchainArbitrary(),
    formalOracleVersion: fc.integer({ min: 1, max: 3 }),
  });
}

/** The whole measurement, its limits drawn from the declared registry rather than invented. */
function measurementArbitrary(): fc.Arbitrary<PropertyOnlyMeasurement> {
  return fc.record<PropertyOnlyMeasurement>({
    schemaVersion: fc.constant(PROPERTY_ONLY_SCHEMA_VERSION),
    runName: fc.constantFrom(...RUN_NAMES),
    measurementKind: fc.constant(PROPERTY_ONLY_MEASUREMENT_KIND),
    omittedStudentPathSteps: fc.subarray([...OMITTED_STEPS], { minLength: 1 }),
    results: fc.array(designResultArbitrary(), { minLength: 1, maxLength: 2 }),
    limits: fc.subarray(Object.values(DECLARED_LIMITS), { minLength: 1 }),
  });
}

// ---------------------------------------------------------------------------
// The rows the round trip must exercise
// ---------------------------------------------------------------------------

/**
 * Every member of a string-literal union, read off a TOTAL record of it.
 *
 * For the three condition vocabularies, which `record.ts` restates as arrays of its own: a member
 * missing from one of those arrays refuses a record that carries it, so the member has to be
 * DRAWN for the round trip to see the refusal, and a widened union is a compile error here.
 */
function membersOf<Member extends string>(
  total: Readonly<Record<Member, true>>,
): readonly Member[] {
  return Object.keys(total) as unknown as readonly Member[];
}

const PRESAT_VALUES = membersOf<ProofConditions['presat']>({
  satisfiable: true,
  preunsat: true,
  'not-run': true,
});
const BASE_VALUES = membersOf<ProofConditions['base']>({
  passed: true,
  failed: true,
  'not-run': true,
});
const INDUCTION_VALUES = membersOf<ProofConditions['induction']>({
  successful: true,
  inconclusive: true,
  'not-run': true,
});

/** The row one Cover_Check reading exercises; all three shapes must survive the line. */
function coverRowOf(cover: CoverCondition): string {
  if (cover.reached === 'not-applicable') {
    return 'cover:not-applicable';
  }
  return cover.reached ? 'cover:reached' : 'cover:unreached';
}

/** The rows one property's outcome exercises: its arm, its verdict, its cause, its conditions. */
function outcomeRowsOf(outcome: PropertyOnlyOutcome): readonly string[] {
  if (outcome.kind === 'not-measured') {
    return ['outcome:not-measured'];
  }
  const { conditions } = outcome;
  return [
    'outcome:measured',
    `verdict:${outcome.verdict}`,
    ...(outcome.couldNotVerifyCause === null
      ? []
      : [
          `cause:${outcome.couldNotVerifyCause}`,
          `cross-check:${String(outcome.crossCheckDisagreed)}`,
        ]),
    conditions.assertionCount === 0 ? 'count:zero' : 'count:positive',
    `presat:${conditions.presat}`,
    coverRowOf(conditions.cover),
    `base:${conditions.base}`,
    `induction:${conditions.induction}`,
  ];
}

/** The rows one design result exercises, the three Req 5.17 and 5.19 rest on among them. */
function designRowsOf(result: PropertyOnlyDesignResult): readonly string[] {
  return [
    `population:${result.population}`,
    result.prepassRefusalCause === null ? 'prepass:none' : 'prepass:refused',
    result.unexpressedCriteria.length === 0 ? 'criteria:empty' : 'criteria:named',
    ...Object.values<ProbedVersion>({
      yosysVersion: result.toolchain.yosysVersion,
      yosysBuildId: result.toolchain.yosysBuildId,
      yosysSmtBmcVersion: result.toolchain.yosysSmtBmcVersion,
      bitwuzlaVersion: result.toolchain.bitwuzlaVersion,
      z3Version: result.toolchain.z3Version,
    }).map((entry) => `probed:${entry.kind}`),
    `legacy:${result.toolchain.workerPython === null ? 'null' : 'string'}`,
    ...result.properties.flatMap((property) => outcomeRowsOf(property.outcome)),
  ];
}

/** Every row one measurement exercises, read off the fields the round trip is claimed over. */
function roundTripRowsOf(measurement: PropertyOnlyMeasurement): readonly string[] {
  return [
    ...measurement.limits.map((limit) => `limit:${limit.name}`),
    ...measurement.results.flatMap(designRowsOf),
  ];
}

/** Every row the round trip must have seen, or it checked less of the record than it claims. */
const REQUIRED_ROWS: readonly string[] = [
  ...Object.keys(DECLARED_LIMITS).map((name) => `limit:${name}`),
  ...POPULATIONS.map((population) => `population:${population}`),
  'prepass:none',
  'prepass:refused',
  'criteria:empty',
  'criteria:named',
  'probed:read',
  'probed:not-measured',
  'legacy:null',
  'legacy:string',
  'outcome:measured',
  'outcome:not-measured',
  ...FORMAL_VERDICTS.map((verdict) => `verdict:${verdict}`),
  ...COULD_NOT_VERIFY_CAUSES.map((cause) => `cause:${cause}`),
  'cross-check:true',
  'cross-check:false',
  'count:zero',
  'count:positive',
  ...PRESAT_VALUES.map((presat) => `presat:${presat}`),
  'cover:reached',
  'cover:unreached',
  'cover:not-applicable',
  ...BASE_VALUES.map((base) => `base:${base}`),
  ...INDUCTION_VALUES.map((induction) => `induction:${induction}`),
];

// ---------------------------------------------------------------------------
// The generated departure
// ---------------------------------------------------------------------------

/** A path of keys and array indices into the encoded document; the root is never one. */
type DocumentPath = readonly (string | number)[];

/** The two ways one node of a well-formed document is departed from. */
const DEPARTURE_KINDS = ['foreign-node', 'missing-key'] as const;

type DepartureKind = (typeof DEPARTURE_KINDS)[number];

/**
 * The node put where a readable one belongs.
 *
 * An object, because the record holds no field an object satisfies: every leaf is narrowed to a
 * string, a number, a boolean, or a closed vocabulary member, every container is narrowed by its
 * own members, and `results`, `properties`, `limits`, and the two string lists all demand arrays.
 */
const FOREIGN_NODE: Readonly<Record<string, unknown>> = Object.freeze({ departed: true });

/**
 * The five keys whose ABSENCE the record reads as a meaning rather than as a departure: the
 * pre-pass that did not refuse, the three legacy versions where absent and null are one unknown,
 * and the Proof_Span, absent on a design that reached no proof and on any record written before
 * that field existed. Removing one of these is not a departure, so `missing-key` is not offered
 * there. A present but unreadable Proof_Span is still a departure, which `wrong-type` covers.
 */
const OPTIONAL_KEYS: readonly string[] = [
  'prepassRefusalCause',
  'iverilogVersion',
  'vvpVersion',
  'workerPython',
  'proofSpanMs',
];

/** Every path inside the encoded document, containers and leaves alike. */
function pathsOf(node: unknown, prefix: DocumentPath = []): readonly DocumentPath[] {
  if (Array.isArray(node)) {
    return node.flatMap((entry, index): readonly DocumentPath[] => {
      const here: DocumentPath = [...prefix, index];
      return [here, ...pathsOf(entry, here)];
    });
  }
  if (typeof node === 'object' && node !== null) {
    return Object.entries(node).flatMap(([key, value]): readonly DocumentPath[] => {
      const here: DocumentPath = [...prefix, key];
      return [here, ...pathsOf(value, here)];
    });
  }
  return [];
}

/** One path's field signature: its array indices collapsed, so `results.0` and `results.1` are one. */
function signatureOf(path: DocumentPath): string {
  return path.map((step) => (typeof step === 'number' ? '*' : step)).join('.');
}

/** The regions a departure must have landed in, or whole stretches of the record went untried. */
const REGIONS = [
  'measurement',
  'design-result',
  'property',
  'outcome',
  'conditions',
  'toolchain',
  'limit',
] as const;

type Region = (typeof REGIONS)[number];

/** Which region a signature sits in, innermost first so a nested node is not claimed twice. */
function regionOf(signature: string): Region {
  if (signature.startsWith('limits')) {
    return 'limit';
  }
  if (signature.includes('.toolchain')) {
    return 'toolchain';
  }
  if (signature.includes('.conditions')) {
    return 'conditions';
  }
  if (signature.includes('.outcome')) {
    return 'outcome';
  }
  if (signature.includes('.properties.')) {
    return 'property';
  }
  return signature.startsWith('results.') ? 'design-result' : 'measurement';
}

/**
 * The kinds that are a departure AT this path, which is both of them at most keys.
 *
 * Neither an optional key nor an ARRAY ENTRY is removed. Removing an entry leaves a hole, and no
 * document holds one: JSON has no hole, so a parsed file's arrays are always dense. Measured while
 * writing this: `strList` reads a hole leniently, because `Array.prototype.map` SKIPS holes where
 * the `for...of` in the sibling `list` helper yields `undefined` and refuses. Generating a hole
 * would therefore fail the property over an input no caller can produce, which is the same reason
 * `reportableConditions` narrows rather than the decoder widening. A foreign node still lands on
 * every array entry, so no entry goes untried.
 */
function kindsFor(path: DocumentPath): readonly DepartureKind[] {
  const key = path.at(-1);
  const removable = typeof key === 'string' && !OPTIONAL_KEYS.includes(key);
  return removable ? DEPARTURE_KINDS : DEPARTURE_KINDS.filter((kind) => kind !== 'missing-key');
}

/** One departure: the well-formed measurement behind it, the node chosen, and what was done. */
interface Departure {
  readonly measurement: PropertyOnlyMeasurement;
  readonly path: DocumentPath;
  readonly kind: DepartureKind;
}

/**
 * A measurement, one node of its encoded form, and one departure from that node.
 *
 * The node is drawn uniformly over the document's distinct SIGNATURES and only then over the
 * paths sharing one, so a two-design record does not make a design's fields twice as likely as
 * the run's own, and the eight toolchain members do not crowd out `schemaVersion`.
 */
function departureArbitrary(): fc.Arbitrary<Departure> {
  return measurementArbitrary().chain((measurement) => {
    const document = JSON.parse(encodePropertyOnlyMeasurement(measurement)) as unknown;
    const bySignature = new Map<string, DocumentPath[]>();
    for (const path of pathsOf(document)) {
      const signature = signatureOf(path);
      bySignature.set(signature, [...(bySignature.get(signature) ?? []), path]);
    }
    return fc
      .constantFrom(...bySignature.values())
      .chain((group) => fc.constantFrom(...group))
      .chain((path) =>
        fc.constantFrom(...kindsFor(path)).map((kind): Departure => ({ measurement, path, kind })),
      );
  });
}

/** The container one step above `path`, which every non-root path has. */
function containerAt(document: unknown, path: DocumentPath): Record<string | number, unknown> {
  let here: unknown = document;
  for (const step of path.slice(0, -1)) {
    here = (here as Record<string | number, unknown>)[step];
  }
  return here as Record<string | number, unknown>;
}

/** The document with its node at `path` departed from, in place. */
function applyDeparture(document: unknown, { path, kind }: Departure): void {
  const key = path.at(-1);
  if (key === undefined) {
    throw new Error('a departure path is never the document root');
  }
  const container = containerAt(document, path);
  if (kind === 'missing-key') {
    Reflect.deleteProperty(container, key);
    return;
  }
  container[key] = FOREIGN_NODE;
}

// ---------------------------------------------------------------------------
// Property 15
// ---------------------------------------------------------------------------

describe(PROPERTY, () => {
  it('given any measurement, when it is encoded and decoded, then an equivalent one comes back', () => {
    const seen = new Set<string>();

    fc.assert(
      fc.property(measurementArbitrary(), (measurement) => {
        for (const row of roundTripRowsOf(measurement)) {
          seen.add(row);
        }

        // `toEqual`, because `fc.record` builds null-prototype objects that never strictly
        // equal the decoder's plain ones, and the mismatch prints no visible difference.
        expect(decodePropertyOnlyMeasurement(encodePropertyOnlyMeasurement(measurement))).toEqual(
          measurement,
        );
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    for (const row of REQUIRED_ROWS) {
      expect(seen.has(row), `no measurement exercised ${row}`).toBe(true);
    }
  });

  it('given any departure from the shape, when it is decoded, then nothing comes back', () => {
    const kinds = new Set<DepartureKind>();
    const regions = new Set<Region>();

    fc.assert(
      fc.property(departureArbitrary(), (departure) => {
        kinds.add(departure.kind);
        regions.add(regionOf(signatureOf(departure.path)));

        // The positive control, asserted FIRST: the untampered document decodes. A draw that
        // failed to depart would hand the decoder this same document, and the refusal below
        // would go red - which is what keeps this half from passing vacuously.
        const encoded = encodePropertyOnlyMeasurement(departure.measurement);
        expect(decodePropertyOnlyMeasurement(encoded)).toEqual(departure.measurement);

        const document = JSON.parse(encoded) as unknown;
        applyDeparture(document, departure);

        expect(
          decodePropertyOnlyMeasurement(document),
          `${departure.kind} at ${signatureOf(departure.path)}`,
        ).toBeNull();
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    for (const kind of DEPARTURE_KINDS) {
      expect(kinds.has(kind), `no draw departed by ${kind}`).toBe(true);
    }
    for (const region of REGIONS) {
      expect(regions.has(region), `no departure landed in the ${region}`).toBe(true);
    }
  });
});
