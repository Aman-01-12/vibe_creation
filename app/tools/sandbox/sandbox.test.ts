// Example unit tests for the Tool_Runner sandbox adapter (task 3.1).
//
// These are concrete example checks of the runner's core logic: capture-all-or-
// error classification (the whole invocation is `error` on timeout, infra failure,
// or a missing required output), contract validation at the seam, the hardened
// isolation flags, the adapter end-to-end over the injectable runtime fake, and a
// drift guard that the committed JSON mirror matches the canonical schema. The
// universal Property 8 (capture-all-or-error) is a separate fast-check property in
// task 3.3; these examples complement it and are intentionally not exhaustive.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  FakeSandboxRuntime,
  SandboxContractError,
  SandboxToolRunner,
  buildContainerSpec,
  buildRunscArgs,
  classifyCapture,
  missingRequiredOutputs,
  sandboxContractSchema,
  validateSandboxJob,
} from './index.js';
import type { RawRunCapture, RequiredOutput, SandboxJob } from './index.js';

const LIMITS = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5000 } as const;

/** A minimal valid simulate job; callers pick which outputs are required. */
function job(requiredOutputs: readonly RequiredOutput[]): SandboxJob {
  return {
    kind: 'simulate',
    workspaceFiles: [{ path: 'top.v', contents: 'module top; endmodule' }],
    limits: LIMITS,
    requiredOutputs,
  };
}

/** A fully captured, successful run; override fields to model each scenario. */
function capture(overrides: Partial<RawRunCapture> = {}): RawRunCapture {
  return {
    timedOut: false,
    infraFailure: false,
    exitCode: 0,
    stdout: '',
    stderr: '',
    artifacts: {},
    deniedOperations: [],
    resourceUsage: { wallMs: 12, maxMemMb: 8, cpuMs: 10 },
    ...overrides,
  };
}

/** A captured VCD artifact blob reference. */
const VCD_ARTIFACT = {
  vcd: { name: 'dump.vcd', sizeBytes: 4, sha256: 'a'.repeat(64) },
} as const;

describe('classifyCapture (capture-all-or-error)', () => {
  it('classifies a fully captured clean exit as pass', () => {
    const result = classifyCapture(job(['stdout', 'stderr', 'exitCode']), capture({ exitCode: 0 }));
    expect(result.verdict).toBe('pass');
  });

  it('classifies a fully captured non-zero exit as a functional fail', () => {
    const result = classifyCapture(job(['stdout', 'stderr', 'exitCode']), capture({ exitCode: 1 }));
    expect(result.verdict).toBe('fail');
  });

  it('classifies a wall-clock timeout as error regardless of exit code', () => {
    const result = classifyCapture(job(['exitCode']), capture({ timedOut: true, exitCode: 0 }));
    expect(result.verdict).toBe('error');
  });

  it('classifies an infrastructure failure as error', () => {
    const result = classifyCapture(job(['exitCode']), capture({ infraFailure: true }));
    expect(result.verdict).toBe('error');
  });

  it('classifies a missing required artifact as error, not a partial result', () => {
    const result = classifyCapture(
      job(['exitCode', 'vcd']),
      capture({ exitCode: 0, artifacts: {} }),
    );
    expect(result.verdict).toBe('error');
  });

  it('classifies a missing required stream as error', () => {
    const result = classifyCapture(job(['stdout']), capture({ stdout: null }));
    expect(result.verdict).toBe('error');
  });

  it('reflects the run when every required output including the artifact is present', () => {
    const result = classifyCapture(
      job(['exitCode', 'vcd']),
      capture({ exitCode: 0, artifacts: VCD_ARTIFACT }),
    );
    expect(result.verdict).toBe('pass');
    expect(result.artifacts.vcd?.name).toBe('dump.vcd');
  });
});

describe('missingRequiredOutputs', () => {
  it('lists a required output that was not captured', () => {
    expect(missingRequiredOutputs(['vcd', 'exitCode'], capture({ exitCode: 0 }))).toEqual(['vcd']);
  });

  it('is empty when every required output is present', () => {
    const present = capture({ exitCode: 0, artifacts: VCD_ARTIFACT });
    expect(missingRequiredOutputs(['exitCode', 'vcd'], present)).toEqual([]);
  });
});

describe('validateSandboxJob (seam contract)', () => {
  it('accepts a well-formed job', () => {
    expect(validateSandboxJob(job(['exitCode'])).ok).toBe(true);
  });

  it('rejects a non-positive memory limit', () => {
    const bad = { ...job(['exitCode']), limits: { ...LIMITS, memMb: 0 } };
    expect(validateSandboxJob(bad).ok).toBe(false);
  });

  it('rejects an unknown extra property', () => {
    const bad = { ...job(['exitCode']), rogue: true };
    expect(validateSandboxJob(bad).ok).toBe(false);
  });
});

describe('SandboxToolRunner (adapter over the runtime port)', () => {
  it('validates, launches, and classifies a valid job', async () => {
    const runtime = new FakeSandboxRuntime(capture({ exitCode: 0, artifacts: VCD_ARTIFACT }));
    const runner = new SandboxToolRunner(runtime);
    const result = await runner.run(job(['exitCode', 'vcd']));
    expect(result.verdict).toBe('pass');
  });

  it('rejects an invalid job at the boundary before any launch', async () => {
    const runtime = new FakeSandboxRuntime(capture());
    const runner = new SandboxToolRunner(runtime);
    const invalid = {
      ...job(['exitCode']),
      limits: { ...LIMITS, memMb: -1 },
    } as unknown as SandboxJob;
    await expect(runner.run(invalid)).rejects.toBeInstanceOf(SandboxContractError);
  });
});

describe('buildRunscArgs (isolation flags)', () => {
  const args = buildRunscArgs(buildContainerSpec(job(['exitCode'])));

  it('enforces gVisor, non-root, read-only rootfs, dropped caps, and no new privileges', () => {
    expect(args).toContain('--runtime=runsc');
    expect(args).toContain('--user=65534:65534');
    expect(args).toContain('--read-only');
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--security-opt=no-new-privileges');
  });

  it('denies default network and caps memory, cpu, and process count', () => {
    expect(args).toContain('--network=none');
    expect(args.some((flag) => flag.startsWith('--memory='))).toBe(true);
    expect(args.some((flag) => flag.startsWith('--cpus='))).toBe(true);
    expect(args.some((flag) => flag.startsWith('--pids-limit='))).toBe(true);
  });

  it('mounts only a size-capped tmpfs workspace and no secrets, env, or host volumes', () => {
    expect(args.some((flag) => flag.startsWith('--tmpfs=/workspace:'))).toBe(true);
    expect(args.some((flag) => flag.startsWith('--env'))).toBe(false);
    expect(args.some((flag) => flag === '-v' || flag.startsWith('--volume'))).toBe(false);
    expect(args.some((flag) => flag.startsWith('--mount'))).toBe(false);
  });
});

describe('contract schema drift guard', () => {
  it('keeps the committed JSON mirror byte-equal in value to the canonical schema', () => {
    const jsonPath = fileURLToPath(new URL('./contract.schema.json', import.meta.url));
    const onDisk: unknown = JSON.parse(readFileSync(jsonPath, 'utf8'));
    expect(onDisk).toEqual(sandboxContractSchema);
  });
});
