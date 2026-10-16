// The runnable check behind the worker environment projection: no name from outside the one
// declared allowlist can reach the worker, and an allowlisted name the host lacks is reported
// by name rather than silently dropped.

import { describe, expect, it } from 'vitest';

import { WORKER_SOURCE_ROOT, workerSpawnEnvironment } from './runtime-local-worker.js';
import { WORKER_ENVIRONMENT_ALLOWLIST, projectWorkerEnvironment } from './worker-environment.js';
import { TOOL_RUNNER_WORKSPACE_ENV } from './workspace-lifecycle.js';

/** The measured exposure's shape: the credential's name beside PATH. The value here is test text. */
const HOST_WITH_CREDENTIAL = {
  PATH: '/usr/local/bin:/usr/bin',
  AWS_BEARER_TOKEN_BEDROCK: 'not-a-credential-this-is-test-text',
  HOME: '/Users/nobody',
};

describe('WORKER_ENVIRONMENT_ALLOWLIST', () => {
  it('cannot be widened at runtime', () => {
    expect(Object.isFrozen(WORKER_ENVIRONMENT_ALLOWLIST)).toBe(true);
  });
});

describe('projectWorkerEnvironment', () => {
  it('passes no name the allowlist does not hold', () => {
    const projected = projectWorkerEnvironment(HOST_WITH_CREDENTIAL);

    expect(Object.keys(projected.env)).toEqual(['PATH']);
    expect(projected.env.PATH).toBe(HOST_WITH_CREDENTIAL.PATH);
  });

  it('accounts for every allowlisted name once, and for no other name', () => {
    const projected = projectWorkerEnvironment(HOST_WITH_CREDENTIAL);

    // The allowlist is the projection's only source of names, which is what makes one
    // declaration the whole closed set (Req 1.2).
    expect([...Object.keys(projected.env), ...projected.absent].sort()).toEqual(
      [...WORKER_ENVIRONMENT_ALLOWLIST].sort(),
    );
  });

  it('reports an allowlisted name the host does not hold, by name', () => {
    const projected = projectWorkerEnvironment({ HOME: '/Users/nobody' });

    expect(projected.absent).toEqual([...WORKER_ENVIRONMENT_ALLOWLIST]);
    expect(projected.env).not.toHaveProperty('PATH');
  });

  it('treats an empty value as held rather than absent', () => {
    const projected = projectWorkerEnvironment({ PATH: '' });

    expect(projected.absent).toEqual([]);
    expect(projected.env.PATH).toBe('');
  });
});

describe('workerSpawnEnvironment', () => {
  /** The workspace root the runtime creates per run and hands to the worker. */
  const WORKSPACE_ROOT = '/tmp/tool-runner-ws-abc123';

  it('hands the spawn no name outside the allowlist and the two the runtime sets', () => {
    const spawned = workerSpawnEnvironment(HOST_WITH_CREDENTIAL, WORKSPACE_ROOT);

    expect(Object.keys(spawned.env).sort()).toEqual(
      [...WORKER_ENVIRONMENT_ALLOWLIST, 'PYTHONPATH', TOOL_RUNNER_WORKSPACE_ENV].sort(),
    );
    expect(spawned.env.PYTHONPATH).toBe(WORKER_SOURCE_ROOT);
    expect(spawned.env[TOOL_RUNNER_WORKSPACE_ENV]).toBe(WORKSPACE_ROOT);
  });

  it('carries the absent names through to the runtime diagnostic', () => {
    const spawned = workerSpawnEnvironment({ HOME: '/Users/nobody' }, WORKSPACE_ROOT);

    expect(spawned.absent).toEqual([...WORKER_ENVIRONMENT_ALLOWLIST]);
  });
});
