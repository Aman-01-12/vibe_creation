// timing-contract-inference, Property 8: the pre-pass parse rejects what it does not recognize,
// now that `timing` is a required field of the document (task 4.2).
//
// WHY THIS IS GENERATED WHERE `formal-prepass-vocabulary.test.ts` IS EXAMPLED
//   That file pins FIXED shapes: one document per arm, one per named refusal. This file states the
//   claim over ARBITRARY text, which is a different claim and the one Req 1.13 actually makes:
//   acceptance is EXACTLY the conjunction of three conditions - within the size bound, well-formed
//   JSON, and schema-satisfying - so a document failing any ONE of them in isolation must be
//   refused, and the refusal must name the first condition that failed. Each case shape below
//   breaks exactly one condition, which is what makes the conjunction testable rather than
//   confirmable.
//
// THE LOAD-BEARING HALF: A REJECTION CARRIES NO VALUE FROM THE OFFENDING DOCUMENT
//   A value in this document can be a host path, a fragment of RTL, or a line of a Yosys
//   diagnostic, which is why `prepass.ts`'s header states that no offending value is ever quoted
//   into an issue string. So every generated document is SEEDED with all three of those shapes -
//   in the reset name, the predicate, and the timing arm's `port`, `sources`, and `cause` - and no
//   seeded string may appear anywhere in the returned rejection.
//
//   Containment is sound HERE, where `gotcha-a-credential-leak-property-written-as-containment-is-
//   both-unsound-and-weak.md` found it unsound for credentials, for two reasons that are built into
//   the seeds rather than hoped for: every seed carries a marker that cannot occur in ajv's own
//   prose or in an `instancePath`, so a collision with the refusal text is impossible; and the
//   marker is checked on its own as well as the whole seed, so a TRUNCATED or re-worded leak is
//   caught too. The non-vacuity guard is the other half - the case asserts that the offending
//   document really did carry at least two seeds, or "no seed leaked" would hold of a document
//   that carried none. The rejection is also checked to carry no FIELD beyond its declared ones,
//   because a value cannot leak through a key that does not exist.
//
// WHY THE CASE TABLE IS EXHAUSTED AND NOT ONLY SAMPLED
//   The shapes are a closed, frozen table, and
//   `gotcha-a-closed-union-non-vacuity-row-should-be-exhausted-not-sampled.md` records that raising
//   `numRuns` is the wrong lever for that: at 100 runs over 16 shapes a shape is missed often
//   enough to matter. So the grading is a named function called from the property AND from a
//   deterministic loop over every shape, which makes coverage a fact rather than a sample.
//
// `MAX_PREPASS_REPORT_CHARS` is READ, never restated, so the concurrent task that may change it
// does not silently make the size clause vacuous here.
//
// **Validates: Requirements 1.13**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CLOCK_POLARITIES,
  MAX_PREPASS_REPORT_CHARS,
  parseFormalPrepassReport,
  type ClockPolarity,
  type FormalPrepassRejection,
  type PortTimingFacts,
  type PrepassTimingFinding,
  type PrepassTimingRefusalCause,
} from '@app/tools';

import { propertyParameters } from './property.js';

// **Feature: timing-contract-inference, Property 8: The report parse rejects what it does not recognize**
const PROPERTY =
  'timing-contract-inference, Property 8: The report parse rejects what it does not recognize';

/**
 * The token every seeded value carries, chosen so it cannot occur in ajv's prose or in a JSON path.
 *
 * Checked on its own alongside the whole seed, so a rejection quoting half a value still fails.
 */
const LEAK_MARKER = 'Zq7Leak';

/** The three refusal tokens, TYPED so a rename in `prepass.ts` is a compile error here. */
const TIMING_CAUSES: readonly PrepassTimingRefusalCause[] = [
  'module-instance',
  'unrecognized-clocked-cell',
  'cell-shape-unreadable',
];

/** An untrusted value in its three measured shapes: a host path, RTL text, and a tool diagnostic. */
interface Seeds {
  readonly path: string;
  readonly source: string;
  readonly diagnostic: string;
}

/**
 * The three seed shapes for one tag. No backslash and no double quote anywhere in them, so JSON
 * escaping cannot hide a leaked value from a containment check over the serialized rejection.
 */
function seedsFor(tag: number): Seeds {
  const mark = `${LEAK_MARKER}${tag}`;
  return {
    path: `/Users/${mark}/workspace/formal-prepass-report.json`,
    source: `assign ${mark}_out = ${mark}_in & 1'b1;`,
    diagnostic: `ERROR: syntax error near 'always' in ${mark}.v:12`,
  };
}

/** Every seed a case built from `tag` could carry, across the tag range the port entries use. */
function candidateSeeds(tag: number): readonly string[] {
  return [0, 1, 2, 3, 4, 5].flatMap((offset) => {
    const seeds = seedsFor(tag + offset);
    return [seeds.path, seeds.source, seeds.diagnostic];
  });
}

/** An untyped document fragment: these are wire shapes, and most of them are deliberately invalid. */
type WireObject = Record<string, unknown>;

/** The drawn part of a case: everything the shape itself does not fix. */
interface Draw {
  readonly tag: number;
  readonly polarity: ClockPolarity;
  readonly resetDerived: boolean;
  readonly cause: PrepassTimingRefusalCause;
  readonly portCount: number;
  readonly notJsonShape: number;
}

/**
 * One port's cone facts, seeded in every string field.
 *
 * `port` carries the diagnostic-shaped seed rather than a plausible port name on purpose: the
 * worker's answer is untrusted text, and a name is exactly the field a refusal would be tempted to
 * quote.
 */
function portEntry(tag: number, index: number): PortTimingFacts {
  const seeds = seedsFor(tag);
  return {
    port: seeds.diagnostic,
    sources: [seeds.path, seeds.source],
    reachesState: index % 2 === 0,
    undriven: index % 3 === 0,
  };
}

/** Several entries, each on its own tag so a leak can be traced to the field it came from. */
function portEntries(draw: Draw): readonly PortTimingFacts[] {
  return Array.from({ length: draw.portCount }, (_unused, index) =>
    portEntry(draw.tag + 1 + index, index),
  );
}

/** The same entry with one required field removed, built by filtering rather than by `delete`. */
function withoutField(entry: PortTimingFacts, field: keyof PortTimingFacts): WireObject {
  return Object.fromEntries(Object.entries(entry).filter(([name]) => name !== field));
}

/** A timing arm as it goes onto the wire, plus whether the whole document still satisfies the schema. */
interface TimingShape {
  readonly wire: unknown;
  /** The arm an ACCEPTED document must come back carrying, or `null` where the document is refused. */
  readonly arm: PrepassTimingFinding | null;
  readonly schemaSatisfying: boolean;
}

/** A schema-satisfying arm: the wire shape and the typed arm are the same value. */
function satisfying(arm: PrepassTimingFinding): TimingShape {
  return { wire: arm, arm, schemaSatisfying: true };
}

/** A shape the closed schema must refuse, so no arm is expected back. */
function refusedBySchema(wire: unknown): TimingShape {
  return { wire, arm: null, schemaSatisfying: false };
}

/** The case shapes, closed and frozen so the loop below can exhaust them. */
const CASE_KINDS = [
  'valid-derived-zero-ports',
  'valid-derived-several-ports',
  'valid-refused-module-instance',
  'valid-refused-unrecognized-clocked-cell',
  'valid-refused-cell-shape-unreadable',
  'too-large',
  'not-json',
  'cause-out-of-vocabulary',
  'cross-armed-derived-with-cause',
  'cross-armed-refused-with-ports',
  'port-missing-port',
  'port-missing-sources',
  'port-missing-reaches-state',
  'port-missing-undriven',
  'reaches-state-raw-zero',
  'undriven-raw-zero',
] as const;

type CaseKind = (typeof CASE_KINDS)[number];

/**
 * One timing shape per case kind, as a TOTAL record: a kind added to the list above without a shape
 * is a compile error rather than an untested member.
 *
 * `too-large` and `not-json` carry a VALID arm, because each case must break exactly one of the
 * three conditions - the bound and JSON well-formedness are broken by the TEXT, below, so the
 * document under them has to be otherwise acceptable or the refusal reason would not be decidable.
 */
const TIMING_BY_KIND: Readonly<Record<CaseKind, (draw: Draw) => TimingShape>> = {
  'valid-derived-zero-ports': () => satisfying({ derived: true, ports: [] }),
  'valid-derived-several-ports': (draw) => satisfying({ derived: true, ports: portEntries(draw) }),
  'valid-refused-module-instance': () => satisfying({ derived: false, cause: 'module-instance' }),
  'valid-refused-unrecognized-clocked-cell': () =>
    satisfying({ derived: false, cause: 'unrecognized-clocked-cell' }),
  'valid-refused-cell-shape-unreadable': () =>
    satisfying({ derived: false, cause: 'cell-shape-unreadable' }),
  'too-large': (draw) => satisfying({ derived: true, ports: portEntries(draw) }),
  'not-json': (draw) => satisfying({ derived: true, ports: portEntries(draw) }),
  // A cause the vocabulary does not hold, carrying a seeded value: the one shape where `cause`
  // itself is the untrusted text.
  'cause-out-of-vocabulary': (draw) =>
    refusedBySchema({ derived: false, cause: seedsFor(draw.tag).diagnostic }),
  // Cross-armed both ways: neither matches either closed arm, so `oneOf` must refuse both.
  'cross-armed-derived-with-cause': (draw) =>
    refusedBySchema({ derived: true, ports: [portEntry(draw.tag + 1, 0)], cause: draw.cause }),
  'cross-armed-refused-with-ports': (draw) =>
    refusedBySchema({ derived: false, cause: draw.cause, ports: [portEntry(draw.tag + 1, 0)] }),
  'port-missing-port': (draw) =>
    refusedBySchema({ derived: true, ports: [withoutField(portEntry(draw.tag + 1, 0), 'port')] }),
  'port-missing-sources': (draw) =>
    refusedBySchema({
      derived: true,
      ports: [withoutField(portEntry(draw.tag + 1, 0), 'sources')],
    }),
  'port-missing-reaches-state': (draw) =>
    refusedBySchema({
      derived: true,
      ports: [withoutField(portEntry(draw.tag + 1, 0), 'reachesState')],
    }),
  'port-missing-undriven': (draw) =>
    refusedBySchema({
      derived: true,
      ports: [withoutField(portEntry(draw.tag + 1, 0), 'undriven')],
    }),
  // The sharp coercion trap: JavaScript reads the non-empty string `"0"` as TRUTHY, so a raw bit
  // passed through from the netlist would arrive as `true` and invert the fact.
  'reaches-state-raw-zero': (draw) =>
    refusedBySchema({
      derived: true,
      ports: [{ ...portEntry(draw.tag + 1, 0), reachesState: '0' }],
    }),
  'undriven-raw-zero': (draw) =>
    refusedBySchema({ derived: true, ports: [{ ...portEntry(draw.tag + 1, 0), undriven: '0' }] }),
};

/** The predicate field, carrying two seeds, and padded past the size bound for the `too-large` case. */
function predicateFor(kind: CaseKind, seeds: Seeds): string {
  const body = `${seeds.source} // ${seeds.path}`;
  // Padded against the READ constant, so the concurrent task that may change it cannot leave this
  // document merely large rather than oversized.
  return kind === 'too-large' ? `${body} ${'x'.repeat(MAX_PREPASS_REPORT_CHARS)}` : body;
}

/**
 * Text that is not JSON, in three shapes, each still carrying at least two seeds.
 *
 * The first is a report with its final brace removed, which is the truncation a killed worker
 * leaves behind; the other two are prose and a document with an unquoted value.
 */
function notJsonTextFor(draw: Draw, json: string, seeds: Seeds): string {
  const shape = draw.notJsonShape % 3;
  if (shape === 0) return json.slice(0, -1);
  if (shape === 1) return `${seeds.path} ${seeds.source}`;
  return `{"reset": ${seeds.path}, "note": "${seeds.source}"}`;
}

/** One built case: the text to parse, what the conjunction says about it, and what it carries. */
interface BuiltCase {
  readonly kind: CaseKind;
  readonly text: string;
  readonly wellFormedJson: boolean;
  readonly schemaSatisfying: boolean;
  readonly timing: PrepassTimingFinding | null;
  /** The seeded values the text actually carries, so the no-leak clause cannot pass vacuously. */
  readonly seeds: readonly string[];
}

function buildCase(kind: CaseKind, draw: Draw): BuiltCase {
  const seeds = seedsFor(draw.tag);
  const shape = TIMING_BY_KIND[kind](draw);
  const document: WireObject = {
    reset: draw.resetDerived
      ? { derived: true, resetName: seeds.path, resetActiveLow: true, resetKind: 'sync' }
      : { derived: false },
    clockPolarity: draw.polarity,
    initialStatePredicate: predicateFor(kind, seeds),
    timing: shape.wire,
  };
  const json = JSON.stringify(document);
  const text = kind === 'not-json' ? notJsonTextFor(draw, json, seeds) : json;
  return {
    kind,
    text,
    wellFormedJson: kind !== 'not-json',
    schemaSatisfying: shape.schemaSatisfying,
    timing: shape.arm,
    seeds: candidateSeeds(draw.tag).filter((seed) => text.includes(seed)),
  };
}

/** The first condition of the conjunction that failed, which is the reason the parse must name. */
function expectedReason(
  withinBound: boolean,
  built: BuiltCase,
): FormalPrepassRejection['reason'] | null {
  if (!withinBound) return 'report-too-large';
  if (!built.wellFormedJson) return 'not-json';
  if (!built.schemaSatisfying) return 'schema-violation';
  return null;
}

/** The no-leaked-value clause: nothing from the offending document survives into the rejection. */
function assertCarriesNoValue(rejection: FormalPrepassRejection, built: BuiltCase): void {
  // Non-vacuity first: a document carrying no seed would satisfy every clause below for free.
  expect(built.seeds.length).toBeGreaterThanOrEqual(2);

  // One serialization covers every field of the rejection, the `issues` array included.
  const rendered = JSON.stringify(rejection);
  for (const seed of built.seeds) {
    expect(rendered).not.toContain(seed);
  }
  // The marker on its own, so a truncated or re-worded quotation is caught as well.
  expect(rendered).not.toContain(LEAK_MARKER);

  // A value cannot leak through a key that does not exist.
  expect(Object.keys(rejection).sort()).toEqual(
    rejection.reason === 'schema-violation' ? ['issues', 'reason'] : ['reason'],
  );
  if (rejection.reason === 'schema-violation') {
    // An empty issue list would make the containment check above hold of nothing.
    expect(rejection.issues.length).toBeGreaterThan(0);
  }
}

/**
 * Grade one case against the real parse.
 *
 * Named and called from both the property and the exhaustive loop, so every shape is graded on
 * every run rather than whenever the generator happens to draw it.
 */
function gradeCase(built: BuiltCase): void {
  const withinBound = built.text.length <= MAX_PREPASS_REPORT_CHARS;
  const reason = expectedReason(withinBound, built);
  const result = parseFormalPrepassReport(built.text);

  expect(result.ok).toBe(reason === null);
  if (result.ok) {
    // Round-trip: the arm comes back entry for entry, so the parse normalizes and drops nothing.
    expect(result.value.timing).toEqual(built.timing);
    return;
  }
  expect(result.error.reason).toBe(reason);
  assertCarriesNoValue(result.error, built);
}

const drawArbitrary: fc.Arbitrary<Draw> = fc.record({
  // Three digits throughout, so no seed is a prefix of another tag's seed.
  tag: fc.integer({ min: 100, max: 899 }),
  polarity: fc.constantFrom(...CLOCK_POLARITIES),
  resetDerived: fc.boolean(),
  cause: fc.constantFrom(...TIMING_CAUSES),
  // "Several" ports, against the zero-port shape that has its own kind.
  portCount: fc.integer({ min: 2, max: 4 }),
  notJsonShape: fc.integer({ min: 0, max: 2 }),
});

/** The draw the exhaustive loop uses: fixed, because the loop's job is coverage and not search. */
const FIXED_DRAW: Draw = {
  tag: 500,
  polarity: 'posedge',
  resetDerived: true,
  cause: 'module-instance',
  portCount: 3,
  notJsonShape: 0,
};

describe(PROPERTY, () => {
  it('accepts exactly the within-bound, well-formed, schema-satisfying documents and quotes no offending value when it refuses', () => {
    fc.assert(
      fc.property(fc.constantFrom(...CASE_KINDS), drawArbitrary, (kind, draw) => {
        gradeCase(buildCase(kind, draw));
      }),
      propertyParameters(),
    );
  });

  it('grades every case shape on every run', () => {
    for (const kind of CASE_KINDS) {
      gradeCase(buildCase(kind, FIXED_DRAW));
    }
  });
});
