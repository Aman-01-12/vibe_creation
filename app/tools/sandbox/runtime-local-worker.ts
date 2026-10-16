// The "real oracle, local runtime" `SandboxRuntime`: the REAL Python worker (and
// therefore the real `iverilog` + `vvp` / `yosys` toolchain) spawned as a local
// process instead of inside a gVisor container.
//
// WHY THIS LIVES IN @app/tools
//   This layer owns the `SandboxRuntime` seam and the language-neutral job/result
//   contract the worker speaks, so it is the natural owner of every runtime that
//   implements that seam - `RunscSandboxRuntime` (production isolation),
//   `FakeSandboxRuntime` (no toolchain), and this one (real toolchain, no
//   isolation). It previously lived in the test harness, which made it unreachable
//   from `@app/eval`; the eval loop-runner must drive the real oracle and may not
//   import `app/test`, so the runtime belongs here where both layers can reach it.
//
// WHAT IS REAL AND WHAT IS NOT
//   Real: the worker process, the job/result contract, the resource caps, the
//   wall-clock kill-timer semantics, and the EDA toolchain itself - so the oracle
//   verdict this runtime feeds is a real verdict, never a fabricated one.
//   NOT real: the isolation wrapper. `RunscSandboxRuntime` runs the same worker
//   under gVisor (`runsc`) via the container CLI, which needs Docker + the `runsc`
//   runtime + the pinned worker image. This runtime deliberately provides NO
//   isolation, so it is only for hosts that already trust the code they run:
//   integration suites and a provisioned eval host. It must never be wired into a
//   path that executes student- or model-authored code for a real session; that
//   path uses `RunscSandboxRuntime`.
//
// The interpreter is INJECTED. Discovering which interpreter can import the worker
// (and whether the EDA binaries exist at all) is a host-capability question owned by
// the caller - the test harness gates its suites on it, an eval composition root
// resolves it from configuration - so this module never probes, never reads the
// environment for a path, and never guesses a binary.

import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ArtifactRetentionSink } from './artifact-retention.js';
import type {
  ArtifactBlobRef,
  ContainerSpec,
  DeniedOperation,
  RawRunCapture,
  ResourceUsage,
  SandboxJob,
  SandboxRuntime,
} from './contract.js';
import { projectWorkerEnvironment } from './worker-environment.js';
import {
  createWorkspaceRoot,
  reapStaleWorkspaceRoots,
  removeWorkspaceRoot,
  spawnInOwnProcessGroup,
  TOOL_RUNNER_WORKSPACE_ENV,
  type WorkspaceNoteSink,
} from './workspace-lifecycle.js';

/** This module's directory, resolved from its module URL. */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * This package's root directory, resolved from this module's own location in either
 * layout.
 *
 * The worker's Python tree is only ever the AUTHORED one. This module is authored at
 * `app/tools/sandbox/` and compiles to `app/tools/dist/sandbox/`, and `tsc` compiles
 * TypeScript only - nothing copies `worker/` into `dist` - so resolving the worker
 * relative to this module's own directory would point every consumer of `@app/tools`
 * (which is published through `dist`) at a path that does not exist, leaving the real
 * oracle unable to import its own worker. The parent directory name distinguishes the
 * two layouts exactly - `tools` versus `dist` - so the level count is decided on
 * evidence rather than guessed.
 */
function packageRoot(): string {
  const levelsUp = basename(dirname(HERE)) === 'dist' ? 2 : 1;
  return resolve(HERE, ...new Array<string>(levelsUp).fill('..'));
}

/**
 * The thin Python worker's importable source root (`.../sandbox/worker/src`).
 *
 * A fact about this package's own layout, so it is owned here and exported for the
 * callers that must put it on `PYTHONPATH` themselves - notably a capability probe
 * that checks whether an interpreter can import the worker before selecting it.
 *
 * Resolved against the AUTHORED tree from both layouts. This module is authored at
 * `sandbox/` and compiles to `dist/sandbox/`, and `tsc` copies no `.py` file, so from the
 * build output the worker sits two levels further out. The parent directory name decides it
 * on evidence - `tools` versus `dist` - the same way `corpus/fetch-node.ts` resolves its own
 * root. Without it every CLI that runs from `dist/` sets a `PYTHONPATH` holding no worker,
 * and the only symptom is a capability probe reporting no interpreter can import it.
 */
export const WORKER_SOURCE_ROOT = resolve(packageRoot(), 'sandbox/worker/src');

/** The module invoked to run one job: `python -m tool_runner_worker`. */
const WORKER_MODULE = 'tool_runner_worker';

/** Prefix of the absence note; the missing names follow it, and no value ever does. */
export const WORKER_ENV_ABSENT_NOTE = 'tool-runner worker started without allowlisted variables:';

/** The environment one worker child is spawned with, and the allowlisted names the host lacked. */
export interface WorkerSpawnEnvironment {
  /** The complete child environment: the projected allowlist plus the two set here. */
  readonly env: NodeJS.ProcessEnv;
  /** Allowlisted names the host did not hold. Names only, so no diagnostic can emit a value. */
  readonly absent: readonly string[];
}

/**
 * Build the worker child's whole environment: the host projected onto the allowlist, then the two
 * variables this runtime owns, set last so widening the allowlist cannot shadow them. Returned
 * rather than assembled at the spawn so the exact argument is assertable without spawning.
 */
export function workerSpawnEnvironment(
  hostEnv: Readonly<Record<string, string | undefined>>,
  workspaceRoot: string,
): WorkerSpawnEnvironment {
  const projected = projectWorkerEnvironment(hostEnv);
  return {
    env: {
      ...projected.env,
      PYTHONPATH: WORKER_SOURCE_ROOT,
      [TOOL_RUNNER_WORKSPACE_ENV]: workspaceRoot,
    },
    absent: projected.absent,
  };
}

/** Zeroed usage for a run that could not report its own consumption. */
const ZERO_USAGE: ResourceUsage = { wallMs: 0, maxMemMb: 0, cpuMs: 0 };

/** An infrastructure-failure capture: nothing usable was produced. */
function infraCapture(timedOut: boolean): RawRunCapture {
  return {
    timedOut,
    infraFailure: !timedOut,
    exitCode: null,
    stdout: null,
    stderr: null,
    // No stream was captured at all, so nothing was dropped from one. The run is
    // already `error` via `timedOut`/`infraFailure`, so this cannot create a pass.
    stdoutTruncated: false,
    stderrTruncated: false,
    // Same reasoning: the report that would have carried the worker's disk-cap
    // verdict was discarded with everything else. This says what THIS capture knows,
    // not that the workspace stayed inside its cap, and the run is already `error`.
    diskLimitExceeded: false,
    artifacts: {},
    deniedOperations: [],
    resourceUsage: ZERO_USAGE,
  };
}

/** Narrow an unknown to a plain object record, or null. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** Narrow an unknown to a string, or null. */
function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Narrow an unknown to a finite number, defaulting to 0. */
function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Narrow an unknown exit code to a number, or null. */
function asExitCode(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

/**
 * Narrow a reported resource-bound flag, defaulting an unusable value to `true`.
 *
 * The worker always reports the truncation flags and the disk-cap flag, so a missing
 * or non-boolean value means a report we do not understand. `true` is the fail-safe
 * reading: an unknown status is not a known-clean one, and it costs at most a `pass`
 * downgraded to `error`, whereas `false` would let an unrecognized report's bounded
 * prefix - or a run the worker killed for disk - be classified as a complete, passing
 * run. The worker owns the disk cap, so this side must never be able to assume the
 * enforcement did not happen.
 */
function asBoundFlag(value: unknown): boolean {
  return typeof value === 'boolean' ? value : true;
}

/** Narrow an unknown to an array of unknowns (empty when it is not an array). */
function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

/** Parse one artifact reference from the worker report, or null when malformed. */
function parseArtifactRef(value: unknown): ArtifactBlobRef | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const name = asString(record.name);
  const sha256 = asString(record.sha256);
  if (name === null || sha256 === null) {
    return null;
  }
  return { name, sizeBytes: asNumber(record.sizeBytes), sha256 };
}

/** Parse the name-keyed artifact map from the worker report. */
function parseArtifacts(value: unknown): Record<string, ArtifactBlobRef> {
  const record = asRecord(value);
  if (record === null) {
    return {};
  }
  const artifacts: Record<string, ArtifactBlobRef> = {};
  for (const [key, entry] of Object.entries(record)) {
    const ref = parseArtifactRef(entry);
    if (ref !== null) {
      artifacts[key] = ref;
    }
  }
  return artifacts;
}

/** The denial kinds the seam recognizes. */
const DENIAL_KINDS: readonly DeniedOperation['kind'][] = ['filesystem', 'network', 'process'];

/** Parse the recorded out-of-workspace denials from the worker report. */
function parseDeniedOperations(value: unknown): DeniedOperation[] {
  const denials: DeniedOperation[] = [];
  for (const entry of asArray(value)) {
    const record = asRecord(entry);
    if (record === null) {
      continue;
    }
    const kind = asString(record.kind);
    const detail = asString(record.detail);
    if (
      kind === null ||
      detail === null ||
      !DENIAL_KINDS.includes(kind as DeniedOperation['kind'])
    ) {
      continue;
    }
    const path = asString(record.path);
    denials.push(
      path === null
        ? { kind: kind as DeniedOperation['kind'], detail }
        : { kind: kind as DeniedOperation['kind'], detail, path },
    );
  }
  return denials;
}

/** Parse the observed resource usage from the worker report. */
function parseResourceUsage(value: unknown): ResourceUsage {
  const record = asRecord(value);
  if (record === null) {
    return ZERO_USAGE;
  }
  return {
    wallMs: asNumber(record.wallMs),
    maxMemMb: asNumber(record.maxMemMb),
    cpuMs: asNumber(record.cpuMs),
  };
}

/**
 * Turn the worker's stdout report into a `RawRunCapture`.
 *
 * Mirrors the parsing `RunscSandboxRuntime` performs on the same report shape. The
 * report is untrusted input, so every field is narrowed before use and an
 * unparseable report is an infrastructure failure - never a fabricated run.
 */
function captureFromWorkerReport(raw: string): RawRunCapture {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A non-JSON report means the worker never produced a usable result; the parse
    // error itself carries no information the caller can act on, and surfacing it
    // would leak worker internals, so it is classified rather than propagated.
    return infraCapture(false);
  }
  const record = asRecord(parsed);
  if (record === null) {
    return infraCapture(false);
  }
  return {
    timedOut: false,
    infraFailure: false,
    exitCode: asExitCode(record.exitCode),
    stdout: asString(record.stdout),
    stderr: asString(record.stderr),
    stdoutTruncated: asBoundFlag(record.stdoutTruncated),
    stderrTruncated: asBoundFlag(record.stderrTruncated),
    diskLimitExceeded: asBoundFlag(record.diskLimitExceeded),
    artifacts: parseArtifacts(record.artifacts),
    deniedOperations: parseDeniedOperations(record.deniedOperations),
    resourceUsage: parseResourceUsage(record.resourceUsage),
  };
}

/** The mutable accumulation of one spawned run, resolved into a `RawRunCapture`. */
interface RunAccumulator {
  workerStdout: string;
  timedOut: boolean;
  spawnFailed: boolean;
  /** The worker's stdin failed before the whole job was written, so it never ran our job. */
  jobUndelivered: boolean;
}

/** Resolve the accumulated run into a capture (timeout, spawn failure, undelivered job win). */
function resolveCapture(acc: RunAccumulator): RawRunCapture {
  if (acc.timedOut) {
    return infraCapture(true);
  }
  if (acc.spawnFailed || acc.jobUndelivered) {
    return infraCapture(false);
  }
  return captureFromWorkerReport(acc.workerStdout);
}

/**
 * A `SandboxRuntime` that runs the real Python worker as a LOCAL process.
 *
 * It honors the same job/result contract and the same wall-clock kill-timer
 * semantics as `RunscSandboxRuntime`, but provides NO gVisor isolation - see the
 * module header. Use it only where the executed code is already trusted.
 */
export class LocalWorkerRuntime implements SandboxRuntime {
  readonly #pythonBin: string;
  readonly #noteSink: WorkspaceNoteSink;
  readonly #retention: ArtifactRetentionSink | null;
  /** The one reap pass this instance performs, started lazily and shared. */
  #reap: Promise<void> | null = null;

  /**
   * @param pythonBin Interpreter that can import the worker package. Injected: the
   *   caller owns interpreter discovery, so this class never probes the host.
   * @param noteSink Receives sanitized notes: a cleanup failure, or an allowlisted
   *   variable the host lacked. Injected rather than logged, because this layer has no logger and a
   *   note must never become a thrown error on a run whose verdict was measured.
   *   Defaults to discarding, which costs diagnosability and never correctness.
   * @param retention Receives the bytes of the artifacts each run REGISTERED, before
   *   the workspace is removed, for a caller that needs an artifact's text rather
   *   than its ref (see `./artifact-retention.ts`). Optional and defaulted to none,
   *   so the runtime costs nothing extra for the callers that only need verdicts,
   *   and so no bytes are held by a runtime nobody asked to hold them. Absent
   *   retention is indistinguishable from a refused artifact: the reader answers
   *   `null`, which is the fail-safe answer everywhere it flows.
   */
  constructor(
    pythonBin: string,
    noteSink: WorkspaceNoteSink = () => {
      /* notes are discarded unless a caller asks for them */
    },
    retention: ArtifactRetentionSink | null = null,
  ) {
    this.#pythonBin = pythonBin;
    this.#noteSink = noteSink;
    this.#retention = retention;
  }

  /**
   * Run one job, then remove its workspace whatever happened to the child.
   *
   * The workspace is created HERE and handed to the worker, rather than left to the
   * worker's own temporary directory, because this is the side that owns the
   * wall-clock SIGKILL. A `finally` on this side runs after a normal exit, after a
   * throw, and after a kill; the worker's context-manager cleanup cannot run after a
   * signal it is not allowed to catch.
   *
   * RETENTION SITS BETWEEN THOSE TWO FACTS, and that is the only place it can sit:
   * after the worker has finished writing and registering its artifacts, and before
   * the `finally` removes the directory they are in. It reads ONLY what the run
   * registered, it cannot fail the run (`retain` never throws), and it does not
   * change what this method returns - a `RawRunCapture` still carries refs and no
   * bytes, so `SandboxResult`'s shape is untouched.
   */
  async launch(spec: ContainerSpec, job: SandboxJob): Promise<RawRunCapture> {
    await this.#reapOnce();
    const workspaceRoot = await createWorkspaceRoot();
    try {
      const capture = await this.#runWorker(workspaceRoot, spec, job);
      if (this.#retention !== null) {
        await this.#retention.retain(workspaceRoot, capture.artifacts);
      }
      return capture;
    } finally {
      const note = await removeWorkspaceRoot(workspaceRoot);
      if (note !== null) {
        this.#noteSink(note);
      }
    }
  }

  /** Spawn the worker for one job and resolve its raw capture. */
  #runWorker(workspaceRoot: string, spec: ContainerSpec, job: SandboxJob): Promise<RawRunCapture> {
    return new Promise<RawRunCapture>((resolvePromise) => {
      const acc: RunAccumulator = {
        workerStdout: '',
        timedOut: false,
        spawnFailed: false,
        jobUndelivered: false,
      };

      // Node replaces the child environment wholesale when `env` is supplied, so handing it the
      // projection is what keeps a credential out of the EDA tools the worker spawns.
      const { env, absent } = workerSpawnEnvironment(process.env, workspaceRoot);
      if (absent.length > 0) {
        this.#noteSink(`${WORKER_ENV_ABSENT_NOTE} ${absent.join(', ')}`);
      }

      // No shell and array args prevent command injection from job contents; the
      // worker package is made importable via PYTHONPATH without an install step,
      // and the workspace root is handed over rather than chosen by the worker.
      const { child, killTree } = spawnInOwnProcessGroup(
        this.#pythonBin,
        ['-m', WORKER_MODULE],
        env,
      );

      const killTimer = setTimeout(() => {
        acc.timedOut = true;
        // The whole tree, not just the worker: the EDA tool is a grandchild, and one
        // that survives its parent keeps writing the waveform AND keeps the file
        // open, so removing the directory afterwards would reclaim nothing.
        killTree();
      }, spec.limits.wallMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        acc.workerStdout += chunk.toString('utf8');
      });
      child.on('error', () => {
        acc.spawnFailed = true;
      });
      // Resolve once BOTH the child and its stdin have closed: a stdin 'error' (the job was never
      // delivered) can arrive after the child's 'close' and must still decide the capture.
      let pendingCloses = child.stdin === null ? 1 : 2;
      const settle = (): void => {
        pendingCloses -= 1;
        if (pendingCloses === 0) {
          clearTimeout(killTimer);
          resolvePromise(resolveCapture(acc));
        }
      };
      child.on('close', settle);

      // A worker that exits before reading closes the pipe under this write (EPIPE). Unhandled,
      // that 'error' event is an uncaught exception that ends the whole parent process.
      child.stdin?.on('error', () => {
        acc.jobUndelivered = true;
      });
      child.stdin?.on('close', settle);
      child.stdin?.end(JSON.stringify(job));
    });
  }

  /**
   * Collect workspaces orphaned before this process started, once per instance.
   *
   * Per instance rather than per run: the leak it addresses is a crashed PARENT, so
   * one pass when a runtime starts working is enough, and keeping it off the per-run
   * path means a directory scan never joins the measured cost of a run. It is awaited
   * so a failure cannot surface as an unhandled rejection, and it cannot fail a run -
   * `reapStaleWorkspaceRoots` reports counts and never throws.
   */
  #reapOnce(): Promise<void> {
    this.#reap ??= reapStaleWorkspaceRoots().then(() => undefined);
    return this.#reap;
  }
}
