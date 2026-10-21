// **Feature: timing-contract-inference, Property 19: The cross-check counts partition the ports they cover**
// **Validates: Requirements 6.3, 6.4, 6.6**
//
// WHAT THIS ASSERTS, OVER THE AGGREGATION ALONE
//   `assembleCrossCheckReport` is exercised directly on hand-built `TimingPortComparison[]`
//   arrays, never through `compareDerivedTiming`: the partition claim is about how the six
//   figures are COUNTED from rows, not about how rows get produced, so routing every case
//   through the comparator would just be re-deriving its own classification table inside the
//   generator. Four partitions are checked:
//     1. `agreeing + disagreeing + refusalCovered` equals the count of `AGREED` / `DISAGREED` /
//        `REFUSAL_COVERED` rows combined - no double count, no overlap between the three.
//     2. `falseRegistered + falseCombinational` equals `disagreeing` exactly (the two directions
//        of a `DISAGREED` row partition it).
//     3. The two clocked-class `.total` figures sum to exactly the CLOCKED `AGREED`/`DISAGREED`
//        rows - no clocked covered row falls into neither figure or into both.
//     4. Each clocked figure's `agreeing <= total`.
//
// GENERATOR OBLIGATIONS, WHICH DECIDE VACUITY
//   Every `TimingComparisonOutcome` arm, every `derived` kind (`registered`, `combinational`,
//   `refused`), a mix of clocked and clockless design names, both `groundTruth` values, and a
//   `DISAGREED` row in EACH direction must all appear somewhere across the run - tracked in
//   mutable sets/counters outside `fc.property` and asserted non-zero afterward, the same
//   pattern `timing-ground-truth-manifest.property.test.ts` uses. Without both DISAGREED
//   directions, claim 2 would hold by one side always being zero.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  assembleCrossCheckReport,
  type TimingComparisonOutcome,
  type TimingPortComparison,
  type TimingRatchetResult,
} from '../eval/corpus/timing-cross-check.js';
import type { TimingPopulationSummary } from '../eval/corpus/timing-populations.js';

import { propertyParameters } from './property.js';

const PROPERTY =
  'Feature: timing-contract-inference, Property 19: The cross-check counts partition the ports they cover';

/**
 * Copied from `timing-cross-check.ts`'s own (unexported) `CLOCKLESS_DESIGNS`, for generation
 * only - this file does not call `isClockedDesign`, so it keeps its own mirror to decide which
 * generated design names are clockless.
 */
const CLOCKLESS_DESIGN_NAMES = [
  'adder_8bit',
  'adder_16bit',
  'adder_32bit',
  'adder_bcd',
  'comparator_3bit',
  'comparator_4bit',
  'div_16bit',
  'multi_8bit',
  'fixed_point_adder',
  'fixed_point_substractor',
  'sub_64bit',
  'barrel_shifter',
  'ROM',
  'alu',
] as const;

/** Invented clocked design names, distinct from the clockless list above. */
const CLOCKED_DESIGN_NAMES = [
  'fsm',
  'accu',
  'traffic_light',
  'pulse_detect',
  'radix2_div',
] as const;

const CLOCKLESS_SET: ReadonlySet<string> = new Set(CLOCKLESS_DESIGN_NAMES);

function isClocked(design: string): boolean {
  return !CLOCKLESS_SET.has(design);
}

function designArbitrary(): fc.Arbitrary<string> {
  return fc.constantFrom(...CLOCKLESS_DESIGN_NAMES, ...CLOCKED_DESIGN_NAMES);
}

function portArbitrary(): fc.Arbitrary<string> {
  return fc.string({ minLength: 1, maxLength: 8 });
}

const PORT_TIMINGS = ['registered', 'combinational'] as const;

function portTimingArbitrary(): fc.Arbitrary<'registered' | 'combinational'> {
  return fc.constantFrom(...PORT_TIMINGS);
}

/** `AGREED`: derived reproduces the manifest value exactly. */
function agreedRowArbitrary(): fc.Arbitrary<TimingPortComparison> {
  return fc
    .tuple(designArbitrary(), portArbitrary(), portTimingArbitrary())
    .map(([design, port, timing]) => ({
      design,
      port,
      outcome: 'AGREED' as const,
      derived: timing,
      groundTruth: timing,
      expected: 'agrees' as const,
      rationale: null,
    }));
}

/**
 * `DISAGREED`: derived differs from the manifest value, in EITHER direction - the pair drawn
 * from both orderings so the generator cannot favour one direction over the other.
 *
 * `rationale` is a non-null string, not `null`: task 12.3's `narrowDisagreement` throws on a
 * `DISAGREED` row with no rationale, since a real manifest entry always carries one.
 */
function disagreedRowArbitrary(): fc.Arbitrary<TimingPortComparison> {
  return fc
    .tuple(
      designArbitrary(),
      portArbitrary(),
      fc.constantFrom(
        ['registered', 'combinational'] as const,
        ['combinational', 'registered'] as const,
      ),
    )
    .map(([design, port, [derived, groundTruth]]) => ({
      design,
      port,
      outcome: 'DISAGREED' as const,
      derived,
      groundTruth,
      expected: 'agrees' as const,
      rationale: 'generated fixture rationale',
    }));
}

/** `REFUSAL_COVERED`: the manifest expects a refusal and the derivation refused. */
function refusalCoveredRowArbitrary(): fc.Arbitrary<TimingPortComparison> {
  return fc
    .tuple(designArbitrary(), portArbitrary(), portTimingArbitrary())
    .map(([design, port, groundTruth]) => ({
      design,
      port,
      outcome: 'REFUSAL_COVERED' as const,
      derived: 'refused' as const,
      groundTruth,
      expected: 'refused' as const,
      rationale: null,
    }));
}

/** `UNEXPECTED_REFUSAL`: expected to agree, the derivation refused instead. */
function unexpectedRefusalRowArbitrary(): fc.Arbitrary<TimingPortComparison> {
  return fc
    .tuple(designArbitrary(), portArbitrary(), portTimingArbitrary())
    .map(([design, port, groundTruth]) => ({
      design,
      port,
      outcome: 'UNEXPECTED_REFUSAL' as const,
      derived: 'refused' as const,
      groundTruth,
      expected: 'agrees' as const,
      rationale: null,
    }));
}

/** `UNEXPECTED_AGREEMENT`: the manifest records `refused` and the derivation classified it. */
function unexpectedAgreementRowArbitrary(): fc.Arbitrary<TimingPortComparison> {
  return fc
    .tuple(designArbitrary(), portArbitrary(), portTimingArbitrary(), portTimingArbitrary())
    .map(([design, port, derived, groundTruth]) => ({
      design,
      port,
      outcome: 'UNEXPECTED_AGREEMENT' as const,
      derived,
      groundTruth,
      expected: 'refused' as const,
      rationale: null,
    }));
}

/** `UNKNOWN_PORT`: a supplied result for a pair the manifest does not carry. */
function unknownPortRowArbitrary(): fc.Arbitrary<TimingPortComparison> {
  return fc
    .tuple(
      designArbitrary(),
      portArbitrary(),
      fc.oneof(portTimingArbitrary(), fc.constant('refused' as const)),
    )
    .map(([design, port, derived]) => ({
      design,
      port,
      outcome: 'UNKNOWN_PORT' as const,
      derived,
      groundTruth: null,
      expected: null,
      rationale: null,
    }));
}

/** `MISSING_RESULT`: a manifest entry no supplied result covers. */
function missingResultRowArbitrary(): fc.Arbitrary<TimingPortComparison> {
  return fc
    .tuple(designArbitrary(), portArbitrary(), portTimingArbitrary())
    .map(([design, port, groundTruth]) => ({
      design,
      port,
      outcome: 'MISSING_RESULT' as const,
      derived: null,
      groundTruth,
      expected: 'agrees' as const,
      rationale: null,
    }));
}

/** `CONFLICTING_RESULT`: two supplied results disagreed about one pair. */
function conflictingResultRowArbitrary(): fc.Arbitrary<TimingPortComparison> {
  return fc
    .tuple(designArbitrary(), portArbitrary(), portTimingArbitrary(), portTimingArbitrary())
    .map(([design, port, derived, groundTruth]) => ({
      design,
      port,
      outcome: 'CONFLICTING_RESULT' as const,
      derived,
      groundTruth,
      expected: 'agrees' as const,
      rationale: null,
    }));
}

function rowArbitrary(): fc.Arbitrary<TimingPortComparison> {
  return fc.oneof(
    agreedRowArbitrary(),
    disagreedRowArbitrary(),
    refusalCoveredRowArbitrary(),
    unexpectedRefusalRowArbitrary(),
    unexpectedAgreementRowArbitrary(),
    unknownPortRowArbitrary(),
    missingResultRowArbitrary(),
    conflictingResultRowArbitrary(),
  );
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

const COVERED_OUTCOMES: ReadonlySet<TimingComparisonOutcome> = new Set([
  'AGREED',
  'DISAGREED',
  'REFUSAL_COVERED',
]);

describe(PROPERTY, () => {
  it('partitions the covered count, the disagreement directions, and the two clocked-class figures', () => {
    const outcomesSeen = new Set<TimingComparisonOutcome>();
    const derivedKindsSeen = new Set<string>();
    const groundTruthsSeen = new Set<string>();
    let sawClockless = false;
    let sawClocked = false;
    let sawRegisteredOverCombinational = false;
    let sawCombinationalOverRegistered = false;

    fc.assert(
      fc.property(fc.array(rowArbitrary(), { minLength: 10, maxLength: 60 }), (rows) => {
        for (const row of rows) {
          outcomesSeen.add(row.outcome);
          if (row.derived !== null) derivedKindsSeen.add(row.derived);
          if (row.groundTruth !== null) groundTruthsSeen.add(row.groundTruth);
          if (isClocked(row.design)) sawClocked = true;
          else sawClockless = true;
          if (
            row.outcome === 'DISAGREED' &&
            row.derived === 'registered' &&
            row.groundTruth === 'combinational'
          ) {
            sawRegisteredOverCombinational = true;
          }
          if (
            row.outcome === 'DISAGREED' &&
            row.derived === 'combinational' &&
            row.groundTruth === 'registered'
          ) {
            sawCombinationalOverRegistered = true;
          }
        }

        const result: TimingRatchetResult = { comparisons: rows, failures: [] };
        const report = assembleCrossCheckReport(result, POPULATIONS);

        // Claim 1: the three covered counts partition the AGREED/DISAGREED/REFUSAL_COVERED rows.
        const coveredCount = rows.filter((row) => COVERED_OUTCOMES.has(row.outcome)).length;
        expect(report.agreeing + report.disagreeing + report.refusalCovered).toBe(coveredCount);

        // Claim 2: the two disagreement directions partition `disagreeing` exactly.
        expect(report.falseRegistered + report.falseCombinational).toBe(report.disagreeing);

        // Claim 3: the two clocked-class totals partition the clocked AGREED/DISAGREED rows.
        const clockedCoveredCount = rows.filter(
          (row) =>
            (row.outcome === 'AGREED' || row.outcome === 'DISAGREED') && isClocked(row.design),
        ).length;
        expect(
          report.clockedGroundTruthCombinational.total + report.clockedGroundTruthRegistered.total,
        ).toBe(clockedCoveredCount);

        // Claim 4: each clocked figure's agreement count cannot exceed its own total.
        expect(report.clockedGroundTruthCombinational.agreeing).toBeLessThanOrEqual(
          report.clockedGroundTruthCombinational.total,
        );
        expect(report.clockedGroundTruthRegistered.agreeing).toBeLessThanOrEqual(
          report.clockedGroundTruthRegistered.total,
        );
      }),
      propertyParameters(),
    );

    // NON-VACUITY: every outcome, every derived kind, both ground-truth values, both clocked
    // classes, and a DISAGREED row in each direction were all exercised somewhere in the run.
    expect([...outcomesSeen].sort()).toEqual(
      [
        'AGREED',
        'CONFLICTING_RESULT',
        'DISAGREED',
        'MISSING_RESULT',
        'REFUSAL_COVERED',
        'UNEXPECTED_AGREEMENT',
        'UNEXPECTED_REFUSAL',
        'UNKNOWN_PORT',
      ].sort(),
    );
    expect([...derivedKindsSeen].sort()).toEqual(['combinational', 'refused', 'registered']);
    expect([...groundTruthsSeen].sort()).toEqual(['combinational', 'registered']);
    expect(sawClockless).toBe(true);
    expect(sawClocked).toBe(true);
    expect(sawRegisteredOverCombinational).toBe(true);
    expect(sawCombinationalOverRegistered).toBe(true);
  });
});
