// Regression: `@app/tools`'s published `WORKER_SOURCE_ROOT` must name a PYTHONPATH
// root from which the sandbox worker package is importable.
//
// WHY THIS IS A SEPARATE, NON-INTEGRATION TEST
//   `LocalWorkerRuntime` spawns `python -m tool_runner_worker` with
//   `PYTHONPATH: WORKER_SOURCE_ROOT`, and the eval campaign's preflight selects an
//   interpreter with the same constant, so a root that does not contain the package
//   makes every real verdict an `error` and makes the campaign refuse to start. That
//   regression is invisible to the real-oracle suites: they gate on the very probe
//   this constant feeds, so a wrong root turns them into silent skips rather than
//   failures. This check therefore must NOT depend on the EDA toolchain.
//
//   It imports the constant through `@app/tools` on purpose - the package entry every
//   consumer actually resolves, which is the compiled `dist` tree. A deep import of
//   the authored module would resolve the source layout and could not observe the
//   defect at all.
//
// WHAT IS ASSERTED, AND HOW
//   Importability, by a real interpreter, with `importlib.util.find_spec` under that
//   exact `PYTHONPATH`. `find_spec` locates the package without executing it, so this
//   needs no worker runtime dependency (not even `jsonschema`) and stays a fast-tier
//   check. The interpreter is the only environmental requirement, so the spawn-backed
//   assertion is skipped when no Python is present, and a layout assertion that needs
//   no interpreter at all always runs.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { WORKER_SOURCE_ROOT } from '@app/tools';
import { describe, expect, it } from 'vitest';

/** The package directory an interpreter must find under `WORKER_SOURCE_ROOT`. */
const WORKER_PACKAGE_DIR = join(WORKER_SOURCE_ROOT, 'tool_runner_worker');

/** How long the import probe may run before it is abandoned (ms). */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Whether an interpreter can LOCATE the worker package, given `WORKER_SOURCE_ROOT`
 * on `PYTHONPATH`. `null` means no interpreter could be launched at all, which is an
 * environment fact rather than a result.
 */
function workerPackageIsImportable(): boolean | null {
  for (const bin of ['python3', 'python']) {
    const probe = spawnSync(
      bin,
      [
        '-c',
        'import importlib.util, sys; sys.exit(0 if importlib.util.find_spec("tool_runner_worker") else 1)',
      ],
      {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        env: { ...process.env, PYTHONPATH: WORKER_SOURCE_ROOT },
      },
    );
    if (probe.error === undefined) {
      return probe.status === 0;
    }
  }
  return null;
}

const IMPORTABLE = workerPackageIsImportable();

describe('WORKER_SOURCE_ROOT, as published by @app/tools', () => {
  it('names a directory that holds the runnable tool_runner_worker package', () => {
    expect(existsSync(WORKER_SOURCE_ROOT)).toBe(true);
    // `python -m tool_runner_worker` is what the runtime spawns, so the module entry
    // point is the thing that has to be there - not merely some directory.
    expect(existsSync(join(WORKER_PACKAGE_DIR, '__main__.py'))).toBe(true);
  });

  it.skipIf(IMPORTABLE === null)(
    'lets a real interpreter import the worker package when used as PYTHONPATH',
    () => {
      expect(IMPORTABLE).toBe(true);
    },
  );
});
