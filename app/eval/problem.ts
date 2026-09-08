// The eval problem shape: one fixed benchmark problem the harness runs through the
// loop (Req 15.1).
//
// A problem carries exactly what the Verification_Loop needs to attempt it: the
// approved `Spec` that is the source of truth generation and the independent
// testbench both derive from, plus the confirmed-intent summary the loop-runner
// adapter uses to open the generation gate. The problem itself is inert data - it
// never decides pass/fail; the Simulator oracle inside the loop does (Req 15.3,
// 15.5). The concrete curated subset lives in `./subset`.

import type { Spec } from '@app/core';

/** The benchmark family a problem is drawn from. */
export type EvalProblemSource = 'VerilogEval' | 'RTLLM';

/**
 * One fixed benchmark problem.
 *
 * `id` is a stable, human-readable slug used both for reporting and as an input to
 * the deterministic per-sample seed derivation, so it must never change once a
 * baseline references it. `spec` is pre-approved (`spec.approved === true`) with an
 * exact module interface and simulation-verifiable acceptance criteria; the loop's
 * generation gate and oracle rely on both.
 */
export interface EvalProblem {
  /** Stable slug, e.g. `verilogeval/adder8`; also feeds the per-sample seed. */
  readonly id: string;
  /** Short human-readable title for the report. */
  readonly title: string;
  /** Which benchmark family this problem represents. */
  readonly source: EvalProblemSource;
  /** The approved Spec the loop generates against and the oracle verifies (Req 15.1). */
  readonly spec: Spec;
  /** The confirmed-intent summary the loop-runner adapter opens the gate with. */
  readonly intentSummary: string;
}
