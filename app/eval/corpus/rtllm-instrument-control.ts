// The RTLLM-backed INSTRUMENT CONTROL: our own testbench, run against the known-good design
// and then against deliberately broken versions of it.
//
// THE SIBLING OF `./rtllm-golden-judge.ts`
//   The golden judge answers "is the CANDIDATE right?" by running a testbench we did not
//   write. This answers "is our TESTBENCH usable?" by running a design we did not write.
//   Same corpus, same sandbox, same caps, opposite direction - and both are needed, because
//   a disagreement between them is meaningless until the instrument is known to work.
//
// TWO PHASES, IN THIS ORDER, FOR A REASON
//   1. POSITIVE: does RTLLM's reference design pass our testbench? Falsifies a testbench that
//      passes nothing.
//   2. NEGATIVE: does our testbench kill deliberately mutated versions of that reference? It is
//      SCORED over every mutant that compiles and GATED on the ones the golden testbench itself
//      catches. Falsifies a testbench that passes everything (`./rtllm-negative-control.ts`).
//
//   Phase 2 runs only when phase 1 passed. A testbench that cannot pass the correct design has
//   already been falsified, and spending a mutant set's worth of simulations to reach the same
//   conclusion under a vaguer defect code would trade wall clock for less information. The
//   combination rule itself lives in `../instrument-control.ts`, so there is exactly one
//   owner of what `valid` means.
//
// WHY `IcarusSimulatorAdapter` IS REUSED HERE AND NOT IN THE GOLDEN SCORER
//   The golden scorer deliberately avoids that adapter: RTLLM's testbenches print VCS-style
//   banners and never call `$dumpfile`, so the adapter's CHECK parser and required VCD would
//   classify every golden run as an error (see `./golden-scorer.ts`).
//
//   The control has the opposite input. It runs OUR OWN generated testbench - the one that
//   emits `CHECK <name> PASS|FAIL` and writes a waveform - so `IcarusSimulatorAdapter` is
//   not merely usable, it is the only honest choice: it is the EXACT oracle that produced
//   the loop's verdict for this sample. The control changes one thing and one thing only,
//   the RTL under the testbench. Anything else would leave "the control disagreed because
//   it read the output differently" as a live explanation.
//
// THE MODULE-NAME MISMATCH IS ALREADY SOLVED UPSTREAM
//   Our testbench instantiates the Spec's module name (`right_shifter`) while RTLLM's
//   reference declares `verified_right_shifter`. No rename happens here, because
//   `importRtllmCorpus` already applied `renameTopModule` when it built each
//   `ReferenceDesign` - the same adapted reference Stage 0 drives against the golden
//   testbench. Consuming `RtllmCorpus.references` reuses that one decision (including its
//   whole-word boundary handling and its rename-collision quarantine) instead of adding a
//   second, weaker rename on this path.
//
// SANDBOX NOTE
//   The testbench is model-authored, so it MUST be driven through the sandbox. The
//   simulator adapter is injected and this module never picks a runtime, exactly like the
//   golden scorer.

import type { SimulationVerdict, SimulatorAdapter } from '@app/tools';

import {
  combineInstrumentControls,
  invalidInstrument,
  uncheckedInstrument,
  VALID_INSTRUMENT,
  type InstrumentControl,
  type InstrumentControlRequest,
  type InstrumentControlResult,
  type RecordedInstrumentVerdict,
} from '../instrument-control.js';
import type {
  MutationNegativeControl,
  MutationProbeOutcome,
  MutationProbeReport,
} from '../mutation-control.js';
import type { ReferenceDesign } from './corpus-types.js';
import { classifyNonPass } from './nonpass-cause.js';

/** Workspace filename OUR testbench is materialized under for a control run. */
export const CONTROL_TESTBENCH_WORKSPACE_FILENAME = 'instrument_control_tb.v' as const;

/** Longest testbench the control will submit; bounds untrusted model output. */
const MAX_TESTBENCH_CHARS = 200_000;

/** The result for a testbench the control declines to submit; no run, no streams. */
function refused(reason: 'testbench-unsubmittable'): InstrumentControlResult {
  return {
    verdict: uncheckedInstrument(reason),
    stdout: '',
    stderr: '',
    exitCode: null,
    mutation: null,
  };
}

/** The probe's report when it measured one, else `null`. */
function measuredReport(outcome: MutationProbeOutcome | null): MutationProbeReport | null {
  return outcome !== null && outcome.kind === 'measured' ? outcome.report : null;
}

/**
 * Classify one control run into an instrument verdict.
 *
 * A pass is the ONLY outcome that proves the instrument. Everything else is invalid, and
 * the cause is separated by the shared rule in `./nonpass-cause.ts` because the three cases
 * point at different defects: a testbench that REJECTS the reference has an incorrect
 * expectation (the measured `right_shifter` case: it assumed a reset the interface never
 * declared), a testbench that does not BUILD with the reference has a structural mismatch,
 * and a run that produced nothing proves nothing.
 *
 * Note that `SimulationVerdict.verdict === 'error'` collapses a compile failure, a timeout,
 * and a crash into one value, so the cause is re-derived from the diagnostics rather than
 * read off the verdict.
 */
function classifyControlRun(simulation: SimulationVerdict): RecordedInstrumentVerdict {
  if (simulation.verdict === 'pass') {
    return VALID_INSTRUMENT;
  }
  const cause = classifyNonPass({
    reportedFailure: simulation.verdict === 'fail',
    diagnostics: simulation.stderr,
  });
  if (cause === 'reported-failure') {
    return invalidInstrument('TESTBENCH_FAILED_REFERENCE');
  }
  if (cause === 'did-not-build') {
    return invalidInstrument('TESTBENCH_REFERENCE_UNBUILDABLE');
  }
  return invalidInstrument('CONTROL_RUN_ERRORED');
}

/** The injected collaborators one RTLLM instrument control needs; no globals. */
export interface RtllmInstrumentControlDeps {
  /** The SAME oracle adapter the loop's own verdict came from. */
  readonly simulator: SimulatorAdapter;
  /** The corpus's reference designs, keyed by problem id, already top-module-renamed. */
  readonly references: ReadonlyMap<string, ReferenceDesign>;
  /**
   * The NEGATIVE control, or absent to apply the positive-control-only standard.
   *
   * Absent is a legitimate configuration - a cheap run, or a benchmark with no golden
   * testbench to calibrate against - and the summary labels a run that used it, so a
   * positive-control-only `valid` is never cited as the full standard.
   */
  readonly negativeControl?: MutationNegativeControl;
}

/** An `InstrumentControl` backed by RTLLM's own reference designs. */
export class RtllmInstrumentControl implements InstrumentControl {
  readonly #deps: RtllmInstrumentControlDeps;

  constructor(deps: RtllmInstrumentControlDeps) {
    this.#deps = deps;
  }

  async check(request: InstrumentControlRequest): Promise<InstrumentControlResult | null> {
    const reference = this.#deps.references.get(request.problemId);
    if (reference === undefined) {
      return null;
    }
    if (request.testbench.length === 0 || request.testbench.length > MAX_TESTBENCH_CHARS) {
      return refused('testbench-unsubmittable');
    }
    const simulation = await this.#run(reference, request);
    const positive = classifyControlRun(simulation);
    const negative = await this.#probeMutants(positive, request);
    return {
      verdict: combineInstrumentControls({ positive, negative }),
      stdout: simulation.stdout,
      stderr: simulation.stderr,
      exitCode: simulation.exitCode,
      mutation: measuredReport(negative),
    };
  }

  /**
   * Phase 2: run the negative control, but only when phase 1 accepted the instrument.
   *
   * Returns `null` when no negative control is wired OR when the positive control already
   * falsified the testbench - the two cases the combination rule treats identically, because
   * in neither is there a mutation measurement to weigh.
   */
  #probeMutants(
    positive: RecordedInstrumentVerdict,
    request: InstrumentControlRequest,
  ): Promise<MutationProbeOutcome | null> {
    const negativeControl = this.#deps.negativeControl;
    if (negativeControl === undefined || positive.validity !== 'valid') {
      return Promise.resolve(null);
    }
    return negativeControl.probe({
      problemId: request.problemId,
      testbench: request.testbench,
      limits: request.limits,
    });
  }

  /** Drive the reference RTL against our testbench under the caller's sandbox caps. */
  #run(reference: ReferenceDesign, request: InstrumentControlRequest): Promise<SimulationVerdict> {
    return this.#deps.simulator.simulate(
      [reference.rtl],
      { path: CONTROL_TESTBENCH_WORKSPACE_FILENAME, contents: request.testbench },
      request.limits,
    );
  }
}
