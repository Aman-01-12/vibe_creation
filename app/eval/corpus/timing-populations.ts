// The five named populations of the timing derivation, computed from membership.
//
// WHY MEMBERSHIP RATHER THAN FIGURES
//   "Included" is retired: five populations exist, they are not interchangeable, and
//   every count states which one it is over (DQ-07). A single denominator carried as a
//   literal double-subtracts: an earlier draft took `clkgenerator` off the scored
//   cohort even though `RTLLM_SCORED_DESIGN_COUNT` is already the universe minus the
//   four Stage-0 entries and `clkgenerator` is one of them. So no population size is
//   written here. Each one is a set operation over committed id sets, and every
//   subtraction goes through a UNION of exclusions, which makes subtracting the same
//   design twice unrepresentable rather than merely discouraged.
//
// THE SIX FIGURES TRAVEL IN ONE OBJECT
//   Requirement 3.6 publishes all six together because a count of successful
//   derivations is meaningless without its denominator and its exclusions: apparent
//   accuracy otherwise improves merely because the hard cases dropped out.

import { RTLLM_EXPECTED_DESIGN_COUNT } from './pinned-source.js';
import { RTLLM_SCORED_DESIGN_COUNT, STAGE0_QUARANTINED_PROBLEM_IDS } from './stage0-quarantine.js';

/**
 * The designs whose reference RTL does not elaborate under the Yosys frontend.
 *
 * Measured, not assumed: every other upstream reference elaborates under a real
 * `prep -flatten` run at `RTLLM_PINNED_COMMIT`, and these two fail the frontend
 * itself, so no netlist exists to walk and no Port_Timing can be derived for them.
 * Recorded here as a committed constant for the same reason `STAGE0_QUARANTINE` is:
 * the Derivation_Population must be known without the toolchain, so a reviewer can
 * see what was dropped and why without running anything. The cross-check's real run
 * asserts this list in both directions, so it is a ratchet and can only shrink
 * through a reviewed edit.
 */
export const YOSYS_FRONTEND_REJECTED_PROBLEM_IDS: readonly string[] = Object.freeze([
  'rtllm/miscellaneous/synchronizer',
  'rtllm/arithmetic/float_multi',
]);

const FRONTEND_REJECTED = new Set(YOSYS_FRONTEND_REJECTED_PROBLEM_IDS);
const STAGE0_EXCLUDED = new Set(STAGE0_QUARANTINED_PROBLEM_IDS);

/** All upstream reference designs at the pinned commit. */
export const SOURCE_UNIVERSE_SIZE = RTLLM_EXPECTED_DESIGN_COUNT;

/** Source_Universe minus the designs the Yosys frontend rejects. */
export const DERIVATION_POPULATION_SIZE = SOURCE_UNIVERSE_SIZE - FRONTEND_REJECTED.size;

/** The existing Stage-0 cohort, read rather than recomputed. */
export const SCORING_COHORT_SIZE = RTLLM_SCORED_DESIGN_COUNT;

/**
 * Whether a design of the Source_Universe elaborates, so a contract can be derived
 * for it at all. A design outside the Derivation_Population is not a derivation
 * failure; it never entered the derivation.
 */
export function inDerivationPopulation(problemId: string): boolean {
  return !FRONTEND_REJECTED.has(problemId);
}

/**
 * Whether a design of the Source_Universe is scored, i.e. its own golden testbench is
 * a usable measuring stick. Membership is the committed Stage-0 list, so a design
 * already quarantined there cannot be excluded a second time by this feature.
 */
export function inScoringCohort(problemId: string): boolean {
  return !STAGE0_EXCLUDED.has(problemId);
}

/** Scoring_Cohort intersected with Derivation_Population. */
export function inDerivableScoringCohort(problemId: string): boolean {
  return inScoringCohort(problemId) && inDerivationPopulation(problemId);
}

/**
 * Scoring_Cohort intersected with Derivation_Population, sized through the union of
 * both exclusion causes so a design carrying both is subtracted once.
 */
export const DERIVABLE_SCORING_COHORT_SIZE =
  SCORING_COHORT_SIZE - YOSYS_FRONTEND_REJECTED_PROBLEM_IDS.filter(inScoringCohort).length;

/** One design's derivation outcome, as plain data so this module runs no derivation. */
export type DesignDerivationOutcome =
  | { readonly problemId: string; readonly outcome: 'derived' }
  | { readonly problemId: string; readonly outcome: 'excluded'; readonly cause: string };

/** One design excluded by the derivation, with the cause that excluded it (Req 3.5). */
export interface DerivationExclusion {
  readonly design: string;
  readonly cause: string;
}

/** The six figures Requirement 3.6 publishes alongside any inference count. */
export interface TimingPopulationSummary {
  readonly sourceUniverse: number;
  readonly derivationPopulation: number;
  readonly derivedContracts: number;
  readonly derivationExclusions: readonly DerivationExclusion[];
  readonly scoringCohort: number;
  readonly timingAwareScoringCohort: number;
}

/** The `<design>` segment of a `rtllm/<category>/<design>` id, for the published row. */
function designNameOf(problemId: string): string {
  return problemId.slice(problemId.lastIndexOf('/') + 1);
}

/**
 * Partition outcomes by problem id, with EXCLUSION DOMINANT: a design reported both
 * ways is excluded, never derived, so a contradictory pair cannot inflate the success
 * count. The first recorded cause wins, which keeps the result order-stable.
 */
function partitionOutcomes(outcomes: readonly DesignDerivationOutcome[]): {
  readonly derived: ReadonlySet<string>;
  readonly excluded: ReadonlyMap<string, string>;
} {
  const derived = new Set<string>();
  const excluded = new Map<string, string>();
  for (const outcome of outcomes) {
    if (outcome.outcome === 'excluded') {
      if (!excluded.has(outcome.problemId)) excluded.set(outcome.problemId, outcome.cause);
      continue;
    }
    derived.add(outcome.problemId);
  }
  for (const problemId of excluded.keys()) derived.delete(problemId);
  return { derived, excluded };
}

/**
 * The six published population figures over a set of per-design derivation outcomes.
 *
 * Total and pure: outcomes in, figures out, no I/O and no derivation dependency, so
 * the reconciliation of Property 12 is testable on plain data. Outcomes are expected
 * to cover the Derivation_Population once per design; anything outside it is ignored
 * rather than counted, because a design that never elaborated is not a derivation
 * result either way.
 *
 * `timingAwareScoringCohort` subtracts only the exclusions that are INSIDE the
 * Derivable_Scoring_Cohort, which is what keeps an already-quarantined design such as
 * `clkgenerator` from being subtracted a second time.
 */
export function summarizeTimingPopulations(
  outcomes: readonly DesignDerivationOutcome[],
): TimingPopulationSummary {
  const { derived, excluded } = partitionOutcomes(outcomes);
  const excludedInPopulation = [...excluded].filter(([problemId]) =>
    inDerivationPopulation(problemId),
  );
  const derivationExclusions = excludedInPopulation.map(([problemId, cause]) => ({
    design: designNameOf(problemId),
    cause,
  }));
  const cohortExclusions = new Set(
    [
      ...YOSYS_FRONTEND_REJECTED_PROBLEM_IDS,
      ...excludedInPopulation.map(([problemId]) => problemId),
    ].filter(inScoringCohort),
  );
  return {
    sourceUniverse: SOURCE_UNIVERSE_SIZE,
    derivationPopulation: DERIVATION_POPULATION_SIZE,
    derivedContracts: [...derived].filter(inDerivationPopulation).length,
    derivationExclusions,
    scoringCohort: SCORING_COHORT_SIZE,
    timingAwareScoringCohort: SCORING_COHORT_SIZE - cohortExclusions.size,
  };
}
