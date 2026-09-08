// Sandbox isolation policy and container-spec construction.
//
// This is the single place the non-negotiable isolation controls are declared,
// per `ECE-SECURITY-PERFORMANCE-RESILIENCE.md`: the Tool_Runner is the only
// arbitrary-code-execution surface, so every run is ephemeral, non-root, has no
// secrets, no default outbound network, a read-only root filesystem except a
// size-capped workspace, all Linux capabilities dropped, no new privileges, and
// hard CPU/memory/process/disk/wall-clock caps.
//
// `buildRunscArgs` is a pure function so the exact isolation flags handed to the
// gVisor (`runsc`) runtime are unit-testable without launching a container. None
// of these flags may be weakened on the real path.

import type { ContainerSpec, ResourceLimits, SandboxJob } from './contract.js';
import { TOOL_RUNNER_WORKSPACE_ENV } from './workspace-lifecycle.js';

/**
 * The pinned worker image the sandbox runs. The image is built out of band and
 * pinned by digest in deployment; generated code never changes it.
 */
export const SANDBOX_WORKER_IMAGE = 'ece/tool-runner-worker:pinned';

/**
 * The fixed isolation controls applied to every invocation. Frozen and treated
 * as a security constant; there is deliberately no code path that relaxes it.
 */
export const SANDBOX_ISOLATION = {
  /** gVisor user-space kernel: the container isolation boundary (OD-1, OD-3). */
  runtime: 'runsc',
  /** Non-root `uid:gid` (nobody:nogroup). */
  user: '65534:65534',
  readOnlyRootfs: true,
  /** Drop every Linux capability. */
  dropCapabilities: ['ALL'],
  noNewPrivileges: true,
  /** No default outbound network; the in-scope jobs need none. */
  network: 'none',
  /** No secret is ever mounted into the sandbox. */
  mountSecrets: false,
  /** The sole writable mount, backed by a size-capped tmpfs. */
  workspacePath: '/workspace',
} as const;

/**
 * Build the hardened container spec for a job: the fixed isolation policy plus
 * this job's resource limits.
 */
export function buildContainerSpec(
  job: SandboxJob,
  image: string = SANDBOX_WORKER_IMAGE,
): ContainerSpec {
  return {
    image,
    runtime: SANDBOX_ISOLATION.runtime,
    user: SANDBOX_ISOLATION.user,
    readOnlyRootfs: SANDBOX_ISOLATION.readOnlyRootfs,
    dropCapabilities: [...SANDBOX_ISOLATION.dropCapabilities],
    noNewPrivileges: SANDBOX_ISOLATION.noNewPrivileges,
    network: SANDBOX_ISOLATION.network,
    mountSecrets: false,
    workspacePath: SANDBOX_ISOLATION.workspacePath,
    limits: job.limits,
  };
}

/** Render the per-cap resource flags from the job's limits. */
function resourceArgs(limits: ResourceLimits, workspacePath: string): string[] {
  return [
    `--memory=${limits.memMb}m`,
    // Equal memory and memory-swap disables swap, so the memory cap is hard.
    `--memory-swap=${limits.memMb}m`,
    `--cpus=${limits.cpu}`,
    // Process cap defeats the fork-bomb class.
    `--pids-limit=${limits.procs}`,
    // The only writable mount: a non-exec-suid, size-capped tmpfs workspace. The
    // `size=` here is the kernel's half of the disk cap; the worker enforces the same
    // number from inside by measuring the mount and killing the tool, so the cause is
    // reported across the seam instead of surfacing only as a tool write error.
    `--tmpfs=${workspacePath}:rw,nosuid,nodev,size=${limits.diskMb}m`,
  ];
}

/**
 * Build the argv for launching the sandbox container under gVisor.
 *
 * Pure and side-effect free so the isolation flags can be asserted directly. The
 * wall-clock cap (`limits.wallMs`) is not a container flag; the runtime enforces
 * it with a kill timer, so it is intentionally absent here.
 */
export function buildRunscArgs(spec: ContainerSpec): readonly string[] {
  const flags = [
    'run',
    '--rm',
    // `--init` reaps zombie processes so the pid cap is not exhausted by them.
    '--init',
    `--runtime=${spec.runtime}`,
    `--user=${spec.user}`,
    ...(spec.readOnlyRootfs ? ['--read-only'] : []),
    ...spec.dropCapabilities.map((capability) => `--cap-drop=${capability}`),
    ...(spec.noNewPrivileges ? ['--security-opt=no-new-privileges'] : []),
    `--network=${spec.network}`,
    ...resourceArgs(spec.limits, spec.workspacePath),
    `--workdir=${spec.workspacePath}`,
    // Point the worker at the tmpfs. Without this the worker falls back to its own
    // temporary directory, which on a `--read-only` rootfs is either unwritable or -
    // worse - somewhere OTHER than the size-capped mount, so the disk cap would apply
    // to a directory the run does not use. Naming it here makes the tmpfs both the
    // workspace and the thing `diskMb` bounds, twice over: once by the kernel via
    // `size=`, once by the worker measuring the same tree.
    `--env=${TOOL_RUNNER_WORKSPACE_ENV}=${spec.workspacePath}`,
    spec.image,
  ];
  return flags;
}
