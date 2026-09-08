// Real gVisor-backed sandbox runtime.
//
// This is the production `SandboxRuntime`: it launches an ephemeral container
// under gVisor (`runsc`) with the hardened isolation flags from `isolation.ts`,
// feeds the job to the thin worker over stdin, and captures the worker's report
// over stdout. It enforces the wall-clock cap with a kill timer (the one cap that
// is not a container flag). No isolation flag is weakened here.
//
// It is wired against the container CLI and the worker image but is exercised only
// by the real-oracle and containment integration tests (tasks 3.8, 3.9) where a
// gVisor runtime and the built worker image are present. Where neither exists (for
// example this development environment), it reports an infrastructure failure,
// which the adapter classifies as `error` - it never fabricates a run.
//
// WHY THIS RUNTIME HAS NO WORKSPACE CLEANUP OF ITS OWN
//   `LocalWorkerRuntime` creates the run's workspace on the host and removes it in a
//   `finally`, because a SIGKILLed worker cannot clean up after itself. Here the
//   workspace is a size-capped tmpfs INSIDE the container (`isolation.ts`), so it
//   exists only as long as the container does and `--rm` disposes of it along with
//   the container. There is no host directory to leak, which is why the two runtimes
//   differ here and agree everywhere else: the same job contract, the same wall-clock
//   kill shape, the same worker enforcing the same `diskMb` from inside.

import type {
  ArtifactBlobRef,
  ContainerSpec,
  DeniedOperation,
  RawRunCapture,
  ResourceUsage,
  SandboxJob,
  SandboxRuntime,
} from './contract.js';
import { buildRunscArgs, SANDBOX_WORKER_IMAGE } from './isolation.js';
import { spawnInOwnProcessGroup } from './workspace-lifecycle.js';

/** Zeroed usage used when a run could not report its own consumption. */
const ZERO_USAGE: ResourceUsage = { wallMs: 0, maxMemMb: 0, cpuMs: 0 };

/**
 * The worker's stdout payload: the raw, pre-classification capture. The worker
 * never decides the verdict; classification stays in the adapter.
 */
interface WorkerReport {
  readonly exitCode: number | null;
  readonly stdout: string | null;
  readonly stderr: string | null;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly diskLimitExceeded: boolean;
  readonly artifacts: Readonly<Record<string, ArtifactBlobRef>>;
  readonly deniedOperations: readonly DeniedOperation[];
  readonly resourceUsage: ResourceUsage;
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

/** The mutable accumulation of one spawned run, resolved into a `RawRunCapture`. */
interface RunAccumulator {
  containerStdout: string;
  timedOut: boolean;
  spawnFailed: boolean;
}

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
    // verdict was discarded with everything else, and the run is already `error`, so
    // `false` here cannot manufacture a pass. It is a statement about what THIS
    // capture knows, not a claim that the workspace stayed inside its cap.
    diskLimitExceeded: false,
    artifacts: {},
    deniedOperations: [],
    resourceUsage: ZERO_USAGE,
  };
}

/** Parse and shallowly validate the worker report; return null when unusable. */
function parseWorkerReport(raw: string): WorkerReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const report = parsed as Partial<WorkerReport>;
  if (typeof report.resourceUsage !== 'object' || report.resourceUsage === null) {
    return null;
  }
  return {
    exitCode: typeof report.exitCode === 'number' ? report.exitCode : null,
    stdout: typeof report.stdout === 'string' ? report.stdout : null,
    stderr: typeof report.stderr === 'string' ? report.stderr : null,
    stdoutTruncated: asBoundFlag(report.stdoutTruncated),
    stderrTruncated: asBoundFlag(report.stderrTruncated),
    diskLimitExceeded: asBoundFlag(report.diskLimitExceeded),
    artifacts: report.artifacts ?? {},
    deniedOperations: report.deniedOperations ?? [],
    resourceUsage: report.resourceUsage,
  };
}

/** Turn a completed run's worker report into a raw capture. */
function captureFromReport(report: WorkerReport | null): RawRunCapture {
  if (report === null) {
    return infraCapture(false);
  }
  return {
    timedOut: false,
    infraFailure: false,
    exitCode: report.exitCode,
    stdout: report.stdout,
    stderr: report.stderr,
    stdoutTruncated: report.stdoutTruncated,
    stderrTruncated: report.stderrTruncated,
    diskLimitExceeded: report.diskLimitExceeded,
    artifacts: report.artifacts,
    deniedOperations: report.deniedOperations,
    resourceUsage: report.resourceUsage,
  };
}

/**
 * Launches sandbox jobs in a gVisor-isolated container via the container CLI.
 *
 * The CLI binary and worker image are injectable so deployment can pin exact
 * values; both default to the standard names.
 */
export class RunscSandboxRuntime implements SandboxRuntime {
  private readonly cliBinary: string;
  private readonly image: string;

  constructor(cliBinary = 'docker', image: string = SANDBOX_WORKER_IMAGE) {
    this.cliBinary = cliBinary;
    this.image = image;
  }

  launch(spec: ContainerSpec, job: SandboxJob): Promise<RawRunCapture> {
    const withImage: ContainerSpec = { ...spec, image: this.image };
    const args = [...buildRunscArgs(withImage)];
    return this.spawnRun(args, job, spec.limits.wallMs);
  }

  /** Spawn the container, stream the job in, and resolve the raw capture. */
  private spawnRun(
    args: readonly string[],
    job: SandboxJob,
    wallMs: number,
  ): Promise<RawRunCapture> {
    return new Promise<RawRunCapture>((resolve) => {
      const acc: RunAccumulator = { containerStdout: '', timedOut: false, spawnFailed: false };
      // No shell and array args prevent command injection from job contents. Spawned
      // in its own process group so the wall-clock kill uses the same shape as the
      // local runtime's, rather than two dissimilar kills for one bound.
      const { child, killTree } = spawnInOwnProcessGroup(this.cliBinary, args, process.env);

      const killTimer = setTimeout(() => {
        acc.timedOut = true;
        killTree();
      }, wallMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        acc.containerStdout += chunk.toString('utf8');
      });
      child.on('error', () => {
        acc.spawnFailed = true;
      });
      child.on('close', () => {
        clearTimeout(killTimer);
        resolve(this.resolveCapture(acc));
      });

      child.stdin?.end(JSON.stringify(job));
    });
  }

  /** Resolve the accumulated run into a raw capture (timeout/infra win over parse). */
  private resolveCapture(acc: RunAccumulator): RawRunCapture {
    if (acc.timedOut) {
      return infraCapture(true);
    }
    if (acc.spawnFailed) {
      return infraCapture(false);
    }
    return captureFromReport(parseWorkerReport(acc.containerStdout));
  }
}
