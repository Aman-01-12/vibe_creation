// Both sandbox runtimes when the spawned process dies before reading its job.
//
// Each runtime hands the job over on the child's stdin. A child that exits first closes the
// pipe under that write, and Node reports EPIPE as an 'error' event on the stdin socket. With no
// listener that event is an uncaught exception that ends the whole parent process, which is how
// an eval sweep died mid-run. The run must instead resolve as an infrastructure failure.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RawRunCapture, SandboxJob, SandboxRuntime } from './contract.js';
import { buildContainerSpec } from './isolation.js';
import { LocalWorkerRuntime } from './runtime-local-worker.js';
import { RunscSandboxRuntime } from './runtime-runsc.js';

/** Larger than any OS pipe buffer, so the write is still pending when the child exits. */
const OVERSIZED_CONTENTS = 'x'.repeat(4 * 1024 * 1024);

const JOB: SandboxJob = {
  kind: 'simulate',
  workspaceFiles: [{ path: 'design.v', contents: OVERSIZED_CONTENTS }],
  limits: { cpu: 1, memMb: 64, procs: 8, diskMb: 8, wallMs: 30_000 },
  requiredOutputs: [],
};

/** A worker-shaped report, so acceptance cannot rest on the report failing to parse. */
const VALID_LOOKING_REPORT = JSON.stringify({
  exitCode: 0,
  stdout: 'CHECK a PASS\n',
  stderr: '',
  stdoutTruncated: false,
  stderrTruncated: false,
  diskLimitExceeded: false,
  artifacts: {},
  deniedOperations: [],
  resourceUsage: { wallMs: 1, maxMemMb: 1, cpuMs: 1 },
});

/** Each runtime, built around a stub binary that stands in for its worker or container CLI. */
const RUNTIMES: readonly [string, (stub: string) => SandboxRuntime][] = [
  ['LocalWorkerRuntime', (stub) => new LocalWorkerRuntime(stub)],
  ['RunscSandboxRuntime', (stub) => new RunscSandboxRuntime(stub)],
];

describe.each(RUNTIMES)('%s with a child that exits before reading its job', (_name, build) => {
  let stubDir = '';
  const uncaught: unknown[] = [];
  const record = (error: unknown): void => {
    uncaught.push(error);
  };

  beforeEach(async () => {
    stubDir = await mkdtemp(join(tmpdir(), 'undelivered-job-'));
    uncaught.length = 0;
    process.on('uncaughtException', record);
  });

  afterEach(async () => {
    process.off('uncaughtException', record);
    await rm(stubDir, { recursive: true, force: true });
  });

  /** Launch the runtime around a `/bin/sh` stub with the given body; argv is ignored. */
  async function launchWith(body: string): Promise<RawRunCapture> {
    const stub = join(stubDir, 'stub.sh');
    await writeFile(stub, `#!/bin/sh\n${body}\n`, { encoding: 'utf8', mode: 0o700 });
    return build(stub).launch(buildContainerSpec(JOB), JOB);
  }

  it('resolves the run as an infrastructure failure instead of crashing the parent', async () => {
    // Given a child that exits at once, When launched with a job too large for the pipe
    const capture = await launchWith('exit 0');

    // Then the broken pipe is absorbed and the run reports that nothing ran under its control
    expect(uncaught).toEqual([]);
    expect(capture.infraFailure).toBe(true);
    expect(capture.timedOut).toBe(false);
  });

  it('refuses a valid-looking report from a child that never read its job', async () => {
    // Given a child that prints a passing report without reading stdin
    const capture = await launchWith(`printf '%s' '${VALID_LOOKING_REPORT}'\nexit 0`);

    // Then that report is not accepted as a measurement of the job it never received
    expect(uncaught).toEqual([]);
    expect(capture.infraFailure).toBe(true);
    expect(capture.stdout).toBeNull();
  });
});
