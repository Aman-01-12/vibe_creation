// The Benchmark_Regression_Suite's arm list, with the single-Model_Family control arm
// marked run-once (C20; Req 3.6, 3.10, 16.3).
//
// The split IS the implementation of the decision (design.md, C20): the mixed-Model_Family
// main arm runs on every regression run, and the single-Model_Family control arm runs ONCE
// at first light and is then retired to its own recorded measurement. A retired arm must be
// UNREACHABLE from the per-run path, not merely absent from it by convention, which is why
// `PER_RUN_ARMS` is its own narrower list rather than `ALL_ARMS` filtered by a flag a future
// caller could forget to check.
//
// The replay now covers the diversity effect directly - 2.6% wrong labels over 13,532
// single-Model_Family sessions against 0.3% for two or more - so the control arm is no
// longer establishing the effect, only confirming it transfers from replay to the real loop.
// Both the replay figures and the holdout figures they confirm are recorded on
// `CONSENSUS_REGRESSION_DIVERSITY_RECORD` (gate.ts's `DiversityRecord` shape), so retiring
// the arm retires the RUN and not the evidence.

/** Which Model_Family diversity one arm's Design_Pool and Testbench_Pool are planned under. */
export type ConsensusRegressionArmFamilySpread = 'mixed' | 'single';

/** One Benchmark_Regression_Suite arm: its name, its spread, and when it runs. */
export interface ConsensusRegressionArm {
  readonly name: string;
  readonly familySpread: ConsensusRegressionArmFamilySpread;
  /** `true` for an arm driven every regression run; `false` for a retired, run-once arm. */
  readonly runsPerRegression: boolean;
}

/** The mixed-Model_Family main arm: runs every regression run (Req 3.1 to 3.5). */
export const MAIN_ARM: ConsensusRegressionArm = Object.freeze({
  name: 'mixed-model-family-main',
  familySpread: 'mixed',
  runsPerRegression: true,
});

/**
 * The single-Model_Family control arm: ran ONCE at first light, then retired (Req 3.6).
 *
 * `runsPerRegression: false` is what the retirement IS - a data fact a scheduler reads,
 * never a note an operator has to remember to honor.
 */
export const SINGLE_FAMILY_CONTROL_ARM: ConsensusRegressionArm = Object.freeze({
  name: 'single-model-family-control',
  familySpread: 'single',
  runsPerRegression: false,
});

/** Every arm the suite has ever defined, retired or not. */
export const ALL_ARMS: readonly ConsensusRegressionArm[] = Object.freeze([
  MAIN_ARM,
  SINGLE_FAMILY_CONTROL_ARM,
]);

/**
 * The arms a regression run actually drives: `ALL_ARMS` filtered to `runsPerRegression`.
 *
 * This is what makes the retired control arm UNREACHABLE from the per-run path: a caller
 * that iterates `PER_RUN_ARMS` can never schedule it, regardless of whether `ALL_ARMS` still
 * names it for the record.
 */
export const PER_RUN_ARMS: readonly ConsensusRegressionArm[] = Object.freeze(
  ALL_ARMS.filter((arm) => arm.runsPerRegression),
);

/**
 * The diversity figures recorded beside the retired control arm (Req 3.10): both the replay
 * figures that reduced its value and the holdout figures they confirm transfer to the real
 * loop.
 */
export const CONSENSUS_REGRESSION_DIVERSITY_RECORD = Object.freeze({
  wrongLabelShareSingleFamilyHoldout: 0.024,
  wrongLabelShareMixedFamilyHoldout: 0.002,
  wrongLabelShareSingleFamilyReplay: 0.026,
  wrongLabelShareMultiFamilyReplay: 0.003,
});
