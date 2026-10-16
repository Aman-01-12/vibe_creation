// Property 30 for the Project_Store: crash restore loads only the last consistent
// checkpoint and never auto-re-executes (task 12.3).
//
// This is the universal complement to the concrete examples in
// `project-store.test.ts`. Over generated checkpoint histories in which an
// arbitrary subset of the NEWEST checkpoints are corrupt, plus an optional
// separately-preserved crash Trace and a generated resume request, it asserts the
// guarantees the design binds to Property 30 (Req 16.4, 16.6, 16.7, 16.8, 16.10):
//
//   - Last consistent (16.4, 16.6): `restoreLastConsistentCheckpoint` returns the
//     state of the NEWEST checkpoint whose integrity verifies, and every newer
//     checkpoint that fails integrity is surfaced in `unrecovered` and never
//     loaded.
//   - None consistent (16.7): when every checkpoint is corrupt, `restored` is
//     `null` and `unrecovered` lists them all, newest-first.
//   - No auto-re-execute (16.8, 16.10): the restore is data-only
//     (`autoReExecuted === false`); a resume is blocked without explicit approval,
//     and a side-effectful resume requires a non-empty idempotency key and is
//     authorized at most once per key (a repeated key is duplicate-suppressed).
//   - Crash Trace preserved separately (16.8): a preserved crash Trace is surfaced
//     (`crashTracePreserved`, `interruptedStep` from its last span) and survives
//     the restore rather than being destroyed by it.
//
// A corrupt checkpoint is created deterministically two ways, both generated:
// tampering the stored `integrity` string, and tampering the state after its
// integrity was computed. A fresh store over a fresh in-memory adapter is built
// per run, so every run is fully independent.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  InMemoryStorageAdapter,
  ProjectStore,
  computeStateIntegrity,
  createOwnerObjectAuthorizer,
  verifyCheckpointIntegrity,
  type AuthenticatedPrincipal,
  type Checkpoint,
  type CheckpointReason,
  type ProjectState,
  type ResumeDecision,
} from '@app/api';
import {
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
  type TraceSpan,
  type Ulid,
  type VerificationResult,
} from '@app/core';
import { propertyParameters, propertyTag, timingContractFor } from '@app/test';

// --- Result unwrapping -------------------------------------------------------

/** Unwrap a Result in a test, failing loudly if it is unexpectedly an error. */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) {
    throw new Error(`unexpected error result: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

// --- Domain builders (same approach as project-store.test.ts) ----------------

function principal(userId: Ulid): AuthenticatedPrincipal {
  return { userId, sessionId: newUlid(), scopes: [] };
}

function buildPort(): Port {
  return unwrap(makePort({ name: 'clk', direction: 'input', width: 1 }));
}

function buildSpec(projectId: Ulid, goal: string): Spec {
  const criterion: AcceptanceCriterion = {
    id: newUlid(),
    text: 'counts up on each clock',
    measurable: true,
    method: 'simulation',
  };
  return {
    timingContract: timingContractFor({
      validityOutputName: null,
      moduleName: 'counter',
      ports: [buildPort()],
      clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
    }),
    id: newUlid(),
    projectId,
    goal,
    constraints: ['synchronous reset'],
    moduleInterface: {
      validityOutputName: null,
      moduleName: 'counter',
      ports: [buildPort()],
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

/** A minimal one-span Trace used as the persisted working snapshot's Trace. */
function buildWorkingTrace(): Trace {
  const sessionId = newUlid();
  return {
    sessionId,
    spans: [
      {
        id: newUlid(),
        sessionId,
        seq: 0,
        stageOrTool: 'Spec_Agent',
        sanitizedInputs: { note: 'redacted' },
        outputs: { approved: true },
        exitCode: 0,
        startedAt: '2024-01-01T00:00:01.000Z',
        durationMs: 42,
        retryCount: 0,
        costCents: 1,
      },
    ],
  };
}

/**
 * A fully populated project state for a fixed project/owner, with `goal` varied
 * so distinct checkpoints hold distinct states and the restored state can be
 * matched to the specific checkpoint it came from.
 */
function buildStateFor(projectId: Ulid, ownerId: Ulid, goal: string): ProjectState {
  const spec = buildSpec(projectId, goal);
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
    trace: buildWorkingTrace(),
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

// --- Corruption --------------------------------------------------------------

/** How a checkpoint is corrupted; both make `verifyCheckpointIntegrity` false. */
type CorruptionMethod = 'tamper-integrity' | 'tamper-state';

/**
 * Build a checkpoint whose integrity check fails, deterministically.
 *
 * `tamper-integrity` keeps the honest state but stores a fingerprint that cannot
 * match it; `tamper-state` stores a mutated state under the fingerprint of the
 * original, modelling a partial/corrupt write. Either way the recomputed
 * fingerprint differs from the stored one.
 */
function buildCorruptCheckpoint(
  id: Ulid,
  projectId: Ulid,
  seq: number,
  reason: CheckpointReason,
  createdAt: string,
  state: ProjectState,
  method: CorruptionMethod,
): Checkpoint {
  if (method === 'tamper-integrity') {
    // A guaranteed-mismatching fingerprint: the honest hex digest with an extra
    // character appended can never equal the 64-char digest recomputed on read.
    return {
      id,
      projectId,
      seq,
      reason,
      createdAt,
      state,
      integrity: `${computeStateIntegrity(state)}0`,
    };
  }
  // tamper-state: fingerprint the ORIGINAL, then store a mutated state under it.
  const honestIntegrity = computeStateIntegrity(state);
  const tamperedState: ProjectState = {
    ...state,
    spec: state.spec === null ? null : { ...state.spec, goal: `${state.spec.goal} TAMPERED` },
  };
  return {
    id,
    projectId,
    seq,
    reason,
    createdAt,
    state: tamperedState,
    integrity: honestIntegrity,
  };
}

/** Build an honest, integrity-consistent checkpoint. */
function buildGoodCheckpoint(
  id: Ulid,
  projectId: Ulid,
  seq: number,
  reason: CheckpointReason,
  createdAt: string,
  state: ProjectState,
): Checkpoint {
  return { id, projectId, seq, reason, createdAt, state, integrity: computeStateIntegrity(state) };
}

// --- Generators --------------------------------------------------------------

/** The generated shape of one checkpoint in the history. */
interface CheckpointPlan {
  readonly good: boolean;
  readonly reason: CheckpointReason;
  readonly method: CorruptionMethod;
}

function checkpointPlanArbitrary(): fc.Arbitrary<CheckpointPlan> {
  return fc.record<CheckpointPlan>({
    good: fc.boolean(),
    reason: fc.constantFrom<CheckpointReason>('spec-approved', 'verified'),
    method: fc.constantFrom<CorruptionMethod>('tamper-integrity', 'tamper-state'),
  });
}

/** A crash Trace with a non-empty, ordered span list; its last span is the interrupted step. */
function crashTraceArbitrary(): fc.Arbitrary<Trace> {
  return fc.uniqueArray(newUlidArbitrary(), { minLength: 1, maxLength: 4 }).chain((spanIds) => {
    const sessionId = newUlid();
    return fc
      .array(fc.constantFrom('Generation_Agent', 'Simulator', 'Verification_Loop'), {
        minLength: spanIds.length,
        maxLength: spanIds.length,
      })
      .map((stages): Trace => {
        const spans: TraceSpan[] = spanIds.map((id, index) => ({
          id,
          sessionId,
          seq: index,
          stageOrTool: stages[index] ?? 'Simulator',
          sanitizedInputs: { step: index },
          outputs: { ok: true },
          exitCode: 0,
          startedAt: '2024-01-01T00:00:03.000Z',
          durationMs: 10,
          retryCount: 0,
          costCents: 1,
        }));
        return { sessionId, spans };
      });
  });
}

/** A fresh, syntactically valid ULID as a fast-check arbitrary. */
function newUlidArbitrary(): fc.Arbitrary<Ulid> {
  return fc.constant(null).map(() => newUlid());
}

/** The generated resume request plus whether it is expected to be authorized once. */
interface ResumePlan {
  readonly approved: boolean;
  readonly sideEffectful: boolean;
  readonly idempotencyKey: string;
}

function resumePlanArbitrary(): fc.Arbitrary<ResumePlan> {
  const blankKey = fc.constantFrom('', '   ', '\t', '\n ');
  const realKey = fc
    .string({ minLength: 1, maxLength: 16 })
    .filter((value) => value.trim().length > 0);
  return fc.record<ResumePlan>({
    approved: fc.boolean(),
    sideEffectful: fc.boolean(),
    idempotencyKey: fc.oneof(blankKey, realKey),
  });
}

/** The full generated scenario for one run. */
interface Scenario {
  readonly plans: readonly CheckpointPlan[];
  readonly crashTrace: Trace | null;
  readonly resume: ResumePlan;
}

function scenarioArbitrary(): fc.Arbitrary<Scenario> {
  return fc.record<Scenario>({
    plans: fc.array(checkpointPlanArbitrary(), { minLength: 1, maxLength: 8 }),
    crashTrace: fc.option(crashTraceArbitrary(), { nil: null }),
    resume: resumePlanArbitrary(),
  });
}

// --- Materialized checkpoint (plan + concrete ids/state) ---------------------

interface MaterializedCheckpoint {
  readonly id: Ulid;
  readonly seq: number;
  readonly reason: CheckpointReason;
  readonly good: boolean;
  readonly createdAt: string;
}

/** The decision the resume gate must reach for a given plan, before any call. */
function expectedFirstDecisionKind(plan: ResumePlan): ResumeDecision['kind'] {
  if (!plan.approved) {
    return 'blocked-needs-approval';
  }
  if (!plan.sideEffectful) {
    return 'authorized-to-resume';
  }
  if (plan.idempotencyKey.trim().length === 0) {
    return 'blocked-needs-idempotency-key';
  }
  return 'authorized-to-resume';
}

// --- The property ------------------------------------------------------------

describe('Project_Store crash restore (Property 30)', () => {
  // Feature: hdl-creation-loop, Property 30: Crash restore loads only the last consistent checkpoint and never auto-re-executes
  it('loads the newest consistent checkpoint, surfaces newer corrupt ones, and never auto-re-executes', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary(), async ({ plans, crashTrace, resume }) => {
        // Fresh store + adapter per run: full independence between runs.
        const { store, adapter } = newStore();
        const owner = principal(newUlid());
        const projectId = newUlid();

        // Establish ownership + a working snapshot (which crash restore ignores:
        // it always resolves from checkpoints, never the working state).
        expect(
          isOk(await store.createProject(owner, buildStateFor(projectId, owner.userId, 'working'))),
        ).toBe(true);

        // Append the generated checkpoint history seq 0..N-1 (oldest -> newest),
        // honest or corrupt per plan, directly through the adapter so reasons and
        // integrity are controlled rather than milestone-validated.
        const materialized: MaterializedCheckpoint[] = [];
        for (let index = 0; index < plans.length; index += 1) {
          const plan = plans[index];
          if (plan === undefined) {
            continue;
          }
          const id = newUlid();
          const createdAt = new Date(1_700_000_000_000 + index * 1000).toISOString();
          const state = buildStateFor(projectId, owner.userId, `checkpoint-${index}`);
          const checkpoint = plan.good
            ? buildGoodCheckpoint(id, projectId, index, plan.reason, createdAt, state)
            : buildCorruptCheckpoint(
                id,
                projectId,
                index,
                plan.reason,
                createdAt,
                state,
                plan.method,
              );

          // Non-vacuous: the intended integrity outcome actually holds.
          expect(verifyCheckpointIntegrity(checkpoint)).toBe(plan.good);

          await adapter.appendCheckpoint(checkpoint);
          materialized.push({ id, seq: index, reason: plan.reason, good: plan.good, createdAt });
        }

        // Preserve the crash Trace separately, when one was generated.
        if (crashTrace !== null) {
          expect(isOk(await store.preserveCrashTrace(owner, projectId, crashTrace))).toBe(true);
        }

        const outcome = unwrap(await store.restoreLastConsistentCheckpoint(owner, projectId));

        // No auto-re-execute holds unconditionally (Req 16.8, 16.10).
        expect(outcome.autoReExecuted).toBe(false);

        // Expected selection: the newest good checkpoint, or none.
        const newestGood = [...materialized].reverse().find((cp) => cp.good) ?? null;
        const expectedUnrecovered = materialized
          .filter((cp) => (newestGood === null ? true : cp.seq > newestGood.seq))
          .sort((a, b) => b.seq - a.seq);

        if (newestGood === null) {
          // None consistent (Req 16.7): nothing restored, all corrupt surfaced.
          expect(outcome.restored).toBeNull();
          expect(outcome.restoredCheckpointId).toBeNull();
          expect(outcome.restoredReason).toBeNull();
        } else {
          // Last consistent (Req 16.4, 16.6): the newest integrity-verified one.
          expect(outcome.restoredCheckpointId).toBe(newestGood.id);
          expect(outcome.restoredReason).toBe(newestGood.reason);
          expect(outcome.restored).not.toBeNull();
          // The loaded state matches the winning checkpoint (its goal is unique).
          expect(outcome.restored?.spec?.goal).toBe(`checkpoint-${newestGood.seq}`);
        }

        // Unrecovered lists exactly the newer corrupt checkpoints, newest-first,
        // each with the sanitized fixed cause and never the restored one.
        expect(outcome.unrecovered.map((u) => u.checkpointId)).toStrictEqual(
          expectedUnrecovered.map((cp) => cp.id),
        );
        outcome.unrecovered.forEach((entry, position) => {
          const expectedEntry = expectedUnrecovered[position];
          expect(expectedEntry).toBeDefined();
          expect(entry.reason).toBe(expectedEntry?.reason);
          expect(entry.createdAt).toBe(expectedEntry?.createdAt);
          expect(entry.cause).toBe('integrity-check-failed');
        });
        if (outcome.restoredCheckpointId !== null) {
          expect(outcome.unrecovered.map((u) => u.checkpointId)).not.toContain(
            outcome.restoredCheckpointId,
          );
        }

        // Crash Trace preserved separately (Req 16.8): surfaced, and not destroyed.
        if (crashTrace === null) {
          expect(outcome.crashTracePreserved).toBe(false);
          expect(outcome.interruptedStep).toBeNull();
        } else {
          const lastSpan = crashTrace.spans[crashTrace.spans.length - 1];
          expect(outcome.crashTracePreserved).toBe(true);
          expect(outcome.interruptedStep).not.toBeNull();
          expect(outcome.interruptedStep?.spanId).toBe(lastSpan?.id);
          expect(outcome.interruptedStep?.stageOrTool).toBe(lastSpan?.stageOrTool);
          expect(outcome.interruptedStep?.seq).toBe(lastSpan?.seq);
          // The restore did not consume/destroy the separately preserved Trace.
          expect(await adapter.loadCrashTrace(projectId)).toStrictEqual(crashTrace);
        }

        // No auto-re-execute resume gate (Req 16.8): the decision matches the
        // approval + idempotency rules, and a side-effectful key is at-most-once.
        const request = {
          projectId,
          approved: resume.approved,
          sideEffectful: resume.sideEffectful,
          idempotencyKey: resume.idempotencyKey,
        };
        const first = unwrap(await store.resumeInterruptedStep(owner, request));
        expect(first.kind).toBe(expectedFirstDecisionKind(resume));

        if (resume.approved && resume.sideEffectful && resume.idempotencyKey.trim().length > 0) {
          // A repeat with the same key grants no second side effect.
          const second = unwrap(await store.resumeInterruptedStep(owner, request));
          expect(second.kind).toBe('duplicate-suppressed');
        }
      }),
      propertyParameters(),
    );
  });
});

// Referenced so the exact Property 30 tag is asserted, not just written in a
// comment above.
describe('Property 30 tag', () => {
  it('uses the canonical feature tag', () => {
    expect(
      propertyTag(
        30,
        'Crash restore loads only the last consistent checkpoint and never auto-re-executes',
      ),
    ).toBe(
      'Feature: hdl-creation-loop, Property 30: Crash restore loads only the last consistent checkpoint and never auto-re-executes',
    );
  });
});
