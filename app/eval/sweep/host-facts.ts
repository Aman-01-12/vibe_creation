// The host facts a manifest needs, probed rather than assumed.
//
// WHY PROBE INSTEAD OF DECLARE
//   The simulator version is part of what a verdict MEANS: the Stage 0 quarantine exists
//   precisely because Icarus and VCS disagree about several golden testbenches. A manifest
//   that recorded a hardcoded "iverilog 13" would be a claim, not a measurement, and would
//   go stale the first time a host upgraded. So `iverilog -V` and `vvp -V` are actually
//   executed and their first line recorded; a probe that cannot read a version records
//   `null`, which reads as unknown and never as a default.
//
// WHY THE PROBE IS SHARED, NOT COPIED
//   `probeOracleToolchain` in `../gate/measure.ts` already owns "is the Icarus toolchain
//   on PATH", and it is reused here rather than reimplemented, so the sweep and the CI
//   gate can never disagree about whether this host can decide a verdict. What this module
//   adds is what the gate does not need: the VERSION strings, the worker-capable Python
//   interpreter, and the git provenance of the harness itself.
//
// THE DIRTY-TREE PROBE IS THE POINT OF THE GIT SECTION
//   A commit hash alone is misleading when the tree is dirty: it names code that did not
//   produce the result. `git status --porcelain` decides it, and a probe that cannot run
//   git records `null` for both fields rather than claiming a clean tree.
//
// EVERY CHILD PROCESS IS SPAWNED WITHOUT A SHELL, with array arguments and no interpolated
// values, so nothing here can be turned into command injection by a config or an
// environment.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WORKER_SOURCE_ROOT } from '@app/tools';

import { probeOracleToolchain } from '../gate/measure.js';
import type { ManifestHarness, ManifestHost, ManifestToolchain } from './manifest.js';

/** This module's directory, resolved from its module URL. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** Longest version string recorded, so a chatty tool cannot bloat the manifest. */
const MAX_VERSION_CHARS = 200;

/** How long any probe process may run before it is abandoned (ms). */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Python interpreters to try, most-preferred first.
 *
 * The repo venv per `dev-tooling.md`, then the standard interpreters. This module
 * compiles to `app/eval/dist/sweep/`, and is authored at `app/eval/sweep/`, so the venv
 * sits a different number of levels up in each layout; both are listed rather than
 * guessed, and a candidate that cannot import the worker is simply skipped.
 */
const PYTHON_CANDIDATES: readonly string[] = [
  resolve(HERE, '../../../.venv/bin/python'),
  resolve(HERE, '../../../../.venv/bin/python'),
  'python3',
  'python',
];

/** Run a probe process and return its trimmed stdout+stderr, or null on any failure. */
function probeOutput(bin: string, args: readonly string[]): string | null {
  const result = spawnSync(bin, [...args], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
  });
  if (result.error !== undefined) {
    return null;
  }
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return text.length === 0 ? null : text;
}

/** The first line of a tool's version output, bounded. */
function firstLine(text: string | null): string | null {
  if (text === null) {
    return null;
  }
  const line = text.split('\n')[0]?.trim() ?? '';
  return line.length === 0 ? null : line.slice(0, MAX_VERSION_CHARS);
}

/**
 * The first Python interpreter that can import the sandbox worker, or null.
 *
 * Returned as the candidate string the caller passes to `LocalWorkerRuntime`. The
 * manifest records only its basename (see `workerPythonLabel`) because a full path names
 * a developer's home directory and answers nothing about reproducibility.
 */
export function findWorkerPython(): string | null {
  for (const candidate of PYTHON_CANDIDATES) {
    const result = spawnSync(candidate, ['-c', 'import tool_runner_worker'], {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      env: { ...process.env, PYTHONPATH: WORKER_SOURCE_ROOT },
    });
    if (result.error === undefined && result.status === 0) {
      return candidate;
    }
  }
  return null;
}

/** The manifest label for an interpreter: its basename only, never its full path. */
function workerPythonLabel(pythonBin: string | null): string | null {
  if (pythonBin === null) {
    return null;
  }
  const segments = pythonBin.split('/');
  return segments[segments.length - 1] ?? pythonBin;
}

/** Whether this host can decide a real oracle verdict, and why not when it cannot. */
export interface ToolchainAvailability {
  readonly available: boolean;
  readonly reason: string;
  /** The interpreter to hand `LocalWorkerRuntime`; empty when unavailable. */
  readonly pythonBin: string;
}

/**
 * Probe the host for everything a real verdict needs: iverilog, vvp, and a
 * worker-capable Python.
 *
 * The binary presence check is delegated to the gate's existing probe so there is one
 * definition of "the toolchain is here" in the codebase.
 */
export function probeToolchainAvailability(): ToolchainAvailability {
  const binaries = probeOracleToolchain();
  if (!binaries.available) {
    return { available: false, reason: binaries.reason, pythonBin: '' };
  }
  const pythonBin = findWorkerPython();
  if (pythonBin === null) {
    return {
      available: false,
      reason: 'no Python interpreter can import the tool_runner_worker package',
      pythonBin: '',
    };
  }
  return { available: true, reason: binaries.reason, pythonBin };
}

/** Record the EDA tool versions actually installed on this host. */
export function probeToolchainVersions(pythonBin: string | null): ManifestToolchain {
  return {
    iverilogVersion: firstLine(probeOutput('iverilog', ['-V'])),
    vvpVersion: firstLine(probeOutput('vvp', ['-V'])),
    workerPython: workerPythonLabel(pythonBin),
  };
}

/** The host object that carries platform facts, when the runtime has one. */
interface ProcessHost {
  readonly platform?: string;
  readonly arch?: string;
  readonly version?: string;
}

/**
 * Describe the host as far as reproducibility requires - and no further.
 *
 * No hostname: a machine name identifies a person's laptop and answers nothing the
 * platform, architecture, and runtime version do not already answer.
 */
export function probeHost(): ManifestHost {
  const host = (globalThis as { process?: ProcessHost }).process;
  return {
    platform: host?.platform ?? 'unknown',
    arch: host?.arch ?? 'unknown',
    release: firstLine(probeOutput('uname', ['-r'])) ?? 'unknown',
    runtimeVersion: host?.version ?? 'unknown',
  };
}

/**
 * Probe the harness's own git provenance.
 *
 * Both fields go `null` together when git cannot be read, because a commit without a
 * verified clean/dirty answer is worse than no commit: it invites a reader to assume the
 * code is what the hash says.
 */
export function probeHarnessProvenance(repoRoot: string): ManifestHarness {
  const commit = firstLine(probeOutput('git', ['-C', repoRoot, 'rev-parse', 'HEAD']));
  if (commit === null) {
    return { commit: null, workingTreeDirty: null };
  }
  const status = spawnSync('git', ['-C', repoRoot, 'status', '--porcelain'], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
  });
  if (status.error !== undefined || status.status !== 0) {
    return { commit, workingTreeDirty: null };
  }
  return { commit, workingTreeDirty: (status.stdout ?? '').trim().length > 0 };
}
