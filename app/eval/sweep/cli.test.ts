// Unit tests for the sweep CLI's argument parsing and its preflight refusals.
//
// These are the tests that prove the CLI cannot start a run that would produce nothing.
// Every one of them runs WITHOUT a credential, without a network, and without a toolchain,
// which is exactly the situation the fail-fast path exists for: the refusal happens before
// any provider is reached, so nothing is spent and the message names the fix.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { InMemorySecretManager, providerCredentialRef, type SecretManagerPort } from '@app/agent';

import { parseSweepArgs, runSweep, runSweepCli, summarizeSweepRun } from './cli.js';
import {
  checkCorpus,
  checkCredential,
  renderPreflightFailure,
  toolchainFailure,
  type CheckoutPresencePort,
} from './preflight.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The committed example config; a real, valid campaign definition. */
const EXAMPLE_CONFIG = resolve(HERE, 'sweep.config.example.json');

/** A secret manager holding no credential at all. */
const NO_CREDENTIAL: SecretManagerPort = new InMemorySecretManager({});

/** A secret manager holding the bedrock-mantle credential. */
const WITH_CREDENTIAL: SecretManagerPort = new InMemorySecretManager({
  [providerCredentialRef('bedrock-mantle')]: 'never-logged-test-value',
});

/** A checkout probe that reports a fixed presence. */
function presenceProbe(
  presence: 'absent' | 'non-repository' | 'git-repository',
): CheckoutPresencePort {
  return { inspect: () => Promise.resolve(presence) };
}

describe('parseSweepArgs', () => {
  it('parses a run invocation', () => {
    expect(parseSweepArgs(['--config', 'sweep.json'])).toEqual({
      kind: 'run',
      configPath: 'sweep.json',
    });
  });

  it('parses a summarize invocation', () => {
    expect(parseSweepArgs(['--summarize', '.eval-runs/x'])).toEqual({
      kind: 'summarize',
      runDir: '.eval-runs/x',
    });
  });

  it('refuses an unrecognized flag rather than guessing', () => {
    expect(parseSweepArgs(['--run', 'x']).kind).toBe('usage');
  });

  it('refuses a missing value', () => {
    expect(parseSweepArgs(['--config']).kind).toBe('usage');
  });

  it('refuses an empty value', () => {
    expect(parseSweepArgs(['--config', '   ']).kind).toBe('usage');
  });

  it('refuses extra arguments', () => {
    expect(parseSweepArgs(['--config', 'a', '--summarize', 'b']).kind).toBe('usage');
  });
});

describe('preflight - the credential', () => {
  it('refuses when no credential is available, naming the variable and the file', async () => {
    const failure = await checkCredential(NO_CREDENTIAL);
    expect(failure?.code).toBe('credential-missing');
    expect(failure?.fix).toContain('AWS_BEARER_TOKEN_BEDROCK');
    expect(failure?.fix).toContain('.env');
    expect(failure?.fix).toContain('never put it in the sweep config');
  });

  it('passes when the credential resolves, without echoing its value', async () => {
    expect(await checkCredential(WITH_CREDENTIAL)).toBeNull();
  });

  it('never echoes the credential value in the refusal text', async () => {
    const failure = await checkCredential(WITH_CREDENTIAL);
    expect(failure).toBeNull();
    const rendered = renderPreflightFailure(
      (await checkCredential(NO_CREDENTIAL)) ?? {
        code: 'credential-missing',
        problem: '',
        fix: '',
      },
    ).join('\n');
    expect(rendered).not.toContain('never-logged-test-value');
  });
});

describe('preflight - the corpus', () => {
  it('refuses an absent checkout and names the fetch command', async () => {
    const failure = await checkCorpus(presenceProbe('absent'), '/nowhere');
    expect(failure?.code).toBe('corpus-missing');
    expect(failure?.fix).toContain('npm run corpus:fetch');
  });

  it('refuses a hand-copied tree, because its provenance cannot be verified', async () => {
    const failure = await checkCorpus(presenceProbe('non-repository'), '/nowhere');
    expect(failure?.problem).toContain('provenance');
  });

  it('passes for a verified git checkout', async () => {
    expect(await checkCorpus(presenceProbe('git-repository'), '/somewhere')).toBeNull();
  });
});

describe('preflight - the toolchain', () => {
  it('names the tools to install and never substitutes a fake oracle', () => {
    const failure = toolchainFailure('iverilog is not installed on PATH');
    expect(failure.code).toBe('toolchain-missing');
    expect(failure.problem).toContain('iverilog is not installed on PATH');
    expect(failure.fix).toContain('iverilog');
    expect(failure.fix).toContain('vvp');
  });
});

describe('runSweep - the fail-fast path', () => {
  it('exits non-zero with the credential fix when no credential is set', async () => {
    const result = await runSweep(EXAMPLE_CONFIG, { secretManager: NO_CREDENTIAL });
    expect(result.exitCode).toBe(1);
    const text = result.lines.join('\n');
    expect(text).toContain('eval sweep refused to start');
    expect(text).toContain('AWS_BEARER_TOKEN_BEDROCK');
  });

  it('exits non-zero for a config file that does not exist', async () => {
    const result = await runSweep(resolve(HERE, 'no-such-config.json'), {
      secretManager: WITH_CREDENTIAL,
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('could not be read');
  });

  it('exits non-zero for an invalid config, naming the offending field', async () => {
    // The package's own tsconfig is valid JSON and an invalid sweep config, so this
    // exercises the parse-failure path without adding a broken fixture to the tree.
    const result = await runSweep(resolve(HERE, '..', 'tsconfig.json'), {
      secretManager: WITH_CREDENTIAL,
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('the sweep config is invalid');
  });

  it('checks the config BEFORE the credential, so a typo is reported without a token', async () => {
    const result = await runSweep(resolve(HERE, '..', 'tsconfig.json'), {
      secretManager: NO_CREDENTIAL,
    });
    expect(result.lines.join('\n')).toContain('the sweep config is invalid');
  });
});

describe('summarizeSweepRun', () => {
  it('reports honestly when a directory holds no results log', async () => {
    const result = await summarizeSweepRun(resolve(HERE, 'no-such-run-dir'));
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('no results log');
  });
});

describe('runSweepCli', () => {
  it('prints usage and exits non-zero for a malformed invocation', async () => {
    const result = await runSweepCli(['--nonsense']);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('--config');
  });
});
