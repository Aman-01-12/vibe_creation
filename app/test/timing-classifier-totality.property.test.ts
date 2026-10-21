// **Feature: timing-contract-inference, Property 1: The classifier is total and returns exactly one arm**
//
// THE ORACLE, RESTATED INDEPENDENTLY OF THE CLASSIFIER
//   For any `ModuleInterface` and any `PrepassTimingFinding`, `classifyPortTiming` lands on exactly
//   one arm (Req 2.1, 2.4) and never by throwing. On the ok arm the contract's entry port-name SET
//   equals the declared output port set exactly - one value per declared output port and nothing
//   else, which is Req 1.1's "for each declared output port". On the error arm the `cause` is a
//   member of the five-token closed vocabulary and `ports` is non-empty, because a refusal that
//   names nobody is not a refusal.
//
// WHY THE INPUTS ARE ADVERSARIAL RATHER THAN WELL-FORMED
//   Totality over AGREEING inputs is nearly free: if the finding always reports facts for exactly
//   the declared output ports, no clause but the last three can ever fire. So the generators draw
//   the disagreements - a derived finding whose `ports` is EMPTY while the interface declares
//   outputs, facts for ports the interface never declares, duplicate port names, and port names
//   spelled `__proto__`, `constructor`, and `toString`, which are the names a `Record`-keyed
//   implementation would read through the prototype chain rather than through an entry.
//
// WHY THE INTERFACE IS BUILT FROM OBJECT LITERALS AND NOT THROUGH `makeModuleInterface`
//   The validating constructor refuses duplicate port names, and a duplicate declared output is one
//   of the shapes under test: `classifyPortTiming` is reached by callers holding a `ModuleInterface`
//   value, and the type admits a duplicate even where the constructor does not. Going through the
//   constructor here would delete the case rather than test it.
//
// Validates: Requirements 1.1, 2.1, 2.4

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ModuleInterface, Port } from '@app/core';
import {
  classifyPortTiming,
  type PortTimingFacts,
  type PrepassTimingFinding,
  type PrepassTimingRefusalCause,
  type TimingRefusalCause,
} from '@app/tools';

import { ASCII_IDENT_CHARS, stringFromChars } from './generators/chars.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'timing-contract-inference, Property 1: The classifier is total and returns exactly one arm';

/**
 * 400 runs rather than the 100 default.
 *
 * The scarcest required draw is the full cross of `sources`-non-empty, `reachesState`, and
 * `undriven` - eight combinations, each reached only through the aligned finding mode - so the
 * default would leave corners of that cross untouched on some seeds.
 */
const NUM_RUNS = 400;

/**
 * The five-token refusal vocabulary, re-spelled here rather than imported as a runtime list.
 *
 * Annotated with the imported type instead of derived from it, which is the direction that matters:
 * a token spelled wrong, or one the union does not admit, is a COMPILE error, while a sixth token
 * added to the union is caught by the membership assertion below reporting a cause this list does
 * not hold. An imported list would assert only that the vocabulary equals itself.
 */
const REFUSAL_CAUSES: readonly TimingRefusalCause[] = [
  'netlist-unavailable',
  'netlist-walk-unreliable',
  'port-not-reported',
  'undriven-output-port',
  'input-and-state-independent',
];

/** The worker's own three design-level refusal tokens, for the `derived: false` finding arm. */
const PREPASS_REFUSAL_CAUSES: readonly PrepassTimingRefusalCause[] = [
  'module-instance',
  'unrecognized-clocked-cell',
  'cell-shape-unreadable',
];

/** Port names that a prototype-chain read would answer for even when no entry was ever set. */
const EXOTIC_NAMES: readonly string[] = ['__proto__', 'constructor', 'toString', 'valueOf'];

/**
 * A port name: a SHORT identifier, or one of the exotic names.
 *
 * Short on purpose - one to three characters over a 63-character alphabet - so that independently
 * drawn names collide often, which is what produces the duplicate-name and the
 * output-name-equals-input-name shapes without a dedicated generator for either.
 */
function portNameArbitrary(): fc.Arbitrary<string> {
  return fc.oneof(
    { arbitrary: stringFromChars(ASCII_IDENT_CHARS, 1, 3), weight: 3 },
    { arbitrary: fc.constantFrom(...EXOTIC_NAMES), weight: 1 },
  );
}

/** A boolean that is `true` about one draw in four, so the common shape stays the common shape. */
function rareBoolean(): fc.Arbitrary<boolean> {
  return fc.oneof(
    { arbitrary: fc.constant(false), weight: 3 },
    { arbitrary: fc.constant(true), weight: 1 },
  );
}

/** The drawn interface, plus the name pools a finding is built from. */
interface GeneratedInterface {
  readonly moduleInterface: ModuleInterface;
  /** Declared output names, DEDUPLICATED: the set the contract is checked against. */
  readonly outputNameSet: ReadonlySet<string>;
  /** Every declared input name plus the clock and the reset, which is what a cone may report. */
  readonly coneSourceNames: readonly string[];
}

/** The pre-naming shape: how many ports of each kind, and whether a clock and a reset exist. */
interface InterfaceDraft {
  readonly moduleName: string;
  /** May hold duplicates, and may be empty - the empty-contract case. */
  readonly outputNames: readonly string[];
  /** May be empty - the zero-data-input case, and with a clock the clock-and-reset-only case. */
  readonly dataInputNames: readonly string[];
  readonly clockName: string | null;
  readonly resetName: string | null;
  readonly resetActiveLow: boolean;
}

function buildInterface(draft: InterfaceDraft): GeneratedInterface {
  const inputNames = [
    ...(draft.clockName === null ? [] : [draft.clockName]),
    ...(draft.resetName === null ? [] : [draft.resetName]),
    ...draft.dataInputNames,
  ];
  const ports: readonly Port[] = [
    ...inputNames.map((name) => ({ name, direction: 'input', width: 1 }) as const),
    ...draft.outputNames.map((name) => ({ name, direction: 'output', width: 1 }) as const),
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
    outputNameSet: new Set(draft.outputNames),
    coneSourceNames: inputNames,
  };
}

/**
 * Interfaces from zero to four outputs and zero to three data inputs, with the clock and the reset
 * each independently `null` or drawn from the same short-name pool as every other port.
 */
function generatedInterfaceArbitrary(): fc.Arbitrary<GeneratedInterface> {
  return fc
    .record<InterfaceDraft>({
      moduleName: stringFromChars(ASCII_IDENT_CHARS, 1, 6),
      outputNames: fc.array(portNameArbitrary(), { minLength: 0, maxLength: 4 }),
      dataInputNames: fc.array(portNameArbitrary(), { minLength: 0, maxLength: 3 }),
      clockName: fc.option(portNameArbitrary(), { nil: null }),
      resetName: fc.option(portNameArbitrary(), { nil: null }),
      resetActiveLow: fc.boolean(),
    })
    .map(buildInterface);
}

/** Cone facts for `port`, with every `sources`/`reachesState`/`undriven` combination reachable. */
function factsArbitrary(
  port: fc.Arbitrary<string>,
  sourcePool: readonly string[],
): fc.Arbitrary<PortTimingFacts> {
  const sources =
    sourcePool.length === 0
      ? fc.constant<readonly string[]>([])
      : fc.oneof(
          fc.constant<readonly string[]>([]),
          fc.shuffledSubarray([...sourcePool], { minLength: 1 }),
        );
  return fc.record<PortTimingFacts>({
    port,
    // A cone may name a signal the interface does not declare at all, which must intersect with
    // nothing rather than widen the Declared_Data_Input set.
    sources: fc.oneof(
      { arbitrary: sources, weight: 3 },
      { arbitrary: fc.array(portNameArbitrary(), { maxLength: 2 }), weight: 1 },
    ),
    reachesState: fc.boolean(),
    undriven: rareBoolean(),
  });
}

/**
 * A finding drawn against one interface, in one of three relations to it.
 *
 * `refused` is the design-level `derived: false` arm. `aligned` reports facts for exactly the
 * declared output ports over the interface's own input names, which is the only relation that
 * reaches the ok arm with a non-empty contract. The free-form arm draws its port names and its
 * length independently, so it covers the empty-`ports`-with-declared-outputs case, facts for
 * undeclared ports, duplicate facts for one port, and facts for only some of the declared outputs.
 */
function findingArbitrary(generated: GeneratedInterface): fc.Arbitrary<PrepassTimingFinding> {
  const declaredNames = [...generated.outputNameSet];
  const aligned = fc
    .tuple(
      ...declaredNames.map((name) => factsArbitrary(fc.constant(name), generated.coneSourceNames)),
    )
    .map((ports): PrepassTimingFinding => ({ derived: true, ports }));
  const freeName =
    declaredNames.length === 0
      ? portNameArbitrary()
      : fc.oneof(fc.constantFrom(...declaredNames), portNameArbitrary());
  const adversarial = fc
    .array(factsArbitrary(freeName, generated.coneSourceNames), { minLength: 0, maxLength: 5 })
    .map((ports): PrepassTimingFinding => ({ derived: true, ports }));
  const refused = fc
    .constantFrom(...PREPASS_REFUSAL_CAUSES)
    .map((cause): PrepassTimingFinding => ({ derived: false, cause }));
  return fc.oneof(
    { arbitrary: refused, weight: 1 },
    { arbitrary: aligned, weight: 3 },
    { arbitrary: adversarial, weight: 2 },
  );
}

/** One drawn case: an interface and a finding built against it. */
interface Scenario {
  readonly generated: GeneratedInterface;
  readonly finding: PrepassTimingFinding;
}

function scenarioArbitrary(): fc.Arbitrary<Scenario> {
  return generatedInterfaceArbitrary().chain((generated) =>
    findingArbitrary(generated).map((finding) => ({ generated, finding })),
  );
}

/** The classifier's outcome, or the throw it is not permitted to make. */
type Outcome =
  | { readonly threw: false; readonly result: ReturnType<typeof classifyPortTiming> }
  | { readonly threw: true; readonly message: string };

/**
 * Call the classifier, converting a throw into a value.
 *
 * Without this the first throwing input would abort the run instead of being REPORTED as the
 * shrunk counterexample, and "never by throwing" is half of what this property claims.
 */
function classifySafely(moduleInterface: ModuleInterface, finding: PrepassTimingFinding): Outcome {
  try {
    return { threw: false, result: classifyPortTiming(moduleInterface, finding) };
  } catch (error) {
    return { threw: true, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Every shape the property's non-vacuity depends on having been drawn at least once. */
interface Coverage {
  okArm: number;
  errorArm: number;
  okWithEntries: number;
  zeroOutputPorts: number;
  zeroDataInputs: number;
  clockAndResetOnlyInputs: number;
  nullReset: number;
  duplicateOutputNames: number;
  exoticPortNames: number;
  refusedFinding: number;
  derivedFinding: number;
  emptyPortsWithDeclaredOutputs: number;
  factsForUndeclaredPort: number;
  /** Keys of the `sources`-non-empty x `reachesState` x `undriven` cross, eight in all. */
  factsCombinations: Set<string>;
}

function emptyCoverage(): Coverage {
  return {
    okArm: 0,
    errorArm: 0,
    okWithEntries: 0,
    zeroOutputPorts: 0,
    zeroDataInputs: 0,
    clockAndResetOnlyInputs: 0,
    nullReset: 0,
    duplicateOutputNames: 0,
    exoticPortNames: 0,
    refusedFinding: 0,
    derivedFinding: 0,
    emptyPortsWithDeclaredOutputs: 0,
    factsForUndeclaredPort: 0,
    factsCombinations: new Set<string>(),
  };
}

function recordCoverage(coverage: Coverage, scenario: Scenario): void {
  const { generated, finding } = scenario;
  const { moduleInterface, outputNameSet } = generated;
  const outputPorts = moduleInterface.ports.filter((port) => port.direction === 'output');
  const inputPorts = moduleInterface.ports.filter((port) => port.direction === 'input');
  const { clockName, resetName } = moduleInterface.clocking;
  const named = [clockName, resetName].filter((name): name is string => name !== null);

  if (outputNameSet.size === 0) coverage.zeroOutputPorts += 1;
  if (outputPorts.length > outputNameSet.size) coverage.duplicateOutputNames += 1;
  if (inputPorts.length === named.length) coverage.zeroDataInputs += 1;
  if (named.length === 2 && inputPorts.length === 2) coverage.clockAndResetOnlyInputs += 1;
  if (resetName === null) coverage.nullReset += 1;
  if (moduleInterface.ports.some((port) => EXOTIC_NAMES.includes(port.name))) {
    coverage.exoticPortNames += 1;
  }

  if (!finding.derived) {
    coverage.refusedFinding += 1;
    return;
  }
  coverage.derivedFinding += 1;
  if (finding.ports.length === 0 && outputNameSet.size > 0) {
    coverage.emptyPortsWithDeclaredOutputs += 1;
  }
  for (const facts of finding.ports) {
    if (!outputNameSet.has(facts.port)) coverage.factsForUndeclaredPort += 1;
    coverage.factsCombinations.add(
      `${facts.sources.length > 0}|${facts.reachesState}|${facts.undriven}`,
    );
  }
}

describe(PROPERTY, () => {
  it('lands on exactly one arm for any interface and any finding, never by throwing', () => {
    const coverage = emptyCoverage();

    fc.assert(
      fc.property(scenarioArbitrary(), (scenario) => {
        const { generated, finding } = scenario;
        const outcome = classifySafely(generated.moduleInterface, finding);

        // Never by throwing. fast-check reports the shrunk interface and finding alongside this.
        expect(outcome.threw ? outcome.message : null).toBeNull();
        if (outcome.threw) return;
        const { result } = outcome;

        // EXACTLY one arm, asserted on the carried fields rather than inferred from `ok`: a value
        // carrying both would satisfy an `ok`-only check while being neither a contract nor a
        // refusal (Req 2.1, and Req 2.4's "as a return value").
        expect('value' in result).toBe(result.ok);
        expect('error' in result).toBe(!result.ok);

        if (result.ok) {
          const portNames = result.value.entries.map((entry) => entry.portName);
          // The entry SET equals the declared output set exactly, and the entry COUNT equals that
          // set's size, which together rule out an extra, a missing, and a duplicated entry.
          expect(new Set(portNames)).toEqual(new Set(generated.outputNameSet));
          expect(portNames).toHaveLength(generated.outputNameSet.size);
          coverage.okArm += 1;
          if (portNames.length > 0) coverage.okWithEntries += 1;
        } else {
          expect(REFUSAL_CAUSES).toContain(result.error.cause);
          expect(result.error.ports.length).toBeGreaterThan(0);
          coverage.errorArm += 1;
        }

        recordCoverage(coverage, scenario);
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    // NON-VACUITY: both arms, and every adversarial shape the totality claim leans on, were drawn.
    expect({
      bothArms: coverage.okArm > 0 && coverage.errorArm > 0,
      okWithEntries: coverage.okWithEntries > 0,
      zeroOutputPorts: coverage.zeroOutputPorts > 0,
      zeroDataInputs: coverage.zeroDataInputs > 0,
      clockAndResetOnlyInputs: coverage.clockAndResetOnlyInputs > 0,
      nullReset: coverage.nullReset > 0,
      duplicateOutputNames: coverage.duplicateOutputNames > 0,
      exoticPortNames: coverage.exoticPortNames > 0,
      refusedFinding: coverage.refusedFinding > 0,
      derivedFinding: coverage.derivedFinding > 0,
      emptyPortsWithDeclaredOutputs: coverage.emptyPortsWithDeclaredOutputs > 0,
      factsForUndeclaredPort: coverage.factsForUndeclaredPort > 0,
      everyFactsCombination: coverage.factsCombinations.size === 8,
    }).toEqual({
      bothArms: true,
      okWithEntries: true,
      zeroOutputPorts: true,
      zeroDataInputs: true,
      clockAndResetOnlyInputs: true,
      nullReset: true,
      duplicateOutputNames: true,
      exoticPortNames: true,
      refusedFinding: true,
      derivedFinding: true,
      emptyPortsWithDeclaredOutputs: true,
      factsForUndeclaredPort: true,
      everyFactsCombination: true,
    });
  });
});
