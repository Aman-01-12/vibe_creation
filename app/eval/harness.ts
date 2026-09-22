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
import { NO_REPAIR, type RepairProvenance } from '@app/agent';
import { readCheckSignals, type ResourceLimits } from '@app/tools';

import {
  candidateRtlOf,
  captureSampleArtifacts,
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
import { MemoizingInstrumentAdmission } from './instrument-admission.js';
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
  /** ULID source for per-session budget ids; defaults to `newUlid`. */
  readonly newId?: () => Ulid;
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
  readonly newId: () => Ulid;
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
      newId,
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
    const outcome = await this.#drive(problem, sampleIndex, seed, budget, admission);
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
      // Req 1.6: COPIED from what the loop returned, never re-derived from acceptance.
      repairProvenance: repairProvenanceOf(outcome),
      // Req 5.8, 5.11: computed LAST, after every verdict field above is already
      // decided, from the same `outcome`/`control` this method already holds - see
      // `checkNameVisibilitySignalOf`'s own comment for why this changes nothing.
      checkNameVisibilitySignal: checkNameVisibilitySignalOf(outcome, control),
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
  ): Promise<DriveOutcome> {
    try {
      return await this.#resolved.loopRunner.runSample({
        problem,
        sampleIndex,
        seed,
        temperature: this.#resolved.config.temperature,
        budget,
        limits: this.#resolved.limits,
        ...(admission === null ? {} : { instrumentAdmission: admission }),
      });
    } catch {
      // Sanitized, fail-safe: the runner's error detail never enters the report.
      return { status: 'runner-error' };
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
    });
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

/** The control result for a sample the control could not speak for; no streams, no run. */
function uncheckedControl(reason: InstrumentUncheckedReason): InstrumentControlResult {
  return {
    verdict: uncheckedInstrument(reason),
    stdout: '',
    stderr: '',
    exitCode: null,
    mutation: null,
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
