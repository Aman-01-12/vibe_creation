// Per-object authorization seam (IDOR/BOLA guard).
//
// STUB FOR TASK 5.1. Per-object authorization is completed against the
// Project_Store in task 12.1, which decides ownership from a validated token
// claim on every project access and restore. Until then this seam is
// SAFE-BY-DEFAULT: the default authorizer DENIES every object-scoped request, so
// no object endpoint is ever silently permissive. Task 12.1 injects the real
// `ObjectAuthorizer`; nothing about the calling convention changes.
//
// The object-less M0 skeleton path (compile-and-simulate hardcoded Verilog, Req
// 1.4) does not touch a stored object and therefore does not call this seam, so
// the deny-by-default stub does not block the M0 milestone.

import type { Result } from '@app/core';
import { err, ok } from '@app/core';

import type { AuthenticatedPrincipal } from './auth.js';
import { gatewayError, type GatewayError } from './errors.js';

/**
 * The per-object authorization port.
 *
 * Decides whether `principal` may act on the object identified by `objectId`.
 * Returns a typed `forbidden` error rather than throwing, so the pipeline can
 * fail closed uniformly.
 */
export interface ObjectAuthorizer {
  authorize(
    principal: AuthenticatedPrincipal,
    objectId: string,
  ): Promise<Result<void, GatewayError>>;
}

/**
 * The default authorizer used until task 12.1 wires the Project_Store.
 *
 * Denies unconditionally. This is intentional: an unwired per-object check must
 * fail closed, never open.
 */
export const denyAllObjectAuthorizer: ObjectAuthorizer = {
  authorize(): Promise<Result<void, GatewayError>> {
    return Promise.resolve(
      err(gatewayError('forbidden', 'per-object authorization is not yet wired (task 12.1)')),
    );
  },
};

/**
 * Authorize an object-scoped action through the injected authorizer.
 *
 * A thin, uniform entry point the tRPC resolvers call before touching any
 * object; defaults to the deny-all stub when no authorizer is injected.
 */
export async function authorizeObject(
  authorizer: ObjectAuthorizer,
  principal: AuthenticatedPrincipal,
  objectId: string,
): Promise<Result<void, GatewayError>> {
  if (objectId.length === 0) {
    return err(gatewayError('forbidden', 'missing object identifier'));
  }
  return authorizer.authorize(principal, objectId);
}

/** A void success, for authorizers that grant access. */
export function authorized(): Result<void, GatewayError> {
  return ok(undefined);
}
