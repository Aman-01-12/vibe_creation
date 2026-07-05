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

import { spawn } from 'node:child_process';

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
  readonly artifacts: Readonly<Record<string, ArtifactBlobRef>>;
  readonly deniedOperations: readonly DeniedOperation[];
  readonly resourceUsage: ResourceUsage;
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
      // No shell and array args prevent command injection from job contents.
      const child = spawn(this.cliBinary, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });

      const killTimer = setTimeout(() => {
        acc.timedOut = true;
        child.kill('SIGKILL');
      }, wallMs);

      child.stdout.on('data', (chunk: Buffer) => {
        acc.containerStdout += chunk.toString('utf8');
      });
      child.on('error', () => {
        acc.spawnFailed = true;
      });
      child.on('close', () => {
        clearTimeout(killTimer);
        resolve(this.resolveCapture(acc));
      });

      child.stdin.end(JSON.stringify(job));
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
