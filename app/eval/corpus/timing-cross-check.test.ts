// Unit tests for the both-direction ratchet comparator (task 1.5).
//
// The manifest is a four-entry FIXTURE rather than the committed one: this file pins
// the comparator's behaviour, and the committed manifest's own totality is Property 18
// (task 1.2). Shapes are borrowed from real corpus designs so the rows read honestly -
// `fsm/MATCH` is the Mealy combinational port, `alu/carry` one of the three undriven
// ports the manifest records as `refused`.

import { describe, expect, it } from 'vitest';

import {
  assembleCrossCheckReport,
  compareDerivedTiming,
  type DerivedPortResult,
  type TimingPortComparison,
  type TimingWitnessRow,
} from './timing-cross-check.js';
import type { TimingGroundTruthEntry } from './timing-ground-truth.js';
import type { TimingPopulationSummary } from './timing-populations.js';

const MANIFEST: readonly TimingGroundTruthEntry[] = Object.freeze([
  {
    design: 'fsm',
    port: 'MATCH',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'Mealy: reads the data input IN directly in always @(*).',
  },
  {
    design: 'accu',
    port: 'data_out',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'data_in reaches it only through the posedge accumulate flop.',
  },
  {
    design: 'traffic_light',
    port: 'clock',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'assign clock = cnt off the countdown register.',
  },
  {
    design: 'alu',
    port: 'carry',
    timing: 'combinational',
    expected: 'refused',
    rationale: 'Declared but never assigned; undriven, and the design has no clock.',
  },
]);

/** The supplied results that make every manifest entry agree, i.e. the ratchet holding. */
const AGREEING: readonly DerivedPortResult[] = Object.freeze([
  { design: 'fsm', port: 'MATCH', derived: 'combinational' },
  { design: 'accu', port: 'data_out', derived: 'registered' },
  { design: 'traffic_light', port: 'clock', derived: 'registered' },
  { design: 'alu', port: 'carry', derived: 'refused' },
]);

/** `AGREEING` with the named pair's result replaced, so one row at a time is in play. */
function agreeingExcept(replacement: DerivedPortResult): DerivedPortResult[] {
  return AGREEING.map((result) =>
    result.design === replacement.design && result.port === replacement.port ? replacement : result,
  );
}

/** The single failure of a comparison, asserted to be the only one. */
function onlyFailure(results: readonly DerivedPortResult[]): TimingPortComparison {
  const { failures } = compareDerivedTiming(results, MANIFEST);
  expect(failures).toHaveLength(1);
  return failures[0] as TimingPortComparison;
}

describe('compareDerivedTiming - the agreeing case', () => {
  it('reports no failure when every port reproduces its manifest entry', () => {
    const result = compareDerivedTiming(AGREEING, MANIFEST);

    expect(result.failures).toEqual([]);
    expect(result.comparisons.map((row) => row.outcome)).toEqual([
      'AGREED',
      'AGREED',
      'AGREED',
      'REFUSAL_COVERED',
    ]);
  });

  it('returns one row per manifest entry, in manifest order', () => {
    const result = compareDerivedTiming(AGREEING, MANIFEST);

    expect(result.comparisons.map((row) => `${row.design}/${row.port}`)).toEqual([
      'fsm/MATCH',
      'accu/data_out',
      'traffic_light/clock',
      'alu/carry',
    ]);
  });
});

describe('compareDerivedTiming - direction 1, a port the manifest expects to agree', () => {
  it('fails a differing derived value, naming every manifest field', () => {
    const failure = onlyFailure(
      agreeingExcept({ design: 'traffic_light', port: 'clock', derived: 'combinational' }),
    );

    expect(failure).toEqual({
      design: 'traffic_light',
      port: 'clock',
      outcome: 'DISAGREED',
      derived: 'combinational',
      groundTruth: 'registered',
      expected: 'agrees',
      rationale: 'assign clock = cnt off the countdown register.',
    });
  });

  it('fails an unexpected refusal, recording the refusal rather than a value', () => {
    const failure = onlyFailure(
      agreeingExcept({ design: 'accu', port: 'data_out', derived: 'refused' }),
    );

    expect(failure.outcome).toBe('UNEXPECTED_REFUSAL');
    expect(failure.derived).toBe('refused');
    expect(failure.groundTruth).toBe('registered');
    expect(failure.expected).toBe('agrees');
    expect(failure.rationale).toContain('posedge accumulate flop');
  });
});

describe('compareDerivedTiming - direction 2, a port the manifest records as refused', () => {
  it('fails a port that starts being classified, so the manifest stays a pin', () => {
    const failure = onlyFailure(
      agreeingExcept({ design: 'alu', port: 'carry', derived: 'combinational' }),
    );

    expect(failure).toEqual({
      design: 'alu',
      port: 'carry',
      outcome: 'UNEXPECTED_AGREEMENT',
      derived: 'combinational',
      groundTruth: 'combinational',
      expected: 'refused',
      rationale: 'Declared but never assigned; undriven, and the design has no clock.',
    });
  });
});

describe('compareDerivedTiming - what is neither a comparison nor a pass', () => {
  it('fails a derived result for a pair the manifest does not carry', () => {
    const failure = onlyFailure([
      ...AGREEING,
      { design: 'alu', port: 'negative', derived: 'combinational' },
    ]);

    expect(failure).toEqual({
      design: 'alu',
      port: 'negative',
      outcome: 'UNKNOWN_PORT',
      derived: 'combinational',
      groundTruth: null,
      expected: null,
      rationale: null,
    });
  });

  it('fails a manifest entry no supplied result covers, because an unchecked pin is not a passed pin', () => {
    const failure = onlyFailure(AGREEING.filter((result) => result.design !== 'fsm'));

    expect(failure).toEqual({
      design: 'fsm',
      port: 'MATCH',
      outcome: 'MISSING_RESULT',
      derived: null,
      groundTruth: 'combinational',
      expected: 'agrees',
      rationale: 'Mealy: reads the data input IN directly in always @(*).',
    });
  });

  it('fails a pair two supplied results disagree about, rather than taking the first', () => {
    const failure = onlyFailure([
      ...AGREEING,
      { design: 'accu', port: 'data_out', derived: 'combinational' },
    ]);

    expect(failure.outcome).toBe('CONFLICTING_RESULT');
    expect(failure.design).toBe('accu');
    expect(failure.port).toBe('data_out');
    expect(failure.rationale).toContain('posedge accumulate flop');
  });
});

// Unit test for task 12.1's `assembleCrossCheckReport`.
//
// A second fixed manifest/derived pair, distinct from `MANIFEST`/`AGREEING` above: this one
// is built to pin all six published figures at once, which needs at least one `DISAGREED`
// row in EACH direction and a mix of clocked and clockless designs so the two clocked-class
// figures are non-trivial (an all-clocked fixture could not catch a clockless row leaking in).

const REPORT_MANIFEST: readonly TimingGroundTruthEntry[] = Object.freeze([
  {
    design: 'fsm',
    port: 'MATCH',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'Mealy: reads the data input IN directly in always @(*).',
  },
  {
    design: 'accu',
    port: 'data_out',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'data_in reaches it only through the posedge accumulate flop.',
  },
  {
    design: 'traffic_light',
    port: 'clock',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'assign clock = cnt off the countdown register.',
  },
  {
    design: 'alu',
    port: 'carry',
    timing: 'combinational',
    expected: 'refused',
    rationale: 'Declared but never assigned; undriven, and the design has no clock.',
  },
  {
    design: 'pulse_detect',
    port: 'data_out',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'always @(*) reads the data input as (pulse_level1 == s2 && data_in == 0).',
  },
  {
    design: 'radix2_div',
    port: 'res_valid',
    timing: 'registered',
    expected: 'agrees',
    rationale: 'Flopped on posedge clk off cnt[3] and data_go, no data input reaches it.',
  },
  {
    design: 'adder_8bit',
    port: 'sum',
    timing: 'combinational',
    expected: 'agrees',
    rationale: 'Ripple chain of full_adder instances, each a single assign off a, b, cin.',
  },
]);

/**
 * Derived results producing: four `AGREED` rows (one over a clockless design), one
 * `REFUSAL_COVERED`, one `DISAGREED` derived `registered` against a `combinational`
 * truth, and one `DISAGREED` derived `combinational` against a `registered` truth.
 */
const REPORT_RESULTS: readonly DerivedPortResult[] = Object.freeze([
  { design: 'fsm', port: 'MATCH', derived: 'combinational' },
  { design: 'accu', port: 'data_out', derived: 'registered' },
  { design: 'traffic_light', port: 'clock', derived: 'registered' },
  { design: 'alu', port: 'carry', derived: 'refused' },
  { design: 'pulse_detect', port: 'data_out', derived: 'registered' },
  { design: 'radix2_div', port: 'res_valid', derived: 'combinational' },
  { design: 'adder_8bit', port: 'sum', derived: 'combinational' },
]);

/** A population summary fixture; its figures are opaque to this test, only pass-through matters. */
const POPULATIONS: TimingPopulationSummary = Object.freeze({
  sourceUniverse: 50,
  derivationPopulation: 48,
  derivedContracts: 44,
  derivationExclusions: Object.freeze([{ design: 'clkgenerator', cause: 'stage0-quarantined' }]),
  scoringCohort: 46,
  timingAwareScoringCohort: 43,
});

// Unit tests for task 12.5's `witnesses` rows, run against the real committed manifest
// (the `manifest` parameter is omitted) so the three cases exercise the actual
// Mandatory_Witness port sets rather than a reconstructed fixture.

/** The named witness's row, asserted to be present (buildWitnessRows always returns one per design). */
function witnessRow(
  report: ReturnType<typeof assembleCrossCheckReport>,
  design: string,
): TimingWitnessRow {
  const row = report.witnesses.find((w) => w.design === design);
  if (row === undefined) throw new Error(`no witness row for ${design}`);
  return row;
}

describe('assembleCrossCheckReport - Mandatory_Witness rows (task 12.5)', () => {
  it('collapses radix2_div when both its ports derive the same value despite differing truth', () => {
    const result = compareDerivedTiming([
      // Ground_Truth differs (res_valid registered, result combinational); deriving
      // 'registered' for both is the collapse this detector exists to catch.
      { design: 'radix2_div', port: 'res_valid', derived: 'registered' },
      { design: 'radix2_div', port: 'result', derived: 'registered' },
    ]);
    const report = assembleCrossCheckReport(result, EMPTY_POPULATIONS);

    const radix2Div = witnessRow(report, 'radix2_div');
    expect(radix2Div.collapsed).toBe(true);
    expect(radix2Div.unproven).toBeNull();
  });

  it('does not collapse radix2_div when its ports derive their differing truth correctly', () => {
    const result = compareDerivedTiming([
      { design: 'radix2_div', port: 'res_valid', derived: 'registered' },
      { design: 'radix2_div', port: 'result', derived: 'combinational' },
    ]);
    const report = assembleCrossCheckReport(result, EMPTY_POPULATIONS);

    const radix2Div = witnessRow(report, 'radix2_div');
    expect(radix2Div.collapsed).toBe(false);
    expect(radix2Div.unproven).toBeNull();
    expect(radix2Div.ports).toEqual([
      { port: 'res_valid', derived: 'registered', groundTruth: 'registered' },
      { port: 'result', derived: 'combinational', groundTruth: 'combinational' },
    ]);
  });

  it('is structurally non-collapsing on traffic_light and fsm, whose own ports share one truth', () => {
    const result = compareDerivedTiming([
      { design: 'traffic_light', port: 'clock', derived: 'registered' },
      { design: 'traffic_light', port: 'red', derived: 'registered' },
      { design: 'traffic_light', port: 'yellow', derived: 'registered' },
      { design: 'traffic_light', port: 'green', derived: 'registered' },
      { design: 'fsm', port: 'MATCH', derived: 'combinational' },
    ]);
    const report = assembleCrossCheckReport(result, EMPTY_POPULATIONS);

    expect(witnessRow(report, 'traffic_light').collapsed).toBe(false);
    expect(witnessRow(report, 'fsm').collapsed).toBe(false);
  });

  it('labels an unanalysable witness UNPROVEN rather than omitting its row', () => {
    // fsm's one declared port, MATCH, is simply never supplied: MISSING_RESULT.
    const result = compareDerivedTiming([
      { design: 'radix2_div', port: 'res_valid', derived: 'registered' },
      { design: 'radix2_div', port: 'result', derived: 'combinational' },
      { design: 'traffic_light', port: 'clock', derived: 'registered' },
      { design: 'traffic_light', port: 'red', derived: 'registered' },
      { design: 'traffic_light', port: 'yellow', derived: 'registered' },
      { design: 'traffic_light', port: 'green', derived: 'registered' },
    ]);
    const report = assembleCrossCheckReport(result, EMPTY_POPULATIONS);

    const fsm = witnessRow(report, 'fsm');
    expect(fsm.unproven).toBe('incomplete-coverage (Requirement 6.7 UNPROVEN)');
    expect(fsm.collapsed).toBe(false);
    // Still a real row, not omitted (Req 6.10).
    expect(report.witnesses).toHaveLength(3);
  });
});

const EMPTY_POPULATIONS: TimingPopulationSummary = Object.freeze({
  sourceUniverse: 50,
  derivationPopulation: 48,
  derivedContracts: 0,
  derivationExclusions: [],
  scoringCohort: 46,
  timingAwareScoringCohort: 43,
});

describe('assembleCrossCheckReport', () => {
  it('pins all six figures plus the pass-through populations object', () => {
    const result = compareDerivedTiming(REPORT_RESULTS, REPORT_MANIFEST);

    expect(assembleCrossCheckReport(result, POPULATIONS)).toEqual({
      // fsm, accu, traffic_light, adder_8bit all AGREED.
      agreeing: 4,
      // pulse_detect and radix2_div both DISAGREED, one in each direction.
      disagreeing: 2,
      refusalCovered: 1,
      // pulse_detect: derived registered, manifest combinational.
      falseRegistered: 1,
      // radix2_div: derived combinational, manifest registered.
      falseCombinational: 1,
      // Clocked + groundTruth combinational: fsm (AGREED) and pulse_detect (DISAGREED).
      // adder_8bit is clockless and excluded despite also being groundTruth combinational.
      clockedGroundTruthCombinational: { agreeing: 1, total: 2 },
      // Clocked + groundTruth registered: accu, traffic_light (AGREED) and radix2_div (DISAGREED).
      clockedGroundTruthRegistered: { agreeing: 2, total: 3 },
      populations: POPULATIONS,
      disagreements: [
        {
          design: 'pulse_detect',
          port: 'data_out',
          derived: 'registered',
          groundTruth: 'combinational',
          rationale: 'always @(*) reads the data input as (pulse_level1 == s2 && data_in == 0).',
        },
        {
          design: 'radix2_div',
          port: 'res_valid',
          derived: 'combinational',
          groundTruth: 'registered',
          rationale: 'Flopped on posedge clk off cnt[3] and data_go, no data input reaches it.',
        },
      ],
      // REPORT_MANIFEST declares exactly one port per witness design here (the full
      // committed manifest declares radix2_div's second port, `result`, too); every
      // declared port is cleanly classified, so none of the three is UNPROVEN.
      witnesses: [
        {
          design: 'radix2_div',
          ports: [{ port: 'res_valid', derived: 'combinational', groundTruth: 'registered' }],
          collapsed: false,
          unproven: null,
        },
        {
          design: 'traffic_light',
          ports: [{ port: 'clock', derived: 'registered', groundTruth: 'registered' }],
          collapsed: false,
          unproven: null,
        },
        {
          design: 'fsm',
          ports: [{ port: 'MATCH', derived: 'combinational', groundTruth: 'combinational' }],
          collapsed: false,
          unproven: null,
        },
      ],
    });
  });
});
