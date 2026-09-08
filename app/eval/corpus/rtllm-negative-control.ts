// The RTLLM-backed NEGATIVE CONTROL: our own testbench, run against deliberately broken
// versions of the known-good design.
//
// THE THIRD MEMBER OF THE FAMILY
//   `./rtllm-golden-judge.ts`      is the CANDIDATE right?          (a testbench we did not write)
//   `./rtllm-instrument-control.ts` can our TESTBENCH pass the truth? (a design we did not write)
//   this module                     can our TESTBENCH reject a lie?   (designs we broke on purpose)
//
//   The positive control falsifies a testbench that passes NOTHING. This one falsifies a
//   testbench that passes EVERYTHING - the shape that produced `MISSED BUGS: 1` in
//   smoke-v4-oracle, where our testbench printed fourteen mismatch lines as prose and then
//   signalled `CHECK ... PASS`.
//
// WHY `IcarusSimulatorAdapter` HERE AND THE GOLDEN SCORER IN THE CALIBRATOR
//   This runs OUR testbench, which emits `CHECK <name> PASS|FAIL` and writes a waveform, so it
//   uses the EXACT oracle adapter that produced the loop's verdict. The calibrator runs
//   RTLLM's testbench, which prints VCS-style banners and never calls `$dumpfile`, so it uses
//   the golden scorer. The two read different output grammars; that split is deliberate and is
//   documented at both ends (see `./golden-scorer.ts`). Reusing one reader for both would
//   classify every golden run as an error.
//
// WHAT IT IS SCORED OVER: EVERY VALID MUTANT
//   Every mutant that compiles, not just the ones RTLLM's golden testbench kills. Scoring
//   ourselves only on what the independent judge catches would excuse us for whatever it is
//   blind to, and its blindness is the exact population that produces a missed bug. The golden
//   verdict is still consulted, but only to bucket the mutants WE fail to kill; see
//   `./mutation-calibration.ts` for the full argument and the GateTruth precedent.
//
// WHAT COUNTS AS A KILL
//   Any NON-PASS. Our testbench's job on a broken design is to refuse to certify it, and both
//   `fail` and `error` refuse - the Verification_Loop cannot mint `Verified` from either. A
//   simulation TIMEOUT lands in `error` and is therefore a kill: the mutant produced an
//   observable behavioural difference. That is established practice - Stryker counts a mutant
//   causing an infinite loop as detected - but it is weaker evidence than a reported failure,
//   so the two are counted APART (`MutantKillKind`) and a timeout-heavy result stays visible
//   instead of reading as coverage.
//
//   Counting `error` as a kill looks like it could flatter a testbench that errors on
//   everything, so note why it cannot: such a testbench also errors on the REFERENCE, which
//   the positive control already classifies `invalid` / `CONTROL_RUN_ERRORED`. Validity
//   requires BOTH controls, so "passes the correct design" and "rejects the broken ones" have
//   to hold at once, and no single degenerate testbench satisfies both.
//
// IT DOES NOT SHORT-CIRCUIT
//   Every valid mutant is run even once the threshold is provably missed. Stopping early would
//   save wall clock and destroy the only actionable output: the FULL list of which defect
//   classes our testbench does not notice.
//
// SANDBOX NOTE
//   The testbench is model-authored, so it MUST be driven through the sandbox. The simulator
//   adapter is injected and this module never picks a runtime, exactly like the golden scorer.

import type { SimulatorAdapter, SourceFile } from '@app/tools';

import {
  mutantRunLimits,
  type Mutant,
  type MutantIdentity,
  type MutantKillKind,
  type MutationNegativeControl,
  type MutationProbeOutcome,
  type MutationProbeReport,
  type MutationProbeRequest,
} from '../mutation-control.js';
import {
  goldenKilled,
  goldenKilledCountOf,
  goldenTimeoutCountOf,
  type CalibratedMutant,
  type CalibratedMutants,
  type RtllmMutationCalibrator,
} from './mutation-calibration.js';

/** Workspace filename a MUTANT design is materialized under for a negative-control run. */
export const MUTANT_WORKSPACE_FILENAME = 'dut_mutant.v' as const;

/** Workspace filename OUR testbench is materialized under for a negative-control run. */
export const NEGATIVE_CONTROL_TESTBENCH_FILENAME = 'negative_control_tb.v' as const;

/** Longest testbench the negative control will submit; bounds untrusted model output. */
const MAX_TESTBENCH_CHARS = 200_000;

/** The injected collaborators one negative control needs; no globals. */
export interface RtllmNegativeControlDeps {
  /** The SAME oracle adapter the loop's own verdict came from. */
  readonly simulator: SimulatorAdapter;
  /** Decides which mutants count, using RTLLM's own golden testbench. */
  readonly calibrator: RtllmMutationCalibrator;
  /** Wall clock, injected so the per-sample added time is measurable and testable. */
  readonly now?: () => number;
}

/** The identity fields of a mutant, without its RTL, for the survivor record. */
function identityOf(mutant: Mutant): MutantIdentity {
  return { mutantId: mutant.mutantId, operator: mutant.operator, site: mutant.site };
}

/**
 * What one valid mutant's run established: a kill of a stated kind, or a survivor.
 *
 * A discriminated union rather than a boolean plus a nullable kind, so "survived, killed by
 * timeout" is not representable.
 */
type MutantOutcome =
  { readonly kind: 'killed'; readonly by: MutantKillKind } | { readonly kind: 'survived' };

/** The two survivor buckets, accumulated as the probe walks the valid set in order. */
interface ProbeTally {
  readonly killedCount: number;
  readonly noVerdictKills: number;
  readonly coverageGapSurvivors: readonly MutantIdentity[];
  readonly candidateEquivalentSurvivors: readonly MutantIdentity[];
}

/** The empty tally a probe starts from. */
const EMPTY_TALLY: ProbeTally = Object.freeze({
  killedCount: 0,
  noVerdictKills: 0,
  coverageGapSurvivors: Object.freeze([]),
  candidateEquivalentSurvivors: Object.freeze([]),
});

/**
 * Fold one mutant's outcome into the tally (pure).
 *
 * A survivor is bucketed by the INDEPENDENT judge's verdict on the same mutant, which is the
 * only place that verdict is used: `goldenKilled` makes it a definite coverage gap, because the
 * judge has demonstrated the bug is catchable and ours did not catch it. Otherwise it is
 * candidate-equivalent - flagged for review, never excluded, because simulation cannot decide
 * equivalence.
 */
function fold(tally: ProbeTally, entry: CalibratedMutant, outcome: MutantOutcome): ProbeTally {
  if (outcome.kind === 'killed') {
    return {
      ...tally,
      killedCount: tally.killedCount + 1,
      noVerdictKills: tally.noVerdictKills + (outcome.by === 'no-verdict' ? 1 : 0),
    };
  }
  const identity = identityOf(entry.mutant);
  return goldenKilled(entry)
    ? { ...tally, coverageGapSurvivors: [...tally.coverageGapSurvivors, identity] }
    : { ...tally, candidateEquivalentSurvivors: [...tally.candidateEquivalentSurvivors, identity] };
}

/** A `MutationNegativeControl` over RTLLM's reference designs and golden testbenches. */
export class RtllmMutationNegativeControl implements MutationNegativeControl {
  readonly #deps: RtllmNegativeControlDeps;

  constructor(deps: RtllmNegativeControlDeps) {
    this.#deps = deps;
  }

  /**
   * Run OUR testbench against every VALID mutant and report what it killed.
   *
   * Total by construction: every path that cannot produce a measurement returns
   * `unavailable` with a reason, so a broken probe can only move a sample OUT of the pass@k
   * denominator and can never end a campaign.
   */
  async probe(request: MutationProbeRequest): Promise<MutationProbeOutcome> {
    const startedAtMs = this.#now();
    try {
      return await this.#measure(request, startedAtMs);
    } catch {
      // Sanitized, fail-safe: the thrown detail routinely names a sandbox workspace path, so
      // it is neither read nor propagated. The instrument stays unproven.
      return { kind: 'unavailable', reason: 'probe-errored' };
    }
  }

  /** The measurement itself, once the guards above are in place. */
  async #measure(
    request: MutationProbeRequest,
    startedAtMs: number,
  ): Promise<MutationProbeOutcome> {
    if (request.testbench.length === 0 || request.testbench.length > MAX_TESTBENCH_CHARS) {
      // Unreachable through `RtllmInstrumentControl`, which refuses an unsubmittable
      // testbench before the positive control runs; guarded because the port is public.
      return { kind: 'unavailable', reason: 'probe-errored' };
    }
    const calibrated = await this.#deps.calibrator.calibrate(request.problemId, request.limits);
    if (calibrated === null) {
      return { kind: 'unavailable', reason: 'no-reference' };
    }
    if (calibrated.generatedCount === 0) {
      return { kind: 'unavailable', reason: 'no-mutants-generated' };
    }
    if (calibrated.valid.length === 0) {
      // Not one mutant compiled, so there was nothing to kill and killing nothing proves
      // nothing. Reported as unchecked rather than as a pass.
      return { kind: 'unavailable', reason: 'no-valid-mutants' };
    }
    const tally = await this.#tally(calibrated, request);
    return {
      kind: 'measured',
      report: {
        validCount: calibrated.valid.length,
        killedCount: tally.killedCount,
        noVerdictKills: tally.noVerdictKills,
        coverageGapSurvivors: tally.coverageGapSurvivors,
        candidateEquivalentSurvivors: tally.candidateEquivalentSurvivors,
        goldenKilledCount: goldenKilledCountOf(calibrated),
        goldenTimeoutCount: goldenTimeoutCountOf(calibrated),
        nonCompilingCount: calibrated.nonCompilingCount,
        goldenErroredCount: calibrated.goldenErroredCount,
        generatedCount: calibrated.generatedCount,
        elapsedMs: Math.max(0, this.#now() - startedAtMs),
      } satisfies MutationProbeReport,
    };
  }

  /** Run our testbench against every valid mutant, in calibration order, and tally. */
  async #tally(calibrated: CalibratedMutants, request: MutationProbeRequest): Promise<ProbeTally> {
    let tally = EMPTY_TALLY;
    for (const entry of calibrated.valid) {
      tally = fold(tally, entry, await this.#run(entry.mutant, request));
    }
    return tally;
  }

  /**
   * What our testbench made of one mutant.
   *
   * `pass` is the only survival: the testbench certified a design we deliberately broke. `fail`
   * is a kill it can take credit for. Everything else is `error`, which collapses a timeout, a
   * crash, and an empty capture into one value (see `SimulationVerdict`) - still a kill, since
   * the loop cannot mint `Verified` from it, but recorded as `no-verdict` so it is never mistaken
   * for demonstrated coverage.
   *
   * It runs under the MUTANT wall cap, not the student session's: a mutant that hangs OUR
   * testbench costs the whole cap too, and the probe is one run per valid mutant. Every other
   * resource cap stays the caller's, because only the RTL under the testbench may differ from
   * the oracle's own run (see `mutantRunLimits`).
   *
   * The cap is READ FROM THE CALIBRATOR rather than held here as well. It has one owner, and it
   * has to: the calibrator's cache key records the cap its verdicts were measured under, so a
   * second copy of the knob could drift and leave the independent judge and our own testbench
   * answering "does this mutant hang?" on two different clocks.
   */
  async #run(mutant: Mutant, request: MutationProbeRequest): Promise<MutantOutcome> {
    const simulation = await this.#deps.simulator.simulate(
      [mutantFile(mutant)],
      { path: NEGATIVE_CONTROL_TESTBENCH_FILENAME, contents: request.testbench },
      mutantRunLimits(request.limits, this.#deps.calibrator.mutantWallMs),
    );
    if (simulation.verdict === 'pass') {
      return { kind: 'survived' };
    }
    return {
      kind: 'killed',
      by: simulation.verdict === 'fail' ? 'reported-failure' : 'no-verdict',
    };
  }

  /** The injected clock, or the wall clock. */
  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }
}

/** One mutant as a workspace source file. */
function mutantFile(mutant: Mutant): SourceFile {
  return { path: MUTANT_WORKSPACE_FILENAME, contents: mutant.rtl };
}
