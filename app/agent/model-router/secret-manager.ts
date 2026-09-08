// Secret-manager port and per-provider credential confinement (Req 12.6-12.10).
//
// The router NEVER touches this port. Each vendor adapter is constructed with a
// `ProviderCredentialResolver` scoped to exactly its own provider, so an adapter
// is structurally incapable of naming another provider's secret. Credentials are
// resolved from the secret manager at the point of use (inside the adapter's
// outbound call) and are never stored in shared router/Orchestrator state, placed
// in a prompt, or put on any cross-component payload.
//
// The concrete secret manager (a cloud secret manager / KMS) implements
// `SecretManagerPort` and is injected at deployment; this module intentionally
// provides only the port, the scoping, and an in-memory fake for tests. It does
// not read process.env for credentials.

import { err, ok, type Result } from '@app/core';

import type { ProviderName } from './contract.js';

/** Why a secret could not be resolved. Never carries the secret value itself. */
export interface SecretResolutionError {
  readonly code: 'SECRET_NOT_FOUND' | 'SECRET_ACCESS_DENIED';
  /** A short, non-sensitive reason; references the ref, never a value. */
  readonly reason: string;
}

/**
 * Resolves a secret VALUE by opaque reference at the point of use.
 *
 * Callers must never persist, log, return, or embed a resolved value. The ref is
 * a non-secret pointer; the value it resolves to is the secret.
 */
export interface SecretManagerPort {
  resolveSecret(ref: string): Promise<Result<string, SecretResolutionError>>;
}

/**
 * A credential accessor confined to exactly one provider (Req 12.8).
 *
 * A vendor adapter holds only this, never the broad `SecretManagerPort`, so it can
 * resolve its own provider's credential and no other, even when several adapters
 * are active at once.
 */
export interface ProviderCredentialResolver {
  readonly provider: ProviderName;
  resolve(): Promise<Result<string, SecretResolutionError>>;
}

/**
 * The canonical, non-secret reference for a provider's credential.
 *
 * This is a pointer, not a value, so it is safe to surface in routing diagnostics
 * (Req 12.10). The concrete secret manager maps this ref to the stored secret.
 */
export function providerCredentialRef(provider: ProviderName): string {
  return `secret://provider/${provider}/api-key`;
}

/**
 * Confine a broad `SecretManagerPort` to a single provider's credential.
 *
 * The returned resolver can resolve ONLY that provider's ref; it never exposes the
 * underlying manager and cannot name another provider's secret, so an adapter
 * built from it cannot reach a sibling provider's key (Req 12.7, 12.8).
 */
export function scopeToProvider(
  secretManager: SecretManagerPort,
  provider: ProviderName,
): ProviderCredentialResolver {
  const ref = providerCredentialRef(provider);
  return {
    provider,
    resolve: () => secretManager.resolveSecret(ref),
  };
}

/**
 * An in-memory `SecretManagerPort` for tests ONLY.
 *
 * It holds synthetic tokens keyed by ref and records the refs (pointers, never
 * values) it was asked to resolve, so a test can assert an adapter resolved only
 * its own provider's credential (Req 12.8, smoke test 9.4).
 */
export class InMemorySecretManager implements SecretManagerPort {
  readonly #secrets: ReadonlyMap<string, string>;
  readonly #accessedRefs: string[] = [];

  constructor(secrets: Readonly<Record<string, string>>) {
    this.#secrets = new Map(Object.entries(secrets));
  }

  resolveSecret(ref: string): Promise<Result<string, SecretResolutionError>> {
    this.#accessedRefs.push(ref);
    const value = this.#secrets.get(ref);
    if (value === undefined) {
      return Promise.resolve(
        err({ code: 'SECRET_NOT_FOUND', reason: `no secret registered for ref ${ref}` }),
      );
    }
    return Promise.resolve(ok(value));
  }

  /** The refs (non-secret pointers) resolved so far, for confinement assertions. */
  get accessedRefs(): readonly string[] {
    return [...this.#accessedRefs];
  }
}
