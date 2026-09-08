// Checkpoint integrity: a fingerprint over a persisted `ProjectState` and the
// verification that a restored checkpoint still matches it (Req 16.6, 16.7).
//
// The store computes this fingerprint at write time and stores it on the
// `Checkpoint`. On restore, the fingerprint is recomputed over the loaded state
// and compared: a mismatch means the checkpoint is corrupt or was partially
// written, so it is rejected and the previous valid checkpoint is restored
// instead (fail safe, never load a corrupt/partial state).
//
// The fingerprint is a SHA-256 over a CANONICAL serialization of the state
// (object keys sorted recursively) so that two states that are deeply equal
// always produce the same fingerprint regardless of key insertion order, and any
// change to the content changes the fingerprint. This is an integrity check
// against corruption/partial writes, not a security signature (a durable store
// stores the fingerprint alongside the data); it deliberately holds no secret.

import { createHash } from 'node:crypto';

import type { Checkpoint, ProjectState } from './storage-adapter.js';

/**
 * Canonicalize a JSON-compatible value to a deterministic string.
 *
 * Objects have their keys sorted so serialization order never depends on how the
 * object was built; arrays preserve order (order is significant, e.g. Trace
 * spans); primitives use `JSON.stringify`. `undefined` object fields are skipped,
 * matching how they serialize out of storage.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Compute the integrity fingerprint (hex SHA-256) over a project state.
 *
 * Used both when writing a checkpoint and when verifying one on restore, so the
 * two computations are guaranteed identical.
 */
export function computeStateIntegrity(state: ProjectState): string {
  return createHash('sha256').update(canonicalize(state), 'utf8').digest('hex');
}

/**
 * Verify a restored checkpoint's state matches its stored fingerprint.
 *
 * Returns `true` only when the recomputed fingerprint equals the stored one; any
 * corruption, truncation, or partial write flips at least one byte of the
 * canonical form and fails the check.
 */
export function verifyCheckpointIntegrity(checkpoint: Checkpoint): boolean {
  return computeStateIntegrity(checkpoint.state) === checkpoint.integrity;
}
