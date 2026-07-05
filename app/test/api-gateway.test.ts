// Example unit tests for the API_Gateway trust boundary (task 5.1).
//
// These are concrete example checks of the three security guarantees the gateway
// boundary must never break:
//
//   1. The single error-mapper never lets an internal host, IP, file path, stack
//      trace, or secret cross the boundary (Req 1.3, 17.4).
//   2. Request rate limiting rejects over-limit traffic per-principal AND
//      globally, without consuming quota on a rejected request. This mechanism is
//      deliberately DISTINCT from the per-session Session_Budget.
//   3. The per-object authorization seam FAILS CLOSED until task 12.1 wires the
//      real ownership check against the Project_Store.
//
// The universal Property 32 (boundary validation + sanitized errors), the abuse
// tests, and the injection-efficacy tests are separate fast-check suites in tasks
// 5.2 to 5.4; these examples complement them.

import { describe, expect, it } from 'vitest';

import {
  InMemoryRateLimiter,
  authorizeObject,
  authorized,
  denyAllObjectAuthorizer,
  gatewayError,
  isGatewayError,
  toClientSafeError,
  type AuthenticatedPrincipal,
  type ObjectAuthorizer,
} from '@app/api';
import { isErr, isOk } from '@app/core';

const KNOWN_CODES = [
  'payload_empty',
  'payload_too_large',
  'malformed_payload',
  'schema_invalid',
  'unauthenticated',
  'forbidden',
  'rate_limited',
  'unsafe_content',
  'not_found',
  'internal',
] as const;

describe('toClientSafeError (single error-mapper)', () => {
  it('maps every known gateway code to a fixed, safe, non-empty message', () => {
    for (const code of KNOWN_CODES) {
      const safe = toClientSafeError(gatewayError(code));
      expect(safe.code).toBe(code);
      expect(safe.message.length).toBeGreaterThan(0);
      expect(typeof safe.retryable).toBe('boolean');
    }
  });

  it('never copies internal detail into the client message', () => {
    const detail =
      'db=10.0.3.14:5432 host=internal.prod.svc path=/etc/secrets/key.pem token=sk-LEAKED';
    const safe = toClientSafeError(gatewayError('internal', detail));

    for (const leak of ['10.0.3.14', 'internal.prod.svc', '/etc/secrets', 'sk-LEAKED', ':5432']) {
      expect(safe.message).not.toContain(leak);
    }
  });

  it('collapses an arbitrary thrown Error (with a leaky message) to a generic internal error', () => {
    const leaky = new Error('ECONNREFUSED 192.168.1.7:6379 at /srv/app/api/gateway/pipeline.ts:42');
    const safe = toClientSafeError(leaky);

    expect(safe.code).toBe('internal');
    expect(safe.message).toBe('An unexpected error occurred.');
    expect(safe.message).not.toContain('192.168.1.7');
    expect(safe.message).not.toContain('pipeline.ts');
    expect(safe.retryable).toBe(true);
  });

  it('collapses unknown non-error values to a generic internal error', () => {
    for (const value of [null, undefined, 42, 'raw string', { code: 'not_a_real_code' }]) {
      const safe = toClientSafeError(value);
      expect(safe.code).toBe('internal');
      expect(safe.message).toBe('An unexpected error occurred.');
    }
  });

  it('recognizes only well-formed gateway errors with a known code', () => {
    expect(isGatewayError(gatewayError('forbidden'))).toBe(true);
    expect(isGatewayError({ code: 'made_up' })).toBe(false);
    expect(isGatewayError(null)).toBe(false);
    expect(isGatewayError('forbidden')).toBe(false);
  });
});

describe('InMemoryRateLimiter (per-principal + global, distinct from Session_Budget)', () => {
  it('admits up to the per-principal cap then rejects the next request', () => {
    const limiter = new InMemoryRateLimiter({
      perPrincipalMax: 3,
      globalMax: 1000,
      windowMs: 1000,
    });

    expect(limiter.check('user-a', 0).allowed).toBe(true);
    expect(limiter.check('user-a', 0).allowed).toBe(true);
    expect(limiter.check('user-a', 0).allowed).toBe(true);

    const rejected = limiter.check('user-a', 0);
    expect(rejected.allowed).toBe(false);
    expect(rejected.scope).toBe('principal');
    expect(rejected.retryAfterMs).toBe(1000);
  });

  it('tracks principals independently and resets a window after windowMs', () => {
    const limiter = new InMemoryRateLimiter({
      perPrincipalMax: 1,
      globalMax: 1000,
      windowMs: 1000,
    });

    expect(limiter.check('user-a', 0).allowed).toBe(true);
    expect(limiter.check('user-a', 500).allowed).toBe(false);
    // A different principal has its own fresh window.
    expect(limiter.check('user-b', 0).allowed).toBe(true);
    // Once the full window elapses, the principal is admitted again.
    expect(limiter.check('user-a', 1000).allowed).toBe(true);
  });

  it('rejects once the global cap is hit even for fresh principals', () => {
    const limiter = new InMemoryRateLimiter({ perPrincipalMax: 100, globalMax: 2, windowMs: 1000 });

    expect(limiter.check('user-a', 0).allowed).toBe(true);
    expect(limiter.check('user-b', 0).allowed).toBe(true);

    const rejected = limiter.check('user-c', 0);
    expect(rejected.allowed).toBe(false);
    expect(rejected.scope).toBe('global');
  });

  it('does not consume quota when a request is rejected', () => {
    const limiter = new InMemoryRateLimiter({
      perPrincipalMax: 1,
      globalMax: 1000,
      windowMs: 1000,
    });

    expect(limiter.check('user-a', 0).allowed).toBe(true);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(limiter.check('user-a', 0).allowed).toBe(false);
    }
    // The rejections above consumed no global quota, so another principal is unaffected.
    expect(limiter.check('user-b', 0).allowed).toBe(true);
  });
});

describe('per-object authorization seam (deny-by-default until task 12.1)', () => {
  const principal: AuthenticatedPrincipal = {
    userId: 'user-1',
    sessionId: 'session-1',
    scopes: [],
  };

  it('denies every object-scoped request by default', async () => {
    const decision = await authorizeObject(denyAllObjectAuthorizer, principal, 'project-1');
    expect(isErr(decision)).toBe(true);
    if (isErr(decision)) {
      expect(decision.error.code).toBe('forbidden');
    }
  });

  it('rejects an empty object identifier before consulting the authorizer', async () => {
    let consulted = false;
    const spy: ObjectAuthorizer = {
      authorize() {
        consulted = true;
        return Promise.resolve(authorized());
      },
    };

    const decision = await authorizeObject(spy, principal, '');
    expect(isErr(decision)).toBe(true);
    expect(consulted).toBe(false);
  });

  it('delegates to an injected authorizer that grants access', async () => {
    const allow: ObjectAuthorizer = { authorize: () => Promise.resolve(authorized()) };

    const decision = await authorizeObject(allow, principal, 'project-1');
    expect(isOk(decision)).toBe(true);
  });
});
