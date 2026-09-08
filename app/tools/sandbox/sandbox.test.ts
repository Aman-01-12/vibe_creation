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
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
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

  it('given a timed-out run, when classified, then the TIMEOUT CAUSE is carried, not lost', () => {
    // `error` collapses timeout / infra failure / missing output / truncation, and a wall-clock
    // kill leaves no exit code, no streams, and zeroed usage behind - so a caller that must tell
    // a timeout from a crash has nothing to infer from unless the fact travels with the result.
    const result = classifyCapture(job(['exitCode']), capture({ timedOut: true, exitCode: null }));

    expect(result.verdict).toBe('error');
    expect(result.timedOut).toBe(true);
  });

  it('given an INFRA failure, when classified, then it is error but NOT a timeout', () => {
    // The distinction the flag exists for: both are `error`, and only one is evidence that the
    // run kept running. Folding them would let a crashed run be read as a behavioural difference.
    const result = classifyCapture(job(['exitCode']), capture({ infraFailure: true }));

    expect(result.verdict).toBe('error');
    expect(result.timedOut).toBe(false);
  });

  it('given a clean completed run, when classified, then timedOut is false', () => {
    // Stated so `timedOut` can never be read as a verdict: a pass reports it too.
    const result = classifyCapture(job(['exitCode']), capture({ exitCode: 0 }));

    expect(result.verdict).toBe('pass');
    expect(result.timedOut).toBe(false);
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

describe('classifyCapture (bounded output must never read as a pass)', () => {
  it('given a clean exit on truncated stdout when classified then the verdict is error', () => {
    // The Tool_Runner caps how much output it retains, so a `CHECK ... FAIL` line
    // may sit in the bytes it dropped. A clean exit on a bounded prefix therefore
    // establishes nothing, exactly as an unreadable CHECK line does.
    const result = classifyCapture(
      job(['stdout', 'exitCode']),
      capture({ exitCode: 0, stdoutTruncated: true }),
    );
    expect(result.verdict).toBe('error');
  });

  it('given a non-zero exit on truncated stdout when classified then the fail is preserved', () => {
    // A definite failure outranks the evidence gap: `fail` says strictly more than
    // `error` and is what self-healing can act on.
    const result = classifyCapture(
      job(['stdout', 'exitCode']),
      capture({ exitCode: 1, stdoutTruncated: true }),
    );
    expect(result.verdict).toBe('fail');
  });

  it('given truncated stderr only when classified then the verdict still reflects the run', () => {
    // Check signalling is read from stdout, so a bounded stderr costs diagnostics
    // and nothing else. Over-reporting `error` here would hide real verdicts.
    const result = classifyCapture(
      job(['stdout', 'stderr', 'exitCode']),
      capture({ exitCode: 0, stderrTruncated: true }),
    );
    expect(result.verdict).toBe('pass');
  });

  it('given either stream truncated when classified then the flags reach the result', () => {
    const result = classifyCapture(
      job(['exitCode']),
      capture({ exitCode: 0, stdoutTruncated: true, stderrTruncated: true }),
    );
    // The seam must let a caller tell "all of the output" from "some of it".
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
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

  it('mounts only a size-capped tmpfs workspace and no secrets or host volumes', () => {
    expect(args.some((flag) => flag.startsWith('--tmpfs=/workspace:'))).toBe(true);
    expect(args.some((flag) => flag === '-v' || flag.startsWith('--volume'))).toBe(false);
    expect(args.some((flag) => flag.startsWith('--mount'))).toBe(false);
  });

  it('injects exactly one env var, the workspace path constant, and nothing else', () => {
    // The workspace root has to reach the worker somehow, and the environment is the
    // only channel that is not the untrusted job: a root the CALLER could vary is a
    // root the disk cap might not be measuring. So the ban on `--env` cannot be
    // absolute, and the assertion is made precise instead of relaxed - the one
    // permitted flag is pinned by exact value, so it cannot drift into carrying
    // anything host-derived, job-derived, or secret, and a SECOND env flag still
    // fails. The wholesale vectors (`--env-host`, `--env-file`) stay banned outright
    // in the smoke suite.
    const envFlags = args.filter((flag) => flag.startsWith('--env'));

    expect(envFlags).toEqual(['--env=TOOL_RUNNER_WORKSPACE=/workspace']);
  });
});

describe('contract schema drift guard', () => {
  it('keeps the committed JSON mirror byte-equal in value to the canonical schema', () => {
    const jsonPath = fileURLToPath(new URL('./contract.schema.json', import.meta.url));
    const onDisk: unknown = JSON.parse(readFileSync(jsonPath, 'utf8'));
    expect(onDisk).toEqual(sandboxContractSchema);
  });
});
