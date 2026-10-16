// Tool_Runner sandbox adapter (TypeScript side): the trust boundary for all
// arbitrary-code execution. This barrel is the public surface of the sandbox
// package for task 3.1 - the language-neutral job/result contract, the hardened
// gVisor isolation policy, capture-all-or-error classification, and the adapter
// behind an injectable runtime port. All validation stays in TypeScript; the thin
// Python worker under ./worker (task 3.2) consumes the same contract across the
// seam and implements the iverilog/vvp glue and path confinement.

// The language-neutral contract types and the runtime/adapter ports.
export type {
  ArtifactBlobRef,
  ContainerSpec,
  DeniedOperation,
  DeniedOperationKind,
  FormalJobRequest,
  FormalPrepassJobRequest,
  DefaultTimescale,
  SimulateJobRequest,
  RawRunCapture,
  RequiredOutput,
  ResourceLimits,
  ResourceUsage,
  SandboxJob,
  SandboxJobKind,
  SandboxResult,
  SandboxRuntime,
  SourceFile,
  ToolRunner,
} from './contract.js';

// The canonical seam schema. The byte-mirror `contract.schema.json` (consumed by
// the Python worker) is kept in lockstep with this const by a drift-guard test.
export {
  CONTRACT_SCHEMA_ID,
  SANDBOX_JOB_REF,
  SANDBOX_RESULT_REF,
  sandboxContractSchema,
} from './contract-schema.js';

// Contract validation (both sides validate against the schema; this is the TS side).
export { validateSandboxJob, validateSandboxResult } from './validation.js';
export { SandboxContractError } from './errors.js';
export type { ContractViolation, ContractViolationCode } from './errors.js';

// Hardened isolation policy and pure container-spec/argv construction.
export {
  SANDBOX_ISOLATION,
  SANDBOX_WORKER_IMAGE,
  buildContainerSpec,
  buildRunscArgs,
} from './isolation.js';

// The closed allowlist of host environment variables the local worker child may inherit,
// and the pure projection that applies it, so no credential reaches generated Verilog.
export { WORKER_ENVIRONMENT_ALLOWLIST, projectWorkerEnvironment } from './worker-environment.js';
export type { ProjectedWorkerEnvironment } from './worker-environment.js';

// Capture-all-or-error classification.
export { classifyCapture, missingRequiredOutputs } from './classification.js';

// The adapter and the three interchangeable runtimes: real gVisor isolation
// (production), the real worker as a local process (real toolchain, no isolation -
// integration suites and a provisioned eval host), and the no-toolchain fake.
export { SandboxToolRunner } from './adapter.js';
export { RunscSandboxRuntime } from './runtime-runsc.js';
export {
  LocalWorkerRuntime,
  WORKER_ENV_ABSENT_NOTE,
  WORKER_SOURCE_ROOT,
  workerSpawnEnvironment,
} from './runtime-local-worker.js';

// Bounded, content-addressed retention of a run's registered artifact BYTES. The seam
// itself still carries refs only; this is the resolve-by-ref side of that model for a
// caller whose verdict IS a report the worker wrote into the workspace.
export {
  BoundedArtifactRetention,
  MAX_RETAINED_ARTIFACT_BYTES,
  MAX_RETAINED_TOTAL_BYTES,
} from './artifact-retention.js';
export type { ArtifactRetentionSink } from './artifact-retention.js';
export { FakeSandboxRuntime } from './fake-runtime.js';
export type { FakeCaptureScript } from './fake-runtime.js';

// Workspace lifecycle: creation, the process-tree kill that ends the writers, the
// removal that runs whether a run exited or was killed, and the bounded reaper for
// directories an earlier crashed parent orphaned.
export {
  createWorkspaceRoot,
  reapStaleWorkspaceRoots,
  removeWorkspaceRoot,
  spawnInOwnProcessGroup,
  STALE_WORKSPACE_MIN_AGE_MS,
  TOOL_RUNNER_WORKSPACE_ENV,
  WORKSPACE_CLEANUP_FAILED_NOTE,
  WORKSPACE_DIR_PREFIX,
} from './workspace-lifecycle.js';
export type {
  ProcessGroupChild,
  WorkspaceNoteSink,
  WorkspaceReapOptions,
  WorkspaceReapOutcome,
} from './workspace-lifecycle.js';
