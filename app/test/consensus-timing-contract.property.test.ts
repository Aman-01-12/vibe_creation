// reference-model-consensus-gate, Property 14: The Timing_Contract is total or refused, and never
// defaulted (task 1.4). This file covers the CONSTRUCTION clause only. The second clause - a Spec
// whose draft contract has a gap raises one Ambiguity_Escalation per gapped port and issues zero
// model calls - is appended to this same file by task 13.6, which is why the two tasks are serial on
// it; nothing below should be restructured in a way that would block that append.
//
// THE ORACLE
//   `makeTimingContract` constructs iff `declared`'s port names are a bijection onto the interface's
//   output port names: no duplicate, no entry naming a non-output port, and no output port omitted.
//   This file restates that bijection independently of the implementation and asserts the three ways
//   it can fail land on their own named refusal, plus - for the gap case specifically - that the
//   refusal names EXACTLY the missing set (Req 6.2's "never defaulted": nothing is guessed, so the
//   named set must be the true set difference, not a superset or a subset of it).
//
// WHY THE DECISIVE SHAPES ARE CONSTRUCTED, NOT SAMPLED
//   A random `declared` list drawn independently of the generated output-port set would almost never
//   land on a permutation of it once that set has more than a couple of ports, so the accepting half
//   of the oracle - and each specific refusal shape - would be under-tested or untested. Each case
//   `scenarioArbitrary` below produces is therefore DERIVED from the same generated port names it is
//   checked against: a shuffled permutation of the full output set (the "entries shuffled" case,
//   order-independence), that same set with exactly one entry dropped (the "exactly one gap" case),
//   that same set plus one duplicate of an existing entry, and that same set plus one entry naming a
//   declared INPUT port. The zero-output and one-output interface shapes are reached by letting the
//   generated output count range down to 0, not by a dedicated generator.
//
// Validates: Requirements 6.1, 6.2

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  makePort,
  makeTimingContract,
  type ModuleInterface,
  type Port,
  type PortDirection,
  type TimingContractEntry,
} from '@app/core';

import { ASCII_IDENT_CHARS, stringFromChars } from './generators/chars.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'reference-model-consensus-gate, Property 14: The Timing_Contract is total or refused, and never defaulted';

/** See the header: the rarest required combination is a zero-output interface paired with one of
 * two applicable kinds, at roughly 1-in-14 per run, so 300 runs rather than the 100 default. */
const NUM_RUNS = 300;

type Timing = 'registered' | 'combinational';
const TIMINGS: readonly Timing[] = ['registered', 'combinational'];

/** Build a `Port` through the validating constructor, or fail the generator loudly. */
function portOrThrow(name: string, direction: PortDirection): Port {
  const built = makePort({ name, direction, width: 1 });
  if (!built.ok) {
    throw new Error(`generator produced an invalid port: ${built.error.code}`);
  }
  return built.value;
}

/** A non-empty identifier drawn from an explicit ASCII alphabet; widths play no role here. */
function identifierArbitrary(): fc.Arbitrary<string> {
  return stringFromChars(ASCII_IDENT_CHARS, 1, 10);
}

/** A `ModuleInterface` plus the output and input port names it was built from. */
interface GeneratedInterface {
  readonly moduleInterface: ModuleInterface;
  readonly outputNames: readonly string[];
  readonly inputNames: readonly string[];
}

/** The raw, pre-naming shape: how many output and input ports to declare. Always at least one
 * input, so the "extra entry naming an input" case always has one to name. */
interface InterfaceShape {
  readonly moduleName: string;
  readonly outputCount: number;
  readonly inputCount: number;
}

function buildGeneratedInterface(
  shape: InterfaceShape,
  uniqueNames: readonly string[],
): GeneratedInterface {
  const outputNames = uniqueNames.slice(0, shape.outputCount);
  const inputNames = uniqueNames.slice(shape.outputCount);
  const moduleInterface: ModuleInterface = {
    moduleName: shape.moduleName,
    ports: [
      ...outputNames.map((name) => portOrThrow(name, 'output')),
      ...inputNames.map((name) => portOrThrow(name, 'input')),
    ],
    clocking: { clockName: null, resetName: null, resetActiveLow: false },
    validityOutputName: null,
  };
  return { moduleInterface, outputNames, inputNames };
}

/** Zero to six output ports (reaching the zero- and one-output decisive shapes), at least one input. */
function generatedInterfaceArbitrary(): fc.Arbitrary<GeneratedInterface> {
  return fc
    .record<InterfaceShape>({
      moduleName: identifierArbitrary(),
      outputCount: fc.integer({ min: 0, max: 6 }),
      inputCount: fc.integer({ min: 1, max: 3 }),
    })
    .chain((shape) => {
      const needed = shape.outputCount + shape.inputCount;
      return fc
        .uniqueArray(identifierArbitrary(), { minLength: needed, maxLength: needed })
        .map((names) => buildGeneratedInterface(shape, names));
    });
}

/**
 * The four decisive shapes. `single-gap` and `duplicate-entry` need an existing output entry to
 * drop or duplicate, so they are only drawn when the generated interface declared at least one.
 */
type ScenarioKind = 'permutation' | 'single-gap' | 'duplicate-entry' | 'extra-input-entry';

interface Scenario {
  readonly generated: GeneratedInterface;
  readonly kind: ScenarioKind;
  readonly timings: readonly Timing[];
  readonly order: readonly number[];
  readonly pickedOutputIndex: number;
  readonly pickedInputIndex: number;
  readonly extraTiming: Timing;
}

function scenarioArbitrary(): fc.Arbitrary<Scenario> {
  return generatedInterfaceArbitrary().chain((generated) => {
    const outputCount = generated.outputNames.length;
    const kinds: readonly ScenarioKind[] =
      outputCount > 0
        ? ['permutation', 'single-gap', 'duplicate-entry', 'extra-input-entry']
        : ['permutation', 'extra-input-entry'];
    return fc.record<Scenario>({
      generated: fc.constant(generated),
      kind: fc.constantFrom(...kinds),
      timings: fc.array(fc.constantFrom(...TIMINGS), {
        minLength: outputCount,
        maxLength: outputCount,
      }),
      order: fc.shuffledSubarray([...Array(outputCount).keys()], {
        minLength: outputCount,
        maxLength: outputCount,
      }),
      pickedOutputIndex: outputCount > 0 ? fc.nat({ max: outputCount - 1 }) : fc.constant(0),
      pickedInputIndex: fc.nat({ max: generated.inputNames.length - 1 }),
      extraTiming: fc.constantFrom(...TIMINGS),
    });
  });
}

type RefusalCode =
  'MISSING_PORT_TIMING' | 'DUPLICATE_PORT_TIMING_ENTRY' | 'TIMING_ENTRY_NOT_AN_OUTPUT_PORT';

type Expectation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: RefusalCode; readonly missing?: readonly string[] };

/** The `declared` entries one scenario submits, and the outcome the bijection oracle predicts. */
function entriesFor(scenario: Scenario): {
  readonly declared: readonly TimingContractEntry[];
  readonly expectation: Expectation;
} {
  const { generated, kind, timings, order, pickedOutputIndex, pickedInputIndex, extraTiming } =
    scenario;
  const { outputNames, inputNames } = generated;
  const fullSet: readonly TimingContractEntry[] = order.map((index) => ({
    portName: outputNames[index] as string,
    timing: timings[index] as Timing,
  }));

  switch (kind) {
    case 'permutation':
      return { declared: fullSet, expectation: { ok: true } };
    case 'single-gap': {
      const droppedName = outputNames[pickedOutputIndex] as string;
      const declared = fullSet.filter((entry) => entry.portName !== droppedName);
      return {
        declared,
        expectation: { ok: false, code: 'MISSING_PORT_TIMING', missing: [droppedName] },
      };
    }
    case 'duplicate-entry': {
      const duplicatedName = outputNames[pickedOutputIndex] as string;
      const declared = [...fullSet, { portName: duplicatedName, timing: extraTiming }];
      return { declared, expectation: { ok: false, code: 'DUPLICATE_PORT_TIMING_ENTRY' } };
    }
    case 'extra-input-entry': {
      const extraName = inputNames[pickedInputIndex] as string;
      const declared = [...fullSet, { portName: extraName, timing: extraTiming }];
      return { declared, expectation: { ok: false, code: 'TIMING_ENTRY_NOT_AN_OUTPUT_PORT' } };
    }
  }
}

/** An order-independent view of an entry list, for comparing two sets of entries. */
function sortedEntries(entries: readonly TimingContractEntry[]): readonly TimingContractEntry[] {
  return [...entries].sort((left, right) => left.portName.localeCompare(right.portName));
}

/** The exact port names a `MISSING_PORT_TIMING` message lists, read from its own fixed shape rather
 * than guessed by substring search (two generated names can otherwise collide as substrings). */
const MISSING_PORTS_MARKER = 'output port(s): ';
function namedMissingPorts(message: string): readonly string[] {
  const markerIndex = message.indexOf(MISSING_PORTS_MARKER);
  if (markerIndex === -1) {
    return [];
  }
  return message.slice(markerIndex + MISSING_PORTS_MARKER.length).split(', ');
}

describe(PROPERTY, () => {
  it('constructs iff declared is a bijection onto the output ports, and otherwise refuses by the specific defect', () => {
    let zeroOutputCases = 0;
    let oneOutputCases = 0;
    let permutationCases = 0;
    let singleGapCases = 0;
    let duplicateCases = 0;
    let extraInputCases = 0;

    fc.assert(
      fc.property(scenarioArbitrary(), (scenario) => {
        const { generated, kind } = scenario;
        const { outputNames } = generated;
        const { declared, expectation } = entriesFor(scenario);

        const built = makeTimingContract(generated.moduleInterface, declared);

        // No refusal path returns a partial contract: an `err` result carries no `value` field at
        // all, asserted directly rather than inferred from `built.ok`.
        expect('value' in built).toBe(expectation.ok);

        if (expectation.ok) {
          expect(built.ok).toBe(true);
          if (built.ok) {
            // Order-independent (the "entries shuffled" decisive case): the contract holds exactly
            // the submitted set regardless of the order it was declared in.
            expect(sortedEntries(built.value.entries)).toEqual(sortedEntries(declared));
            // No entry names a port the interface does not declare as an output.
            for (const entry of built.value.entries) {
              expect(outputNames).toContain(entry.portName);
            }
          }
        } else {
          expect(built.ok).toBe(false);
          if (!built.ok) {
            expect(built.error.code).toBe(expectation.code);
            if (expectation.missing) {
              // Names exactly the gap: the set the message lists equals the set that was omitted,
              // neither a superset nor a subset of it (Req 6.2, "never defaulted").
              expect(new Set(namedMissingPorts(built.error.message))).toEqual(
                new Set(expectation.missing),
              );
            }
          }
        }

        if (outputNames.length === 0) {
          zeroOutputCases += 1;
        }
        if (outputNames.length === 1) {
          oneOutputCases += 1;
        }
        if (kind === 'permutation') {
          permutationCases += 1;
        }
        if (kind === 'single-gap') {
          singleGapCases += 1;
        }
        if (kind === 'duplicate-entry') {
          duplicateCases += 1;
        }
        if (kind === 'extra-input-entry') {
          extraInputCases += 1;
        }
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    // NON-VACUITY: every decisive shape the task names must actually have been exercised.
    expect({
      zeroOutputCases: zeroOutputCases > 0,
      oneOutputCases: oneOutputCases > 0,
      permutationCases: permutationCases > 0,
      singleGapCases: singleGapCases > 0,
      duplicateCases: duplicateCases > 0,
      extraInputCases: extraInputCases > 0,
    }).toEqual({
      zeroOutputCases: true,
      oneOutputCases: true,
      permutationCases: true,
      singleGapCases: true,
      duplicateCases: true,
      extraInputCases: true,
    });
  });
});

// Property 14's second clause (the Ambiguity_Escalation rule over a gapped Spec draft) is appended
// here, below this closed `describe` block, by task 13.6.
