// The Benchmark_Regression_Suite's gate table (C20; Req 16.1, 16.2, 16.3, 16.4, 16.5,
// 1.8, 1.9, 1.10, 5.8, 9.8, 9.9, 9.10).
//
// THREE pre-registered bars, fixed before any paid run (Req 1.8, 1.9, 5.8). THREE further
// bars gate the suite without being pre-registered, because Requirement 9 states them as
// SHALL thresholds and Requirement 16 criterion 4 fails the suite on any figure past its
// bar (Req 9.8, 9.9, 9.10). The two tables are kept SEPARATE on purpose: folding them into
// one table would let "pre-registered" quietly come to mean "gated", which is not what it
// means here - a bar invented after its own measurement can be moved after its result, the
// exact discipline that caught the plurality rule failing its holdout at 4.2% (Req 2.3).
//
// `decideConsensusRegressionGate` takes ONLY `GatedFigures`, never `ReportedFigures` - no
// parameter through which a reported figure could move the verdict exists, so "the reported
// figures gate nothing" is a type signature rather than a rule the body happens to follow.
//
// A figure exactly equal to its bar PASSES, in both tables and for both comparison
// directions (Req 16.4's own criterion), which is why every bar below is one `GateBar`
// value compared through the single `passesBar` rule rather than six hand-written
// comparisons that could drift on the boundary.

/** Which side of a bar is the passing side. */
export type GateDirection = 'at-most' | 'at-least';

/** One gated figure's name, comparison direction, and bar. */
export interface GateBar {
  readonly name: string;
  readonly direction: GateDirection;
  readonly bar: number;
}

/** Whether `value` is on the passing side of `bar`, where exactly equal always passes. */
function passesBar(value: number, bar: GateBar): boolean {
  return bar.direction === 'at-most' ? value <= bar.bar : value >= bar.bar;
}

// --- Table 1: the three PRE-REGISTERED bars (Req 1.8, 1.9, 5.8) --------------------------

/** MEASURED: 0.2% held out, against the 11.6% of today's loop. */
export const WRONG_LABEL_SHARE_BAR: GateBar = {
  name: 'Wrong_Label_Share',
  direction: 'at-most',
  bar: 0.02,
};

/** MEASURED: 44.9% held out, against roughly 27% of today's loop. */
export const VERIFIED_CORRECT_SHARE_BAR: GateBar = {
  name: 'Verified_Correct_Share',
  direction: 'at-least',
  bar: 0.4,
};

/** MEASURED: every one of `PILOT_DESIGN_SET` sits at 0% today. */
export const PILOT_PASS_SHARE_BAR: GateBar = {
  name: 'Pilot_Pass_Share',
  direction: 'at-least',
  bar: 0.5,
};

/** The three Pilot_Design_Set designs the Pilot_Pass_Share bar is checked for, each on its own. */
export const PILOT_DESIGN_SET = ['counter_12', 'traffic_light', 'accu'] as const;
export type PilotDesign = (typeof PILOT_DESIGN_SET)[number];

// --- Table 2: THREE further gated bars, NOT pre-registered (Req 9.8, 9.9, 9.10) ----------

/** MEASURED: 99.5% over 2,545 pairs where exactly one side was at fault. */
export const ATTRIBUTION_ACCURACY_TESTBENCH_BAR: GateBar = {
  name: 'Attribution_Accuracy (TESTBENCH)',
  direction: 'at-least',
  bar: 0.95,
};

/** MEASURED: 90.4% over 468 pairs where exactly one side was at fault. */
export const ATTRIBUTION_ACCURACY_RTL_BAR: GateBar = {
  name: 'Attribution_Accuracy (RTL)',
  direction: 'at-least',
  bar: 0.85,
};

/** MEASURED: 0.6%, against the 79.3% of today's loop. */
export const MISATTRIBUTION_SHARE_BAR: GateBar = {
  name: 'Misattribution_Share',
  direction: 'at-most',
  bar: 0.02,
};

/**
 * RTLLM's golden testbench kills 267 of 367 valid planted mutants (Req 16.5).
 *
 * Every wrong-label figure the suite reports - gated or merely reported - is read as a
 * FLOOR against this figure, never as an exact rate: a planted mutant the golden testbench
 * itself cannot kill is one this suite could not have scored either way.
 */
export const GOLDEN_MUTANT_KILL_FLOOR = 267 / 367;

/**
 * Every bar of Requirements 1, 5, and 9 was measured with the benchmark's golden testbench
 * and reference design as ground truth, which production does not have (Req 16.1).
 */
export const MEASURED_AGAINST_BENCHMARK_GROUND_TRUTH_NOTE =
  'Every bar of Requirements 1, 5, and 9 was measured with the benchmark\u2019s golden ' +
  'testbench and reference design as ground truth, which production does not have.';

/**
 * The Consensus_Gate makes no claim about its own accuracy on a student's design, because no
 * Independent_Judge exists for that design (Req 16.2).
 */
export const NO_STUDENT_ACCURACY_CLAIM_NOTE =
  'The Consensus_Gate makes no claim about its own accuracy on a student\u2019s design, ' +
  'because no Independent_Judge exists for that design.';

/** The six figures the gate decides on; everything else the suite measures is reported only. */
export interface GatedFigures {
  readonly wrongLabelShare: number;
  readonly verifiedCorrectShare: number;
  /** One share per `PilotDesign`, each checked against `PILOT_PASS_SHARE_BAR` on its own. */
  readonly pilotPassShare: Readonly<Record<PilotDesign, number>>;
  readonly attributionAccuracyTestbench: number;
  readonly attributionAccuracyRtl: number;
  readonly misattributionShare: number;
}

/** The diversity figures a run records beside the retired control arm (Req 3.10, task 16.4). */
export interface DiversityRecord {
  /** MEASURED: 2.4% for one Model_Family on the holdout. */
  readonly wrongLabelShareSingleFamilyHoldout: number;
  /** MEASURED: 0.2% for mixed Model_Families on the holdout. */
  readonly wrongLabelShareMixedFamilyHoldout: number;
  /** MEASURED: 2.6% over 13,532 single-Model_Family sessions in the replay. */
  readonly wrongLabelShareSingleFamilyReplay: number;
  /** MEASURED: 0.3% over sessions with 2 or more Model_Families in the replay. */
  readonly wrongLabelShareMultiFamilyReplay: number;
}

/**
 * Everything the suite measures that gates NOTHING (Req 16.7, Q-03).
 *
 * `Delivered_Label_Correct_Share` is reported rather than a fourth pre-registered bar: the
 * 97% figure once attached to it was chosen AFTER the 99.7% measurement, and a bar invented
 * after its own measurement can be moved after its result - the exact discipline Req 2.3's
 * holdout failure already demonstrates the cost of skipping. It is also largely implied by
 * the 2% `Wrong_Label_Share` bar, which does gate.
 */
export interface ReportedFigures {
  /** MEASURED: 99.7%. */
  readonly deliveredLabelCorrectShare: number;
  /** MEASURED: 45.6%. */
  readonly firstAttemptVerifiedCorrectShare: number;
  /** MEASURED: 63.4%. */
  readonly withinThreeAttemptsVerifiedCorrectShare: number;
  /** `null`: NOT YET MEASURED, the honest check on C12. */
  readonly peerCalibratedMutationGateAgreement: number | null;
  readonly diversity: DiversityRecord;
}

/** One gated figure that landed past its bar. */
export interface GateFailure {
  readonly figure: string;
  readonly value: number;
  readonly bar: GateBar;
}

/** The suite's pass/fail verdict over the six gated figures alone (Req 16.4). */
export interface GateVerdict {
  readonly passed: boolean;
  readonly failures: readonly GateFailure[];
}

/** Check one named figure against one bar, appending a failure when it lands past it. */
function checkFigure(name: string, value: number, bar: GateBar, failures: GateFailure[]): void {
  if (!passesBar(value, bar)) {
    failures.push({ figure: name, value, bar });
  }
}

/**
 * Decide the Benchmark_Regression_Suite's verdict from the six gated figures alone (Req
 * 16.4): a failure if and only if some gated figure is past its bar, where a figure exactly
 * equal to its bar passes.
 *
 * Pure and total, and structurally blind to every reported figure: there is no
 * `ReportedFigures` parameter here, so a reported figure cannot move this verdict no matter
 * how far from its own (nonexistent) bar it drifts.
 */
export function decideConsensusRegressionGate(figures: GatedFigures): GateVerdict {
  const failures: GateFailure[] = [];
  checkFigure(WRONG_LABEL_SHARE_BAR.name, figures.wrongLabelShare, WRONG_LABEL_SHARE_BAR, failures);
  checkFigure(
    VERIFIED_CORRECT_SHARE_BAR.name,
    figures.verifiedCorrectShare,
    VERIFIED_CORRECT_SHARE_BAR,
    failures,
  );
  for (const design of PILOT_DESIGN_SET) {
    checkFigure(
      `${PILOT_PASS_SHARE_BAR.name} (${design})`,
      figures.pilotPassShare[design],
      PILOT_PASS_SHARE_BAR,
      failures,
    );
  }
  checkFigure(
    ATTRIBUTION_ACCURACY_TESTBENCH_BAR.name,
    figures.attributionAccuracyTestbench,
    ATTRIBUTION_ACCURACY_TESTBENCH_BAR,
    failures,
  );
  checkFigure(
    ATTRIBUTION_ACCURACY_RTL_BAR.name,
    figures.attributionAccuracyRtl,
    ATTRIBUTION_ACCURACY_RTL_BAR,
    failures,
  );
  checkFigure(
    MISATTRIBUTION_SHARE_BAR.name,
    figures.misattributionShare,
    MISATTRIBUTION_SHARE_BAR,
    failures,
  );
  return { passed: failures.length === 0, failures };
}
