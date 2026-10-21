// **Feature: timing-contract-inference, Property 20: Every disagreement is fully named**
// **Validates: Requirements 6.5**
//
// WHAT THIS ASSERTS, OVER THE AGGREGATION ALONE
//   `assembleCrossCheckReport` is exercised directly on hand-built `TimingPortComparison[]`
//   arrays, never through `compareDerivedTiming`, same rationale as Property 19's file: the
//   naming claim is about how `disagreements` is BUILT from rows, not about how rows get
//   produced. Four claims are checked:
//     1. Completeness: `disagreements.length` equals the count of `DISAGREED` rows in the
//        input exactly - no drop, no duplicate.
//     2. Correspondence: every `DISAGREED` input row has a matching `disagreements` entry
//        carrying that row's exact `design`, `port`, `derived`, and `groundTruth`.
//     3. Each entry's `rationale` is a non-empty string - never `null`, never `''`.
//     4. Non-`DISAGREED` rows contribute nothing: `disagreements` never grows past the
//        `DISAGREED` count regardless of how many other-outcome rows accompany them.
//
// GENERATOR OBLIGATIONS, WHICH DECIDE VACUITY
//   `DISAGREED` rows in BOTH directions (`registered` over `combinational` and the reverse),
//   mixed with at least one row of a non-`DISAGREED` outcome, across several designs and port
//   names - tracked in mutable counters outside `fc.property` and asserted non-zero
//   afterward, the same pattern Property 19's file uses.

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
  'Feature: timing-contract-inference, Property 20: Every disagreement is fully named';

function designArbitrary(): fc.Arbitrary<string> {
  return fc.constantFrom(
    'fsm',
    'accu',
    'traffic_light',
    'pulse_detect',
    'radix2_div',
    'adder_8bit',
  );
}

function portArbitrary(): fc.Arbitrary<string> {
  return fc.string({ minLength: 1, maxLength: 8 });
}

const PORT_TIMINGS = ['registered', 'combinational'] as const;

function portTimingArbitrary(): fc.Arbitrary<'registered' | 'combinational'> {
  return fc.constantFrom(...PORT_TIMINGS);
}

/**
 * `DISAGREED`: derived differs from the manifest value, in EITHER direction - drawn from
 * both orderings so the generator cannot favour one direction over the other.
 *
 * `rationale` is a non-empty string, matching what a real manifest entry always carries
 * (the sole source `narrowDisagreement` reads it from).
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

/** `AGREED`: a non-`DISAGREED` row, to exercise claim 4 non-vacuously. */
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

/** `REFUSAL_COVERED`: another non-`DISAGREED` row, distinct shape from `AGREED`. */
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

/** `UNEXPECTED_REFUSAL`: another non-`DISAGREED` row, distinct shape again. */
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

function rowArbitrary(): fc.Arbitrary<TimingPortComparison> {
  return fc.oneof(
    disagreedRowArbitrary(),
    agreedRowArbitrary(),
    refusalCoveredRowArbitrary(),
    unexpectedRefusalRowArbitrary(),
  );
}

/** Opaque to this property; only pass-through matters. */
const POPULATIONS: TimingPopulationSummary = Object.freeze({
  sourceUniverse: 50,
  derivationPopulation: 48,
  derivedContracts: 44,
  derivationExclusions: Object.freeze([]),
  scoringCohort: 46,
  timingAwareScoringCohort: 43,
});

describe(PROPERTY, () => {
  it('names every disagreement with its design, port, derived value, ground truth, and rationale, and nothing else', () => {
    const outcomesSeen = new Set<TimingComparisonOutcome>();
    let sawRegisteredOverCombinational = false;
    let sawCombinationalOverRegistered = false;
    let sawNonDisagreedAlongsideDisagreed = false;

    fc.assert(
      fc.property(fc.array(rowArbitrary(), { minLength: 5, maxLength: 40 }), (rows) => {
        for (const row of rows) {
          outcomesSeen.add(row.outcome);
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
        const hasDisagreed = rows.some((row) => row.outcome === 'DISAGREED');
        const hasNonDisagreed = rows.some((row) => row.outcome !== 'DISAGREED');
        if (hasDisagreed && hasNonDisagreed) sawNonDisagreedAlongsideDisagreed = true;

        const result: TimingRatchetResult = { comparisons: rows, failures: [] };
        const report = assembleCrossCheckReport(result, POPULATIONS);
        const disagreedRows = rows.filter((row) => row.outcome === 'DISAGREED');

        // Claim 1: completeness - no drop, no duplicate.
        expect(report.disagreements.length).toBe(disagreedRows.length);

        // Claim 2: correspondence - every DISAGREED row has a matching entry with its exact
        // design/port/derived/groundTruth. Ports are not required to be unique across rows,
        // so match on the full field set rather than keying by design/port alone.
        for (const row of disagreedRows) {
          const match = report.disagreements.find(
            (entry) =>
              entry.design === row.design &&
              entry.port === row.port &&
              entry.derived === row.derived &&
              entry.groundTruth === row.groundTruth,
          );
          expect(match).toBeDefined();
        }

        // Claim 3: every entry's rationale is a non-empty string.
        for (const entry of report.disagreements) {
          expect(typeof entry.rationale).toBe('string');
          expect(entry.rationale.length).toBeGreaterThan(0);
        }

        // Claim 4: non-DISAGREED rows contribute nothing beyond the DISAGREED count.
        expect(report.disagreements.length).toBeLessThanOrEqual(rows.length);
        expect(report.disagreements.length).toBe(disagreedRows.length);
      }),
      propertyParameters(),
    );

    // NON-VACUITY: both DISAGREED directions and a non-DISAGREED row alongside them were all
    // exercised somewhere in the run.
    expect(outcomesSeen.has('DISAGREED')).toBe(true);
    expect(sawRegisteredOverCombinational).toBe(true);
    expect(sawCombinationalOverRegistered).toBe(true);
    expect(sawNonDisagreedAlongsideDisagreed).toBe(true);
  });
});
