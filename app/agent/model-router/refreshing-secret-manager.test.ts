// The runnable check behind the Credential_File provider: a refreshed file reaches the next
// request, every unusable file is the typed absence, and no diagnostic quotes the file.
// Every value here is obviously fake, and no test reads a real file.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CREDENTIAL_FILE,
  RefreshingSecretManager,
  type ReadTextFile,
} from './refreshing-secret-manager.js';
import { BEDROCK_CREDENTIAL_ENV_KEY, EnvSecretManager } from './env-secret-manager.js';
import { providerCredentialRef } from './secret-manager.js';

const FIRST = 'not-a-real-credential-first';
const SECOND = 'not-a-real-credential-second';

const SERVED_REF = providerCredentialRef('bedrock-mantle');
const PATH = '.secrets/fake-test-token';

/** A reader whose contents change between calls, which is the refresh under test. */
function readerOver(contents: readonly (string | null)[]): {
  readonly read: ReadTextFile;
  readonly paths: readonly string[];
} {
  const paths: string[] = [];
  let call = 0;
  const read: ReadTextFile = (path) => {
    paths.push(path);
    const next = contents[Math.min(call, contents.length - 1)] ?? null;
    call += 1;
    return Promise.resolve(next);
  };
  return { read, paths };
}

function managerOver(contents: readonly (string | null)[]): {
  readonly manager: RefreshingSecretManager;
  readonly paths: readonly string[];
} {
  const reader = readerOver(contents);
  const manager = new RefreshingSecretManager({ path: PATH, readFile: reader.read });
  return { manager, paths: reader.paths };
}

describe('RefreshingSecretManager', () => {
  it('given a file that changed, when asked again, then the later request sees the change', async () => {
    const { manager } = managerOver([FIRST, SECOND]);

    const before = await manager.resolveSecret(SERVED_REF);
    const after = await manager.resolveSecret(SERVED_REF);

    expect(before.ok && before.value).toBe(FIRST);
    expect(after.ok && after.value).toBe(SECOND);
  });

  it('reads the declared path once per request', async () => {
    const { manager, paths } = managerOver([FIRST]);

    await manager.resolveSecret(SERVED_REF);
    await manager.resolveSecret(SERVED_REF);

    expect(paths).toEqual([PATH, PATH]);
  });

  it.each([
    ['absent', null],
    ['empty', ''],
    ['whitespace only', ' \t\n '],
  ])('given a %s file, then it reports the typed absence', async (_shape, contents) => {
    const { manager } = managerOver([contents]);

    const result = await manager.resolveSecret(SERVED_REF);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('SECRET_NOT_FOUND');
  });

  it('given a reader that rejects, then it reports the absence rather than throwing', async () => {
    const manager = new RefreshingSecretManager({
      path: PATH,
      readFile: () => Promise.reject(new Error('EACCES')),
    });

    const result = await manager.resolveSecret(SERVED_REF);

    expect(!result.ok && result.error.code).toBe('SECRET_NOT_FOUND');
  });

  it('given a ref the Credential_File does not serve, then it reads no file at all', async () => {
    const { manager, paths } = managerOver([FIRST]);

    const result = await manager.resolveSecret(providerCredentialRef('claude'));

    expect(!result.ok && result.error.code).toBe('SECRET_NOT_FOUND');
    expect(paths).toEqual([]);
  });

  it('given an environment that holds the credential and no file, then it still reports absence', async () => {
    // The environment is handed to `EnvSecretManager` explicitly rather than set on the host, so
    // the claim is tested without mutating global state a sibling test file shares.
    const environment = { [BEDROCK_CREDENTIAL_ENV_KEY]: FIRST };
    const viaEnvironment = await new EnvSecretManager(environment).resolveSecret(SERVED_REF);
    const { manager } = managerOver([null]);

    const viaFile = await manager.resolveSecret(SERVED_REF);

    // The positive control: that same environment does satisfy the environment-backed manager,
    // so the absence below is this manager ignoring it and not an unresolvable ref.
    expect(viaEnvironment.ok).toBe(true);
    expect(!viaFile.ok && viaFile.error.code).toBe('SECRET_NOT_FOUND');
  });

  it('names the ref in its reason and never what the file held', async () => {
    const { manager } = managerOver([FIRST]);

    const result = await manager.resolveSecret(providerCredentialRef('claude'));
    const reason = result.ok ? '' : result.error.reason;

    expect(reason).toContain(providerCredentialRef('claude'));
    expect(reason).not.toContain(FIRST);
  });

  it('defaults to a Credential_File inside its own directory, so the directory can be ignored', () => {
    expect(DEFAULT_CREDENTIAL_FILE).toContain('/');
    expect(DEFAULT_CREDENTIAL_FILE.startsWith('.secrets/')).toBe(true);
  });
});
