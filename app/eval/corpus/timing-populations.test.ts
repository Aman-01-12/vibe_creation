// Unit tests for the five named populations (task 1.3).
//
// The measured figures are written as literals HERE, in the test, deliberately: the
// module computes them from membership, and this file is the pin that says what the
// computation must come out to. The reconciliation property lands in task 1.4.

import { describe, expect, it } from 'vitest';

import { RTLLM_EXPECTED_DESIGN_COUNT } from './pinned-source.js';
import { RTLLM_SCORED_DESIGN_COUNT, STAGE0_QUARANTINED_PROBLEM_IDS } from './stage0-quarantine.js';
import {
  DERIVABLE_SCORING_COHORT_SIZE,
  DERIVATION_POPULATION_SIZE,
  inDerivableScoringCohort,
  SCORING_COHORT_SIZE,
  SOURCE_UNIVERSE_SIZE,
  summarizeTimingPopulations,
  type DesignDerivationOutcome,
} from './timing-populations.js';

const ALU = 'rtllm/miscellaneous/alu';
const CLKGENERATOR = 'rtllm/miscellaneous/clkgenerator';
const RADIX2_DIV = 'rtllm/arithmetic/radix2_div';
const SYNCHRONIZER = 'rtllm/miscellaneous/synchronizer';
const ADDER_8BIT = 'rtllm/arithmetic/adder_8bit';
const FSM = 'rtllm/control/fsm';

/** `alu` refuses, `radix2_div` refuses outside the Scoring_Cohort, two derive. */
const OUTCOMES: readonly DesignDerivationOutcome[] = Object.freeze([
  { problemId: ADDER_8BIT, outcome: 'derived' },
  { problemId: FSM, outcome: 'derived' },
  { problemId: ALU, outcome: 'excluded', cause: 'UNDRIVEN_OUTPUT: carry, negative, overflow' },
  { problemId: RADIX2_DIV, outcome: 'excluded', cause: 'UNDRIVEN_OUTPUT: res_valid' },
]);

describe('the named population sizes', () => {
  it('matches the measured figures for all four committed populations', () => {
    expect(SOURCE_UNIVERSE_SIZE).toBe(50);
    expect(DERIVATION_POPULATION_SIZE).toBe(48);
    expect(SCORING_COHORT_SIZE).toBe(46);
    expect(DERIVABLE_SCORING_COHORT_SIZE).toBe(44);
  });

  it('keeps the Scoring_Cohort consistent with the Stage-0 list it is defined by', () => {
    // The fact that makes `clkgenerator` ALREADY outside the Scoring_Cohort: if these
    // ever diverge, subtracting a Stage-0 design again would stop being a no-op.
    expect(RTLLM_SCORED_DESIGN_COUNT).toBe(
      RTLLM_EXPECTED_DESIGN_COUNT - STAGE0_QUARANTINED_PROBLEM_IDS.length,
    );
  });

  it('places a Stage-0 design outside the Derivable_Scoring_Cohort and a derivable one inside', () => {
    expect(inDerivableScoringCohort(CLKGENERATOR)).toBe(false);
    expect(inDerivableScoringCohort(RADIX2_DIV)).toBe(false);
    expect(inDerivableScoringCohort(SYNCHRONIZER)).toBe(false);
    expect(inDerivableScoringCohort(ADDER_8BIT)).toBe(true);
  });
});

describe('summarizeTimingPopulations', () => {
  it('publishes the six figures over a fixed outcome set', () => {
    expect(summarizeTimingPopulations(OUTCOMES)).toEqual({
      sourceUniverse: 50,
      derivationPopulation: 48,
      derivedContracts: 2,
      derivationExclusions: [
        { design: 'alu', cause: 'UNDRIVEN_OUTPUT: carry, negative, overflow' },
        { design: 'radix2_div', cause: 'UNDRIVEN_OUTPUT: res_valid' },
      ],
      scoringCohort: 46,
      // 46 - 2 frontend-rejected - `alu`. `radix2_div` is already outside the cohort.
      timingAwareScoringCohort: 43,
    });
  });

  it('does not subtract an already-quarantined design a second time', () => {
    const withClkgenerator = summarizeTimingPopulations([
      ...OUTCOMES,
      { problemId: CLKGENERATOR, outcome: 'excluded', cause: 'UNDRIVEN_OUTPUT: clk' },
    ]);

    expect(withClkgenerator.timingAwareScoringCohort).toBe(43);
    expect(withClkgenerator.derivationExclusions).toHaveLength(3);
  });

  it('ignores an outcome for a design the frontend rejected', () => {
    const withSynchronizer = summarizeTimingPopulations([
      ...OUTCOMES,
      { problemId: SYNCHRONIZER, outcome: 'derived' },
    ]);

    expect(withSynchronizer.derivedContracts).toBe(2);
    expect(withSynchronizer.timingAwareScoringCohort).toBe(43);
  });

  it('excludes a design reported both ways rather than counting it derived', () => {
    const contradictory = summarizeTimingPopulations([
      { problemId: ALU, outcome: 'derived' },
      { problemId: ALU, outcome: 'excluded', cause: 'UNDRIVEN_OUTPUT: carry' },
    ]);

    expect(contradictory.derivedContracts).toBe(0);
    expect(contradictory.derivationExclusions).toEqual([
      { design: 'alu', cause: 'UNDRIVEN_OUTPUT: carry' },
    ]);
  });

  it('is total over an empty outcome set', () => {
    const empty = summarizeTimingPopulations([]);

    expect(empty.derivedContracts).toBe(0);
    expect(empty.derivationExclusions).toEqual([]);
    expect(empty.timingAwareScoringCohort).toBe(DERIVABLE_SCORING_COHORT_SIZE);
  });
});
