// An environment-backed `SecretManagerPort` (Req 12.6-12.9).
//
// This is the ONE module in the agent layer permitted to read the ambient process
// environment. Every other module receives its configuration by injection, so the
// blast radius of "where can a credential come from" is exactly this file.
//
// It resolves a non-secret credential ref (`providerCredentialRef`) to the value of
// the environment variable that holds that provider's credential. Rules it keeps:
//
//   - it never throws: a missing, blank, or non-string variable is the typed
//     `SECRET_NOT_FOUND` failure, so a caller handles absence explicitly;
//   - it never logs, returns, or embeds the value in a diagnostic;
//   - the ref -> variable mapping stays module-private and is never surfaced on the
//     instance or in a reason string, so a diagnostic cannot be used to enumerate or
//     probe the environment.
//
// `InMemorySecretManager` in `secret-manager.ts` remains the fake for tests; this is
// the concrete manager a local or single-tenant deployment injects. A managed secret
// manager / KMS implementation would implement the same port and replace it without
// touching an adapter.

import { err, ok, type Result } from '@app/core';

import { providerCredentialRef } from './secret-manager.js';
import type { SecretManagerPort, SecretResolutionError } from './secret-manager.js';

/**
 * The environment variable holding the bedrock-mantle bearer token.
 *
 * A variable NAME, never a value: safe to export so deployment docs, `.env.example`,
 * and tests reference one source of truth instead of repeating the string.
 */
export const BEDROCK_CREDENTIAL_ENV_KEY = 'AWS_BEARER_TOKEN_BEDROCK';

/** A read-only view of an environment: variable names to raw values. */
export type EnvironmentMap = Readonly<Record<string, string | undefined>>;

/**
 * Credential ref -> environment variable name.
 *
 * Module-private on purpose: exposing the table would hand a caller a way to walk
 * every credential source at once, which is exactly the confinement this port exists
 * to prevent. Only bedrock-mantle is mapped today; the other providers are served by
 * a managed secret manager, so an unmapped ref is a clean `SECRET_NOT_FOUND`.
 */
const ENV_KEY_BY_REF: Readonly<Record<string, string>> = {
  [providerCredentialRef('bedrock-mantle')]: BEDROCK_CREDENTIAL_ENV_KEY,
};

/** The host object that carries a process environment, when the runtime has one. */
interface ProcessEnvironmentHost {
  readonly env?: EnvironmentMap;
}

/**
 * The ambient process environment, or an empty map when the host has none.
 *
 * Reached without depending on a runtime's global typings, matching how the agent
 * layer reaches the host timer. A host with no process (a browser bundle) yields an
 * empty map, so resolution reports `SECRET_NOT_FOUND` instead of throwing.
 */
function processEnvironment(): EnvironmentMap {
  const host = (globalThis as { process?: ProcessEnvironmentHost }).process;
  return host?.env ?? {};
}

/**
 * The single failure this manager reports.
 *
 * The reason names the ref, which is a non-secret pointer, and nothing else: not the
 * variable name, not its presence, and never its value.
 */
function notFound(ref: string): Result<string, SecretResolutionError> {
  return err({ code: 'SECRET_NOT_FOUND', reason: `no environment credential for ref ${ref}` });
}

/**
 * A `SecretManagerPort` that reads provider credentials from the environment.
 *
 * The environment map is injected (defaulting to the ambient one) so tests and a
 * composition root can supply an explicit map instead of mutating global state.
 */
export class EnvSecretManager implements SecretManagerPort {
  readonly #env: EnvironmentMap;

  constructor(env: EnvironmentMap = processEnvironment()) {
    this.#env = env;
  }

  /**
   * Resolve one credential ref to its value, or report a typed absence.
   *
   * The environment is external input, so the raw value is validated before use: a
   * non-string or whitespace-only variable counts as unset rather than resolving to
   * a blank credential that would fail deep inside a provider call.
   */
  resolveSecret(ref: string): Promise<Result<string, SecretResolutionError>> {
    const envKey = ENV_KEY_BY_REF[ref];
    if (envKey === undefined) {
      return Promise.resolve(notFound(ref));
    }
    const raw = this.#env[envKey];
    if (typeof raw !== 'string') {
      return Promise.resolve(notFound(ref));
    }
    const value = raw.trim();
    if (value.length === 0) {
      return Promise.resolve(notFound(ref));
    }
    return Promise.resolve(ok(value));
  }
}
