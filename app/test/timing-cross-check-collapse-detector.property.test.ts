// **Feature: timing-contract-inference, Property 21: A collapsed witness fails the check**
// **Validates: Requirements 6.9**
//
// WHAT THIS ASSERTS, OVER THE AGGREGATION ALONE
//   `assembleCrossCheckReport` is exercised directly on hand-built `TimingPortComparison[]`
//   rows for one Mandatory_Witness design at a time, never through `compareDerivedTiming`:
//   the collapse claim is about how `buildWitnessRow` reads a witness's OWN rows, not about
//   how rows get produced, and routing every draw through the comparator would just be
//   re-deriving its own classification table inside the generator (same rationale Property
//   19 and 20's files give). Every drawn port is kept ANALYSABLE (outcome AGREED, DISAGREED,
//   or UNEXPECTED_REFUSAL, never one of the three unanalysable outcomes), so the property
//   isolates the collapse clause from the separate UNPROVEN path task 12.5's own unit test
//   already covers.
//
//   For a witness's set of declared output ports, `collapsed` is true EXACTLY when the
//   Ground_Truth values across those ports are not all identical AND the derived values are
//   all identical. Three outcomes are checked against that formula on every draw:
//     1. Collapsed: Ground_Truth differs across ports, derived collapses to one value -
//        `collapsed` is true (the positive direction Requirement 6.9 names).
//     2. Not collapsed because derived does not collapse: Ground_Truth differs but the
//        derived values are not all the same - `collapsed` is false.
//     3. Not collapsed because Ground_Truth was already uniform: every port's Ground_Truth
//        is the same value, so there is nothing to collapse regardless of what was derived -
//        `collapsed` is false.
//   `unproven` stays `null` throughout, since every port is analysable.
//
// GENERATOR OBLIGATIONS, WHICH DECIDE VACUITY
//   One of the three real Mandatory_Witness design names is drawn (the detector is only ever
//   invoked on those three in production), with one to four ports whose Ground_Truth is drawn
//   from both `PortTiming` members and whose derived value is drawn from both `PortTiming`
//   members plus `'refused'`. All three outcomes above, and a draw where derived includes
//   `'refused'`, are tracked in mutable counters outside `fc.property` and asserted non-zero
//   afterward, the pattern `timing-cross-check-count-partition.property.test.ts` uses.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { PortTiming } from '@app/core';

import {
  assembleCrossCheckReport,
  type TimingPortComparison,
  type TimingRatchetResult,
} from '../eval/corpus/timing-cross-check.js';
import type { TimingPopulationSummary } from '../eval/corpus/timing-populations.js';

import { propertyParameters } from './property.js';

const PROPERTY =
  'Feature: timing-contract-inference, Property 21: A collapsed witness fails the check';

/** The three real Mandatory_Witness design names, mirrored from `timing-cross-check.ts`'s own (unexported) list. */
const WITNESS_DESIGNS = ['radix2_div', 'traffic_light', 'fsm'] as const;

const PORT_TIMINGS = ['registered', 'combinational'] as const;
const DERIVED_VALUES = ['registered', 'combinational', 'refused'] as const;

interface WitnessPortDraw {
  readonly groundTruth: PortTiming;
  readonly derived: PortTiming | 'refused';
}

function witnessPortDrawArbitrary(): fc.Arbitrary<WitnessPortDraw> {
  return fc
    .tuple(fc.constantFrom(...PORT_TIMINGS), fc.constantFrom(...DERIVED_VALUES))
    .map(([groundTruth, derived]) => ({ groundTruth, derived }));
}

/**
 * One analysable row for a witness's declared output port. Analysable means the outcome is
 * never one of the three `UNANALYSABLE_OUTCOMES` `buildWitnessRow` reads for: the `derived`
 * value always carries through to `TimingWitnessPort.derived` so the collapse formula sees it.
 *
 * `DISAGREED` carries a non-null `rationale`, because `assembleCrossCheckReport` narrows every
 * `DISAGREED` row through `narrowDisagreement`, which throws on a null one.
 */
function witnessPortRow(design: string, port: string, draw: WitnessPortDraw): TimingPortComparison {
  const { groundTruth, derived } = draw;
  if (derived === groundTruth) {
    return {
      design,
      port,
      outcome: 'AGREED',
      derived,
      groundTruth,
      expected: 'agrees',
      rationale: null,
    };
  }
  if (derived === 'refused') {
    return {
      design,
      port,
      outcome: 'UNEXPECTED_REFUSAL',
      derived,
      groundTruth,
      expected: 'agrees',
      rationale: null,
    };
  }
  return {
    design,
    port,
    outcome: 'DISAGREED',
    derived,
    groundTruth,
    expected: 'agrees',
    rationale: 'generated fixture rationale',
  };
}

/** Opaque to this property; only pass-through matters, as the 12.1 unit test already pins. */
const POPULATIONS: TimingPopulationSummary = Object.freeze({
  sourceUniverse: 50,
  derivationPopulation: 48,
  derivedContracts: 44,
  derivationExclusions: Object.freeze([]),
  scoringCohort: 46,
  timingAwareScoringCohort: 43,
});

describe(PROPERTY, () => {
  it('collapses a witness exactly when its ground truths differ and its derived values do not', () => {
    let sawCollapsed = false;
    let sawDifferingGroundTruthNotCollapsed = false;
    let sawUniformGroundTruthNotCollapsed = false;
    let sawRefusedDerived = false;

    fc.assert(
      fc.property(
        fc.constantFrom(...WITNESS_DESIGNS),
        fc.array(witnessPortDrawArbitrary(), { minLength: 1, maxLength: 4 }),
        (design, draws) => {
          const comparisons = draws.map((draw, index) =>
            witnessPortRow(design, `port${index}`, draw),
          );
          const result: TimingRatchetResult = { comparisons, failures: [] };
          const report = assembleCrossCheckReport(result, POPULATIONS);

          const row = report.witnesses.find((witness) => witness.design === design);
          if (row === undefined) throw new Error(`unreachable: no witness row for ${design}`);

          const groundTruths = new Set(draws.map((draw) => draw.groundTruth));
          const derivedValues = new Set(draws.map((draw) => draw.derived));
          const expectedCollapsed = groundTruths.size > 1 && derivedValues.size === 1;

          if (expectedCollapsed) sawCollapsed = true;
          else if (groundTruths.size > 1) sawDifferingGroundTruthNotCollapsed = true;
          else sawUniformGroundTruthNotCollapsed = true;
          if (draws.some((draw) => draw.derived === 'refused')) sawRefusedDerived = true;

          expect(row.unproven).toBeNull();
          expect(row.collapsed).toBe(expectedCollapsed);
        },
      ),
      propertyParameters(),
    );

    // NON-VACUITY: the collapsed case, both non-collapsed cases, and a refused-derived draw
    // were all exercised somewhere in the run.
    expect(sawCollapsed).toBe(true);
    expect(sawDifferingGroundTruthNotCollapsed).toBe(true);
    expect(sawUniformGroundTruthNotCollapsed).toBe(true);
    expect(sawRefusedDerived).toBe(true);
  });
});
