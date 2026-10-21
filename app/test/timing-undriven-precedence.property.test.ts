// timing-contract-inference, Property 3: an undriven bit refuses the port ahead of every other
// clause (task 4.7).
//
// WHAT REQUIREMENT 1.18 ACTUALLY CLAIMS
//   A declared output port with one undriven bit and a second bit reachable from a
//   Declared_Data_Input must REFUSE, not receive a whole-port value, because that value is
//   fabricated for the bits that have no driver. `alu`'s `carry`, `negative`, and `overflow` are
//   the measured witnesses: declared and never assigned in `verified_alu`. So the claim is about
//   CLAUSE ORDER, not about any single clause's answer.
//
// WHY THE DECISIVE HALF IS A PAIRED BEFORE/AFTER
//   "An undriven port refuses" on its own is satisfied by a classifier with no ordering at all,
//   because clause 5 refuses an undriven port that reaches nothing anyway. The ordering claim only
//   becomes falsifiable when the port WOULD have classified: the same drawn input is therefore
//   classified twice, once with `undriven: false` and once with `undriven: true` on one pivot port
//   whose shape reaches a declared data input (clause 3) or retained state (clause 4). Flipping
//   that one boolean must turn a contract into a refusal naming exactly that port. Over the same
//   input, that is a precedence claim; as two independent draws it would be a coincidence.
//   Both classifying clauses are pivoted separately, because precedence over clause 3 says nothing
//   about precedence over clause 4.
//
// WHY THE GENERATOR'S COVERAGE IS THE WHOLE TEST
//   A generator that only ever draws an undriven port with no sources and no state dependence
//   proves NOTHING about ordering - clause 5 would refuse that port whatever the order. So the four
//   undriven shapes are a closed table, port 0's shape is DRAWN FROM that table on every run rather
//   than left to independent coin flips, and each of the four is counted and required non-zero.
//   This follows `gotcha-a-closed-union-non-vacuity-row-should-be-exhausted-not-sampled.md`:
//   forcing the row is the lever, not raising `numRuns`.
//
// THE ORACLE IS RESTATED, NOT IMPORTED
//   `oracleOutcome` below restates the five-clause rule from the requirements over the SHAPE a port
//   was drawn from, so the test does not grade `classifyPortTiming` against itself. The clock and
//   the reset are seeded into `sources` on purpose: they are inputs the worker reports and the
//   classifier must subtract, so a port whose only sources are those two must not read as
//   reaching a data input.
//
// Zero-data-input interfaces and the fully-driven constant shape belong to task 4.8's Property 4
// and are not restated here; every interface below declares at least one data input.
//
// **Validates: Requirements 1.16, 1.17, 1.18, 2.2**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ModuleInterface } from '@app/core';
import { classifyPortTiming, type PortTimingFacts, type PrepassTimingFinding } from '@app/tools';

import { ASCII_IDENT_CHARS, stringFromChars } from './generators/chars.js';
import { propertyParameters } from './property.js';

// **Feature: timing-contract-inference, Property 3: An undriven bit refuses the port ahead of every other clause**
const PROPERTY =
  'timing-contract-inference, Property 3: An undriven bit refuses the port ahead of every other clause';

/**
 * The four undriven shapes. The first three are what make this a precedence test rather than a
 * restatement of clause 5; the fourth is the shape clause 5 would catch anyway, kept so the claim
 * is stated over every undriven port and not only over the interesting ones.
 */
const COVER_SHAPES = [
  'undriven-reaching-a-data-input',
  'undriven-reaching-state',
  'undriven-reaching-both',
  'undriven-reaching-neither',
] as const;
type CoverShape = (typeof COVER_SHAPES)[number];

/** Which classifying clause the paired before/after pivots on. */
const PIVOT_KINDS = ['sources', 'state'] as const;
type PivotKind = (typeof PIVOT_KINDS)[number];

/** One output port's cone shape, before any port name is attached to it. */
interface PortShape {
  readonly undriven: boolean;
  /** Whether `sources` carries a Declared_Data_Input, which is what clause 3 reads. */
  readonly reachesDataInput: boolean;
  readonly reachesState: boolean;
  /** Whether the clock and the reset are also in `sources`; neither may count as a data input. */
  readonly clockAndResetInSources: boolean;
}

function shapeOf(cover: CoverShape, clockAndResetInSources: boolean): PortShape {
  return {
    undriven: true,
    reachesDataInput:
      cover === 'undriven-reaching-a-data-input' || cover === 'undriven-reaching-both',
    reachesState: cover === 'undriven-reaching-state' || cover === 'undriven-reaching-both',
    clockAndResetInSources,
  };
}

/** A drawn interface, the names it was built from, and one shape per declared output port. */
interface Drawn {
  readonly moduleInterface: ModuleInterface;
  readonly clockName: string;
  readonly resetName: string;
  readonly dataInputNames: readonly string[];
  readonly outputNames: readonly string[];
  readonly shapes: readonly PortShape[];
  readonly pivotIndex: number;
  readonly pivotKind: PivotKind;
  readonly coverShape: CoverShape;
}

/** How many ports of each kind to declare. At least one data input and one output port. */
interface InterfaceShape {
  readonly moduleName: string;
  readonly dataInputCount: number;
  readonly outputCount: number;
}

/** Identifiers with a leading letter, so no drawn name is a digit-initial HDL identifier. */
function identifierArbitrary(): fc.Arbitrary<string> {
  return stringFromChars(ASCII_IDENT_CHARS, 1, 8).map((tail) => `p${tail}`);
}

function portShapeArbitrary(): fc.Arbitrary<PortShape> {
  return fc.record<PortShape>({
    undriven: fc.boolean(),
    reachesDataInput: fc.boolean(),
    reachesState: fc.boolean(),
    clockAndResetInSources: fc.boolean(),
  });
}

function buildDrawn(
  shape: InterfaceShape,
  names: readonly string[],
  parts: {
    readonly coverShape: CoverShape;
    readonly coverClockAndReset: boolean;
    readonly tailShapes: readonly PortShape[];
    readonly pivotIndex: number;
    readonly pivotKind: PivotKind;
  },
): Drawn {
  const clockName = names[0] as string;
  const resetName = names[1] as string;
  const dataInputNames = names.slice(2, 2 + shape.dataInputCount);
  const outputNames = names.slice(2 + shape.dataInputCount);
  const moduleInterface: ModuleInterface = {
    moduleName: shape.moduleName,
    ports: [
      { name: clockName, direction: 'input', width: 1 },
      { name: resetName, direction: 'input', width: 1 },
      ...dataInputNames.map((name) => ({ name, direction: 'input' as const, width: 8 })),
      ...outputNames.map((name) => ({ name, direction: 'output' as const, width: 4 })),
    ],
    clocking: { clockName, resetName, resetActiveLow: true },
    validityOutputName: null,
  };
  return {
    moduleInterface,
    clockName,
    resetName,
    dataInputNames,
    outputNames,
    // Port 0 carries the forced cover shape; the rest are free, so a run also exercises mixed
    // findings where a classifying port sits beside an undriven one.
    shapes: [shapeOf(parts.coverShape, parts.coverClockAndReset), ...parts.tailShapes],
    pivotIndex: parts.pivotIndex,
    pivotKind: parts.pivotKind,
    coverShape: parts.coverShape,
  };
}

function drawnArbitrary(): fc.Arbitrary<Drawn> {
  return fc
    .record<InterfaceShape>({
      moduleName: identifierArbitrary(),
      dataInputCount: fc.integer({ min: 1, max: 3 }),
      outputCount: fc.integer({ min: 1, max: 4 }),
    })
    .chain((shape) => {
      const needed = 2 + shape.dataInputCount + shape.outputCount;
      return fc
        .record({
          names: fc.uniqueArray(identifierArbitrary(), { minLength: needed, maxLength: needed }),
          coverShape: fc.constantFrom(...COVER_SHAPES),
          coverClockAndReset: fc.boolean(),
          tailShapes: fc.array(portShapeArbitrary(), {
            minLength: shape.outputCount - 1,
            maxLength: shape.outputCount - 1,
          }),
          pivotIndex: fc.nat({ max: shape.outputCount - 1 }),
          pivotKind: fc.constantFrom(...PIVOT_KINDS),
        })
        .map(({ names, ...parts }) => buildDrawn(shape, names, parts));
    });
}

/** The cone facts one shape reports for the output port at `index`. */
function factsFor(drawn: Drawn, index: number, shape: PortShape): PortTimingFacts {
  const dataInput = drawn.dataInputNames[index % drawn.dataInputNames.length] as string;
  return {
    port: drawn.outputNames[index] as string,
    sources: [
      ...(shape.reachesDataInput ? [dataInput] : []),
      ...(shape.clockAndResetInSources ? [drawn.clockName, drawn.resetName] : []),
    ],
    reachesState: shape.reachesState,
    undriven: shape.undriven,
  };
}

/** A derived finding reporting every declared output port under `shapes`. */
function findingFor(drawn: Drawn, shapes: readonly PortShape[]): PrepassTimingFinding {
  return { derived: true, ports: shapes.map((shape, index) => factsFor(drawn, index, shape)) };
}

type Outcome =
  'combinational' | 'registered' | 'undriven-output-port' | 'input-and-state-independent';

/**
 * The five-clause rule restated from Requirements 1.5 to 1.9 and 1.16 to 1.18, over a port's shape.
 *
 * Clauses 1 and 2 of the implementation are not reachable here: every finding is `derived` and
 * reports every declared output port, which is deliberate - it leaves `undriven-output-port` as
 * the highest-ranked cause any drawn port can carry, so the refusal's cause is decidable from the
 * shapes alone.
 */
function oracleOutcome(shape: PortShape): Outcome {
  if (shape.undriven) return 'undriven-output-port';
  if (shape.reachesDataInput) return 'combinational';
  if (shape.reachesState) return 'registered';
  return 'input-and-state-independent';
}

/**
 * The paired shapes for the pivot clause: every port classifies, and the pivot classifies through
 * the clause `pivotKind` names. Only `undriven` on the pivot differs between the two calls, so any
 * difference in outcome is attributable to that one bit.
 */
function pairedShapes(drawn: Drawn, pivotUndriven: boolean): readonly PortShape[] {
  return drawn.shapes.map((shape, index) =>
    index === drawn.pivotIndex
      ? {
          undriven: pivotUndriven,
          reachesDataInput: drawn.pivotKind === 'sources',
          reachesState: drawn.pivotKind === 'state',
          clockAndResetInSources: shape.clockAndResetInSources,
        }
      : // Every non-pivot port must classify, or the refusal would not name the pivot alone.
        { ...shape, undriven: false, reachesDataInput: true },
  );
}

describe(PROPERTY, () => {
  it('refuses every undriven port whatever its sources and state, and a single undriven bit overrides both classifying clauses', () => {
    const counts = {
      undrivenReachingADataInput: 0,
      undrivenReachingState: 0,
      undrivenReachingBoth: 0,
      undrivenReachingNeither: 0,
      pivotOnSources: 0,
      pivotOnState: 0,
    };

    fc.assert(
      fc.property(drawnArbitrary(), (drawn) => {
        const { outputNames, shapes } = drawn;
        const undrivenNames = outputNames.filter(
          (_, index) => (shapes[index] as PortShape).undriven,
        );
        const undeterminedNames = outputNames.filter(
          (_, index) =>
            oracleOutcome(shapes[index] as PortShape) !== 'combinational' &&
            oracleOutcome(shapes[index] as PortShape) !== 'registered',
        );

        const classified = classifyPortTiming(drawn.moduleInterface, findingFor(drawn, shapes));

        // An undriven port NEVER reaches a contract, whatever its sources or state dependence: the
        // forced cover shape makes at least one port undriven on every run, so `ok` is always false
        // here, and the entry set it would have carried is asserted empty rather than merely absent.
        expect(classified.ok).toBe(false);
        if (classified.ok) return;
        expect('value' in classified).toBe(false);
        // Req 2.2: ONE refusal naming EVERY undetermined port.
        expect(new Set(classified.error.ports)).toEqual(new Set(undeterminedNames));
        for (const name of undrivenNames) {
          expect(classified.error.ports).toContain(name);
        }
        // Where every undetermined port is undriven, the cause is the undriven one. `undriven`
        // outranks `input-and-state-independent`, so it is also the cause of a mixed refusal.
        if (undeterminedNames.length === undrivenNames.length) {
          expect(classified.error.cause).toBe('undriven-output-port');
        }

        // THE DECISIVE CLAUSE, paired over this same drawn input.
        const pivotName = outputNames[drawn.pivotIndex] as string;
        const before = classifyPortTiming(
          drawn.moduleInterface,
          findingFor(drawn, pairedShapes(drawn, false)),
        );
        const after = classifyPortTiming(
          drawn.moduleInterface,
          findingFor(drawn, pairedShapes(drawn, true)),
        );

        // Before: the pivot classified, through clause 3 or clause 4 as `pivotKind` chose.
        expect(before.ok).toBe(true);
        if (!before.ok) return;
        expect(before.value.entries).toContainEqual({
          portName: pivotName,
          timing: drawn.pivotKind === 'sources' ? 'combinational' : 'registered',
        });

        // After: flipping that one bit refuses, naming the pivot and nothing else.
        expect(after.ok).toBe(false);
        if (after.ok) return;
        expect(after.error.cause).toBe('undriven-output-port');
        expect(after.error.ports).toEqual([pivotName]);

        for (const shape of shapes) {
          if (!shape.undriven) continue;
          if (shape.reachesDataInput && shape.reachesState) counts.undrivenReachingBoth += 1;
          else if (shape.reachesDataInput) counts.undrivenReachingADataInput += 1;
          else if (shape.reachesState) counts.undrivenReachingState += 1;
          else counts.undrivenReachingNeither += 1;
        }
        if (drawn.pivotKind === 'sources') counts.pivotOnSources += 1;
        else counts.pivotOnState += 1;
      }),
      propertyParameters(),
    );

    // NON-VACUITY. The first three rows are what make this a precedence test: an undriven port that
    // reaches nothing would be refused by clause 5 whatever the clause order, so a run that only
    // ever drew that shape would prove nothing. The last two rows are the paired half, which must
    // have pivoted on BOTH classifying clauses.
    expect(
      Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value > 0])),
    ).toEqual({
      undrivenReachingADataInput: true,
      undrivenReachingState: true,
      undrivenReachingBoth: true,
      undrivenReachingNeither: true,
      pivotOnSources: true,
      pivotOnState: true,
    });
  });
});
