// The seam between the Eval_Harness and the already-built Verification_Loop.
//
// The harness's job is orchestration and measurement: pick the subset, thread the
// student-session caps and the reproducibility config, run each sample, and compute
// pass@k / iterations-to-pass / cost. Actually driving one sample through the loop
// - opening the generation gate, running generation and the independent testbench,
// compiling and simulating inside the Tool_Runner sandbox, and labeling by oracle
// provenance - is the Verification_Loop's job. This module is the narrow port
// between them.
//
// Why a port rather than importing the loop directly: the seed and temperature
// (Req 15.10) reach the model provider through the Model_Router, which is
// constructed with the generation/testbench agents beneath the loop. Threading a
// per-sample seed therefore means constructing a seeded loop per sample - a
// composition concern that belongs at the wiring root (task 19.4), not in the
// measuring harness. Injecting this port keeps the harness unit-testable with a
// fake runner and free of any provider SDK, while the production adapter builds a
// seeded `VerificationLoop` and calls `verify`.

import type { ResourceLimits } from '@app/tools';
import type {
  InstrumentAdmission,
  PropertySetAdmissionOutcome,
  SessionBudgetHandle,
  StrategyArm,
  VerificationOutcome,
  PropertySetSource,
} from '@app/agent';

import type { EvalProblem } from './problem.js';

/**
 * The student-session caps every eval sample runs under (Req 15.2, 15.6, 17.3).
 *
 * These are the SAME caps a real student session gets, threaded unchanged into
 * every sample's budget - the harness never invents looser caps. The harness builds
 * a fresh budget from these caps for each sample so sessions never share
 * consumption.
 */
export interface StudentSessionCaps {
  readonly maxIterations: number;
  readonly maxTokens: number;
  readonly maxWallClockMs: number;
  readonly maxCostCents: number;
}

/** One sample run request handed to the loop runner. */
export interface EvalSampleRequest {
  /** The problem to attempt. */
  readonly problem: EvalProblem;
  /** The 0-based sample index within this problem. */
  readonly sampleIndex: number;
  /** The deterministic seed for this sample, threaded to the provider (Req 15.10). */
  readonly seed: number;
  /** The fixed sampling temperature for this run (Req 15.10). */
  readonly temperature: number;
  /** The metered student-caps budget for this session; the loop charges it. */
  readonly budget: SessionBudgetHandle;
  /** The sandbox resource limits, identical to a student session (Req 15.6). */
  readonly limits: ResourceLimits;
  /** The Strategy_Arm the sample's Testbench_Agent runs under (Req 6.1). */
  readonly strategyArm: StrategyArm;
  /**
   * The per-sample Instrument_Admission adapter, or absent when the runner should
   * validate the instrument only after the loop returns (Req 4.10, 4.14).
   */
  readonly instrumentAdmission?: InstrumentAdmission;
  /**
   * The sample's ALREADY-AUTHORED Property_Set source, or absent to let the loop author its own.
   *
   * Present only on a gated eval run, where the harness authored up front so the gate could
   * score the same artifact the loop reasons with. Absent is the SHIPPING path: the runner
   * constructs its own `PropertyAgent` and the loop authors when it needs to, exactly as a
   * student session does. So the two differ by the gate alone, which is what makes a gated and
   * an ungated run comparable; see design.md, Component 11a.
   */
  readonly propertySetSource?: PropertySetSource;
  /**
   * The Property_Set admission outcome, ALREADY DECIDED by the harness (Req 10.3, 13.6).
   *
   * THE SIGNAL, AND THE REASON IT TRAVELS ON THIS PORT. The admission gate reads a
   * reference design, so it lives in `app/eval` and nothing on the product path can reach
   * it; and `app/agent` holds no import of `app/eval` (Req 11.11, 13.6), so the loop cannot
   * compute this for itself. The harness therefore decides and the runner carries the
   * decision in: the loop receives a Property_Set already stamped with this outcome, or -
   * where `propertySetAdmissionFallsBack` holds, which today is `'refused'` alone - no
   * usable Property_Set at all, so the simulation path decides the sample.
   *
   * ABSENT means no gate was wired, which the loop already records as `'not-gated'`, so
   * there is nothing for the runner to stamp and the formal gate (where one is wired)
   * behaves exactly as it did before this seam existed.
   *
   * An adapter that wires NO formal gate - which is every adapter today - satisfies the
   * obligation trivially: with no Property_Set there is nothing a refused one could decide.
   * The obligation is on the adapter that wires one, and it is one condition: a sample whose
   * outcome falls back must not be given a Property_Set to decide from.
   */
  readonly propertySetAdmitted?: PropertySetAdmissionOutcome;
}

/**
 * The port the harness drives one sample through.
 *
 * The production adapter (task 19.4) implements this by constructing a
 * `VerificationLoop` wired to a Model_Router seeded with `request.seed` and
 * `request.temperature`, then calling `verify` with the problem's admission request,
 * the supplied budget, and the supplied limits. The returned `VerificationOutcome`
 * carries the oracle-decided verdict; the harness never second-guesses it.
 */
export interface EvalLoopRunner {
  runSample(request: EvalSampleRequest): Promise<VerificationOutcome>;
}
