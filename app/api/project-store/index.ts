// Project_Store: durable, per-object-authorized persistence with crash restore
// and no-auto-re-execute (task 12.1; Req 5.7, 16.1-16.10).
//
// Public surface (one name per concept):
//   - `StorageAdapter` + `ProjectState` / `Checkpoint` / keyset page types: the
//     single persistence seam the store programs to, with Trace spans persisted
//     behind it (OD-2: Postgres on Neon behind a storage adapter).
//   - `computeStateIntegrity` / `verifyCheckpointIntegrity`: the checkpoint
//     integrity fingerprint and its verification on restore.
//   - `createOwnerObjectAuthorizer`: the real per-object authorizer that replaces
//     the API_Gateway deny-all stub, decided from the validated token claim.
//   - `InMemoryStorageAdapter`: the exercised, full-correctness adapter for tests
//     and local development.
//   - `PostgresStorageAdapter` / `SqlClient` / `resolvePostgresConfigFromEnv`: the
//     production Neon/Postgres adapter behind the same seam (unexercised here).
//   - `ProjectStore`: the orchestration - persist, checkpoint on Spec approval and
//     on `Verified`, reopen, crash-restore the last consistent checkpoint with
//     fallback, preserve the crash Trace, and gate side-effectful resume behind
//     approval + an idempotency key.

export * from './storage-adapter.js';
export * from './integrity.js';
export * from './authorizer.js';
export * from './in-memory-adapter.js';
export * from './postgres-adapter.js';
export * from './project-store.js';
