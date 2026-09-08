// The Project_Store storage adapter: the single seam the store persists behind
// (Design: Cross-cutting components (Project_Store); Recommended stack: Postgres
// on Neon behind a storage adapter, Req 16.2, 16.3).
//
// The store programs to this interface only, so the concrete durable store
// (Neon/Postgres, see `postgres-adapter.ts`) is injected at composition time and
// swapped without touching the store's logic. Two implementations satisfy it: an
// in-memory adapter for local runs and tests, and a Postgres adapter written to
// the same contract. Trace spans are persisted behind this adapter (never by a
// caller reaching a table directly) so high-volume spans can move to an
// append-optimized store later without changing any caller (OD-2 caveat).
//
// Listing is keyset-paginated (never OFFSET) on the monotonic checkpoint `seq`,
// per `ECE-SECURITY-PERFORMANCE-RESILIENCE.md`: checkpoints are ULID/seq-ordered
// so a cursor is a stable position, not a shifting row offset.

import type {
  ModuleVersion,
  Project,
  Spec,
  Testbench,
  Trace,
  Ulid,
  VerificationResult,
} from '@app/core';

/**
 * The full, round-trippable working state of one project (Req 16.2).
 *
 * This is the unit persisted and restored: the Spec, the sources (generated
 * module versions), the Testbench, the latest verification result, and the
 * Trace. Optionality is explicit via `null` for the artifacts that do not yet
 * exist rather than an absent field, so a partially built project has one
 * unambiguous shape.
 */
export interface ProjectState {
  readonly project: Project;
  readonly spec: Spec | null;
  /** The generated module versions (RTL sources) for the project. */
  readonly sources: readonly ModuleVersion[];
  readonly testbench: Testbench | null;
  readonly latestVerificationResult: VerificationResult | null;
  readonly trace: Trace;
}

/**
 * Why a durable checkpoint was written.
 *
 * Checkpoints are written on exactly these two milestones (Req 16.1): the
 * Student approving the Spec, and the module reaching `Verified`.
 */
export type CheckpointReason = 'spec-approved' | 'verified';

/**
 * A durable checkpoint: an immutable snapshot of a `ProjectState` plus the
 * integrity fingerprint computed over that snapshot at write time.
 *
 * `seq` is a per-project monotonic ordering key used for keyset pagination and
 * for selecting the most recent consistent checkpoint on restore. `integrity` is
 * recomputed and compared on restore; a mismatch marks the checkpoint corrupt
 * and triggers fallback to the previous valid checkpoint (Req 16.6, 16.7).
 */
export interface Checkpoint {
  readonly id: Ulid;
  readonly projectId: Ulid;
  /** Per-project monotonic sequence; larger is newer. */
  readonly seq: number;
  readonly reason: CheckpointReason;
  /** ISO-8601 timestamp. */
  readonly createdAt: string;
  readonly state: ProjectState;
  /** Fingerprint over `state`, verified on restore (hex-encoded). */
  readonly integrity: string;
}

/**
 * A keyset page request over a project's checkpoints, newest-first.
 *
 * `afterSeq` is the cursor: `null` starts at the newest checkpoint, otherwise the
 * page returns checkpoints with `seq` strictly less than `afterSeq`. This is a
 * stable keyset position, never an OFFSET.
 */
export interface KeysetPage {
  readonly afterSeq: number | null;
  /** Maximum items to return; the adapter clamps to a sane upper bound. */
  readonly limit: number;
}

/** One page of checkpoints plus the cursor to fetch the next (older) page. */
export interface CheckpointPage {
  /** Checkpoints newest-first (descending `seq`). */
  readonly items: readonly Checkpoint[];
  /** Cursor for the next page, or `null` when no older checkpoints remain. */
  readonly nextAfterSeq: number | null;
}

/**
 * Read-only ownership lookup, the narrow slice the per-object authorizer needs.
 *
 * Kept separate from the full adapter so the `ObjectAuthorizer` depends only on
 * "who owns this project", never on the whole persistence surface. This is what
 * lets the authorizer decide ownership without a dependency cycle back into the
 * store.
 */
export interface ProjectOwnershipReader {
  /** The owner's user id for a project, or `null` when the project is unknown. */
  findOwnerId(projectId: Ulid): Promise<Ulid | null>;
}

/**
 * The persistence contract behind the Project_Store.
 *
 * Every method is asynchronous so a network-backed implementation (Neon) fits
 * without changing the store. Implementations MUST treat stored state as
 * immutable (no in-place mutation of a returned snapshot) and MUST persist Trace
 * spans through this adapter rather than exposing a span table to callers.
 */
export interface StorageAdapter extends ProjectOwnershipReader {
  /**
   * Persist the working state for a project, establishing or updating it. The
   * project's `ownerId` is recorded so `findOwnerId` can answer authorization
   * checks for every later access.
   */
  saveProjectState(state: ProjectState): Promise<void>;

  /** Load the working state for a project, or `null` when none is stored. */
  loadProjectState(projectId: Ulid): Promise<ProjectState | null>;

  /** Append a durable checkpoint (append-only; checkpoints are never mutated). */
  appendCheckpoint(checkpoint: Checkpoint): Promise<void>;

  /** The next per-project checkpoint `seq` to assign (0 when none exist yet). */
  nextCheckpointSeq(projectId: Ulid): Promise<number>;

  /** List checkpoints newest-first with keyset pagination on `seq`. */
  listCheckpoints(projectId: Ulid, page: KeysetPage): Promise<CheckpointPage>;

  /**
   * Preserve the crash Trace SEPARATELY from checkpoints (Req 16.10), so
   * automatic restore never destroys the information needed to debug the crash.
   */
  saveCrashTrace(projectId: Ulid, trace: Trace): Promise<void>;

  /** Load the separately preserved crash Trace, or `null` when none exists. */
  loadCrashTrace(projectId: Ulid): Promise<Trace | null>;

  /**
   * Reserve an idempotency key for a side-effectful re-run of a project step.
   *
   * Returns `true` when the key was newly reserved (the caller may proceed), and
   * `false` when it was already reserved (a duplicate that must be suppressed).
   * This is the storage half of the idempotency gate in Req 16.8.
   */
  reserveIdempotencyKey(projectId: Ulid, key: string): Promise<boolean>;
}

/** Upper bound the adapters clamp a page `limit` to, to bound payload size. */
export const MAX_CHECKPOINT_PAGE_LIMIT = 100;

/** Clamp a requested page limit into `[1, MAX_CHECKPOINT_PAGE_LIMIT]`. */
export function clampPageLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) {
    return 1;
  }
  return Math.min(limit, MAX_CHECKPOINT_PAGE_LIMIT);
}
