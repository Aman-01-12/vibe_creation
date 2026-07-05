// The single error boundary for the API_Gateway.
//
// Two error vocabularies live here and only here:
//
//   - `GatewayError` is INTERNAL. Its `code` drives control flow and its
//     `detail` may carry diagnostic context for server-side logging (never for
//     the client). It is never serialized to the Editor.
//   - `ClientSafeError` is what crosses the trust boundary to the Editor. Its
//     `message` is a fixed, static string chosen by `code` alone; no internal
//     value is ever interpolated into it.
//
// `toClientSafeError` is the ONE place a client-facing error is produced
// (Design: Error Handling; Req 1.3, 17.4). Because the client message is looked
// up from a static table keyed by a closed code, it is impossible for a host,
// IP, file path, stack trace, or secret to leak through it: the raw internal
// error text is never copied into the output. Any unrecognized throwable
// collapses to the generic `internal` code, failing safe.

/** Internal, closed set of failure causes at the gateway boundary. */
export type GatewayErrorCode =
  | 'payload_empty'
  | 'payload_too_large'
  | 'malformed_payload'
  | 'schema_invalid'
  | 'unauthenticated'
  | 'forbidden'
  | 'rate_limited'
  | 'unsafe_content'
  | 'not_found'
  | 'internal';

/**
 * A typed internal failure. `detail` is for server-side diagnosis only and MUST
 * NOT be forwarded to the client; the mapper never reads it into client output.
 */
export interface GatewayError {
  readonly code: GatewayErrorCode;
  readonly detail?: string;
}

/** Construct a `GatewayError`, attaching `detail` only when supplied. */
export function gatewayError(code: GatewayErrorCode, detail?: string): GatewayError {
  return detail === undefined ? { code } : { code, detail };
}

/** Type guard: is this value one of our typed gateway errors? */
export function isGatewayError(value: unknown): value is GatewayError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { code?: unknown };
  return typeof candidate.code === 'string' && candidate.code in CLIENT_SAFE_TABLE;
}

/** Stable, client-facing error codes (a superset-safe projection of the internal codes). */
export type ClientSafeErrorCode = GatewayErrorCode;

/** The only shape of error the Editor ever receives. */
export interface ClientSafeError {
  readonly code: ClientSafeErrorCode;
  /** A fixed, safe message chosen by `code`; never derived from internal state. */
  readonly message: string;
  /** Whether the client may reasonably retry the same request unchanged. */
  readonly retryable: boolean;
}

/** Static message + retry policy per code. Values are compile-time constants. */
const CLIENT_SAFE_TABLE: Readonly<
  Record<GatewayErrorCode, { message: string; retryable: boolean }>
> = {
  payload_empty: { message: 'Request payload was empty.', retryable: false },
  payload_too_large: { message: 'Request payload exceeded the allowed size.', retryable: false },
  malformed_payload: { message: 'Request payload was not valid JSON.', retryable: false },
  schema_invalid: { message: 'Request did not match the expected shape.', retryable: false },
  unauthenticated: { message: 'Authentication is required.', retryable: false },
  forbidden: { message: 'You do not have access to this resource.', retryable: false },
  rate_limited: {
    message: 'Too many requests. Please slow down and retry later.',
    retryable: true,
  },
  unsafe_content: {
    message: 'Request content was rejected by the safety filter.',
    retryable: false,
  },
  not_found: { message: 'The requested resource was not found.', retryable: false },
  internal: { message: 'An unexpected error occurred.', retryable: true },
};

/**
 * Map ANY value to a sanitized `ClientSafeError`.
 *
 * Recognized `GatewayError`s map by their code; every other throwable (including
 * raw `Error`s whose message may embed internal detail) collapses to `internal`.
 * The returned message comes only from the static table, so no internal string
 * ever reaches the client.
 */
export function toClientSafeError(value: unknown): ClientSafeError {
  const code: GatewayErrorCode = isGatewayError(value) ? value.code : 'internal';
  const entry = CLIENT_SAFE_TABLE[code];
  return { code, message: entry.message, retryable: entry.retryable };
}
