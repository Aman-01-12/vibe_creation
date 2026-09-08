// Example unit tests for the Project_Store (task 12.1).
//
// These are concrete example checks over the IN-MEMORY storage adapter of the
// four behaviors the store must never break:
//
//   1. Persistence round-trip: Spec, sources, Testbench, latest verification
//      result, and Trace survive persist -> restore unchanged (Req 16.2, 16.3).
//   2. Durable checkpoints on Spec approval and on reaching `Verified`
//      (Req 16.1, 5.7).
//   3. Crash restore loads ONLY the last consistent checkpoint, falls back on an
//      integrity failure and surfaces the unrecovered part, preserves the crash
//      Trace separately, and never auto-re-executes (Req 16.4, 16.6-16.10).
//   4. The real per-object authorizer denies a non-owner on BOTH access and
//      automatic restore while allowing the owner, decided from the validated
//      token claim (Req 16.5, 16.9).
//
// The numbered properties (29/30/31) and the IDOR regression suite are the
// separate fast-check suites in tasks 12.2-12.5; these examples complement them.

import { describe, expect, it } from 'vitest';

import {
  InMemoryStorageAdapter,
  ProjectStore,
  createOwnerObjectAuthorizer,
  verifyCheckpointIntegrity,
  type Checkpoint,
  type ProjectState,
} from '@app/api';
import {
  isErr,
  isOk,
  makePort,
  makeTestbench,
  makeVerificationResult,
  newUlid,
  type AcceptanceCriterion,
  type ModuleVersion,
  type Port,
  type Project,
  type Spec,
  type Testbench,
  type Trace,
  type Ulid,
  type VerificationResult,
} from '@app/core';
import type { AuthenticatedPrincipal } from '@app/api';

/** Unwrap a Result in a test, failing loudly if it is unexpectedly an error. */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) {
    throw new Error(`unexpected error result: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

function principal(userId: Ulid): AuthenticatedPrincipal {
  return { userId, sessionId: newUlid(), scopes: [] };
}

function buildPort(): Port {
  return unwrap(makePort({ name: 'clk', direction: 'input', width: 1 }));
}

function buildSpec(projectId: Ulid, approved: boolean): Spec {
  const criterion: AcceptanceCriterion = {
    id: newUlid(),
    text: 'counts up on each clock',
    measurable: true,
    method: 'simulation',
  };
  return {
    id: newUlid(),
    projectId,
    goal: 'a 1-bit counter',
    constraints: ['synchronous reset'],
    moduleInterface: {
      moduleName: 'counter',
      ports: [buildPort()],
      clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
    },
    acceptanceCriteria: [criterion],
    architecture: 'single always block',
    approved,
    version: 1,
  };
}

function buildModuleVersion(projectId: Ulid): ModuleVersion {
  return {
    id: newUlid(),
    projectId,
    specVersion: 1,
    rtl: 'module counter(...); endmodule',
    createdAt: '2024-01-01T00:00:00.000Z',
  };
}

function buildTestbench(specId: Ulid): Testbench {
  return makeTestbench({
    id: newUlid(),
    specId,
    specVersion: 1,
    source: 'initial begin end',
    coversCriteria: [newUlid()],
  });
}

function buildPassingResult(moduleVersionId: Ulid, testbenchId: Ulid): VerificationResult {
  return unwrap(
    makeVerificationResult({
      id: newUlid(),
      moduleVersionId,
      testbenchId,
      verdict: 'pass',
      allChecksPassed: true,
      iterations: 2,
      costCents: 3,
      oracleSpanId: newUlid(),
    }),
  );
}

function buildTrace(): Trace {
  const sessionId = newUlid();
  return {
    sessionId,
    spans: [
      {
        id: newUlid(),
        sessionId,
        seq: 0,
        stageOrTool: 'simulate',
        sanitizedInputs: { rtl: 'redacted' },
        outputs: { verdict: 'pass' },
        exitCode: 0,
        startedAt: '2024-01-01T00:00:01.000Z',
        durationMs: 42,
        retryCount: 0,
        costCents: 1,
      },
    ],
  };
}

/** A fully populated project state owned by `ownerId`. */
function buildState(ownerId: Ulid, approved = true): ProjectState {
  const projectId = newUlid();
  const spec = buildSpec(projectId, approved);
  const moduleVersion = buildModuleVersion(projectId);
  const testbench = buildTestbench(spec.id);
  const project: Project = {
    id: projectId,
    ownerId,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:02.000Z',
    specId: spec.id,
    currentModuleVersionId: moduleVersion.id,
  };
  return {
    project,
    spec,
    sources: [moduleVersion],
    testbench,
    latestVerificationResult: buildPassingResult(moduleVersion.id, testbench.id),
    trace: buildTrace(),
  };
}

/** Compose a store over a fresh in-memory adapter and the real owner authorizer. */
function newStore(): { store: ProjectStore; adapter: InMemoryStorageAdapter } {
  const adapter = new InMemoryStorageAdapter();
  const store = new ProjectStore({
    adapter,
    authorizer: createOwnerObjectAuthorizer(adapter),
  });
  return { store, adapter };
}

describe('ProjectStore persistence round-trip (Req 16.2, 16.3)', () => {
  it('restores the exact Spec, sources, Testbench, result, and Trace that were persisted', async () => {
    const { store } = newStore();
    const owner = principal(newUlid());
    const state = buildState(owner.userId);

    expect(isOk(await store.createProject(owner, state))).toBe(true);
    const restored = unwrap(await store.restore(owner, state.project.id));

    expect(restored).toEqual(state);
  });

  it('returns null when the project has no stored state', async () => {
    const { store, adapter } = newStore();
    const owner = principal(newUlid());
    // Seed ownership so the access is authorized but no state was ever saved.
    const projectId = newUlid();
    await adapter.saveProjectState(buildState(owner.userId));
    const decision = await store.restore(owner, projectId);
    expect(isErr(decision)).toBe(true); // unknown project id -> fail closed
  });
});

describe('ProjectStore durable checkpoints (Req 16.1, 5.7)', () => {
  it('writes a spec-approved checkpoint only for an approved spec', async () => {
    const { store } = newStore();
    const owner = principal(newUlid());
    const state = buildState(owner.userId, true);
    await store.createProject(owner, state);

    const checkpoint = unwrap(await store.checkpointOnSpecApproval(owner, state));
    expect(checkpoint.reason).toBe('spec-approved');
    expect(verifyCheckpointIntegrity(checkpoint)).toBe(true);
  });

  it('refuses a spec-approved checkpoint when the spec is not approved', async () => {
    const { store } = newStore();
    const owner = principal(newUlid());
    const state = buildState(owner.userId, false);
    await store.createProject(owner, state);

    expect(isErr(await store.checkpointOnSpecApproval(owner, state))).toBe(true);
  });

  it('writes a verified checkpoint only for a passing result', async () => {
    const { store } = newStore();
    const owner = principal(newUlid());
    const state = buildState(owner.userId);
    await store.createProject(owner, state);

    const checkpoint = unwrap(await store.checkpointOnVerified(owner, state));
    expect(checkpoint.reason).toBe('verified');
  });

  it('refuses a verified checkpoint without a passing result', async () => {
    const { store } = newStore();
    const owner = principal(newUlid());
    const base = buildState(owner.userId);
    const state: ProjectState = { ...base, latestVerificationResult: null };
    await store.createProject(owner, state);

    expect(isErr(await store.checkpointOnVerified(owner, state))).toBe(true);
  });
});

describe('ProjectStore crash restore (Req 16.4, 16.6-16.10)', () => {
  it('restores the most recent consistent checkpoint and never auto-re-executes', async () => {
    const { store } = newStore();
    const owner = principal(newUlid());
    const state = buildState(owner.userId);
    await store.createProject(owner, state);
    await store.checkpointOnSpecApproval(owner, state);
    const verified = unwrap(await store.checkpointOnVerified(owner, state));

    const outcome = unwrap(await store.restoreLastConsistentCheckpoint(owner, state.project.id));

    expect(outcome.restoredCheckpointId).toBe(verified.id);
    expect(outcome.restoredReason).toBe('verified');
    expect(outcome.unrecovered).toHaveLength(0);
    expect(outcome.autoReExecuted).toBe(false);
  });

  it('falls back to the previous valid checkpoint on an integrity failure and surfaces it', async () => {
    const { store, adapter } = newStore();
    const owner = principal(newUlid());
    const state = buildState(owner.userId);
    await store.createProject(owner, state);
    const good = unwrap(await store.checkpointOnSpecApproval(owner, state));

    // Append a newer, corrupt checkpoint directly: its integrity does not match
    // its state, modelling a partial/corrupt write.
    const corruptSeq = await adapter.nextCheckpointSeq(state.project.id);
    const corrupt: Checkpoint = {
      id: newUlid(),
      projectId: state.project.id,
      seq: corruptSeq,
      reason: 'verified',
      createdAt: '2024-01-01T00:00:05.000Z',
      state,
      integrity: 'not-the-real-fingerprint',
    };
    await adapter.appendCheckpoint(corrupt);

    const outcome = unwrap(await store.restoreLastConsistentCheckpoint(owner, state.project.id));

    expect(outcome.restoredCheckpointId).toBe(good.id);
    expect(outcome.unrecovered).toHaveLength(1);
    expect(outcome.unrecovered[0]?.checkpointId).toBe(corrupt.id);
  });

  it('restores nothing but surfaces all corrupt checkpoints when none are consistent', async () => {
    const { store, adapter } = newStore();
    const owner = principal(newUlid());
    const state = buildState(owner.userId);
    await store.createProject(owner, state);
    const corrupt: Checkpoint = {
      id: newUlid(),
      projectId: state.project.id,
      seq: 0,
      reason: 'spec-approved',
      createdAt: '2024-01-01T00:00:05.000Z',
      state,
      integrity: 'corrupt',
    };
    await adapter.appendCheckpoint(corrupt);

    const outcome = unwrap(await store.restoreLastConsistentCheckpoint(owner, state.project.id));

    expect(outcome.restored).toBeNull();
    expect(outcome.unrecovered).toHaveLength(1);
  });

  it('preserves the crash Trace separately and surfaces the interrupted step', async () => {
    const { store } = newStore();
    const owner = principal(newUlid());
    const state = buildState(owner.userId);
    await store.createProject(owner, state);
    await store.checkpointOnSpecApproval(owner, state);
    expect(isOk(await store.preserveCrashTrace(owner, state.project.id, state.trace))).toBe(true);

    const outcome = unwrap(await store.restoreLastConsistentCheckpoint(owner, state.project.id));

    expect(outcome.crashTracePreserved).toBe(true);
    expect(outcome.interruptedStep?.stageOrTool).toBe('simulate');
  });
});

describe('ProjectStore no-auto-re-execute resume gate (Req 16.8)', () => {
  it('blocks a resume without explicit approval', async () => {
    const { store } = newStore();
    const owner = principal(newUlid());
    const state = buildState(owner.userId);
    await store.createProject(owner, state);

    const decision = unwrap(
      await store.resumeInterruptedStep(owner, {
        projectId: state.project.id,
        approved: false,
        sideEffectful: true,
        idempotencyKey: 'key-1',
      }),
    );
    expect(decision.kind).toBe('blocked-needs-approval');
  });

  it('blocks a side-effectful resume that has no idempotency key', async () => {
    const { store } = newStore();
    const owner = principal(newUlid());
    const state = buildState(owner.userId);
    await store.createProject(owner, state);

    const decision = unwrap(
      await store.resumeInterruptedStep(owner, {
        projectId: state.project.id,
        approved: true,
        sideEffectful: true,
        idempotencyKey: '',
      }),
    );
    expect(decision.kind).toBe('blocked-needs-idempotency-key');
  });

  it('authorizes a side-effectful resume once and suppresses a reused key', async () => {
    const { store } = newStore();
    const owner = principal(newUlid());
    const state = buildState(owner.userId);
    await store.createProject(owner, state);
    const request = {
      projectId: state.project.id,
      approved: true,
      sideEffectful: true,
      idempotencyKey: 'key-42',
    };

    const first = unwrap(await store.resumeInterruptedStep(owner, request));
    const second = unwrap(await store.resumeInterruptedStep(owner, request));

    expect(first.kind).toBe('authorized-to-resume');
    expect(second.kind).toBe('duplicate-suppressed');
  });
});

describe('ProjectStore per-object authorization (Req 16.5, 16.9)', () => {
  it('allows the owner to restore and denies a non-owner on access', async () => {
    const { store } = newStore();
    const owner = principal(newUlid());
    const attacker = principal(newUlid());
    const state = buildState(owner.userId);
    await store.createProject(owner, state);

    expect(isOk(await store.restore(owner, state.project.id))).toBe(true);

    const denied = await store.restore(attacker, state.project.id);
    expect(isErr(denied)).toBe(true);
    if (isErr(denied)) {
      expect(denied.error.code).toBe('forbidden');
    }
  });

  it('denies a non-owner on automatic crash restore', async () => {
    const { store } = newStore();
    const owner = principal(newUlid());
    const attacker = principal(newUlid());
    const state = buildState(owner.userId);
    await store.createProject(owner, state);
    await store.checkpointOnVerified(owner, state);

    const denied = await store.restoreLastConsistentCheckpoint(attacker, state.project.id);
    expect(isErr(denied)).toBe(true);
  });

  it('denies persisting state that would reassign ownership', async () => {
    const { store } = newStore();
    const owner = principal(newUlid());
    const state = buildState(owner.userId);
    await store.createProject(owner, state);

    const tampered: ProjectState = {
      ...state,
      project: { ...state.project, ownerId: newUlid() },
    };
    const denied = await store.persist(owner, tampered);
    expect(isErr(denied)).toBe(true);
  });

  it('fails closed for an unknown project and an invalid claim', async () => {
    const adapter = new InMemoryStorageAdapter();
    const authorizer = createOwnerObjectAuthorizer(adapter);
    const owner = principal(newUlid());

    // Unknown project -> denied (nothing stored yet).
    const unknown = await authorizer.authorize(owner, newUlid());
    expect(isErr(unknown)).toBe(true);

    // Invalid subject claim -> denied.
    const badClaim = await authorizer.authorize(principal('not-a-ulid'), newUlid());
    expect(isErr(badClaim)).toBe(true);
  });
});
