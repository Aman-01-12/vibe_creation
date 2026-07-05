// ULID-based identifiers.
//
// All domain identifiers are ULIDs: unguessable (defense-in-depth against IDOR),
// lexicographically sortable by creation time (keyset pagination), and encoded as
// 26-character Crockford base32. Generation and validation are delegated to the
// `ulidx` library (pinned exactly in package.json); we never hand-roll ULID
// encoding.
//
// `Ulid` is a documentary alias for `string`, matching the design's runtime type
// (identifiers are plain strings on the wire and in storage) while making the
// intended shape explicit at every declaration site. Validity is checked at trust
// boundaries via `parseUlid`, not encoded into the static type, so this alias
// stays freely assignable to and from `string`.

import { isValid, ulid } from 'ulidx';

import { domainError, type DomainError } from './domain-error.js';
import { err, ok, type Result } from './result.js';

/** A ULID string identifier (26-character Crockford base32). */
export type Ulid = string;

/** Generate a fresh, monotonic-safe ULID for the current instant. */
export function newUlid(): Ulid {
  return ulid();
}

/** Return whether a string is a syntactically valid ULID. */
export function isUlid(candidate: string): boolean {
  return isValid(candidate);
}

/**
 * Validate that an untrusted string is a ULID.
 *
 * Returns the value unchanged on success, or a typed `INVALID_ULID` error
 * naming the field on failure. Use this when accepting an identifier that did
 * not originate from `newUlid`.
 */
export function parseUlid(candidate: string, field: string): Result<Ulid, DomainError> {
  if (!isValid(candidate)) {
    return err(domainError('INVALID_ULID', `${field} must be a valid ULID`, field));
  }
  return ok(candidate);
}
