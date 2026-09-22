// The recorded shape of one eval run (Req 15.2, 15.5).
//
// The harness both reports and records: it returns an `EvalRunReport` to its caller
// and, when a recorder is wired, persists the same report so pass@k,
// iterations-to-pass, and cost can be tracked over time (Req 15.5). Every field is
// a plain, serializable value with no host, path, secret, or stack trace, so the
// report is safe to persist and to surface. The reproducibility config is embedded
// so a recorded run is self-describing: you can tell exactly which seeds,
// temperature, and sample count produced these numbers.

import type { BudgetStopReason } from '@app/core';
import type { RepairProvenance } from '@app/agent';

import type { AgreementReport, RecordedGoldenVerdict } from './golden-judge.js';
import type { InstrumentControlReport, RecordedInstrumentVerdict } from './instrument-control.js';
import type { MutationControlReport, MutationProbeReport } from './mutation-control.js';
import type { NoVerdictCause } from './no-verdict-cause.js';
import type { EvalProblemSource } from './problem.js';
import type { ReproducibilityConfig } from './reproducibility.js';

/** The per-session outcome status the harness records for one sample. */
export type SampleOutcomeStatus =
  | 'verified'
  | 'unverified'
  | 'blocked'
  | 'setup-failed'
  // Added by app/agent/orchestrator/verification-loop.ts's `InstrumentRefusedModule`
  // (task 4.1). Excluded from `reachedOracleVerdict`'s positive set in
  // `./instrument-control.ts` (Req 5.8, 5.9), so it never enters the pass@k
  // denominator. Admitted to the GOLDEN denominator by `countsInGoldenPassAtK` in
  // `./golden-judge.ts` (Req 5.7): a refused testbench still surrenders its
  // candidate to the independent judge. Classified under its own distinct
  // `NoVerdictCause` in `./no-verdict-cause.ts` (Req 5.10).
  | 'instrument-refused'
  /** The loop runner threw; the sample is treated as failed, fail-safe. */
  | 'runner-error';

/** The result of one sample (one student session) of one problem. */
export interface SampleResult {
  readonly sampleIndex: number;
  /** The deterministic seed this sample was drawn with (Req 15.10). */
  readonly seed: number;
  /** Whether the Simulator oracle passed this sample - the sole pass authority (Req 15.5). */
  readonly passed: boolean;
  readonly outcomeStatus: SampleOutcomeStatus;
  /**
   * A short SANITIZED explanation for a status that carries no verdict, else `null`.
   *
   * This is the only place a no-verdict sample can say WHY: `blocked` and `setup-failed`
   * produce no oracle verdict at all, and without this a campaign of them is
   * undiagnosable. Never a secret, host, URL, path, or stack trace - it is derived only
   * from our own already-sanitized values (see `./failure-note.ts`) and is bounded, so
   * one record can neither bloat nor corrupt a results file. `null` means there is
   * nothing to explain: a verified sample, or an `unverified` one whose `stopReason` and
   * `iterations` already tell the whole story.
   */
  readonly failureNote: string | null;
  /**
   * The TYPED reason this sample has no oracle verdict, or `null` when it has one.
   *
   * `failureNote` above is the same fact in prose, for an operator to read. This is the same
   * fact as a value, for the sweep to branch on: it decides whether the matrix cell was
   * MEASURED (a finding, final) or merely ATTEMPTED (infrastructure, deferred and retried on
   * resume). Never derived from the note - see `./no-verdict-cause.ts` for why a note must
   * never be load-bearing.
   */
  readonly noVerdictCause: NoVerdictCause | null;
  /** Loop iterations this session ran; 0 when the loop never reached simulation. */
  readonly iterations: number;
  /**
   * Cost this session consumed against its student-caps budget, in cents (Req 15.2).
   *
   * DERIVED FROM AN EXTERNAL RATE CARD, unlike every token and wall-clock figure here: no
   * endpoint returns money, so this is real only when the arm's models were priced in the
   * config. An unpriced model contributes 0, which means PRICE UNKNOWN and not free, and
   * the sweep records that separately (`SweepSampleRecord.costKnown`). Prefer the token
   * and wall-clock figures for anything that must be measured rather than assumed.
   */
  readonly costCents: number;
  /**
   * Prompt tokens the providers reported for this session.
   *
   * MEASURED, not derived: the endpoint returns `usage.prompt_tokens` and it is validated
   * at the reply boundary. A floor when `unreportedUsageCalls` is non-zero.
   */
  readonly promptTokens: number;
  /** Completion tokens the providers reported for this session; a floor, same as above. */
  readonly completionTokens: number;
  /**
   * Total tokens the session's budget accounted, as the providers reported them.
   *
   * Carried separately from `promptTokens + completionTokens` rather than derived from
   * them, because some hosts report a `total_tokens` that is not their sum (cached or
   * reasoning tokens), and the sum of two floors is not the provider's own total.
   */
  readonly totalTokens: number;
  /**
   * Model calls in this session whose provider reported no usable token usage.
   *
   * Non-zero means the three token counts above are FLOORS: those calls contributed
   * nothing to them, because zero tokens is a measurement and a silent provider is not
   * making one. A session that made no model call at all has 0 here and 0 tokens, and
   * that pair is a real measurement - which is exactly the case this field exists to keep
   * distinguishable from a session whose usage went missing.
   */
  readonly unreportedUsageCalls: number;
  /** The cap that stopped the session, or null when it ended before any cap tripped. */
  readonly stopReason: BudgetStopReason | null;
  /**
   * The INDEPENDENT judge's verdict on this sample's candidate, or `null`.
   *
   * `passed` above is the loop's OWN oracle verdict, decided against the agent's
   * spec-derived testbench; this is a benchmark-supplied golden testbench we neither
   * wrote nor modified. Recording both is what separates real pass@k from
   * self-graded success, and their disagreement is what measures the agent's
   * testbench (see `./golden-judge.ts`). `null` means the sample could not be judged:
   * no judge was wired, the problem has no golden testbench, or the loop produced no
   * candidate at all.
   */
  readonly goldenVerdict: RecordedGoldenVerdict | null;
  /**
   * Whether this sample's own testbench was proven to be a usable instrument.
   *
   * `passed` and `goldenVerdict` are verdicts on the CANDIDATE; this is a verdict on the
   * TESTBENCH THAT PRODUCED `passed`, obtained by running it against the benchmark's
   * known-good reference design. An `invalid` instrument means `passed` says nothing about
   * the model, so the sample is excluded from the pass@k denominator and reported
   * separately (see `./instrument-control.ts`).
   *
   * Never `null`: a sample nothing could be checked for is `unchecked`, which is a
   * statement. An absent field would silently read as validated.
   */
  readonly instrumentVerdict: RecordedInstrumentVerdict;
  /**
   * What the NEGATIVE control measured for this sample, or `null` when it measured nothing.
   *
   * The evidence behind `instrumentVerdict` when that verdict came from the mutation gate: how
   * many VALID mutants there were, how many OURS killed, and - the actionable part - exactly
   * which ones survived, split into a definite coverage gap and a candidate-equivalent list.
   * `null` when no negative control was wired, when the positive control had already falsified
   * the instrument, or when the probe was unavailable; in the last case `instrumentVerdict`
   * already carries the reason.
   */
  readonly mutationProbe: MutationProbeReport | null;
  /**
   * Whether a Testbench_Repair was attempted/accepted for this sample, at either
   * the Testbench_Precheck trigger point (inside `app/agent`) or the Positive_
   * Control trigger point (`EvalHarness#repairIfTriggered`, below).
   *
   * `attempted: false` means neither trigger point ever consulted the repair
   * port for this sample - the unrepaired baseline (`NO_REPAIR`). `accepted`
   * is `true` only when the attempt's revised testbench is the one the final
   * verdict in this very record was decided from; every other combination
   * means the sample's recorded fields describe the ORIGINAL, unrepaired run.
   */
  readonly repairProvenance: RepairProvenance;
  /**
   * Council B's early-warning signal (Req 5.8): the Dialect_Normalizer changed this
   * sample's Testbench source, the changed Testbench then passed the Positive_Control, and
   * at least one check name the PRE-normalization source emitted is absent from the names
   * the control's own stdout reports.
   *
   * Computed strictly AFTER every other field above, from the same outcome and control
   * those fields were already decided from (Req 5.11): nothing reads this field back, so
   * it can change neither the loop's own oracle verdict nor `goldenVerdict` for any sample.
   * See `checkNameVisibilitySignalOf` in `./harness.ts` for the full derivation.
   */
  readonly checkNameVisibilitySignal: boolean;
}

/** The aggregated result for one problem across all its samples. */
export interface ProblemResult {
  readonly problemId: string;
  readonly title: string;
  readonly source: EvalProblemSource;
  /** n: the number of samples drawn. */
  readonly sampleCount: number;
  /** c: the number of samples the oracle passed. */
  readonly passCount: number;
  /** pass@k for each reported k (keyed by k). */
  readonly passAtK: Readonly<Record<number, number>>;
  /** Iterations the first passing sample took, or null when no sample passed. */
  readonly iterationsToPass: number | null;
  /** The most expensive session for this problem, in cents. */
  readonly maxCostCents: number;
  readonly samples: readonly SampleResult[];
}

/** One session that breached the per-session cost envelope. */
export interface CostViolation {
  readonly problemId: string;
  readonly sampleIndex: number;
  readonly costCents: number;
}

/**
 * The per-session cost envelope check (Req 15.6, 17.3).
 *
 * Every eval session must stay within the pennies-per-session cost envelope. This
 * records the cap that was asserted, the most expensive observed session, whether
 * every session stayed within the envelope, and any sessions that did not - so the
 * integration test (task 19.4) can assert the envelope held and CI can surface a
 * regression rather than silently overspending.
 */
export interface CostEnvelopeReport {
  readonly maxCentsPerSession: number;
  readonly maxObservedCents: number;
  readonly withinEnvelope: boolean;
  readonly violations: readonly CostViolation[];
}

/** The full report for one eval run. */
export interface EvalRunReport {
  /** The exact config that produced these numbers (Req 15.10). */
  readonly config: ReproducibilityConfig;
  /** The k values pass@k was reported for. */
  readonly ks: readonly number[];
  readonly problems: readonly ProblemResult[];
  /**
   * Subset-level pass@k: the mean of per-problem pass@k, keyed by k (Req 15.2).
   *
   * NOT instrument-gated, deliberately. This is the report for ONE harness run over
   * whatever subset it was handed, including the hand-written smoke subset that has no
   * reference designs and therefore cannot be controlled at all - gating it there would
   * turn "unvalidatable" into a flat 0 and read as a total model failure. The citable,
   * instrument-gated pass@k is the sweep summary's, computed from the persisted records
   * where every sample's `instrumentVerdict` is available (see
   * `./sweep/summary.ts` and the invariant in `./instrument-control.ts`). Read
   * `instrument` below before citing this number.
   */
  readonly aggregatePassAtK: Readonly<Record<number, number>>;
  readonly costEnvelope: CostEnvelopeReport;
  /**
   * How the loop's own verdicts compared with the independent judge's across the run.
   *
   * Zeroed when no judge was wired, which reads as "not measured" rather than as
   * perfect agreement.
   */
  readonly agreement: AgreementReport;
  /**
   * What the POSITIVE CONTROL established about our own testbenches across the run.
   *
   * Zeroed when no control was wired, which reads as "not measured" rather than as every
   * instrument being sound; `instrumentControlMeasured` is the predicate for that.
   */
  readonly instrument: InstrumentControlReport;
  /**
   * What the NEGATIVE control established about our own testbenches across the run.
   *
   * The kill rate over VALID mutants, the golden judge's own reach, and the two survivor
   * tallies. Zeroed when no negative control was wired, which reads as "not measured" rather
   * than as every mutant being killed; `mutationControlMeasured` is the predicate for that.
   */
  readonly mutation: MutationControlReport;
}

/**
 * The port the harness records each run through so results can be tracked over time
 * (Req 15.5).
 *
 * Kept as a narrow injected port: the eval layer never chooses a persistence
 * mechanism, so the composition root wires this to the Project_Store or a results
 * log without the harness importing any store.
 */
export interface EvalRunRecorder {
  record(report: EvalRunReport): Promise<void>;
}
