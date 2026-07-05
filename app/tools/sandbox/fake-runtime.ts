// In-process fake sandbox runtime (TEST DOUBLE - not for production use).
//
// This is a faithful stand-in for the `SandboxRuntime` port so the adapter, the
// capture-all-or-error classification, and later property tests can run without a
// real gVisor container. It performs no isolation and executes nothing; it simply
// returns a scripted `RawRunCapture`. The real, isolation-enforcing runtime is
// `RunscSandboxRuntime`; both implement the same port so they are interchangeable
// by dependency injection.

import type { ContainerSpec, RawRunCapture, SandboxJob, SandboxRuntime } from './contract.js';

/** Produces the capture a fake run should report for a given job. */
export type FakeCaptureScript = (job: SandboxJob, spec: ContainerSpec) => RawRunCapture;

/**
 * A `SandboxRuntime` that returns a scripted capture instead of launching a
 * container. Construct it with a fixed capture or a function of the job/spec.
 */
export class FakeSandboxRuntime implements SandboxRuntime {
  private readonly script: FakeCaptureScript;

  constructor(script: FakeCaptureScript | RawRunCapture) {
    this.script = typeof script === 'function' ? script : () => script;
  }

  launch(spec: ContainerSpec, job: SandboxJob): Promise<RawRunCapture> {
    return Promise.resolve(this.script(job, spec));
  }
}
