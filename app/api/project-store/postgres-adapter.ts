// The Neon/Postgres `StorageAdapter` seam (Recommended stack: Postgres on Neon
// behind a storage adapter, OD-2).
//
// This adapter is written to the same `StorageAdapter` contract as the in-memory
// one and is the production persistence path. It is WIRED BUT UNEXERCISED in this
// environment: Neon is not reachable here, so no test drives it against a live
// database and no query results are faked. It is included so the interface is
// proven to fit a real SQL backend and so the parameterized query shapes and the
// keyset pagination are reviewable now.
//
// Security and performance posture (per `ECE-SECURITY-PERFORMANCE-RESILIENCE.md`):
//   - PARAMETERIZED QUERIES ONLY. Every value is passed as a bound parameter
//     ($1, $2, ...); no SQL is ever built by string concatenation of input, so
//     there is no SQL-injection surface.
//   - KEYSET pagination on the monotonic `seq`, never OFFSET, so deep pages stay
//     O(limit) and are stable under concurrent inserts.
//   - No secret is hardcoded: the connection string and region come from the
//     environment / secret manager via `resolvePostgresConfigFromEnv` and are
//     confined to the injected `SqlClient`; this module never logs them.
//
// The concrete driver (for example `pg` or `@neondatabase/serverless`) is NOT a
// declared dependency here: it is not exercised without a live DB, and declaring
// an uninstalled package would break the build. It plugs in at composition time
// by implementing the tiny `SqlClient` port below, keeping the vendor SDK behind
// our own interface exactly as the standards require.

import type { Trace, Ulid } from '@app/core';
import { gatewayError, type GatewayError } from '../gateway/errors.js';
import type { Result } from '@app/core';
import { err, ok } from '@app/core';

import {
  clampPageLimit,
  type Checkpoint,
  type CheckpointPage,
  type KeysetPage,
  type ProjectState,
  type StorageAdapter,
} from './storage-adapter.js';

/**
 * The minimal parameterized-query port a SQL backend must provide.
 *
 * A single method takes a parameterized statement and its bound parameters and
 * returns typed rows. The concrete Neon/Postgres driver implements this at
 * composition time; isolating it here keeps the driver SDK out of the store and
 * guarantees every call site uses bound parameters.
 */
export interface SqlClient {
  query<Row>(text: string, params: readonly unknown[]): Promise<readonly Row[]>;
}

/** Non-secret Neon/Postgres configuration resolved from the environment. */
export interface PostgresConfig {
  /** The connection string; treated as a secret and never logged. */
  readonly connectionString: string;
  /** Data residency region for the store (OD-2 DPDP/GDPR); non-secret. */
  readonly dataResidencyRegion: string;
}

/** Environment variable names the Postgres config is resolved from. */
const ENV_KEYS = {
  connectionString: 'PROJECT_STORE_DATABASE_URL',
  region: 'PROJECT_STORE_DATA_RESIDENCY_REGION',
} as const;

/**
 * Resolve non-secret-shaped Postgres configuration from an environment map.
 *
 * Reads only from the injected `env` (defaulting to `process.env`) so nothing is
 * hardcoded. Returns a typed `internal` error when a required key is missing,
 * rather than starting with a partial, unsafe configuration. The connection
 * string is carried through but never logged or surfaced to a client.
 */
export function resolvePostgresConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Result<PostgresConfig, GatewayError> {
  const connectionString = env[ENV_KEYS.connectionString];
  const region = env[ENV_KEYS.region];
  if (!connectionString || !region) {
    return err(gatewayError('internal', 'project store configuration is incomplete'));
  }
  return ok({ connectionString, dataResidencyRegion: region });
}

/** Row shape for a single-column owner lookup. */
interface OwnerRow {
  readonly owner_id: string;
}

/** Row shape for the JSON state column. */
interface StateRow {
  readonly state_json: string;
}

/** Row shape for the next-sequence lookup. */
interface SeqRow {
  readonly next_seq: number;
}

/** Row shape for a checkpoint tuple. */
interface CheckpointRow {
  readonly id: string;
  readonly project_id: string;
  readonly seq: number;
  readonly reason: string;
  readonly created_at: string;
  readonly state_json: string;
  readonly integrity: string;
}

/** Row shape for an idempotency-key reservation attempt. */
interface ReservedRow {
  readonly reserved: boolean;
}

/** Parse a JSON string to `unknown` without introducing an implicit `any`. */
function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

/**
 * The Neon/Postgres implementation of `StorageAdapter`.
 *
 * Every statement is parameterized. JSON aggregates (state, trace) are stored in
 * `jsonb` columns and (de)serialized at the boundary. The reason string read
 * back from the database is validated against the closed `CheckpointReason` set
 * before it is trusted.
 */
export class PostgresStorageAdapter implements StorageAdapter {
  readonly #sql: SqlClient;

  constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  async saveProjectState(state: ProjectState): Promise<void> {
    await this.#sql.query(
      `INSERT INTO project_state (project_id, owner_id, state_json)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (project_id)
       DO UPDATE SET owner_id = EXCLUDED.owner_id, state_json = EXCLUDED.state_json`,
      [state.project.id, state.project.ownerId, JSON.stringify(state)],
    );
  }

  async loadProjectState(projectId: Ulid): Promise<ProjectState | null> {
    const rows = await this.#sql.query<StateRow>(
      `SELECT state_json FROM project_state WHERE project_id = $1`,
      [projectId],
    );
    const row = rows[0];
    return row === undefined ? null : (parseJson(row.state_json) as ProjectState);
  }

  async findOwnerId(projectId: Ulid): Promise<Ulid | null> {
    const rows = await this.#sql.query<OwnerRow>(
      `SELECT owner_id FROM project_state WHERE project_id = $1`,
      [projectId],
    );
    return rows[0]?.owner_id ?? null;
  }

  async appendCheckpoint(checkpoint: Checkpoint): Promise<void> {
    await this.#sql.query(
      `INSERT INTO project_checkpoint
         (id, project_id, seq, reason, created_at, state_json, integrity)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        checkpoint.id,
        checkpoint.projectId,
        checkpoint.seq,
        checkpoint.reason,
        checkpoint.createdAt,
        JSON.stringify(checkpoint.state),
        checkpoint.integrity,
      ],
    );
  }

  async nextCheckpointSeq(projectId: Ulid): Promise<number> {
    const rows = await this.#sql.query<SeqRow>(
      `SELECT COALESCE(MAX(seq) + 1, 0) AS next_seq
       FROM project_checkpoint WHERE project_id = $1`,
      [projectId],
    );
    return rows[0]?.next_seq ?? 0;
  }

  async listCheckpoints(projectId: Ulid, page: KeysetPage): Promise<CheckpointPage> {
    const limit = clampPageLimit(page.limit);
    // Fetch one extra row to decide whether an older page exists, and keyset on
    // `seq` (strictly-less-than the cursor) rather than OFFSET.
    const rows = await this.#sql.query<CheckpointRow>(
      `SELECT id, project_id, seq, reason, created_at, state_json, integrity
       FROM project_checkpoint
       WHERE project_id = $1 AND ($2::bigint IS NULL OR seq < $2::bigint)
       ORDER BY seq DESC
       LIMIT $3`,
      [projectId, page.afterSeq, limit + 1],
    );
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => rowToCheckpoint(row));
    const nextAfterSeq = hasMore ? (items.at(-1)?.seq ?? null) : null;
    return { items, nextAfterSeq };
  }

  async saveCrashTrace(projectId: Ulid, trace: Trace): Promise<void> {
    await this.#sql.query(
      `INSERT INTO project_crash_trace (project_id, trace_json)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (project_id) DO UPDATE SET trace_json = EXCLUDED.trace_json`,
      [projectId, JSON.stringify(trace)],
    );
  }

  async loadCrashTrace(projectId: Ulid): Promise<Trace | null> {
    const rows = await this.#sql.query<{ readonly trace_json: string }>(
      `SELECT trace_json FROM project_crash_trace WHERE project_id = $1`,
      [projectId],
    );
    const row = rows[0];
    return row === undefined ? null : (parseJson(row.trace_json) as Trace);
  }

  async reserveIdempotencyKey(projectId: Ulid, key: string): Promise<boolean> {
    // A unique (project_id, key) constraint makes the reservation atomic:
    // `ON CONFLICT DO NOTHING` returns a row only on a fresh insert, so a
    // duplicate side-effectful re-run is suppressed by the database itself.
    const rows = await this.#sql.query<ReservedRow>(
      `INSERT INTO project_idempotency_key (project_id, key)
       VALUES ($1, $2)
       ON CONFLICT (project_id, key) DO NOTHING
       RETURNING true AS reserved`,
      [projectId, key],
    );
    return rows[0]?.reserved ?? false;
  }
}

/** The closed set of persisted checkpoint reasons, validated on read. */
const CHECKPOINT_REASONS = new Set<string>(['spec-approved', 'verified']);

/**
 * Convert a database row into a `Checkpoint`, validating the untrusted `reason`
 * string against the closed set before trusting it (values from storage are
 * validated at this boundary, like any external input).
 */
function rowToCheckpoint(row: CheckpointRow): Checkpoint {
  if (!CHECKPOINT_REASONS.has(row.reason)) {
    throw new Error('corrupt checkpoint reason');
  }
  return {
    id: row.id,
    projectId: row.project_id,
    seq: row.seq,
    reason: row.reason as Checkpoint['reason'],
    createdAt: row.created_at,
    state: parseJson(row.state_json) as ProjectState,
    integrity: row.integrity,
  };
}
