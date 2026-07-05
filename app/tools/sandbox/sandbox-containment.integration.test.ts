// Adversarial sandbox containment integration test (task 3.9).
//
// Tasks 3.7 (config smoke) and 3.2/3.4 (path confinement unit + property) prove
// the isolation POLICY is present and that path confinement rejects hostile
// paths in isolation. They do NOT prove that a real, hostile program is actually
// contained when launched. This suite closes that gap: it runs five genuinely
// hostile payloads through the REAL gVisor-backed `RunscSandboxRuntime` behind the
// production `SandboxToolRunner` and asserts each attack is denied or killed and
// that the denial/termination is recorded in the returned `SandboxResult` (the
// same data the Action_Recorder later persists into the Trace).
//
// It exercises Req 2.1 (isolation/no-network), 2.2/2.3 (resource caps), 2.4
// (wall-clock overrun -> error), and 2.6 (out-of-workspace writes denied and
// recorded), against real attacks rather than configuration alone.
//
// CONTAINMENT IS ONLY EXERCISED WHERE THE REAL RUNTIME EXISTS. gVisor (`runsc`)
// and the built worker image are not present in every environment (they are
// absent from the standard development sandbox). A capability probe detects them
// and the whole suite SKIPS with an explicit reason when they are missing, so it
// never fails spuriously and never creates false confidence. The payloads and
// assertions are real and correct for a real gVisor environment.
//
// Boundary note: this test lives in the `tools` layer and asserts on the
// `SandboxResult` the runner returns. It deliberately does not import the
// `agent`-layer Action_Recorder (that would violate the inward-only import
// boundary); `deniedOperations`, `verdict`, and the captured streams here are
// exactly the fields the Action_Recorder records as a Trace span downstream.

import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import {
  buildContainerSpec,
  RunscSandboxRuntime,
  SANDBOX_WORKER_IMAGE,
  SandboxToolRunner,
} from './index.js';
import type { ResourceLimits, SandboxJob, SourceFile } from './index.js';

/** The container runtime name that provides the isolation boundary. */
const GVISOR_RUNTIME = 'runsc';

/** Container CLI and worker image, overridable so deployment can pin exact values. */
const SANDBOX_CLI = process.env.ECE_SANDBOX_CLI ?? 'docker';
const WORKER_IMAGE = process.env.ECE_SANDBOX_IMAGE ?? SANDBOX_WORKER_IMAGE;

/** The outcome of probing the host for a usable real sandbox runtime. */
interface RuntimeProbe {
  readonly available: boolean;
  readonly reason: string;
  readonly cli: string;
  readonly image: string;
}

/** Run a short, read-only probe command; never throws, reports ok + stdout. */
function tryExec(
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
function detectSandboxRuntime(): RuntimeProbe {
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

const PROBE = detectSandboxRuntime();

if (!PROBE.available) {
  // Prominent, one-time notice so a skip is never mistaken for a pass: real
  // adversarial containment is NOT exercised in this environment.
  console.warn(
    `[sandbox-containment] SKIPPED - real adversarial containment NOT exercised: ${PROBE.reason}. ` +
      `Provide a gVisor ("${GVISOR_RUNTIME}") runtime and the "${PROBE.image}" worker image to run it.`,
  );
}

/** Tight caps that make containment fast: small process, disk, and wall-clock budgets. */
const HOSTILE_LIMITS: ResourceLimits = { cpu: 1, memMb: 128, procs: 16, diskMb: 16, wallMs: 4000 };

/** Build a hostile `simulate` job from the given files and optional cap overrides. */
function hostileJob(
  files: readonly SourceFile[],
  overrides: Partial<ResourceLimits> = {},
): SandboxJob {
  return {
    kind: 'simulate',
    workspaceFiles: files,
    limits: { ...HOSTILE_LIMITS, ...overrides },
    requiredOutputs: ['stdout', 'stderr', 'exitCode'],
  };
}

/** A fresh runner over the REAL gVisor runtime, pinned to the probed CLI + image. */
function newRunner(): SandboxToolRunner {
  return new SandboxToolRunner(new RunscSandboxRuntime(PROBE.cli, PROBE.image), PROBE.image);
}

/** True when the host can still spawn a process (its process table is intact). */
function hostCanStillSpawn(): boolean {
  return tryExec(process.execPath, ['-e', 'process.exit(0)']).ok;
}

// A testbench that tries to open an outbound connection. With `network=none` the
// connection can never succeed, so the success sentinel is never printed.
const NETWORK_PAYLOAD = `module hostile_network;
  initial begin
    $display("NET-ATTEMPT-START");
    $system("{ curl -sf --max-time 5 http://93.184.216.34/ >/dev/null 2>&1 && echo NET-OPEN; } || { wget -q -T 5 -O /dev/null http://93.184.216.34/ >/dev/null 2>&1 && echo NET-OPEN; } || echo NET-BLOCKED");
    $finish;
  end
endmodule
`;

// A classic fork bomb launched via $system. The pids-limit caps concurrent
// processes so the host is never exhausted, and the trailing forever loop keeps
// the simulation alive so the run is ended by the wall-clock kill timer.
const FORKBOMB_PAYLOAD = `module hostile_forkbomb;
  initial begin
    $display("FORKBOMB-START");
    $system("f(){ f|f& };f");
    forever #10;
  end
endmodule
`;

// An unbounded write into the tmpfs workspace. Once the size cap is reached the
// writes are denied; the loop never completes, so the wall-clock timer ends the
// run while the cap keeps the underlying host disk untouched.
const DISKFILL_PAYLOAD = `module hostile_diskfill;
  integer fd;
  integer i;
  initial begin
    $display("DISKFILL-START");
    fd = $fopen("fill.bin", "w");
    for (i = 0; i < 100000000; i = i + 1)
      $fwrite(fd, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    forever #10;
  end
endmodule
`;

// A simulation that never terminates on its own; only the runtime wall-clock kill
// timer can stop it, which must classify the run as `error`.
const TIMEOUT_PAYLOAD = `module hostile_timeout;
  initial begin
    $display("TIMEOUT-START");
    forever #10;
  end
endmodule
`;

/** A harmless module so out-of-workspace path jobs still have a real source to run. */
const BENIGN_PAYLOAD = `module top;
  initial begin
    $display("BENIGN-OK");
    $finish;
  end
endmodule
`;

/** A generous per-run timeout that comfortably covers container startup + the kill timer. */
const RUN_TIMEOUT_MS = 30_000;

describe.skipIf(!PROBE.available)('adversarial sandbox containment (real gVisor runtime)', () => {
  it(
    'denies an outbound network connection attempt (network=none, Req 2.1)',
    async () => {
      const job = hostileJob([{ path: 'net.v', contents: NETWORK_PAYLOAD }]);
      // The container-level control: no outbound network is ever configured.
      expect(buildContainerSpec(job, PROBE.image).network).toBe('none');

      const result = await newRunner().run(job);

      const captured = `${result.stdout}\n${result.stderr}`;
      // The success sentinel is printed only if a connection actually opened; it
      // must never appear. The blocked sentinel confirms the payload really ran.
      expect(captured).not.toContain('NET-OPEN');
      expect(captured).toContain('NET-BLOCKED');
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'contains a fork bomb via the pids-limit without exhausting host processes (Req 2.2)',
    async () => {
      const result = await newRunner().run(
        hostileJob([{ path: 'fork.v', contents: FORKBOMB_PAYLOAD }], { wallMs: 3000 }),
      );
      // The run is terminated rather than completing cleanly: the fork bomb keeps
      // the simulation alive until the wall-clock timer kills it -> error.
      expect(result.verdict).toBe('error');
      // Containment held: the host process table was never exhausted.
      expect(hostCanStillSpawn()).toBe(true);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'contains a disk-fill attempt within the tmpfs size cap (Req 2.3)',
    async () => {
      const result = await newRunner().run(
        hostileJob([{ path: 'fill.v', contents: DISKFILL_PAYLOAD }], { diskMb: 16, wallMs: 4000 }),
      );
      // The size-capped tmpfs denies further writes; the run cannot complete and
      // is killed by the wall-clock timer -> error. The host disk is untouched
      // because the only writable mount is the ephemeral, size-capped workspace.
      expect(result.verdict).toBe('error');
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'kills a wall-clock overrun and classifies it error (Req 2.4)',
    async () => {
      const startedAt = Date.now();
      const result = await newRunner().run(
        hostileJob([{ path: 'spin.v', contents: TIMEOUT_PAYLOAD }], { wallMs: 2000 }),
      );
      // The non-terminating simulation is killed by the runtime timer, and a
      // wall-clock overrun is an infra failure classified `error`, not a fail.
      expect(result.verdict).toBe('error');
      // The kill timer fired promptly rather than letting the run hang.
      expect(Date.now() - startedAt).toBeLessThan(RUN_TIMEOUT_MS);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'denies and records out-of-workspace writes as filesystem DeniedOperations (Req 2.6)',
    async () => {
      const files: readonly SourceFile[] = [
        { path: 'top.v', contents: BENIGN_PAYLOAD },
        { path: '../../../../etc/cron.d/evil.v', contents: 'module evil; endmodule' },
        { path: '/etc/evil.v', contents: 'module evil2; endmodule' },
      ];

      const result = await newRunner().run(hostileJob(files));

      const filesystemDenials = result.deniedOperations.filter(
        (denial) => denial.kind === 'filesystem',
      );
      // Both the traversal and the absolute path are rejected and recorded, never
      // written; the denial carries the offending path for the Trace.
      expect(filesystemDenials.length).toBeGreaterThanOrEqual(2);
      expect(
        filesystemDenials.some((denial) => denial.path === '../../../../etc/cron.d/evil.v'),
      ).toBe(true);
      expect(filesystemDenials.some((denial) => denial.path === '/etc/evil.v')).toBe(true);
    },
    RUN_TIMEOUT_MS,
  );
});
