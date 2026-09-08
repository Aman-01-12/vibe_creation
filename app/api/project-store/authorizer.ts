// The real per-object authorizer (IDOR/BOLA defense), completing the gateway's
// `authorizeObject` seam (Req 16.5, 16.9; Property 31).
//
// This replaces `denyAllObjectAuthorizer` by deciding ownership from the
// principal's VALIDATED TOKEN CLAIM (`principal.userId`, produced by the
// managed-auth adapter's server-side credential verification) on EVERY project
// access AND every automatic restore. The calling convention is unchanged: it
// implements the same `ObjectAuthorizer` interface, so the tRPC router and
// pipeline wiring stay exactly as authored in task 5.1 - only the injected
// instance changes.
//
// It FAILS CLOSED. Ownership must be positively established from stored state to
// grant access; every ambiguous case (missing/invalid claim, unknown project,
// owner mismatch, or a lookup that yields nothing) denies with a uniform
// `forbidden`. The denial is deliberately uniform for "unknown project" and
// "not the owner" so a caller cannot enumerate which project ids exist.

import { isUlid } from '@app/core';
import type { Result } from '@app/core';
import { err } from '@app/core';

import { authorized, type ObjectAuthorizer } from '../gateway/authorize-object.js';
import type { AuthenticatedPrincipal } from '../gateway/auth.js';
import { gatewayError, type GatewayError } from '../gateway/errors.js';

import type { ProjectOwnershipReader } from './storage-adapter.js';

/** A uniform, information-leak-free denial for every unauthorized case. */
function deny(detail: string): Result<void, GatewayError> {
  return err(gatewayError('forbidden', detail));
}

/**
 * Build the owner-check `ObjectAuthorizer` backed by an ownership reader.
 *
 * The reader is the narrow read slice of the Project_Store's storage adapter, so
 * ownership is decided from the same durable source of truth the store persists,
 * with no dependency cycle back into the store.
 */
export function createOwnerObjectAuthorizer(reader: ProjectOwnershipReader): ObjectAuthorizer {
  return {
    async authorize(
      principal: AuthenticatedPrincipal,
      objectId: string,
    ): Promise<Result<void, GatewayError>> {
      // The validated subject claim must itself be well-formed; a malformed or
      // empty claim can never own anything.
      if (!isUlid(principal.userId)) {
        return deny('invalid subject claim');
      }
      // A malformed object id can never match a stored owner; fail closed
      // rather than probing the store with it.
      if (!isUlid(objectId)) {
        return deny('invalid object identifier');
      }
      const ownerId = await reader.findOwnerId(objectId);
      // Unknown project and owner-mismatch both deny identically, so ownership
      // cannot be used to enumerate which projects exist.
      if (ownerId === null || ownerId !== principal.userId) {
        return deny('principal does not own the requested project');
      }
      return authorized();
    },
  };
}
