// Language-neutral Tool_Runner job/result contract (the TS-to-Python seam).
//
// These TypeScript types mirror the JSON Schema in `contract-schema.ts`, which is
// the canonical, cross-language definition of the seam. Both sides of the seam
// validate against that schema: the TypeScript adapter here (via ajv), and the
// thin Python worker in `sandbox/worker` (task 3.2) against the byte-mirror
// `contract.schema.json`. Keeping the schema canonical means adding a field is a
// single edit that both languages inherit.
//
// The `Verdict` type is imported from `@app/core`, never redefined here: the
// sandbox reuses the same `error` verdict semantics as the verdict classifier.

import type { Verdict } from '@app/core';

/**
 * What a single sandbox invocation does.
 *
 * `formalPrepass` is a SECOND Yosys invocation over the candidate DESIGN ALONE, and it
 * is its own kind rather than a step inside `formal` because it must complete BEFORE the
 * Property_Wrapper exists - a `formal` job's `-top` IS that wrapper, and the wrapper is
 * what needs the pre-pass's answers (Req 14.11).
 */
export type SandboxJobKind = 'simulate' | 'synthesize' | 'formal' | 'formalPrepass';

/**
 * An output the invocation is required to produce.
 *
 * Capture-all-or-error (Req 2.5, 2.9): if any required output is missing, the
 * whole invocation is classified `error` rather than returning a partial result.
 *
 * AN OUTPUT IS REQUIRED EXACTLY WHEN ITS ABSENCE CANNOT BE A SUCCESS, and the two formal
 * kinds sit on OPPOSITE sides of that rule, which is the whole reason it is written down
 * here rather than decided per call site.
 *   - `formalPrepassReport` IS required. A pre-pass that produced no report produced
 *     nothing: its entire output is the report, and there is no success case in which the
 *     report is legitimately absent.
 *   - The `formal` job's counterexample trace is NOT required and is not a member of this
 *     union at all. It is registered opportunistically, because a SUCCESSFUL PROOF writes
 *     no trace, so naming it here would make `missingRequiredOutputs` classify every
 *     proof as `error` (Req 12.18, 12.19).
 */
export type RequiredOutput =
  'stdout' | 'stderr' | 'exitCode' | 'vcd' | 'netlistJson' | 'formalReport' | 'formalPrepassReport';

/**
 * One file written into the sandbox workspace before the run.
 *
 * `path` is workspace-relative and is validated and confined to the workspace by
 * the Python worker before any write (task 3.2, Req 2.6, 2.7); the type here only
 * carries it across the seam.
 */
export interface SourceFile {
  readonly path: string;
  readonly contents: string;
}

/**
 * Per-invocation resource and time caps enforced on the ephemeral container.
 *
 * Every cap is a hard ceiling; a breach kills the run. The process cap also
 * defeats the fork-bomb class, and `wallMs` overrun yields an `error` verdict
 * (Req 2.2, 2.3, 2.4).
 */
export interface ResourceLimits {
  /** Fractional CPU cores (for example `1` or `0.5`). */
  readonly cpu: number;
  /** Memory ceiling in mebibytes. */
  readonly memMb: number;
  /** Maximum process/thread count (defeats fork bombs). */
  readonly procs: number;
  /**
   * Workspace disk ceiling in mebibytes; a breach kills the run.
   *
   * Enforced WHILE the run executes, not checked after it: a testbench that dumps a
   * waveform and never reaches `$finish` writes tens of megabytes per second, so a
   * run that has already passed the cap has already done the damage. The worker
   * measures its own workspace and kills the tool on breach, because on the isolated
   * runtime the workspace is a tmpfs inside the container that no host-side monitor
   * can see; that runtime ALSO sizes the tmpfs at this number, so the same ceiling
   * is expressed twice, once by us and once by the kernel.
   *
   * A kill is reported as `SandboxResult.diskLimitExceeded` and forces a non-passing
   * verdict, so a caller cannot mistake a run stopped mid-flight for one that ran to
   * completion.
   */
  readonly diskMb: number;
  /** Wall-clock ceiling in milliseconds; an overrun is classified `error`. */
  readonly wallMs: number;
}

/**
 * Kind-specific parameters for a `formal` job; required when `kind` is `'formal'`.
 *
 * A TYPED, SCHEMA-VALIDATED FIELD rather than a JSON file smuggled through
 * `workspaceFiles`, for two reasons. The schema is the canonical seam, so a field
 * declared here is the single edit both languages inherit (see the note at the top
 * of this module), whereas a workspace file would need a second, hand-written
 * validator on the Python side - one ajv never sees, on the far side of the
 * boundary it is supposed to guard. And because the field is in the schema, a
 * malformed payload is rejected AT the boundary by ajv rather than by a worker
 * that has already been handed the job.
 *
 * Both values reach a command line inside the sandbox (`prep -top <topModule>`,
 * `yosys-smtbmc -t <depth>`), which is why the schema constrains `topModule` to a
 * bounded plain Verilog identifier and `depth` to a positive integer instead of
 * accepting any string and any number. The worker validates both again before use
 * (task 2.2), because it is a trust boundary in its own right and must not take a
 * job's word for a value it is about to interpolate.
 */
export interface FormalJobRequest {
  /** The Property_Wrapper module name, used as `prep -top`. */
  readonly topModule: string;
  /** The `-t` depth every `yosys-smtbmc` invocation in this job runs at. */
  readonly depth: number;
}

/**
 * Kind-specific parameters for a `formalPrepass` job; required when `kind` is
 * `'formalPrepass'` (Req 14.11).
 *
 * ONE FIELD, AND IT IS THE DESIGN'S OWN MODULE NAME rather than a wrapper's. That is the
 * difference between this payload and `FormalJobRequest`, and it is the reason the pre-pass
 * is its own job kind: it runs over the candidate design alone, BEFORE any Property_Wrapper
 * exists, so there is no wrapper name to elaborate as `-top` and no proof depth to run at -
 * the pre-pass runs no solver.
 *
 * `topModule` reaches a command line inside the sandbox (`prep -top <topModule>`), so it
 * carries the same bounded plain-identifier constraint the schema puts on
 * `FormalJobRequest.topModule`, and the worker validates it again before use, because the
 * worker is a trust boundary in its own right.
 */
export interface FormalPrepassJobRequest {
  /** The CANDIDATE DESIGN's own module name, used as `prep -top`. */
  readonly topModule: string;
}

/** The complete description of one sandbox invocation (the stdin side of the seam). */
/** The one default timescale a job may request; a closed vocabulary, re-checked by the worker. */
export type DefaultTimescale = '1ns/1ps';

/** A `simulate` job's optional compile parameters (testbench-spec-grounding, C7). */
export interface SimulateJobRequest {
  readonly defaultTimescale: DefaultTimescale;
}

export interface SandboxJob {
  readonly kind: SandboxJobKind;
  readonly workspaceFiles: readonly SourceFile[];
  readonly limits: ResourceLimits;
  readonly requiredOutputs: readonly RequiredOutput[];
  /**
   * The `formal` kind's parameters; present IF AND ONLY IF `kind` is `'formal'`.
   *
   * The schema carries that biconditional as a conditional rule (required under
   * `formal`, forbidden otherwise), so both halves of the mistake are rejected at
   * the boundary: a `formal` job with no parameters, and a `simulate` or
   * `synthesize` job carrying parameters no code path on the other side reads.
   */
  readonly formal?: FormalJobRequest;
  /**
   * The `formalPrepass` kind's parameters; present IF AND ONLY IF `kind` is
   * `'formalPrepass'`, by the same conditional rule and for the same two reasons.
   *
   * A SEPARATE FIELD rather than a widened `formal`, because the two payloads carry
   * different facts: a `formal` job needs a wrapper name AND a proof depth, and a pre-pass
   * needs the design's name and no depth at all. Sharing one field would make `depth`
   * either optional-and-meaningless on the pre-pass or required-and-fabricated, and both
   * shapes let a job say something no code path on the far side reads.
   */
  readonly formalPrepass?: FormalPrepassJobRequest;
  /** Optional, and allowed only when `kind` is `'simulate'`; absent on every Golden_Judge job. */
  readonly simulate?: SimulateJobRequest;
}

/** A reference to one captured artifact blob (for example the VCD waveform). */
export interface ArtifactBlobRef {
  /** The artifact's logical name (matches its `RequiredOutput` where applicable). */
  readonly name: string;
  readonly sizeBytes: number;
  /** Lowercase hex SHA-256 of the blob contents. */
  readonly sha256: string;
}

/** The category of a denied out-of-sandbox operation. */
export type DeniedOperationKind = 'filesystem' | 'network' | 'process';

/**
 * A recorded attempt to act outside the sandbox workspace.
 *
 * The Tool_Runner denies these and records them so the Action_Recorder can place
 * them in the Trace (Req 2.6). Population of the filesystem/path cases is the
 * worker's job in task 3.2; the type is defined here as part of the seam.
 */
export interface DeniedOperation {
  readonly kind: DeniedOperationKind;
  readonly detail: string;
  readonly path?: string;
}

/** Observed resource consumption of a completed or killed run. */
export interface ResourceUsage {
  readonly wallMs: number;
  readonly maxMemMb: number;
  readonly cpuMs: number;
}

/**
 * The classified outcome of one sandbox invocation (the result side of the seam).
 *
 * `verdict` is `error` when the run timed out, breached its disk cap, or could not
 * produce a required output (Req 2.4, 2.9); otherwise it reflects the run.
 * Classification is done on the TypeScript side by the adapter, never by the worker.
 */
export interface SandboxResult {
  readonly verdict: Verdict;
  /**
   * Whether the run was KILLED for exceeding its wall-clock cap.
   *
   * `error` is reserved for a timeout OR an infrastructure failure OR a missing
   * required output OR a truncated capture, so the verdict alone cannot say WHICH
   * of those happened. This flag carries the one cause a caller cannot re-derive
   * from what is left: on a wall-clock kill the runtime reports no exit code, no
   * streams, and zeroed usage, so every residual field is empty and every
   * heuristic over them is guessing.
   *
   * It is a DIAGNOSTIC fact and never a second verdict. A timeout is ALREADY
   * `error` here, and `timedOut === false` is not evidence of anything: a crash,
   * a compile failure, and a clean pass all report it.
   *
   * Required rather than optional for the same reason as `stdoutTruncated`: an
   * absent flag is indistinguishable from a run that finished inside its cap.
   *
   * Classified on the TypeScript side, like `verdict`. The worker does not report
   * it, because the wall-clock kill happens above the worker (see
   * `RawRunCapture.timedOut`, which is where the fact originates).
   */
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * Whether `stdout` is a bounded PREFIX of what the run actually wrote.
   *
   * The worker retains only a capped number of bytes per stream, because a
   * testbench whose wait condition never becomes true writes without end and an
   * unbounded capture is a measured out-of-memory vector. This flag is what lets a
   * caller tell "this is all the output" from "this is some of the output", and it
   * is required rather than optional so a bounded prefix can never be mistaken for
   * a complete run. A `true` here means a `CHECK ... FAIL` line among the
   * discarded bytes cannot be ruled out, so the run must not classify as `pass`.
   */
  readonly stdoutTruncated: boolean;
  /** Whether `stderr` is a bounded prefix of what the run actually wrote. */
  readonly stderrTruncated: boolean;
  /**
   * Whether the run was KILLED for exceeding its workspace disk cap (`diskMb`).
   *
   * The disk twin of `timedOut`, and carried for the same reason: `error` collapses
   * every cause, so the one fact a caller cannot re-derive has to be stated. A
   * disk-cap kill leaves a real exit code and real streams behind, which is exactly
   * what makes it dangerous to leave unsaid - without this flag the run is
   * indistinguishable from a tool that failed on its own, and the retained output
   * would be read as the whole story.
   *
   * Required rather than optional, like `timedOut` and `stdoutTruncated`: an absent
   * flag is indistinguishable from a run that stayed inside its cap, which is how a
   * cap that is not enforced comes to look like one that is.
   *
   * A DIAGNOSTIC fact, never a second verdict. It forces a non-passing verdict
   * (`classifyVerdict`), but `diskLimitExceeded === false` is evidence of nothing:
   * a pass, a crash, and a compile failure all report it.
   */
  readonly diskLimitExceeded: boolean;
  readonly artifacts: Readonly<Record<string, ArtifactBlobRef>>;
  readonly deniedOperations: readonly DeniedOperation[];
  readonly resourceUsage: ResourceUsage;
}

/**
 * The Tool_Runner adapter interface: the only surface that executes generated
 * code, behind a single injectable contract (design "Tool_Runner and EDA
 * adapters"). Callers depend on this, never on a concrete runtime.
 */
export interface ToolRunner {
  run(job: SandboxJob): Promise<SandboxResult>;
}

/**
 * The raw, pre-classification capture a `SandboxRuntime` returns for one run.
 *
 * `timedOut` and `infraFailure` are determined by the TypeScript runtime from the
 * container process itself; the remaining fields carry what the worker reported.
 * The adapter turns this into a `SandboxResult` via capture-all-or-error, so the
 * verdict decision never lives in the runtime or the worker.
 */
export interface RawRunCapture {
  /** The run exceeded its wall-clock cap and was killed. */
  readonly timedOut: boolean;
  /** The container or runtime failed to run the job (for example it never started). */
  readonly infraFailure: boolean;
  readonly exitCode: number | null;
  readonly stdout: string | null;
  readonly stderr: string | null;
  /**
   * Whether the captured `stdout` is a bounded prefix rather than the whole stream.
   *
   * Reported by the worker, which caps how much of the child's output it retains.
   * A runtime that cannot determine the status reports `true`, because an unknown
   * truncation status is not a known-complete one.
   */
  readonly stdoutTruncated: boolean;
  /** Whether the captured `stderr` is a bounded prefix rather than the whole stream. */
  readonly stderrTruncated: boolean;
  /**
   * Whether a tool was KILLED for exceeding the workspace disk cap.
   *
   * Reported by the worker, which is the side that enforces the cap (it is the only
   * side that can see the workspace: on the isolated runtime it is a tmpfs inside the
   * container). A runtime that cannot determine the status reports `true`, because an
   * unknown status is not a known-absent one - the enforcing side must not be able to
   * assume nothing happened.
   */
  readonly diskLimitExceeded: boolean;
  readonly artifacts: Readonly<Record<string, ArtifactBlobRef>>;
  readonly deniedOperations: readonly DeniedOperation[];
  readonly resourceUsage: ResourceUsage;
}

/**
 * The concrete, hardened isolation configuration handed to a `SandboxRuntime`.
 *
 * Every field is a security control; none may be weakened on the real path. The
 * adapter derives this from the fixed isolation policy plus the job's limits.
 */
export interface ContainerSpec {
  readonly image: string;
  /** Container runtime that provides the isolation boundary (gVisor `runsc`). */
  readonly runtime: string;
  /** Non-root `uid:gid` the process runs as. */
  readonly user: string;
  readonly readOnlyRootfs: boolean;
  /** Linux capabilities to drop; `['ALL']` drops every capability. */
  readonly dropCapabilities: readonly string[];
  readonly noNewPrivileges: boolean;
  /** Network mode; `none` denies all outbound network by default. */
  readonly network: string;
  /** Always `false`: no secret is ever mounted into the sandbox. */
  readonly mountSecrets: false;
  /** Absolute path of the sole writable mount (a size-capped tmpfs). */
  readonly workspacePath: string;
  readonly limits: ResourceLimits;
}

/**
 * The runtime port: launches an ephemeral, isolated container for one job and
 * returns its raw capture. Injecting this keeps the real gVisor runtime and the
 * test fake interchangeable behind the adapter.
 */
export interface SandboxRuntime {
  launch(spec: ContainerSpec, job: SandboxJob): Promise<RawRunCapture>;
}
