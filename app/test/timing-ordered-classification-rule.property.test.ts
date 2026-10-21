// **Feature: timing-contract-inference, Property 4: The ordered classification rule**
// **Validates: Requirements 1.5, 1.6, 1.7, 1.9, 1.15**
//
// THE CLAIM IS THREE BICONDITIONALS, NOT THREE IMPLICATIONS
//   For any `ModuleInterface` and any derived finding covering every declared output port, each
//   returned entry is `combinational` EXACTLY WHEN that port's reported sources intersect the
//   Declared_Data_Input set (Req 1.5), is `registered` EXACTLY WHEN that intersection is empty and
//   the port reaches retained state (Req 1.6), and the result is a refusal EXACTLY WHEN both fail
//   (Req 1.15). Each clause is asserted in both directions: a one-way implication would pass a
//   classifier that answered `registered` for a port reaching a data input.
//
// THE ORACLE IS RESTATED, NOT IMPORTED
//   `declaredDataInputs` below re-derives the set - every `direction === 'input'` port MINUS
//   `clocking.clockName` and `clocking.resetName` - from the interface alone. Importing the
//   classifier's own helper would make this file assert that the subtraction equals itself.
//
// REQUIREMENT 1.7 HAS NO BRANCH HERE, BECAUSE IT HAS NONE IN THE RULE
//   A Moore output is a combinational decode over a state register, which is exactly an empty
//   data-input intersection plus state dependence, so it must land on `registered` through the
//   Req 1.6 clause. The `moore-decode` facts shape below is checked by the SAME per-port assertion
//   as every other shape and is counted separately only to prove it was reached.
//
// SCOPE
//   This property is over findings that COVER every declared output port, so `derived: false`, a
//   port the report omits, and the undriven clause are out of scope - they belong to Properties 2
//   and 3 (tasks 4.6, 4.7). `undriven` is therefore drawn `false` throughout: clause 2 fires AHEAD
//   of all three clauses asserted here, so a drawn undriven bit would pre-empt the very rule under
//   test and the property would pass vacuously.
//
// GENERATOR OBLIGATIONS, WHICH ARE WHAT DECIDE VACUITY
//   Five shapes are drawn and each is counted, with every count required non-zero: an interface
//   with zero Declared_Data_Input ports (Req 1.9); an interface whose only inputs ARE the clock and
//   the reset, so the set is empty though inputs exist; a port whose sources are ONLY the clock and
//   the reset, which must not read as `combinational`; a port with an empty source set and no state
//   dependence (Req 1.15); and one interface whose ports classify DIFFERENTLY from each other.
//   The `differing` scenario is CONSTRUCTED rather than sampled, for the reason the vault records
//   about closed-union non-vacuity rows: a scenario needing one combinational and one registered
//   port with no refusing port anywhere would be reached too rarely to pin by raising `numRuns`.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  makePort,
  type ModuleInterface,
  type Port,
  type PortDirection,
  type PortTiming,
} from '@app/core';
import { classifyPortTiming, type PortTimingFacts, type PrepassTimingFinding } from '@app/tools';

import { ASCII_IDENT_CHARS, stringFromChars } from './generators/chars.js';
import { propertyParameters } from './property.js';

const PROPERTY = 'timing-contract-inference, Property 4: The ordered classification rule';

/**
 * The Declared_Data_Input set, RESTATED from the interface so this file is an independent oracle.
 *
 * A `Set` rather than an array, so a port named `__proto__` is decided by explicit membership.
 */
function declaredDataInputs(moduleInterface: ModuleInterface): ReadonlySet<string> {
  const names = new Set(
    moduleInterface.ports.filter((port) => port.direction === 'input').map((port) => port.name),
  );
  const { clockName, resetName } = moduleInterface.clocking;
  if (clockName !== null) names.delete(clockName);
  if (resetName !== null) names.delete(resetName);
  return names;
}

/** Build a `Port` through the validating constructor, or fail the generator loudly. */
function portOrThrow(name: string, direction: PortDirection): Port {
  const built = makePort({ name, direction, width: 1 });
  if (!built.ok) {
    throw new Error(`generator produced an invalid port: ${built.error.code}`);
  }
  return built.value;
}

/** A non-empty identifier from an explicit ASCII alphabet; bit width plays no role in this rule. */
function identifierArbitrary(): fc.Arbitrary<string> {
  return stringFromChars(ASCII_IDENT_CHARS, 1, 8);
}

/**
 * The three interface shapes, two of which exist to make the Req 1.9 emptiness reachable two ways.
 *
 * `no-input-ports` has no input port at all. `clock-and-reset-only` declares inputs whose every
 * member is subtracted, which is what the corpus's ten zero-data-input designs actually look like -
 * all ten are clocked and state-dependent, so their ports are decided by state alone either way.
 */
type InterfaceShape = 'no-input-ports' | 'clock-and-reset-only' | 'with-data-inputs';

interface InterfaceDraw {
  readonly shape: InterfaceShape;
  readonly moduleName: string;
  readonly outputCount: number;
  readonly dataInputCount: number;
  readonly withReset: boolean;
}

/** A generated interface plus the name groups the facts generator draws its source sets from. */
interface GeneratedInterface {
  readonly moduleInterface: ModuleInterface;
  readonly shape: InterfaceShape;
  readonly outputNames: readonly string[];
  readonly dataInputNames: readonly string[];
  /** The declared clock and reset names, which are the inputs the subtraction removes. */
  readonly clockingNames: readonly string[];
}

/** Assign the drawn unique names to the output, data-input, clock, and reset roles. */
function buildInterface(draw: InterfaceDraw, names: readonly string[]): GeneratedInterface {
  const clocked = draw.shape !== 'no-input-ports';
  const outputNames = names.slice(0, draw.outputCount);
  const dataInputNames = names.slice(draw.outputCount, draw.outputCount + draw.dataInputCount);
  const spare = names.slice(draw.outputCount + draw.dataInputCount);
  const clockName = clocked ? (spare[0] ?? null) : null;
  const resetName = clocked && draw.withReset ? (spare[1] ?? null) : null;
  const clockingNames = [clockName, resetName].filter((name): name is string => name !== null);
  return {
    moduleInterface: {
      moduleName: draw.moduleName,
      ports: [
        ...outputNames.map((name) => portOrThrow(name, 'output')),
        ...dataInputNames.map((name) => portOrThrow(name, 'input')),
        ...clockingNames.map((name) => portOrThrow(name, 'input')),
      ],
      clocking: { clockName, resetName, resetActiveLow: true },
      validityOutputName: null,
    },
    shape: draw.shape,
    outputNames,
    dataInputNames,
    clockingNames,
  };
}

function interfaceArbitrary(): fc.Arbitrary<GeneratedInterface> {
  return fc
    .record<InterfaceDraw>({
      shape: fc.constantFrom<InterfaceShape>(
        'no-input-ports',
        'clock-and-reset-only',
        'with-data-inputs',
      ),
      moduleName: identifierArbitrary(),
      outputCount: fc.integer({ min: 1, max: 4 }),
      dataInputCount: fc.integer({ min: 1, max: 3 }),
      withReset: fc.boolean(),
    })
    .map((draw): InterfaceDraw => {
      // Only `with-data-inputs` declares a data input; the other two shapes are the empty set.
      const dataInputCount = draw.shape === 'with-data-inputs' ? draw.dataInputCount : 0;
      return { ...draw, dataInputCount };
    })
    .chain((draw) => {
      const clocked = draw.shape !== 'no-input-ports';
      const needed =
        draw.outputCount +
        draw.dataInputCount +
        (clocked ? 1 : 0) +
        (clocked && draw.withReset ? 1 : 0);
      return fc
        .uniqueArray(identifierArbitrary(), { minLength: needed, maxLength: needed })
        .map((names) => buildInterface(draw, names));
    });
}

/**
 * The five facts shapes, named by what they make TRUE of the two clauses rather than by outcome.
 *
 * `moore-decode` and `clock-reset-stateless` both carry sources drawn ONLY from the clock and the
 * reset, which is the pair that separates a real subtraction from a bare non-empty `sources` check:
 * `fsm`'s `MATCH` cone contains `RST` and `pulse_detect`'s `data_out` cone contains `rst_n`.
 */
type FactsKind = 'data-input' | 'moore-decode' | 'clock-reset-stateless' | 'state-only' | 'inert';

/** Which shapes a given interface can witness: a data input it does not declare cannot be drawn. */
function availableKinds(generated: GeneratedInterface): readonly FactsKind[] {
  const kinds: FactsKind[] = ['state-only', 'inert'];
  if (generated.clockingNames.length > 0) {
    kinds.push('moore-decode', 'clock-reset-stateless');
  }
  if (generated.dataInputNames.length > 0) {
    kinds.push('data-input');
  }
  return kinds;
}

interface PortDraw {
  readonly kind: FactsKind;
  /** A non-empty pick, used only by `data-input`. */
  readonly dataInputPicks: readonly string[];
  /** A non-empty pick, used by the two clock-and-reset-sourced shapes and optionally by Mealy. */
  readonly clockingPicks: readonly string[];
  /** Whether a `data-input` port ALSO reaches state, which is the Mealy shape on a clocked design. */
  readonly mealy: boolean;
}

/**
 * One port's cone facts for the drawn shape.
 *
 * `undriven: false` throughout. See the header: clause 2 outranks every clause asserted here, so an
 * undriven bit would refuse the port before the data-input and state clauses were consulted.
 */
function factsFor(portName: string, draw: PortDraw): PortTimingFacts {
  const base = { port: portName, undriven: false };
  switch (draw.kind) {
    case 'data-input':
      return {
        ...base,
        sources: [...draw.dataInputPicks, ...draw.clockingPicks],
        reachesState: draw.mealy,
      };
    case 'moore-decode':
      return { ...base, sources: draw.clockingPicks, reachesState: true };
    case 'clock-reset-stateless':
      return { ...base, sources: draw.clockingPicks, reachesState: false };
    case 'state-only':
      return { ...base, sources: [], reachesState: true };
    case 'inert':
      return { ...base, sources: [], reachesState: false };
  }
}

/** A non-empty sub-pick of `names`, or the empty list where the interface declares none. */
function pickArbitrary(names: readonly string[]): fc.Arbitrary<readonly string[]> {
  if (names.length === 0) {
    return fc.constant([]);
  }
  return fc.shuffledSubarray([...names], { minLength: 1, maxLength: names.length });
}

function portDrawArbitrary(generated: GeneratedInterface): fc.Arbitrary<PortDraw> {
  return fc.record<PortDraw>({
    kind: fc.constantFrom(...availableKinds(generated)),
    dataInputPicks: pickArbitrary(generated.dataInputNames),
    clockingPicks: pickArbitrary(generated.clockingNames),
    mealy: fc.boolean(),
  });
}

/**
 * `free` draws each port's shape independently; `differing` is the constructed shape.
 *
 * `differing` forces port 0 onto `data-input` and port 1 onto `moore-decode` and rewrites every
 * refusing shape after them, which is the only way to reach one interface whose ports classify
 * differently from each other inside an `ok` result - a refusal anywhere voids the whole contract.
 */
type ScenarioKind = 'free' | 'differing';

interface Scenario {
  readonly generated: GeneratedInterface;
  readonly kind: ScenarioKind;
  readonly portDraws: readonly PortDraw[];
}

const NON_REFUSING_REPLACEMENT: FactsKind = 'state-only';

/** Rewrite the drawn shapes so the scenario's whole result is an `ok` carrying both values. */
function forceDiffering(portDraws: readonly PortDraw[]): readonly PortDraw[] {
  return portDraws.map((draw, index) => {
    if (index === 0) return { ...draw, kind: 'data-input' };
    if (index === 1) return { ...draw, kind: 'moore-decode' };
    const refusing = draw.kind === 'inert' || draw.kind === 'clock-reset-stateless';
    return refusing ? { ...draw, kind: NON_REFUSING_REPLACEMENT } : draw;
  });
}

function scenarioArbitrary(): fc.Arbitrary<Scenario> {
  return interfaceArbitrary().chain((generated) => {
    const outputCount = generated.outputNames.length;
    // `differing` needs a declared data input for the combinational port and a second output for
    // the registered one; `with-data-inputs` is always clocked, so `moore-decode` is available.
    const kinds: readonly ScenarioKind[] =
      generated.shape === 'with-data-inputs' && outputCount >= 2 ? ['free', 'differing'] : ['free'];
    return fc
      .record({
        generated: fc.constant(generated),
        kind: fc.constantFrom(...kinds),
        portDraws: fc.array(portDrawArbitrary(generated), {
          minLength: outputCount,
          maxLength: outputCount,
        }),
      })
      .map((scenario): Scenario => ({
        ...scenario,
        portDraws:
          scenario.kind === 'differing' ? forceDiffering(scenario.portDraws) : scenario.portDraws,
      }));
  });
}

/** The tallies that keep every obligation in the header non-vacuous. */
interface ShapeCounts {
  zeroDataInputInterfaces: number;
  clockAndResetOnlyInterfaces: number;
  clockResetOnlySourcePorts: number;
  inertPorts: number;
  differingInterfaces: number;
  mooreRegisteredPorts: number;
}

describe(PROPERTY, () => {
  it('classifies combinational iff a data input is reached, registered iff state alone is, and refuses iff neither', () => {
    const counts: ShapeCounts = {
      zeroDataInputInterfaces: 0,
      clockAndResetOnlyInterfaces: 0,
      clockResetOnlySourcePorts: 0,
      inertPorts: 0,
      differingInterfaces: 0,
      mooreRegisteredPorts: 0,
    };

    fc.assert(
      fc.property(scenarioArbitrary(), (scenario) => {
        const { moduleInterface, outputNames, shape } = scenario.generated;
        const dataInputs = declaredDataInputs(moduleInterface);
        const ports = outputNames.map((name, index) =>
          factsFor(name, scenario.portDraws[index] as PortDraw),
        );
        const finding: PrepassTimingFinding = { derived: true, ports };
        const reachesDataInput = (facts: PortTimingFacts): boolean =>
          facts.sources.some((source) => dataInputs.has(source));

        const classified = classifyPortTiming(moduleInterface, finding);

        // Clause 3, both directions: a refusal is returned EXACTLY when some port fails both the
        // data-input clause and the state clause (Req 1.15).
        const expectedRefused = ports
          .filter((facts) => !reachesDataInput(facts) && !facts.reachesState)
          .map((facts) => facts.port);
        expect(classified.ok).toBe(expectedRefused.length === 0);

        if (classified.ok) {
          const timingByPort = new Map<string, PortTiming>(
            classified.value.entries.map((entry) => [entry.portName, entry.timing]),
          );
          for (const facts of ports) {
            const intersects = reachesDataInput(facts);
            const timing = timingByPort.get(facts.port);
            expect(timing).toBeDefined();
            // Clause 1 (Req 1.5) and clause 2 (Req 1.6, and Req 1.7's Moore shape through it),
            // each asserted in BOTH directions.
            expect(timing === 'combinational').toBe(intersects);
            expect(timing === 'registered').toBe(!intersects && facts.reachesState);
          }
          const values = new Set(classified.value.entries.map((entry) => entry.timing));
          if (values.size > 1) counts.differingInterfaces += 1;
          for (const [index, facts] of ports.entries()) {
            if (
              scenario.portDraws[index]?.kind === 'moore-decode' &&
              timingByPort.get(facts.port) === 'registered'
            ) {
              counts.mooreRegisteredPorts += 1;
            }
          }
        } else {
          expect(classified.error.cause).toBe('input-and-state-independent');
          expect(new Set(classified.error.ports)).toEqual(new Set(expectedRefused));
          // Req 1.15's exclusion, stated as a shape: a refused result carries no entries at all,
          // so `combinational` cannot have been the outcome for an input- and state-independent
          // port.
          expect('value' in classified).toBe(false);
        }

        if (dataInputs.size === 0) counts.zeroDataInputInterfaces += 1;
        if (shape === 'clock-and-reset-only') counts.clockAndResetOnlyInterfaces += 1;
        for (const facts of ports) {
          if (facts.sources.length > 0 && !reachesDataInput(facts)) {
            counts.clockResetOnlySourcePorts += 1;
          }
          if (facts.sources.length === 0 && !facts.reachesState) counts.inertPorts += 1;
        }
      }),
      propertyParameters({ numRuns: 200 }),
    );

    // NON-VACUITY: every shape the task names must actually have been drawn.
    const reached = Object.fromEntries(
      Object.entries(counts).map(([shapeName, count]) => [shapeName, count > 0]),
    );
    expect(reached).toEqual({
      zeroDataInputInterfaces: true,
      clockAndResetOnlyInterfaces: true,
      clockResetOnlySourcePorts: true,
      inertPorts: true,
      differingInterfaces: true,
      mooreRegisteredPorts: true,
    });
  });
});
