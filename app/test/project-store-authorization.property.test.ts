// Property 31 for the Project_Store: per-object authorization on project access
// and automatic restore (task 12.4; Req 16.5, 16.9).
//
// This is the security (IDOR/BOLA) complement to the concrete examples in
// `project-store.test.ts`. Over generated DISTINCT owner/attacker principals and
// a project owned by the owner, it asserts the ownership biconditional the design
// binds to Property 31: for every project entry point AND for automatic restore,
// access succeeds iff the calling principal's validated token claim
// (`principal.userId`) equals the stored project owner, decided server-side.
//
// The property covers all seven object-scoped entry points on the store:
//   - restore (reopen), Req 16.3/16.5
//   - restoreLastConsistentCheckpoint (automatic crash restore), Req 16.4/16.9
//   - checkpointOnSpecApproval, Req 16.1/16.5
//   - checkpointOnVerified, Req 16.1/16.5
//   - persist, Req 16.2/16.5
//   - preserveCrashTrace, Req 16.10/16.5
//   - resumeInterruptedStep, Req 16.8/16.5
//
// It also asserts the authorizer FAILS CLOSED (unknown project denied, invalid
// non-ULID claim denied), that the denial is UNIFORM (`forbidden`, identical
// error object) for "unknown project" and "not the owner" so ownership cannot be
// used to enumerate which projects exist, and that a persist cannot reassign
// ownership away from the caller.
//
// A fresh in-memory adapter + `createOwnerObjectAuthorizer(adapter)` + store are
// composed per run, so every iteration is fully independent and ownership is
// decided from the same durable source of truth the store persists.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  InMemoryStorageAdapter,
  ProjectStore,
  createOwnerObjectAuthorizer,
  type ProjectState,
  type AuthenticatedPrincipal,
} from '@app/api';
import {
  isErr,
  isOk,
  isUlid,
  makePort,
  makeTestbench,
  makeVerificationResult,
  type ModuleVersion,
  type Project,
  type Result,
  type Spec,
  type Testbench,
  type Trace,
  type Ulid,
  type VerificationResult,
} from '@app/core';
import { propertyParameters, propertyTag } from '@app/test';

// --- ULID + principal generators ---------------------------------------------
// ULIDs are built from the Crockford base32 alphabet with a timestamp-high first
// character (`0`-`7`) so every generated id is syntactically valid and fully
// reproducible under shrinking (no reliance on the non-deterministic clock).

/** Crockford base32 (no I, L, O, U): the ULID alphabet. */
const CROCKFORD: readonly string[] = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.split('');

/** An arbitrary string of fixed length drawn from an explicit alphabet. */
function fromChars(chars: readonly string[], length: number): fc.Arbitrary<string> {
  const [first, ...rest] = chars;
  if (first === undefined) {
    throw new Error('fromChars requires a non-empty character set');
  }
  return fc
    .array(fc.constantFrom(first, ...rest), { minLength: length, maxLength: length })
    .map((picked) => picked.join(''));
}

/** A syntactically valid, 26-character ULID identifier. */
function ulidArbitrary(): fc.Arbitrary<Ulid> {
  return fc
    .tuple(fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '7'), fromChars(CROCKFORD, 25))
    .map(([head, rest]) => `${head}${rest}`);
}

/** An authenticated principal whose subject claim is a valid ULID. */
function principalArbitrary(): fc.Arbitrary<AuthenticatedPrincipal> {
  return fc
    .tuple(ulidArbitrary(), ulidArbitrary())
    .map(([userId, sessionId]) => ({ userId, sessionId, scopes: [] }));
}

/** A distinct (owner, attacker) pair: the attacker never shares the owner's id. */
function distinctPrincipalsArbitrary(): fc.Arbitrary<
  readonly [AuthenticatedPrincipal, AuthenticatedPrincipal]
> {
  return fc
    .tuple(principalArbitrary(), principalArbitrary())
    .filter(([owner, attacker]) => owner.userId !== attacker.userId);
}

/** A string that is never a valid ULID, for the malformed-claim fail-closed case. */
function nonUlidArbitrary(): fc.Arbitrary<string> {
  return fc.string({ maxLength: 30 }).filter((candidate) => !isUlid(candidate));
}

// --- ProjectState builder ----------------------------------------------------
// A fully populated, valid project state owned by `ownerId`. It carries an
// approved Spec and a passing verification result so the checkpoint entry points
// pass their business preconditions for the OWNER; every id is generated so the
// state is reproducible.

/** The generated ULIDs a project state is assembled from (ownership aside). */
interface StateIds {
  readonly projectId: Ulid;
  readonly specId: Ulid;
  readonly criterionId: Ulid;
  readonly moduleVersionId: Ulid;
  readonly testbenchId: Ulid;
  readonly coversCriterionId: Ulid;
  readonly resultId: Ulid;
  readonly oracleSpanId: Ulid;
  readonly sessionId: Ulid;
  readonly spanId: Ulid;
}

function stateIdsArbitrary(): fc.Arbitrary<StateIds> {
  return fc.record<StateIds>({
    projectId: ulidArbitrary(),
    specId: ulidArbitrary(),
    criterionId: ulidArbitrary(),
    moduleVersionId: ulidArbitrary(),
    testbenchId: ulidArbitrary(),
    coversCriterionId: ulidArbitrary(),
    resultId: ulidArbitrary(),
    oracleSpanId: ulidArbitrary(),
    sessionId: ulidArbitrary(),
    spanId: ulidArbitrary(),
  });
}

/** Unwrap a core constructor Result in test setup, failing loudly on error. */
function mustBuild<T>(result: Result<T, unknown>): T {
  if (isErr(result)) {
    throw new Error(`unexpected build error: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

function buildApprovedSpec(ids: StateIds): Spec {
  const port = mustBuild(makePort({ name: 'clk', direction: 'input', width: 1 }));
  return {
    id: ids.specId,
    projectId: ids.projectId,
    goal: 'a 1-bit counter',
    constraints: ['synchronous reset'],
    moduleInterface: {
      moduleName: 'counter',
      ports: [port],
      clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
    },
    acceptanceCriteria: [
      {
        id: ids.criterionId,
        text: 'counts up on each clock',
        measurable: true,
        method: 'simulation',
      },
    ],
    architecture: 'single always block',
    approved: true,
    version: 1,
  };
}

function buildPassingResult(ids: StateIds): VerificationResult {
  return mustBuild(
    makeVerificationResult({
      id: ids.resultId,
      moduleVersionId: ids.moduleVersionId,
      testbenchId: ids.testbenchId,
      verdict: 'pass',
      allChecksPassed: true,
      iterations: 2,
      costCents: 3,
      oracleSpanId: ids.oracleSpanId,
    }),
  );
}

function buildTrace(ids: StateIds): Trace {
  return {
    sessionId: ids.sessionId,
    spans: [
      {
        id: ids.spanId,
        sessionId: ids.sessionId,
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

/** Assemble the full, valid working state for `ownerId` from generated ids. */
function buildState(ownerId: Ulid, ids: StateIds): ProjectState {
  const spec = buildApprovedSpec(ids);
  const moduleVersion: ModuleVersion = {
    id: ids.moduleVersionId,
    projectId: ids.projectId,
    specVersion: 1,
    rtl: 'module counter(...); endmodule',
    createdAt: '2024-01-01T00:00:00.000Z',
  };
  const testbench: Testbench = makeTestbench({
    id: ids.testbenchId,
    specId: spec.id,
    specVersion: 1,
    source: 'initial begin end',
    coversCriteria: [ids.coversCriterionId],
  });
  const project: Project = {
    id: ids.projectId,
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
    latestVerificationResult: buildPassingResult(ids),
    trace: buildTrace(ids),
  };
}

/**
 * Rebind a base state's owner claim to `principal`, keeping the SAME project id.
 *
 * This is what each principal submits to the state-carrying entry points: the
 * owner re-submits their own state unchanged, while the attacker submits a state
 * that claims their own ownership but still targets the victim's project id, so
 * the per-object authorizer (not just a field pre-check) is the control under
 * test on every state-carrying method.
 */
function stateSubmittedBy(base: ProjectState, principal: AuthenticatedPrincipal): ProjectState {
  return { ...base, project: { ...base.project, ownerId: principal.userId } };
}

// --- Entry points ------------------------------------------------------------

/** One object-scoped entry point, invoked by an arbitrary principal. */
interface EntryPoint {
  readonly name: string;
  readonly invoke: (
    store: ProjectStore,
    principal: AuthenticatedPrincipal,
    base: ProjectState,
  ) => Promise<Result<unknown, { code: string }>>;
}

/**
 * Every access method plus automatic restore. Each is invoked against the SAME
 * stored project, so the ownership biconditional is asserted uniformly across
 * the whole object-scoped surface (Req 16.5, 16.9).
 */
const ENTRY_POINTS: readonly EntryPoint[] = [
  { name: 'restore', invoke: (store, p, base) => store.restore(p, base.project.id) },
  {
    name: 'restoreLastConsistentCheckpoint',
    invoke: (store, p, base) => store.restoreLastConsistentCheckpoint(p, base.project.id),
  },
  {
    name: 'checkpointOnSpecApproval',
    invoke: (store, p, base) => store.checkpointOnSpecApproval(p, stateSubmittedBy(base, p)),
  },
  {
    name: 'checkpointOnVerified',
    invoke: (store, p, base) => store.checkpointOnVerified(p, stateSubmittedBy(base, p)),
  },
  { name: 'persist', invoke: (store, p, base) => store.persist(p, stateSubmittedBy(base, p)) },
  {
    name: 'preserveCrashTrace',
    invoke: (store, p, base) => store.preserveCrashTrace(p, base.project.id, base.trace),
  },
  {
    name: 'resumeInterruptedStep',
    invoke: (store, p, base) =>
      store.resumeInterruptedStep(p, {
        projectId: base.project.id,
        approved: true,
        sideEffectful: false,
        idempotencyKey: '',
      }),
  },
];

/** Compose a store over a fresh in-memory adapter and the real owner authorizer. */
function newStore(): { store: ProjectStore; adapter: InMemoryStorageAdapter } {
  const adapter = new InMemoryStorageAdapter();
  const store = new ProjectStore({ adapter, authorizer: createOwnerObjectAuthorizer(adapter) });
  return { store, adapter };
}

// --- The property ------------------------------------------------------------

describe('Project_Store per-object authorization (Property 31)', () => {
  // Feature: hdl-creation-loop, Property 31: Per-object authorization on project access and restore
  it('grants the owner and denies every non-owner on all access methods and automatic restore', async () => {
    await fc.assert(
      fc.asyncProperty(
        distinctPrincipalsArbitrary(),
        stateIdsArbitrary(),
        async ([owner, attacker], ids) => {
          const { store } = newStore();
          const base = buildState(owner.userId, ids);
          // Bootstrap ownership from the authenticated principal (Req 16.5).
          expect(isOk(await store.createProject(owner, base))).toBe(true);

          for (const entry of ENTRY_POINTS) {
            // Non-owner is denied with a uniform `forbidden` on every entry
            // point, including automatic restore (IDOR/BOLA defense).
            const attackerResult = await entry.invoke(store, attacker, base);
            expect(isErr(attackerResult), `${entry.name} must deny a non-owner`).toBe(true);
            if (isErr(attackerResult)) {
              expect(attackerResult.error.code, `${entry.name} denial code`).toBe('forbidden');
            }

            // Owner is allowed on the same entry point: the biconditional holds
            // (allowed iff principal.userId === project.ownerId).
            const ownerResult = await entry.invoke(store, owner, base);
            expect(isOk(ownerResult), `${entry.name} must allow the owner`).toBe(true);
          }
        },
      ),
      propertyParameters(),
    );
  });

  it('fails closed for an unknown project and a malformed (non-ULID) subject claim', async () => {
    await fc.assert(
      fc.asyncProperty(
        principalArbitrary(),
        ulidArbitrary(),
        nonUlidArbitrary(),
        async (owner, unknownProjectId, badClaim) => {
          const adapter = new InMemoryStorageAdapter();
          const authorizer = createOwnerObjectAuthorizer(adapter);

          // Nothing is stored: an unknown project id must deny, never grant.
          const unknown = await authorizer.authorize(owner, unknownProjectId);
          expect(isErr(unknown)).toBe(true);
          if (isErr(unknown)) {
            expect(unknown.error.code).toBe('forbidden');
          }

          // A malformed subject claim can never own anything: deny.
          const malformed = await authorizer.authorize(
            { userId: badClaim, sessionId: owner.sessionId, scopes: [] },
            unknownProjectId,
          );
          expect(isErr(malformed)).toBe(true);
          if (isErr(malformed)) {
            expect(malformed.error.code).toBe('forbidden');
          }
        },
      ),
      propertyParameters(),
    );
  });

  it('denies unknown-project and not-owner identically, leaking no enumeration signal', async () => {
    await fc.assert(
      fc.asyncProperty(
        distinctPrincipalsArbitrary(),
        stateIdsArbitrary(),
        ulidArbitrary(),
        async ([owner, attacker], ids, unknownProjectId) => {
          const { store, adapter } = newStore();
          const base = buildState(owner.userId, ids);
          expect(isOk(await store.createProject(owner, base))).toBe(true);
          const authorizer = createOwnerObjectAuthorizer(adapter);

          // "Not the owner" (project exists, wrong principal) and "unknown
          // project" (nothing stored) must be indistinguishable to the caller:
          // identical error object, so ownership cannot enumerate project ids.
          const notOwner = await authorizer.authorize(attacker, base.project.id);
          const unknown = await authorizer.authorize(attacker, unknownProjectId);
          expect(isErr(notOwner)).toBe(true);
          expect(isErr(unknown)).toBe(true);
          if (isErr(notOwner) && isErr(unknown)) {
            expect(notOwner.error).toStrictEqual(unknown.error);
          }
        },
      ),
      propertyParameters(),
    );
  });

  it('never lets a persist reassign ownership away from the authenticated caller', async () => {
    await fc.assert(
      fc.asyncProperty(
        principalArbitrary(),
        ulidArbitrary(),
        stateIdsArbitrary(),
        async (owner, otherOwnerId, ids) => {
          fc.pre(owner.userId !== otherOwnerId);
          const { store } = newStore();
          const base = buildState(owner.userId, ids);
          expect(isOk(await store.createProject(owner, base))).toBe(true);

          // A persist whose state claims a different owner is refused, so a
          // caller can never hand their project to another principal.
          const reassigned: ProjectState = {
            ...base,
            project: { ...base.project, ownerId: otherOwnerId },
          };
          const denied = await store.persist(owner, reassigned);
          expect(isErr(denied)).toBe(true);
          if (isErr(denied)) {
            expect(denied.error.code).toBe('forbidden');
          }
        },
      ),
      propertyParameters(),
    );
  });
});

// The exact Property 31 tag is asserted here, not only written in a comment:
// `Feature: hdl-creation-loop, Property 31: Per-object authorization on project access and restore`.
describe('Property 31 tag', () => {
  it('uses the canonical feature tag', () => {
    expect(propertyTag(31, 'Per-object authorization on project access and restore')).toBe(
      'Feature: hdl-creation-loop, Property 31: Per-object authorization on project access and restore',
    );
  });
});
