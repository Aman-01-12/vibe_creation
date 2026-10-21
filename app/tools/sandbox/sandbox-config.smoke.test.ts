// Sandbox configuration smoke tests (task 3.7).
//
// A focused, deterministic smoke suite that pins the NON-NEGOTIABLE isolation
// guarantees of the Tool_Runner (Req 2.1, 2.2, 2.3; `security-sensitive.md`
// sandbox rules: isolated, no secrets, no default network, resource-capped).
// It exercises the pure `buildContainerSpec`/`buildRunscArgs` seam for
// representative jobs and a range of resource limits.
//
// Relationship to task 3.1 (`sandbox.test.ts`, `describe('buildRunscArgs ...')`):
// that suite proves the hardening flags are PRESENT for one default job (a
// `toContain` / `startsWith` smoke of the argv). This suite is intentionally
// complementary and does not restate those presence checks. Its distinct job is
// to pin, at the security-critical level:
//   1. the frozen isolation POLICY constant and the SPEC object (not just argv),
//   2. that every resource cap's rendered VALUE derives from the job's limits
//      (varied across cases), so a cap can never silently become hardcoded,
//   3. that swap is disabled (memory-swap == memory) so the memory cap is hard,
//   4. a single exhaustive "no injection vector" scan (no env/secret/host-volume
//      flag of any spelling), stronger than three separate presence checks, and
//   5. the design's wall-clock encoding: `wallMs` is NOT a container flag; it is
//      carried on the spec for the runtime kill timer to enforce
//      (`RunscSandboxRuntime`, exercised end to end by integration tasks 3.8/3.9).

import { describe, expect, it } from 'vitest';

import {
  SANDBOX_ISOLATION,
  SANDBOX_WORKER_IMAGE,
  TOOL_RUNNER_WORKSPACE_ENV,
  buildContainerSpec,
  buildRunscArgs,
} from './index.js';
import type { ResourceLimits, SandboxJob, SandboxJobKind } from './index.js';

/**
 * Representative limit sets. The values deliberately differ on every axis so a
 * rendered cap that ignored its input (a hardcoded constant) would fail at least
 * one case.
 */
const STUDENT_DEFAULTS: ResourceLimits = {
  cpu: 1,
  memMb: 256,
  procs: 64,
  diskMb: 64,
  wallMs: 5000,
};
const LARGER_SYNTH_JOB: ResourceLimits = {
  cpu: 2,
  memMb: 512,
  procs: 32,
  diskMb: 128,
  wallMs: 10_000,
};
const TIGHT_JOB: ResourceLimits = { cpu: 0.5, memMb: 128, procs: 16, diskMb: 32, wallMs: 2000 };

const LIMIT_CASES: ReadonlyArray<{ readonly label: string; readonly limits: ResourceLimits }> = [
  { label: 'student defaults', limits: STUDENT_DEFAULTS },
  { label: 'larger synth job', limits: LARGER_SYNTH_JOB },
  { label: 'fractional-cpu tight job', limits: TIGHT_JOB },
];

/**
 * The kind-specific payload each kind must carry, and no other kind may.
 *
 * A total `Record` over `SandboxJobKind` rather than a comparison chain, so a FIFTH job kind is
 * a compile error here instead of silently producing a job the contract rejects - which is how a
 * whole isolation-posture case comes to assert about a job that would never run.
 */
const KIND_PAYLOAD: Readonly<Record<SandboxJobKind, Partial<SandboxJob>>> = Object.freeze({
  simulate: {},
  synthesize: { synthesize: { topModule: 'top', schematic: false } },
  formal: { formal: { topModule: 'top', depth: 1 } },
  formalPrepass: { formalPrepass: { topModule: 'top' } },
  lint: { lint: { topModule: 'top' } },
});

/**
 * Build a minimal valid job for a kind and set of limits.
 *
 * Each kind carries exactly its own payload and no other kind's, because the seam requires it
 * there and forbids it elsewhere - a job built without that rule would be one the contract
 * rejects, whatever this file then asserts about it.
 */
function jobWith(limits: ResourceLimits, kind: SandboxJobKind = 'simulate'): SandboxJob {
  return {
    kind,
    workspaceFiles: [{ path: 'top.v', contents: 'module top; endmodule' }],
    limits,
    requiredOutputs: ['stdout', 'stderr', 'exitCode'],
    ...KIND_PAYLOAD[kind],
  };
}

/** The single value of a `--flag=value` argument, or undefined if the flag is absent. */
function flagValue(args: readonly string[], flag: string): string | undefined {
  const prefix = `${flag}=`;
  const match = args.find((arg) => arg.startsWith(prefix));
  return match?.slice(prefix.length);
}

describe('sandbox config smoke: isolation policy is a frozen security constant', () => {
  it('pins every non-negotiable control to its hardened value (Req 2.1)', () => {
    // Pinning the constant itself catches a weakening edit at the source, before
    // it can ever reach the rendered argv that task 3.1 smoke-checks.
    expect(SANDBOX_ISOLATION.runtime).toBe('runsc');
    expect(SANDBOX_ISOLATION.user).toBe('65534:65534');
    expect(SANDBOX_ISOLATION.readOnlyRootfs).toBe(true);
    expect(SANDBOX_ISOLATION.dropCapabilities).toEqual(['ALL']);
    expect(SANDBOX_ISOLATION.noNewPrivileges).toBe(true);
    expect(SANDBOX_ISOLATION.network).toBe('none');
    expect(SANDBOX_ISOLATION.mountSecrets).toBe(false);
    expect(SANDBOX_ISOLATION.workspacePath).toBe('/workspace');
  });
});

describe('sandbox config smoke: no secrets are ever mounted (Req 2.1)', () => {
  it('marks the spec non-secret and pins the image to the out-of-band pinned worker', () => {
    const spec = buildContainerSpec(jobWith(STUDENT_DEFAULTS));
    // `mountSecrets` is the typed `false` guarantee at the spec level; task 3.1
    // only inspects the argv, so this pins the source-of-truth object.
    expect(spec.mountSecrets).toBe(false);
    expect(spec.image).toBe(SANDBOX_WORKER_IMAGE);
  });

  it('renders no env-injection or host-volume flag of any spelling, bar the workspace path', () => {
    const args = buildRunscArgs(buildContainerSpec(jobWith(STUDENT_DEFAULTS)));
    // One exhaustive scan of every forbidden secret/host-reachback vector,
    // covering short and long spellings, rather than a few sampled presence
    // checks. If any of these ever appears, generated code could receive a
    // secret or reach the host filesystem.
    //
    // THE ONE ALLOWED VALUE, and why it is not a hole. The worker must be told which
    // directory is its workspace, or it falls back to a temporary directory that on a
    // `--read-only` rootfs is either unwritable or sits OUTSIDE the size-capped tmpfs -
    // so `diskMb` would bound a tree the run does not use. It cannot come from the job,
    // which is untrusted input. Both halves of the permitted flag are compile-time
    // constants of ours, so it is checked by exact identity below rather than skipped by
    // a loosened prefix: nothing host-derived, job-derived, or secret can ride in on it.
    // `--env-host` and `--env-file` - the flags that pull the ambient environment in
    // wholesale, which is how a secret would actually arrive - stay banned outright.
    const allowedEnvFlag = `--env=${TOOL_RUNNER_WORKSPACE_ENV}=${SANDBOX_ISOLATION.workspacePath}`;
    const forbiddenExact = new Set([
      '-e',
      '-v',
      '--env',
      '--volume',
      '--mount',
      '--env-file',
      '--env-host',
    ]);
    const forbiddenPrefixes = [
      '--env=',
      '--env-file=',
      '-e=',
      '-v=',
      '--volume=',
      '--mount=',
      '--secret',
    ];
    for (const arg of args) {
      if (arg === allowedEnvFlag) {
        continue;
      }
      expect(forbiddenExact.has(arg)).toBe(false);
      for (const prefix of forbiddenPrefixes) {
        expect(arg.startsWith(prefix)).toBe(false);
      }
    }
    // The allowance is not vacuous and is not open-ended: exactly one env flag, and it
    // is that one.
    expect(args.filter((arg) => arg.startsWith('--env'))).toEqual([allowedEnvFlag]);
  });
});

describe('sandbox config smoke: no default outbound network (Req 2.1)', () => {
  it('sets the network mode to none on both the spec and the rendered argv', () => {
    const spec = buildContainerSpec(jobWith(STUDENT_DEFAULTS));
    expect(spec.network).toBe('none');
    expect(buildRunscArgs(spec)).toContain('--network=none');
  });
});

describe('sandbox config smoke: resource caps derive from the job limits (Req 2.2, 2.3)', () => {
  it.each(LIMIT_CASES)(
    'renders CPU, memory, process, and disk caps from the $label limits',
    ({ limits }) => {
      const args = buildRunscArgs(buildContainerSpec(jobWith(limits)));

      // Each rendered value must equal the job's limit, proving the cap is wired
      // from `ResourceLimits` and not a hardcoded constant. This is the guarantee
      // task 3.1 does not make (it only checks the flags are present).
      expect(flagValue(args, '--cpus')).toBe(String(limits.cpu));
      expect(flagValue(args, '--memory')).toBe(`${limits.memMb}m`);
      expect(flagValue(args, '--pids-limit')).toBe(String(limits.procs));

      // Swap disabled: memory-swap equal to memory makes the memory cap hard
      // (no swap escape hatch). Distinct from any task 3.1 assertion.
      expect(flagValue(args, '--memory-swap')).toBe(`${limits.memMb}m`);

      // The workspace tmpfs is size-capped from `diskMb`, and is non-suid/non-dev.
      const tmpfs = flagValue(args, '--tmpfs');
      expect(tmpfs).toBe(
        `${SANDBOX_ISOLATION.workspacePath}:rw,nosuid,nodev,size=${limits.diskMb}m`,
      );
    },
  );

  it('changes the rendered cap values when the limits change (not hardcoded)', () => {
    const small = buildRunscArgs(buildContainerSpec(jobWith(TIGHT_JOB)));
    const large = buildRunscArgs(buildContainerSpec(jobWith(LARGER_SYNTH_JOB)));
    expect(flagValue(small, '--memory')).not.toBe(flagValue(large, '--memory'));
    expect(flagValue(small, '--cpus')).not.toBe(flagValue(large, '--cpus'));
    expect(flagValue(small, '--pids-limit')).not.toBe(flagValue(large, '--pids-limit'));
    expect(flagValue(small, '--tmpfs')).not.toBe(flagValue(large, '--tmpfs'));
  });
});

describe('sandbox config smoke: wall-clock cap lives in the runtime, not the argv (Req 2.2)', () => {
  it.each(LIMIT_CASES)(
    'omits wallMs from the container flags for the $label limits',
    ({ limits }) => {
      const spec = buildContainerSpec(jobWith(limits));
      const args = buildRunscArgs(spec);

      // The wall-clock cap is enforced by the runtime kill timer, not a container
      // flag (see `RunscSandboxRuntime.spawnRun`; exercised by integration tasks
      // 3.8/3.9). So it must be carried on the spec's limits yet absent from argv.
      expect(spec.limits.wallMs).toBe(limits.wallMs);
      expect(args.some((arg) => arg.startsWith('--timeout'))).toBe(false);
      expect(args.some((arg) => arg.startsWith('--stop-timeout'))).toBe(false);
      expect(args.some((arg) => arg.includes(String(limits.wallMs)))).toBe(false);
    },
  );
});

describe('sandbox config smoke: guarantees hold across job kinds', () => {
  // Read off `KIND_PAYLOAD`'s keys rather than hand-listed, because `it.each<SandboxJobKind>`
  // is TYPED by the union but not EXHAUSTIVE over it: a hand list silently leaves a new kind
  // unchecked here, which is what happened when `formal` was added. The total `Record` above is
  // what makes this list complete by construction (Req 14.11, 14.25 - the pre-pass executes
  // under every isolation control a formal invocation does).
  it.each<SandboxJobKind>(Object.keys(KIND_PAYLOAD) as SandboxJobKind[])(
    'keeps the isolation posture identical for a %s job',
    (kind) => {
      const args = buildRunscArgs(buildContainerSpec(jobWith(STUDENT_DEFAULTS, kind)));
      // The isolation posture is fixed by policy and must not vary by job kind.
      expect(args).toContain('--network=none');
      expect(args).toContain('--runtime=runsc');
      expect(args).toContain('--read-only');
      expect(args).toContain('--cap-drop=ALL');
    },
  );
});
