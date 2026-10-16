// Sentinel_Isolation_Test (task 1.5, Req 1.4, 1.5, 1.6, 1.8).
//
// The one check that the REAL spawned child receives no credential. The projection itself is
// proved pure elsewhere; only a spawn shows what `#runWorker` handed over. See design.md C2.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { findWorkerPython } from '@app/eval';
import {
  buildContainerSpec,
  createWorkspaceRoot,
  LocalWorkerRuntime,
  removeWorkspaceRoot,
  WORKER_ENVIRONMENT_ALLOWLIST,
  type RawRunCapture,
  type SandboxJob,
} from '@app/tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** The interpreter the real worker runs under. A skip here is correct, and it is not a pass. */
const WORKER_PYTHON = findWorkerPython();

if (WORKER_PYTHON === null) {
  console.warn(
    '[worker-secret-isolation.integration] Secret isolation was NOT exercised on this host: no Python interpreter can import the tool_runner_worker package.',
  );
}

/** A host name the allowlist does not hold, standing in for the credential at risk (Req 1.4). */
const SENTINEL_NAME = 'FORMAL_GATE_FIRST_LIGHT_SENTINEL';

/** Obviously fake, and the only environment value this file may emit (Req 1.8). */
const SENTINEL_VALUE = 'sentinel-not-a-real-credential';

/** A kind the worker refuses before invoking any tool, so this test needs no EDA toolchain. */
const JOB: SandboxJob = {
  kind: 'synthesize',
  workspaceFiles: [],
  limits: { cpu: 1, memMb: 64, procs: 8, diskMb: 8, wallMs: 60_000 },
  requiredOutputs: [],
};

/** The worker's own refusal of that kind, which is how this test knows the child answered. */
const WORKER_REFUSAL = `unsupported job kind: ${JOB.kind}`;

/** awk over its own environment: every variable NAME the child holds. */
const NAME_SCAN = 'BEGIN { for (n in ENVIRON) print n }';

/** awk over its own environment: the NAME of every variable whose value carries the sentinel. */
const LEAK_SCAN = 'BEGIN { for (n in ENVIRON) if (index(ENVIRON[n], s) > 0) print n }';

/** The non-empty lines of a recording. Every recording holds names, never values. */
function lines(text: string): readonly string[] {
  return text.split('\n').filter((line) => line.length > 0);
}

/**
 * The interpreter `LocalWorkerRuntime` is given: it records its own environment and then `exec`s
 * the real worker, so the names it wrote are the worker's own. It writes outside the job
 * workspace, which `launch` removes before it resolves.
 */
function shimScript(python: string, namesFile: string, leakedFile: string): string {
  return [
    '#!/bin/sh',
    // stdin stays untouched for the exec'd worker, which reads the job from it.
    `awk '${NAME_SCAN}' < /dev/null > "${namesFile}"`,
    `awk -v s='${SENTINEL_VALUE}' '${LEAK_SCAN}' < /dev/null > "${leakedFile}"`,
    `exec "${python}" "$@"`,
    '',
  ].join('\n');
}

describe.skipIf(WORKER_PYTHON === null)(
  'the real spawned worker child receives no credential',
  () => {
    let shimDir = '';
    let capture: RawRunCapture | null = null;
    let childNames: readonly string[] = [];
    let leakedNames: readonly string[] = [];
    let hostHeldSentinel = false;
    let expectedNames: readonly string[] = [];

    beforeAll(async () => {
      if (WORKER_PYTHON === null) {
        throw new Error('the worker interpreter vanished after the skip decision');
      }
      shimDir = await createWorkspaceRoot();
      const shim = join(shimDir, 'recording-worker.sh');
      const namesFile = join(shimDir, 'child-env-names.txt');
      const leakedFile = join(shimDir, 'child-env-leaked-names.txt');
      await writeFile(shim, shimScript(WORKER_PYTHON, namesFile, leakedFile), {
        encoding: 'utf8',
        mode: 0o700,
      });
      // Pre-created, because the leak scan opens its output only when it finds something.
      await writeFile(leakedFile, '', 'utf8');

      // `#runWorker` reads `process.env` itself, so the sentinel has to go there. It comes
      // straight back out, so it cannot outlive the one spawn that reads it.
      process.env[SENTINEL_NAME] = SENTINEL_VALUE;
      try {
        hostHeldSentinel = process.env[SENTINEL_NAME] === SENTINEL_VALUE;
        expectedNames = WORKER_ENVIRONMENT_ALLOWLIST.filter(
          (name) => process.env[name] !== undefined,
        );
        capture = await new LocalWorkerRuntime(shim).launch(buildContainerSpec(JOB), JOB);
      } finally {
        delete process.env[SENTINEL_NAME];
      }
      childNames = lines(await readFile(namesFile, 'utf8'));
      leakedNames = lines(await readFile(leakedFile, 'utf8'));
    });

    afterAll(async () => {
      // Repeated, so a hook that never reached its `finally` still cannot leak into another file.
      delete process.env[SENTINEL_NAME];
      if (shimDir.length > 0) {
        await removeWorkspaceRoot(shimDir);
      }
    });

    it('places the sentinel in the host environment under a non-allowlisted name (Req 1.4)', () => {
      expect(WORKER_ENVIRONMENT_ALLOWLIST).not.toContain(SENTINEL_NAME);
      expect(hostHeldSentinel).toBe(true);
    });

    it('spawns a child that really ran, so an absent sentinel is not an absent process', () => {
      // The worker's refusal of an unimplemented kind: it parsed the job and dispatched on it,
      // which no unstarted child could have done.
      expect(capture?.stderr).toContain(WORKER_REFUSAL);
      expect(capture?.exitCode).toBe(1);
      expect({ infra: capture?.infraFailure, timedOut: capture?.timedOut }).toEqual({
        infra: false,
        timedOut: false,
      });
      expect(childNames.length).toBeGreaterThan(0);
    });

    it('hands the child no sentinel, under its own name or any other (Req 1.5, 1.8)', () => {
      expect(leakedNames).toEqual([]);
      expect(childNames).not.toContain(SENTINEL_NAME);
    });

    it('hands the child the allowlisted names the host held (Req 1.6)', () => {
      // No exact key set and no key count: macOS injects `__CF_USER_TEXT_ENCODING` and the shim's
      // shell adds its own, so the child's names are a superset of what the runtime passed.
      expect(expectedNames.length).toBeGreaterThan(0);
      for (const name of expectedNames) {
        expect(childNames).toContain(name);
      }
    });
  },
);
