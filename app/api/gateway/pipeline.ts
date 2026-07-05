// The inbound gateway pipeline: the authoritative trust boundary.
//
// This function enforces the mandated order EXACTLY, once, in one place:
//
//   size -> type -> schema -> auth -> rate-limit -> injection-filter
//
// Every inbound request is validated by size, then type, then schema BEFORE any
// handler logic; only then is the caller authenticated, rate limited, and the
// content injection-filtered before it can reach the Orchestrator. Every failure
// path - including any unexpected throwable - funnels through the single
// error-mapper (`toClientSafeError`) and fails safe. The transport adapter (tRPC
// over SSE/HTTP2, wired in task 6) calls this for each inbound request.

import type { ZodType } from 'zod';

import type { Result } from '@app/core';
import { err, isErr, ok } from '@app/core';

import type { AuthAdapter, AuthenticatedPrincipal } from './auth.js';
import { toClientSafeError, type ClientSafeError, type GatewayError } from './errors.js';
import { gatewayError } from './errors.js';
import { sanitizeDeep, type InjectionReport } from './injection-filter.js';
import type { RateLimiter } from './rate-limit.js';
import { checkSchema, checkSize, parseJson } from './validation.js';

/** Injected collaborators the pipeline depends on (all behind interfaces). */
export interface GatewayDeps {
  readonly auth: AuthAdapter;
  readonly rateLimiter: RateLimiter;
  readonly config: GatewayConfig;
}

/** Non-secret pipeline configuration. */
export interface GatewayConfig {
  readonly maxPayloadBytes: number;
}

/** The raw, untrusted inbound request as seen at the transport edge. */
export interface InboundRequest {
  /** The serialized request body, measured for the size gate then parsed. */
  readonly rawBody: string;
  /** The bearer credential from the transport, or null when absent. */
  readonly credential: string | null;
  /** Injected clock for deterministic rate limiting. */
  readonly now: number;
}

/** A fully validated, authenticated, sanitized request ready for the Orchestrator. */
export interface ValidatedInbound<T> {
  readonly principal: AuthenticatedPrincipal;
  /** The schema-valid value with its untrusted free-text injection-filtered. */
  readonly value: T;
  readonly injection: InjectionReport;
}

/**
 * A sanitization strategy for the injection-filter step.
 *
 * Defaults to `sanitizeDeep`, which neutralizes every string leaf - correct for
 * natural-language payloads. Code-bearing payloads (e.g. the skeleton simulate
 * path, whose Verilog goes to the deterministic oracle rather than a model)
 * supply a field-targeted or no-op strategy so legitimate source is not mangled.
 */
export type SanitizeStrategy<T> = (value: T) => { value: T; report: InjectionReport };

/**
 * Run the full inbound pipeline for one request against a payload schema.
 *
 * Returns the validated request on success, or a sanitized `ClientSafeError` on
 * any failure. Never throws for expected failures; unexpected throwables are
 * caught and mapped to a generic sanitized error.
 */
export async function enforceInboundPipeline<T>(
  deps: GatewayDeps,
  schema: ZodType<T>,
  inbound: InboundRequest,
  sanitize: SanitizeStrategy<T> = sanitizeDeep,
): Promise<Result<ValidatedInbound<T>, ClientSafeError>> {
  try {
    const validated = await runSteps(deps, schema, inbound, sanitize);
    if (isErr(validated)) {
      return err(toClientSafeError(validated.error));
    }
    return ok(validated.value);
  } catch {
    // Fail safe: no internal detail crosses the boundary.
    return err(toClientSafeError(gatewayError('internal')));
  }
}

/** The ordered steps, each short-circuiting on the first typed failure. */
async function runSteps<T>(
  deps: GatewayDeps,
  schema: ZodType<T>,
  inbound: InboundRequest,
  sanitize: SanitizeStrategy<T>,
): Promise<Result<ValidatedInbound<T>, GatewayError>> {
  const sized = checkSize(inbound.rawBody, deps.config.maxPayloadBytes);
  if (isErr(sized)) {
    return sized;
  }
  const parsed = parseJson(sized.value);
  if (isErr(parsed)) {
    return parsed;
  }
  const shaped = checkSchema(parsed.value, schema);
  if (isErr(shaped)) {
    return shaped;
  }
  const authed = await authenticate(deps, inbound.credential);
  if (isErr(authed)) {
    return authed;
  }
  const limited = enforceRateLimit(deps, authed.value.userId, inbound.now);
  if (isErr(limited)) {
    return limited;
  }
  const { value, report } = sanitize(shaped.value);
  return ok({ principal: authed.value, value, injection: report });
}

/** Step 4 - auth. Absent credential is unauthenticated; adapter decides the rest. */
async function authenticate(
  deps: GatewayDeps,
  credential: string | null,
): Promise<Result<AuthenticatedPrincipal, GatewayError>> {
  if (credential === null || credential.length === 0) {
    return err(gatewayError('unauthenticated', 'missing credential'));
  }
  return deps.auth.verify(credential);
}

/** Step 5 - rate limit. Rejects when either the per-principal or global cap is hit. */
function enforceRateLimit(
  deps: GatewayDeps,
  principalId: string,
  now: number,
): Result<void, GatewayError> {
  const decision = deps.rateLimiter.check(principalId, now);
  if (!decision.allowed) {
    return err(
      gatewayError('rate_limited', `rate limit exceeded (${decision.scope ?? 'unknown'})`),
    );
  }
  return ok(undefined);
}
