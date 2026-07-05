// Property 32: External input and model output are validated at the boundary,
// and errors are sanitized (task 5.2).
//
// This is the universal complement to the example checks in `api-gateway.test.ts`.
// It asserts, over many generated inputs, the four guarantees the API_Gateway
// trust boundary must never break (Design: Property 32; Req 1.3, 1.6, 17.4, 17.5):
//
//   1. Boundary validation is total and precedes any handler: oversized, empty,
//      malformed-JSON, and schema-invalid payloads are ALL rejected, so no
//      unvalidated value is ever produced for a handler to consume.
//   2. Untrusted content is neutralized: injection control content in a valid
//      payload is filtered before the request is forwarded, and model output is
//      validated as untrusted (well-formedness only, never a correctness signal).
//   3. Every failure path returns a sanitized `ClientSafeError` whose message
//      leaks no internal host, IP, file path, stack trace, or secret - even when
//      the internal error deliberately embeds all of those.
//   4. The error-mapper is total: ANY thrown value maps to a sanitized error and
//      an unrecognized cause collapses to the generic `internal` code.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  NEUTRALIZED_PLACEHOLDER,
  enforceInboundPipeline,
  gatewayError,
  toClientSafeError,
  validateModelOutput,
  type AuthAdapter,
  type AuthenticatedPrincipal,
  type ClientSafeError,
  type GatewayConfig,
  type GatewayDeps,
  type GatewayError,
  type InboundRequest,
  type RateLimitDecision,
  type RateLimiter,
} from '@app/api';
import { err, isErr, isOk, ok, type Result } from '@app/core';
import {
  INJECTION_MARKERS,
  absolutePathArbitrary,
  emptyPayloadArbitrary,
  injectionMarkerArbitrary,
  oversizedPayloadArbitrary,
  propertyParameters,
  propertyTag,
  secretShapedTokenArbitrary,
} from '@app/test';

const PROPERTY = propertyTag(
  32,
  'External input and model output are validated at the boundary, and errors are sanitized',
);

// -- Fixtures ---------------------------------------------------------------

/** A small size cap keeps the oversized generator fast while still exceeding it. */
const MAX_PAYLOAD_BYTES = 2048;

/** The one credential the fake auth adapter accepts; everything else is rejected. */
const VALID_CREDENTIAL = 'valid-credential-token';

const PRINCIPAL: AuthenticatedPrincipal = {
  userId: 'user-under-test',
  sessionId: 'session-under-test',
  scopes: [],
};

/** The inbound payload schema under test: an object with a text field and a count. */
const payloadSchema = z.object({
  description: z.string(),
  count: z.number(),
});
type Payload = z.infer<typeof payloadSchema>;

/** A fake auth adapter that admits only `VALID_CREDENTIAL`; never throws. */
function fakeAuth(): AuthAdapter {
  return {
    provider: 'fake',
    verify(credential: string): Promise<Result<AuthenticatedPrincipal, GatewayError>> {
      if (credential === VALID_CREDENTIAL) {
        return Promise.resolve(ok(PRINCIPAL));
      }
      return Promise.resolve(
        err(gatewayError('unauthenticated', 'credential rejected by adapter')),
      );
    },
  };
}

/** A rate limiter with a fixed decision, so the pipeline result is deterministic. */
function fixedRateLimiter(decision: RateLimitDecision): RateLimiter {
  return { check: () => decision };
}

/** A permissive limiter that always admits. */
const ALLOW_ALL: RateLimiter = fixedRateLimiter({ allowed: true });

function deps(rateLimiter: RateLimiter = ALLOW_ALL): GatewayDeps {
  const config: GatewayConfig = { maxPayloadBytes: MAX_PAYLOAD_BYTES };
  return { auth: fakeAuth(), rateLimiter, config };
}

/** Build an inbound request; credential and clock default to a valid, admitted call. */
function inbound(rawBody: string, credential: string | null = VALID_CREDENTIAL): InboundRequest {
  return { rawBody, credential, now: 0 };
}

// -- Generators -------------------------------------------------------------

/**
 * JSON text that is guaranteed to be malformed: an object/array opener followed
 * by bare letters never parses, so the type step must reject it. Bounded well
 * under the size cap so it clears the size gate and fails at parsing.
 */
function malformedJsonArbitrary(): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.constantFrom('{', '['),
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !s.includes('"')),
    )
    .map(([opener, body]) => `${opener}${body}`)
    .filter((raw) => raw.length > 0 && raw.length <= MAX_PAYLOAD_BYTES && !isParseable(raw));
}

/** Whether a string parses as JSON (used to keep the malformed generator honest). */
function isParseable(raw: string): boolean {
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * JSON-serialized values that never satisfy `payloadSchema` (which requires an
 * object): scalars and arrays. All fail the schema step, none the earlier steps.
 */
function schemaInvalidJsonArbitrary(): fc.Arbitrary<string> {
  return fc
    .oneof(
      fc.integer(),
      fc.string({ maxLength: 40 }),
      fc.boolean(),
      fc.constant(null),
      fc.array(fc.integer(), { maxLength: 8 }),
    )
    .map((value) => JSON.stringify(value))
    .filter((raw) => raw.length > 0 && raw.length <= MAX_PAYLOAD_BYTES);
}

/** A valid payload whose free-text field embeds at least one injection marker. */
function injectionPayloadJsonArbitrary(): fc.Arbitrary<string> {
  return fc
    .tuple(injectionMarkerArbitrary(), fc.integer())
    .map(([description, count]) => JSON.stringify({ description, count } satisfies Payload))
    .filter((raw) => raw.length <= MAX_PAYLOAD_BYTES);
}

/**
 * A distinctive host fragment. No shared generator emits hostnames, so this small
 * arbitrary composes one; every fragment carries a `.internal` marker so it can
 * never coincide with a fixed client-safe message.
 */
function internalHostArbitrary(): fc.Arbitrary<string> {
  return fc
    .tuple(fc.constantFrom('db', 'cache', 'orchestrator', 'vault'), fc.integer({ min: 0, max: 99 }))
    .map(([role, n]) => `${role}-${n}.internal.svc.cluster.local`);
}

/** A distinctive IPv4:port fragment, likewise composed locally. */
function internalIpArbitrary(): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.integer({ min: 1, max: 254 }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 1, max: 254 }),
      fc.integer({ min: 1024, max: 65535 }),
    )
    .map(([a, b, c, d, port]) => `${a}.${b}.${c}.${d}:${port}`);
}

/** A stack-frame fragment referencing an internal source path. */
function stackFrameArbitrary(): fc.Arbitrary<string> {
  return fc
    .tuple(absolutePathArbitrary(), fc.integer({ min: 1, max: 9999 }))
    .map(([path, line]) => `at handler (${path}:${line}:7)`);
}

/**
 * A single leaky internal-detail string built by composing the shared secret and
 * path generators with local host/IP/stack fragments, paired with the exact set
 * of needles that must never appear in a client-facing message.
 */
interface LeakyDetail {
  readonly detail: string;
  readonly needles: readonly string[];
}

function leakyDetailArbitrary(): fc.Arbitrary<LeakyDetail> {
  return fc
    .record({
      host: internalHostArbitrary(),
      ip: internalIpArbitrary(),
      path: absolutePathArbitrary(),
      secret: secretShapedTokenArbitrary(),
      frame: stackFrameArbitrary(),
    })
    .map(({ host, ip, path, secret, frame }) => ({
      detail: `connect ${host} (${ip}) reading ${path} with ${secret}\n${frame}`,
      needles: [host, ip, path, secret, frame],
    }));
}

/** Every closed gateway error code, so leak-freedom is asserted for each cause. */
const GATEWAY_CODES = [
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

/** Assert a client-safe error carries a non-empty message and no leaked needle. */
function expectSanitized(safe: ClientSafeError, needles: readonly string[]): void {
  expect(safe.message.length).toBeGreaterThan(0);
  expect(typeof safe.retryable).toBe('boolean');
  for (const needle of needles) {
    expect(safe.message).not.toContain(needle);
  }
}

// -- Properties -------------------------------------------------------------

describe(PROPERTY, () => {
  it('rejects oversized payloads at the boundary before any handler', async () => {
    await fc.assert(
      fc.asyncProperty(oversizedPayloadArbitrary(MAX_PAYLOAD_BYTES + 1), async (rawBody) => {
        const result = await enforceInboundPipeline(deps(), payloadSchema, inbound(rawBody));
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.code).toBe('payload_too_large');
          expectSanitized(result.error, [rawBody]);
        }
      }),
      propertyParameters(),
    );
  });

  it('rejects empty payloads at the boundary before any handler', async () => {
    await fc.assert(
      fc.asyncProperty(emptyPayloadArbitrary(), async (rawBody) => {
        const result = await enforceInboundPipeline(deps(), payloadSchema, inbound(rawBody));
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.code).toBe('payload_empty');
        }
      }),
      propertyParameters(),
    );
  });

  it('rejects malformed JSON at the boundary before any handler', async () => {
    await fc.assert(
      fc.asyncProperty(malformedJsonArbitrary(), async (rawBody) => {
        const result = await enforceInboundPipeline(deps(), payloadSchema, inbound(rawBody));
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.code).toBe('malformed_payload');
          // The parser message can echo payload fragments; it must not leak.
          expectSanitized(result.error, [rawBody]);
        }
      }),
      propertyParameters(),
    );
  });

  it('rejects schema-invalid shapes at the boundary before any handler', async () => {
    await fc.assert(
      fc.asyncProperty(schemaInvalidJsonArbitrary(), async (rawBody) => {
        const result = await enforceInboundPipeline(deps(), payloadSchema, inbound(rawBody));
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.code).toBe('schema_invalid');
        }
      }),
      propertyParameters(),
    );
  });

  it('neutralizes injection control content in a valid payload before forwarding', async () => {
    await fc.assert(
      fc.asyncProperty(injectionPayloadJsonArbitrary(), async (rawBody) => {
        const result = await enforceInboundPipeline(deps(), payloadSchema, inbound(rawBody));
        expect(isOk(result)).toBe(true);
        if (isOk(result)) {
          expect(result.value.injection.neutralized).toBe(true);
          expect(result.value.injection.markersFound.length).toBeGreaterThan(0);
          const forwarded = result.value.value.description;
          expect(forwarded).toContain(NEUTRALIZED_PLACEHOLDER);
          for (const marker of INJECTION_MARKERS) {
            expect(forwarded).not.toContain(marker);
          }
        }
      }),
      propertyParameters(),
    );
  });

  it('validates model output as untrusted: valid shapes pass, invalid shapes are rejected', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer(),
          fc.string(),
          fc.boolean(),
          fc.constant(null),
          fc.array(fc.anything()),
          fc.record({ description: fc.string() }),
        ),
        fc.record({ description: fc.string(), count: fc.integer() }),
        (invalidRaw, validRaw) => {
          expect(isErr(validateModelOutput(invalidRaw, payloadSchema))).toBe(true);

          const validated = validateModelOutput(validRaw, payloadSchema);
          expect(isOk(validated)).toBe(true);
          if (isOk(validated)) {
            // Structural equality only: the validator returns a fresh plain object,
            // so prototypes may differ from a null-prototype generated input.
            expect(validated.value.description).toBe(validRaw.description);
            expect(validated.value.count).toBe(validRaw.count);
          }
        },
      ),
      propertyParameters(),
    );
  });

  it('sanitizes every failure path so no internal host, IP, path, stack, or secret leaks', () => {
    fc.assert(
      fc.property(fc.constantFrom(...GATEWAY_CODES), leakyDetailArbitrary(), (code, leaky) => {
        // Internal detail is deliberately packed with leak needles.
        const safe = toClientSafeError(gatewayError(code, leaky.detail));
        expect(safe.code).toBe(code);
        expectSanitized(safe, leaky.needles);

        // A raw thrown Error whose message embeds the same needles collapses safely.
        const thrown = toClientSafeError(new Error(leaky.detail));
        expect(thrown.code).toBe('internal');
        expect(thrown.message).toBe('An unexpected error occurred.');
        expectSanitized(thrown, leaky.needles);
      }),
      propertyParameters(),
    );
  });

  it('maps ANY thrown value to a sanitized error, collapsing unknown causes to internal', () => {
    fc.assert(
      fc.property(fc.anything(), (thrown) => {
        const safe = toClientSafeError(thrown);
        expect(GATEWAY_CODES).toContain(safe.code);
        expect(safe.message.length).toBeGreaterThan(0);
        expect(typeof safe.retryable).toBe('boolean');

        // Only a well-formed GatewayError keeps its code; everything else is internal.
        const isGatewayShaped =
          typeof thrown === 'object' &&
          thrown !== null &&
          typeof (thrown as { code?: unknown }).code === 'string' &&
          (GATEWAY_CODES as readonly string[]).includes((thrown as { code: string }).code);
        if (!isGatewayShaped) {
          expect(safe.code).toBe('internal');
          expect(safe.message).toBe('An unexpected error occurred.');
        }
      }),
      propertyParameters(),
    );
  });

  it('returns a sanitized error when authentication fails, leaking no adapter detail', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ description: fc.string({ maxLength: 40 }), count: fc.integer() }),
        leakyDetailArbitrary(),
        async (payload, leaky) => {
          const rawBody = JSON.stringify(payload);
          fc.pre(rawBody.length > 0 && rawBody.length <= MAX_PAYLOAD_BYTES);
          // A wrong credential fails auth after size/type/schema have passed.
          const result = await enforceInboundPipeline(
            deps(),
            payloadSchema,
            inbound(rawBody, 'wrong-credential'),
          );
          expect(isErr(result)).toBe(true);
          if (isErr(result)) {
            expect(result.error.code).toBe('unauthenticated');
            expectSanitized(result.error, leaky.needles);
          }
        },
      ),
      propertyParameters(),
    );
  });

  it('returns a sanitized error when a downstream collaborator throws leaky detail', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ description: fc.string({ maxLength: 40 }), count: fc.integer() }),
        leakyDetailArbitrary(),
        async (payload, leaky) => {
          const rawBody = JSON.stringify(payload);
          fc.pre(rawBody.length > 0 && rawBody.length <= MAX_PAYLOAD_BYTES);
          // An auth adapter that throws a leaky Error must be caught and sanitized.
          const throwingDeps: GatewayDeps = {
            auth: {
              provider: 'throwing',
              verify: () => Promise.reject(new Error(leaky.detail)),
            },
            rateLimiter: ALLOW_ALL,
            config: { maxPayloadBytes: MAX_PAYLOAD_BYTES },
          };
          const result = await enforceInboundPipeline(
            throwingDeps,
            payloadSchema,
            inbound(rawBody),
          );
          expect(isErr(result)).toBe(true);
          if (isErr(result)) {
            expect(result.error.code).toBe('internal');
            expectSanitized(result.error, leaky.needles);
          }
        },
      ),
      propertyParameters(),
    );
  });
});
