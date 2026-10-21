// timing-contract-inference, Property 9: a Timing_Refusal carries declared output port NAMES and a
// closed cause TOKEN, and nothing else - no host file path, no design source text, no tool
// diagnostic text (task 4.11, Req 2.5).
//
// THE SUBTLETY THAT MAKES THIS PROPERTY HONEST, AND HOW THE TWO HALVES ARE SEPARATED
//   A declared output port's NAME is PERMITTED in the refusal: that is what `ports` is for. So
//   seeding a port name with a path-shaped string and then asserting the path is absent would
//   assert the opposite of the requirement. The two halves are therefore stated differently:
//     - The fields that must NOT leak are SEEDED, and the claim over them is absence. Those are
//       every `sources` entry, the `port` of facts for a port the interface does not declare, the
//       design-level refusal `cause`, and the module name.
//     - Over `ports` the claim is the COMPLEMENT: every name it carries is a declared output port
//       name of the drawn interface. That is the precise form of "names, and nothing more".
//     - The refusal's KEY SET is asserted to be exactly `cause` and `ports`, because a value
//       cannot leak through a key that does not exist, and that is the cheapest check that no
//       diagnostic field was added beside the two.
//
// WHY THIS IS NOT A NAIVE CONTAINMENT CHECK
//   `gotcha-a-credential-leak-property-written-as-containment-is-both-unsound-and-weak.md` records
//   that containment over randomly drawn values is unsound (the value collides with the emitter's
//   own prose) and weak (a random string never collides, so the check also passes on an emitter
//   that leaks a TRUNCATED or RE-WORDED value). Its mitigation is applied here:
//     - every seed carries a MARKER containing `@`, a character no cause token and no drawn port
//       name can hold, so a reported absence cannot be a collision with legitimate text, and the
//       self-check test below asserts that disjointness rather than assuming it;
//     - the whole seed, the marker alone, and the marker CHARACTER alone are each scanned, so a
//       leak that truncated or re-wrapped the seed is still caught;
//     - every graded draw asserts that the finding really CARRIED a seed, because "nothing leaked"
//       is free of a document that carried nothing to leak.
//   The scan walks the returned value recursively and collects KEYS as well as values, so a leak
//   through a field this file does not know about is scanned too.
//
// WHAT THE GENERATOR OWES
//   Every draw must REFUSE, since a contract-returning draw exercises nothing here, and the draws
//   must reach several causes. The pivot output port is always drawn on a refusing ending that
//   still produces a facts entry, which makes both obligations structural rather than sampled: the
//   refusal arm is reached on every draw and the seeded `sources` of that entry is the seed the
//   non-vacuity assertion stands on. The four causes `classifyPortTiming` produces are counted,
//   and the closed set of shapes is pinned in a second test rather than sampled, per
//   `gotcha-a-closed-union-non-vacuity-row-should-be-exhausted-not-sampled.md`.
//
// **Validates: Requirements 2.5**

import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ModuleInterface, Port } from '@app/core';
import {
  classifyPortTiming,
  type PortTimingFacts,
  type PrepassTimingFinding,
  type PrepassTimingRefusalCause,
  type TimingRefusal,
  type TimingRefusalCause,
} from '@app/tools';

import { ASCII_IDENT_CHARS, stringFromChars } from './generators/chars.js';
import { propertyParameters } from './property.js';

// **Feature: timing-contract-inference, Property 9: A refusal leaks nothing but port names and a cause**
const PROPERTY =
  'timing-contract-inference, Property 9: A refusal leaks nothing but port names and a cause';

/** The five-member refusal vocabulary, TYPED so a rename in `timing.ts` fails to compile here. */
const TIMING_REFUSAL_CAUSES: readonly TimingRefusalCause[] = [
  'netlist-unavailable',
  'netlist-walk-unreliable',
  'port-not-reported',
  'undriven-output-port',
  'input-and-state-independent',
];

/** The two keys a `TimingRefusal` may have, sorted, which is the whole of its admitted shape. */
const REFUSAL_KEYS: readonly string[] = ['cause', 'ports'];

/** The one character every marker carries. No cause token and no drawn port name holds it. */
const MARKER_CHAR = '@';

/** The three classes of text Req 2.5 excludes by name. */
type SeedKind = 'host-path' | 'design-source' | 'tool-diagnostic';

interface Seed {
  readonly kind: SeedKind;
  /** The marker, scanned on its own so a truncated or re-wrapped leak is still caught. */
  readonly marker: string;
  readonly text: string;
}

/**
 * The strings planted in every field that must not leak: two per excluded class of Req 2.5.
 *
 * Shaped like the real thing - a host workspace path, a line of RTL, a tool diagnostic - because
 * the claim is about those three classes and a nondescript random string is not evidence about any
 * of them. None of them is a secret, so a printed counterexample is safe to read.
 */
const POSIX_PATH_SEED: Seed = {
  kind: 'host-path',
  marker: '@@L1@@',
  text: '/Users/founder/work/@@L1@@/build/netlist.json',
};

const WINDOWS_PATH_SEED: Seed = {
  kind: 'host-path',
  marker: '@@L2@@',
  text: 'C:\\sandbox\\@@L2@@\\formal-prepass-report.json',
};

const RTL_STATEMENT_SEED: Seed = {
  kind: 'design-source',
  marker: '@@L3@@',
  text: 'always @(posedge clk) q <= d; // @@L3@@',
};

const RTL_ASSIGN_SEED: Seed = {
  kind: 'design-source',
  marker: '@@L4@@',
  text: 'assign y = a & ~b; /* @@L4@@ */',
};

const SYNTAX_DIAGNOSTIC_SEED: Seed = {
  kind: 'tool-diagnostic',
  marker: '@@L5@@',
  text: "ERROR: /tmp/t.v:12: syntax error near '@@L5@@'",
};

const CELL_DIAGNOSTIC_SEED: Seed = {
  kind: 'tool-diagnostic',
  marker: '@@L6@@',
  text: 'yosys: cell $dff shape unreadable (@@L6@@)',
};

const SEEDS: readonly Seed[] = Object.freeze([
  POSIX_PATH_SEED,
  WINDOWS_PATH_SEED,
  RTL_STATEMENT_SEED,
  RTL_ASSIGN_SEED,
  SYNTAX_DIAGNOSTIC_SEED,
  CELL_DIAGNOSTIC_SEED,
]);

/** The clause ending one output port is BUILT to land on. Intent for the generator only. */
const PORT_OUTCOMES = [
  'omitted-from-report',
  'undriven',
  'reaches-data-input',
  'state-only',
  'inert',
] as const;

type PortOutcome = (typeof PORT_OUTCOMES)[number];

/**
 * The refusing endings the PIVOT port may take: both still produce a facts entry.
 *
 * Both refuse whatever else the draw does, which is what makes the refusal arm structural.
 * `undriven` refuses ahead of every other clause, and `inert` refuses because its only source is a
 * seed string, which no interface can declare as a data input. `omitted-from-report` is excluded
 * here only because it produces NO facts entry, so it would leave a finding carrying no seed on a
 * draw where nothing else did.
 */
const PIVOT_OUTCOMES: readonly PortOutcome[] = ['undriven', 'inert'];

/** The clock and reset, reported unsubtracted by the worker and subtracted by the classifier. */
const CLOCKISH_SOURCES: readonly string[] = ['clk', 'rst_n'];

/** The declared output port present on every draw, on an ending that always refuses. */
const PIVOT_PORT = 'pivot_q';

/** The prefix on every drawn output port name, keeping them disjoint from `PIVOT_PORT`. */
const OUTPUT_PREFIX = 'o_';

/** One drawn output port: its name suffix and the clause ending it is built to land on. */
interface DrawnOutput {
  readonly suffix: string;
  readonly outcome: PortOutcome;
}

/** Everything about one case the shape itself does not fix. */
interface Draw {
  readonly outputs: readonly DrawnOutput[];
  /** The pivot's ending, which is what guarantees the refusal arm is reached. */
  readonly pivotOutcome: PortOutcome;
  readonly dataInputCount: number;
  readonly clockNamed: boolean;
  readonly resetNamed: boolean;
  readonly walkDerived: boolean;
  /** How many facts entries name a port the interface does not declare. */
  readonly ghostCount: number;
  /** Seeded into the `sources` of every facts entry. */
  readonly sourceSeed: Seed;
  /** Seeded into the `port` of each undeclared facts entry, which no refusal may name. */
  readonly ghostSeed: Seed;
  /** Seeded into the design-level refusal `cause` the worker hands across. */
  readonly causeSeed: Seed;
  /** Seeded into the module name: design-level text, and never a port name. */
  readonly moduleNameSeed: Seed;
}

/** One declared output port of the draw: its name, and the clause ending it is built for. */
interface PlannedPort {
  readonly name: string;
  readonly outcome: PortOutcome;
}

/** The declared output ports of the draw, in declaration order, pivot last. */
function portPlan(draw: Draw): readonly PlannedPort[] {
  return [
    ...draw.outputs.map((output) => ({
      name: `${OUTPUT_PREFIX}${output.suffix}`,
      outcome: output.outcome,
    })),
    { name: PIVOT_PORT, outcome: draw.pivotOutcome },
  ];
}

/** The declared output port names of the draw, in declaration order. */
function outputNamesOf(draw: Draw): readonly string[] {
  return portPlan(draw).map((planned) => planned.name);
}

function inputPort(name: string, width: number): Port {
  return { name, direction: 'input', width };
}

/** The interface the draw describes. Built from literals, since no drawn shape needs validating. */
function interfaceOf(draw: Draw): ModuleInterface {
  const dataInputs = Array.from({ length: draw.dataInputCount }, (_unused, index) =>
    inputPort(`d${index}`, index + 1),
  );
  const outputs: readonly Port[] = outputNamesOf(draw).map((name, index) => ({
    name,
    direction: 'output',
    width: index + 1,
  }));
  return {
    moduleName: draw.moduleNameSeed.text,
    ports: [...CLOCKISH_SOURCES.map((name) => inputPort(name, 1)), ...dataInputs, ...outputs],
    clocking: {
      clockName: draw.clockNamed ? 'clk' : null,
      resetName: draw.resetNamed ? 'rst_n' : null,
      resetActiveLow: true,
    },
    validityOutputName: null,
  };
}

/** The data input this draw's cones reach, or `null` where the interface declares none. */
function reachableDataInput(draw: Draw): string | null {
  return draw.dataInputCount > 0 ? 'd0' : null;
}

/**
 * The cone facts for one output port, or `null` where the ending is for the report to omit it.
 *
 * The seed sits in `sources` on EVERY entry, including the ones that classify, because a careless
 * implementation could gather the sources of every port rather than of the refused ones. It cannot
 * change any classification: clause 3 intersects `sources` with the declared input names, and a
 * seed holds `@`, which no port of this interface is named with.
 */
function factsFor(draw: Draw, portName: string, outcome: PortOutcome): PortTimingFacts | null {
  const dataInput = reachableDataInput(draw);
  const reaching = [
    draw.sourceSeed.text,
    ...CLOCKISH_SOURCES,
    ...(dataInput === null ? [] : [dataInput]),
  ];
  if (outcome === 'omitted-from-report') return null;
  if (outcome === 'undriven') {
    return { port: portName, sources: reaching, reachesState: true, undriven: true };
  }
  if (outcome === 'reaches-data-input') {
    return { port: portName, sources: reaching, reachesState: false, undriven: false };
  }
  if (outcome === 'state-only') {
    return {
      port: portName,
      sources: [draw.sourceSeed.text, ...CLOCKISH_SOURCES],
      reachesState: true,
      undriven: false,
    };
  }
  return { port: portName, sources: [draw.sourceSeed.text], reachesState: false, undriven: false };
}

/** Facts for ports the interface does not declare, each NAMED with a seed the refusal must drop. */
function undeclaredFacts(draw: Draw): readonly PortTimingFacts[] {
  return Array.from({ length: draw.ghostCount }, (_unused, index) => ({
    port: index === 0 ? draw.ghostSeed.text : `${draw.ghostSeed.text}:${index}`,
    sources: [draw.sourceSeed.text, ...CLOCKISH_SOURCES],
    reachesState: index % 2 === 0,
    undriven: index % 2 === 1,
  }));
}

/**
 * The finding the draw describes: the seeded refused walk, or the entries the plan asks for.
 *
 * The refused arm's `cause` is a CLOSED token on the wire, so planting a seed there needs the cast
 * below and that is exactly why the probe is worth writing: the claim is that no worker text
 * reaches the refusal, and a run restricted to the three real tokens cannot tell that apart from an
 * implementation that passes through whichever token it happens to recognize.
 */
function findingOf(draw: Draw): PrepassTimingFinding {
  if (!draw.walkDerived) {
    return { derived: false, cause: draw.causeSeed.text as PrepassTimingRefusalCause };
  }
  const declared = portPlan(draw)
    .map((planned) => factsFor(draw, planned.name, planned.outcome))
    .filter((facts): facts is PortTimingFacts => facts !== null);
  return { derived: true, ports: [...declared, ...undeclaredFacts(draw)] };
}

/**
 * Every string reachable in `value`, KEYS included.
 *
 * Keys are collected because a leak can arrive as one - a field named after the offending path is
 * the same disclosure as a field holding it - and the recursion covers a field this file does not
 * know the shape of.
 */
function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === 'string') {
    into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      into.push(key);
      collectStrings(item, into);
    }
  }
}

/** The seeds whose text really occurs in `value`. The non-vacuity measure, not an expectation. */
function seedsCarriedBy(value: unknown): readonly Seed[] {
  const texts: string[] = [];
  collectStrings(value, texts);
  return SEEDS.filter((seed) => texts.some((text) => text.includes(seed.text)));
}

/**
 * No field of `refusal` carries any planted seed, its marker, or the marker character.
 *
 * Three layers rather than one: the whole seed catches a verbatim leak, the marker catches a leak
 * that kept only part of the seed, and the marker CHARACTER catches a leak truncated below the
 * marker itself. The third is sound only because no legitimate cause token or port name holds that
 * character, which the self-check test below asserts.
 */
function expectNoLeak(refusal: TimingRefusal, planted: readonly Seed[]): void {
  const texts: string[] = [];
  collectStrings(refusal, texts);
  for (const text of texts) {
    expect(text).not.toContain(MARKER_CHAR);
    for (const seed of planted) {
      expect(text).not.toContain(seed.text);
      expect(text).not.toContain(seed.marker);
    }
  }
}

/** How many shapes the run actually saw, so no clause of the claim can pass vacuously. */
interface Coverage {
  readonly causes: Set<TimingRefusalCause>;
  readonly seedKinds: Set<SeedKind>;
  refusedWalk: number;
  derivedWalk: number;
  ghostNamesPresent: number;
  portsNamed: number;
}

function emptyCoverage(): Coverage {
  return {
    causes: new Set(),
    seedKinds: new Set(),
    refusedWalk: 0,
    derivedWalk: 0,
    ghostNamesPresent: 0,
    portsNamed: 0,
  };
}

function recordCoverage(
  coverage: Coverage,
  draw: Draw,
  planted: readonly Seed[],
  refusal: TimingRefusal,
): void {
  coverage.causes.add(refusal.cause);
  for (const seed of planted) coverage.seedKinds.add(seed.kind);
  if (draw.walkDerived) coverage.derivedWalk += 1;
  else coverage.refusedWalk += 1;
  if (draw.walkDerived && draw.ghostCount > 0) coverage.ghostNamesPresent += 1;
  if (refusal.ports.length > 0) coverage.portsNamed += 1;
}

/** Grade one draw: it refuses, the refusal is shaped as `{cause, ports}`, and nothing leaked. */
function gradeDraw(coverage: Coverage, draw: Draw): void {
  const moduleInterface = interfaceOf(draw);
  const finding = findingOf(draw);
  const planted = seedsCarriedBy(finding);
  // Non-vacuity, per draw: "nothing leaked" holds trivially of a finding that carried nothing.
  expect(planted.length).toBeGreaterThan(0);

  const classified = classifyPortTiming(moduleInterface, finding);
  // The generator's own obligation: a contract-returning draw exercises none of the claim.
  expect(classified.ok).toBe(false);
  if (classified.ok) return;

  const refusal = classified.error;
  // The leak claim itself, asserted FIRST and over every string the value holds, so a leak is
  // reported as a leak rather than as whichever structural clause below it happens to also break.
  expectNoLeak(refusal, [...planted, draw.moduleNameSeed]);
  // The admitted SHAPE. A value cannot leak through a key that does not exist, so the cheapest
  // check that no diagnostic field was added is that there is no third key at all.
  expect(Object.keys(refusal).sort()).toEqual([...REFUSAL_KEYS]);
  // The cause is a token OF THE CLOSED VOCABULARY, which is the other half of "a cause": a
  // free-form string here would be a channel for whatever the worker said.
  expect(TIMING_REFUSAL_CAUSES).toContain(refusal.cause);
  // `ports` by its COMPLEMENT, since a declared output port NAME is exactly what it may carry: no
  // name in it is anything other than a declared output port name of this interface.
  const declaredOutputs = outputNamesOf(draw);
  for (const portName of refusal.ports) {
    expect(declaredOutputs).toContain(portName);
  }

  recordCoverage(coverage, draw, [...planted, draw.moduleNameSeed], refusal);
}

const seedArbitrary: fc.Arbitrary<Seed> = fc.constantFrom(...SEEDS);

const drawArbitrary: fc.Arbitrary<Draw> = fc.record({
  outputs: fc.uniqueArray(
    fc.record({
      suffix: stringFromChars(ASCII_IDENT_CHARS, 1, 6),
      outcome: fc.constantFrom(...PORT_OUTCOMES),
    }),
    { selector: (output) => output.suffix, minLength: 0, maxLength: 4 },
  ),
  pivotOutcome: fc.constantFrom(...PIVOT_OUTCOMES),
  // Zero included: an interface with no declared data input decides every port by state alone.
  dataInputCount: fc.integer({ min: 0, max: 3 }),
  clockNamed: fc.boolean(),
  resetNamed: fc.boolean(),
  // Weighted towards the derived walk, which is the arm carrying the per-port seeds.
  walkDerived: fc.oneof(
    { arbitrary: fc.constant(true), weight: 4 },
    { arbitrary: fc.constant(false), weight: 1 },
  ),
  ghostCount: fc.integer({ min: 0, max: 2 }),
  sourceSeed: seedArbitrary,
  ghostSeed: seedArbitrary,
  causeSeed: seedArbitrary,
  moduleNameSeed: seedArbitrary,
});

/** The base every constructed draw below varies, so each row states only what it is about. */
const BASE_DRAW: Draw = {
  outputs: [{ suffix: 'ready', outcome: 'reaches-data-input' }],
  pivotOutcome: 'undriven',
  dataInputCount: 2,
  clockNamed: true,
  resetNamed: true,
  walkDerived: true,
  ghostCount: 1,
  sourceSeed: POSIX_PATH_SEED,
  ghostSeed: RTL_STATEMENT_SEED,
  causeSeed: SYNTAX_DIAGNOSTIC_SEED,
  moduleNameSeed: WINDOWS_PATH_SEED,
};

/**
 * The shapes whose coverage is PINNED rather than sampled: one per cause `classifyPortTiming`
 * produces, plus the seed placements a sampled run can miss.
 */
const CONSTRUCTED_DRAWS: Readonly<Record<string, Draw>> = Object.freeze({
  'the whole walk refused, carrying a diagnostic-shaped cause': {
    ...BASE_DRAW,
    walkDerived: false,
    causeSeed: CELL_DIAGNOSTIC_SEED,
  },
  'a port the report omits, which dominates the undriven pivot': {
    ...BASE_DRAW,
    outputs: [
      { suffix: 'omitted', outcome: 'omitted-from-report' },
      { suffix: 'comb', outcome: 'reaches-data-input' },
    ],
  },
  'an undriven pivot beside two classified ports': {
    ...BASE_DRAW,
    outputs: [
      { suffix: 'comb', outcome: 'reaches-data-input' },
      { suffix: 'seq', outcome: 'state-only' },
    ],
  },
  'an inert pivot, every other port classified': {
    ...BASE_DRAW,
    pivotOutcome: 'inert',
    outputs: [
      { suffix: 'comb', outcome: 'reaches-data-input' },
      { suffix: 'seq', outcome: 'state-only' },
    ],
  },
  'two undeclared facts entries named with a source-shaped seed': {
    ...BASE_DRAW,
    ghostCount: 2,
    ghostSeed: RTL_ASSIGN_SEED,
  },
  'no undeclared facts entry at all': { ...BASE_DRAW, ghostCount: 0 },
  'the pivot is the only declared output port': { ...BASE_DRAW, outputs: [] },
  'no data input, so state dependence decides alone': { ...BASE_DRAW, dataInputCount: 0 },
  'clk and rst_n declared as inputs but named by neither clocking field': {
    ...BASE_DRAW,
    clockNamed: false,
    resetNamed: false,
  },
  'one host-path seed in every seeded field at once': {
    ...BASE_DRAW,
    sourceSeed: WINDOWS_PATH_SEED,
    ghostSeed: WINDOWS_PATH_SEED,
    causeSeed: WINDOWS_PATH_SEED,
    moduleNameSeed: WINDOWS_PATH_SEED,
  },
});

describe(PROPERTY, () => {
  let coverage = emptyCoverage();

  beforeEach(() => {
    coverage = emptyCoverage();
  });

  it('plants markers no legitimate cause token or port name could carry', () => {
    // The soundness guard the three-layer scan stands on: were `@` legitimate anywhere in a
    // refusal, the marker-character layer would report a leak that never happened.
    for (const cause of TIMING_REFUSAL_CAUSES) {
      expect(cause).not.toContain(MARKER_CHAR);
    }
    expect(ASCII_IDENT_CHARS).not.toContain(MARKER_CHAR);
    for (const fixedName of [...CLOCKISH_SOURCES, PIVOT_PORT, OUTPUT_PREFIX, 'd0']) {
      expect(fixedName).not.toContain(MARKER_CHAR);
    }
    // Each seed really carries its own distinct marker, and all three excluded classes of Req 2.5
    // are represented, so an absence is evidence about paths, source text, AND diagnostics.
    for (const seed of SEEDS) {
      expect(seed.text).toContain(seed.marker);
      expect(seed.marker).toContain(MARKER_CHAR);
    }
    expect(new Set(SEEDS.map((seed) => seed.marker)).size).toBe(SEEDS.length);
    expect(new Set(SEEDS.map((seed) => seed.kind)).size).toBe(3);
  });

  it('returns a refusal carrying declared output port names and a closed cause, and nothing else', () => {
    fc.assert(
      fc.property(drawArbitrary, (draw) => {
        gradeDraw(coverage, draw);
      }),
      propertyParameters(),
    );

    // More than one cause reached, since a single-cause run says nothing about the others.
    expect(coverage.causes.size).toBeGreaterThan(1);
    expect(coverage.refusedWalk).toBeGreaterThan(0);
    expect(coverage.derivedWalk).toBeGreaterThan(0);
    expect(coverage.ghostNamesPresent).toBeGreaterThan(0);
    // A refusal naming NO port would satisfy the complement clause vacuously.
    expect(coverage.portsNamed).toBeGreaterThan(0);
  });

  it('grades every pinned shape on every run', () => {
    for (const draw of Object.values(CONSTRUCTED_DRAWS)) {
      gradeDraw(coverage, draw);
    }

    // All four causes this classifier produces. `netlist-unavailable` is the Timing_Derivation
    // port's and is unreachable from here, which is why the count is four rather than five.
    expect(coverage.causes).toEqual(
      new Set<TimingRefusalCause>([
        'netlist-walk-unreliable',
        'port-not-reported',
        'undriven-output-port',
        'input-and-state-independent',
      ]),
    );
    expect(coverage.seedKinds.size).toBe(3);
    expect(coverage.refusedWalk).toBeGreaterThan(0);
    expect(coverage.derivedWalk).toBeGreaterThan(0);
    expect(coverage.ghostNamesPresent).toBeGreaterThan(0);
    expect(coverage.portsNamed).toBeGreaterThan(0);
  });
});
