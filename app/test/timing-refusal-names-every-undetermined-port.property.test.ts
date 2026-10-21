// timing-contract-inference, Property 2: a Timing_Refusal names EVERY declared output port the
// ordered rule left undetermined, and nothing else (task 4.6).
//
// WHY A SECOND STATEMENT OF THE RULE LIVES IN THIS FILE
//   The claim is a SET EQUALITY, so the expectation cannot come from asking `timing.ts` what the
//   answer is. `ruleVerdicts` below walks the five clauses over the drawn interface and finding
//   itself. That buys independence on the half this property is about - the ASSEMBLY of the set -
//   because every failure mode Req 2.2 forbids lives there: naming only the FIRST undetermined
//   port, naming a SUPERSET such as every declared output port, naming the same port twice, and
//   naming a port the interface never declared. The per-port clause chain is restated rather than
//   imported for the other direction: a clause whose order silently changes fails here too.
//
// WHAT THE GENERATOR MUST PRODUCE, OR THE PROPERTY IS NEARLY FREE
//   Only a PROPER, NON-EMPTY subset of the declared output ports separates "every" from "the
//   first" and from "all of them". A generator that only ever leaves zero or all ports
//   undetermined would pass a classifier that named just the first one. So each output port draws
//   an intended clause ending, and the run asserts it really saw that shape rather than assuming
//   it; the all-undetermined, none-undetermined, mixed-cause, undeclared-facts, refused-walk and
//   zero-output shapes are pinned by the frozen table below instead of sampled, because
//   `gotcha-a-closed-union-non-vacuity-row-should-be-exhausted-not-sampled.md` records that
//   raising `numRuns` is the wrong lever for coverage of a closed set of shapes.
//
//   The drawn plan is INTENT ONLY and is never the expectation. A draw where the intent misfires -
//   `clk` declared as an input but NOT named by `clocking`, which makes it a Declared_Data_Input
//   and turns an intended state-only port combinational - is graded on what the rule actually
//   says, which is the point of deriving the expectation from the built values.
//
// WHAT THIS FILE DELIBERATELY DOES NOT CLAIM
//   Which cause a mixed-cause refusal reports is a separate claim owned by another task's
//   property. The cause is derived here only to count the mixed-cause draws, never asserted.
//
// **Validates: Requirements 2.2, 1.8**

import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ModuleInterface, Port, PortTiming } from '@app/core';
import {
  classifyPortTiming,
  type PortTimingFacts,
  type PrepassTimingFinding,
  type PrepassTimingRefusalCause,
  type TimingRefusalCause,
} from '@app/tools';

import { propertyParameters } from './property.js';

// **Feature: timing-contract-inference, Property 2: A refusal names every undetermined port, and only those**
const PROPERTY =
  'timing-contract-inference, Property 2: A refusal names every undetermined port, and only those';

/**
 * The clause ending one output port is BUILT to land on. Intent for the generator, never the
 * expectation: three of the five leave a port undetermined, two classify it.
 */
const PORT_OUTCOMES = [
  'omitted-from-report',
  'undriven',
  'reaches-data-input',
  'state-only',
  'inert',
] as const;

type PortOutcome = (typeof PORT_OUTCOMES)[number];

/** The worker's three design-level refusal tokens, TYPED so a rename there fails to compile here. */
const WALK_REFUSAL_CAUSES: readonly PrepassTimingRefusalCause[] = [
  'module-instance',
  'unrecognized-clocked-cell',
  'cell-shape-unreadable',
];

/**
 * The clock and reset names, seeded into every state-dependent cone whether or not the interface
 * declares them as ports and whether or not `clocking` names them.
 *
 * Unsubtracted sources are what the worker really reports, so a cone naming only these two is the
 * Moore shape where `clocking` names them and an ordinary combinational cone where it does not.
 */
const CLOCKISH_SOURCES: readonly string[] = ['clk', 'rst_n'];

/** Everything about one case the shape itself does not fix. */
interface Draw {
  /** One intended clause ending per declared output port, in declaration order. */
  readonly outcomes: readonly PortOutcome[];
  readonly dataInputCount: number;
  /** Whether `clk` and `rst_n` are declared input ports at all. */
  readonly declareClockPorts: boolean;
  readonly clockNamed: boolean;
  readonly resetNamed: boolean;
  readonly walkDerived: boolean;
  readonly walkCause: PrepassTimingRefusalCause;
  /** Cone facts for ports the interface does not declare, which no refusal may name. */
  readonly undeclaredFactsCount: number;
  /** Report the entries in reverse declaration order, since the rule must not read order. */
  readonly factsReversed: boolean;
}

function inputPort(name: string, width: number): Port {
  return { name, direction: 'input', width };
}

/** The interface the draw describes: the clock and reset ports, the data inputs, and the outputs. */
function interfaceOf(draw: Draw): ModuleInterface {
  const clockPorts = draw.declareClockPorts
    ? [inputPort('clk', 1), inputPort('rst_n', 1)]
    : [inputPort('en', 1)];
  const dataInputs = Array.from({ length: draw.dataInputCount }, (_unused, index) =>
    inputPort(`d${index}`, index + 1),
  );
  const outputs: readonly Port[] = draw.outcomes.map((_unused, index) => ({
    name: `out${index}`,
    direction: 'output',
    width: index + 1,
  }));
  return {
    moduleName: 'drawn_design',
    ports: [...clockPorts, ...dataInputs, ...outputs],
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
 * The cone facts for one output port, or `null` where the outcome is for the report to omit it.
 *
 * `undriven` carries a reached data input on purpose: clause 2 runs ahead of clause 3, so that
 * port must still come back undetermined (Req 1.17, 1.18).
 */
function factsFor(draw: Draw, portName: string, outcome: PortOutcome): PortTimingFacts | null {
  const dataInput = reachableDataInput(draw);
  const withDataInput = [...CLOCKISH_SOURCES, ...(dataInput === null ? [] : [dataInput])];
  if (outcome === 'omitted-from-report') return null;
  if (outcome === 'undriven') {
    return { port: portName, sources: withDataInput, reachesState: true, undriven: true };
  }
  if (outcome === 'reaches-data-input') {
    return { port: portName, sources: withDataInput, reachesState: false, undriven: false };
  }
  if (outcome === 'state-only') {
    return { port: portName, sources: CLOCKISH_SOURCES, reachesState: true, undriven: false };
  }
  return { port: portName, sources: [], reachesState: false, undriven: false };
}

/** Cone facts for ports the interface does not declare, which the rule must simply ignore. */
function undeclaredFacts(draw: Draw): readonly PortTimingFacts[] {
  return Array.from({ length: draw.undeclaredFactsCount }, (_unused, index) => ({
    port: `ghost${index}`,
    sources: [...CLOCKISH_SOURCES],
    reachesState: index % 2 === 0,
    undriven: index % 2 === 1,
  }));
}

/** The finding the draw describes: the refused walk, or the entries the plan asks for. */
function findingOf(draw: Draw): PrepassTimingFinding {
  if (!draw.walkDerived) return { derived: false, cause: draw.walkCause };
  const declared = draw.outcomes
    .map((outcome, index) => factsFor(draw, `out${index}`, outcome))
    .filter((facts): facts is PortTimingFacts => facts !== null);
  const ports = [...declared, ...undeclaredFacts(draw)];
  return { derived: true, ports: draw.factsReversed ? [...ports].reverse() : ports };
}

/** The declared output port names, in declaration order and deduplicated. */
function declaredOutputNames(moduleInterface: ModuleInterface): readonly string[] {
  return [
    ...new Set(
      moduleInterface.ports.filter((port) => port.direction === 'output').map((port) => port.name),
    ),
  ];
}

/** The Declared_Data_Input set: every input port MINUS the named clock and reset (Req 1.2, 1.3). */
function dataInputNames(moduleInterface: ModuleInterface): ReadonlySet<string> {
  const names = new Set(
    moduleInterface.ports.filter((port) => port.direction === 'input').map((port) => port.name),
  );
  const { clockName, resetName } = moduleInterface.clocking;
  if (clockName !== null) names.delete(clockName);
  if (resetName !== null) names.delete(resetName);
  return names;
}

/** One port's outcome under the restated rule: a timing value, or the cause that left it open. */
type Verdict = { readonly timing: PortTiming } | { readonly undeterminedCause: TimingRefusalCause };

/**
 * The independent expectation: the five clauses in order, restated over the BUILT interface and
 * finding rather than read back from `classifyPortTiming`.
 *
 * Keyed in declaration order over the declared output ports only, so a port the interface does not
 * declare has no verdict and cannot be expected in any refusal.
 */
function ruleVerdicts(
  moduleInterface: ModuleInterface,
  finding: PrepassTimingFinding,
): ReadonlyMap<string, Verdict> {
  const dataInputs = dataInputNames(moduleInterface);
  const reported = finding.derived
    ? new Map(finding.ports.map((facts) => [facts.port, facts]))
    : null;
  return new Map(
    declaredOutputNames(moduleInterface).map((portName) => [
      portName,
      verdictFor(reported, portName, dataInputs),
    ]),
  );
}

/** The five clauses, in their fixed order, for one declared output port. */
function verdictFor(
  reported: ReadonlyMap<string, PortTimingFacts> | null,
  portName: string,
  dataInputs: ReadonlySet<string>,
): Verdict {
  if (reported === null) return { undeterminedCause: 'netlist-walk-unreliable' };
  const facts = reported.get(portName);
  if (facts === undefined) return { undeterminedCause: 'port-not-reported' };
  if (facts.undriven) return { undeterminedCause: 'undriven-output-port' };
  if (facts.sources.some((source) => dataInputs.has(source))) return { timing: 'combinational' };
  if (facts.reachesState) return { timing: 'registered' };
  return { undeterminedCause: 'input-and-state-independent' };
}

function isUndetermined(verdict: Verdict): boolean {
  return 'undeterminedCause' in verdict;
}

/** The declared output ports the restated rule left undetermined, in declaration order. */
function undeterminedNames(verdicts: ReadonlyMap<string, Verdict>): readonly string[] {
  return [...verdicts].filter(([, verdict]) => isUndetermined(verdict)).map(([name]) => name);
}

/** How many shapes the run actually saw, so no clause of the claim can pass vacuously. */
interface Coverage {
  properSubset: number;
  allUndetermined: number;
  noneUndetermined: number;
  mixedCause: number;
  undeclaredFactsPresent: number;
}

function emptyCoverage(): Coverage {
  return {
    properSubset: 0,
    allUndetermined: 0,
    noneUndetermined: 0,
    mixedCause: 0,
    undeclaredFactsPresent: 0,
  };
}

function recordCoverage(
  coverage: Coverage,
  verdicts: ReadonlyMap<string, Verdict>,
  finding: PrepassTimingFinding,
): void {
  const undetermined = undeterminedNames(verdicts);
  if (undetermined.length === 0 && verdicts.size > 0) coverage.noneUndetermined += 1;
  else if (undetermined.length === verdicts.size && verdicts.size > 0) {
    coverage.allUndetermined += 1;
  } else if (undetermined.length > 0) coverage.properSubset += 1;

  const causes = new Set(
    [...verdicts.values()].flatMap((verdict) =>
      'undeterminedCause' in verdict ? [verdict.undeterminedCause] : [],
    ),
  );
  if (causes.size > 1) coverage.mixedCause += 1;
  if (finding.derived && finding.ports.some((facts) => !verdicts.has(facts.port))) {
    coverage.undeclaredFactsPresent += 1;
  }
}

/**
 * Grade one draw: the refusal arm is taken exactly when something is undetermined, and the names it
 * carries are exactly the undetermined declared output ports.
 */
function gradeDraw(coverage: Coverage, draw: Draw): void {
  const moduleInterface = interfaceOf(draw);
  const finding = findingOf(draw);
  const verdicts = ruleVerdicts(moduleInterface, finding);
  const undetermined = undeterminedNames(verdicts);
  recordCoverage(coverage, verdicts, finding);

  const classified = classifyPortTiming(moduleInterface, finding);

  // The arm itself, which is Req 2.1's exclusive choice: a contract or a refusal, decided by
  // whether the rule left anything open.
  expect(classified.ok).toBe(undetermined.length === 0);
  if (classified.ok) {
    expect(classified.value.entries.map((entry) => entry.portName)).toEqual([...verdicts.keys()]);
    return;
  }

  const named = classified.error.ports;
  // EXACT set equality, sorted because Req 2.2 is about membership and not about order. This is the
  // one assertion that fails for a classifier naming only the first undetermined port and for one
  // naming every declared output port.
  expect([...named].sort()).toEqual([...undetermined].sort());
  // A name repeated twice is a different defect from a name missing, and sorted equality above
  // would see a duplicate only if the expectation held one too.
  expect(new Set(named).size).toBe(named.length);
  // "Only those", stated against the interface rather than against the expectation: a refusal may
  // not name a port that is not a declared output port at all (Req 2.5).
  for (const portName of named) {
    expect(declaredOutputNames(moduleInterface)).toContain(portName);
  }
  // The complement: every declared output port the refusal does NOT name is one the rule
  // classified, so an undetermined port cannot hide behind a value.
  for (const [portName, verdict] of verdicts) {
    if (!named.includes(portName)) expect(isUndetermined(verdict)).toBe(false);
  }
}

const drawArbitrary: fc.Arbitrary<Draw> = fc.record({
  // SEVERAL output ports, because one port cannot tell "every" from "the first".
  outcomes: fc.array(fc.constantFrom(...PORT_OUTCOMES), { minLength: 2, maxLength: 5 }),
  // Zero included: Req 1.9's no-data-input interface decides every port by state dependence alone.
  dataInputCount: fc.integer({ min: 0, max: 3 }),
  declareClockPorts: fc.boolean(),
  clockNamed: fc.boolean(),
  resetNamed: fc.boolean(),
  // Weighted towards the derived walk: the refused walk leaves EVERY port undetermined, which is
  // the one shape that cannot separate "every" from "the first".
  walkDerived: fc.oneof(
    { arbitrary: fc.constant(true), weight: 9 },
    { arbitrary: fc.constant(false), weight: 1 },
  ),
  walkCause: fc.constantFrom(...WALK_REFUSAL_CAUSES),
  undeclaredFactsCount: fc.integer({ min: 0, max: 2 }),
  factsReversed: fc.boolean(),
});

/** The base every constructed draw below varies, so each row states only what it is about. */
const BASE_DRAW: Draw = {
  outcomes: ['reaches-data-input', 'state-only'],
  dataInputCount: 2,
  declareClockPorts: true,
  clockNamed: true,
  resetNamed: true,
  walkDerived: true,
  walkCause: 'unrecognized-clocked-cell',
  undeclaredFactsCount: 0,
  factsReversed: false,
};

/**
 * The shapes whose coverage is PINNED rather than sampled: each is a distinct way the set equality
 * could be got wrong, and a sampled run can miss one.
 */
const CONSTRUCTED_DRAWS: Readonly<Record<string, Draw>> = Object.freeze({
  'a proper subset undetermined': {
    ...BASE_DRAW,
    outcomes: ['reaches-data-input', 'undriven', 'state-only', 'inert'],
  },
  'every port undetermined under one cause': {
    ...BASE_DRAW,
    outcomes: ['undriven', 'undriven', 'undriven'],
  },
  'no port undetermined': {
    ...BASE_DRAW,
    outcomes: ['reaches-data-input', 'state-only', 'reaches-data-input'],
  },
  'three causes at once beside two classified ports': {
    ...BASE_DRAW,
    outcomes: ['omitted-from-report', 'undriven', 'inert', 'reaches-data-input', 'state-only'],
  },
  'facts for ports the interface does not declare': {
    ...BASE_DRAW,
    outcomes: ['inert', 'state-only'],
    undeclaredFactsCount: 2,
  },
  'entries reported in reverse declaration order': {
    ...BASE_DRAW,
    outcomes: ['undriven', 'reaches-data-input', 'inert'],
    factsReversed: true,
  },
  'the whole walk refused': {
    ...BASE_DRAW,
    outcomes: ['state-only', 'reaches-data-input', 'inert'],
    walkDerived: false,
  },
  'no declared output port at all': { ...BASE_DRAW, outcomes: [] },
  'no data input, so state dependence decides alone': {
    ...BASE_DRAW,
    outcomes: ['reaches-data-input', 'state-only', 'inert'],
    dataInputCount: 0,
  },
  'clk and rst_n declared as inputs but named by neither clocking field': {
    ...BASE_DRAW,
    outcomes: ['state-only', 'inert', 'undriven'],
    clockNamed: false,
    resetNamed: false,
  },
});

describe(PROPERTY, () => {
  let coverage = emptyCoverage();

  beforeEach(() => {
    coverage = emptyCoverage();
  });

  it('names exactly the declared output ports the ordered rule left undetermined', () => {
    fc.assert(
      fc.property(drawArbitrary, (draw) => {
        gradeDraw(coverage, draw);
      }),
      propertyParameters(),
    );

    // The non-vacuity guard this property stands on: without a proper non-empty subset, every
    // assertion above also holds of a classifier that names only the first undetermined port.
    expect(coverage.properSubset).toBeGreaterThan(0);
  });

  it('grades every pinned shape on every run', () => {
    for (const draw of Object.values(CONSTRUCTED_DRAWS)) {
      gradeDraw(coverage, draw);
    }

    expect(coverage.properSubset).toBeGreaterThan(0);
    expect(coverage.allUndetermined).toBeGreaterThan(0);
    expect(coverage.noneUndetermined).toBeGreaterThan(0);
    expect(coverage.mixedCause).toBeGreaterThan(0);
    expect(coverage.undeclaredFactsPresent).toBeGreaterThan(0);
  });
});
