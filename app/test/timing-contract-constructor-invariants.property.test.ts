// **Feature: timing-contract-inference, Property 10: A returned contract satisfies the constructor's invariants**
//
// THE ORACLE, RESTATED INDEPENDENTLY OF THE CLASSIFIER
//   `makeTimingContract` enforces three rules, and a contract `classifyPortTiming` returns must
//   satisfy all three: exactly one entry per declared output port, so the entry count equals the
//   DEDUPLICATED declared output count and every declared output name appears; no second entry for
//   one port; and no entry naming anything that is not a declared output. Each is restated below
//   from the interface's own port list rather than read back off the contract.
//
// WHY THE CROSS-CHECK IS THE PART THAT EARNS THE PROPERTY
//   The three restatements alone would be close to a re-run of Property 1. So every ok contract is
//   fed BACK through `makeTimingContract` with the same interface, and the constructor must ACCEPT
//   its own entries. That is Requirement 2.6's claim checked by the thing it names: a classifier
//   that assembled a `TimingContract` object literal directly - bypassing the constructor, which
//   the structural type permits - would be caught here the moment its own assembly disagreed with
//   the constructor about the declared output set, which is exactly the disagreement the
//   classifier's unreachable arm exists for.
//
// WHY THE INTERFACE IS BUILT FROM OBJECT LITERALS AND NOT THROUGH `makeModuleInterface`
//   A DUPLICATE declared output name is one of the decisive shapes, and the validating constructor
//   refuses it. The `ModuleInterface` TYPE admits it, and `classifyPortTiming` is reached by
//   callers holding a value of that type, so going through `makeModuleInterface` would delete the
//   case rather than test it. A duplicate is what separates "one entry per declared output PORT"
//   from "one entry per declared output NAME": only the second is satisfiable, and a count checked
//   against the undeduplicated port list would report a missing entry that cannot exist.
//
// Validates: Requirements 2.6

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  isPortTiming,
  makeTimingContract,
  type ModuleInterface,
  type Port,
  type TimingContractEntry,
} from '@app/core';
import {
  classifyPortTiming,
  type PortTimingFacts,
  type PrepassTimingFinding,
  type PrepassTimingRefusalCause,
} from '@app/tools';

import { ASCII_IDENT_CHARS, stringFromChars } from './generators/chars.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  "timing-contract-inference, Property 10: A returned contract satisfies the constructor's invariants";

/**
 * 300 runs rather than the 100 default.
 *
 * The ok arm needs every declared output port to classify, and the decisive shapes - a duplicate
 * declared output name, a zero-output interface, extra undeclared facts, duplicate facts for one
 * port - are drawn independently of each other, so their conjunctions are the scarce draws.
 */
const NUM_RUNS = 300;

/** The worker's three design-level refusal tokens, for the `derived: false` finding arm. */
const PREPASS_REFUSAL_CAUSES: readonly PrepassTimingRefusalCause[] = [
  'module-instance',
  'unrecognized-clocked-cell',
  'cell-shape-unreadable',
];

/** Port names a prototype-chain read would answer for even where no entry was ever set. */
const EXOTIC_NAMES: readonly string[] = ['__proto__', 'constructor', 'toString'];

/**
 * Names a finding may carry facts for that the interface CANNOT have declared.
 *
 * Longer than the three-character ceiling `portNameArbitrary` draws under and absent from
 * `EXOTIC_NAMES`, so "undeclared" is guaranteed by construction rather than by a `filter` that
 * could exhaust. Facts for these must never become contract entries.
 */
const UNDECLARED_NAMES: readonly string[] = ['undeclared_a', 'undeclared_b', 'undeclared_c'];

/**
 * A port name: a SHORT identifier, or one of the exotic names.
 *
 * One to three characters, so independently drawn names collide and the output-name-equals-input-
 * name shape arises without a generator of its own.
 */
function portNameArbitrary(): fc.Arbitrary<string> {
  return fc.oneof(
    { arbitrary: stringFromChars(ASCII_IDENT_CHARS, 1, 3), weight: 3 },
    { arbitrary: fc.constantFrom(...EXOTIC_NAMES), weight: 1 },
  );
}

/** The drawn interface, plus what a finding is built from and what the contract is checked against. */
interface GeneratedInterface {
  readonly moduleInterface: ModuleInterface;
  /** Declared output names, DEDUPLICATED: the set one entry each is owed to. */
  readonly outputNameSet: ReadonlySet<string>;
  /** Declared output PORTS, which may exceed the set above - the duplicate-name shape. */
  readonly outputPortCount: number;
  /** Every declared input name including the clock and the reset, which is what a cone may name. */
  readonly coneSourceNames: readonly string[];
}

/** The pre-naming shape. `duplicateFirstOutput` guarantees the duplicate-name draw rather than
 * leaving it to a name collision, which is rare enough to be seed-dependent. */
interface InterfaceDraft {
  readonly moduleName: string;
  /** May be empty - the interface whose contract is legitimately empty. */
  readonly baseOutputNames: readonly string[];
  readonly duplicateFirstOutput: boolean;
  readonly dataInputNames: readonly string[];
  readonly clockName: string | null;
  readonly resetName: string | null;
  readonly resetActiveLow: boolean;
}

function buildInterface(draft: InterfaceDraft): GeneratedInterface {
  const first = draft.baseOutputNames[0];
  const outputNames =
    draft.duplicateFirstOutput && first !== undefined
      ? [...draft.baseOutputNames, first]
      : draft.baseOutputNames;
  const inputNames = [
    ...(draft.clockName === null ? [] : [draft.clockName]),
    ...(draft.resetName === null ? [] : [draft.resetName]),
    ...draft.dataInputNames,
  ];
  const ports: readonly Port[] = [
    ...inputNames.map((name) => ({ name, direction: 'input', width: 1 }) as const),
    ...outputNames.map((name) => ({ name, direction: 'output', width: 1 }) as const),
  ];
  return {
    moduleInterface: {
      moduleName: draft.moduleName,
      ports,
      clocking: {
        clockName: draft.clockName,
        resetName: draft.resetName,
        resetActiveLow: draft.resetActiveLow,
      },
      validityOutputName: null,
    },
    outputNameSet: new Set(outputNames),
    outputPortCount: outputNames.length,
    coneSourceNames: inputNames,
  };
}

/** Interfaces from zero to three base outputs, optionally with one of them declared twice. */
function generatedInterfaceArbitrary(): fc.Arbitrary<GeneratedInterface> {
  return fc
    .record<InterfaceDraft>({
      moduleName: stringFromChars(ASCII_IDENT_CHARS, 1, 6),
      baseOutputNames: fc.array(portNameArbitrary(), { minLength: 0, maxLength: 3 }),
      duplicateFirstOutput: fc.boolean(),
      dataInputNames: fc.array(portNameArbitrary(), { minLength: 1, maxLength: 3 }),
      clockName: fc.option(portNameArbitrary(), { nil: null }),
      resetName: fc.option(portNameArbitrary(), { nil: null }),
      resetActiveLow: fc.boolean(),
    })
    .map(buildInterface);
}

/**
 * Cone facts for `port`, biased toward a port that CLASSIFIES.
 *
 * The invariants under test only exist on the ok arm, so `undriven` is rare and `reachesState` is
 * common: an all-refusing run would satisfy every assertion below without ever examining a
 * contract, which is the vacuity the counters at the end rule out.
 */
function factsArbitrary(
  port: fc.Arbitrary<string>,
  sourcePool: readonly string[],
): fc.Arbitrary<PortTimingFacts> {
  return fc.record<PortTimingFacts>({
    port,
    sources:
      sourcePool.length === 0
        ? fc.constant<readonly string[]>([])
        : fc.shuffledSubarray([...sourcePool], { minLength: 0 }),
    reachesState: fc.oneof(
      { arbitrary: fc.constant(true), weight: 3 },
      { arbitrary: fc.constant(false), weight: 1 },
    ),
    undriven: fc.oneof(
      { arbitrary: fc.constant(false), weight: 9 },
      { arbitrary: fc.constant(true), weight: 1 },
    ),
  });
}

/** One drawn case: an interface, a finding built against it, and what that finding carries. */
interface Scenario {
  readonly generated: GeneratedInterface;
  readonly finding: PrepassTimingFinding;
  /** Whether the finding carries facts for at least one name the interface does not declare. */
  readonly carriesUndeclaredFacts: boolean;
  /** Whether the finding carries two facts entries for one declared output port. */
  readonly carriesDuplicateFacts: boolean;
}

/** The pre-assembly draw: aligned facts, plus the two adversarial additions, plus the refused arm. */
interface FindingDraft {
  readonly aligned: readonly PortTimingFacts[];
  readonly undeclared: readonly PortTimingFacts[];
  readonly duplicateOfIndex: number | null;
  readonly refusalCause: PrepassTimingRefusalCause | null;
}

function buildScenario(generated: GeneratedInterface, draft: FindingDraft): Scenario {
  if (draft.refusalCause !== null) {
    return {
      generated,
      finding: { derived: false, cause: draft.refusalCause },
      carriesUndeclaredFacts: false,
      carriesDuplicateFacts: false,
    };
  }
  const duplicated =
    draft.duplicateOfIndex === null ? undefined : draft.aligned[draft.duplicateOfIndex];
  const ports: readonly PortTimingFacts[] = [
    ...draft.aligned,
    ...draft.undeclared,
    ...(duplicated === undefined ? [] : [duplicated]),
  ];
  return {
    generated,
    finding: { derived: true, ports },
    carriesUndeclaredFacts: draft.undeclared.length > 0,
    carriesDuplicateFacts: duplicated !== undefined,
  };
}

/**
 * A finding drawn against one interface.
 *
 * `aligned` reports facts for exactly the declared output names, which is the only relation that
 * reaches the ok arm with a non-empty contract. On top of it: facts for names the interface never
 * declares, which must not become entries, and a second facts entry for one declared port, which
 * must not become a second contract entry. The refused arm is drawn rarely, as a control.
 */
function findingArbitrary(generated: GeneratedInterface): fc.Arbitrary<Scenario> {
  const declaredNames = [...generated.outputNameSet];
  const aligned = fc.tuple(
    ...declaredNames.map((name) => factsArbitrary(fc.constant(name), generated.coneSourceNames)),
  );
  return fc
    .record<FindingDraft>({
      aligned,
      undeclared: fc.array(
        factsArbitrary(fc.constantFrom(...UNDECLARED_NAMES), generated.coneSourceNames),
        { minLength: 0, maxLength: 2 },
      ),
      duplicateOfIndex:
        declaredNames.length === 0
          ? fc.constant(null)
          : fc.option(fc.nat({ max: declaredNames.length - 1 }), { nil: null }),
      refusalCause: fc.oneof(
        { arbitrary: fc.constant(null), weight: 9 },
        { arbitrary: fc.constantFrom(...PREPASS_REFUSAL_CAUSES), weight: 1 },
      ),
    })
    .map((draft) => buildScenario(generated, draft));
}

function scenarioArbitrary(): fc.Arbitrary<Scenario> {
  return generatedInterfaceArbitrary().chain(findingArbitrary);
}

/** An order-independent view of an entry list, for comparing two entry sets. */
function sortedEntries(entries: readonly TimingContractEntry[]): readonly TimingContractEntry[] {
  return [...entries].sort((left, right) => left.portName.localeCompare(right.portName));
}

/** Every shape this property's non-vacuity depends on having been drawn at least once. */
interface Coverage {
  okArm: number;
  errorArm: number;
  okWithEntries: number;
  okWithZeroOutputPorts: number;
  duplicateDeclaredOutputNames: number;
  duplicateDeclaredOutputNamesOnOkArm: number;
  undeclaredFacts: number;
  undeclaredFactsOnOkArm: number;
  duplicateFacts: number;
  duplicateFactsOnOkArm: number;
  feedBackAccepted: number;
}

function emptyCoverage(): Coverage {
  return {
    okArm: 0,
    errorArm: 0,
    okWithEntries: 0,
    okWithZeroOutputPorts: 0,
    duplicateDeclaredOutputNames: 0,
    duplicateDeclaredOutputNamesOnOkArm: 0,
    undeclaredFacts: 0,
    undeclaredFactsOnOkArm: 0,
    duplicateFacts: 0,
    duplicateFactsOnOkArm: 0,
    feedBackAccepted: 0,
  };
}

function recordDraw(coverage: Coverage, scenario: Scenario, reachedOkArm: boolean): void {
  const hasDuplicateNames =
    scenario.generated.outputPortCount > scenario.generated.outputNameSet.size;
  if (hasDuplicateNames) {
    coverage.duplicateDeclaredOutputNames += 1;
    if (reachedOkArm) coverage.duplicateDeclaredOutputNamesOnOkArm += 1;
  }
  if (scenario.carriesUndeclaredFacts) {
    coverage.undeclaredFacts += 1;
    if (reachedOkArm) coverage.undeclaredFactsOnOkArm += 1;
  }
  if (scenario.carriesDuplicateFacts) {
    coverage.duplicateFacts += 1;
    if (reachedOkArm) coverage.duplicateFactsOnOkArm += 1;
  }
}

describe(PROPERTY, () => {
  it('every returned contract satisfies the three constructor invariants, and the constructor itself re-accepts it', () => {
    const coverage = emptyCoverage();

    fc.assert(
      fc.property(scenarioArbitrary(), (scenario) => {
        const { generated, finding } = scenario;
        const { moduleInterface, outputNameSet } = generated;
        const result = classifyPortTiming(moduleInterface, finding);

        recordDraw(coverage, scenario, result.ok);
        if (!result.ok) {
          coverage.errorArm += 1;
          return;
        }
        coverage.okArm += 1;
        const { entries } = result.value;
        if (entries.length > 0) coverage.okWithEntries += 1;
        if (outputNameSet.size === 0) coverage.okWithZeroOutputPorts += 1;

        const portNames = entries.map((entry) => entry.portName);

        // INVARIANT 1, exactly one entry per declared output port. The count is checked against the
        // DEDUPLICATED declared output count, and every declared name must appear.
        expect(portNames).toHaveLength(outputNameSet.size);
        for (const declaredName of outputNameSet) {
          expect(portNames).toContain(declaredName);
        }

        // INVARIANT 2, no duplicate entry: the name set is as large as the list.
        expect(new Set(portNames).size).toBe(portNames.length);

        // INVARIANT 3, no entry naming anything that is not a declared output port - which rules
        // out the undeclared names the finding carried facts for, and any declared INPUT port.
        for (const name of portNames) {
          expect(outputNameSet.has(name)).toBe(true);
        }

        // Every `timing` is a member of the closed vocabulary, by `Set` membership rather than a
        // record index, so a port named `__proto__` cannot be answered through the prototype chain.
        for (const entry of entries) {
          expect(isPortTiming(entry.timing)).toBe(true);
        }

        // THE CROSS-CHECK (Req 2.6): the constructor the contract must be built through accepts
        // these very entries against this very interface, and returns them unchanged.
        const rebuilt = makeTimingContract(moduleInterface, entries);
        expect(rebuilt.ok ? null : rebuilt.error.code).toBeNull();
        if (rebuilt.ok) {
          expect(sortedEntries(rebuilt.value.entries)).toEqual(sortedEntries(entries));
          coverage.feedBackAccepted += 1;
        }
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    // NON-VACUITY: the ok arm was reached, and reached under each shape a naive implementation
    // would get wrong. A run that only ever refused would prove nothing about contracts.
    expect({
      okArm: coverage.okArm > 0,
      errorArm: coverage.errorArm > 0,
      okWithEntries: coverage.okWithEntries > 0,
      okWithZeroOutputPorts: coverage.okWithZeroOutputPorts > 0,
      duplicateDeclaredOutputNames: coverage.duplicateDeclaredOutputNames > 0,
      duplicateDeclaredOutputNamesOnOkArm: coverage.duplicateDeclaredOutputNamesOnOkArm > 0,
      undeclaredFacts: coverage.undeclaredFacts > 0,
      undeclaredFactsOnOkArm: coverage.undeclaredFactsOnOkArm > 0,
      duplicateFacts: coverage.duplicateFacts > 0,
      duplicateFactsOnOkArm: coverage.duplicateFactsOnOkArm > 0,
      feedBackAccepted: coverage.feedBackAccepted === coverage.okArm,
    }).toEqual({
      okArm: true,
      errorArm: true,
      okWithEntries: true,
      okWithZeroOutputPorts: true,
      duplicateDeclaredOutputNames: true,
      duplicateDeclaredOutputNamesOnOkArm: true,
      undeclaredFacts: true,
      undeclaredFactsOnOkArm: true,
      duplicateFacts: true,
      duplicateFactsOnOkArm: true,
      feedBackAccepted: true,
    });
  });
});
