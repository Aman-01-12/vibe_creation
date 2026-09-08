// INSTRUMENT VALIDITY: is our own testbench a usable instrument at all?
//
// TWO CONTROLS, ONE VERDICT
//   A testbench is a valid instrument only if it BOTH passes the reference design AND fails
//   deliberately broken versions of it. Those are two different experiments and they falsify
//   two different degenerate testbenches, so validity requires both:
//
//     POSITIVE CONTROL (this module + `./corpus/rtllm-instrument-control.ts`)
//       Run our testbench against the benchmark's known-good REFERENCE design and require a
//       pass. Falsifies a testbench that passes NOTHING.
//
//     NEGATIVE CONTROL (`./mutation-control.ts` + `./corpus/rtllm-negative-control.ts`)
//       Run our testbench against deliberately MUTATED versions of that reference and require
//       it to kill every one the INDEPENDENT golden testbench kills. Falsifies a testbench that
//       passes EVERYTHING.
//
//   Neither alone is enough, and the pair is what makes each non-vacuous: a testbench that
//   errors on every input would kill every mutant but cannot pass the reference, and a
//   testbench that signals PASS unconditionally passes the reference but kills no mutant.
//
// THE MEASURED DEFECT THE POSITIVE CONTROL EXISTS FOR
//   The first real smoke sweep reported pass@1 = 0.333. On `rtllm/memory/right_shifter`
//   our agent-written testbench rejected the candidate - and, reproduced by hand, it
//   rejects RTLLM's OWN human-verified reference design byte-identically:
//
//     CHECK ac1_under_simulation_right_shifter_produces FAIL
//     ERROR at fill-1s step 0: expected q=10000000, got q=11010101
//
//   The testbench's "fill-1s" phase expects `q == 0` at its start, but the design has NO
//   reset port, so the zero state cannot be re-established after the testbench's own
//   earlier stimulus. Our testbench invented a capability the declared interface does not
//   have. That number therefore measured OUR INSTRUMENT, not the model - and nothing in
//   the report said so.
//
// THE MEASURED DEFECT THE NEGATIVE CONTROL EXISTS FOR
//   `smoke-v4-oracle` then recorded `MISSED BUGS: 1`. On `rtllm/arithmetic/multi_pipe_8bit`
//   our testbench PASSED a candidate RTLLM's independent golden testbench fails 100/100. Its
//   monitor DETECTED the mismatch - it printed roughly fourteen `Time N: ... mismatch,
//   expected X, got Y` lines - and then signalled `CHECK <name> PASS`, because the mismatch
//   never reached a flag the CHECK status reads. The signal itself says PASS, so no reader or
//   parser fix can catch it. And the POSITIVE control read that sample `valid`, correctly:
//   the same testbench passes the reference design too. A control that only proves a
//   testbench CAN pass the correct answer is structurally incapable of catching a testbench
//   that passes everything.
//
// WHY THESE ARE CONTROLS
//   Every experiment that reports a failure rate needs a positive control: a case the
//   instrument is KNOWN to have to pass. RTLLM ships one for every problem - the reference
//   design - so this is detectable per sample instead of by hand. After the loop finishes,
//   the SAME generated testbench that judged the candidate is run against the reference
//   RTL through the same sandbox rails. If the known-good design fails our testbench, the
//   testbench is not a measuring stick and the sample's verdict says nothing about the
//   model.
//
//   It needs a negative control for the same reason: a case the instrument is KNOWN to have
//   to FAIL. Those are manufactured by mutating the reference. Our testbench is SCORED over
//   every mutant that compiles - not only the ones the independent golden testbench kills,
//   because scoring ourselves on the judge's own reach would excuse us for whatever it is
//   blind to (see `./corpus/mutation-calibration.ts` for that argument in full) - but it is
//   GATED on a narrower set: the mutants the golden testbench actually killed. Those are
//   proven catchable by a third party, so a survivor among them is unarguably our defect,
//   while the wider set necessarily contains mutants no testbench can kill. One number
//   informs, the other decides; `combineInstrumentControls` says which is which and why.
//
// THE FOUNDER'S RULING ON WHAT THAT MEANS FOR THE NUMBER
//   An instrument-invalid sample is EXCLUDED from the pass@k denominator and reported
//   separately as a first-class number. It is never silently dropped and never counted as
//   a model failure - counting it would attribute our own defect to the model, and
//   dropping it silently would make the denominator a lie. See `countsInPassAtK` for the
//   invariant this layer exists to enforce.
//
// WHAT THE CONTROLS MAY NEVER DO
//   They are validity checks ON THE INSTRUMENT, not a third opinion on the candidate. Neither
//   can change the loop's own oracle verdict, neither can change the golden verdict, neither
//   makes a model call, neither consumes student-session budget, and neither counts as a
//   sample or an iteration. A control that cannot run degrades to `unchecked` - never to a
//   verdict.
//
// WHY THE RECORDED VERDICT CARRIES NO FREE TEXT
//   `RecordedInstrumentVerdict` is a closed discriminated union of enum members and
//   nothing else. It is persisted in the results log, echoed into artifacts, and printed
//   to operators, so making it structurally incapable of carrying a path, a host, or a
//   tool message is stronger than sanitizing one. The operator wording is DERIVED from the
//   union by `describeInstrumentVerdict`, and the toolchain's actual output goes to
//   artifact files (see `./artifact-sink.ts`), which is where path-bearing text already
//   lives.

import type { ResourceLimits } from '@app/tools';

import type { RecordedGoldenVerdict } from './golden-judge.js';
import {
  judgeCoverageGaps,
  type CoverageGapVerdict,
  type MutationProbeOutcome,
  type MutationProbeReport,
  type MutationUnavailableReason,
} from './mutation-control.js';
import type { SampleOutcomeStatus } from './report.js';

/** Whether this sample's testbench was proven to be a usable measuring stick. */
export type InstrumentValidity =
  /**
   * Both controls passed: the reference passes, and NO independently-catchable mutant survived.
   *
   * The second half is the zero-coverage-gap gate (`judgeCoverageGaps`), not a kill-rate bar.
   */
  | 'valid'
  /** A control falsified the instrument; see `InstrumentDefectCode`. */
  | 'invalid'
  /** A control could not speak for this sample; see `InstrumentUncheckedReason`. */
  | 'unchecked';

/**
 * How an invalid instrument was falsified; a closed, accountable set.
 *
 * The four are kept distinct because they point at DIFFERENT defects in the Testbench_Agent,
 * and blending them would produce a count nobody can act on: a wrong expectation, a
 * structural mismatch, a run that said nothing, and a testbench with a coverage gap are four
 * separate repairs.
 */
export type InstrumentDefectCode =
  /** It built and ran, and reported a failure against the known-good design. */
  | 'TESTBENCH_FAILED_REFERENCE'
  /** It did not compile or elaborate together with the reference design. */
  | 'TESTBENCH_REFERENCE_UNBUILDABLE'
  /** It ran but produced no verdict at all: a timeout, a crash, or no capture. */
  | 'CONTROL_RUN_ERRORED'
  /**
   * It passes the reference, but it also passes broken versions of it that an INDEPENDENT judge
   * catches.
   *
   * The `multi_pipe_8bit` class: the testbench is not over-strict, it is under-powered. Each
   * such survivor is a defect class our testbench does not notice, and a testbench that does not
   * notice a defect class is one that can mint a false `Verified` on it.
   *
   * The name is kept from the kill-rate era because it still reads true - the testbench survived
   * mutants - but the population narrowed to the one that makes the accusation unarguable: every
   * mutant counted here was killed by RTLLM's own golden testbench, so it is provably catchable
   * at the ports and missing it is provably our gap. A survivor the golden judge also passed is
   * reported as candidate-equivalent (`MutationProbeReport`) and never charged here, because
   * nobody has established it is killable at all.
   */
  | 'TESTBENCH_SURVIVED_MUTANTS';

/** Why a control could not speak for a sample; a closed set, so `unchecked` is never vague. */
export type InstrumentUncheckedReason =
  /** No control was wired for this run, so no instrument was validated at all. */
  | 'control-absent'
  /** The loop produced no testbench, so there was no instrument to validate. */
  | 'no-testbench'
  /** The control holds no reference design for this problem. */
  | 'no-reference'
  /** The testbench is empty or larger than the control will submit. */
  | 'testbench-unsubmittable'
  /** The control threw or could not run; fail-safe, never a verdict. */
  | 'control-unavailable'
  /** No mutation operator found a site in the reference, so nothing could be broken. */
  | 'no-mutants-generated'
  /**
   * NOT ONE generated mutant compiled, so the negative control proves nothing.
   *
   * The degenerate case that must never read as `valid`: with an empty valid set, "our
   * testbench killed every valid mutant" is vacuously true and says nothing at all.
   */
  | 'no-valid-mutants'
  /**
   * The INDEPENDENT judge killed no valid mutant, so the gate is VACUOUS for this problem.
   *
   * The same vacuity trap as `no-valid-mutants`, one level in, and it needs its own reason for
   * exactly that reason. The gate asks "did our testbench kill everything the golden testbench
   * killed?"; when the golden testbench killed nothing, that requirement is EMPTY and a testbench
   * that kills nothing at all satisfies it. Nothing was proven catchable, so nothing about our
   * instrument was proven either - which is `unchecked`, not `valid`.
   */
  | 'no-golden-killed-mutants'
  /** The negative control threw or could not run; fail-safe, never a verdict. */
  | 'mutation-probe-unavailable';

/**
 * One sample's instrument verdict, as a report, a record, and an artifact carry it.
 *
 * A discriminated union rather than a validity plus two nullable fields, so "invalid with
 * no defect" and "valid with a defect" are not representable - the same discipline
 * `Verified`-with-provenance uses in the core domain.
 */
export type RecordedInstrumentVerdict =
  | { readonly validity: 'valid' }
  | { readonly validity: 'invalid'; readonly defect: InstrumentDefectCode }
  | { readonly validity: 'unchecked'; readonly reason: InstrumentUncheckedReason };

/** The verdict for an instrument the reference design passed. */
export const VALID_INSTRUMENT: RecordedInstrumentVerdict = Object.freeze({ validity: 'valid' });

/** The verdict for a sample the control could not speak for. */
export function uncheckedInstrument(reason: InstrumentUncheckedReason): RecordedInstrumentVerdict {
  return { validity: 'unchecked', reason };
}

/** The verdict for an instrument the reference design did not pass. */
export function invalidInstrument(defect: InstrumentDefectCode): RecordedInstrumentVerdict {
  return { validity: 'invalid', defect };
}

/** One control request: which problem, and the testbench whose validity is in question. */
export interface InstrumentControlRequest {
  readonly problemId: string;
  /** OUR generated testbench - the instrument under test, exactly as the oracle ran it. */
  readonly testbench: string;
  /** The same sandbox caps the loop's own oracle and the golden judge ran under. */
  readonly limits: ResourceLimits;
}

/**
 * What one control run produced: the verdict, plus the toolchain's own output.
 *
 * The streams are for ARTIFACTS ONLY. They are raw tool output and routinely name a
 * sandbox workspace path, so they never enter a report, a results record, or a progress
 * line - only files under the run directory, beside the testbench that caused them.
 */
export interface InstrumentControlResult {
  readonly verdict: RecordedInstrumentVerdict;
  readonly stdout: string;
  readonly stderr: string;
  /** The process exit code, or `null` when the process did not run to an exit. */
  readonly exitCode: number | null;
  /**
   * What the NEGATIVE control measured, or `null` when it did not measure anything.
   *
   * `null` covers every non-measurement: no negative control was wired, the positive control
   * already falsified the instrument so mutants would add nothing, or the probe was
   * unavailable - in which case the REASON is already carried by `verdict`, so this field
   * never has to encode it a second time.
   */
  readonly mutation: MutationProbeReport | null;
}

/**
 * The positive-control port.
 *
 * Returns `null` when the control has no reference design for that problem id, so a mixed
 * subset (some problems controlled, some not) is expressed honestly rather than by
 * inventing a verdict. Implementations must never throw for a broken testbench: a
 * testbench that will not compile with the reference is a legitimate `invalid` verdict.
 */
export interface InstrumentControl {
  check(request: InstrumentControlRequest): Promise<InstrumentControlResult | null>;
}

/** The operator-facing sentence for one verdict; the single owner of this wording. */
export function describeInstrumentVerdict(verdict: RecordedInstrumentVerdict): string {
  if (verdict.validity === 'valid') {
    return 'the reference design passes our testbench, so the instrument measures something';
  }
  if (verdict.validity === 'invalid') {
    return INVALID_DESCRIPTIONS[verdict.defect];
  }
  return UNCHECKED_DESCRIPTIONS[verdict.reason];
}

/** Why an invalid instrument is invalid, in operator-facing words. */
const INVALID_DESCRIPTIONS: Readonly<Record<InstrumentDefectCode, string>> = Object.freeze({
  TESTBENCH_FAILED_REFERENCE:
    'our testbench REJECTS the reference design, so it is not a measuring stick',
  TESTBENCH_REFERENCE_UNBUILDABLE:
    'our testbench does not build with the reference design, so it never measured anything',
  CONTROL_RUN_ERRORED: 'the control run produced no verdict, so the instrument is unproven',
  TESTBENCH_SURVIVED_MUTANTS:
    'our testbench PASSES broken designs the independent judge catches, so it has a PROVEN ' +
    'coverage gap',
});

/** Why an unchecked instrument is unchecked, in operator-facing words. */
const UNCHECKED_DESCRIPTIONS: Readonly<Record<InstrumentUncheckedReason, string>> = Object.freeze({
  'control-absent': 'no positive control was wired, so no instrument was validated',
  'no-testbench': 'the loop produced no testbench, so there was no instrument to validate',
  'no-reference': 'no reference design is available for this problem',
  'testbench-unsubmittable': 'the testbench is empty or too large for the control to submit',
  'control-unavailable': 'the control could not run, so the instrument stays unproven',
  'no-mutants-generated': 'no mutation operator found a site in the reference design',
  'no-valid-mutants': 'not one generated mutant compiled, so killing none proves nothing',
  'no-golden-killed-mutants':
    'the independent judge killed no mutant here, so nothing was proven catchable and the gate ' +
    'is vacuous',
  'mutation-probe-unavailable':
    'the negative control could not run, so the instrument stays unproven',
});

/**
 * How an unavailable negative control maps onto an unchecked instrument.
 *
 * A total `Record` rather than a `switch`, so adding a `MutationUnavailableReason` is a
 * compile error here instead of a silently-defaulted `unchecked` reason nobody can act on.
 */
const MUTATION_UNCHECKED_REASONS: Readonly<
  Record<MutationUnavailableReason, InstrumentUncheckedReason>
> = Object.freeze({
  'no-reference': 'no-reference',
  'no-mutants-generated': 'no-mutants-generated',
  'no-valid-mutants': 'no-valid-mutants',
  'probe-errored': 'mutation-probe-unavailable',
});

/**
 * How each coverage-gap verdict lands as an instrument verdict.
 *
 * A total `Record` rather than a `switch`, for the same reason as `MUTATION_UNCHECKED_REASONS`:
 * adding a `CoverageGapVerdict` is a compile error here instead of a silently-defaulted outcome.
 * Note that only ONE member maps to `valid` - the two vacuous cases map to their own `unchecked`
 * reasons, which is what stops a gate with nothing to say from reading as a validated pass.
 */
const COVERAGE_GAP_VERDICTS: Readonly<Record<CoverageGapVerdict, RecordedInstrumentVerdict>> =
  Object.freeze({
    closed: VALID_INSTRUMENT,
    open: Object.freeze(invalidInstrument('TESTBENCH_SURVIVED_MUTANTS')),
    'no-valid-mutants': Object.freeze(uncheckedInstrument('no-valid-mutants')),
    'no-golden-killed-mutants': Object.freeze(uncheckedInstrument('no-golden-killed-mutants')),
  });

/** The two controls' findings; everything the combined verdict is decided from. */
export interface CombinedControls {
  /** The POSITIVE control's verdict: does the known-good reference pass our testbench? */
  readonly positive: RecordedInstrumentVerdict;
  /**
   * The NEGATIVE control's outcome, or `null` when none was wired.
   *
   * `null` is a real configuration, not a failure: a run with no negative control applies the
   * positive-control-only standard, and the summary LABELS it as such rather than presenting
   * it as the full one.
   */
  readonly negative: MutationProbeOutcome | null;
}

/**
 * Combine both controls into ONE instrument verdict (pure, total).
 *
 * The precedence, and the reason for each step:
 *
 *   1. A positive control that already falsified the instrument WINS. Running mutants past a
 *      testbench that cannot pass the correct design would add nothing - it has no chance of
 *      being right about a broken one - and it would spend a mutant set's worth of wall clock
 *      to reach the same conclusion under a less specific defect code.
 *   2. No negative control wired -> the positive-control-only standard, reported as such.
 *   3. A negative control that could not speak -> `unchecked` with ITS reason. Deliberately
 *      strict: "we could not prove the instrument rejects anything" is not evidence that it
 *      does, and `unchecked` can only move a sample OUT of the denominator.
 *   4. The ZERO-COVERAGE-GAP gate, owned by `judgeCoverageGaps` and mapped above.
 *
 * WHAT STEP 4 IS NOT: a kill-rate threshold. It used to be one, at 0.95 over every valid mutant,
 * and that produced a measured FALSE NEGATIVE - a testbench that killed two mutants the golden
 * judge itself misses was marked `invalid` at 4/6, because the two it survived were very likely
 * true equivalents. Requiring a rate over a set that necessarily contains unkillable mutants
 * holds an instrument to the undecidable. Requiring zero survivors among the mutants an
 * INDEPENDENT judge already killed cannot: every entry in that set is proven catchable, so
 * missing one is proven to be our defect, and a genuine equivalent can never enter the
 * requirement in the first place. The kill rate is still computed and reported as a quality
 * signal (`killRateOf`); it simply no longer decides anything.
 */
export function combineInstrumentControls(input: CombinedControls): RecordedInstrumentVerdict {
  if (input.positive.validity !== 'valid') {
    return input.positive;
  }
  if (input.negative === null) {
    return VALID_INSTRUMENT;
  }
  if (input.negative.kind === 'unavailable') {
    return uncheckedInstrument(MUTATION_UNCHECKED_REASONS[input.negative.reason]);
  }
  return COVERAGE_GAP_VERDICTS[judgeCoverageGaps(input.negative.report)];
}

/**
 * The outcome statuses that DO carry an oracle verdict.
 *
 * Stated as the positive set on purpose: `verified` and `unverified` are the only two
 * outcomes the oracle actually spoke for, so any status added later is treated as
 * no-verdict and is excluded from the denominator rather than silently admitted.
 */
const VERDICT_BEARING_STATUSES: readonly SampleOutcomeStatus[] = ['verified', 'unverified'];

/** Whether the loop reached an oracle verdict for this sample at all. */
export function reachedOracleVerdict(outcomeStatus: SampleOutcomeStatus): boolean {
  return VERDICT_BEARING_STATUSES.includes(outcomeStatus);
}

/** The two facts the denominator invariant is decided from. */
export interface PassAtKEligibility {
  readonly outcomeStatus: SampleOutcomeStatus;
  readonly instrument: RecordedInstrumentVerdict;
}

/**
 * THE pass@k DENOMINATOR INVARIANT.
 *
 * A sample counts in the pass@k denominator if and ONLY if
 *   (1) the loop reached an oracle verdict for it, AND
 *   (2) the positive control proved its instrument `valid`.
 *
 * Both halves are refusals to attribute our own problems to the model:
 *   - a sample with no oracle verdict (`blocked`, `setup-failed`, `runner-error`) was
 *     never judged, so counting it as a failure would score a provider outage or a wiring
 *     mistake as a model defect;
 *   - a sample whose testbench rejects the known-good reference design was judged by a
 *     broken instrument, so its verdict is not about the candidate at all.
 *
 * `unchecked` therefore does NOT count. That is the strict reading, and it is deliberate:
 * "we could not prove the instrument" is not evidence that the instrument is sound. The
 * two are kept from collapsing into one number by reporting them separately - and by
 * refusing to present a pass@k as validated when nothing was checked, which is what
 * `instrumentControlMeasured` is for.
 *
 * The interaction of (1) and (2) is not merely a conjunction, it is nearly an implication:
 * a sample with no oracle verdict produced no testbench, so its instrument is necessarily
 * `unchecked` and (2) already excludes it. Condition (1) is kept explicit anyway, because
 * it is the older and more fundamental rule and a reader must not have to derive it from
 * the control's behaviour.
 */
export function countsInPassAtK(sample: PassAtKEligibility): boolean {
  return reachedOracleVerdict(sample.outcomeStatus) && sample.instrument.validity === 'valid';
}

/** One sample as the instrument aggregation reads it. */
export interface InstrumentSample {
  readonly outcomeStatus: SampleOutcomeStatus;
  readonly instrument: RecordedInstrumentVerdict;
  /** Whether the loop's own oracle passed it; used only for the invalid/disagreement split. */
  readonly loopPassed: boolean;
  /** The independent judge's verdict, or `null` when the sample was unjudged. */
  readonly golden: RecordedGoldenVerdict | null;
}

/**
 * What the positive control established across a run.
 *
 * `invalidSamples` is the headline: every one of those is a defect in OUR testbench
 * generator, sitting in a run whose numbers would otherwise have blamed the model.
 */
export interface InstrumentControlReport {
  /** Samples the control actually ran on: `validSamples + invalidSamples`. */
  readonly checkedSamples: number;
  /** Samples whose testbench the reference design passes. */
  readonly validSamples: number;
  /** Samples whose testbench the reference design does not pass: OUR defect. */
  readonly invalidSamples: number;
  /** Samples the control could not speak for, for any reason. */
  readonly uncheckedSamples: number;
  /** Samples in the pass@k denominator: the invariant applied (see `countsInPassAtK`). */
  readonly countedSamples: number;
  /**
   * Verdict-bearing samples excluded because their instrument was never proven.
   *
   * Distinct from `uncheckedSamples`, which also counts samples that had no verdict to
   * begin with: this is the population whose pass/fail WAS decided but cannot be cited.
   */
  readonly uncheckedWithVerdict: number;
  /** Invalid samples whose testbench built and then reported a failure on the reference. */
  readonly failedReferenceSamples: number;
  /** Invalid samples whose testbench did not build with the reference at all. */
  readonly unbuildableSamples: number;
  /** Invalid samples whose control run produced no verdict. */
  readonly erroredSamples: number;
  /**
   * Invalid samples whose testbench passes the reference but does NOT kill the mutants.
   *
   * Kept distinct from `failedReferenceSamples` because the repair is the opposite one: a
   * rejected reference means the testbench expects too much, a survived mutant means it
   * checks too little.
   */
  readonly survivedMutantsSamples: number;
  /**
   * Invalid-instrument samples that read as "over-strict" against the independent judge.
   *
   * These are the ones that would otherwise be chased as a model or prompt problem. They
   * are not a disagreement worth investigating: our testbench rejects the reference too.
   */
  readonly invalidOverStrict: number;
  /** Invalid-instrument samples that read as "missed bug" against the independent judge. */
  readonly invalidMissedBug: number;
}

/** The empty report, for a run with no control wired. */
export const NO_INSTRUMENT_CONTROL_MEASURED: InstrumentControlReport = Object.freeze({
  checkedSamples: 0,
  validSamples: 0,
  invalidSamples: 0,
  uncheckedSamples: 0,
  countedSamples: 0,
  uncheckedWithVerdict: 0,
  failedReferenceSamples: 0,
  unbuildableSamples: 0,
  erroredSamples: 0,
  survivedMutantsSamples: 0,
  invalidOverStrict: 0,
  invalidMissedBug: 0,
});

/**
 * Whether the control spoke for at least one sample.
 *
 * `false` means the run's pass@k is NOT VALIDATED - not that every instrument was sound.
 * Consumers must label the number accordingly rather than presenting it as controlled, the
 * same way `summarizeAgreement` reports a zero rate as "not measured" rather than as
 * perfect agreement.
 */
export function instrumentControlMeasured(report: InstrumentControlReport): boolean {
  return report.checkedSamples > 0;
}

/** The report field each defect code is tallied into; total, so a new code cannot hide. */
const DEFECT_TALLY_FIELDS: Readonly<Record<InstrumentDefectCode, DefectTallyField>> = Object.freeze(
  {
    TESTBENCH_FAILED_REFERENCE: 'failedReferenceSamples',
    TESTBENCH_REFERENCE_UNBUILDABLE: 'unbuildableSamples',
    CONTROL_RUN_ERRORED: 'erroredSamples',
    TESTBENCH_SURVIVED_MUTANTS: 'survivedMutantsSamples',
  },
);

/** The report fields the defect tally writes into. */
type DefectTallyField =
  'failedReferenceSamples' | 'unbuildableSamples' | 'erroredSamples' | 'survivedMutantsSamples';

/** The defect-code tallies for the invalid samples (pure). */
function tallyDefects(
  samples: readonly InstrumentSample[],
): Readonly<Record<DefectTallyField, number>> {
  const tally: Record<DefectTallyField, number> = {
    failedReferenceSamples: 0,
    unbuildableSamples: 0,
    erroredSamples: 0,
    survivedMutantsSamples: 0,
  };
  for (const sample of samples) {
    if (sample.instrument.validity !== 'invalid') {
      continue;
    }
    const field = DEFECT_TALLY_FIELDS[sample.instrument.defect];
    tally[field] += 1;
  }
  return tally;
}

/** How the invalid-instrument samples read against the independent judge (pure). */
function tallyInvalidDisagreements(samples: readonly InstrumentSample[]): Readonly<{
  invalidOverStrict: number;
  invalidMissedBug: number;
}> {
  let invalidOverStrict = 0;
  let invalidMissedBug = 0;
  for (const sample of samples) {
    if (sample.instrument.validity !== 'invalid' || sample.golden === null) {
      continue;
    }
    const goldenPassed = sample.golden.kind === 'passed';
    if (!sample.loopPassed && goldenPassed) {
      invalidOverStrict += 1;
    } else if (sample.loopPassed && !goldenPassed) {
      invalidMissedBug += 1;
    }
  }
  return { invalidOverStrict, invalidMissedBug };
}

/**
 * Aggregate per-sample instrument verdicts into the control report (pure).
 *
 * `countedSamples` is computed here, from `countsInPassAtK`, so the report and the
 * denominator can never disagree: there is exactly one implementation of the invariant and
 * both the estimator and the reported count read it.
 */
export function summarizeInstrumentControl(
  samples: readonly InstrumentSample[],
): InstrumentControlReport {
  const valid = samples.filter((sample) => sample.instrument.validity === 'valid');
  const invalid = samples.filter((sample) => sample.instrument.validity === 'invalid');
  const unchecked = samples.filter((sample) => sample.instrument.validity === 'unchecked');
  return {
    checkedSamples: valid.length + invalid.length,
    validSamples: valid.length,
    invalidSamples: invalid.length,
    uncheckedSamples: unchecked.length,
    countedSamples: samples.filter((sample) => countsInPassAtK(sample)).length,
    uncheckedWithVerdict: unchecked.filter((sample) => reachedOracleVerdict(sample.outcomeStatus))
      .length,
    ...tallyDefects(invalid),
    ...tallyInvalidDisagreements(invalid),
  };
}
