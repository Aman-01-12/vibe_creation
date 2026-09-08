// An in-memory `StorageAdapter` for local runs and tests.
//
// This is the implementation the unit and property tests exercise: it is
// dependency-free and deterministic, so persistence round-trips, checkpoint
// selection, keyset pagination, and crash-trace preservation can be verified
// without a live database. The Neon/Postgres adapter (see `postgres-adapter.ts`)
// implements the same contract for production.
//
// Snapshots are deep-copied on the way in and out via `structuredClone`, so a
// caller cannot mutate stored state through a retained reference and a restored
// state is independent of the stored one. This makes the immutability the
// interface promises real at runtime, not just in the type system.

import type { Trace, Ulid } from '@app/core';

import {
  clampPageLimit,
  type Checkpoint,
  type CheckpointPage,
  type KeysetPage,
  type ProjectState,
  type StorageAdapter,
} from './storage-adapter.js';

/** Deep, independent copy of a stored value (structured clone of plain data). */
function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * A process-local `StorageAdapter`. State lives in `Map`s keyed by project id;
 * nothing escapes the process and nothing is shared between instances.
 */
export class InMemoryStorageAdapter implements StorageAdapter {
  readonly #states = new Map<Ulid, ProjectState>();
  readonly #owners = new Map<Ulid, Ulid>();
  readonly #checkpoints = new Map<Ulid, Checkpoint[]>();
  readonly #crashTraces = new Map<Ulid, Trace>();
  readonly #idempotencyKeys = new Map<Ulid, Set<string>>();

  saveProjectState(state: ProjectState): Promise<void> {
    const projectId = state.project.id;
    this.#states.set(projectId, clone(state));
    this.#owners.set(projectId, state.project.ownerId);
    return Promise.resolve();
  }

  loadProjectState(projectId: Ulid): Promise<ProjectState | null> {
    const stored = this.#states.get(projectId);
    return Promise.resolve(stored === undefined ? null : clone(stored));
  }

  findOwnerId(projectId: Ulid): Promise<Ulid | null> {
    return Promise.resolve(this.#owners.get(projectId) ?? null);
  }

  appendCheckpoint(checkpoint: Checkpoint): Promise<void> {
    const list = this.#checkpoints.get(checkpoint.projectId) ?? [];
    list.push(clone(checkpoint));
    this.#checkpoints.set(checkpoint.projectId, list);
    // A checkpoint also establishes ownership if state was never saved directly.
    if (!this.#owners.has(checkpoint.projectId)) {
      this.#owners.set(checkpoint.projectId, checkpoint.state.project.ownerId);
    }
    return Promise.resolve();
  }

  nextCheckpointSeq(projectId: Ulid): Promise<number> {
    const list = this.#checkpoints.get(projectId) ?? [];
    const last = list.at(-1);
    return Promise.resolve(last === undefined ? 0 : last.seq + 1);
  }

  listCheckpoints(projectId: Ulid, page: KeysetPage): Promise<CheckpointPage> {
    const limit = clampPageLimit(page.limit);
    const cursor = page.afterSeq;
    const descending = [...(this.#checkpoints.get(projectId) ?? [])].sort((a, b) => b.seq - a.seq);
    const afterCursor = cursor === null ? descending : descending.filter((cp) => cp.seq < cursor);
    const items = afterCursor.slice(0, limit).map(clone);
    const hasMore = afterCursor.length > limit;
    const nextAfterSeq = hasMore ? (items.at(-1)?.seq ?? null) : null;
    return Promise.resolve({ items, nextAfterSeq });
  }

  saveCrashTrace(projectId: Ulid, trace: Trace): Promise<void> {
    this.#crashTraces.set(projectId, clone(trace));
    return Promise.resolve();
  }

  loadCrashTrace(projectId: Ulid): Promise<Trace | null> {
    const stored = this.#crashTraces.get(projectId);
    return Promise.resolve(stored === undefined ? null : clone(stored));
  }

  reserveIdempotencyKey(projectId: Ulid, key: string): Promise<boolean> {
    const keys = this.#idempotencyKeys.get(projectId) ?? new Set<string>();
    if (keys.has(key)) {
      return Promise.resolve(false);
    }
    keys.add(key);
    this.#idempotencyKeys.set(projectId, keys);
    return Promise.resolve(true);
  }
}
