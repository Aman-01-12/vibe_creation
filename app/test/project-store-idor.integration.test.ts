// IDOR / BOLA regression suite for the Project_Store (task 12.5; Req 16.5, 16.9;
// Design: Testing Strategy (Integration tests)).
//
// This is the concrete, enumerated companion to the universal Property 31 (task
// 12.4). Where the property asserts the invariant over random inputs, this suite
// pins the cross-user denial across EVERY project-touching Project_Store method,
// one explicit case each, so a future regression that drops an authorization
// check on any single endpoint fails loudly and by name.
//
// It asserts three things for the full endpoint surface:
//   1. The legitimate owner is ALLOWED on every method (no false denial).
//   2. A different authenticated user (the attacker) is DENIED on every method
//      with a sanitized `forbidden` (Req 16.5, 16.9).
//   3. The denial LEAKS NOTHING about whether the target project exists: an
//      attacker probing a real project id and a random unknown id gets an
//      identical `forbidden` (no enumeration oracle).
//
// A completeness guard cross-checks the enumerated set against the store's actual
// public methods, so a newly-added project endpoint that is not covered here (and
// therefore might ship without an ownership check) breaks this test immediately.
//
// Transport boundary: the tRPC router's object-scoped procedures (`openProject`,
// `requestIteration`) enforce access by delegating to the injected
// `ObjectAuthorizer` via `authorizeObject` before touching any handler. tRPC v11
// does not expose `createCallerFactory` on its public surface (only the internal
// `t.createCallerFactory`, which the api layer keeps private), so rather than
// reaching into tRPC internals we exercise the exact authorization decision those
// procedures funnel through, with the real owner authorizer the router is
// composed with. The ProjectStore layer below is the authoritative enforcement
// point the router delegates to, and it is covered exhaustively.

import { describe, expect, it } from 'vitest';

import {
  InMemoryStorageAdapter,
  ProjectStore,
  authorizeObject,
  createOwnerObjectAuthorizer,
  toClientSafeError,
  type AuthenticatedPrincipal,
  type GatewayError,
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
  type Project,
  type Result,
  type Spec,
  type Testbench,
  type Trace,
  type Ulid,
  type VerificationResult,
} from '@app/core';

/** Unwrap a Result in a test, failing loudly if it is unexpectedly an error. */
function unwrap<T>(result: Result<T, unknown>): T {
  if (!result.ok) {
    throw new Error(`unexpected error result: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

function principal(userId: Ulid): AuthenticatedPrincipal {
  return { userId, sessionId: newUlid(), scopes: [] };
}

function buildSpec(projectId: Ulid): Spec {
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
      ports: [unwrap(makePort({ name: 'clk', direction: 'input', width: 1 }))],
      clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
    },
    acceptanceCriteria: [criterion],
    architecture: 'single always block',
    approved: true,
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

/** A fully populated, approved-and-verified project state owned by `ownerId`. */
function buildState(ownerId: Ulid): ProjectState {
  const projectId = newUlid();
  const spec = buildSpec(projectId);
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

/** Everything a per-endpoint case needs about the owner's existing project. */
interface OwnedProject {
  readonly state: ProjectState;
  readonly projectId: Ulid;
  readonly trace: Trace;
}

/**
 * One project-touching endpoint, with an owner-allowed invocation and an
 * attacker invocation that must be denied. Every public method of the store that
 * touches a stored project MUST have an entry here (enforced by the completeness
 * guard below), so a newly-added endpoint cannot ship uncovered.
 */
interface EndpointCase {
  readonly name: string;
  /** The store method this case exercises; matched against the store's surface. */
  readonly method: keyof ProjectStore;
  allow(
    store: ProjectStore,
    owner: AuthenticatedPrincipal,
    p: OwnedProject,
  ): Promise<Result<unknown, GatewayError>>;
  deny(
    store: ProjectStore,
    attacker: AuthenticatedPrincipal,
    p: OwnedProject,
  ): Promise<Result<unknown, GatewayError>>;
}

const ENDPOINT_CASES: readonly EndpointCase[] = [
  {
    name: 'createProject',
    method: 'createProject',
    // A brand-new project the owner is allowed to create.
    allow: (store, owner) => store.createProject(owner, buildState(owner.userId)),
    // The attacker cannot plant or hijack a project at an id the owner already
    // holds, whether they claim it for themselves or for the owner.
    deny: (store, attacker, p) =>
      store.createProject(attacker, {
        ...p.state,
        project: { ...p.state.project, ownerId: attacker.userId },
      }),
  },
  {
    name: 'persist',
    method: 'persist',
    allow: (store, owner, p) => store.persist(owner, p.state),
    deny: (store, attacker, p) => store.persist(attacker, p.state),
  },
  {
    name: 'restore (reopen)',
    method: 'restore',
    allow: (store, owner, p) => store.restore(owner, p.projectId),
    deny: (store, attacker, p) => store.restore(attacker, p.projectId),
  },
  {
    name: 'restoreLastConsistentCheckpoint (automatic crash restore)',
    method: 'restoreLastConsistentCheckpoint',
    allow: (store, owner, p) => store.restoreLastConsistentCheckpoint(owner, p.projectId),
    deny: (store, attacker, p) => store.restoreLastConsistentCheckpoint(attacker, p.projectId),
  },
  {
    name: 'checkpointOnSpecApproval',
    method: 'checkpointOnSpecApproval',
    allow: (store, owner, p) => store.checkpointOnSpecApproval(owner, p.state),
    deny: (store, attacker, p) => store.checkpointOnSpecApproval(attacker, p.state),
  },
  {
    name: 'checkpointOnVerified',
    method: 'checkpointOnVerified',
    allow: (store, owner, p) => store.checkpointOnVerified(owner, p.state),
    deny: (store, attacker, p) => store.checkpointOnVerified(attacker, p.state),
  },
  {
    name: 'preserveCrashTrace',
    method: 'preserveCrashTrace',
    allow: (store, owner, p) => store.preserveCrashTrace(owner, p.projectId, p.trace),
    deny: (store, attacker, p) => store.preserveCrashTrace(attacker, p.projectId, p.trace),
  },
  {
    name: 'resumeInterruptedStep',
    method: 'resumeInterruptedStep',
    allow: (store, owner, p) =>
      store.resumeInterruptedStep(owner, {
        projectId: p.projectId,
        approved: true,
        sideEffectful: false,
        idempotencyKey: 'resume-key',
      }),
    deny: (store, attacker, p) =>
      store.resumeInterruptedStep(attacker, {
        projectId: p.projectId,
        approved: true,
        sideEffectful: false,
        idempotencyKey: 'resume-key',
      }),
  },
] as const;

/**
 * Seed a store with one project owned by `owner`. The project is fully populated
 * (approved spec + passing verification result) so every owner-allowed
 * invocation has its preconditions satisfied and a denial can only come from the
 * authorization check, never from a missing precondition.
 */
async function seedOwnedProject(
  store: ProjectStore,
  owner: AuthenticatedPrincipal,
): Promise<OwnedProject> {
  const state = buildState(owner.userId);
  expect(isOk(await store.createProject(owner, state))).toBe(true);
  return { state, projectId: state.project.id, trace: state.trace };
}

/** Assert a denial is a sanitized `forbidden` that leaks no internal detail. */
function expectSanitizedForbidden(
  result: Result<unknown, GatewayError>,
  secretsThatMustNotLeak: readonly string[],
): void {
  expect(isErr(result)).toBe(true);
  if (!isErr(result)) {
    return;
  }
  expect(result.error.code).toBe('forbidden');

  // What the client actually receives is the static, code-derived message; it
  // must never carry an id, owner, or other internal value.
  const clientSafe = toClientSafeError(result.error);
  expect(clientSafe.code).toBe('forbidden');
  expect(clientSafe.message).toBe('You do not have access to this resource.');
  for (const secret of secretsThatMustNotLeak) {
    expect(clientSafe.message).not.toContain(secret);
  }
}

describe('Project_Store IDOR/BOLA regression: cross-user denial across every project endpoint (Req 16.5, 16.9)', () => {
  for (const endpoint of ENDPOINT_CASES) {
    it(`allows the owner and denies a non-owner on ${endpoint.name}`, async () => {
      const { store } = newStore();
      const owner = principal(newUlid());
      const attacker = principal(newUlid());
      const owned = await seedOwnedProject(store, owner);

      // The legitimate owner is allowed.
      expect(isOk(await endpoint.allow(store, owner, owned))).toBe(true);

      // A different authenticated user is denied with a sanitized forbidden that
      // leaks neither the project id nor the owner id.
      const denied = await endpoint.deny(store, attacker, owned);
      expectSanitizedForbidden(denied, [owned.projectId, owner.userId]);
    });
  }

  it('covers every public project-touching method of the store (completeness guard)', () => {
    // Any public method added to ProjectStore that is not enumerated above is a
    // potential unguarded endpoint. `#private` methods are not enumerable on the
    // prototype, so this set is exactly the public surface.
    const publicMethods = Object.getOwnPropertyNames(ProjectStore.prototype).filter(
      (name) => name !== 'constructor',
    );
    const covered = new Set(ENDPOINT_CASES.map((c) => c.method));

    const uncovered = publicMethods.filter((name) => !covered.has(name as keyof ProjectStore));
    expect(uncovered).toEqual([]);
    // And every enumerated method is real (no stale entry masking a rename).
    for (const method of covered) {
      expect(publicMethods).toContain(method);
    }
  });
});

describe('Project_Store IDOR denial reveals no project-existence oracle (Req 16.9)', () => {
  // Requirements 16.5/16.9 require the denial to be uniform so an attacker cannot
  // learn which project ids exist by probing. The two id-only restore paths are
  // the enumeration-prone surface, so we pin them explicitly.
  it('returns an identical forbidden for a real foreign project and an unknown id on restore', async () => {
    const { store } = newStore();
    const owner = principal(newUlid());
    const attacker = principal(newUlid());
    const owned = await seedOwnedProject(store, owner);
    const unknownProjectId = newUlid();

    const deniedReal = await store.restore(attacker, owned.projectId);
    const deniedUnknown = await store.restore(attacker, unknownProjectId);

    expect(isErr(deniedReal)).toBe(true);
    expect(isErr(deniedUnknown)).toBe(true);
    if (isErr(deniedReal) && isErr(deniedUnknown)) {
      // Same code AND same detail: the "not the owner" and "does not exist" cases
      // are indistinguishable to the caller.
      expect(deniedReal.error).toEqual(deniedUnknown.error);
      expect(deniedReal.error.code).toBe('forbidden');
    }
  });

  it('returns an identical forbidden for a real foreign project and an unknown id on automatic crash restore', async () => {
    const { store } = newStore();
    const owner = principal(newUlid());
    const attacker = principal(newUlid());
    const owned = await seedOwnedProject(store, owner);
    const unknownProjectId = newUlid();

    const deniedReal = await store.restoreLastConsistentCheckpoint(attacker, owned.projectId);
    const deniedUnknown = await store.restoreLastConsistentCheckpoint(attacker, unknownProjectId);

    expect(isErr(deniedReal)).toBe(true);
    expect(isErr(deniedUnknown)).toBe(true);
    if (isErr(deniedReal) && isErr(deniedUnknown)) {
      expect(deniedReal.error).toEqual(deniedUnknown.error);
    }
  });
});

describe('Transport boundary: the tRPC object-scoped procedures delegate to the same owner authorizer', () => {
  // `openProject` and `requestIteration` both call `authorizeObject(objectAuthorizer, ...)`
  // (via the router's `ensureObjectAccess`) BEFORE reaching any handler. We assert
  // that exact decision here with the real authorizer the router is composed with;
  // see the file header for why we do not construct a tRPC caller directly.
  it('authorizes the owner and rejects a non-owner for the router object-scoped project id', async () => {
    const adapter = new InMemoryStorageAdapter();
    const objectAuthorizer = createOwnerObjectAuthorizer(adapter);
    const store = new ProjectStore({ adapter, authorizer: objectAuthorizer });
    const owner = principal(newUlid());
    const attacker = principal(newUlid());
    const owned = await seedOwnedProject(store, owner);

    // openProject.projectId / requestIteration.projectId is `owned.projectId`.
    expect(isOk(await authorizeObject(objectAuthorizer, owner, owned.projectId))).toBe(true);

    const denied = await authorizeObject(objectAuthorizer, attacker, owned.projectId);
    expectSanitizedForbidden(denied, [owned.projectId, owner.userId]);
  });
});
