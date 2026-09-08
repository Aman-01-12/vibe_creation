// The reviewed Stage 0 quarantine list: the designs whose own golden testbench is
// not a usable measuring stick under Icarus.
//
// WHY THIS IS A COMMITTED CONSTANT RATHER THAN A RUNTIME RESULT
//   Stage 0 needs the real toolchain, but the SCORED corpus has to be known without
//   it - the harness must be able to exclude a broken judge on a machine with no
//   `iverilog`, and a reviewer must be able to see which designs we dropped and why
//   without running anything. So the outcome is recorded here, and
//   `rtllm-corpus-stage0.integration.test.ts` asserts that a real Stage 0 run
//   reproduces this list EXACTLY - in both directions. A design that starts failing
//   fails the suite; a quarantined design that starts passing also fails it, so the
//   list can only shrink through a deliberate, reviewed edit. It is a ratchet, the
//   same discipline the eval pass@k gate uses for its baseline.
//
// WHAT THESE FOUR CASES ACTUALLY ARE
//   Two are the VCS-versus-Icarus dialect gap: the golden testbench uses syntax
//   Synopsys VCS accepts and Icarus 13 does not, so nothing even elaborates. Two are
//   the reference genuinely not passing its own testbench under Icarus - one from a
//   same-timestep sampling race whose resolution is simulator-dependent, one from a
//   handshake the testbench does not hold long enough. In every case the judge cannot
//   distinguish "the candidate is wrong" from "the judge is broken", which is exactly
//   what makes the design unusable for scoring.
//
// NOTE: this is a statement about the INSTRUMENT, not about RTLLM's quality. Upstream
// validated these against VCS; we run Icarus.

import type { EvalProblem } from '../problem.js';
import type { QuarantinedDesign, QuarantineReasonCode, RtllmCorpus } from './corpus-types.js';
import { asRtllmCategory, type RtllmCategory } from './pinned-source.js';

/** One reviewed Stage 0 exclusion's reason code; a narrowing of the corpus vocabulary. */
type Stage0ReasonCode = Extract<
  QuarantineReasonCode,
  'REFERENCE_COMPILE_FAILED' | 'REFERENCE_FAILED_GOLDEN' | 'REFERENCE_RUN_ERRORED'
>;

/** One reviewed Stage 0 exclusion. */
export interface Stage0QuarantineEntry {
  readonly problemId: string;
  /** Restricted to the Stage 0 codes, so an import-stage reason cannot be recorded here. */
  readonly code: Stage0ReasonCode;
  /** The engineering reason, recorded so the exclusion is reviewable, not just counted. */
  readonly reason: string;
}

/**
 * The designs excluded by Stage 0 at `RTLLM_PINNED_COMMIT`, under Icarus Verilog 13.
 *
 * Measured, not assumed: every entry was produced by running the design's own
 * reference RTL against its own unmodified golden testbench through the real
 * `iverilog` + `vvp` toolchain.
 */
export const STAGE0_QUARANTINE: readonly Stage0QuarantineEntry[] = Object.freeze([
  {
    problemId: 'rtllm/arithmetic/radix2_div',
    code: 'REFERENCE_FAILED_GOLDEN',
    reason:
      "The reference fails 3 of its own 8 checks under Icarus (the two signed-dividend cases and the a==b case). The testbench drives the next operand while holding res_ready high and then waits on res_valid, so it can sample the previous operation's result; whether it does is event-ordering dependent, and VCS and Icarus order it differently.",
  },
  {
    problemId: 'rtllm/control/ring_counter',
    code: 'REFERENCE_COMPILE_FAILED',
    reason:
      "VCS-versus-Icarus dialect gap: the golden testbench initializes an unpacked array with an aggregate concatenation (reg [7:0] data [0:9] = {8'b1, ...}). Icarus 13 reports an internal elaboration error, so nothing runs.",
  },
  {
    problemId: 'rtllm/miscellaneous/freq_divbyeven',
    code: 'REFERENCE_COMPILE_FAILED',
    reason:
      'VCS-versus-Icarus dialect gap: the golden testbench declares a localparam inside a named generate-for block and uses it as a parameter override. Icarus 13 reports a syntax error at the instantiation, so nothing runs.',
  },
  {
    problemId: 'rtllm/miscellaneous/clkgenerator',
    code: 'REFERENCE_FAILED_GOLDEN',
    reason:
      'The golden testbench samples clk at exactly the timestep the reference toggles it (both use a #5 half-period with no timescale), so the check is a same-timestep race. Icarus resolves it to the pre-toggle value and all 20 checks mismatch; VCS resolves it the other way.',
  },
]);

/** The quarantined problem ids, derived so the two can never drift apart. */
export const STAGE0_QUARANTINED_PROBLEM_IDS: readonly string[] = Object.freeze(
  STAGE0_QUARANTINE.map((entry) => entry.problemId),
);

/**
 * The number of designs upstream ships whose reference passes its own golden
 * testbench under Icarus: the real, usable size of the scored corpus.
 *
 * 50 imported, 48 build, 46 pass. This is the denominator any honest pass@k over this
 * corpus is reported against.
 */
export const RTLLM_SCORED_DESIGN_COUNT = 46;

/** Split a `rtllm/<category>/<design>` id into the parts a quarantine record needs. */
function describeProblemId(problemId: string): {
  readonly category: RtllmCategory;
  readonly designName: string;
} {
  const [, categoryPart = '', designName = ''] = problemId.split('/');
  const capitalized = categoryPart.charAt(0).toUpperCase() + categoryPart.slice(1);
  return { category: asRtllmCategory(capitalized) ?? 'Miscellaneous', designName };
}

/** Turn a reviewed entry into a quarantine record in the corpus's own vocabulary. */
function toQuarantinedDesign(entry: Stage0QuarantineEntry): QuarantinedDesign {
  const { category, designName } = describeProblemId(entry.problemId);
  return {
    problemId: entry.problemId,
    designName,
    category,
    stage: 'stage0',
    code: entry.code,
    detail: entry.reason,
  };
}

/**
 * The scored corpus: the imported corpus with the Stage 0 exclusions moved out of
 * `problems` and into `quarantined`.
 *
 * Requires no toolchain, so any consumer - including a machine that cannot run
 * `iverilog` - gets the same honest problem set. Exclusions are moved, never deleted:
 * the reason travels with them so a report can state exactly what was dropped.
 */
export function scoredRtllmCorpus(corpus: RtllmCorpus): RtllmCorpus {
  const excluded = new Set(STAGE0_QUARANTINED_PROBLEM_IDS);
  const problems: EvalProblem[] = corpus.problems.filter((problem) => !excluded.has(problem.id));
  const dropped = STAGE0_QUARANTINE.filter((entry) =>
    corpus.problems.some((problem) => problem.id === entry.problemId),
  ).map(toQuarantinedDesign);
  return {
    ...corpus,
    problems,
    quarantined: [...corpus.quarantined, ...dropped],
  };
}
