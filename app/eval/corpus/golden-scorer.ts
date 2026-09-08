// The golden-testbench scorer: the INDEPENDENT JUDGE of a candidate's correctness.
//
// WHY THIS EXISTS AT ALL
//   The Verification_Loop's oracle is `iverilog` + `vvp` run against the AGENT'S OWN
//   spec-derived testbench. That is the right oracle for the loop - it is what makes
//   repair possible - but it is not a neutral scorer. A pass@k computed from the
//   loop's own verdict measures SELF-GRADED success: if the agent's testbench is
//   weak, a wrong design passes and the number goes up. RTLLM's `testbench.v` was
//   written by someone else, before us, against the reference design, and we do not
//   get to touch it. That is what makes it a judge.
//
//   So each sample can carry TWO verdicts: the loop's own (which drove repair) and
//   the golden one (which decides the reported pass@k). Their disagreement rate is
//   the empirical answer to "do our agent-written testbenches actually catch bugs" -
//   see `../golden-judge.ts` for the recording seam.
//
// WHAT IS DELIBERATELY NOT REUSED
//   `IcarusSimulatorAdapter` is not used here, for two independent reasons:
//     1. It parses `CHECK <name> PASS|FAIL`, our own convention. The golden
//        testbenches print VCS-style banners; `golden-banner.ts` reads those.
//     2. It declares `vcd` a REQUIRED output, so a run that produced no waveform is
//        classified `error`. The golden testbenches never call `$dumpfile`, so
//        requiring a VCD would classify every single golden run as an error. The
//        waveform is a teaching artifact for a student session, not evidence a judge
//        needs, so this scorer requires only `stdout` and `exitCode`.
//   Everything below that line IS reused: the same `ToolRunner` seam, the same
//   validated job contract, the same confinement, the same resource caps, the same
//   real `iverilog`/`vvp`. The judge runs on the same rails as the oracle.
//
// SANDBOX NOTE
//   The candidate RTL is model-authored and the testbench is third-party, so this
//   MUST be driven through a `ToolRunner` (which is the only surface allowed to
//   execute either). The runner is injected; this module never picks a runtime, so a
//   caller on an untrusted path wires the gVisor-isolated runtime and a caller on a
//   provisioned eval host wires the local-worker one.

import type {
  RequiredOutput,
  ResourceLimits,
  SandboxJob,
  SourceFile,
  ToolRunner,
} from '@app/tools';

import type { GoldenTestbench } from './corpus-types.js';
import { parseGoldenVerdict, type GoldenVerdict } from './golden-banner.js';

/**
 * The outputs a golden run must produce for its capture to be complete.
 *
 * `stdout` carries the banners this scorer reads and `exitCode` proves the process
 * ran. No `vcd`: the unmodified golden testbenches do not write one (see header).
 */
const GOLDEN_REQUIRED_OUTPUTS: readonly RequiredOutput[] = Object.freeze(['stdout', 'exitCode']);

/** Workspace filename the candidate RTL is materialized under. */
export const CANDIDATE_WORKSPACE_FILENAME = 'candidate.v' as const;

/** Longest candidate RTL the scorer will submit; bounds untrusted model output. */
const MAX_CANDIDATE_CHARS = 200_000;

/** The judge's verdict on one candidate, plus sanitized diagnostics. */
export interface GoldenScore {
  readonly problemId: string;
  readonly verdict: GoldenVerdict;
  /**
   * Whether the run was KILLED for exceeding its wall-clock cap.
   *
   * Threaded from `SandboxResult.timedOut` rather than inferred, because a
   * wall-clock kill leaves nothing to infer FROM: the runtime reports no exit code,
   * no streams, and zeroed usage. It is load-bearing for exactly one caller -
   * mutation calibration, where a golden testbench that never terminates on a
   * mutant is a KILL and a golden testbench that failed to build is not a usable
   * mutant at all (see `./mutation-calibration.ts`).
   *
   * It never decides THIS module's verdict. The banner still does that, and a
   * timed-out run printed no banner, so it is already `error` here.
   */
  readonly timedOut: boolean;
  /**
   * Whether the run was KILLED for exceeding its workspace disk cap.
   *
   * Carried for the same reason and the same caller as `timedOut`: both mean a
   * resource bound we imposed stopped the run before it finished, and mutation
   * calibration reads that as a golden KILL. Without this flag a hang that trips the
   * disk cap first - a mutant that makes a waveform-dumping testbench spin - would
   * arrive indistinguishable from a golden run that failed to build, and would drop
   * out of the valid-mutant denominator and the gate set. The cause has to be stated
   * for the calibration to keep meaning what it meant.
   */
  readonly diskLimitExceeded: boolean;
  /** The process exit code, or `null` when the process did not run to an exit. */
  readonly exitCode: number | null;
  /**
   * Compiler/simulator diagnostics, truncated. Carried for triage only - it is
   * upstream tool output and is never used to decide the verdict.
   */
  readonly diagnostics: string;
}

/** Most diagnostic characters retained, so one broken candidate cannot flood a report. */
const MAX_DIAGNOSTIC_CHARS = 4_000;

/**
 * Assemble the sandbox job for one golden run: the RTL under test, the UNMODIFIED
 * golden testbench, and the data files it reads.
 *
 * The candidate is listed first so a compiler that reports the first error it meets
 * points at the candidate rather than at the judge. Pure and exported so job
 * assembly is unit-testable without a toolchain.
 */
export function assembleGoldenJob(
  rtl: SourceFile,
  golden: GoldenTestbench,
  limits: ResourceLimits,
): SandboxJob {
  return {
    kind: 'simulate',
    workspaceFiles: [rtl, golden.testbench, ...golden.dataFiles],
    limits,
    requiredOutputs: GOLDEN_REQUIRED_OUTPUTS,
  };
}

/** The judge port: score one RTL candidate against a design's golden testbench. */
export interface GoldenTestbenchScorer {
  score(rtl: SourceFile, golden: GoldenTestbench, limits: ResourceLimits): Promise<GoldenScore>;
}

/**
 * A sanitized `error` score for a candidate we refuse to submit.
 *
 * Both resource-kill flags are `false` because no run happened at all: nothing was
 * submitted, so nothing exceeded a cap. Reporting `true` would claim a measurement
 * never made.
 */
function refusedScore(problemId: string, detail: string): GoldenScore {
  return {
    problemId,
    verdict: { kind: 'error', failureCount: null, banners: [] },
    timedOut: false,
    diskLimitExceeded: false,
    exitCode: null,
    diagnostics: detail,
  };
}

/**
 * `GoldenTestbenchScorer` over the Tool_Runner sandbox running iverilog + vvp.
 *
 * The verdict comes only from what the golden testbench PRINTED. A non-zero exit
 * code is not read as a failure and a zero exit code is not read as a pass: several
 * golden testbenches end without `$finish` and exit codes vary, whereas the banner is
 * the signal upstream actually defined. A run with no banner is `error` - fail-safe,
 * never a pass.
 */
export class SandboxGoldenTestbenchScorer implements GoldenTestbenchScorer {
  readonly #toolRunner: ToolRunner;

  constructor(toolRunner: ToolRunner) {
    this.#toolRunner = toolRunner;
  }

  async score(
    rtl: SourceFile,
    golden: GoldenTestbench,
    limits: ResourceLimits,
  ): Promise<GoldenScore> {
    if (rtl.contents.length === 0) {
      return refusedScore(golden.problemId, 'the candidate RTL is empty');
    }
    if (rtl.contents.length > MAX_CANDIDATE_CHARS) {
      return refusedScore(golden.problemId, 'the candidate RTL exceeded the submittable size');
    }
    const result = await this.#toolRunner.run(assembleGoldenJob(rtl, golden, limits));
    return {
      problemId: golden.problemId,
      // The sandbox may already have classified the run `error` (timeout, infra
      // failure, missing capture). That is exactly the case where no banner reached
      // stdout, so the banner parser reaches the same conclusion from the evidence
      // rather than from a second, duplicated rule.
      verdict: parseGoldenVerdict(result.stdout),
      // Carried, not re-derived: the sandbox is the only layer that observed the
      // wall-clock kill, and it leaves no residual field a reader could infer it
      // from (see `SandboxResult.timedOut`).
      timedOut: result.timedOut,
      // Same discipline for the disk cap: the worker enforces it and the sandbox
      // reports it, and a disk-cap kill leaves a plausible exit code behind, so
      // re-deriving it here would mean guessing at a tool failure.
      diskLimitExceeded: result.diskLimitExceeded,
      exitCode: result.exitCode,
      diagnostics: result.stderr.slice(0, MAX_DIAGNOSTIC_CHARS),
    };
  }
}
