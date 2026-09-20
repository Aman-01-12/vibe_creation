// The Simulator adapter: Icarus Verilog (iverilog + vvp) as the deterministic
// oracle for functional correctness (design "Tool_Runner and EDA adapters"; Req
// 2.5, 8.1).
//
// This adapter sits ON TOP of the Tool_Runner sandbox. It does not isolate, run
// tools, or classify capture-all-or-error itself; it assembles a `SandboxJob`
// (the RTL and testbench as workspace files, the VCD as a required output),
// drives it through an injected `ToolRunner`, and interprets the raw
// `SandboxResult` into a per-check functional verdict plus the captured waveform.
//
// Division of responsibility (kept single-owner, never duplicated):
//   - The sandbox (`ToolRunner`) owns isolation, path confinement, and
//     capture-all-or-error: a timeout, an infrastructure failure, or a missing
//     required output (including a missing VCD) already yields a `SandboxResult`
//     with verdict `error`.
//   - This adapter layers the per-check FUNCTIONAL pass/fail on top of a run whose
//     capture succeeded, by parsing the testbench's per-check signalling and
//     feeding it to the core verdict rules so pass integrity holds (Req 8.10).
//   - The core `classifyVerdict` (`@app/core`) owns the pass/fail/error decision;
//     it is reused here, never reimplemented.
//
// The Simulator turns a run into a pass/fail signal and a waveform; it never
// assigns trust. Constructing a `VerificationResult` or a `Verified` label is the
// Verification_Loop's and Trust_Labeler's job, not this adapter's.

import { classifyVerdict, type CheckResult, type InvocationOutcome, type Verdict } from '@app/core';

import type {
  ArtifactBlobRef,
  RequiredOutput,
  ResourceLimits,
  ResourceUsage,
  SandboxJob,
  SandboxResult,
  SourceFile,
  ToolRunner,
} from '../sandbox/index.js';
import { readCheckSignals } from './check-signalling.js';
import { classifyRunFailure, type RunFailureCause } from './failure-attribution.js';

/**
 * The artifact-map key under which the captured VCD waveform is returned.
 *
 * Matches the sandbox worker's VCD key and the `vcd` `RequiredOutput`, so the
 * adapter finds the waveform the run produced.
 */
const VCD_ARTIFACT_KEY = 'vcd' as const;

/**
 * The outputs a simulate invocation must produce for its capture to be complete.
 *
 * `stdout` carries the per-check signalling this adapter parses, `exitCode` marks
 * that the process ran, and `vcd` is the waveform artifact. If any is missing the
 * sandbox classifies the whole run `error` (capture-all-or-error), so a completed
 * capture is guaranteed to carry the waveform.
 */
const SIMULATE_REQUIRED_OUTPUTS: readonly RequiredOutput[] = ['stdout', 'exitCode', 'vcd'];

/**
 * The interpreted outcome of one compile-and-simulate run.
 *
 * Reuses the core `Verdict` and `CheckResult` types rather than redefining them.
 * `checks` is the per-spec-check signal parsed from the run; `vcd` is the captured
 * waveform reference (absent only when the run errored before producing it); the
 * stream, exit-code, and resource fields are carried for diagnostics.
 */
export interface SimulationVerdict {
  /** `pass` iff every spec-derived check passed; `error` on tool/infra failure or a non-verifying run. */
  readonly verdict: Verdict;
  /** The per-check results parsed from the testbench signalling, in emission order. */
  readonly checks: readonly CheckResult[];
  /** The captured VCD waveform, or `null` when the run errored before producing one. */
  readonly vcd: ArtifactBlobRef | null;
  /** The simulation's standard output (source of the per-check signalling), for diagnostics. */
  readonly stdout: string;
  /** The simulation's standard error, for diagnostics. */
  readonly stderr: string;
  /** The process exit code, or `null` if the process did not run to an exit. */
  readonly exitCode: number | null;
  /** Observed resource consumption of the run. */
  readonly resourceUsage: ResourceUsage;
  /**
   * Why this run's verdict is `error`; `none` for a run that reached `pass` or `fail`.
   *
   * Required, not optional: an optional field would let a caller construct a verdict
   * meaning "cause unknown", which is the exact collapse this field exists to undo
   * (design "SimulationVerdict delta"). Derived by `classifyRunFailure` from the
   * sandbox's own `timedOut` / `diskLimitExceeded` / `stdoutTruncated` flags, never
   * from `verdict` itself, so adding it cannot move the verdict it explains (Property 1).
   */
  readonly failureCause: RunFailureCause;
  /**
   * The submitted workspace files a build diagnostic named; a subset of the paths
   * this run's job submitted, in submission order. Empty unless `failureCause` is
   * `build-failed` (Property 3).
   */
  readonly attributedFiles: readonly string[];
}

/**
 * The Simulator port (design "Tool_Runner and EDA adapters"): compile and simulate
 * an RTL candidate against an independently derived testbench, returning the
 * per-check functional verdict and the waveform. Callers depend on this interface,
 * not on the concrete iverilog/vvp implementation.
 */
export interface SimulatorAdapter {
  simulate(
    rtl: readonly SourceFile[],
    testbench: SourceFile,
    limits: ResourceLimits,
  ): Promise<SimulationVerdict>;
}

/**
 * Assemble the `SandboxJob` for a simulate run: the RTL sources plus the testbench
 * as workspace files, the fixed simulate required-output set, and the caller's
 * resource limits. Pure and exported so job assembly is unit-testable in isolation.
 */
export function assembleSimulateJob(
  rtl: readonly SourceFile[],
  testbench: SourceFile,
  limits: ResourceLimits,
): SandboxJob {
  return {
    kind: 'simulate',
    workspaceFiles: [...rtl, testbench],
    limits,
    requiredOutputs: SIMULATE_REQUIRED_OUTPUTS,
  };
}

/** The captured VCD waveform reference from a result, or `null` when absent. */
function capturedVcd(result: SandboxResult): ArtifactBlobRef | null {
  return result.artifacts[VCD_ARTIFACT_KEY] ?? null;
}

/**
 * Interpret a raw `SandboxResult` into a `SimulationVerdict`.
 *
 * `submittedPaths` is the workspace file paths the job submitted (the RTL and
 * testbench `assembleSimulateJob` placed in `workspaceFiles`), passed through
 * unread except by `classifyRunFailure`, which uses it solely to identify which
 * submitted file a build diagnostic named (Property 3). Defaults to `[]` so
 * existing callers that interpret a result outside a real job (unit tests, the
 * reproducibility property) keep compiling; an empty list can only ever yield
 * `attributedFiles: []`, never a wrong attribution.
 *
 * The sandbox already reserved `error` for a timeout, a workspace disk-cap kill, an
 * infrastructure failure, or a missing required output (including the VCD); that
 * decision is propagated unchanged with no checks, because such a run verified
 * nothing about the design. For a run whose
 * capture succeeded, the per-check functional verdict is derived from the testbench
 * signalling via the core rules: a completed run with no readable check is `error`
 * (verified nothing), any failing check is `fail`, a run that emitted a check
 * signal the reader could not parse is `error` (it verified nothing about that
 * check, so it must not read as a pass), a run whose stdout was TRUNCATED is
 * `error` for the same reason one step earlier (a failing check may sit in the
 * bytes the Tool_Runner never retained), and only an entirely readable, entirely
 * complete, entirely passing run is `pass` (Req 8.10).
 *
 * `verdict` is computed by `classifyVerdict` exactly as before `failureCause` and
 * `attributedFiles` existed; `classifyRunFailure` only explains that verdict after
 * the fact and is never consulted to produce it (Property 1). Pure and exported for
 * unit testing.
 */
export function interpretSandboxResult(
  result: SandboxResult,
  submittedPaths: readonly string[] = [],
): SimulationVerdict {
  const vcd = capturedVcd(result);
  const attribution = classifyRunFailure(result, submittedPaths);
  const diagnostics = {
    vcd,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    resourceUsage: result.resourceUsage,
    failureCause: attribution.cause,
    attributedFiles: attribution.attributedFiles,
  };
  if (result.verdict === 'error') {
    return { verdict: 'error', checks: [], ...diagnostics };
  }
  const reading = readCheckSignals(result.stdout);
  const outcome: InvocationOutcome = {
    timedOut: false,
    toolFailure: false,
    completed: true,
    checks: reading.checks,
    unreadableCheckSignals: reading.unreadableSignals,
    // A run killed for exceeding its workspace disk cap stopped part-way through the
    // stimulus, so the checks it managed to print describe a fraction of it. Stated
    // here as well as in the sandbox for the same reason the truncation flag is: this
    // is the layer that reads the stream and derives the per-check verdict, and it
    // must not silently lose the precondition that the stream is the whole run.
    diskLimitExceeded: result.diskLimitExceeded,
    // The reader only ever saw `result.stdout`. If that is a bounded prefix, a
    // `CHECK ... FAIL` line may be among the bytes the Tool_Runner discarded, and
    // the retained prefix cannot rule it out - so the run must not read as `pass`.
    //
    // The sandbox already refuses a truncated run in `classifyCapture`, so on the
    // real path this branch is reached only with `false`. Stating the rule here
    // anyway is deliberate: THIS is the layer whose verdict actually depends on
    // reading stdout, and the sandbox's contribution rests on its own coarse
    // process-exit check, which is documented as a placeholder for exactly this
    // per-check classification. If that placeholder is ever narrowed, the layer
    // that reads the stream must not silently lose its precondition with it.
    stdoutTruncated: result.stdoutTruncated,
  };
  return { verdict: classifyVerdict(outcome), checks: reading.checks, ...diagnostics };
}

/**
 * `SimulatorAdapter` backed by the Tool_Runner sandbox running iverilog + vvp.
 *
 * The `ToolRunner` is injected so a `FakeSandboxRuntime`-backed runner can drive
 * the adapter in tests; the concrete sandbox runtime is never hardcoded here.
 */
export class IcarusSimulatorAdapter implements SimulatorAdapter {
  private readonly toolRunner: ToolRunner;

  constructor(toolRunner: ToolRunner) {
    this.toolRunner = toolRunner;
  }

  async simulate(
    rtl: readonly SourceFile[],
    testbench: SourceFile,
    limits: ResourceLimits,
  ): Promise<SimulationVerdict> {
    const job = assembleSimulateJob(rtl, testbench, limits);
    const result = await this.toolRunner.run(job);
    const submittedPaths = job.workspaceFiles.map((file) => file.path);
    return interpretSandboxResult(result, submittedPaths);
  }
}
