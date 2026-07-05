// Authentication behind a managed-auth adapter (OD-4).
//
// The gateway never talks to an identity vendor directly and never embeds a
// vendor SDK or a secret in source. It depends only on the `AuthAdapter`
// interface below; a concrete adapter (managed OIDC/SAML provider per OD-4) is
// injected at composition time and resolves its own configuration and signing
// keys from the environment or a secret manager via `resolveAuthConfigFromEnv`.
//
// Data residency (OD-2): the provider region is configuration, not code. It is
// carried on `AuthAdapterConfig.dataResidencyRegion` and chosen to satisfy India
// DPDP and GDPR-style expectations because the identity store holds student PII.
// It is documented here as a config seam so a residency change never touches the
// gateway logic.

import type { Ulid } from '@app/core';

import { gatewayError, type GatewayError } from './errors.js';
import type { Result } from '@app/core';
import { err, ok } from '@app/core';

/**
 * The authenticated caller, derived from a verified credential.
 *
 * `userId` is the stable subject used for per-object authorization and per-user
 * rate limiting. No credential material is ever carried on this object.
 */
export interface AuthenticatedPrincipal {
  readonly userId: Ulid;
  readonly sessionId: string;
  readonly scopes: readonly string[];
}

/**
 * The provider-agnostic authentication port.
 *
 * A credential (typically a bearer token) is verified server-side; the adapter
 * owns all vendor specifics and confines any signing secret to itself. Expected
 * failures return a typed `unauthenticated` error rather than throwing.
 */
export interface AuthAdapter {
  /** An opaque provider label for diagnostics; never a secret. */
  readonly provider: string;
  verify(credential: string): Promise<Result<AuthenticatedPrincipal, GatewayError>>;
}

/**
 * Non-secret configuration for a managed-auth adapter.
 *
 * The values that identify the provider are safe to hold in config; the actual
 * verification key/secret is resolved inside the adapter from the secret manager
 * at the point of use and is deliberately absent from this shape.
 */
export interface AuthAdapterConfig {
  readonly issuer: string;
  readonly audience: string;
  /** JWKS endpoint or equivalent key source; a URL, never a key value. */
  readonly jwksUri: string;
  /** Residency region for the identity store (OD-2 DPDP/GDPR). */
  readonly dataResidencyRegion: string;
}

/** Environment variable names the adapter config is resolved from. */
const ENV_KEYS = {
  issuer: 'AUTH_ISSUER',
  audience: 'AUTH_AUDIENCE',
  jwksUri: 'AUTH_JWKS_URI',
  region: 'AUTH_DATA_RESIDENCY_REGION',
} as const;

/**
 * Resolve non-secret auth configuration from an environment map.
 *
 * Reads only from the injected `env` (defaulting to `process.env`) so no value
 * is hardcoded. Returns a typed `internal` error when a required key is missing,
 * rather than starting with a partial, unsafe configuration.
 */
export function resolveAuthConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Result<AuthAdapterConfig, GatewayError> {
  const issuer = env[ENV_KEYS.issuer];
  const audience = env[ENV_KEYS.audience];
  const jwksUri = env[ENV_KEYS.jwksUri];
  const region = env[ENV_KEYS.region];
  if (!issuer || !audience || !jwksUri || !region) {
    return err(gatewayError('internal', 'auth configuration is incomplete'));
  }
  return ok({ issuer, audience, jwksUri, dataResidencyRegion: region });
}
