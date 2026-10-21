// **Feature: timing-contract-inference, Property 11: The imported Spec carries the derived contract unchanged**
//
// THE ORACLE: THE PORT'S OWN RETURN VALUE
//   The injected `TimingDerivationPort` records the contract it returned for each design, and the
//   imported Spec's `timingContract` is compared against that recording entry for entry and IN
//   ORDER. Order is the stronger true claim here, not a guess: `makeTimingContract` returns
//   `{ entries: declared }` unsorted and the importer passes that value straight into `buildSpec`,
//   so a re-sort or a rebuild would be a real change and is asserted against.
//
// WHY "NOT ALL-REGISTERED" IS THE DECISIVE CLAUSE
//   The defect this feature removes is a `buildTimingContract` that mapped every declared output
//   port to `registered` with no inference at all. A property asserting only "the contract equals
//   what the port returned" would still pass on a reinstated fabrication whenever the drawn
//   contract happened to be all-`registered`. So each design is drawn as either a UNIFORM or a
//   MIXED contract, and a mixed draw must arrive in the Spec carrying BOTH values. That is the
//   draw a fabricated constant cannot survive, which is why the mixed count is required non-zero
//   below rather than left to the seed.
//
// WHY THIS FILE CARRIES ITS OWN FAKE PORT
//   `FixedTimingDerivation` places every output port at ONE caller-named timing, so it cannot
//   express a mixed contract. Widening the shared double would push a per-port plan onto the many
//   suites that want nothing but a stand-in, so the planned double lives here, where the mix is
//   the point.
//
// THE REFUSAL COMPLEMENT
//   Each draw is imported a SECOND time through `RefusingTimingDerivation` over the same checkout.
//   A refused design must reach no Spec at all - it is quarantined `TIMING_UNDERIVABLE` and still
//   counted in `designsSeen` - so there is no path on which a refusal becomes a filled-in contract.
//
// GENERATOR OBLIGATIONS
//   Designs declare one to four output ports (a mixed draw at least two, or its own assertion would
//   be unsatisfiable), the entry order is a drawn permutation of them, and uniform draws range over
//   both timings so the all-`registered` shape is exercised alongside the mixed one. Mixed,
//   uniform, all-`registered`, multi-output, and reordered draws are each counted and each required
//   non-zero.
//
// Validates: Requirements 3.1, 3.7

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  makeTimingContract,
  type ModuleInterface,
  type PortTiming,
  type Result,
  type TimingContract,
} from '@app/core';
import {
  importRtllmCorpus,
  RefusingTimingDerivation,
  type CorpusCheckoutPort,
  type TimingDerivationPort,
} from '@app/eval';
import type { TimingRefusal } from '@app/tools';

import { ASCII_IDENT_CHARS, stringFromChars } from './generators/chars.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'timing-contract-inference, Property 11: The imported Spec carries the derived contract unchanged';

const TIMINGS: readonly PortTiming[] = ['registered', 'combinational'];

/** The one category and subcategory the fake checkout lays its designs out under. */
const CATEGORY = 'Arithmetic';
const SUBCATEGORY = 'Adder';

/** Whether a design's drawn contract places every output port at one timing, or mixes them. */
type Mix = 'uniform' | 'mixed';

/** One drawn design: its name, its output ports, each port's timing, and the reporting order. */
interface DesignPlan {
  readonly designName: string;
  readonly mix: Mix;
  readonly outputNames: readonly string[];
  /** Parallel to `outputNames`. */
  readonly timings: readonly PortTiming[];
  /** A permutation of `outputNames`' indices: the order the derivation reports its entries in. */
  readonly entryOrder: readonly number[];
}

/** One element of a generated array, failing loudly rather than widening to `undefined`. */
function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`the generator produced no element at index ${index}`);
  }
  return value;
}

/** One design folder's files, keyed by filename. */
type DesignFolder = Readonly<Record<string, string>>;

/**
 * An in-memory `CorpusCheckoutPort` over one subcategory of drawn designs.
 *
 * Mirrors the shape `locateDesigns` walks - `<Category>/<Subcategory>/<design>` - and nothing
 * else, so the whole import runs with no fetch and no disk.
 */
class PlannedCheckout implements CorpusCheckoutPort {
  readonly #designs: ReadonlyMap<string, DesignFolder>;

  constructor(designs: ReadonlyMap<string, DesignFolder>) {
    this.#designs = designs;
  }

  listDirectories(segments: readonly string[]): Promise<readonly string[]> {
    const [category, subcategory] = segments;
    if (category !== CATEGORY) {
      return Promise.resolve([]);
    }
    if (subcategory === undefined) {
      return Promise.resolve([SUBCATEGORY]);
    }
    return Promise.resolve(subcategory === SUBCATEGORY ? [...this.#designs.keys()].sort() : []);
  }

  listFiles(segments: readonly string[]): Promise<readonly string[]> {
    return Promise.resolve(Object.keys(this.#folder(segments) ?? {}).sort());
  }

  readTextFile(segments: readonly string[]): Promise<string | null> {
    const filename = segments[segments.length - 1];
    const folder = this.#folder(segments.slice(0, -1));
    if (folder === undefined || filename === undefined) {
      return Promise.resolve(null);
    }
    return Promise.resolve(folder[filename] ?? null);
  }

  /** The folder at `[category, subcategory, design]`, or undefined. */
  #folder(segments: readonly string[]): DesignFolder | undefined {
    const [category, subcategory, design] = segments;
    if (category !== CATEGORY || subcategory !== SUBCATEGORY || design === undefined) {
      return undefined;
    }
    return this.#designs.get(design);
  }
}

/**
 * A `TimingDerivationPort` returning one caller-planned, per-port contract per design.
 *
 * FOR THIS PROPERTY ONLY; it derives nothing from the design. The contract is built through
 * `makeTimingContract` against the interface the importer actually assembled, so a generator that
 * drifted from the importer's output ports throws here instead of weakening the comparison.
 */
class PlannedTimingDerivation implements TimingDerivationPort {
  readonly #plans: ReadonlyMap<string, DesignPlan>;
  readonly #returned = new Map<string, TimingContract>();

  constructor(plans: ReadonlyMap<string, DesignPlan>) {
    this.#plans = plans;
  }

  derive(request: {
    readonly moduleInterface: ModuleInterface;
  }): Promise<Result<TimingContract, TimingRefusal>> {
    const { moduleName } = request.moduleInterface;
    const plan = this.#plans.get(moduleName);
    if (plan === undefined) {
      throw new Error(`the importer asked for an unplanned module "${moduleName}"`);
    }
    const entries = plan.entryOrder.map((index) => ({
      portName: at(plan.outputNames, index),
      timing: at(plan.timings, index),
    }));
    const built = makeTimingContract(request.moduleInterface, entries);
    if (!built.ok) {
      throw new Error(
        `the planned contract does not fit the imported interface: ${built.error.message}`,
      );
    }
    this.#returned.set(moduleName, built.value);
    return Promise.resolve(built);
  }

  /** The contract this port returned for `moduleName`, or undefined if it was never asked. */
  returnedFor(moduleName: string): TimingContract | undefined {
    return this.#returned.get(moduleName);
  }
}

/** A description in the layout the importer's parser reads. */
function description(moduleName: string): string {
  return [
    'Please act as a professional verilog designer.',
    'Drive every declared output port.',
    'Module name:',
    `    ${moduleName}`,
    'Implementation:',
    'Do it well.',
    'Give me the complete code.',
    '',
  ].join('\n');
}

/** A minimal golden testbench mentioning `moduleName`, which the importer requires. */
function testbench(moduleName: string): string {
  return `module tb;\n  ${moduleName} dut ();\nendmodule\n`;
}

/**
 * The reference RTL for one plan, with the top carrying upstream's `verified_` prefix.
 *
 * Declares a real clock and reset so the importer's clock/reset split runs and is shown not to
 * disturb the contract; every output name carries an `o_` prefix, so no output can be read as the
 * clock or the reset.
 */
function reference(plan: DesignPlan): string {
  const ports = [
    'input clk',
    'input rst_n',
    'input din',
    ...plan.outputNames.map((name) => `output ${name}`),
  ];
  return `module verified_${plan.designName}\n(\n  ${ports.join(',\n  ')}\n);\nendmodule\n`;
}

/** The checkout folder for one plan. */
function designFolder(plan: DesignPlan): DesignFolder {
  return {
    'design_description.txt': description(plan.designName),
    'testbench.v': testbench(plan.designName),
    [`verified_${plan.designName}.v`]: reference(plan),
  };
}

/** Unique `o_`-prefixed output port names. */
function outputNamesArbitrary(count: number): fc.Arbitrary<string[]> {
  return fc.uniqueArray(
    stringFromChars(ASCII_IDENT_CHARS, 1, 4).map((suffix) => `o_${suffix}`),
    { minLength: count, maxLength: count },
  );
}

/** A permutation of `[0, count)`. */
function permutationArbitrary(count: number): fc.Arbitrary<number[]> {
  return fc.shuffledSubarray([...Array(count).keys()], { minLength: count, maxLength: count });
}

/** Two distinct indices of `[0, count)`, or an empty pair when there are not two to draw. */
function indexPairArbitrary(count: number): fc.Arbitrary<number[]> {
  return count < 2
    ? fc.constant([])
    : fc.shuffledSubarray([...Array(count).keys()], { minLength: 2, maxLength: 2 });
}

/** The raw per-design draw, before the mix is applied to it. */
interface DrawnDesign {
  readonly outputNames: readonly string[];
  readonly drawnTimings: readonly PortTiming[];
  readonly forcedPair: readonly number[];
  readonly entryOrder: readonly number[];
}

/**
 * Each output port's timing under the drawn mix.
 *
 * A uniform draw flattens to the first drawn timing, so both all-`registered` and
 * all-`combinational` are reached. A mixed draw forces one drawn index to each value, which is
 * what makes the "not all-`registered`" assertion satisfiable rather than seed-dependent.
 */
function timingsFor(mix: Mix, drawn: DrawnDesign): readonly PortTiming[] {
  const first = at(drawn.drawnTimings, 0);
  if (mix === 'uniform') {
    return drawn.drawnTimings.map(() => first);
  }
  const timings = [...drawn.drawnTimings];
  timings[at(drawn.forcedPair, 0)] = 'combinational';
  timings[at(drawn.forcedPair, 1)] = 'registered';
  return timings;
}

/** One design's plan. `designName` is a placeholder the checkout generator replaces by index. */
function designPlanArbitrary(): fc.Arbitrary<DesignPlan> {
  return fc.constantFrom<Mix>('uniform', 'mixed').chain((mix) =>
    fc.integer({ min: mix === 'mixed' ? 2 : 1, max: 4 }).chain((outputCount) =>
      fc
        .record<DrawnDesign>({
          outputNames: outputNamesArbitrary(outputCount),
          drawnTimings: fc.array(fc.constantFrom(...TIMINGS), {
            minLength: outputCount,
            maxLength: outputCount,
          }),
          forcedPair: indexPairArbitrary(outputCount),
          entryOrder: permutationArbitrary(outputCount),
        })
        .map((drawn) => ({
          designName: 'unnamed',
          mix,
          outputNames: drawn.outputNames,
          timings: timingsFor(mix, drawn),
          entryOrder: drawn.entryOrder,
        })),
    ),
  );
}

/** One to three designs, named by position so no two folders collide. */
function checkoutArbitrary(): fc.Arbitrary<readonly DesignPlan[]> {
  return fc
    .array(designPlanArbitrary(), { minLength: 1, maxLength: 3 })
    .map((plans) => plans.map((plan, index) => ({ ...plan, designName: `des_${index}` })));
}

/** The counts that keep each decisive draw shape from going unexercised. */
interface Coverage {
  mixed: number;
  uniform: number;
  allRegistered: number;
  multiOutput: number;
  reordered: number;
}

/** Record one plan's shape against the coverage counters. */
function countDraw(coverage: Coverage, plan: DesignPlan): void {
  if (plan.mix === 'mixed') {
    coverage.mixed += 1;
  } else {
    coverage.uniform += 1;
  }
  if (plan.timings.every((timing) => timing === 'registered')) {
    coverage.allRegistered += 1;
  }
  if (plan.outputNames.length > 1) {
    coverage.multiOutput += 1;
  }
  if (plan.entryOrder.some((index, position) => index !== position)) {
    coverage.reordered += 1;
  }
}

/** The declared output port names of an imported interface, in declaration order. */
function declaredOutputNames(moduleInterface: ModuleInterface): readonly string[] {
  return moduleInterface.ports
    .filter((port) => port.direction === 'output')
    .map((port) => port.name);
}

/** The timing the imported contract records for one port, or null when it records none. */
function recordedTiming(contract: TimingContract, portName: string): PortTiming | null {
  return contract.entries.find((entry) => entry.portName === portName)?.timing ?? null;
}

/** The refusal the complement half of each draw imports under. */
const REFUSAL: TimingRefusal = { cause: 'undriven-output-port', ports: ['o_a'] };

describe(PROPERTY, () => {
  it('carries every derived per-port value into the Spec unchanged, and a refusal into no Spec at all', async () => {
    const coverage: Coverage = {
      mixed: 0,
      uniform: 0,
      allRegistered: 0,
      multiOutput: 0,
      reordered: 0,
    };

    await fc.assert(
      fc.asyncProperty(checkoutArbitrary(), async (plans) => {
        const folders = new Map(plans.map((plan) => [plan.designName, designFolder(plan)]));
        const planByModule = new Map(plans.map((plan) => [plan.designName, plan]));
        const derivation = new PlannedTimingDerivation(planByModule);

        const corpus = await importRtllmCorpus(new PlannedCheckout(folders), derivation);

        // Every drawn design converts, so nothing below is asserted over an empty corpus.
        expect(corpus.quarantined).toEqual([]);
        expect(corpus.problems).toHaveLength(plans.length);

        for (const problem of corpus.problems) {
          const { moduleInterface, timingContract } = problem.spec;
          const plan = planByModule.get(moduleInterface.moduleName);
          const returned = derivation.returnedFor(moduleInterface.moduleName);
          expect(plan).toBeDefined();
          expect(returned).toBeDefined();
          if (plan === undefined || returned === undefined) {
            return;
          }

          // UNCHANGED: entry for entry and in the order the port reported them.
          expect(timingContract).toEqual(returned);

          // Req 3.7: one entry per declared output port, each port's value its own.
          const outputNames = declaredOutputNames(moduleInterface);
          expect([...outputNames].sort()).toEqual([...plan.outputNames].sort());
          expect(timingContract.entries).toHaveLength(outputNames.length);
          for (const [index, portName] of plan.outputNames.entries()) {
            expect(recordedTiming(timingContract, portName)).toBe(at(plan.timings, index));
          }

          // THE DECISIVE CLAUSE: a mixed derivation reaches the Spec mixed, so the contract is not
          // the all-`registered` constant the importer used to fabricate.
          const recorded = new Set(timingContract.entries.map((entry) => entry.timing));
          expect(recorded).toEqual(new Set(plan.timings));
          if (plan.mix === 'mixed') {
            expect(recorded).toEqual(new Set<PortTiming>(['combinational', 'registered']));
          }

          countDraw(coverage, plan);
        }

        // THE COMPLEMENT: the same designs under a refusing port reach no Spec, so no refused
        // design can carry a filled-in contract.
        const refused = await importRtllmCorpus(
          new PlannedCheckout(folders),
          new RefusingTimingDerivation(REFUSAL),
        );
        expect(refused.problems).toEqual([]);
        expect(refused.quarantined.map((record) => record.code)).toEqual(
          plans.map(() => 'TIMING_UNDERIVABLE'),
        );
        expect(refused.designsSeen).toBe(plans.length);
      }),
      propertyParameters(),
    );

    // NON-VACUITY: without a mixed draw the decisive clause proves nothing, and without an
    // all-`registered` draw the fabrication it replaces would not have been exercised at all.
    expect({
      mixed: coverage.mixed > 0,
      uniform: coverage.uniform > 0,
      allRegistered: coverage.allRegistered > 0,
      multiOutput: coverage.multiOutput > 0,
      reordered: coverage.reordered > 0,
    }).toEqual({
      mixed: true,
      uniform: true,
      allRegistered: true,
      multiOutput: true,
      reordered: true,
    });
  });
});
