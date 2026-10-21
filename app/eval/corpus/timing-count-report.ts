// The importer's inference count, published over a NAMED population.
//
// WHY THE COUNT NEVER TRAVELS ALONE
//   A count of derived Timing_Contracts says nothing without the population it is over
//   and the exclusions that left that population: otherwise apparent accuracy improves
//   merely because the hard cases disappeared from the denominator. So the report names
//   its population, carries that population's size, and publishes the six figures of
//   `summarizeTimingPopulations` in the same object (Req 3.4, 3.6).
//
//   Nothing here computes a population size. Every figure comes from the task 1.3
//   summary, which derives each one from membership over committed id sets, so this
//   module has no way to state a size that disagrees with it.
//
// WHY `clkgenerator` GETS NO CAUSE HERE
//   It is already one of the four committed Stage-0 entries, so `RTLLM_SCORED_DESIGN_COUNT`
//   has it outside the Scoring_Cohort before this feature runs. The report CITES those
//   entries instead of recording a second exclusion cause, which would subtract the design
//   twice (Req 3.3).

import type { QuarantinedDesign, RtllmCorpus } from './corpus-types.js';
import { STAGE0_QUARANTINE, type Stage0QuarantineEntry } from './stage0-quarantine.js';
import {
  summarizeTimingPopulations,
  type DesignDerivationOutcome,
  type TimingPopulationSummary,
} from './timing-populations.js';

/** The populations Requirement 3.4 allows an inference count to be reported over. */
export type ReportedPopulation =
  'Derivation_Population' | 'Scoring_Cohort' | 'Timing_Aware_Scoring_Cohort';

/**
 * The population the importer's own count is over.
 *
 * The Derivation_Population, because the importer derives a contract for every design that
 * elaborates, scored or not: `radix2_div` has no usable golden testbench and still gets a
 * contract derived from its netlist.
 */
const COUNTED_POPULATION: ReportedPopulation = 'Derivation_Population';

/** The importer's inference count, with the population it is over and its denominators. */
export interface TimingInferenceCountReport {
  /** Which population `inferenceCount` is over (Req 3.4). */
  readonly population: ReportedPopulation;
  /** That population's size, read off the summary that computes it from membership (Req 3.4). */
  readonly populationSize: number;
  /** Timing_Contracts successfully derived over `population`. */
  readonly inferenceCount: number;
  /** The six figures published alongside the count (Req 3.6). */
  readonly populations: TimingPopulationSummary;
  /**
   * The committed Stage-0 entries that place their designs outside the Scoring_Cohort,
   * `clkgenerator` among them, cited rather than re-excluded (Req 3.3).
   */
  readonly scoringCohortCitations: readonly Stage0QuarantineEntry[];
}

/** Whether a quarantine record is the Timing_Derivation's own refusal. */
function isTimingExclusion(record: QuarantinedDesign): boolean {
  return record.code === 'TIMING_UNDERIVABLE';
}

/**
 * The per-design derivation outcomes an imported corpus records.
 *
 * An imported problem carries a derived contract; a `TIMING_UNDERIVABLE` quarantine is a
 * derivation exclusion carrying the refusal's cause. Any other quarantine code is NEITHER:
 * a design whose description or interface could not be read never reached the derivation,
 * so counting it as a derivation failure would charge the derivation for a read error.
 */
export function derivationOutcomesOf(corpus: RtllmCorpus): readonly DesignDerivationOutcome[] {
  return [
    ...corpus.problems.map((problem): DesignDerivationOutcome => ({
      problemId: problem.id,
      outcome: 'derived',
    })),
    ...corpus.quarantined.filter(isTimingExclusion).map((record): DesignDerivationOutcome => ({
      problemId: record.problemId,
      outcome: 'excluded',
      cause: record.detail,
    })),
  ];
}

/** The named population's published size, so the stated name and figure cannot drift apart. */
function sizeOf(population: ReportedPopulation, summary: TimingPopulationSummary): number {
  switch (population) {
    case 'Derivation_Population':
      return summary.derivationPopulation;
    case 'Scoring_Cohort':
      return summary.scoringCohort;
    case 'Timing_Aware_Scoring_Cohort':
      return summary.timingAwareScoringCohort;
  }
}

/**
 * Report how many Timing_Contracts an imported corpus derived, over a named population.
 *
 * Total and pure: corpus in, figures out, no I/O and no derivation dependency.
 */
export function timingInferenceCountReport(corpus: RtllmCorpus): TimingInferenceCountReport {
  const populations = summarizeTimingPopulations(derivationOutcomesOf(corpus));
  return {
    population: COUNTED_POPULATION,
    populationSize: sizeOf(COUNTED_POPULATION, populations),
    inferenceCount: populations.derivedContracts,
    populations,
    scoringCohortCitations: STAGE0_QUARANTINE,
  };
}
