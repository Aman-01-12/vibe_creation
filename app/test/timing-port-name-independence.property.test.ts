// **Feature: timing-contract-inference, Property 6: Renaming an output port changes no derived value**
//
// THE ORACLE: A PAIRED RENAME OVER ONE DRAWN INPUT
//   Classify once, rename ONE declared output port CONSISTENTLY in both places the name occurs -
//   the `ports` entry of the `ModuleInterface` and the `port` field of the matching
//   `PortTimingFacts` - then classify again. Every derived VALUE must be identical: the target's
//   `PortTiming`, every other port's `PortTiming`, the arm, and the refusal's cause. Only the NAMES
//   move, so a refusal's port set is the RENAMED set rather than the old one.
//   Renaming only one of the two places would make the port unreported, which is clause 1's
//   `port-not-reported` and a different fact entirely; `renamedFactsOf` and `renamedInterfaceOf`
//   are always applied as a pair for that reason.
//
// WHY THIS PROPERTY EXISTS
//   Req 1.11: every Port_Timing value is read from the Elaborated_Netlist ALONE, excluding the
//   design description, the PORT NAME, and the `reg`/`wire` qualifier as sources. Port names in
//   this corpus are highly suggestive - `clk_div`, `clock`, `valid_out`, `dout`, `q` - so a rule
//   that leaned on a name would look right on the corpus and be wrong in general. This property is
//   what forbids it, and the names renamed TO are chosen to tempt exactly that rule.
//
// THE CLOCK/RESET COLLISION, EXCLUDED DELIBERATELY RATHER THAN BY ACCIDENT
//   Renaming an output port to the same string as `clocking.clockName` or `clocking.resetName` is
//   NOT a pure rename: it changes which names the Declared_Data_Input subtraction removes, so a
//   sibling port whose cone reaches that input legitimately changes class. The same holds for a
//   collision with any other declared port, which would also shrink the deduplicated output set.
//   Every declared name therefore carries the `d_` prefix and no pool name does, so the rename pool
//   is disjoint from the declared names by construction and no collision can be read as a
//   violation. The interesting case survives intact: the clock here is some `d_...` name, so
//   renaming a data output to the literal `clk` is still drawn and still must change nothing.
//
// THE SOLO VIEW, AND WHY THE WHOLE-INTERFACE COMPARISON IS NOT ENOUGH
//   `classifyPortTiming` returns ONE refusal for the whole interface and the refusal arm carries no
//   entries, so whenever any OTHER port is undetermined the target's class is not observable in the
//   return value at all. The target's `PortTiming` clause is therefore asserted on a SOLO view -
//   the same interface restricted to the inputs plus the target - where nothing can mask it, with
//   the whole-interface comparison kept alongside for the entries-and-port-set clause.
//
// THE COMPLEMENT, WITHOUT WHICH A CLASSIFIER THAT IGNORES THE FINDING WOULD PASS
//   A classifier returning a constant would satisfy any pure invariance. So each draw also asserts
//   the target's outcome EQUALS the class its drawn cone facts independently imply
//   (`INTENT_OUTCOME`), before AND after the rename. That is what makes a rename to `q` or `clk`
//   decisive: a name-based rule would report `registered` where the cone says `combinational`.
//
// GENERATOR OBLIGATIONS
//   The 15 rename names and the 4 cone shapes are CLOSED sets, so both are exhausted by the loops
//   below rather than sampled - a non-vacuity row over a closed union should not depend on a seed.
//   Ports are drawn across all three classifications (`combinational`, `registered`, refused) for
//   the target and for its siblings, and each count is required non-zero: a run where every port
//   refused would prove nothing about derived VALUES.
//
// Validates: Requirements 1.11

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ModuleInterface, Port, PortTiming } from '@app/core';
import {
  classifyPortTiming,
  type PortTimingFacts,
  type PrepassTimingFinding,
  type TimingRefusalCause,
} from '@app/tools';

import { ASCII_IDENT_CHARS, stringFromChars } from './generators/chars.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'timing-contract-inference, Property 6: Renaming an output port changes no derived value';

/** Names that suggest a clock or a reset, applied here to an ordinary data output. */
const CLOCKING_SUGGESTING_NAMES: readonly string[] = ['clk', 'clock', 'rst', 'rst_n'];
/** Names that suggest registration. */
const REGISTRATION_SUGGESTING_NAMES: readonly string[] = [
  'q',
  'data_out',
  'valid_out',
  'count_reg',
];
/** Names that suggest combinational logic. */
const COMBINATIONAL_SUGGESTING_NAMES: readonly string[] = ['sum', 'y', 'result', 'comb_out'];
/** Names resolving on `Object.prototype`, which the classifier's `Set`/`Map` use exists for. */
const PROTOTYPE_CHAIN_NAMES: readonly string[] = ['__proto__', 'constructor', 'toString'];

/** Every name a port is renamed TO, exhausted by the loop below. */
const RENAME_POOL: readonly string[] = [
  ...CLOCKING_SUGGESTING_NAMES,
  ...REGISTRATION_SUGGESTING_NAMES,
  ...COMBINATIONAL_SUGGESTING_NAMES,
  ...PROTOTYPE_CHAIN_NAMES,
];

/** Declared names carry this prefix, so no rename-pool name can collide with one. */
const DECLARED_PREFIX = 'd_';
/** Cone sources the interface does not declare carry this one, so they stay non-data-inputs. */
const ABSENT_PREFIX = 'a_';

/** The cone shape a port is drawn to have, which fixes its expected class independently. */
type PortIntent = 'combinational' | 'registered' | 'undriven' | 'independent';
const PORT_INTENTS: readonly PortIntent[] = [
  'combinational',
  'registered',
  'undriven',
  'independent',
];

/** One port's expected outcome: its `PortTiming`, or the cause that refuses it. */
type Outcome =
  | { readonly ok: true; readonly timing: PortTiming }
  | { readonly ok: false; readonly cause: TimingRefusalCause };

/**
 * What each cone shape must classify as, restated here rather than read back from the classifier.
 *
 * A total `Record`, so a fifth intent is a compile error until its outcome is stated.
 */
const INTENT_OUTCOME: Readonly<Record<PortIntent, Outcome>> = Object.freeze({
  combinational: { ok: true, timing: 'combinational' },
  registered: { ok: true, timing: 'registered' },
  undriven: { ok: false, cause: 'undriven-output-port' },
  independent: { ok: false, cause: 'input-and-state-independent' },
});

/** The three classifications the draws must span, as the non-vacuity row reads them. */
type Classification = 'combinational' | 'registered' | 'refused';
function classificationOf(intent: PortIntent): Classification {
  const outcome = INTENT_OUTCOME[intent];
  return outcome.ok ? outcome.timing : 'refused';
}

/** The names one interface is built from. Disjoint by construction: unique and prefix-separated. */
interface NameBundle {
  readonly moduleName: string;
  readonly clockName: string;
  readonly resetName: string;
  readonly dataInputNames: readonly string[];
  readonly outputNames: readonly string[];
  readonly absentNames: readonly string[];
}

/** Freely drawn cone facts, before `coerceToIntent` fixes them to one shape. */
interface RawFacts {
  readonly sources: readonly string[];
  readonly reachesState: boolean;
  readonly undriven: boolean;
  /** The Declared_Data_Input a `combinational` port is made to reach. */
  readonly dataInputPick: string;
}

interface Scenario {
  readonly bundle: NameBundle;
  readonly targetIndex: number;
  /** One per declared output port; the target's slot is overwritten with the loop's intent. */
  readonly intents: readonly PortIntent[];
  readonly rawFacts: readonly RawFacts[];
}

type ClassifyResult = ReturnType<typeof classifyPortTiming>;

function identifierArbitrary(prefix: string): fc.Arbitrary<string> {
  return stringFromChars(ASCII_IDENT_CHARS, 1, 8).map((tail) => `${prefix}${tail}`);
}

function nameBundleArbitrary(): fc.Arbitrary<NameBundle> {
  return fc
    .record({
      moduleName: identifierArbitrary(DECLARED_PREFIX),
      dataInputCount: fc.integer({ min: 1, max: 3 }),
      outputCount: fc.integer({ min: 1, max: 4 }),
      absentNames: fc.uniqueArray(identifierArbitrary(ABSENT_PREFIX), {
        minLength: 1,
        maxLength: 2,
      }),
    })
    .chain((shape) => {
      const declaredCount = 2 + shape.dataInputCount + shape.outputCount;
      return fc
        .uniqueArray(identifierArbitrary(DECLARED_PREFIX), {
          minLength: declaredCount,
          maxLength: declaredCount,
        })
        .map((declared) => ({
          moduleName: shape.moduleName,
          clockName: declared[0] as string,
          resetName: declared[1] as string,
          dataInputNames: declared.slice(2, 2 + shape.dataInputCount),
          outputNames: declared.slice(2 + shape.dataInputCount),
          absentNames: shape.absentNames,
        }));
    });
}

/**
 * Names that are NOT a Declared_Data_Input: the clock, the reset, and names nothing declares.
 *
 * Declared OUTPUT names are deliberately absent from this pool. The worker reports cone sources as
 * top-level input ports, and keeping an output's own name out of every `sources` list is what makes
 * the rename a strictly two-place edit rather than a three-place one.
 */
function nonDataInputNamesOf(bundle: NameBundle): readonly string[] {
  return [bundle.clockName, bundle.resetName, ...bundle.absentNames, ...PROTOTYPE_CHAIN_NAMES];
}

function rawFactsArbitrary(bundle: NameBundle): fc.Arbitrary<RawFacts> {
  const everyName = [...nonDataInputNamesOf(bundle), ...bundle.dataInputNames];
  return fc.record<RawFacts>({
    sources: fc.subarray(everyName, { minLength: 0, maxLength: 4 }),
    reachesState: fc.boolean(),
    undriven: fc.boolean(),
    dataInputPick: fc.constantFrom(...bundle.dataInputNames),
  });
}

/** Fix freely drawn facts to one cone shape, so the port's expected class is known independently. */
function coerceToIntent(
  raw: RawFacts,
  intent: PortIntent,
  bundle: NameBundle,
  port: string,
): PortTimingFacts {
  const dataInputs = new Set(bundle.dataInputNames);
  const withoutDataInputs = raw.sources.filter((source) => !dataInputs.has(source));
  switch (intent) {
    case 'combinational':
      return {
        port,
        sources: [...new Set([...raw.sources, raw.dataInputPick])],
        reachesState: raw.reachesState,
        undriven: false,
      };
    case 'registered':
      return { port, sources: withoutDataInputs, reachesState: true, undriven: false };
    case 'independent':
      return { port, sources: withoutDataInputs, reachesState: false, undriven: false };
    case 'undriven':
      // Clause 2 precedes clause 3, so the cone is left free: an undriven port refuses whatever it
      // reaches, and a drawn data input in its sources is the precedence case rather than a problem.
      return { port, sources: raw.sources, reachesState: raw.reachesState, undriven: true };
  }
}

function scenarioArbitrary(targetIntent: PortIntent): fc.Arbitrary<Scenario> {
  return nameBundleArbitrary().chain((bundle) => {
    const outputCount = bundle.outputNames.length;
    return fc
      .record({
        targetIndex: fc.nat({ max: outputCount - 1 }),
        intents: fc.array(fc.constantFrom(...PORT_INTENTS), {
          minLength: outputCount,
          maxLength: outputCount,
        }),
        rawFacts: fc.array(rawFactsArbitrary(bundle), {
          minLength: outputCount,
          maxLength: outputCount,
        }),
      })
      .map((drawn) => ({
        bundle,
        targetIndex: drawn.targetIndex,
        intents: drawn.intents.map((intent, index) =>
          index === drawn.targetIndex ? targetIntent : intent,
        ),
        rawFacts: drawn.rawFacts,
      }));
  });
}

function portsOf(bundle: NameBundle): readonly Port[] {
  return [
    { name: bundle.clockName, direction: 'input', width: 1 },
    { name: bundle.resetName, direction: 'input', width: 1 },
    ...bundle.dataInputNames.map((name) => ({ name, direction: 'input' as const, width: 8 })),
    ...bundle.outputNames.map((name) => ({ name, direction: 'output' as const, width: 4 })),
  ];
}

function interfaceOf(bundle: NameBundle): ModuleInterface {
  return {
    moduleName: bundle.moduleName,
    ports: portsOf(bundle),
    clocking: { clockName: bundle.clockName, resetName: bundle.resetName, resetActiveLow: true },
    // `null` rather than a drawn output name, so the rename stays the two-place edit under test.
    validityOutputName: null,
  };
}

function factsOf(scenario: Scenario): readonly PortTimingFacts[] {
  return scenario.bundle.outputNames.map((port, index) =>
    coerceToIntent(
      scenario.rawFacts[index] as RawFacts,
      scenario.intents[index] as PortIntent,
      scenario.bundle,
      port,
    ),
  );
}

function findingOf(facts: readonly PortTimingFacts[]): PrepassTimingFinding {
  return { derived: true, ports: facts };
}

/** Half one of the paired rename: the `ports` entry of the interface. */
function renamedInterfaceOf(
  moduleInterface: ModuleInterface,
  from: string,
  to: string,
): ModuleInterface {
  return {
    ...moduleInterface,
    ports: moduleInterface.ports.map((port) => (port.name === from ? { ...port, name: to } : port)),
  };
}

/** The other half: the `port` field of the matching facts. Applied only ever together. */
function renamedFactsOf(
  facts: readonly PortTimingFacts[],
  from: string,
  to: string,
): readonly PortTimingFacts[] {
  return facts.map((entry) => (entry.port === from ? { ...entry, port: to } : entry));
}

/** The same interface restricted to the inputs plus one output: the view nothing can mask. */
function soloInterfaceOf(moduleInterface: ModuleInterface, portName: string): ModuleInterface {
  return {
    ...moduleInterface,
    ports: moduleInterface.ports.filter(
      (port) => port.direction === 'input' || port.name === portName,
    ),
  };
}

/**
 * The outcome of a SOLO-view classification, with the port-name clause asserted on the way out.
 *
 * The name assertion belongs here rather than at the call site because it is the renamed-set clause
 * at the solo level: whichever arm is returned must name the port the caller passed in, which after
 * a rename is the NEW name and never the old one.
 */
function soloOutcome(result: ClassifyResult, portName: string): Outcome {
  if (result.ok) {
    expect(result.value.entries).toHaveLength(1);
    const entry = result.value.entries[0];
    expect(entry?.portName).toBe(portName);
    return { ok: true, timing: entry?.timing as PortTiming };
  }
  expect(result.error.ports).toEqual([portName]);
  return { ok: false, cause: result.error.cause };
}

describe(PROPERTY, () => {
  it('renaming a declared output port changes no derived value, only the names', () => {
    const targetClassifications = new Set<Classification>();
    const siblingClassifications = new Set<Classification>();
    const renameNamesUsed = new Set<string>();
    let contractCases = 0;
    let refusalCases = 0;
    let renamedRefusedPortCases = 0;

    for (const newName of RENAME_POOL) {
      for (const targetIntent of PORT_INTENTS) {
        fc.assert(
          fc.property(scenarioArbitrary(targetIntent), (scenario) => {
            const { bundle, targetIndex } = scenario;
            const oldName = bundle.outputNames[targetIndex] as string;
            // The rename pool is prefix-disjoint from every declared name, so this is a pure
            // rename: no collision with the clock, the reset, or another declared port.
            expect(bundle.outputNames).not.toContain(newName);
            expect([bundle.clockName, bundle.resetName, ...bundle.dataInputNames]).not.toContain(
              newName,
            );

            const moduleInterface = interfaceOf(bundle);
            const facts = factsOf(scenario);
            const renamedInterface = renamedInterfaceOf(moduleInterface, oldName, newName);
            const renamedFacts = renamedFactsOf(facts, oldName, newName);

            // THE TARGET'S OWN VALUE, on the solo view where no sibling refusal can mask it - and
            // equal to the class its cone facts independently imply, before and after.
            const expected = INTENT_OUTCOME[targetIntent];
            const soloBefore = classifyPortTiming(
              soloInterfaceOf(moduleInterface, oldName),
              findingOf([facts[targetIndex] as PortTimingFacts]),
            );
            const soloAfter = classifyPortTiming(
              soloInterfaceOf(renamedInterface, newName),
              findingOf([renamedFacts[targetIndex] as PortTimingFacts]),
            );
            expect(soloOutcome(soloBefore, oldName)).toEqual(expected);
            expect(soloOutcome(soloAfter, newName)).toEqual(expected);

            // THE WHOLE INTERFACE: the same arm, and every other port's value unchanged too.
            const before = classifyPortTiming(moduleInterface, findingOf(facts));
            const after = classifyPortTiming(renamedInterface, findingOf(renamedFacts));
            expect(after.ok).toBe(before.ok);
            if (before.ok && after.ok) {
              expect(after.value.entries).toEqual(
                before.value.entries.map((entry) =>
                  entry.portName === oldName ? { ...entry, portName: newName } : entry,
                ),
              );
              contractCases += 1;
            }
            if (!before.ok && !after.ok) {
              expect(after.error.cause).toBe(before.error.cause);
              expect(after.error.ports).toEqual(
                before.error.ports.map((port) => (port === oldName ? newName : port)),
              );
              refusalCases += 1;
              // The renamed set rather than the old one, wherever the target is among the refused.
              if (before.error.ports.includes(oldName)) {
                expect(after.error.ports).toContain(newName);
                expect(after.error.ports).not.toContain(oldName);
                renamedRefusedPortCases += 1;
              }
            }

            renameNamesUsed.add(newName);
            targetClassifications.add(classificationOf(targetIntent));
            scenario.intents.forEach((intent, index) => {
              if (index !== targetIndex) siblingClassifications.add(classificationOf(intent));
            });
          }),
          propertyParameters(),
        );
      }
    }

    // NON-VACUITY. Target and sibling ports must both span all three classifications, every rename
    // name must have been used, and both arms plus the renamed-refused-port clause must be reached.
    expect({
      targetClassifications: [...targetClassifications].sort(),
      siblingClassifications: [...siblingClassifications].sort(),
      renameNamesUsed: renameNamesUsed.size,
      contractCases: contractCases > 0,
      refusalCases: refusalCases > 0,
      renamedRefusedPortCases: renamedRefusedPortCases > 0,
    }).toEqual({
      targetClassifications: ['combinational', 'refused', 'registered'],
      siblingClassifications: ['combinational', 'refused', 'registered'],
      renameNamesUsed: RENAME_POOL.length,
      contractCases: true,
      refusalCases: true,
      renamedRefusedPortCases: true,
    });
  });
});
