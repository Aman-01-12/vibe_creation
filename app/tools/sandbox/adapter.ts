// The Tool_Runner adapter: the trust boundary for arbitrary-code execution.
//
// All validation lives here in TypeScript, never in the worker. `run` validates
// the untrusted job against the seam contract, builds the hardened container spec,
// delegates the actual launch to an injected `SandboxRuntime`, then applies
// capture-all-or-error classification and validates its own result before
// returning. The runtime is injected so the real gVisor runtime and the test fake
// are interchangeable without changing this class.

import type { SandboxJob, SandboxResult, SandboxRuntime, ToolRunner } from './contract.js';
import { classifyCapture } from './classification.js';
import { SandboxContractError } from './errors.js';
import { buildContainerSpec, SANDBOX_WORKER_IMAGE } from './isolation.js';
import { validateSandboxJob, validateSandboxResult } from './validation.js';

/**
 * Sandbox-backed `ToolRunner`. Validates at the boundary, isolates via the
 * injected runtime, and classifies capture-all-or-error.
 */
export class SandboxToolRunner implements ToolRunner {
  private readonly runtime: SandboxRuntime;
  private readonly image: string;

  constructor(runtime: SandboxRuntime, image: string = SANDBOX_WORKER_IMAGE) {
    this.runtime = runtime;
    this.image = image;
  }

  async run(job: SandboxJob): Promise<SandboxResult> {
    const validatedJob = validateSandboxJob(job);
    if (!validatedJob.ok) {
      // Untrusted input failed the seam contract: reject rather than execute it.
      throw new SandboxContractError(validatedJob.error);
    }

    const spec = buildContainerSpec(validatedJob.value, this.image);
    const capture = await this.runtime.launch(spec, validatedJob.value);
    const result = classifyCapture(validatedJob.value, capture);

    const validatedResult = validateSandboxResult(result);
    if (!validatedResult.ok) {
      // Our own output must satisfy the seam; a break here is an internal defect.
      throw new SandboxContractError(validatedResult.error);
    }
    return validatedResult.value;
  }
}
