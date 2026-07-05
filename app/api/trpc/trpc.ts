// tRPC initialization, context, and shared procedures for the API_Gateway.
//
// This is the typed RPC surface the Editor consumes (OD-7, tRPC v11 with SSE
// subscriptions per OD-6). Authentication is resolved into the per-request
// context by `createGatewayContext` using the injected auth adapter; the
// `authedProcedure` then enforces presence of a principal and applies the
// per-principal + global rate limit. Every client-facing error is passed through
// the single error-mapper by the error formatter, so no internal detail leaks.

import { initTRPC, TRPCError } from '@trpc/server';

import type { AuthAdapter, AuthenticatedPrincipal } from '../gateway/auth.js';
import { toClientSafeError, type GatewayError, type GatewayErrorCode } from '../gateway/errors.js';
import type { RateLimiter } from '../gateway/rate-limit.js';
import { isErr } from '@app/core';

/** Per-request context. `principal` is null until a credential is verified. */
export interface GatewayContext {
  readonly principal: AuthenticatedPrincipal | null;
  readonly rateLimiter: RateLimiter;
  readonly now: number;
}

/** Inputs the transport supplies to build one request's context. */
export interface GatewayContextInput {
  readonly credential: string | null;
  readonly now: number;
}

/** Collaborators needed to authenticate a request into a context. */
export interface GatewayContextDeps {
  readonly auth: AuthAdapter;
  readonly rateLimiter: RateLimiter;
}

/**
 * Build the per-request context, authenticating the credential if present.
 *
 * A missing or invalid credential yields a null principal rather than throwing;
 * `authedProcedure` converts that into a sanitized `UNAUTHORIZED` at call time.
 */
export async function createGatewayContext(
  deps: GatewayContextDeps,
  input: GatewayContextInput,
): Promise<GatewayContext> {
  const principal = await resolvePrincipal(deps.auth, input.credential);
  return { principal, rateLimiter: deps.rateLimiter, now: input.now };
}

async function resolvePrincipal(
  auth: AuthAdapter,
  credential: string | null,
): Promise<AuthenticatedPrincipal | null> {
  if (credential === null || credential.length === 0) {
    return null;
  }
  const result = await auth.verify(credential);
  return isErr(result) ? null : result.value;
}

/** Map an internal gateway code onto the closest tRPC transport code. */
const TRPC_CODE: Readonly<Record<GatewayErrorCode, TRPCError['code']>> = {
  payload_empty: 'BAD_REQUEST',
  payload_too_large: 'PAYLOAD_TOO_LARGE',
  malformed_payload: 'BAD_REQUEST',
  schema_invalid: 'BAD_REQUEST',
  unauthenticated: 'UNAUTHORIZED',
  forbidden: 'FORBIDDEN',
  rate_limited: 'TOO_MANY_REQUESTS',
  unsafe_content: 'BAD_REQUEST',
  not_found: 'NOT_FOUND',
  internal: 'INTERNAL_SERVER_ERROR',
};

/** Throw a `TRPCError` carrying the typed gateway error as its cause. */
export function throwGateway(error: GatewayError): never {
  throw new TRPCError({ code: TRPC_CODE[error.code], cause: error });
}

const t = initTRPC.context<GatewayContext>().create({
  // Single client-facing sanitization point: attach a ClientSafeError derived
  // solely from the error cause, never from raw messages or stack traces.
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: { ...shape.data, clientSafe: toClientSafeError(error.cause) },
    };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;

/**
 * Require an authenticated principal, then enforce the per-principal + global
 * request rate limit. Kept as one middleware so the non-null narrowing of
 * `principal` flows into the rate-limit check and downstream resolvers. Both
 * failures fail closed with a sanitized error.
 */
const authAndRateLimit = t.middleware(({ ctx, next }) => {
  if (ctx.principal === null) {
    throwGateway({ code: 'unauthenticated' });
  }
  const decision = ctx.rateLimiter.check(ctx.principal.userId, ctx.now);
  if (!decision.allowed) {
    throwGateway({ code: 'rate_limited' });
  }
  return next({ ctx: { principal: ctx.principal } });
});

/**
 * The base procedure for every authenticated endpoint: authenticate, then rate
 * limit. Input schema validation is attached per procedure via `.input(...)`.
 */
export const authedProcedure = publicProcedure.use(authAndRateLimit);
