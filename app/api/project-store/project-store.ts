// The Project_Store: durable persistence, crash restore, and no-auto-re-execute
// (Req 5.7, 16.1-16.10; Design: Cross-cutting components (Project_Store), Error
// Handling).
//
// This orchestrates the single `StorageAdapter` seam. It:
//   - persists the working snapshot (the reopen source of truth) and writes a
//     durable checkpoint on Spec approval and on reaching `Verified` (Req 16.1,
//     16.2, 5.7);
//   - reopens the last persisted snapshot, falling back to the last consistent
//     checkpoint when no working snapshot exists (Req 16.3);
//   - on crash, restores ONLY the last integrity-checked checkpoint, falling back
//     to the previous valid one and surfacing what could not be recovered, and
//     reads the crash Trace that was preserved separately (Req 16.4, 16.6, 16.7,
//     16.10);
//   - NEVER auto-re-executes: `restoreLastConsistentCheckpoint` returns data only
//     (`autoReExecuted` is the literal `false`); a side-effectful resume requires
//     explicit approval PLUS a non-empty idempotency key, guarded to at-most-once
//     per key (Req 16.8, 16.10).
//
// Per-object authorization is enforced on EVERY access and on automatic restore,
// decided by the injected `ObjectAuthorizer` from the validated principal claim
// (Req 16.5, 16.9). No method touches stored state before its ownership check
// passes; `createProject` is the sole bootstrap and instead binds ownership to
// the authenticated principal directly.

import { err, isErr, newUlid, ok, type Result, type Trace, type Ulid } from '@app/core';

import type { AuthenticatedPrincipal } from '../gateway/auth.js';
import { authorizeObject, type ObjectAuthorizer } from '../gateway/authorize-object.js';
import { gatewayError, type GatewayError } from '../gateway/errors.js';

import { computeStateIntegrity, verifyCheckpointIntegrity } from './integrity.js';
import {
  type Checkpoint,
  type CheckpointReason,
  type ProjectState,
  type StorageAdapter,
} from './storage-adapter.js';

/** Newest-first keyset page size for the restore walk over checkpoints. */
const RESTORE_PAGE_SIZE = 25;

/** A checkpoint that failed its integrity check and could not be recovered (Req 16.7). */
export interface UnrecoverableCheckpoint {
  readonly checkpointId: Ulid;
  readonly reason: CheckpointReason;
  readonly createdAt: string;
  /** A fixed, sanitized cause; carries no internal detail. */
  readonly cause: 'integrity-check-failed';
}

/** The in-flight step surfaced from the crash Trace for the Student to resume (Req 16.8). */
export interface InterruptedStep {
  readonly spanId: Ulid;
  readonly stageOrTool: string;
  readonly seq: number;
}

/**
 * The outcome of an automatic crash restore.
 *
 * `autoReExecuted` is the literal `false`: a compile-time promise that this path
 * never re-runs the interrupted work (Req 16.8, 16.10). `restored` is `null` when
 * no checkpoint passed its integrity check; `unrecovered` then lists every
 * checkpoint that was skipped for failing integrity (Req 16.7). `interruptedStep`
 * is offered for an explicit, Student-approved resume.
 */
export interface RestoreOutcome {
  readonly restored: ProjectState | null;
  readonly restoredCheckpointId: Ulid | null;
  readonly restoredReason: CheckpointReason | null;
  readonly unrecovered: readonly UnrecoverableCheckpoint[];
  readonly interruptedStep: InterruptedStep | null;
  readonly crashTracePreserved: boolean;
  readonly autoReExecuted: false;
}

/** A request to resume an interrupted step after a crash (Req 16.8). */
export interface ResumeRequest {
  readonly projectId: Ulid;
  /** Explicit Student approval; a resume is blocked unless this is `true`. */
  readonly approved: boolean;
  /** Whether resuming this step causes an external side effect. */
  readonly sideEffectful: boolean;
  /** Idempotency key that makes a side-effectful resume at-most-once. */
  readonly idempotencyKey: string;
}

/**
 * The decision for a resume request.
 *
 * A side-effectful resume is authorized at most once per idempotency key: the
 * first request with a fresh key is `authorized-to-resume`, and any repeat with
 * the same key is `duplicate-suppressed`, so a timeout or double submit can never
 * trigger a second side effect (Req 16.8).
 */
export type ResumeDecision =
  | { readonly kind: 'blocked-needs-approval' }
  | { readonly kind: 'blocked-needs-idempotency-key' }
  | { readonly kind: 'authorized-to-resume' }
  | { readonly kind: 'duplicate-suppressed' };

/** Collaborators injected when the Project_Store is composed. */
export interface ProjectStoreDeps {
  readonly adapter: StorageAdapter;
  readonly authorizer: ObjectAuthorizer;
  /** ISO-8601 clock; injectable for deterministic tests. Defaults to wall clock. */
  readonly now?: () => string;
  /** Checkpoint id factory; injectable for deterministic tests. Defaults to ULID. */
  readonly newCheckpointId?: () => Ulid;
}

/** Result of the internal newest-first walk for the last consistent checkpoint. */
interface ConsistentCheckpointSearch {
  readonly consistent: Checkpoint | null;
  readonly unrecoverable: UnrecoverableCheckpoint[];
}

/** Deep, independent copy of a JSON-shaped snapshot (structured clone of plain data). */
function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Derive the interrupted step from the last recorded span of a crash Trace. */
function interruptedStepOf(trace: Trace): InterruptedStep | null {
  const span = trace.spans.at(-1);
  if (span === undefined) {
    return null;
  }
  return { spanId: span.id, stageOrTool: span.stageOrTool, seq: span.seq };
}

/** The durable, per-object-authorized Project_Store over a storage adapter. */
export class ProjectStore {
  readonly #adapter: StorageAdapter;
  readonly #authorizer: ObjectAuthorizer;
  readonly #now: () => string;
  readonly #newCheckpointId: () => Ulid;

  constructor(deps: ProjectStoreDeps) {
    this.#adapter = deps.adapter;
    this.#authorizer = deps.authorizer;
    this.#now = deps.now ?? (() => new Date().toISOString());
    this.#newCheckpointId = deps.newCheckpointId ?? newUlid;
  }

  /**
   * Create a project, binding its ownership to the authenticated principal.
   *
   * This is the ownership bootstrap every later authorization reads from, so it
   * cannot use the owner check itself. Instead it requires the claimed `ownerId`
   * to match the principal and refuses to overwrite a project id already owned by
   * someone else, so it can neither be used to plant a project for another user
   * nor to hijack an existing one.
   */
  async createProject(
    principal: AuthenticatedPrincipal,
    state: ProjectState,
  ): Promise<Result<void, GatewayError>> {
    if (state.project.ownerId !== principal.userId) {
      return err(gatewayError('forbidden', 'cannot create a project owned by another principal'));
    }
    const existingOwner = await this.#adapter.findOwnerId(state.project.id);
    if (existingOwner !== null && existingOwner !== principal.userId) {
      return err(gatewayError('forbidden', 'project id is already owned by another principal'));
    }
    await this.#adapter.saveProjectState(state);
    return ok(undefined);
  }

  /**
   * Persist the latest working snapshot (the reopen source of truth); authorized.
   *
   * Rejects a snapshot whose `ownerId` differs from the principal so a persist can
   * never reassign ownership away from the caller, in addition to the per-object
   * ownership check on the existing project.
   */
  async persist(
    principal: AuthenticatedPrincipal,
    state: ProjectState,
  ): Promise<Result<void, GatewayError>> {
    if (state.project.ownerId !== principal.userId) {
      return err(gatewayError('forbidden', 'cannot persist a project owned by another principal'));
    }
    const guard = await this.#ensureOwner(principal, state.project.id);
    if (isErr(guard)) {
      return guard;
    }
    await this.#adapter.saveProjectState(state);
    return ok(undefined);
  }

  /**
   * Write a durable checkpoint on Spec approval (Req 16.1); authorized.
   *
   * Refuses to record a `spec-approved` checkpoint unless the snapshot actually
   * carries an approved Spec, so the checkpoint reason can never misrepresent the
   * milestone it claims (Req 5.7).
   */
  async checkpointOnSpecApproval(
    principal: AuthenticatedPrincipal,
    state: ProjectState,
  ): Promise<Result<Checkpoint, GatewayError>> {
    const guard = await this.#ensureOwner(principal, state.project.id);
    if (isErr(guard)) {
      return guard;
    }
    if (state.spec === null || !state.spec.approved) {
      return err(
        gatewayError('schema_invalid', 'a spec-approved checkpoint requires an approved spec'),
      );
    }
    return this.#appendCheckpoint(state, 'spec-approved');
  }

  /**
   * Write a durable checkpoint on reaching `Verified` (Req 16.1); authorized.
   *
   * Refuses to record a `verified` checkpoint unless the snapshot carries a
   * passing verification result with every check passed, so a `verified`
   * checkpoint always corresponds to a real passing oracle verdict (Req 8.10).
   */
  async checkpointOnVerified(
    principal: AuthenticatedPrincipal,
    state: ProjectState,
  ): Promise<Result<Checkpoint, GatewayError>> {
    const guard = await this.#ensureOwner(principal, state.project.id);
    if (isErr(guard)) {
      return guard;
    }
    const result = state.latestVerificationResult;
    if (result === null || result.verdict !== 'pass' || !result.allChecksPassed) {
      return err(
        gatewayError(
          'schema_invalid',
          'a verified checkpoint requires a passing verification result',
        ),
      );
    }
    return this.#appendCheckpoint(state, 'verified');
  }

  /**
   * Reopen a project's last persisted snapshot (Req 16.3); authorized.
   *
   * Falls back to the last consistent checkpoint when no working snapshot exists,
   * so a reopen after a clean checkpoint still returns the approved work.
   */
  async restore(
    principal: AuthenticatedPrincipal,
    projectId: Ulid,
  ): Promise<Result<ProjectState, GatewayError>> {
    const guard = await this.#ensureOwner(principal, projectId);
    if (isErr(guard)) {
      return guard;
    }
    const working = await this.#adapter.loadProjectState(projectId);
    if (working !== null) {
      return ok(working);
    }
    const search = await this.#findLastConsistentCheckpoint(projectId);
    if (search.consistent === null) {
      return err(gatewayError('not_found', 'no persisted state for project'));
    }
    return ok(search.consistent.state);
  }

  /**
   * Automatically restore after a crash (Req 16.4, 16.6, 16.7, 16.10); authorized.
   *
   * Loads only the most recent integrity-checked checkpoint, records any newer
   * checkpoints skipped for failing integrity, surfaces the interrupted step from
   * the separately preserved crash Trace, and never re-executes.
   */
  async restoreLastConsistentCheckpoint(
    principal: AuthenticatedPrincipal,
    projectId: Ulid,
  ): Promise<Result<RestoreOutcome, GatewayError>> {
    const guard = await this.#ensureOwner(principal, projectId);
    if (isErr(guard)) {
      return guard;
    }
    const search = await this.#findLastConsistentCheckpoint(projectId);
    const crashTrace = await this.#adapter.loadCrashTrace(projectId);
    const consistent = search.consistent;
    return ok({
      restored: consistent === null ? null : consistent.state,
      restoredCheckpointId: consistent === null ? null : consistent.id,
      restoredReason: consistent === null ? null : consistent.reason,
      unrecovered: search.unrecoverable,
      interruptedStep: crashTrace === null ? null : interruptedStepOf(crashTrace),
      crashTracePreserved: crashTrace !== null,
      autoReExecuted: false,
    });
  }

  /**
   * Preserve the crash Trace separately from checkpoints (Req 16.10); authorized.
   *
   * Kept apart from the checkpoint history so automatic restore never destroys the
   * information needed to debug the crash cause.
   */
  async preserveCrashTrace(
    principal: AuthenticatedPrincipal,
    projectId: Ulid,
    trace: Trace,
  ): Promise<Result<void, GatewayError>> {
    const guard = await this.#ensureOwner(principal, projectId);
    if (isErr(guard)) {
      return guard;
    }
    await this.#adapter.saveCrashTrace(projectId, trace);
    return ok(undefined);
  }

  /**
   * Decide whether an interrupted step may be resumed, never re-executing on its
   * own (Req 16.8).
   *
   * Requires explicit approval; a side-effectful resume additionally requires a
   * non-empty idempotency key and is authorized at most once per key. A repeat
   * with a used key is `duplicate-suppressed`, granting no second execution.
   */
  async resumeInterruptedStep(
    principal: AuthenticatedPrincipal,
    request: ResumeRequest,
  ): Promise<Result<ResumeDecision, GatewayError>> {
    const guard = await this.#ensureOwner(principal, request.projectId);
    if (isErr(guard)) {
      return guard;
    }
    if (!request.approved) {
      return ok({ kind: 'blocked-needs-approval' });
    }
    if (!request.sideEffectful) {
      return ok({ kind: 'authorized-to-resume' });
    }
    if (request.idempotencyKey.trim().length === 0) {
      return ok({ kind: 'blocked-needs-idempotency-key' });
    }
    const reserved = await this.#adapter.reserveIdempotencyKey(
      request.projectId,
      request.idempotencyKey,
    );
    return ok({ kind: reserved ? 'authorized-to-resume' : 'duplicate-suppressed' });
  }

  /**
   * Snapshot the state, persist it as the working copy, and append an immutable,
   * integrity-stamped checkpoint. Ownership is checked by the public caller.
   */
  async #appendCheckpoint(
    state: ProjectState,
    reason: CheckpointReason,
  ): Promise<Result<Checkpoint, GatewayError>> {
    const snapshot = clone(state);
    const seq = await this.#adapter.nextCheckpointSeq(snapshot.project.id);
    const checkpoint: Checkpoint = {
      id: this.#newCheckpointId(),
      projectId: snapshot.project.id,
      seq,
      reason,
      createdAt: this.#now(),
      state: snapshot,
      integrity: computeStateIntegrity(snapshot),
    };
    await this.#adapter.saveProjectState(snapshot);
    await this.#adapter.appendCheckpoint(checkpoint);
    return ok(checkpoint);
  }

  /**
   * Walk checkpoints newest-first via keyset pages until one passes its integrity
   * check, collecting the failed newer ones as unrecoverable (Req 16.6, 16.7).
   */
  async #findLastConsistentCheckpoint(projectId: Ulid): Promise<ConsistentCheckpointSearch> {
    const unrecoverable: UnrecoverableCheckpoint[] = [];
    let afterSeq: number | null = null;
    for (;;) {
      const page = await this.#adapter.listCheckpoints(projectId, {
        afterSeq,
        limit: RESTORE_PAGE_SIZE,
      });
      for (const record of page.items) {
        if (verifyCheckpointIntegrity(record)) {
          return { consistent: record, unrecoverable };
        }
        unrecoverable.push({
          checkpointId: record.id,
          reason: record.reason,
          createdAt: record.createdAt,
          cause: 'integrity-check-failed',
        });
      }
      if (page.nextAfterSeq === null) {
        return { consistent: null, unrecoverable };
      }
      afterSeq = page.nextAfterSeq;
    }
  }

  /** Enforce per-object ownership from the validated principal claim (Req 16.5, 16.9). */
  #ensureOwner(
    principal: AuthenticatedPrincipal,
    projectId: Ulid,
  ): Promise<Result<void, GatewayError>> {
    return authorizeObject(this.#authorizer, principal, projectId);
  }
}
