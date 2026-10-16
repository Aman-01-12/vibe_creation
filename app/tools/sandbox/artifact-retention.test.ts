// The runnable check behind `BoundedArtifactRetention`: the smallest set of assertions that fails
// if retention regresses in any of the four directions that matter.
//
// Scope, deliberately narrow. This file asserts what the STORE does: that registered bytes come
// back exactly, that every bound refuses with `null` rather than with a partial document, that the
// key is the content hash and not the path, and that the total cap holds under pressure. The
// consequence of a `null` - that no verdict can be built from one - is a fact about the CALLER and
// is asserted where the caller lives (`../formal/adapter.test.ts`), because that is the only place
// a `proved` can be constructed at all.
//
// A real temp workspace rather than a mocked filesystem, and the module's OWN
// `createWorkspaceRoot` / `removeWorkspaceRoot` rather than a second temp-directory helper: the
// bounds under test are path confinement, a symlink refusal, and a size check, and none of those
// means anything against a fake `fs`.

import { createHash } from 'node:crypto';
import { symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BoundedArtifactRetention,
  MAX_RETAINED_ARTIFACT_BYTES,
  MAX_RETAINED_TOTAL_BYTES,
} from './artifact-retention.js';
import type { ArtifactBlobRef, ContainerSpec, SandboxJob } from './contract.js';
import { buildContainerSpec } from './isolation.js';
import { LocalWorkerRuntime } from './runtime-local-worker.js';
import { createWorkspaceRoot, removeWorkspaceRoot } from './workspace-lifecycle.js';

/** The ref the worker would register for a file of this content at this workspace-relative name. */
function refFor(name: string, contents: string): ArtifactBlobRef {
  return {
    name,
    sizeBytes: Buffer.byteLength(contents, 'utf8'),
    sha256: createHash('sha256').update(contents, 'utf8').digest('hex'),
  };
}

/** A representative honest report: small ASCII JSON, exactly what this store exists to carry. */
const REPORT_TEXT = JSON.stringify({
  lowering: { exitCode: 0, stderrTail: '' },
  assertionCount: 2,
});

describe('BoundedArtifactRetention', () => {
  let workspaceRoot = '';
  let retention = new BoundedArtifactRetention();

  beforeEach(async () => {
    workspaceRoot = await createWorkspaceRoot();
    retention = new BoundedArtifactRetention();
  });

  afterEach(async () => {
    await removeWorkspaceRoot(workspaceRoot);
  });

  /** Write one file into the workspace and return the ref a run would have registered for it. */
  async function registered(name: string, contents: string): Promise<ArtifactBlobRef> {
    await writeFile(join(workspaceRoot, name), contents, 'utf8');
    return refFor(name, contents);
  }

  it('returns a registered artifact text EXACTLY, keyed on its content hash', async () => {
    const ref = await registered('formal-report.json', REPORT_TEXT);

    await retention.retain(workspaceRoot, { formalReport: ref });

    expect(await retention.readText(ref)).toBe(REPORT_TEXT);
    // Keyed on the hash and not on the path: the same bytes resolve under a different NAME, and
    // nothing resolves under the same name with a different hash. This is what makes `readText` a
    // lookup rather than a second source of truth about which file is which.
    expect(await retention.readText({ ...ref, name: 'somewhere-else.json' })).toBe(REPORT_TEXT);
    expect(await retention.readText({ ...ref, sha256: 'f'.repeat(64) })).toBeNull();
  });

  it('answers null for an artifact that was never retained', async () => {
    await retention.retain(workspaceRoot, {});

    expect(await retention.readText(refFor('formal-report.json', REPORT_TEXT))).toBeNull();
    expect(retention.retainedBytes).toBe(0);
  });

  it('refuses an OVER-CAP artifact with null, and never with a truncated prefix', async () => {
    // One byte past the per-artifact cap. A truncated JSON report is not a report, so the only
    // honest answers are the whole document or nothing - and nothing is the fail-safe one.
    const oversized = 'x'.repeat(MAX_RETAINED_ARTIFACT_BYTES + 1);
    const ref = await registered('formal-report.json', oversized);

    await retention.retain(workspaceRoot, { formalReport: ref });

    expect(await retention.readText(ref)).toBeNull();
    expect(retention.retainedBytes).toBe(0);
  });

  it('retains an artifact EXACTLY at the cap, so the refusal is the size and not the path', async () => {
    // The positive control for the test above: same store, same name, one byte fewer. A refusal
    // that fired for any reason other than the size would refuse this one too.
    const atCap = 'x'.repeat(MAX_RETAINED_ARTIFACT_BYTES);
    const ref = await registered('formal-report.json', atCap);

    await retention.retain(workspaceRoot, { formalReport: ref });

    expect(await retention.readText(ref)).toBe(atCap);
    expect(retention.retainedBytes).toBe(MAX_RETAINED_ARTIFACT_BYTES);
  });

  it('refuses a ref whose hash does not match the bytes on disk', async () => {
    // The worker writes both the file and the ref, so a mismatch means the key would name a
    // document the store does not hold. Refused, rather than admitted under a lying key.
    await writeFile(join(workspaceRoot, 'formal-report.json'), REPORT_TEXT, 'utf8');
    const honest = refFor('formal-report.json', REPORT_TEXT);
    const lying: ArtifactBlobRef = { ...honest, sha256: 'a'.repeat(64) };

    await retention.retain(workspaceRoot, { formalReport: lying });

    expect(await retention.readText(lying)).toBeNull();
    expect(retention.retainedBytes).toBe(0);
  });

  it('reads nothing through a path or a symlink that leaves the workspace', async () => {
    // The positive control for all three refusals below is the first test in this file: an
    // ordinary in-workspace regular file IS retained, so a refusal here is about the PATH.
    const outside = await createWorkspaceRoot();
    const outsidePath = join(outside, 'outside.json');
    const secret = 'THE BYTES OUTSIDE THE WORKSPACE';
    try {
      await writeFile(outsidePath, secret, 'utf8');
      await symlink(outsidePath, join(workspaceRoot, 'link.json'));
      // A relative name that really does resolve to the outside file, an absolute one, and a
      // symlink: the three channels a workspace-relative name could escape through.
      const traversal = refFor(relative(workspaceRoot, outsidePath), secret);
      const absolute = refFor(outsidePath, secret);
      const viaSymlink = refFor('link.json', secret);

      await retention.retain(workspaceRoot, { a: traversal, b: absolute, c: viaSymlink });

      expect(await retention.readText(traversal)).toBeNull();
      expect(await retention.readText(absolute)).toBeNull();
      expect(await retention.readText(viaSymlink)).toBeNull();
      expect(retention.retainedBytes).toBe(0);
    } finally {
      await removeWorkspaceRoot(outside);
    }
  });

  it('EVICTS to stay inside the total cap, keeping the newest artifact readable', async () => {
    // Enough max-size artifacts to overrun the total twice over, retained one run at a time the
    // way a sequence of real runs would arrive.
    const runs = Math.ceil((MAX_RETAINED_TOTAL_BYTES * 2) / MAX_RETAINED_ARTIFACT_BYTES);
    let oldest: ArtifactBlobRef | null = null;
    let newest: ArtifactBlobRef | null = null;
    for (let run = 0; run < runs; run += 1) {
      // Distinct content per run, so each one is a distinct hash rather than a repeat hit.
      const contents = `${run}`.padEnd(MAX_RETAINED_ARTIFACT_BYTES, 'x');
      const ref = await registered('formal-report.json', contents);
      oldest ??= ref;
      newest = ref;
      await retention.retain(workspaceRoot, { formalReport: ref });
      // The bound holds after EVERY run, not merely at the end.
      expect(retention.retainedBytes).toBeLessThanOrEqual(MAX_RETAINED_TOTAL_BYTES);
    }
    if (oldest === null || newest === null) {
      throw new Error('the eviction fixture retained no artifacts');
    }

    // The newest is still readable - the property that matters, because the one caller reads a
    // report immediately after the run that wrote it - and the oldest has been evicted.
    expect(await retention.readText(newest)).not.toBeNull();
    expect(await retention.readText(oldest)).toBeNull();
  });

  it('keeps the per-artifact cap at or under the total cap, which is what makes room reachable', () => {
    // `#insert` has no branch for "evicted everything and it still does not fit", because this
    // inequality means no such state exists. Pinned here rather than left as a coincidence.
    expect(MAX_RETAINED_ARTIFACT_BYTES).toBeLessThanOrEqual(MAX_RETAINED_TOTAL_BYTES);
  });
});

describe('LocalWorkerRuntime retention wiring', () => {
  // The ORDERING check, and the only thing that fails if the `retain` call is removed from
  // `launch`. Retention has exactly one correct moment - after the worker has registered its
  // artifacts and before the `finally` removes the workspace - and readable bytes afterwards are
  // what proves it happened in that window: the workspace is unconditionally removed by the time
  // `launch` resolves, so bytes that come back must have been read before the removal.
  //
  // A STUB WORKER at the process boundary rather than the real one, because `pythonBin` is
  // injected and the question under test is the runtime's sequencing, not the worker's EDA glue.
  // The stub is a `/bin/sh` script that ignores the `-m tool_runner_worker` argv, writes one file
  // into the workspace it was handed, and prints a worker-shaped report registering it - so no EDA
  // toolchain and no Python are needed and the check runs in every environment.

  /** The document the stub worker writes and registers, standing in for a real report. */
  const STUB_REPORT = JSON.stringify({ lowering: { exitCode: 0 }, assertionCount: 2 });

  /** The ref the stub registers, computed the way the real worker computes it. */
  const STUB_REF: ArtifactBlobRef = refFor('formal-report.json', STUB_REPORT);

  /** A job the stub worker never reads; `launch` needs one and the spec is derived from it. */
  const JOB: SandboxJob = {
    kind: 'simulate',
    workspaceFiles: [{ path: 'design.v', contents: 'module m; endmodule' }],
    limits: { cpu: 1, memMb: 64, procs: 8, diskMb: 8, wallMs: 30_000 },
    requiredOutputs: [],
  };

  /** The hardened spec for that job. `launch` reads only the wall-clock cap off it. */
  const SPEC: ContainerSpec = buildContainerSpec(JOB);

  it('retains the registered bytes BEFORE the workspace is removed', async () => {
    const stubDir = await createWorkspaceRoot();
    try {
      const stub = join(stubDir, 'stub-worker.sh');
      const report = JSON.stringify({
        exitCode: 0,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        diskLimitExceeded: false,
        artifacts: { formalReport: STUB_REF },
        deniedOperations: [],
        resourceUsage: { wallMs: 1, maxMemMb: 1, cpuMs: 1 },
      });
      await writeFile(
        stub,
        [
          '#!/bin/sh',
          'cat > /dev/null',
          `printf '%s' '${STUB_REPORT}' > "$TOOL_RUNNER_WORKSPACE/formal-report.json"`,
          `printf '%s' '${report}'`,
          '',
        ].join('\n'),
        { encoding: 'utf8', mode: 0o700 },
      );

      const retention = new BoundedArtifactRetention();
      const capture = await new LocalWorkerRuntime(stub, undefined, retention).launch(SPEC, JOB);

      // The seam still carried a ref and no bytes, and the bytes are nonetheless readable.
      expect(capture.artifacts.formalReport).toEqual(STUB_REF);
      expect(await retention.readText(STUB_REF)).toBe(STUB_REPORT);
    } finally {
      await removeWorkspaceRoot(stubDir);
    }
  });
});
