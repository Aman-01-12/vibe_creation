// The Eval_Harness (Req 15.1, 15.2, 15.3, 15.5, 15.6, 15.10, 17.3).
//
// The harness runs the fixed VerilogEval/RTLLM subset through the Verification_Loop
// inside the Tool_Runner sandbox, under the SAME student-session caps a real
// student gets, and reports plus records pass@k, iterations-to-pass, and per-session
// cost - all with fixed seeds, temperature, and sample count so the numbers are
// reproducible run-to-run.
//
// Division of responsibility (the model never decides correctness, Req 15.3, 15.5):
// the harness orchestrates and measures; the injected `EvalLoopRunner` drives one
// sample through the loop; and inside that loop the Simulator ORACLE decides
// pass/fail. A sample "passed" here means exactly one thing - the loop returned a
// `verified` outcome, which the Verification_Loop only produces when a passing
// oracle verdict was recorded and bound by the Trust_Labeler. The harness reads that
// status; it never inspects or trusts model output.
//
// Two OPTIONAL checks sit beside that verdict and neither may change it:
//   - the independent golden judge scores the same candidate with a benchmark testbench
//     we did not write, so pass@k is not self-graded (`./golden-judge.ts`);
//   - the positive control runs OUR OWN testbench against the benchmark's known-good
//     reference design, so a sample judged by a broken instrument is identified rather
//     than counted as a model failure (`./instrument-control.ts`).
// Both run only AFTER the sample is measured, receive no budget handle, and make no model
// call, so neither can move a measured number.
//
// A THIRD optional check gates the OTHER instrument, and this one runs BEFORE the sample:
//   - the Property_Set gate scores a Property_Set against single-operator mutants of that
//     same reference design, and a Property_Set that PROVES a mutant the independent judge
//     killed is refused as inadmissible (`./property-set-admission.ts`). A refused sample is
//     decided by the Simulation_Fallback rather than by the refused Property_Set (Req 10.3),
//     which is a decision about which INSTRUMENT may speak and so has to be made before the
//     run rather than after it. It still makes no model call and gets no budget handle.

//
// Determinism (Req 15.10): the subset is iterated in order, samples in index order,
// each sample's seed is derived deterministically from the base seed, and every
// reported number is a pure function of the samples. Given a deterministic loop
// runner, two runs of the same subset produce byte-identical reports.
//
// Every collaborator is injected (loop runner, caps, limits, config, recorder, id
// source); there are no globals and no provider SDKs here.

import {
  makeSessionBudget,
  newUlid,
  ok,
  err,
  domainError,
  type DomainError,
  type Result,
  type SessionBudget,
  type Ulid,
} from '@app/core';
import {
  designGroupOf,
  NO_FORMAL_RUN,
  NO_REPAIR,
  requiredChecksFor,
  routeCheckingApproach,
  type FormalProvenance,
  type TestbenchParseRefusal,
  type StrategyArm,
  type PropertySetAdmissionOutcome,
  type RepairProvenance,
  type PropertySetSource,
} from '@app/agent';
import { readCheckSignals, type ResourceLimits } from '@app/tools';

import {
  candidateRtlOf,
  captureSampleArtifacts,
  normalizationOf,
  testbenchSourceOf,
  type CapturedOutcome,
  type EvalArtifactSink,
} from './artifact-sink.js';
import { failureNoteOf } from './failure-note.js';
import {
  summarizeAgreement,
  type GoldenJudge,
  type RecordedGoldenVerdict,
  type VerdictPair,
} from './golden-judge.js';
import { AdmissionStampingPropertySource } from './admission-stamping-property-source.js';
import { MemoizingInstrumentAdmission } from './instrument-admission.js';
import { MemoizingPropertySetSource } from './memoizing-property-set-source.js';
import {
  summarizeInstrumentControl,
  uncheckedInstrument,
  type InstrumentControl,
  type InstrumentControlResult,
  type InstrumentSample,
  type InstrumentUncheckedReason,
} from './instrument-control.js';
import {
  recordedMutationCounts,
  summarizeMutationControl,
  type MutationSample,
} from './mutation-control.js';
import { noVerdictCauseOf } from './no-verdict-cause.js';
import {
  admitPropertySet,
  formalMutationCounts,
  propertySetAdmissionOutcomeOf,
  propertySetSurvivorCountOf,
  type FormalMutationCounts,
  type PropertySetAdmission,
  type PropertySetGate,
} from './property-set-admission.js';
import { MeteredSessionBudget } from './metered-budget.js';
import { sampleSeed, type ReproducibilityConfig } from './reproducibility.js';
import { meanPassAtK, passAtK } from './metrics.js';
import type { EvalProblem } from './problem.js';
import type { EvalLoopRunner, StudentSessionCaps } from './loop-runner.js';

import type {
  CostEnvelopeReport,
  CostViolation,
  EvalRunRecorder,
  EvalRunReport,
  ProblemResult,
  SampleResult,
  PositiveControlRunSummary,
} from './report.js';

/** The injected collaborators and configuration for the harness; no globals. */
export interface EvalHarnessDeps {
  /** Drives one sample through the Verification_Loop in the sandbox. */
  readonly loopRunner: EvalLoopRunner;
  /** The student-session budget caps every sample runs under (Req 15.2, 15.6). */
  readonly caps: StudentSessionCaps;
  /** The sandbox resource limits, identical to a student session (Req 15.6). */
  readonly limits: ResourceLimits;
  /** Fixed seeds/temperature/sample count for reproducibility (Req 15.10). */
  readonly config: ReproducibilityConfig;
  /** The pennies-per-session cost envelope asserted for every session (Req 15.6, 17.3). */
  readonly costEnvelopeCents: number;
  /** The k values to report pass@k for; defaults to `[config.sampleCount]`. */
  readonly ks?: readonly number[];
  /** Optional sink that records each run so metrics track over time (Req 15.5). */
  readonly recorder?: EvalRunRecorder;
  /**
   * Optional per-problem Property_Author, used ONLY where a Property_Set_Gate is also wired.
   *
   * The gate scores a Property_Set against reference mutants and the loop reasons with it, so
   * both have to be handed the SAME artifact; see design.md, Component 11a. An ungated run
   * never calls this, with or without it supplied, which is what keeps the shipping path the
   * one the student session takes (Req 6.2).
   */
  readonly propertySetSourceFor?: (problem: EvalProblem) => PropertySetSource;
  /**
   * Optional INDEPENDENT judge scoring each sample's candidate against a
   * benchmark-supplied golden testbench.
   *
   * When wired, every sample records the loop's own verdict AND the golden one, and
   * the report carries their agreement rate - the empirical measure of whether the
   * agent's own testbenches catch bugs. When absent, `goldenVerdict` is `null`
   * everywhere and the agreement report is zeroed ("not measured"), so a run without
   * a judge is never mistaken for a run with perfect agreement.
   */
  readonly goldenJudge?: GoldenJudge;
  /**
   * Optional POSITIVE CONTROL validating each sample's own testbench.
   *
   * After the loop finishes, the SAME generated testbench that judged the candidate is run
   * against the problem's known-good REFERENCE design. A reference that fails our testbench
   * proves the instrument is broken, so the sample measured nothing about the model and is
   * excluded from the pass@k denominator (see `./instrument-control.ts`).
   *
   * Deterministic and free of model calls: it consumes no session budget, adds no
   * iteration, and cannot move a measured number. When absent, every sample's instrument is
   * `unchecked` and the run's control report is zeroed ("not measured"), so a run without a
   * control is never mistaken for a run whose instruments were all sound.
   */
  readonly instrumentControl?: InstrumentControl;
  /**
   * Optional sink each sample's inputs and oracle evidence are persisted through.
   *
   * Purely additive observability: when absent, nothing is derived and nothing is written,
   * and the run behaves exactly as it did before this seam existed. When wired, capture
   * happens only AFTER the sample is fully measured, so no artifact can change a measured
   * number (see `#captureArtifacts` and `./artifact-sink.ts`).
   */
  readonly artifactSink?: EvalArtifactSink;
  /**
   * Optional gate on the PROPERTY SET, the other instrument a sample can be decided by.
   *
   * `instrumentControl` above validates the TESTBENCH against the reference design; this
   * scores the Property_Set against single-operator MUTANTS of that same reference, and a
   * Property_Set that PROVES a mutant the independent judge killed is refused as
   * inadmissible. A refused sample is then decided by the Simulation_Fallback rather than by
   * the refused Property_Set (Req 10.3).
   *
   * It lives here rather than in `app/agent` because it reads a reference design and a
   * student session has none (Req 10.7), and because `app/agent` holds no import of
   * `app/eval` (Req 11.11, 13.6). When absent, every sample's Property_Set is `'not-gated'`
   * and nothing falls back, so a run without a gate is never mistaken for a run whose
   * Property_Sets were all admitted.
   *
   * Deterministic and free of model calls, like both controls above: it runs before the
   * sample's own verdict is reached, receives no budget handle, and adds no iteration.
   */
  readonly propertySetGate?: PropertySetGate;
  /** ULID source for per-session budget ids; defaults to `newUlid`. */
  readonly newId?: () => Ulid;
  /** The Strategy_Arm every sample runs under; `control` when absent, as on the Student_Path. */
  readonly strategyArm?: StrategyArm;
}

/** The validated, resolved configuration the harness runs with. */
interface ResolvedConfig {
  readonly loopRunner: EvalLoopRunner;
  readonly caps: StudentSessionCaps;
  readonly limits: ResourceLimits;
  readonly config: ReproducibilityConfig;
  readonly costEnvelopeCents: number;
  readonly ks: readonly number[];
  readonly recorder: EvalRunRecorder | null;
  readonly goldenJudge: GoldenJudge | null;
  readonly instrumentControl: InstrumentControl | null;
  readonly artifactSink: EvalArtifactSink | null;
  readonly propertySetGate: PropertySetGate | null;
  /** The per-problem Property_Author, or `null` where no run authors up front. */
  readonly propertySetSourceFor: ((problem: EvalProblem) => PropertySetSource) | null;
  readonly newId: () => Ulid;
  readonly strategyArm: StrategyArm;
}

/**
 * Construct an `EvalHarness`, validating the reported k values, the cost envelope,
 * and the student caps up front so a run can never start with a config that would
 * make pass@k or the cost assertion ill-defined.
 *
 * Returns a `DomainError` for an out-of-range k (must be an integer in
 * [1, sampleCount]), a negative or non-finite cost envelope, or caps that do not
 * form a valid `SessionBudget`.
 */
export function createEvalHarness(deps: EvalHarnessDeps): Result<EvalHarness, DomainError> {
  const newId = deps.newId ?? newUlid;
  const ks = resolveKs(deps.ks, deps.config.sampleCount);
  const ksError = validateKs(ks, deps.config.sampleCount);
  if (ksError !== null) {
    return err(ksError);
  }
  if (!Number.isFinite(deps.costEnvelopeCents) || deps.costEnvelopeCents < 0) {
    return err(
      domainError(
        'EVAL_COST_ENVELOPE_INVALID',
        'costEnvelopeCents must be a non-negative finite number',
        'costEnvelopeCents',
      ),
    );
  }
  const capsError = validateCaps(deps.caps, newId);
  if (capsError !== null) {
    return err(capsError);
  }
  return ok(
    new EvalHarness({
      loopRunner: deps.loopRunner,
      caps: deps.caps,
      limits: deps.limits,
      config: deps.config,
      costEnvelopeCents: deps.costEnvelopeCents,
      ks,
      recorder: deps.recorder ?? null,
      goldenJudge: deps.goldenJudge ?? null,
      instrumentControl: deps.instrumentControl ?? null,
      artifactSink: deps.artifactSink ?? null,
      propertySetGate: deps.propertySetGate ?? null,
      propertySetSourceFor: deps.propertySetSourceFor ?? null,
      newId,
      strategyArm: deps.strategyArm ?? 'control',
    }),
  );
}

/**
 * The Eval_Harness.
 *
 * `run` executes the whole subset and returns (and optionally records) the report.
 * Construct it through `createEvalHarness`, which validates its configuration.
 */
export class EvalHarness {
  readonly #resolved: ResolvedConfig;

  constructor(resolved: ResolvedConfig) {
    this.#resolved = resolved;
  }

  /**
   * Run the fixed subset and produce the report (Req 15.1, 15.2).
   *
   * Problems and their samples run sequentially in a fixed order so the sandbox is
   * never flooded and the run is deterministic. The oracle-decided per-sample
   * verdicts drive pass@k, iterations-to-pass, and the per-session cost envelope;
   * the report is recorded when a recorder is wired (Req 15.5).
   */
  async run(subset: readonly EvalProblem[]): Promise<EvalRunReport> {
    const problems: ProblemResult[] = [];
    for (const problem of subset) {
      problems.push(await this.#runProblem(problem));
    }
    const report = this.#assembleReport(problems);
    if (this.#resolved.recorder !== null) {
      await this.#resolved.recorder.record(report);
    }
    return report;
  }

  /** Run every sample of one problem and aggregate its pass@k, iterations, and cost. */
  async #runProblem(problem: EvalProblem): Promise<ProblemResult> {
    const samples: SampleResult[] = [];
    for (let sampleIndex = 0; sampleIndex < this.#resolved.config.sampleCount; sampleIndex += 1) {
      samples.push(await this.#runSample(problem, sampleIndex));
    }
    return this.#aggregateProblem(problem, samples);
  }

  /** Aggregate one problem's samples into its `ProblemResult` (pure). */
  #aggregateProblem(problem: EvalProblem, samples: readonly SampleResult[]): ProblemResult {
    const sampleCount = samples.length;
    const passCount = samples.filter((sample) => sample.passed).length;
    const passAtKByK: Record<number, number> = {};
    for (const k of this.#resolved.ks) {
      passAtKByK[k] = passAtK(sampleCount, passCount, k);
    }
    const firstPass = samples.find((sample) => sample.passed);
    const maxCostCents = samples.reduce((max, sample) => Math.max(max, sample.costCents), 0);
    return {
      problemId: problem.id,
      title: problem.title,
      source: problem.source,
      sampleCount,
      passCount,
      passAtK: passAtKByK,
      iterationsToPass: firstPass ? firstPass.iterations : null,
      maxCostCents,
      samples,
    };
  }

  /**
   * Run one sample (one student session) through the loop and measure it.
   *
   * The budget is read BEFORE the independent judge and the positive control run, and
   * neither is given the budget handle, so neither can consume a student session's
   * allowance or move `costCents`. Both are deterministic, make no model call, and count as
   * neither a sample nor an iteration: `iterations` comes from the loop's own outcome.
   */
  async #runSample(problem: EvalProblem, sampleIndex: number): Promise<SampleResult> {
    const seed = sampleSeed(this.#resolved.config, problem.id, sampleIndex);
    const budget = this.#freshBudget();
    const admission = this.#buildAdmission(problem);
    // BEFORE the loop runs, because the decision it produces is an INPUT to the run: a
    // refused Property_Set must not be given the chance to decide this sample (Req 10.1,
    // 10.3). On a GATED run this now makes one model call, the up-front authoring, and it is
    // charged to this sample's own budget handle under FL-18 option (a) - so `costCents` and
    // `totalTokens` carry it rather than it being spent off the books. The gate itself still
    // makes none; see design.md, Component 10.
    const authored = this.#authorPropertySet(problem);
    const propertySet = recordedPropertySetAdmission(
      await this.#gatePropertySet(problem, authored, budget),
    );
    // The loop receives the set already stamped with the gate's decision, which is what makes
    // the loop's own refusal guard reachable on a gated run (Component 11b).
    const propertySetSource =
      authored === null ? null : new AdmissionStampingPropertySource(authored, propertySet.outcome);
    const outcome = await this.#drive(
      problem,
      sampleIndex,
      seed,
      budget,
      admission,
      propertySet,
      propertySetSource,
    );
    // Req 7.10: read once the loop has returned; no repair-and-recheck sequence is
    // held open, because none can occur.
    const consumed = budget.consumed();
    const stopReason = budget.stopReason();
    // Prefer the result the loop's own admission check already produced over the instrument
    // (Req 4.12, 4.14): the loop consults `admission.admit` at most once, before its first
    // iteration, and `recorded()` hands back the exact `InstrumentControlResult` that decision
    // came from. Re-running `#controlInstrument` on top of that would run the control a SECOND
    // time for the same sample, which Req 4.12 forbids. Only when nothing was recorded - no
    // admission was wired, or the runner never actually consulted it (e.g. a precheck failure
    // returned Instrument_Refused before admission was ever reached) - does this fall back to
    // the pre-existing after-the-loop control, unchanged.
    const control = admission?.recorded() ?? (await this.#controlInstrument(problem, outcome));
    const sample: SampleResult = {
      sampleIndex,
      seed,
      passed: outcome.status === 'verified',
      outcomeStatus: outcome.status,
      failureNote: sampleFailureNote(outcome),
      noVerdictCause: noVerdictCauseOf(outcome),
      iterations: iterationsOf(outcome),
      costCents: consumed.costCents,
      promptTokens: consumed.promptTokens,
      completionTokens: consumed.completionTokens,
      totalTokens: consumed.tokens,
      unreportedUsageCalls: consumed.unreportedUsageCalls,
      stopReason,
      goldenVerdict: await this.#judgeIndependently(problem, outcome),
      instrumentVerdict: control.verdict,
      mutationProbe: control.mutation,
      // Req 10.8: the gate's own outcome and the count that makes a refusal readable. Both
      // are derived from the ONE admission `#gatePropertySet` produced, so the member and
      // the number cannot disagree about the same run.
      propertySetAdmitted: propertySet.outcome,
      // Read from the AUTHOR, never from the admission outcome: a gate that found no reference
      // design, or that threw, records `not-gated` after this sample already paid for the
      // authoring, so the outcome cannot tell the two apart and this field is what does.
      propertySetAuthoredUpFront: authored !== null,
      // Read from the author itself, not from the admission outcome: a gate that found no
      // reference, or threw, records `not-gated` after this sample already paid for the authoring.
      propertySetSurvivorCount: propertySet.survivorCount,
      // Req 9.4, 9.6, 9.9: the SAME gate run's own mutant tally, including the mutants the
      // oracle could not reason about - the count that previously died with the population.
      formalMutationCounts: propertySet.mutationCounts,
      // Req 1.6: COPIED from what the loop returned, never re-derived from acceptance.
      repairProvenance: repairProvenanceOf(outcome),
      // Req 7.9, 12.11, 12.21: COPIED from what the loop returned too. The loop decided this
      // sample from these values, so re-deriving them here could disagree with `passed` above.
      formal: formalProvenanceOf(outcome),
      // Req 5.8, 5.11: computed LAST, after every verdict field above is already
      // decided, from the same `outcome`/`control` this method already holds - see
      // `checkNameVisibilitySignalOf`'s own comment for why this changes nothing.
      checkNameVisibilitySignal: checkNameVisibilitySignalOf(outcome, control),
      testbenchParseRefusal: parseRefusalOf(outcome),
      // COPIED from the loop's own provenance, never recomputed here: a second reading could
      // disagree with the source the Positive_Control was run against (Req 5.3).
      valuelessFailureReports: normalizationOf(outcome)?.valuelessFailureReports ?? null,
      positiveControlRun: positiveControlRunOf(control, this.#knownAnswerNames(problem)),
      // Derived with the agent's own pure router over the same Spec and arm, so it equals the
      // approach the agent took whether or not a testbench was generated (Req 1.8).
      checkingApproach: routeCheckingApproach(
        problem.spec.moduleInterface,
        this.#resolved.strategyArm,
      ),
      designGroup: designGroupOf(problem.spec.moduleInterface),
    };
    await this.#captureArtifacts(problem, sample, outcome, control);
    return sample;
  }

  /**
   * Run the POSITIVE CONTROL: does the known-good reference design pass OUR testbench?
   *
   * Total by construction - it always returns a result, never `null` and never a throw - so
   * a sample can never be missing an instrument verdict. Every path that cannot produce a
   * real verdict degrades to `unchecked` with its reason recorded:
   *   - no control wired            -> `control-absent`
   *   - the loop produced no testbench (`blocked`, `setup-failed`, `runner-error`)
   *                                 -> `no-testbench`
   *   - the control has no reference for this problem -> `no-reference`
   *   - the control threw           -> `control-unavailable`
   *
   * The last one is the important guarantee: a control failure must never change the loop's
   * own oracle verdict, never change the golden verdict, and never end a campaign that has
   * hours invested in it. It can only ever move the sample OUT of the pass@k denominator,
   * which is the fail-safe direction.
   */
  async #controlInstrument(
    problem: EvalProblem,
    outcome: DriveOutcome,
  ): Promise<InstrumentControlResult> {
    const control = this.#resolved.instrumentControl;
    if (control === null) {
      return uncheckedControl('control-absent');
    }
    const testbench = testbenchSourceOf(outcome);
    if (testbench === null) {
      return uncheckedControl('no-testbench');
    }
    try {
      const result = await control.check({
        problemId: problem.id,
        testbench,
        // The control runs under the SAME sandbox caps as the loop's own oracle.
        limits: this.#resolved.limits,
        requiredCheckNames: this.#requiredCheckNames(problem),
      });
      return result ?? uncheckedControl('no-reference');
    } catch {
      // Sanitized, fail-safe: the control's error detail never enters the report, and the
      // instrument stays unproven rather than being declared sound on a broken run.
      return uncheckedControl('control-unavailable');
    }
  }

  /**
   * Persist this sample's inputs and oracle evidence through the artifact sink (Req 15.5).
   *
   * Runs AFTER the sample is measured and returns the measured result unchanged, so a
   * write can never move a number. Any throw from the sink is caught: an overnight
   * campaign must not die because a diagnostic file could not be written, and a sample's
   * oracle verdict stands whether or not its evidence reached disk. The production sink
   * reports its own failed writes as a sanitized note through the sweep's progress sink;
   * this catch is the PORT guard for an implementation that throws instead.
   */
  async #captureArtifacts(
    problem: EvalProblem,
    sample: SampleResult,
    outcome: CapturedOutcome,
    control: InstrumentControlResult,
  ): Promise<void> {
    const sink = this.#resolved.artifactSink;
    if (sink === null) {
      return;
    }
    // The hint and the pre-repair source are no longer supplied as separate parallel
    // parameters (task 1.5's stopgap): `captureSampleArtifacts` derives both itself from
    // `sample.repairProvenance` - the same provenance the loop returned, copied verbatim -
    // so a hint and a provenance can no longer disagree (task 1.7).
    try {
      await sink.write(
        { problemId: problem.id, sampleIndex: sample.sampleIndex, seed: sample.seed },
        captureSampleArtifacts({ outcome, measured: sample, control }),
      );
    } catch {
      // Sanitized and fail-safe: the sink's error detail routinely names a path and an
      // errno, so it is neither read nor propagated.
    }
  }

  /**
   * Ask the independent judge for a second verdict on this sample's candidate.
   *
   * Returns `null` when there is nothing to judge - no judge wired, or an outcome
   * that produced no RTL at all (`blocked`, `setup-failed`, `runner-error`) - so an
   * unjudgeable sample is excluded from the agreement rate rather than counted as
   * agreement. A judge that throws yields `null` too: a failure to obtain the second
   * opinion must never change the loop's own recorded verdict or abort the run.
   */
  async #judgeIndependently(
    problem: EvalProblem,
    outcome: DriveOutcome,
  ): Promise<RecordedGoldenVerdict | null> {
    const judge = this.#resolved.goldenJudge;
    if (judge === null) {
      return null;
    }
    const rtl = candidateRtlOf(outcome);
    if (rtl === null) {
      return null;
    }
    try {
      return await judge.judge({
        problemId: problem.id,
        rtl,
        // The judge runs under the SAME sandbox caps as the loop's own oracle.
        limits: this.#resolved.limits,
      });
    } catch {
      // Sanitized, fail-safe: the judge's error detail never enters the report, and
      // the sample stays unjudged rather than being scored on a broken run.
      return null;
    }
  }

  /**
   * Drive one sample through the loop runner, failing safe on any throw.
   *
   * A runner that throws (a sandbox contract failure, an unexpected provider error)
   * must never abort the whole eval run: the sample is classified `runner-error` and
   * treated as a non-pass, so the harness still produces a complete report.
   */
  async #drive(
    problem: EvalProblem,
    sampleIndex: number,
    seed: number,
    budget: MeteredSessionBudget,
    admission: MemoizingInstrumentAdmission | null,
    propertySet: RecordedPropertySetAdmission,
    propertySetSource: AdmissionStampingPropertySource | null,
  ): Promise<DriveOutcome> {
    try {
      return await this.#resolved.loopRunner.runSample({
        problem,
        sampleIndex,
        seed,
        temperature: this.#resolved.config.temperature,
        budget,
        limits: this.#resolved.limits,
        strategyArm: this.#resolved.strategyArm,
        ...(admission === null ? {} : { instrumentAdmission: admission }),
        // THE SIGNAL, AND WHY IT IS OMITTED RATHER THAN SENT AS `'not-gated'`: absent means
        // no gate was wired, which is the exact fact `'not-gated'` carries, and the loop
        // already defaults to it. Sending it would make this request shape differ between a
        // gated and an ungated run over a value that means the same thing in both.
        ...(this.#resolved.propertySetGate === null
          ? {}
          : { propertySetAdmitted: propertySet.outcome }),
        // Omitted rather than passed as `null` for the same reason the outcome is: absent means
        // the loop builds its own author, which is the ungated shipping path.
        ...(propertySetSource === null ? {} : { propertySetSource }),
      });
    } catch {
      // Sanitized, fail-safe: the runner's error detail never enters the report.
      return { status: 'runner-error' };
    }
  }

  /**
   * This sample's up-front Property_Author, or `null` where nothing should author up front.
   *
   * One `MemoizingPropertySetSource` per sample, matching its documented lifetime: the gate and
   * the loop are two callers of ONE authoring call, so the set they see cannot diverge and the
   * sample pays for one model call rather than two.
   *
   * `null` whenever no gate is wired, EVEN IF a factory was supplied. That is the rule that
   * keeps an ungated run identical to the shipping path: nothing authors up front there, so a
   * gated and an ungated run differ by the gate alone, which is what task 9.12's comparison
   * rests on.
   */
  #authorPropertySet(problem: EvalProblem): MemoizingPropertySetSource | null {
    const sourceFor = this.#resolved.propertySetSourceFor;
    if (this.#resolved.propertySetGate === null || sourceFor === null) {
      return null;
    }
    return new MemoizingPropertySetSource(sourceFor(problem));
  }

  /**
   * Score this problem's Property_Set against reference-design mutants (Req 10.1, 10.3).
   *
   * Total by construction - it always returns, never throws - so a sample can never be
   * missing an admission outcome. Every path that cannot produce a real one yields `null`,
   * which `recordedPropertySetAdmission` records as `'not-gated'`:
   *   - no gate wired        -> nothing was gated
   *   - the gate found no reference for this problem (`null` from the port)
   *   - the gate threw       -> no admission was established
   *
   * THE THROWING CASE IS THE ONE WORTH STATING. A gate that broke demonstrated NOTHING, so
   * it must not be recorded as `'refused'` - that would be an accusation nobody measured,
   * and Requirement 10.9's refused-sample count is over `'refused'` alone, so a broken gate
   * would inflate a reported number with samples nothing refused. It degrades to "no
   * admission was established" instead, which is the same fail-safe direction
   * `#controlInstrument` takes when the positive control throws: a control that cannot run
   * degrades to `unchecked`, never to a verdict. The consequence is stated rather than
   * hidden: an ungated Property_Set may then decide a sample, and the record says so.
   *
   * The RULE is applied here and not in the port: `admitPropertySet` reads the population
   * the port measured, so no implementation can widen or weaken which mutants the gate
   * holds a Property_Set to (Req 10.5).
   *
   * THE COUNTS ARE TAKEN HERE FOR THE SAME REASON THE RULE IS (Req 9.4, 9.6, 9.9). This is
   * the one place the calibrated population is in hand: `admitPropertySet` reduces it to an
   * outcome and a survivor list, so a mutant the Formal_Oracle could not reason about was
   * tallied by `formalMutationCounts` nowhere and DROPPED here - one layer above the record -
   * leaving Requirement 9.4's excluded-mutant count with no data path to the Sweep_Summary at
   * all. Both reads are taken from the SAME population in the same statement, so the counts
   * and the admission can never describe different runs.
   */
  async #gatePropertySet(
    problem: EvalProblem,
    authored: MemoizingPropertySetSource | null,
    budget: MeteredSessionBudget,
  ): Promise<GatedPropertySet | null> {
    const gate = this.#resolved.propertySetGate;
    if (gate === null || authored === null) {
      // No gate, or no author to score: either way nothing was gated, and a gate with no set
      // to score would be asked to measure an artifact that does not exist.
      return null;
    }
    try {
      const population = await gate.calibrate({
        problemId: problem.id,
        // The gate runs under the SAME sandbox caps as the loop's own oracle.
        limits: this.#resolved.limits,
        // Authored on THIS sample's budget, and memoized, so the loop is handed the same
        // object rather than a second set the sample paid for twice (Req 6.7).
        propertySet: await authored.propertySetFor(problem.spec, budget),
      });
      // `null` is "the gate could not run"; an EMPTY population is "it ran and its gate set
      // came back empty", which `admitPropertySet` reports as `no-gate-set`. Collapsing the
      // two would lose the one distinction the four-member vocabulary exists for.
      return population === null
        ? null
        : { admission: admitPropertySet(population), counts: formalMutationCounts(population) };
    } catch {
      // Sanitized, fail-safe: the gate's error detail never enters the report, and the
      // Property_Set stays ungated rather than being refused on a broken run.
      return null;
    }
  }

  /**
   * Build this sample's per-sample Instrument_Admission adapter, or `null` when no
   * Instrument_Control is wired (Req 4.10).
   *
   * One `MemoizingInstrumentAdmission` per sample, matching its documented lifetime: no
   * cross-sample state to reset, and the control it wraps runs at most once whether the loop
   * consults `admit` zero or one times (Req 4.12).
   */
  #buildAdmission(problem: EvalProblem): MemoizingInstrumentAdmission | null {
    const control = this.#resolved.instrumentControl;
    if (control === null) {
      return null;
    }
    return new MemoizingInstrumentAdmission(control, {
      problemId: problem.id,
      limits: this.#resolved.limits,
      requiredCheckNames: this.#requiredCheckNames(problem),
    });
  }

  /** The Required_Check names this arm's Testbench_Agent derived, from the Spec alone (C9). */
  #requiredCheckNames(problem: EvalProblem): readonly string[] {
    return requiredChecksFor(problem.spec, this.#resolved.strategyArm).map((check) => check.name);
  }

  /** The Known_Answer_Check names of this arm's list: the trusted side of the membership test. */
  #knownAnswerNames(problem: EvalProblem): ReadonlySet<string> {
    const checks = requiredChecksFor(problem.spec, this.#resolved.strategyArm);
    return new Set(checks.filter((check) => check.kind === 'known-answer').map((c) => c.name));
  }

  /** Assemble the whole-run report from the per-problem results (pure). */
  #assembleReport(problems: readonly ProblemResult[]): EvalRunReport {
    const aggregatePassAtK: Record<number, number> = {};
    for (const k of this.#resolved.ks) {
      aggregatePassAtK[k] = meanPassAtK(problems.map((problem) => problem.passAtK[k] ?? 0));
    }
    return {
      config: this.#resolved.config,
      ks: this.#resolved.ks,
      problems,
      aggregatePassAtK,
      costEnvelope: this.#costEnvelope(problems),
      agreement: summarizeAgreement(verdictPairs(problems)),
      instrument: summarizeInstrumentControl(instrumentSamples(problems)),
      mutation: summarizeMutationControl(mutationSamples(problems)),
    };
  }

  /** Compute the per-session cost envelope report across every sample (Req 15.6). */
  #costEnvelope(problems: readonly ProblemResult[]): CostEnvelopeReport {
    const cap = this.#resolved.costEnvelopeCents;
    const violations: CostViolation[] = [];
    let maxObservedCents = 0;
    for (const problem of problems) {
      for (const sample of problem.samples) {
        maxObservedCents = Math.max(maxObservedCents, sample.costCents);
        if (sample.costCents > cap) {
          violations.push({
            problemId: problem.problemId,
            sampleIndex: sample.sampleIndex,
            costCents: sample.costCents,
          });
        }
      }
    }
    return {
      maxCentsPerSession: cap,
      maxObservedCents,
      withinEnvelope: violations.length === 0,
      violations,
    };
  }

  /** Build a fresh metered budget for one session from the shared student caps. */
  #freshBudget(): MeteredSessionBudget {
    const built = makeSessionBudget(zeroConsumed(this.#resolved.caps, this.#resolved.newId()));
    if (!built.ok) {
      // Unreachable: caps were validated in `createEvalHarness` and `newId` was
      // probed there. A failure here means the injected `newId` produced an invalid
      // ULID, a broken-collaborator programming error, so fail loudly rather than
      // silently mis-measuring a session.
      throw new Error(`Eval budget construction failed: ${built.error.message}`);
    }
    return new MeteredSessionBudget(built.value);
  }
}

/**
 * The outcome the harness measures: a real loop outcome or the fail-safe runner error.
 *
 * Aliased to the artifact layer's `CapturedOutcome` so the union has exactly one
 * definition: both the judge path and the artifact path read the same terminal shapes, and
 * a status added to one can never be forgotten by the other.
 */
type DriveOutcome = CapturedOutcome;

/** Loop iterations the session ran, or 0 when the outcome carries no iteration count. */
function iterationsOf(outcome: DriveOutcome): number {
  return 'iterations' in outcome ? outcome.iterations : 0;
}

/**
 * Whether this sample's outcome already carries a Testbench_Repair attempt, or
 * `NO_REPAIR` when it carries none.
 *
 * Read from `outcome.repairProvenance` for the three statuses that carry it -
 * `verified`, `unverified`, `instrument-refused`, the only outcomes that can
 * reach a repairable point. `blocked`, `setup-failed`, and `runner-error` never
 * reach one, so they report the unrepaired baseline rather than a value that
 * does not exist on them.
 */
function repairProvenanceOf(outcome: DriveOutcome): RepairProvenance {
  if (
    outcome.status === 'verified' ||
    outcome.status === 'unverified' ||
    outcome.status === 'instrument-refused'
  ) {
    // Defensive fallback, mirroring `captureSampleArtifacts`'s identical read of the same
    // required field (`./artifact-sink.ts`): a stale fixture built before this field became
    // required on `VerificationOutcome` can still hand back `undefined` at runtime despite
    // the compile-time guarantee, and `#runSample` reads `.attempted` transitively through
    // `RepairProvenance`'s own consumers, so a silent `undefined` must not reach it.
    return outcome.repairProvenance ?? NO_REPAIR;
  }
  return NO_REPAIR;
}

/**
 * What the Formal_Oracle established for this sample, or `NO_FORMAL_RUN` for an outcome that
 * carries no formal provenance at all (Req 7.9, 12.11, 12.21).
 *
 * Mirrors `repairProvenanceOf`'s narrowing exactly, and for the same reason: `verified`,
 * `unverified`, and `instrument-refused` are the only statuses that reach a candidate the
 * formal gate could have been run over, and `blocked`, `setup-failed`, and `runner-error`
 * never do, so they carry no `formal` field to read and must report the no-run value rather
 * than throw. `NO_FORMAL_RUN` is the honest answer on those three: no property was submitted,
 * no admission gate ran, and the pre-pass was never reached.
 *
 * The `??` guards the same stale-fixture gap `repairProvenanceOf` guards - a fixture built
 * before `formal` became required can still hand back `undefined` at runtime - and it guards
 * it in the fail-safe direction, because `NO_FORMAL_RUN` claims no formal evidence at all.
 */
function formalProvenanceOf(outcome: DriveOutcome): FormalProvenance {
  if (
    outcome.status === 'verified' ||
    outcome.status === 'unverified' ||
    outcome.status === 'instrument-refused'
  ) {
    return outcome.formal ?? NO_FORMAL_RUN;
  }
  return NO_FORMAL_RUN;
}

/**
 * The pre-normalization required-check names this outcome's `NormalizationProvenance`
 * carries, or `null` for a status that carries no `normalization` field at all.
 *
 * Mirrors `repairProvenanceOf`'s narrowing exactly, and for the same reason: `verified`,
 * `unverified`, and `instrument-refused` are the only statuses that reach a point where a
 * Testbench was normalized, and `blocked`, `setup-failed`, and `runner-error` never do, so
 * they carry no `normalization` field to read and must return the "cannot compute" default
 * rather than throw. The `?? null` guards the same stale-fixture gap `repairProvenanceOf`
 * guards: a fixture built before `normalization` became required can still hand back
 * `undefined` at runtime despite the compile-time guarantee.
 */
function preNormalizationCheckNamesOf(outcome: DriveOutcome): readonly string[] | null {
  if (
    outcome.status === 'verified' ||
    outcome.status === 'unverified' ||
    outcome.status === 'instrument-refused'
  ) {
    return outcome.normalization?.preNormalizationCheckNames ?? null;
  }
  return null;
}

/**
 * Whether this sample is the early-warning case Council B named: the Dialect_Normalizer
 * changed the Testbench source, the changed Testbench then PASSED the Positive_Control, and
 * at least one check name the PRE-normalization source emitted is absent from the names the
 * control's own stdout reports (Req 5.8).
 *
 * A pure module-level function, not a method, because it reads no `this`. Both inputs are
 * values `#runSample` already holds: the pre-normalization check names come from
 * `outcome.normalization.preNormalizationCheckNames`, computed once in Loop_Setup where
 * that source existed, and `control` is the SAME `InstrumentControlResult` the sample's
 * verdict was decided from - `#runSample` passes the identical `outcome`/`control` it
 * already used to fill every other field of `sample`, so this signal costs zero extra
 * control runs and cannot make the control run twice (Req 4.12 of the precedent spec).
 *
 * The names the control reported are read with `readCheckSignals`, the oracle's own
 * `CHECK <name> PASS|FAIL` grammar owner, rather than by substring search, so a check name
 * that merely appears inside some other line is not counted as reported. A name that was
 * reported but FAILED still counts as visible - only a name reported nowhere at all trips
 * this signal, per the "absent from the names the control's stdout" wording: a testbench
 * that silently dropped a check from its output is a stronger warning than one that ran the
 * check and reported it failing.
 *
 * CHANGES NOTHING DOWNSTREAM (Req 5.11): this is computed after every verdict field of
 * `sample` is already decided, written only to the record and the artifact, and read back
 * nowhere. It cannot alter the Verification_Loop's oracle verdict or the Golden_Judge's
 * verdict for any sample, because neither of those has been given a way to read it.
 */
function checkNameVisibilitySignalOf(
  outcome: DriveOutcome,
  control: InstrumentControlResult,
): boolean {
  if (control.verdict.validity !== 'valid') {
    return false;
  }
  const preNormalizationNames = preNormalizationCheckNamesOf(outcome);
  if (preNormalizationNames === null || preNormalizationNames.length === 0) {
    return false;
  }
  const normalizationChanged = 'normalization' in outcome && outcome.normalization.report.changed;
  if (!normalizationChanged) {
    return false;
  }
  const reportedNames = new Set(readCheckSignals(control.stdout).checks.map((check) => check.name));
  return preNormalizationNames.some((name) => !reportedNames.has(name));
}

/**
 * The sanitized note recorded for one measured sample, or `null`.
 *
 * `runner-error` is deliberately noteless: `#drive` classifies a throwing runner WITHOUT
 * reading its error, because a thrown detail routinely names a host or carries a stack
 * trace, so `outcomeStatus` is already everything this layer may say about it.
 */
function sampleFailureNote(outcome: DriveOutcome): string | null {
  return outcome.status === 'runner-error' ? null : failureNoteOf(outcome);
}

/** Flatten every sample's verdict pair for the agreement aggregation. */
function verdictPairs(problems: readonly ProblemResult[]): readonly VerdictPair[] {
  return problems.flatMap((problem) =>
    problem.samples.map((sample) => ({
      loopPassed: sample.passed,
      golden: sample.goldenVerdict,
    })),
  );
}

/** Flatten every sample for the positive control's aggregation. */
function instrumentSamples(problems: readonly ProblemResult[]): readonly InstrumentSample[] {
  return problems.flatMap((problem) =>
    problem.samples.map((sample) => ({
      outcomeStatus: sample.outcomeStatus,
      instrument: sample.instrumentVerdict,
      loopPassed: sample.passed,
      golden: sample.goldenVerdict,
    })),
  );
}

/**
 * Flatten every sample for the NEGATIVE control's aggregation.
 *
 * Delegates to `recordedMutationCounts`, the single owner of the probe -> persisted-counts
 * projection, so the harness's in-memory report and a summary computed from disk cannot tally
 * different things. The survivor SITES stay on the sample and reach the per-sample artifacts.
 */
function mutationSamples(problems: readonly ProblemResult[]): readonly MutationSample[] {
  return problems.flatMap((problem) =>
    problem.samples.map((sample) => ({
      problemId: problem.problemId,
      probe: recordedMutationCounts(sample.mutationProbe),
    })),
  );
}

/**
 * One RUN of the Property_Set_Admission gate: the rule's own outcome, and the tally of the
 * population that outcome was decided over.
 *
 * Both halves come from ONE `calibrate` call, so the record cannot pair an admission with
 * counts taken over a different population. The admission alone is lossy on purpose -
 * `admitPropertySet` reduces the population to an outcome and a survivor list - which is why
 * the counts travel beside it rather than being re-derived downstream from something smaller.
 */
interface GatedPropertySet {
  readonly admission: PropertySetAdmission;
  readonly counts: FormalMutationCounts;
}

/** The Property_Set facts one sample records, derived from the ONE gate run it got. */
interface RecordedPropertySetAdmission {
  readonly outcome: PropertySetAdmissionOutcome;
  readonly survivorCount: number;
  /** `null` where no gate ran: not measured, which is a different claim from zero. */
  readonly mutationCounts: FormalMutationCounts | null;
}

/**
 * Project one gate run - or the absence of one - onto what the sample records (pure, total).
 *
 * `null` becomes `'not-gated'`: no gate ran, so nothing was measured in either direction.
 * That is NOT `'no-gate-set'`, which means a gate RAN and its gate set came back empty, and
 * it is NOT `'refused'`, which would report a refusal nobody measured. Both facts are real
 * and both are recorded distinctly, which is the whole reason the vocabulary has four
 * members rather than a boolean (see `./property-set-admission.ts`).
 *
 * The counts go to `null` on that same path rather than to an all-zero tally, by the rule
 * `formalKillRateOf` already follows one layer down: a population nobody calibrated has no
 * counts, where every count at zero reads as a gate that scored nothing. No production
 * `PropertySetGate` is wired yet, so `null` - rendered "not measured" - is what every sweep
 * sample carries today, and that is the honest reading rather than a reason to withhold it.
 */
function recordedPropertySetAdmission(
  gated: GatedPropertySet | null,
): RecordedPropertySetAdmission {
  if (gated === null) {
    return { outcome: 'not-gated', survivorCount: 0, mutationCounts: null };
  }
  return {
    outcome: propertySetAdmissionOutcomeOf(gated.admission),
    survivorCount: propertySetSurvivorCountOf(gated.admission),
    mutationCounts: gated.counts,
  };
}

/** The control result for a sample the control could not speak for; no streams, no run. */
function uncheckedControl(reason: InstrumentUncheckedReason): InstrumentControlResult {
  return {
    verdict: uncheckedInstrument(reason),
    stdout: '',
    stderr: '',
    exitCode: null,
    mutation: null,
    positiveRun: null,
  };
}

/** The parse refusal this sample's setup failure carried, or `null` when it carried none. */
export function parseRefusalOf(outcome: DriveOutcome): TestbenchParseRefusal | null {
  if (outcome.status !== 'setup-failed') {
    return null;
  }
  return outcome.testbenchParseRefusal ?? null;
}

/**
 * Reduce the Positive_Control's run facts to the four booleans a record carries.
 *
 * MEMBERSHIP, NEVER EXTRACTION: `failingCheckNames` is tool output, so it is only ever tested
 * against our own trusted Known_Answer_Check names and is dropped here (Req 11.3).
 */
export function positiveControlRunOf(
  control: InstrumentControlResult,
  knownAnswerNames: ReadonlySet<string>,
): PositiveControlRunSummary | null {
  const run = control.positiveRun;
  if (run === null) {
    return null;
  }
  return {
    passed: run.passed,
    watchdogStopped: run.watchdogStopped,
    waveformMissing: run.waveformMissing,
    knownAnswerOnlyFailure:
      !run.passed &&
      run.failingCheckNames.length > 0 &&
      run.failingCheckNames.every((name) => knownAnswerNames.has(name)),
  };
}

/** Resolve the reported k set: default to `[sampleCount]`, dedupe, and sort ascending. */
function resolveKs(ks: readonly number[] | undefined, sampleCount: number): readonly number[] {
  const requested = ks !== undefined && ks.length > 0 ? ks : [sampleCount];
  return [...new Set(requested)].sort((left, right) => left - right);
}

/** Reject a k that is not an integer in [1, sampleCount]. */
function validateKs(ks: readonly number[], sampleCount: number): DomainError | null {
  for (const k of ks) {
    if (!Number.isInteger(k) || k < 1 || k > sampleCount) {
      return domainError(
        'EVAL_K_OUT_OF_RANGE',
        `each k must be an integer in [1, ${sampleCount}] (sampleCount)`,
        'ks',
      );
    }
  }
  return null;
}

/** Validate the student caps by building a probe `SessionBudget`; returns its error. */
function validateCaps(caps: StudentSessionCaps, newId: () => Ulid): DomainError | null {
  const built = makeSessionBudget(zeroConsumed(caps, newId()));
  return built.ok ? null : built.error;
}

/** A `SessionBudget` input from the caps with zeroed consumption and the given id. */
function zeroConsumed(caps: StudentSessionCaps, sessionId: Ulid): SessionBudget {
  return {
    sessionId,
    maxIterations: caps.maxIterations,
    maxTokens: caps.maxTokens,
    maxWallClockMs: caps.maxWallClockMs,
    maxCostCents: caps.maxCostCents,
    consumedIterations: 0,
    consumedTokens: 0,
    consumedMs: 0,
    consumedCostCents: 0,
  };
}
