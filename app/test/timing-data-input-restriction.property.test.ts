// **Feature: timing-contract-inference, Property 5: Only declared data inputs can make a port combinational**
//
// THE ORACLE, AND WHY IT IS AN INVARIANCE RATHER THAN A CHECK ON ONE RESULT
//   `classifyPortTiming` reaches `combinational` through exactly one clause: a port's reported
//   `sources` intersecting the Declared_Data_Input set, which is every declared input MINUS
//   `clocking.clockName` and `clocking.resetName`. Stated as an invariance, that rule says: adding
//   any name that is NOT a Declared_Data_Input to a port's `sources` changes nothing about the
//   classification - not the arm, not an entry, not the refusal's cause, not its port set.
//   Four name classes are non-data-inputs, and all four are added here, individually and in every
//   combination: the clock name, the reset name, a declared OUTPUT port's name, and a name the
//   interface does not declare at all.
//
// WHY THIS PROPERTY EXISTS, MEASURED
//   The worker reports cone sources with the clock and reset INCLUDED, because it holds no
//   `clocking` record and cannot tell one input from another; the subtraction happens on this side.
//   That subtraction is load-bearing: `fsm`'s `MATCH` cone contains `RST` and `pulse_detect`'s
//   `data_out` cone contains `rst_n`, so counting the reset as a data input would classify an
//   asynchronously cleared state output as `combinational` - the false-`combinational` direction
//   this feature exists to close.
//
// THE TWO VIEWS, AND WHY BOTH ARE ASSERTED
//   The whole-interface result is BLIND to a single port flipping while any OTHER port refuses: the
//   refusal arm carries no entries, so a target flipping `registered` to `combinational` leaves the
//   same cause and the same port set. So the decisive assertion is made on a SOLO view - the same
//   interface restricted to the target output port - where nothing can mask it, and the
//   whole-interface comparison is asserted alongside it for the entries-and-port-set clause. The
//   `fullContractCases` row below requires the unmasked whole-interface shape to have been drawn.
//
// THE POSITIVE CONTROL, WITHOUT WHICH THIS PASSES ON A STUB
//   A classifier that ignored `sources` altogether would satisfy every clause above. So each draw
//   also adds a REAL Declared_Data_Input name to the same target and asserts that this DOES turn it
//   `combinational`. The control runs on the solo view and only where the target is driven, because
//   clause 2 (undriven) precedes clause 3 and an undriven port refuses whatever its cone reaches.
//
// GENERATOR OBLIGATIONS
//   Every interface declares a clock and a reset port, and the target port's drawn sources come
//   from the non-data-input pool ONLY, so the target is always `registered` or refused - the
//   boundary where a mistaken subtraction would flip it. A port already `combinational` through a
//   real data input cannot demonstrate invariance, so the target is never one; the OTHER ports draw
//   from the full pool, so the contract still carries mixed arms. `clocking.resetName` is nullable,
//   and a `null` reset is drawn wherever the subset under test does not need a reset NAME to add:
//   with no reset named, the declared reset port IS a genuine data input, so there is no fourth
//   non-data-input name in that shape and the honest thing is to exercise it rather than assert it
//   away. Prototype-chain names sit among the absent names because the Declared_Data_Input set is a
//   `Set` for exactly that reason.
//
// Validates: Requirements 1.2, 1.3

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ModuleInterface, Port } from '@app/core';
import { classifyPortTiming, type PortTimingFacts, type PrepassTimingFinding } from '@app/tools';

import { ASCII_IDENT_CHARS, stringFromChars } from './generators/chars.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'timing-contract-inference, Property 5: Only declared data inputs can make a port combinational';

/** The four classes of name that are NOT a Declared_Data_Input. */
type NameClass = 'clock' | 'reset' | 'output' | 'absent';
const NAME_CLASSES: readonly NameClass[] = ['clock', 'reset', 'output', 'absent'];

/**
 * Every non-empty combination of the four classes, EXHAUSTED rather than sampled.
 *
 * A closed union of 15 members is run as 15 separate `fc.assert` calls below, so "individually and
 * in combination" is a fact about the run rather than a probability over it.
 */
const CLASS_SUBSETS: readonly (readonly NameClass[])[] = Array.from(
  { length: (1 << NAME_CLASSES.length) - 1 },
  (_unused, index) => NAME_CLASSES.filter((_class, bit) => ((index + 1) >> bit) % 2 === 1),
);

/** Names that resolve on `Object.prototype` and must still read as absent (hence a `Set`). */
const PROTOTYPE_NAMES: readonly string[] = ['__proto__', 'constructor', 'toString'];

/** Declared port names carry a prefix, so no drawn name can collide with a prototype name. */
const DECLARED_PREFIX = 'd_';
/** Absent names carry a different prefix, so they stay absent from any declared set. */
const ABSENT_PREFIX = 'a_';

type Classification = ReturnType<typeof classifyPortTiming>;

/** The names one interface is built from. Disjoint by construction: unique, and prefix-separated. */
interface NameBundle {
  readonly moduleName: string;
  readonly clockName: string;
  readonly resetPortName: string;
  readonly dataInputNames: readonly string[];
  readonly outputNames: readonly string[];
  readonly absentNames: readonly string[];
}

/** One non-target output port's cone facts, drawn freely so the contract carries mixed arms. */
interface OtherPortFacts {
  readonly sources: readonly string[];
  readonly reachesState: boolean;
  readonly undriven: boolean;
}

interface Scenario {
  readonly bundle: NameBundle;
  /** `false` leaves `clocking.resetName` null, which makes the reset port a real data input. */
  readonly hasReset: boolean;
  readonly targetIndex: number;
  /** Drawn from the non-data-input pool only, so the target is never already `combinational`. */
  readonly targetSources: readonly string[];
  readonly targetReachesState: boolean;
  readonly targetUndriven: boolean;
  /** One entry per declared output port; the target's own slot is unused. */
  readonly otherFacts: readonly OtherPortFacts[];
  readonly addedOutputName: string;
  readonly addedAbsentName: string;
  readonly insertIndex: number;
  /** Which Declared_Data_Input the positive control adds. */
  readonly controlInputIndex: number;
}

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
          resetPortName: declared[1] as string,
          dataInputNames: declared.slice(2, 2 + shape.dataInputCount),
          outputNames: declared.slice(2 + shape.dataInputCount),
          absentNames: shape.absentNames,
        }));
    });
}

/** The Declared_Data_Input set the classifier is expected to derive, restated independently. */
function dataInputNamesOf(bundle: NameBundle, hasReset: boolean): readonly string[] {
  return hasReset ? bundle.dataInputNames : [bundle.resetPortName, ...bundle.dataInputNames];
}

/** Every name that is NOT a Declared_Data_Input: the pool the target's sources are drawn from. */
function nonDataInputNamesOf(bundle: NameBundle, hasReset: boolean): readonly string[] {
  return [
    bundle.clockName,
    ...(hasReset ? [bundle.resetPortName] : []),
    ...bundle.outputNames,
    ...bundle.absentNames,
    ...PROTOTYPE_NAMES,
  ];
}

function otherFactsArbitrary(sourcePool: readonly string[]): fc.Arbitrary<OtherPortFacts> {
  return fc.record<OtherPortFacts>({
    sources: fc.subarray([...sourcePool], { minLength: 0, maxLength: 3 }),
    reachesState: fc.boolean(),
    // Weighted rather than a fair coin: an undriven port refuses ahead of every other clause, and
    // the mixed-arm contract this generator exists to produce needs most ports to classify.
    undriven: fc.constantFrom(false, false, false, true),
  });
}

/**
 * One scenario. `requiredClasses` forces a named reset wherever the reset NAME is one of the names
 * under test, because a null reset admits no such name to add.
 */
function scenarioArbitrary(requiredClasses: readonly NameClass[]): fc.Arbitrary<Scenario> {
  const needsResetName = requiredClasses.includes('reset');
  return nameBundleArbitrary().chain((bundle) =>
    (needsResetName ? fc.constant(true) : fc.boolean()).chain((hasReset) => {
      const nonDataInputs = nonDataInputNamesOf(bundle, hasReset);
      const everyName = [...nonDataInputs, ...dataInputNamesOf(bundle, hasReset)];
      const outputCount = bundle.outputNames.length;
      return fc.record<Scenario>({
        bundle: fc.constant(bundle),
        hasReset: fc.constant(hasReset),
        targetIndex: fc.nat({ max: outputCount - 1 }),
        targetSources: fc.subarray([...nonDataInputs], { minLength: 0, maxLength: 3 }),
        targetReachesState: fc.boolean(),
        targetUndriven: fc.constantFrom(false, false, false, true),
        otherFacts: fc.array(otherFactsArbitrary(everyName), {
          minLength: outputCount,
          maxLength: outputCount,
        }),
        addedOutputName: fc.constantFrom(...bundle.outputNames),
        addedAbsentName: fc.constantFrom(...PROTOTYPE_NAMES, ...bundle.absentNames),
        insertIndex: fc.nat({ max: 4 }),
        controlInputIndex: fc.nat({ max: dataInputNamesOf(bundle, hasReset).length - 1 }),
      });
    }),
  );
}

function portsOf(bundle: NameBundle): readonly Port[] {
  return [
    { name: bundle.clockName, direction: 'input', width: 1 },
    { name: bundle.resetPortName, direction: 'input', width: 1 },
    ...bundle.dataInputNames.map((name) => ({ name, direction: 'input' as const, width: 8 })),
    ...bundle.outputNames.map((name) => ({ name, direction: 'output' as const, width: 4 })),
  ];
}

function interfaceOf(scenario: Scenario): ModuleInterface {
  const { bundle, hasReset } = scenario;
  return {
    moduleName: bundle.moduleName,
    ports: portsOf(bundle),
    clocking: {
      clockName: bundle.clockName,
      resetName: hasReset ? bundle.resetPortName : null,
      resetActiveLow: true,
    },
    validityOutputName: null,
  };
}

/** The same interface restricted to the target output port: the view nothing can mask. */
function soloInterfaceOf(moduleInterface: ModuleInterface, targetName: string): ModuleInterface {
  return {
    ...moduleInterface,
    ports: moduleInterface.ports.filter(
      (port) => port.direction === 'input' || port.name === targetName,
    ),
  };
}

/** The names this subset adds. One per class, so a null reset would shorten the list. */
function addedNamesFor(scenario: Scenario, classes: readonly NameClass[]): readonly string[] {
  const { bundle, hasReset, addedOutputName, addedAbsentName } = scenario;
  const byClass: Readonly<Record<NameClass, string | null>> = {
    clock: bundle.clockName,
    reset: hasReset ? bundle.resetPortName : null,
    output: addedOutputName,
    absent: addedAbsentName,
  };
  return classes.map((nameClass) => byClass[nameClass]).filter((name) => name !== null);
}

function factsWithSourcesAdded(
  facts: PortTimingFacts,
  added: readonly string[],
  at: number,
): PortTimingFacts {
  const sources = [...facts.sources];
  sources.splice(Math.min(at, sources.length), 0, ...added);
  return { ...facts, sources };
}

/** The target's facts, with the names about to be added removed so every add is decisive. */
function targetFactsOf(scenario: Scenario, added: readonly string[]): PortTimingFacts {
  return {
    port: scenario.bundle.outputNames[scenario.targetIndex] as string,
    sources: scenario.targetSources.filter((source) => !added.includes(source)),
    reachesState: scenario.targetReachesState,
    undriven: scenario.targetUndriven,
  };
}

function findingOf(scenario: Scenario, targetFacts: PortTimingFacts): PrepassTimingFinding {
  return {
    derived: true,
    ports: scenario.bundle.outputNames.map((port, index) =>
      index === scenario.targetIndex
        ? targetFacts
        : { port, ...(scenario.otherFacts[index] as OtherPortFacts) },
    ),
  };
}

function soloFinding(facts: PortTimingFacts): PrepassTimingFinding {
  return { derived: true, ports: [facts] };
}

/**
 * The target's own class, restated here rather than read back from the classifier, so the
 * non-vacuity counts below do not depend on the code under test. Total only for a target whose
 * sources carry no Declared_Data_Input, which is how the generator draws it.
 */
type TargetClass = 'registered' | 'refused-undriven' | 'refused-independent';
function targetClassOf(facts: PortTimingFacts): TargetClass {
  if (facts.undriven) return 'refused-undriven';
  return facts.reachesState ? 'registered' : 'refused-independent';
}

/** Assert two classifications are the same arm, the same entries, and the same refusal. */
function expectSameClassification(after: Classification, before: Classification): void {
  expect(after).toEqual(before);
  expect(after.ok).toBe(before.ok);
  if (before.ok && after.ok) {
    expect(after.value.entries).toEqual(before.value.entries);
    return;
  }
  if (!before.ok && !after.ok) {
    expect(after.error.cause).toBe(before.error.cause);
    expect(after.error.ports).toEqual(before.error.ports);
  }
}

describe(PROPERTY, () => {
  it('no non-data-input name changes a classification, while a real data input makes the port combinational', () => {
    const classesDrawn = new Set<NameClass>();
    const targetClassesDrawn = new Set<TargetClass>();
    let singleClassDraws = 0;
    let multiClassDraws = 0;
    let nullResetDraws = 0;
    let prototypeNameDraws = 0;
    let fullContractCases = 0;
    let controlCases = 0;

    for (const classes of CLASS_SUBSETS) {
      fc.assert(
        fc.property(scenarioArbitrary(classes), (scenario) => {
          const moduleInterface = interfaceOf(scenario);
          const added = addedNamesFor(scenario, classes);
          // Each class under test contributed exactly one name: a null reset would shorten this,
          // and the generator forces a named reset whenever the reset class is one of them.
          expect(added.length).toBe(classes.length);

          const targetFacts = targetFactsOf(scenario, added);
          const augmentedTarget = factsWithSourcesAdded(targetFacts, added, scenario.insertIndex);
          const solo = soloInterfaceOf(moduleInterface, targetFacts.port);

          // The decisive assertion: on the solo view no other port can mask a flip.
          expectSameClassification(
            classifyPortTiming(solo, soloFinding(augmentedTarget)),
            classifyPortTiming(solo, soloFinding(targetFacts)),
          );

          // The whole-interface clause: same arm, same entries, same cause, same port set.
          const before = classifyPortTiming(moduleInterface, findingOf(scenario, targetFacts));
          const after = classifyPortTiming(moduleInterface, findingOf(scenario, augmentedTarget));
          expectSameClassification(after, before);

          // POSITIVE CONTROL. Clause 2 precedes clause 3, so an undriven target refuses whatever
          // its cone reaches and cannot witness the change; every driven target must.
          if (!targetFacts.undriven) {
            const controlName = dataInputNamesOf(scenario.bundle, scenario.hasReset)[
              scenario.controlInputIndex
            ] as string;
            const controlled = factsWithSourcesAdded(targetFacts, [controlName], 0);
            const soloBefore = classifyPortTiming(solo, soloFinding(targetFacts));
            expect(soloBefore.ok && soloBefore.value.entries[0]?.timing === 'combinational').toBe(
              false,
            );
            const soloAfter = classifyPortTiming(solo, soloFinding(controlled));
            expect(soloAfter.ok).toBe(true);
            if (soloAfter.ok) {
              expect(soloAfter.value.entries).toEqual([
                { portName: targetFacts.port, timing: 'combinational' },
              ]);
            }
            controlCases += 1;
          }

          for (const nameClass of classes) classesDrawn.add(nameClass);
          targetClassesDrawn.add(targetClassOf(targetFacts));
          if (classes.length === 1) singleClassDraws += 1;
          if (classes.length > 1) multiClassDraws += 1;
          if (!scenario.hasReset) nullResetDraws += 1;
          if (PROTOTYPE_NAMES.includes(scenario.addedAbsentName) && classes.includes('absent')) {
            prototypeNameDraws += 1;
          }
          if (before.ok) fullContractCases += 1;
        }),
        propertyParameters(),
      );
    }

    // NON-VACUITY. Every name class must have been added, each boundary target class drawn, the
    // null-reset shape exercised, a prototype-chain name used, and the whole-interface comparison
    // reached in its unmasked (contract-returning) shape at least once.
    expect({
      classesDrawn: [...classesDrawn].sort(),
      targetClassesDrawn: [...targetClassesDrawn].sort(),
      singleClassDraws: singleClassDraws > 0,
      multiClassDraws: multiClassDraws > 0,
      nullResetDraws: nullResetDraws > 0,
      prototypeNameDraws: prototypeNameDraws > 0,
      fullContractCases: fullContractCases > 0,
      controlCases: controlCases > 0,
    }).toEqual({
      classesDrawn: ['absent', 'clock', 'output', 'reset'],
      targetClassesDrawn: ['refused-independent', 'refused-undriven', 'registered'],
      singleClassDraws: true,
      multiClassDraws: true,
      nullResetDraws: true,
      prototypeNameDraws: true,
      fullContractCases: true,
      controlCases: true,
    });
  });
});
