// Boundary validation: size, then type, then schema (Req 1.6).
//
// tRPC's static types are ERASED at runtime (OD-7), so static types are not a
// substitute for runtime validation. Every inbound payload is validated here
// with Zod before any handler logic runs, and in the mandated order: reject
// empty and oversized payloads BY SIZE first (cheapest, and a denial-of-service
// guard), then parse the bytes as JSON (type), then validate structure against a
// Zod schema. Each step returns a typed `GatewayError`; the pipeline funnels it
// through the single error-mapper.

import type { ZodType } from 'zod';

import type { Result } from '@app/core';
import { err, ok } from '@app/core';

import { gatewayError, type GatewayError } from './errors.js';

/** Byte length of a UTF-8 string, used for the size gate. */
function byteLength(raw: string): number {
  return Buffer.byteLength(raw, 'utf8');
}

/**
 * Step 1 - size. Reject an empty payload and any payload above `maxBytes`.
 * Runs before parsing so oversized input is never deserialized.
 */
export function checkSize(raw: string, maxBytes: number): Result<string, GatewayError> {
  if (byteLength(raw) === 0) {
    return err(gatewayError('payload_empty', 'inbound payload was empty'));
  }
  if (byteLength(raw) > maxBytes) {
    return err(gatewayError('payload_too_large', 'inbound payload exceeded size cap'));
  }
  return ok(raw);
}

/** Step 2 - type. Parse the raw bytes as JSON; malformed input is rejected. */
export function parseJson(raw: string): Result<unknown, GatewayError> {
  try {
    return ok(JSON.parse(raw));
  } catch {
    // Deliberately discard the parser message: it can echo payload fragments.
    return err(gatewayError('malformed_payload', 'inbound payload was not valid JSON'));
  }
}

/**
 * Step 3 - schema. Validate an already-parsed value against a Zod schema.
 *
 * On failure the Zod issues are summarized into `detail` for server-side
 * diagnosis only; that text never reaches the client (the mapper uses a static
 * message for `schema_invalid`).
 */
export function checkSchema<T>(parsed: unknown, schema: ZodType<T>): Result<T, GatewayError> {
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`)
      .join('; ');
    return err(gatewayError('schema_invalid', detail));
  }
  return ok(result.data);
}

/**
 * Validate MODEL OUTPUT as untrusted before it is executed or presented as
 * correct (Req 17.5).
 *
 * Model output is data, never a judge: passing this check confirms only that the
 * output is well-formed, never that it is CORRECT. Functional correctness stays
 * the deterministic oracle's decision and labeling stays the Trust_Labeler's;
 * nothing here may confer a `Verified` status.
 */
export function validateModelOutput<T>(raw: unknown, schema: ZodType<T>): Result<T, GatewayError> {
  return checkSchema(raw, schema);
}
