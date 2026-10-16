// The host capability check both real-runtime suites skip on (testbench-spec-grounding, C11).
//
// Moved unchanged out of `sandbox-containment.integration.test.ts` so there is ONE detection
// rule: two copies could disagree about whether a host can run the real sandbox, and a suite
// that skipped for the wrong reason reads as a pass. Deliberately exported from no barrel: it
// is test infrastructure, not part of the sandbox's public surface.

import { execFileSync } from 'node:child_process';

import { SANDBOX_WORKER_IMAGE } from './isolation.js';

/** The container runtime name that provides the isolation boundary. */
export const GVISOR_RUNTIME = 'runsc';

/** Container CLI and worker image, overridable so deployment can pin exact values. */
export const SANDBOX_CLI = process.env.ECE_SANDBOX_CLI ?? 'docker';
export const WORKER_IMAGE = process.env.ECE_SANDBOX_IMAGE ?? SANDBOX_WORKER_IMAGE;

/** The outcome of probing the host for a usable real sandbox runtime. */
export interface RuntimeProbe {
  readonly available: boolean;
  readonly reason: string;
  readonly cli: string;
  readonly image: string;
}

/** Run a short, read-only probe command; never throws, reports ok + stdout. */
export function tryExec(
  bin: string,
  args: readonly string[],
): { readonly ok: boolean; readonly stdout: string } {
  try {
    const stdout = execFileSync(bin, [...args], {
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: '' };
  }
}

/**
 * Detect whether a real gVisor runtime and the worker image are usable here.
 *
 * Robust and side-effect free: it checks the CLI exists, that the `runsc`
 * runtime is registered, and that the worker image is present, returning a clear
 * reason for the first missing piece so the skip message is actionable.
 */
export function detectSandboxRuntime(): RuntimeProbe {
  const base = { cli: SANDBOX_CLI, image: WORKER_IMAGE };
  if (!tryExec(SANDBOX_CLI, ['--version']).ok) {
    return { ...base, available: false, reason: `container CLI "${SANDBOX_CLI}" is not available` };
  }
  const runtimes = tryExec(SANDBOX_CLI, ['info', '--format', '{{json .Runtimes}}']);
  if (!runtimes.ok || !runtimes.stdout.includes(GVISOR_RUNTIME)) {
    return {
      ...base,
      available: false,
      reason: `gVisor runtime "${GVISOR_RUNTIME}" is not registered with "${SANDBOX_CLI}"`,
    };
  }
  if (!tryExec(SANDBOX_CLI, ['image', 'inspect', WORKER_IMAGE]).ok) {
    return {
      ...base,
      available: false,
      reason: `worker image "${WORKER_IMAGE}" is not built or present`,
    };
  }
  return { ...base, available: true, reason: 'gVisor runtime and worker image present' };
}
