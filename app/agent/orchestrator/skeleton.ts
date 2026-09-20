// The M0 Orchestrator skeleton: the oracle-path spine (Req 1.4, 1.5).
//
// This is the minimal end-to-end proof that a student-supplied Verilog module and
// a matching testbench can be compiled, simulated in the sandbox, and reported as
// exactly one of `pass` / `fail` / `error`, with the run recorded as a replayable
// Trace span. It is deliberately NOT the M1 agentic loop: there is no generation,
// no repair, no intent/spec stages, and no model routing here. It drives a single
// simulate invocation through the injected Simulator adapter and records it.
//
// Division of responsibility (single owner, never duplicated):
//   - The API_Gateway owns inbound validation of the module and testbench (Req
//     1.6); the Tool_Runner sandbox re-validates the assembled job at its own
//     trust boundary. This skeleton therefore assumes validated inputs and does
//     not re-validate their contents, but it never trusts blindly: it keeps its
//     input types tight and it fails safe by classifying any exception from the
//     simulate path as an `error` verdict rather than letting it crash the spine.
//   - The Simulator adapter owns compile-and-simulate and the per-check pass/fail
//     interpretation; this skeleton reuses its `SimulationVerdict` unchanged.
//   - The Action_Recorder owns span ordering and secret/PII redaction; this
//     skeleton hands it a raw draft and never sanitizes itself.
//
// Time bound (Req 1.4): the run is bounded SOLELY by the sandbox wall-clock cap
// carried in `limits.wallMs`, which the Tool_Runner runtime enforces by killing an
// overrunning run and returning an `error` verdict. The M0 skeleton intentionally
// does NOT open or consult a Session_Budget; the agentic Session_Budget accounting
// that fully satisfies Req 1.4's time limit in M1 is added later in task 8.1. The
// oracle-path proof needs no agentic budget, so M0 stays self-contained.

import type { FailureClass, Json, TraceSpan, Ulid, Verdict } from '@app/core';
import type { ResourceLimits, SimulationVerdict, SimulatorAdapter, SourceFile } from '@app/tools';

import type { ActionRecorder, SpanDraft } from '../action-recorder/index.js';

/** The Trace `stageOrTool` name recorded for a skeleton simulate invocation. */
const SIMULATOR_STAGE = 'Simulator' as const;

/** The M0 skeleton performs no retries and no repair, so every span records zero. */
const SKELETON_RETRY_COUNT = 0 as const;

/**
 * Cost recorded for a skeleton run. Cost accounting is an M1 concern that arrives
 * with the Session_Budget (task 8.1); the oracle path itself spends no model cost.
 */
const SKELETON_COST_CENTS = 0 as const;

/**
 * An already-validated request to compile and simulate one module against its
 * matching testbench on the skeleton path.
 *
 * `sessionId` identifies the recorder session the span is appended to (the
 * API_Gateway opens the session upstream). Contents are assumed validated by the
 * gateway and re-checked by the sandbox; the tight types are the skeleton's own
 * guard against malformed inputs.
 */
export interface SkeletonSimulationRequest {
  /** The session whose Trace this run is recorded under. */
  readonly sessionId: Ulid;
  /** The candidate RTL sources (at least the module under test). */
  readonly rtl: readonly SourceFile[];
  /** The independently derived testbench that decides correctness. */
  readonly testbench: SourceFile;
  /** Per-invocation sandbox caps; `wallMs` is the sole time bound for this run. */
  readonly limits: ResourceLimits;
}

/**
 * The outcome of one skeleton compile-and-simulate run.
 *
 * `simulation.verdict` is the reported `pass` / `fail` / `error` (Req 1.5). `span`
 * is the recorded provenance the Trust_Labeler binds a `Verified` label to in a
 * later task; it is returned so the caller need not re-read the Trace to obtain
 * the run's identity.
 */
export interface SkeletonSimulationResult {
  /** The full Simulator verdict, whose `verdict` field is the reported result. */
  readonly simulation: SimulationVerdict;
  /** The ordered, sanitized Trace span recorded for this run. */
  readonly span: TraceSpan;
}

/** The synthesized `SimulationVerdict` for a run that failed before the oracle spoke. */
function toolFailureVerdict(): SimulationVerdict {
  return {
    verdict: 'error',
    checks: [],
    vcd: null,
    stdout: '',
    stderr: '',
    exitCode: null,
    resourceUsage: { wallMs: 0, maxMemMb: 0, cpuMs: 0 },
    // No SandboxResult ever existed to classify: the simulator threw before the
    // oracle produced one, so there is no cause to name beyond "the tool failed".
    failureCause: 'tool-failed',
    attributedFiles: [],
  };
}

/** Extract a diagnostic message from a thrown value without leaking its structure. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The best-effort failure classification for a non-passing verdict (Req 3.4).
 *
 * A functional `fail` is a testbench check failure; every `error` on the skeleton
 * path is a tool or infrastructure failure (a sandbox timeout, an infra failure,
 * or a run that verified nothing), so it is recorded as `tool-error`. A `pass`
 * carries no failure class.
 */
function failureClassFor(verdict: Verdict): FailureClass | undefined {
  if (verdict === 'fail') {
    return 'functional-fail';
  }
  if (verdict === 'error') {
    return 'tool-error';
  }
  return undefined;
}

/** The sanitized-by-construction input summary recorded for the run. */
function spanInputs(request: SkeletonSimulationRequest): Json {
  const { cpu, memMb, procs, diskMb, wallMs } = request.limits;
  return {
    job: 'simulate',
    rtlFiles: request.rtl.map((file) => file.path),
    testbenchFile: request.testbench.path,
    limits: { cpu, memMb, procs, diskMb, wallMs },
  };
}

/** The recorded outputs summary for the run (full streams stay out of the Trace). */
function spanOutputs(simulation: SimulationVerdict, errorMessage: string | null): Json {
  const base: { readonly [key: string]: Json } = {
    verdict: simulation.verdict,
    checks: simulation.checks.map((check) => ({ name: check.name, passed: check.passed })),
    exitCode: simulation.exitCode,
    vcdCaptured: simulation.vcd !== null,
  };
  return errorMessage === null ? base : { ...base, error: errorMessage };
}

/**
 * The M0 Orchestrator skeleton: run one compile-and-simulate through the sandbox
 * and record it, bounded solely by the sandbox wall-clock cap.
 *
 * The `SimulatorAdapter` and `ActionRecorder` are injected so tests drive the
 * skeleton with a `FakeSandboxRuntime`-backed `SandboxToolRunner` +
 * `IcarusSimulatorAdapter` and an `InMemoryTracePersistence`-backed
 * `TraceActionRecorder`. The clock is injected too, keeping recorded timing
 * deterministic under test.
 */
export class OrchestratorSkeleton {
  readonly #simulator: SimulatorAdapter;
  readonly #recorder: ActionRecorder;
  readonly #now: () => number;

  constructor(simulator: SimulatorAdapter, recorder: ActionRecorder, now: () => number = Date.now) {
    this.#simulator = simulator;
    this.#recorder = recorder;
    this.#now = now;
  }

  /**
   * Compile and simulate the request in the sandbox, record the run as a span, and
   * return the verdict with its provenance span.
   *
   * A thrown sandbox/contract failure is classified `error` (fail safe) rather than
   * propagated, so the reported result is always exactly one of `pass` / `fail` /
   * `error` (Req 1.5). The run's duration is measured around the simulate call; the
   * time bound itself is the sandbox `limits.wallMs`, not a budget owned here.
   */
  async runSkeletonSimulation(
    request: SkeletonSimulationRequest,
  ): Promise<SkeletonSimulationResult> {
    const startedAtMs = this.#now();
    const { simulation, errorMessage } = await this.#simulate(request);
    const durationMs = Math.max(0, this.#now() - startedAtMs);

    const span = await this.#recorder.record(
      this.#buildDraft(request, simulation, errorMessage, startedAtMs, durationMs),
    );
    return { simulation, span };
  }

  /** Run the oracle, converting any thrown failure into an `error` verdict. */
  async #simulate(
    request: SkeletonSimulationRequest,
  ): Promise<{ simulation: SimulationVerdict; errorMessage: string | null }> {
    try {
      const simulation = await this.#simulator.simulate(
        request.rtl,
        request.testbench,
        request.limits,
      );
      return { simulation, errorMessage: null };
    } catch (error) {
      // A sandbox capture/contract failure is exceptional; classify it `error`,
      // record its cause for diagnosis, and never let it crash the spine.
      return { simulation: toolFailureVerdict(), errorMessage: messageOf(error) };
    }
  }

  /** Assemble the raw span draft; the recorder sanitizes and orders it. */
  #buildDraft(
    request: SkeletonSimulationRequest,
    simulation: SimulationVerdict,
    errorMessage: string | null,
    startedAtMs: number,
    durationMs: number,
  ): SpanDraft {
    const base: SpanDraft = {
      sessionId: request.sessionId,
      stageOrTool: SIMULATOR_STAGE,
      inputs: spanInputs(request),
      outputs: spanOutputs(simulation, errorMessage),
      exitCode: simulation.exitCode,
      startedAt: new Date(startedAtMs).toISOString(),
      durationMs,
      retryCount: SKELETON_RETRY_COUNT,
      costCents: SKELETON_COST_CENTS,
    };
    const failureClass = failureClassFor(simulation.verdict);
    return failureClass === undefined ? base : { ...base, failureClass };
  }
}
