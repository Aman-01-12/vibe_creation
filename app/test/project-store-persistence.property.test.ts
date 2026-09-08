// Property 29: Project state round-trips through persistence (task 12.2).
//
// This is the universal complement to the example checks in `project-store.test.ts`.
// It asserts, over many generated well-formed `ProjectState`s owned by a
// principal, the guarantees the Project_Store persistence seam must never break
// (Design: Property 29; Req 5.7, 16.2, 16.3):
//
//   1. Round-trip fidelity: for any well-formed state (Spec present/absent, a
//      varying sources list, Testbench present/absent, latest verification result
//      present/absent as a passing or failing result, and a Trace with varying
//      spans), `createProject` then `restore` returns a state DEEP-EQUAL to what
//      was persisted, and `persist` of an updated state then `restore` returns the
//      updated state (Req 16.2, 16.3).
//   2. Independence: mutating the state handed back by `restore` never corrupts
//      the stored copy - a second `restore` still yields the original, because the
//      adapter clones on the way out (Req 16.2).
//   3. Checkpoint fallback: when no working snapshot exists but a consistent
//      checkpoint does, `restore` returns the checkpoint's state, and that
//      checkpoint passes its integrity check (Req 16.3).
//
// Every state is exercised against a FRESH `InMemoryStorageAdapter` + `ProjectStore`
// per run, so no run can observe another's state.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  InMemoryStorageAdapter,
  ProjectStore,
  createOwnerObjectAuthorizer,
  verifyCheckpointIntegrity,
  type AuthenticatedPrincipal,
  type ProjectState,
} from '@app/api';
import {
  isOk,
  makePort,
  makeTestbench,
  makeVerificationResult,
  newUlid,
  type AcceptanceCriterion,
  type AcceptanceMethod,
  type BudgetStopReason,
  type ClockingContract,
  type FailingCase,
  type FailureClass,
  type Json,
  type ModuleVersion,
  type Port,
  type PortDirection,
  type Project,
  type Spec,
  type Testbench,
  type Trace,
  type TraceSpan,
  type Ulid,
  type VerificationResult,
} from '@app/core';
import { propertyParameters, propertyTag } from '@app/test';

const PROPERTY = propertyTag(29, 'Project state round-trips through persistence');

// -- Result helper ----------------------------------------------------------

/** Unwrap a Result in a test, failing loudly if it is unexpectedly an error. */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) {
    throw new Error(`unexpected error result: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

// -- Primitive generators ---------------------------------------------------

/** Crockford base32 alphabet used by ULIDs (excludes I, L, O, U). */
const CROCKFORD_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.split('');
/** The valid first-character set for a 48-bit ULID timestamp (0-7). */
const ULID_HEAD_CHARS = '01234567'.split('');
/** ASCII identifier characters for names that must be non-empty, non-whitespace. */
const IDENT_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('');

/** A syntactically valid, deterministically shrinkable 26-char ULID. */
function ulidArbitrary(): fc.Arbitrary<Ulid> {
  return fc
    .tuple(
      fc.constantFrom(...ULID_HEAD_CHARS),
      fc.array(fc.constantFrom(...CROCKFORD_CHARS), { minLength: 25, maxLength: 25 }),
    )
    .map(([head, rest]) => `${head}${rest.join('')}`);
}

/** A non-empty, non-whitespace ASCII identifier suitable for signal/module names. */
function identifierArbitrary(maxLength = 12): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...IDENT_CHARS), { minLength: 1, maxLength: maxLength })
    .map((chars) => chars.join(''));
}

/** An ISO-8601 timestamp drawn from epoch..~year 2100. */
function isoTimestampArbitrary(): fc.Arbitrary<string> {
  return fc.integer({ min: 0, max: 4_102_444_800_000 }).map((ms) => new Date(ms).toISOString());
}

/** A bounded, JSON-compatible value for sanitized span inputs/outputs. */
function jsonArbitrary(): fc.Arbitrary<Json> {
  const { json } = fc.letrec<{ json: Json }>((tie) => ({
    json: fc.oneof(
      { maxDepth: 2 },
      fc.constant(null),
      fc.boolean(),
      fc.integer(),
      fc.string({ maxLength: 12 }),
      fc.array(tie('json'), { maxLength: 3 }),
      // Keys are short (<= 6 chars) so no key can be `__proto__` (9 chars).
      fc.dictionary(fc.string({ minLength: 1, maxLength: 6 }), tie('json'), { maxKeys: 3 }),
    ),
  }));
  return json;
}

// -- Domain generators ------------------------------------------------------

/** A valid `Port` built through the sole supported constructor. */
function portArbitrary(): fc.Arbitrary<Port> {
  return fc
    .record({
      name: identifierArbitrary(8),
      direction: fc.constantFrom<PortDirection>('input', 'output', 'inout'),
      width: fc.integer({ min: 1, max: 64 }),
    })
    .map((input) => unwrap(makePort(input)));
}

/** A clocking contract, possibly combinational (null clock) and/or reset-less. */
function clockingArbitrary(): fc.Arbitrary<ClockingContract> {
  return fc.record({
    clockName: fc.option(identifierArbitrary(8), { nil: null }),
    resetName: fc.option(identifierArbitrary(8), { nil: null }),
    resetActiveLow: fc.boolean(),
  });
}

/** One acceptance criterion, measurable or flagged. */
function criterionArbitrary(): fc.Arbitrary<AcceptanceCriterion> {
  return fc.record({
    id: ulidArbitrary(),
    text: fc.string({ maxLength: 40 }),
    measurable: fc.boolean(),
    method: fc.constantFrom<AcceptanceMethod>('simulation', 'formal', 'manual-inspection'),
  });
}

/** A Spec for the given project; `approved` is forced when supplied. */
function specArbitrary(projectId: Ulid, approved?: boolean): fc.Arbitrary<Spec> {
  return fc
    .record({
      id: ulidArbitrary(),
      goal: fc.string({ maxLength: 40 }),
      constraints: fc.array(fc.string({ maxLength: 20 }), { maxLength: 3 }),
      moduleInterface: fc.record({
        moduleName: identifierArbitrary(),
        ports: fc.array(portArbitrary(), { maxLength: 4 }),
        clocking: clockingArbitrary(),
      }),
      acceptanceCriteria: fc.array(criterionArbitrary(), { maxLength: 3 }),
      architecture: fc.string({ maxLength: 40 }),
      approved: approved === undefined ? fc.boolean() : fc.constant(approved),
      version: fc.integer({ min: 1, max: 10 }),
    })
    .map((fields) => ({ ...fields, projectId }));
}

/** A generated module version (RTL source) for the given project. */
function moduleVersionArbitrary(projectId: Ulid): fc.Arbitrary<ModuleVersion> {
  return fc
    .record({
      id: ulidArbitrary(),
      specVersion: fc.integer({ min: 1, max: 10 }),
      rtl: fc.string({ maxLength: 40 }),
      createdAt: isoTimestampArbitrary(),
    })
    .map((fields) => ({ ...fields, projectId }));
}

/** A Testbench built through its constructor (attribution is always `spec`). */
function testbenchArbitrary(): fc.Arbitrary<Testbench> {
  return fc
    .record({
      id: ulidArbitrary(),
      specId: ulidArbitrary(),
      specVersion: fc.integer({ min: 1, max: 10 }),
      source: fc.string({ maxLength: 40 }),
      coversCriteria: fc.array(ulidArbitrary(), { maxLength: 3 }),
    })
    .map(makeTestbench);
}

/** The concrete failing case attached to a non-passing result. */
function failingCaseArbitrary(): fc.Arbitrary<FailingCase> {
  return fc.record({
    checkName: fc.string({ maxLength: 16 }),
    description: fc.string({ maxLength: 24 }),
    expected: fc.string({ maxLength: 12 }),
    observed: fc.string({ maxLength: 12 }),
    atSimTimeNs: fc.option(fc.integer({ min: 0, max: 100_000 }), { nil: null }),
  });
}

/** A passing verification result (all checks passed, with an oracle span). */
function passingResultArbitrary(): fc.Arbitrary<VerificationResult> {
  return fc
    .record({
      id: ulidArbitrary(),
      moduleVersionId: ulidArbitrary(),
      testbenchId: ulidArbitrary(),
      iterations: fc.integer({ min: 0, max: 20 }),
      costCents: fc.integer({ min: 0, max: 1000 }),
      oracleSpanId: ulidArbitrary(),
    })
    .map((fields) =>
      unwrap(makeVerificationResult({ ...fields, verdict: 'pass', allChecksPassed: true })),
    );
}

/** A non-passing verification result (fail/error, optional failing case + stop). */
function failingResultArbitrary(): fc.Arbitrary<VerificationResult> {
  return fc
    .record({
      id: ulidArbitrary(),
      moduleVersionId: ulidArbitrary(),
      testbenchId: ulidArbitrary(),
      verdict: fc.constantFrom<'fail' | 'error'>('fail', 'error'),
      iterations: fc.integer({ min: 0, max: 20 }),
      costCents: fc.integer({ min: 0, max: 1000 }),
      oracleSpanId: ulidArbitrary(),
      failingCase: fc.option(failingCaseArbitrary(), { nil: null }),
      stopReason: fc.option(
        fc.constantFrom<BudgetStopReason>(
          'max-iterations',
          'max-tokens',
          'max-wall-clock',
          'max-cost',
        ),
        { nil: null },
      ),
    })
    .map((fields) => {
      // Add the optional inputs only when present, so no key is ever explicitly
      // `undefined` (required under exactOptionalPropertyTypes).
      const { failingCase, stopReason, ...base } = fields;
      const withFailing = failingCase === null ? base : { ...base, failingCase };
      const input = stopReason === null ? withFailing : { ...withFailing, stopReason };
      return unwrap(makeVerificationResult({ ...input, allChecksPassed: false }));
    });
}

/** Either a passing or a non-passing verification result. */
function verificationResultArbitrary(): fc.Arbitrary<VerificationResult> {
  return fc.oneof(passingResultArbitrary(), failingResultArbitrary());
}

/** One trace span; optional fields are added only when present (never `undefined`). */
function traceSpanArbitrary(sessionId: Ulid, seq: number): fc.Arbitrary<TraceSpan> {
  return fc
    .record({
      id: ulidArbitrary(),
      stageOrTool: identifierArbitrary(),
      sanitizedInputs: jsonArbitrary(),
      outputs: jsonArbitrary(),
      exitCode: fc.option(fc.integer({ min: -1, max: 255 }), { nil: null }),
      startedAt: isoTimestampArbitrary(),
      durationMs: fc.integer({ min: 0, max: 100_000 }),
      retryCount: fc.integer({ min: 0, max: 5 }),
      costCents: fc.integer({ min: 0, max: 1000 }),
      failureClass: fc.option(
        fc.constantFrom<FailureClass>(
          'compile-error',
          'functional-fail',
          'timeout',
          'tool-error',
          'sandbox-denied',
        ),
        { nil: null },
      ),
      recoveryOf: fc.option(ulidArbitrary(), { nil: null }),
    })
    .map((fields) => {
      const { failureClass, recoveryOf, ...base } = fields;
      let span: TraceSpan = { ...base, sessionId, seq };
      if (failureClass !== null) {
        span = { ...span, failureClass };
      }
      if (recoveryOf !== null) {
        span = { ...span, recoveryOf };
      }
      return span;
    });
}

/** A trace with a varying number of ordered spans (possibly empty). */
function traceArbitrary(): fc.Arbitrary<Trace> {
  return ulidArbitrary().chain((sessionId) =>
    fc
      .integer({ min: 0, max: 4 })
      .chain((count) =>
        fc
          .tuple(...Array.from({ length: count }, (_, seq) => traceSpanArbitrary(sessionId, seq)))
          .map((spans) => ({ sessionId, spans })),
      ),
  );
}

/** A well-formed `ProjectState` bound to the given owner and project id. */
function projectStateArbitrary(ownerId: Ulid, projectId: Ulid): fc.Arbitrary<ProjectState> {
  return fc
    .record({
      createdAt: isoTimestampArbitrary(),
      updatedAt: isoTimestampArbitrary(),
      specId: fc.option(ulidArbitrary(), { nil: null }),
      currentModuleVersionId: fc.option(ulidArbitrary(), { nil: null }),
      spec: fc.option(specArbitrary(projectId), { nil: null }),
      sources: fc.array(moduleVersionArbitrary(projectId), { maxLength: 3 }),
      testbench: fc.option(testbenchArbitrary(), { nil: null }),
      latestVerificationResult: fc.option(verificationResultArbitrary(), { nil: null }),
      trace: traceArbitrary(),
    })
    .map((fields): ProjectState => {
      const project: Project = {
        id: projectId,
        ownerId,
        createdAt: fields.createdAt,
        updatedAt: fields.updatedAt,
        specId: fields.specId,
        currentModuleVersionId: fields.currentModuleVersionId,
      };
      return {
        project,
        spec: fields.spec,
        sources: fields.sources,
        testbench: fields.testbench,
        latestVerificationResult: fields.latestVerificationResult,
        trace: fields.trace,
      };
    });
}

/** An owner id paired with a state that owner owns. */
function ownedStateArbitrary(): fc.Arbitrary<{ ownerId: Ulid; state: ProjectState }> {
  return fc
    .tuple(ulidArbitrary(), ulidArbitrary())
    .chain(([ownerId, projectId]) =>
      projectStateArbitrary(ownerId, projectId).map((state) => ({ ownerId, state })),
    );
}

/** An owner id plus two states for the same project (initial and updated). */
function ownedStatePairArbitrary(): fc.Arbitrary<{
  ownerId: Ulid;
  state: ProjectState;
  updated: ProjectState;
}> {
  return fc
    .tuple(ulidArbitrary(), ulidArbitrary())
    .chain(([ownerId, projectId]) =>
      fc
        .tuple(projectStateArbitrary(ownerId, projectId), projectStateArbitrary(ownerId, projectId))
        .map(([state, updated]) => ({ ownerId, state, updated })),
    );
}

/** An owner id plus a state carrying an APPROVED spec (for the checkpoint path). */
function ownedApprovedStateArbitrary(): fc.Arbitrary<{ ownerId: Ulid; state: ProjectState }> {
  return fc.tuple(ulidArbitrary(), ulidArbitrary()).chain(([ownerId, projectId]) =>
    fc
      .tuple(projectStateArbitrary(ownerId, projectId), specArbitrary(projectId, true))
      .map(([state, approvedSpec]) => ({
        ownerId,
        state: { ...state, spec: approvedSpec },
      })),
  );
}

// -- Fixtures ---------------------------------------------------------------

/** An authenticated principal for the given user id; only `userId` is checked. */
function principal(userId: Ulid): AuthenticatedPrincipal {
  return { userId, sessionId: newUlid(), scopes: [] };
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

// -- Properties -------------------------------------------------------------

describe(PROPERTY, () => {
  it('round-trips any well-formed project state through create then restore', async () => {
    await fc.assert(
      fc.asyncProperty(ownedStateArbitrary(), async ({ ownerId, state }) => {
        const { store } = newStore();
        const owner = principal(ownerId);

        expect(isOk(await store.createProject(owner, state))).toBe(true);
        const restored = unwrap(await store.restore(owner, state.project.id));

        expect(restored).toEqual(state);
      }),
      propertyParameters(),
    );
  });

  it('round-trips an updated state through persist then restore', async () => {
    await fc.assert(
      fc.asyncProperty(ownedStatePairArbitrary(), async ({ ownerId, state, updated }) => {
        const { store } = newStore();
        const owner = principal(ownerId);

        expect(isOk(await store.createProject(owner, state))).toBe(true);
        expect(isOk(await store.persist(owner, updated))).toBe(true);
        const restored = unwrap(await store.restore(owner, state.project.id));

        expect(restored).toEqual(updated);
      }),
      propertyParameters(),
    );
  });

  it('clones on the way out: mutating a restored state never corrupts the stored copy', async () => {
    await fc.assert(
      fc.asyncProperty(ownedStateArbitrary(), async ({ ownerId, state }) => {
        const { store } = newStore();
        const owner = principal(ownerId);
        expect(isOk(await store.createProject(owner, state))).toBe(true);

        // Mutate the returned copy in place (the type is deeply readonly; this
        // reaches through it to prove the runtime object is an independent clone).
        const first = unwrap(await store.restore(owner, state.project.id));
        const mutable = first as unknown as {
          project: { updatedAt: string };
          sources: unknown[];
          trace: { spans: unknown[] };
        };
        mutable.project.updatedAt = 'CORRUPTED';
        mutable.sources.push({ tampered: true });
        mutable.trace.spans.push({ tampered: true });

        const second = unwrap(await store.restore(owner, state.project.id));
        expect(second).toEqual(state);
      }),
      propertyParameters(),
    );
  });

  it('falls back to the last consistent checkpoint when no working snapshot exists', async () => {
    await fc.assert(
      fc.asyncProperty(ownedApprovedStateArbitrary(), async ({ ownerId, state }) => {
        const owner = principal(ownerId);

        // Produce a real durable checkpoint on one adapter (via the store API).
        const sourceAdapter = new InMemoryStorageAdapter();
        const sourceStore = new ProjectStore({
          adapter: sourceAdapter,
          authorizer: createOwnerObjectAuthorizer(sourceAdapter),
        });
        expect(isOk(await sourceStore.createProject(owner, state))).toBe(true);
        const checkpoint = unwrap(await sourceStore.checkpointOnSpecApproval(owner, state));

        // A FRESH adapter holds only that checkpoint - no working snapshot - so a
        // restore must fall back to the checkpoint's state (Req 16.3).
        const restoreAdapter = new InMemoryStorageAdapter();
        await restoreAdapter.appendCheckpoint(checkpoint);
        const restoreStore = new ProjectStore({
          adapter: restoreAdapter,
          authorizer: createOwnerObjectAuthorizer(restoreAdapter),
        });

        const restored = unwrap(await restoreStore.restore(owner, state.project.id));
        expect(restored).toEqual(state);
        expect(verifyCheckpointIntegrity(checkpoint)).toBe(true);
      }),
      propertyParameters(),
    );
  });
});
