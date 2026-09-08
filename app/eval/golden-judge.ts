// The independent-judge seam the Eval_Harness records a SECOND verdict through.
//
// THE PROBLEM THIS SOLVES
//   The Verification_Loop decides pass/fail with the deterministic Simulator oracle
//   run against the AGENT'S OWN spec-derived testbench. That verdict is what drives
//   repair and what the loop returns. If pass@k were computed from it alone, the
//   number would be SELF-GRADED: a weak agent testbench passes a wrong design and
//   the score rises. So the harness records a second, independent verdict from a
//   benchmark-supplied golden testbench we did not write and do not modify, and
//   reports the AGREEMENT between the two.
//
//   The agreement rate is the empirical test of our own testbenches. The interesting
//   cell is `loopPassGoldenFail`: our testbench said pass, the independent judge said
//   fail. Every one of those is a bug our generated testbench failed to catch, and
//   the count is a direct, falsifiable measure of testbench quality - not an opinion
//   about it.
//
// WHY A NARROW PORT
//   The harness must not know what benchmark the judge came from, where its files
//   live, or how its output is signalled. It hands over the problem id and the
//   candidate RTL and gets back a verdict. The RTLLM-backed implementation lives in
//   `./corpus/`; a different benchmark can be judged by a different implementation
//   without the harness changing. Crucially, the judge material never travels inside
//   the `EvalProblem` the loop-runner receives, so the loop structurally cannot read
//   the testbench that is meant to be able to falsify it.
//
// TWO pass@k NUMBERS, AND WHY BOTH ARE NEEDED
//   `countsInGoldenPassAtK` below is the second denominator, and it exists beside - never
//   instead of - the instrument-gated one in `./instrument-control.js`. They answer two
//   different questions and neither answer substitutes for the other:
//
//     GOLDEN pass@k (this module)         did the flow produce a CORRECT DESIGN?
//                                         Decided by a testbench we did not write.
//     instrument-gated pass@k (that one)  may a `Verified` LABEL be shown to a student?
//                                         Decided by OUR testbench, and admitted only
//                                         where the controls proved it a measuring stick.
//
//   Measured on `.eval-runs/instrument-calibration` (1 arm, 46 problems, n=1): 13 samples
//   produced a candidate, the independent judge returned a verdict on all 13, and 6 had an
//   instrument our own controls could prove. Reporting only the second number answers the
//   product-safety question and silently drops 7 of 13 judged samples from the capability
//   claim; reporting only the first answers the capability question and would let a
//   testbench defect mint a `Verified` label. So both are reported, each labelled for
//   exactly what it is.
//
//   The separation is externally grounded, not a local preference: LLM-generated
//   benchmarks systematically favour the model that produced them, and the bias is
//   additive across test-set generation and evaluation ("Deconstructing Self-Bias in
//   LLM-generated Translation Benchmarks", https://arxiv.org/abs/2509.26600). Our agent
//   writes its own testbench, so a self-graded pass@k carries that bias twice. Content was
//   rephrased for compliance with licensing restrictions.
//
//   ADDING the golden number RELAXES NOTHING. `countsInPassAtK` keeps its single owner,
//   this module holds no reference to instrument validity, and the metamorphic property in
//   `./sweep/summary.test.ts` pins that varying a sample's golden kind moves neither the
//   instrument-gated denominator nor either efficiency figure.

import type { ResourceLimits } from '@app/tools';

import { reachedOracleVerdict } from './instrument-control.js';
import type { SampleOutcomeStatus } from './report.js';

/**
 * What the independent judge ESTABLISHED about one candidate; a closed set.
 *
 * WHY THIS IS NOT `GoldenVerdictKind`
 *   `GoldenVerdictKind` in `./corpus/golden-banner.js` is the BANNER GRAMMAR of a
 *   third-party testbench - `passed | failed | error` - and it must not be reshaped by
 *   our reporting needs. Its `error` is the sum of three different causes: the candidate
 *   did not elaborate, the judge run produced nothing at all, or a resource bound we
 *   imposed killed the run. Those point at three different defects, and only one of them
 *   is even arguably about the model, so a reported exclusion bucket that collapses them
 *   is a black box.
 *
 *   Keeping the two types apart also keeps `./corpus/mutation-calibration.js` untouched:
 *   `calibrationOf` deliberately reads `GoldenScore.timedOut` rather than the banner kind,
 *   so widening THIS vocabulary reaches calibration not at all.
 *
 * The split is made at the judge boundary, where the evidence still exists - see
 * `./corpus/rtllm-golden-judge.js`. A closed union of string literals with no free text,
 * for the same reason `RecordedInstrumentVerdict` is one: it is persisted, echoed into
 * `outcome.json`, and printed to operators, so being structurally incapable of carrying a
 * path or a tool message is stronger than sanitizing one.
 */
export type RecordedGoldenKind =
  /** The golden testbench printed its pass banner. */
  | 'passed'
  /** The golden testbench reported wrong results. */
  | 'failed'
  /** No banner, and the run emitted build diagnostics: the candidate did not elaborate. */
  | 'did-not-build'
  /** No banner and no diagnostics: the judge run produced nothing. */
  | 'no-output'
  /** The run was killed for exceeding a resource bound we imposed. */
  | 'timed-out';

/** Every recorded golden kind, in declaration order; the closed set, enumerable. */
export const RECORDED_GOLDEN_KINDS: readonly RecordedGoldenKind[] = Object.freeze([
  'passed',
  'failed',
  'did-not-build',
  'no-output',
  'timed-out',
]);

/** One independent verdict, reduced to what a persisted report should carry. */
export interface RecordedGoldenVerdict {
  readonly kind: RecordedGoldenKind;
  /** Failures the golden testbench reported, or `null` when it printed no count. */
  readonly failureCount: number | null;
}

/** One judging request: which problem, and the candidate the loop produced for it. */
export interface GoldenJudgeRequest {
  readonly problemId: string;
  /** The candidate RTL the loop's terminal outcome carried. */
  readonly rtl: string;
  /** The same sandbox caps the loop's own oracle ran under (Req 15.6). */
  readonly limits: ResourceLimits;
}

/**
 * The independent judge port.
 *
 * Returns `null` when the judge has no golden testbench for that problem id, so a
 * mixed subset (some problems judged, some not) is expressed honestly rather than
 * by inventing a verdict. Implementations must never throw for a failing candidate:
 * a candidate that will not compile is a legitimate `error` verdict.
 */
export interface GoldenJudge {
  judge(request: GoldenJudgeRequest): Promise<RecordedGoldenVerdict | null>;
}

/**
 * How the agent's own testbench and the independent judge compared across a run.
 *
 * Only samples where BOTH verdicts exist are counted: a sample the loop never got a
 * candidate out of (blocked, setup failure) has nothing to judge, and folding it in
 * as agreement would flatter the rate.
 */
export interface AgreementReport {
  /** Samples that produced a candidate AND had a golden testbench available. */
  readonly judgedSamples: number;
  /** Judged samples where the loop's pass/not-pass matched the golden pass/not-pass. */
  readonly agreeingSamples: number;
  /** `agreeingSamples / judgedSamples`, or 0 when nothing was judged. */
  readonly agreementRate: number;
  /** The loop passed but the independent judge failed: a bug our testbench missed. */
  readonly loopPassGoldenFail: number;
  /** The loop failed but the independent judge passed: our testbench was stricter. */
  readonly loopFailGoldenPass: number;
}

/** The empty agreement report, for a run with no judge wired. */
export const NO_AGREEMENT_MEASURED: AgreementReport = Object.freeze({
  judgedSamples: 0,
  agreeingSamples: 0,
  agreementRate: 0,
  loopPassGoldenFail: 0,
  loopFailGoldenPass: 0,
});

/** One sample's pair of verdicts, as the aggregator consumes them. */
export interface VerdictPair {
  /** Whether the loop's own oracle passed the sample. */
  readonly loopPassed: boolean;
  /** The independent verdict, or `null` when the sample could not be judged. */
  readonly golden: RecordedGoldenVerdict | null;
}

/**
 * Aggregate per-sample verdict pairs into the agreement report (pure).
 *
 * `agreementRate` is 0 - not 1 - for an unjudged run, so an environment with no
 * judge wired can never read as perfect agreement.
 */
export function summarizeAgreement(pairs: readonly VerdictPair[]): AgreementReport {
  const judged = pairs.filter((pair) => pair.golden !== null);
  let agreeing = 0;
  let loopPassGoldenFail = 0;
  let loopFailGoldenPass = 0;
  for (const pair of judged) {
    const goldenPassed = pair.golden?.kind === 'passed';
    if (pair.loopPassed === goldenPassed) {
      agreeing += 1;
    } else if (pair.loopPassed) {
      loopPassGoldenFail += 1;
    } else {
      loopFailGoldenPass += 1;
    }
  }
  return {
    judgedSamples: judged.length,
    agreeingSamples: agreeing,
    agreementRate: judged.length === 0 ? 0 : agreeing / judged.length,
    loopPassGoldenFail,
    loopFailGoldenPass,
  };
}

/** The two facts golden-denominator membership is decided from. */
export interface GoldenPassAtKEligibility {
  readonly outcomeStatus: SampleOutcomeStatus;
  /** The independent judge's recorded verdict, or `null` when the sample was unjudged. */
  readonly golden: RecordedGoldenVerdict | null;
}

/** The recorded kinds that ARE a verdict on the candidate's behaviour. */
const BEHAVIOURAL_GOLDEN_KINDS: readonly RecordedGoldenKind[] = Object.freeze(['passed', 'failed']);

/**
 * THE GOLDEN DENOMINATOR INVARIANT.
 *
 * A sample counts in the golden denominator if and ONLY if the loop reached an oracle
 * verdict AND the independent judge returned a verdict on the candidate's BEHAVIOUR
 * (`passed` or `failed`).
 *
 * Exactly one predicate decides this, and both the estimator and the reported exclusion
 * tally read it, so the denominator and the counts describing it cannot disagree - the
 * same discipline `countsInPassAtK` already applies to its own denominator.
 *
 * Why each exclusion, stated for the record:
 *
 *   NO ORACLE VERDICT (`blocked`, `setup-failed`, `runner-error`). The flow never handed the
 *   judge a candidate, so the judge never spoke. Counting it as a model failure would
 *   attribute a rate-limit burst, a harness crash, or a declined slot to the model. This is
 *   the same first condition `countsInPassAtK` applies, and it is read through the same
 *   `reachedOracleVerdict` owner rather than restated here.
 *
 *   NO GOLDEN OUTCOME AT ALL. Either no judge was wired, or the problem has no golden
 *   testbench (a Stage 0 quarantine). A sample nobody judged is not evidence about the model.
 *
 *   `did-not-build`. Tempting to count as a model failure, and rejected: six golden
 *   testbenches OVERRIDE module parameters our `ModuleInterface` has no concept of, so a
 *   candidate generated faithfully from the Spec can fail to elaborate against the judge for
 *   a requirement the Spec never stated. Attributing that to the model would be the same
 *   class of error as counting an instrument-invalid sample as a model failure. It is
 *   excluded AND counted, and a `did-not-build`-dominated bucket is a finding about the
 *   parameter-override gap.
 *
 *   `no-output`. Our own infrastructure produced nothing. Never a model result.
 *
 *   `timed-out`. A resource bound WE imposed stopped the run. A wall-clock finding, not a
 *   capability finding, and the same discipline the mutation control already applies to
 *   `goldenTimeoutMutants`.
 *
 * FAIL-SAFE IN ONE DIRECTION ONLY: every exclusion can only move a sample OUT of the golden
 * denominator, never in, and `RecordedGoldenKind` is closed, so there is no path by which an
 * unclassifiable run becomes a `passed`. That mirrors `unchecked` in the instrument control.
 */
export function countsInGoldenPassAtK(sample: GoldenPassAtKEligibility): boolean {
  if (!reachedOracleVerdict(sample.outcomeStatus)) {
    return false;
  }
  return sample.golden !== null && BEHAVIOURAL_GOLDEN_KINDS.includes(sample.golden.kind);
}

/**
 * How one arm's samples split around its golden denominator.
 *
 * `judgedSamples` plus the FIVE exclusion counts equals the arm's recorded sample count by
 * construction, so a shrunken denominator can never be cited without what it leaves out.
 * `goldenPassedSamples` is a subset of `judgedSamples` and is deliberately NOT part of that
 * partition - it is the numerator, not a bucket.
 */
export interface GoldenPassAtKReport {
  /** Samples the independent judge returned a behavioural verdict on: the denominator. */
  readonly judgedSamples: number;
  /** Judged samples the independent judge passed: the numerator. */
  readonly goldenPassedSamples: number;
  /** Samples that never produced a candidate, so were never judged. */
  readonly noCandidateSamples: number;
  /** Samples with no golden testbench available, so nobody judged them. */
  readonly unjudgedSamples: number;
  /** Judged runs whose candidate did not elaborate against the judge. */
  readonly didNotBuildSamples: number;
  /** Judged runs that produced nothing at all. */
  readonly noOutputSamples: number;
  /** Judged runs a resource bound we imposed killed. */
  readonly timedOutSamples: number;
}

/** The empty golden report, for an arm with no samples or no judge wired. */
export const NO_GOLDEN_PASS_AT_K_MEASURED: GoldenPassAtKReport = Object.freeze({
  judgedSamples: 0,
  goldenPassedSamples: 0,
  noCandidateSamples: 0,
  unjudgedSamples: 0,
  didNotBuildSamples: 0,
  noOutputSamples: 0,
  timedOutSamples: 0,
});

/** The report fields a recorded golden kind may be tallied into. */
type GoldenTallyField =
  'judgedSamples' | 'didNotBuildSamples' | 'noOutputSamples' | 'timedOutSamples';

/**
 * Which report bucket each recorded kind lands in.
 *
 * A TOTAL `Record` rather than a `switch`, so a sixth `RecordedGoldenKind` added later is a
 * COMPILE ERROR here instead of a population that silently vanishes from the partition -
 * the same discipline `DEFECT_TALLY_FIELDS` applies in `./instrument-control.js`.
 */
const GOLDEN_TALLY_FIELDS: Readonly<Record<RecordedGoldenKind, GoldenTallyField>> = Object.freeze({
  passed: 'judgedSamples',
  failed: 'judgedSamples',
  'did-not-build': 'didNotBuildSamples',
  'no-output': 'noOutputSamples',
  'timed-out': 'timedOutSamples',
});

/**
 * Aggregate per-sample eligibility facts into the golden report (pure).
 *
 * The three-way split is applied in the SAME order `countsInGoldenPassAtK` decides
 * membership in, so the two cannot disagree: no oracle verdict first, then no golden
 * outcome, then the kind's own bucket.
 */
export function summarizeGoldenPassAtK(
  samples: readonly GoldenPassAtKEligibility[],
): GoldenPassAtKReport {
  const tally: Record<GoldenTallyField, number> = {
    judgedSamples: 0,
    didNotBuildSamples: 0,
    noOutputSamples: 0,
    timedOutSamples: 0,
  };
  let noCandidateSamples = 0;
  let unjudgedSamples = 0;
  let goldenPassedSamples = 0;
  for (const sample of samples) {
    if (!reachedOracleVerdict(sample.outcomeStatus)) {
      noCandidateSamples += 1;
      continue;
    }
    if (sample.golden === null) {
      unjudgedSamples += 1;
      continue;
    }
    tally[GOLDEN_TALLY_FIELDS[sample.golden.kind]] += 1;
    if (sample.golden.kind === 'passed') {
      goldenPassedSamples += 1;
    }
  }
  return { ...tally, goldenPassedSamples, noCandidateSamples, unjudgedSamples };
}
