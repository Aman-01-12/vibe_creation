// The sweep engine: drive the bake-off matrix, stream every completed sample to disk,
// skip what a previous run already paid for, and stop cleanly on any bound.
//
// THE UNIT OF WORK IS ONE SAMPLE
//   (arm, problem, sampleIndex). That granularity is what makes the run resumable
//   without re-paying, and it is executed through the Eval_Harness by scheduling exactly
//   that slot - see `./sample-scheduler.ts` for why that composition is the honest one.
//
// ORDER IS ARM-MAJOR AND DETERMINISTIC
//   Every sample of arm 1 is planned before arm 2. An interrupted campaign therefore
//   leaves COMPLETE, citable numbers for the arms that finished rather than partial
//   numbers for all of them, which is the difference between a usable overnight run and a
//   wasted one. Within an arm the order is problem-major, sample-index-minor.
//
// CONCURRENCY IS BOUNDED AND ORDER-INDEPENDENT
//   Samples are drawn from the plan by a fixed-size worker pool. Each sample is
//   independent - its seed is derived from (base seed, problem, index), its budget is
//   fresh, and its sandbox run is isolated - so completing them out of order changes no
//   number. Only the ORDER OF LINES in the results file varies, and the summary groups
//   rather than reads positionally. The default is conservative because the host
//   rate-limits before it refuses.
//
// FAIL SAFE, ONE SAMPLE AT A TIME
//   A sample that throws anywhere - the harness, the provider, the sandbox - is recorded
//   as a failed sample with a sanitized note and the run continues. The only conditions
//   that stop the run are the explicit bounds: the wall clock, the sample cap, a
//   sustained provider outage, and the inability to persist a result. Each stops
//   DISPATCH at a sample boundary and lets in-flight samples finish, so nothing paid for
//   is thrown away.
//
// COST IS RECORDED, NEVER A LIMITER (see `./kill-switch.ts`).

import {
  designGroupOf,
  MODEL_TASKS,
  repairDeclineReasonOf,
  routeCheckingApproach,
  TESTBENCH_PROMPT_VERSION,
  type DesignGroup,
  type PropertySetSource,
  type StrategyArm,
} from '@app/agent';
import { SIMULATION_HARNESS_VERSION } from '@app/tools';

import type { EvalArtifactSink } from '../artifact-sink.js';
import { createEvalHarness } from '../harness.js';
import type { GoldenJudge } from '../golden-judge.js';
import type { InstrumentControl } from '../instrument-control.js';
import { recordedMutationCounts, type MutationSampleCounts } from '../mutation-control.js';
import type { PropertySetGate } from '../property-set-admission.js';
import type { EvalLoopRunner } from '../loop-runner.js';
import { noVerdictCauseOf } from '../no-verdict-cause.js';
import type { EvalProblem } from '../problem.js';
import type { SampleOutcomeStatus, SampleResult } from '../report.js';
import {
  armCostIsKnown,
  modelSignatureOf,
  type ScoreboardCampaignConfig,
  type SweepArmConfig,
  type SweepConfig,
} from './config.js';
import type { SweepKillSwitch, SweepStopReason } from './kill-switch.js';
import {
  encodeSampleRecord,
  recordedFormalRun,
  RESULTS_SCHEMA_VERSION,
  type CompletedSampleIndex,
  type ResultsLogPort,
  type SweepSampleRecord,
} from './results-log.js';
import { captureOneSample, scheduleOneSample } from './sample-scheduler.js';
import type { ThrottleGovernor } from './throttle-governor.js';

/**
 * How often a withheld worker re-asks for admission, in milliseconds.
 *
 * A build constant, not a config field, for the same reason the governor's own bounds are
 * build constants (see `./throttle-governor.ts`): it is throttle machinery, not an
 * experiment parameter, and a config field here would enter the Config_Identity and orphan
 * paid samples over a value that cannot move a measured number. Small enough that a
 * recovering recommendation is picked up promptly against the governor's 60-second window,
 * large enough that polling costs nothing measurable next to a model call.
 */
const ADMISSION_POLL_MS = 500;

/**
 * Outcome statuses that mean the sample produced NO oracle verdict at all.
 *
 * Counted separately from `unverified`, which IS a verdict: the oracle ran and did not
 * pass. Conflating them would hide an infrastructure problem inside a model's score. These
 * are also the statuses the pass@k denominator invariant excludes on its first condition -
 * see `../instrument-control.ts`, which owns that rule; this list drives the run's own
 * progress counter.
 */
const NO_VERDICT_STATUSES: readonly SampleOutcomeStatus[] = [
  'blocked',
  'setup-failed',
  'runner-error',
];

/**
 * The EVAL-side Formal_Gate, whose two halves are only ever supplied together.
 *
 * They are bundled for the reason `FormalGate` in `../verification-loop-runner.ts` is bundled:
 * a gate holding no Property_Author has nothing to score, so the harness would spend the gate
 * and still record `not-gated`. One optional field makes that half-wired state unrepresentable
 * here rather than merely discouraged.
 *
 * `sourceFor` is keyed by ARM because the author is a model call: a bake-off that authored every
 * arm's properties with one fixed model would be holding the wrong thing constant.
 */
export interface SweepPropertySetGate {
  readonly gate: PropertySetGate;
  /** The arm's per-problem Property_Author, built once per arm like `loopRunnerFor`. */
  readonly sourceFor: (arm: SweepArmConfig) => (problem: EvalProblem) => PropertySetSource;
}

/** One planned unit of work. */
interface SampleUnit {
  readonly arm: SweepArmConfig;
  readonly armName: string;
  readonly modelSignature: string;
  readonly costKnown: boolean;
  readonly problem: EvalProblem;
  readonly sampleIndex: number;
}

/** What one sweep run did. */
export interface SweepRunResult {
  readonly stopReason: SweepStopReason;
  /** Samples in the full matrix (arms x problems x sampleCount). */
  readonly plannedSamples: number;
  /** Samples a previous run already recorded for this config, so they were not re-run. */
  readonly skippedSamples: number;
  /** Samples this process dispatched to a model. */
  readonly dispatchedSamples: number;
  /** Samples this process appended to the results log. */
  readonly recordedSamples: number;
  /** Dispatched samples that produced no oracle verdict (recorded as failures). */
  readonly failedSamples: number;
}

/** The injected collaborators one sweep run needs; no globals. */
export interface SweepRunnerDeps {
  readonly config: SweepConfig;
  /** The experiment identity every persisted record is keyed by. */
  readonly configHash: string;
  /** The selected problems, already resolved against the scored corpus, in run order. */
  readonly problems: readonly EvalProblem[];
  /**
   * Builds the arm's loop runner: in deployment the production
   * `EvalVerificationLoopRunner` over the real models and the real Icarus oracle. Called
   * once per arm; the returned runner is shared by that arm's concurrent samples, which
   * is safe because it holds no per-sample state.
   */
  readonly loopRunnerFor: (arm: SweepArmConfig) => EvalLoopRunner;
  /**
   * Builds the arm's per-sample artifact sink, or ABSENT when capture is off.
   *
   * Called once per arm, like `loopRunnerFor`, and for the same reason: the returned sink
   * holds no per-sample state, so an arm's concurrent samples share it safely. Absent means
   * the harness receives no sink at all and behaves exactly as it did before this seam
   * existed. The arm is bound HERE because this is the layer that knows which arm a sample
   * belongs to - the harness is not told.
   */
  readonly artifactSinkFor?: (arm: SweepArmConfig) => EvalArtifactSink;
  /**
   * The EVAL-side Formal_Gate on the PROPERTY SET, or ABSENT when the config leaves it off.
   *
   * Composed in `./cli.ts#prepare` rather than here, because that is already the composition
   * root for the retention store the gate's oracle reads its own reports through and for both
   * instrument controls, and it builds the shared stack once so no arm re-composes it. The gate
   * is part of the held-constant stack a bake-off permutes models against.
   *
   * Absent means the harness receives no gate and no Property_Author, so every sample records
   * `'not-gated'` and behaves exactly as it did before this seam existed.
   */
  readonly propertySetGate?: SweepPropertySetGate;
  /** The independent golden judge, shared by every arm; null when none is available. */
  readonly goldenJudge: GoldenJudge | null;
  /**
   * The INSTRUMENT CONTROL, shared by every arm; null when none is available.
   *
   * Deterministic and free of model calls, so it is shared exactly like the judge and adds no
   * cost - only wall clock. The positive control is one compile plus one simulation per
   * sample; the negative control adds one per DETECTABLE mutant, plus a one-off calibration
   * per problem that is cached across runs (see `../corpus/mutation-calibration.ts`). A `null`
   * control leaves every instrument `unchecked`, which the summary reports as pass@k NOT
   * VALIDATED.
   */
  readonly instrumentControl: InstrumentControl | null;
  readonly resultsLog: ResultsLogPort;
  /** Sample slots a previous run already completed for this exact config. */
  readonly completed: CompletedSampleIndex;
  readonly killSwitch: SweepKillSwitch;
  /** Reports a sustained provider outage; the shared transport circuit breaker. */
  readonly outage: () => boolean;
  /**
   * The shared run-wide throttle observer; reports how many workers may hold a unit right
   * now. Injected rather than built here for the same reason the kill switch and breaker
   * are: it is shared with the transport layer that actually observes the throttle
   * replies, and this run must react to the SAME observations rather than a second,
   * disagreeing count.
   */
  readonly governor: ThrottleGovernor;
  /**
   * Delay used by a withheld worker before it re-asks for admission.
   *
   * Injected the way `now` is injected, so a test can advance admission without a real
   * timer. Production passes a real `setTimeout`-backed delay; a test passes one that
   * resolves immediately (or that observes the wait) and controls `governor` instead.
   */
  readonly waitMs: (ms: number) => Promise<void>;
  /** Wall clock for record timestamps and durations. */
  readonly now: () => number;
  /** Sanitized progress sink: the CLI prints these, a test collects them. */
  readonly onProgress: (line: string) => void;
  /** Persists the run manifest; awaited before the first dispatch (Req 10.2). */
  readonly writeManifest: () => Promise<void>;
}

/** The first Campaign problem whose recorded Design_Group differs from its interface's, or null. */
export function designGroupMismatch(
  problems: readonly EvalProblem[],
  designGroups: Readonly<Record<string, DesignGroup>>,
): string | null {
  const wrong = problems.find(
    (problem) => designGroups[problem.id] !== designGroupOf(problem.spec.moduleInterface),
  );
  return wrong?.id ?? null;
}

/**
 * The Streaming_Supplement rule (Req 8.8): every scored design outside the baseline ids that
 * routes In_Order_Scoreboard under Treatment, in corpus order.
 */
export function streamingSupplementOf(
  scoredCorpus: readonly EvalProblem[],
  baselineIds: ReadonlySet<string>,
): readonly string[] {
  return scoredCorpus
    .filter((problem) => !baselineIds.has(problem.id))
    .filter(
      (problem) =>
        routeCheckingApproach(problem.spec.moduleInterface, 'treatment') === 'in-order-scoreboard',
    )
    .map((problem) => problem.id);
}

/**
 * Why a Campaign may not start (Req 8.4, 8.8), or null when its hand-written lists match what
 * the imported Specs say. Baseline ids are the Campaign's ids outside its supplement.
 */
export function campaignStartRefusal(
  campaign: ScoreboardCampaignConfig,
  selected: readonly EvalProblem[],
  scoredCorpus: readonly EvalProblem[],
): string | null {
  const mismatch = designGroupMismatch(selected, campaign.designGroups);
  if (mismatch !== null) {
    return `the recorded Design_Group of ${mismatch} differs from its imported interface`;
  }
  const declared = new Set(campaign.streamingSupplement);
  const baselineIds = new Set(
    selected.map((problem) => problem.id).filter((id) => !declared.has(id)),
  );
  const derived = streamingSupplementOf(scoredCorpus, baselineIds);
  const differs = derived.length !== declared.size || derived.some((id) => !declared.has(id));
  return differs
    ? `streamingSupplement must be exactly [${derived.join(', ')}], the designs the rule selects`
    : null;
}

/**
 * Group arms by their models in order of first appearance. Strategy-free arms are never
 * paired, so a config without strategies keeps today's arm-major order exactly.
 */
function armsByModels(arms: readonly SweepArmConfig[]): readonly (readonly SweepArmConfig[])[] {
  const groups = new Map<string, SweepArmConfig[]>();
  for (const [index, arm] of arms.entries()) {
    const models = MODEL_TASKS.map((task) => arm.roleModels[task]);
    const key = JSON.stringify(arm.strategy === undefined ? [index] : models);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [arm]);
    } else {
      group.push(arm);
    }
  }
  return [...groups.values()];
}

/**
 * Build the full matrix pair-major (Req 7.10): per model group, problem, and sample index,
 * every arm of the group in config order, so a Control slot is followed by its Treatment slot.
 */
function planUnits(deps: SweepRunnerDeps): readonly SampleUnit[] {
  const { config } = deps;
  const units: SampleUnit[] = [];
  for (const group of armsByModels(config.arms)) {
    const shared = group.map((arm) => ({
      arm,
      armName: arm.name,
      modelSignature: modelSignatureOf(arm, MODEL_TASKS),
      costKnown: armCostIsKnown(arm, MODEL_TASKS, config.prices),
    }));
    for (const problem of deps.problems) {
      for (
        let sampleIndex = 0;
        sampleIndex < config.reproducibility.sampleCount;
        sampleIndex += 1
      ) {
        units.push(...shared.map((arm) => ({ ...arm, problem, sampleIndex })));
      }
    }
  }
  return units;
}

/** The Strategy_Arm a unit runs under; an arm without one is the Control_Arm. */
function strategyOf(unit: SampleUnit): StrategyArm {
  return unit.arm.strategy ?? 'control';
}

/** Build the record for a sample the harness measured. */
function recordFor(
  unit: SampleUnit,
  sample: SampleResult,
  configHash: string,
  timing: { readonly durationMs: number; readonly completedAtMs: number },
): SweepSampleRecord {
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    configHash,
    armName: unit.armName,
    strategyArm: strategyOf(unit),
    checkingApproach: sample.checkingApproach,
    designGroup: sample.designGroup,
    testbenchParseRefusal: sample.testbenchParseRefusal,
    positiveControlRun: sample.positiveControlRun,
    valuelessFailureReports: sample.valuelessFailureReports,
    testbenchPromptVersion: TESTBENCH_PROMPT_VERSION,
    simulationHarnessVersion: SIMULATION_HARNESS_VERSION,
    modelSignature: unit.modelSignature,
    problemId: unit.problem.id,
    sampleIndex: unit.sampleIndex,
    seed: sample.seed,
    passed: sample.passed,
    outcomeStatus: sample.outcomeStatus,
    iterations: sample.iterations,
    costCents: sample.costCents,
    costKnown: unit.costKnown,
    promptTokens: sample.promptTokens,
    completionTokens: sample.completionTokens,
    totalTokens: sample.totalTokens,
    unreportedUsageCalls: sample.unreportedUsageCalls,
    stopReason: sample.stopReason,
    goldenVerdict: sample.goldenVerdict?.kind ?? null,
    goldenFailureCount: sample.goldenVerdict?.failureCount ?? null,
    instrumentValidity: sample.instrumentVerdict.validity,
    instrumentDefect:
      sample.instrumentVerdict.validity === 'invalid' ? sample.instrumentVerdict.defect : null,
    instrumentUncheckedReason:
      sample.instrumentVerdict.validity === 'unchecked' ? sample.instrumentVerdict.reason : null,
    mutation: recordedMutationCounts(sample.mutationProbe),
    repairAttempted: sample.repairProvenance.attempted,
    repairAccepted: sample.repairProvenance.accepted,
    repairDeclineReason: repairDeclineReasonOf(sample.repairProvenance),
    checkNameVisibilitySignal: sample.checkNameVisibilitySignal,
    // Req 12.11: the roll-up lives in `./results-log.ts` beside the shape it builds, so the
    // precedence `refuted` > `could-not-verify` > `proved` is stated once.
    formal: recordedFormalRun(sample.formal),
    // Req 7.9: copied verbatim from the loop's closed-shape field, and FLAT rather than inside
    // `formal` above, because a run whose oracle port threw records a fallback reason with no
    // submitted property at all.
    formalFallbackReason: sample.formal.fallbackReason,
    // Req 7.21: the route, beside the reason it is the iff of - copied from the same closed
    // field the loop decided, so the record says WHY on every route and not only the one a
    // Could_Not_Verify_Cause drove.
    formalFallbackRoute: sample.formal.fallbackRoute,
    // Req 12.21: the contract the gate emission is a function of. `null` and `{derived:false}`
    // are different facts - never read, never derived here - so both are passed through.
    formalResetContract: sample.formal.resetContract,
    formalAssertionGateEmitted: sample.formal.assertionGateEmitted,
    formalClockPolarity: sample.formal.clockPolarity,
    // Req 10.8: the EVAL-side gate's own measurement, which the harness holds, not the copy
    // the loop received on `sample.formal.propertySetAdmitted`.
    propertySetAdmitted: sample.propertySetAdmitted,
    propertySetAuthoredUpFront: sample.propertySetAuthoredUpFront,
    propertySetSurvivorCount: sample.propertySetSurvivorCount,
    // Req 9.4, 9.6, 9.9: threaded from the same gate run, never re-derived. `null` is "no gate
    // ran", which the summary renders as NOT MEASURED rather than as a zero kill rate.
    formalMutationCounts: sample.formalMutationCounts,
    durationMs: timing.durationMs,
    completedAtMs: timing.completedAtMs,
    // The harness derived this from the loop's own sanitized outcome; it is the only
    // thing a `blocked` / `setup-failed` record can say about WHY, so it is threaded
    // through rather than dropped. `null` for a sample with nothing to explain.
    failureNote: sample.failureNote,
    // Threaded from the harness, which derived it from the loop's TYPED cause - never
    // re-derived from `failureNote` above. This is what decides whether the slot is
    // finished: an infrastructure cause leaves it out of `CompletedSampleIndex`, so the
    // next run takes it again instead of counting an outage as a measurement.
    noVerdictCause: sample.noVerdictCause,
  };
}

/** Build the record for a sample the sweep could not obtain a verdict for. */
function failureRecordFor(
  unit: SampleUnit,
  configHash: string,
  note: string,
  timing: { readonly durationMs: number; readonly completedAtMs: number },
): SweepSampleRecord {
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    configHash,
    armName: unit.armName,
    strategyArm: strategyOf(unit),
    // No sample came back, so the approach is derived with the agent's own pure router.
    checkingApproach: routeCheckingApproach(unit.problem.spec.moduleInterface, strategyOf(unit)),
    designGroup: designGroupOf(unit.problem.spec.moduleInterface),
    testbenchPromptVersion: TESTBENCH_PROMPT_VERSION,
    simulationHarnessVersion: SIMULATION_HARNESS_VERSION,
    testbenchParseRefusal: null,
    positiveControlRun: null,
    // No sample came back, so no testbench was measured: `null`, never `0`.
    valuelessFailureReports: null,
    modelSignature: unit.modelSignature,
    problemId: unit.problem.id,
    sampleIndex: unit.sampleIndex,
    seed: 0,
    passed: false,
    outcomeStatus: 'runner-error',
    iterations: 0,
    costCents: 0,
    costKnown: unit.costKnown,
    // The harness never returned a measured sample, so there is no metered token count to
    // record. Zeros are safe HERE and only here: a `runner-error` sample carries no oracle
    // verdict, so it is excluded from the per-verified-artifact population by the same
    // condition that excludes it from the pass@k denominator, and can neither deflate the
    // token numerator nor inflate the verified divisor.
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    unreportedUsageCalls: 0,
    stopReason: null,
    goldenVerdict: null,
    goldenFailureCount: null,
    // The harness never produced a sample, so nothing was validated. `unchecked` (not
    // `invalid`) is the honest statement, and the record is excluded from the pass@k
    // denominator by its `runner-error` status regardless.
    instrumentValidity: 'unchecked',
    instrumentDefect: null,
    // No testbench exists for a sample the runner itself crashed before producing anything
    // for - the same reason `harness.ts` maps every no-testbench outcome status onto.
    instrumentUncheckedReason: 'no-testbench',
    // Nothing was probed either, so there is no mutation evidence to record.
    mutation: null,
    // The runner crashed before the sample ever reached a repairable point - the same
    // "nothing was ever measured" reason `instrumentValidity: 'unchecked'` above is hardcoded
    // for this path, not a genuine "no repair happened" answer.
    repairAttempted: false,
    repairAccepted: false,
    // No decline was ever measured either - the mirror of `repairAttempted: false` above.
    repairDeclineReason: null,
    // The runner crashed before any testbench was normalized or controlled, so there is no
    // visibility signal to report.
    checkNameVisibilitySignal: false,
    // The runner crashed before the sample reached a candidate, so no Formal_Property was ever
    // submitted and no pre-pass was ever read - the same "nothing was measured" reason
    // `instrumentValidity: 'unchecked'` above is hardcoded for this path. `null` rather than an
    // empty run, and `'not-gated'` rather than `'no-gate-set'`, because no gate ran at all.
    formal: null,
    formalFallbackReason: null,
    // Nothing fell back, because nothing ran: `'not-applicable'` and NOT
    // `'no-property-expressed'`, which would claim a Property_Author was asked and answered
    // with nothing.
    formalFallbackRoute: 'not-applicable',
    formalResetContract: null,
    formalAssertionGateEmitted: false,
    formalClockPolarity: null,
    propertySetAdmitted: 'not-gated',
    propertySetAuthoredUpFront: false,
    // No SampleResult came back, so nothing was authored for it.
    propertySetSurvivorCount: 0,
    // No gate ran, so there is no population to tally - `null` rather than an all-zero tally,
    // which would read as a gate that calibrated mutants and scored none of them.
    formalMutationCounts: null,
    durationMs: timing.durationMs,
    completedAtMs: timing.completedAtMs,
    failureNote: note,
    // Derived through the SAME total classifier the harness uses rather than written as a
    // literal, so `outcomeStatus` and `noVerdictCause` cannot drift apart on this path. A
    // `runner-error` resolves to `harness-error`, which is DEFERRABLE: our own machinery
    // failing says nothing about the model, so the slot must be run again rather than
    // deleted from the matrix. A deterministic crash therefore costs a retry per resume -
    // paid deliberately, because the alternative silently shrinks the matrix (see
    // `../no-verdict-cause.ts`).
    noVerdictCause: noVerdictCauseOf({ status: 'runner-error' }),
  };
}

/**
 * One line of sanitized progress for a completed sample.
 *
 * The failure note is appended when the sample has one, because an operator watching a
 * multi-hour run must see WHY a sample produced no verdict as it happens - not only after
 * the run, by reading the results file.
 */
/**
 * The mutation fragment of a progress line: the kill fraction over VALID mutants.
 *
 * The denominator is stated as `valid` rather than left bare, because it used to be the much
 * smaller golden-detectable set and an operator comparing a new run against an old log needs to
 * see that the fraction is over a different population.
 */
function mutationProgress(mutation: MutationSampleCounts): string {
  const gap = mutation.coverageGapOperators.length;
  return (
    ` mutants-killed=${mutation.killedCount}/${mutation.validCount} valid` +
    (gap > 0 ? ` COVERAGE-GAP=${gap}` : '')
  );
}

function progressLine(
  unit: SampleUnit,
  record: SweepSampleRecord,
  position: string,
  recommendationSuffix: string,
): string {
  const golden = record.goldenVerdict === null ? 'unjudged' : `golden=${record.goldenVerdict}`;
  const why = record.failureNote === null ? '' : ` (${record.failureNote})`;
  // An invalid instrument is the loudest thing in the line, because it means this sample's
  // verdict measured OUR testbench: an operator must see it as it happens, not afterwards.
  const instrument =
    record.instrumentValidity === 'invalid'
      ? ` INSTRUMENT-INVALID(${record.instrumentDefect ?? 'unknown'})`
      : ` instrument=${record.instrumentValidity}`;
  // The kill count is printed as it happens because it is the negative control's whole
  // finding: an operator watching a long run must see a testbench letting mutants through
  // while there is still time to stop the campaign, not only in the summary afterwards. The
  // coverage-gap count rides along because it is the actionable half of the survivors.
  const mutation = record.mutation === null ? '' : mutationProgress(record.mutation);
  return (
    `${position} arm=${unit.armName} ${unit.problem.id} #${unit.sampleIndex} -> ` +
    `${record.outcomeStatus} iters=${record.iterations} ${golden}${instrument}${mutation}${why}` +
    recommendationSuffix
  );
}

/** The mutable progress the pool shares; the runner is its single owner. */
interface RunState {
  dispatched: number;
  recorded: number;
  failed: number;
  stop: SweepStopReason | null;
  /**
   * Workers currently HOLDING a unit (mid-flight, between admission and persistence).
   *
   * This, not the number of `#worker` loops, is what admission is gated on: the loop
   * count is the fixed ceiling started by `Promise.all`, while this count rises and falls
   * as the governor's recommendation moves, which is what lets a withheld worker resume
   * later instead of exiting for good.
   */
  holding: number;
}

/**
 * What one admission request resolves to.
 *
 * A worker whose request resolves to `'exhausted'` is done for good - the plan has
 * nothing left for it and it may safely return. A request that resolves to `'withheld'`
 * means work remains but the recommendation has no room right now: the worker must wait
 * and re-ask, never exit, or a unit at the tail of a reduced run would never be picked up
 * once the recommendation recovers. Only an admitted request consumes a unit from the
 * plan, so a withheld worker never holds a unit it then has to discard.
 */
type AdmissionResult =
  | { readonly kind: 'admitted'; readonly unit: SampleUnit }
  | { readonly kind: 'withheld' }
  | { readonly kind: 'exhausted' };

/**
 * The sweep runner.
 *
 * Constructed with everything it needs; `run` executes the plan once and returns what it
 * did. It owns the run counters and nothing else - the arms' stacks, the log, the
 * breaker, and the clock are all injected.
 */
export class SweepRunner {
  readonly #deps: SweepRunnerDeps;
  readonly #runnerByArm = new Map<string, EvalLoopRunner>();
  readonly #artifactSinkByArm = new Map<string, EvalArtifactSink>();
  readonly #propertyAuthorByArm = new Map<string, (problem: EvalProblem) => PropertySetSource>();

  constructor(deps: SweepRunnerDeps) {
    this.#deps = deps;
  }

  /**
   * Execute the planned matrix, honoring resume, concurrency, and every bound.
   *
   * Every arm's stack is built BEFORE the first dispatch, so a wiring mistake in any arm
   * (a bad region, an unusable model id) throws here with nothing spent, rather than
   * three arms into the matrix.
   */
  async run(): Promise<SweepRunResult> {
    this.#prepareArms();
    await this.#deps.writeManifest();
    const planned = planUnits(this.#deps);
    const outstanding = planned.filter(
      (unit) => !this.#deps.completed.isComplete(unit.armName, unit.problem.id, unit.sampleIndex),
    );
    const skipped = planned.length - outstanding.length;
    this.#deps.onProgress(
      `planned ${planned.length} samples; ${skipped} already recorded for this config; ` +
        `${outstanding.length} to run at concurrency ${this.#deps.config.concurrency}` +
        this.#recommendationSuffix(),
    );
    const state: RunState = { dispatched: 0, recorded: 0, failed: 0, stop: null, holding: 0 };
    await this.#drain(outstanding, state);
    return {
      stopReason: state.stop ?? 'completed',
      plannedSamples: planned.length,
      skippedSamples: skipped,
      dispatchedSamples: state.dispatched,
      recordedSamples: state.recorded,
      failedSamples: state.failed,
    };
  }

  /** Run the outstanding units through a fixed-size worker pool. */
  async #drain(units: readonly SampleUnit[], state: RunState): Promise<void> {
    let nextIndex = 0;
    // Consumes a unit from the plan ONLY when admission is granted (see `AdmissionResult`),
    // so a withheld worker never holds a unit it would then have to leave unrecorded.
    const requestAdmission = (): AdmissionResult => {
      const stop = this.#deps.killSwitch.shouldStop({
        dispatchedSamples: state.dispatched,
        providerOutage: this.#deps.outage(),
      });
      if (stop !== null) {
        state.stop = state.stop ?? stop;
        return { kind: 'exhausted' };
      }
      if (state.stop !== null || nextIndex >= units.length) {
        return { kind: 'exhausted' };
      }
      // The floor: admitting anyway when nothing is currently holding is what makes a
      // reduction a slowdown rather than a deadlock, per Requirement 7.5 - zero active
      // workers while work remains is the one state the recommendation may never produce.
      const recommended = this.#deps.governor.recommendedConcurrency();
      if (state.holding >= recommended && state.holding > 0) {
        return { kind: 'withheld' };
      }
      const unit = units[nextIndex];
      nextIndex += 1;
      if (unit === undefined) {
        return { kind: 'exhausted' };
      }
      return { kind: 'admitted', unit };
    };
    const workerCount = Math.max(1, Math.min(this.#deps.config.concurrency, units.length));
    await Promise.all(
      Array.from({ length: workerCount }, () =>
        this.#worker(requestAdmission, units.length, state),
      ),
    );
  }

  /**
   * One pool worker: hold at most one unit at a time, waiting and re-asking when the
   * recommendation currently has no room, and exiting only once the plan is exhausted.
   */
  async #worker(
    requestAdmission: () => AdmissionResult,
    total: number,
    state: RunState,
  ): Promise<void> {
    for (;;) {
      const admission = requestAdmission();
      if (admission.kind === 'exhausted') {
        return;
      }
      if (admission.kind === 'withheld') {
        await this.#deps.waitMs(ADMISSION_POLL_MS);
        continue;
      }
      const unit = admission.unit;
      state.holding += 1;
      try {
        state.dispatched += 1;
        const position = `[${state.dispatched}/${total}]`;
        const record = await this.#runUnit(unit);
        if (NO_VERDICT_STATUSES.includes(record.outcomeStatus)) {
          state.failed += 1;
        }
        const persisted = await this.#persist(record, state);
        if (!persisted) {
          return;
        }
        state.recorded += 1;
        this.#deps.onProgress(progressLine(unit, record, position, this.#recommendationSuffix()));
      } finally {
        // Released whether the sample succeeded, failed, or the log write failed: a
        // worker that is about to return must not leave a phantom holder behind, or the
        // remaining workers would compute admission against a count nothing will ever
        // decrement.
        state.holding -= 1;
      }
    }
  }

  /** The `" (recommended concurrency N)"` suffix, or empty when there is nothing to report. */
  #recommendationSuffix(): string {
    const recommended = this.#deps.governor.recommendedConcurrency();
    return recommended === this.#deps.config.concurrency
      ? ''
      : ` (recommended concurrency ${recommended})`;
  }

  /**
   * Append one record, stopping the run when it cannot be persisted.
   *
   * A results log we cannot write to means every subsequent sample would be paid for and
   * lost, so this is one of the few conditions worth ending the run over.
   */
  async #persist(record: SweepSampleRecord, state: RunState): Promise<boolean> {
    try {
      await this.#deps.resultsLog.appendLine(encodeSampleRecord(record));
      return true;
    } catch {
      // The underlying error names a path and an errno; it is classified rather than
      // surfaced, and the stop reason tells the operator exactly what to fix.
      state.stop = state.stop ?? 'results-log-unwritable';
      this.#deps.onProgress('a results record could not be appended; stopping the run');
      return false;
    }
  }

  /**
   * Run one sample through the harness and turn it into a record.
   *
   * Never throws: a harness or provider failure becomes a recorded failed sample with a
   * sanitized note, because one bad sample must not end a matrix that has hours invested
   * in it.
   */
  async #runUnit(unit: SampleUnit): Promise<SweepSampleRecord> {
    const startedAtMs = this.#deps.now();
    try {
      const sample = await this.#measure(unit);
      const timing = this.#timing(startedAtMs);
      return sample === null
        ? failureRecordFor(unit, this.#deps.configHash, 'harness-returned-no-sample', timing)
        : recordFor(unit, sample, this.#deps.configHash, timing);
    } catch {
      // Sanitized and fail-safe: the thrown detail can carry a host or a stack trace and
      // never enters a persisted record.
      return failureRecordFor(
        unit,
        this.#deps.configHash,
        'harness-error',
        this.#timing(startedAtMs),
      );
    }
  }

  /** Duration and completion instant for one sample. */
  #timing(startedAtMs: number): { readonly durationMs: number; readonly completedAtMs: number } {
    const completedAtMs = this.#deps.now();
    return { durationMs: Math.max(0, completedAtMs - startedAtMs), completedAtMs };
  }

  /**
   * Measure exactly one sample slot through the Eval_Harness.
   *
   * The returned report covers only the scheduled slot (every other slot is declined),
   * so ONLY that sample is read out of it; its aggregate pass@k is meaningless by
   * construction and is never used - the summary computes pass@k from the persisted
   * records instead.
   */
  async #measure(unit: SampleUnit): Promise<SampleResult | null> {
    const { config } = this.#deps;
    const slot = { problemId: unit.problem.id, sampleIndex: unit.sampleIndex };
    const armSink = this.#artifactSinkByArm.get(unit.arm.name);
    // Scoped to the scheduled slot for the same reason the loop runner is: the harness
    // measures every slot of the problem, and a DECLINED slot must leave no evidence behind
    // claiming it failed setup.
    const artifactSink = armSink === undefined ? undefined : captureOneSample(armSink, slot);
    const formalGate = this.#deps.propertySetGate;
    const propertySetSourceFor = this.#propertyAuthorByArm.get(unit.arm.name);
    const built = createEvalHarness({
      loopRunner: scheduleOneSample(this.#armRunner(unit.arm), slot),
      caps: config.caps,
      limits: config.limits,
      config: config.reproducibility,
      costEnvelopeCents: config.costEnvelopeCents,
      ks: config.ks,
      strategyArm: strategyOf(unit),
      ...(this.#deps.goldenJudge === null ? {} : { goldenJudge: this.#deps.goldenJudge }),
      ...(this.#deps.instrumentControl === null
        ? {}
        : { instrumentControl: this.#deps.instrumentControl }),
      ...(artifactSink === undefined ? {} : { artifactSink }),
      // Both halves or neither: the harness authors up front ONLY where a gate is also wired,
      // so handing it one without the other spends a gate that has no Property_Set to score.
      // ponytail: neither seam carries the sample index, so unlike the loop runner and the
      // artifact sink these are NOT scoped to the scheduled slot - the harness authors and
      // gates every slot of the problem, so sampleCount n pays n times per dispatched sample.
      // Closing it needs a `sampleIndex` on `propertySetSourceFor` and `PropertySetGateRequest`.
      ...(formalGate === undefined || propertySetSourceFor === undefined
        ? {}
        : { propertySetGate: formalGate.gate, propertySetSourceFor }),
    });
    if (!built.ok) {
      // Unreachable in a validated run: the CLI builds a probe harness before dispatching
      // anything, so a failure here means the caps or ks changed underneath us.
      return null;
    }
    const report = await built.value.run([unit.problem]);
    const problem = report.problems[0];
    return problem?.samples.find((sample) => sample.sampleIndex === unit.sampleIndex) ?? null;
  }

  /** Build every arm's collaborators up front, so a wiring mistake costs nothing. */
  #prepareArms(): void {
    const artifactSinkFor = this.#deps.artifactSinkFor;
    const propertySetGate = this.#deps.propertySetGate;
    for (const arm of this.#deps.config.arms) {
      this.#runnerByArm.set(arm.name, this.#deps.loopRunnerFor(arm));
      if (artifactSinkFor !== undefined) {
        this.#artifactSinkByArm.set(arm.name, artifactSinkFor(arm));
      }
      if (propertySetGate !== undefined) {
        this.#propertyAuthorByArm.set(arm.name, propertySetGate.sourceFor(arm));
      }
    }
  }

  /**
   * The arm's loop runner, built once in `#prepareArms` and shared by that arm's
   * concurrent samples - safe because it holds no per-sample state.
   */
  #armRunner(arm: SweepArmConfig): EvalLoopRunner {
    const runner = this.#runnerByArm.get(arm.name);
    if (runner === undefined) {
      // Unreachable: `#prepareArms` covers every configured arm and arm names are unique.
      throw new Error('Sweep runner error: no loop runner was prepared for this arm');
    }
    return runner;
  }
}
