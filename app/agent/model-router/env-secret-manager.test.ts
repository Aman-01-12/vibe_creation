// Unit tests for the environment-backed secret manager (Req 12.6-12.9).
//
// Every case runs against an INJECTED environment map, so no test mutates ambient
// process state and no test needs a real credential. The values here are synthetic.
//
// What these examples pin: the bedrock credential ref resolves from
// `AWS_BEARER_TOKEN_BEDROCK`; an unset, blank, or unmapped ref is the typed
// `SECRET_NOT_FOUND` failure rather than a throw or a blank credential; and no
// diagnostic carries the value or the variable name that holds it.

import { describe, expect, it } from 'vitest';

import {
  BEDROCK_CREDENTIAL_ENV_KEY,
  EnvSecretManager,
  type EnvironmentMap,
} from './env-secret-manager.js';
import { providerCredentialRef } from './secret-manager.js';

/** A synthetic credential. Never a real token. */
const SYNTHETIC_CREDENTIAL = 'synthetic-bearer-value-for-tests';

const BEDROCK_REF = providerCredentialRef('bedrock-mantle');

/** An environment carrying only the bedrock credential. */
function envWith(value: string | undefined): EnvironmentMap {
  return value === undefined ? {} : { [BEDROCK_CREDENTIAL_ENV_KEY]: value };
}

describe('EnvSecretManager - resolving a mapped credential', () => {
  it('resolves the bedrock ref from its environment variable', async () => {
    const manager = new EnvSecretManager(envWith(SYNTHETIC_CREDENTIAL));

    const resolved = await manager.resolveSecret(BEDROCK_REF);

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value).toBe(SYNTHETIC_CREDENTIAL);
  });

  it('trims surrounding whitespace, which a copied token commonly carries', async () => {
    const manager = new EnvSecretManager(envWith(`  ${SYNTHETIC_CREDENTIAL}\n`));

    const resolved = await manager.resolveSecret(BEDROCK_REF);

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value).toBe(SYNTHETIC_CREDENTIAL);
  });
});

describe('EnvSecretManager - typed absence instead of a throw', () => {
  it('reports SECRET_NOT_FOUND when the variable is unset', async () => {
    const manager = new EnvSecretManager(envWith(undefined));

    const resolved = await manager.resolveSecret(BEDROCK_REF);

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.code).toBe('SECRET_NOT_FOUND');
  });

  it('treats a blank variable as unset rather than a blank credential', async () => {
    const manager = new EnvSecretManager(envWith('   \t\n'));

    const resolved = await manager.resolveSecret(BEDROCK_REF);

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.code).toBe('SECRET_NOT_FOUND');
  });

  it('reports SECRET_NOT_FOUND for a provider it does not map', async () => {
    const manager = new EnvSecretManager(envWith(SYNTHETIC_CREDENTIAL));

    const resolved = await manager.resolveSecret(providerCredentialRef('deepseek'));

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.code).toBe('SECRET_NOT_FOUND');
  });

  it('does not throw on an unknown ref shape', async () => {
    const manager = new EnvSecretManager(envWith(SYNTHETIC_CREDENTIAL));

    const resolved = await manager.resolveSecret('not-a-ref');

    expect(resolved.ok).toBe(false);
  });

  it('does not throw when constructed against the ambient environment', async () => {
    const manager = new EnvSecretManager();

    const resolved = await manager.resolveSecret(providerCredentialRef('gemini'));

    // Asserted on the outcome shape only: the ambient environment is not this
    // test's to know, and a resolved value must never be printed or compared.
    expect(resolved.ok).toBe(false);
  });
});

describe('EnvSecretManager - diagnostics leak nothing', () => {
  it('never names the value or the variable that holds it', async () => {
    const manager = new EnvSecretManager(envWith(undefined));

    const resolved = await manager.resolveSecret(BEDROCK_REF);

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.reason).not.toContain(BEDROCK_CREDENTIAL_ENV_KEY);
    expect(resolved.error.reason).not.toContain(SYNTHETIC_CREDENTIAL);
    // The ref is a non-secret pointer, so naming it keeps the failure diagnosable.
    expect(resolved.error.reason).toContain(BEDROCK_REF);
  });
});
