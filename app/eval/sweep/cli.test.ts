// Unit tests for the sweep CLI's argument parsing, its preflight refusals, and the one
// composition decision the artifact store is built from.
//
// These are the tests that prove the CLI cannot start a run that would produce nothing.
// Every one of them runs WITHOUT a credential, without a network, and without a toolchain,
// which is exactly the situation the fail-fast path exists for: the refusal happens before
// any provider is reached, so nothing is spent and the message names the fix.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  InMemorySecretManager,
  providerCredentialRef,
  RefreshingSecretManager,
  type JsonHttpPort,
  type SecretManagerPort,
} from '@app/agent';
import { BoundedArtifactRetention, LocalWorkerRuntime } from '@app/tools';

import { RtllmMutationCalibrator, type GoldenTestbenchScorer } from '../corpus/index.js';
import { DEFAULT_MUTATION_CONFIG } from '../mutation-control.js';
import { FIXED_EVAL_SUBSET } from '../subset.js';
import {
  appendedSampleFacts,
  artifactStoreDeps,
  AuthFailureWatch,
  buildPropertySetGate,
  distinctConfigHashes,
  parseSweepArgs,
  pooledIdentityRefusalLines,
  runExitStatus,
  runSweep,
  runSweepCli,
  runShapeOf,
  summarizeSweepRun,
  type AppendedSampleFacts,
} from './cli.js';
import type { SweepArmConfig, SweepConfig } from './config.js';
import { parseSweepConfig } from './config-parse.js';
import type { SweepPropertySetGate, SweepRunResult } from './runner.js';
import type { ResultsLogPort, SweepSampleRecord } from './results-log.js';
import {
  checkCorpus,
  checkCredential,
  checkFormalToolchain,
  renderPreflightFailure,
  toolchainFailure,
  type CheckoutPresencePort,
  type FormalToolchainProbePort,
  type ModelListProbePort,
  type PreflightFailure,
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

describe('preflight - the credential is an ACCEPTANCE check', () => {
  /** The Credential_File path a refusal is allowed to name; never a real one. */
  const CREDENTIAL_FILE = '/repo/.secrets/bedrock-token';

  /** A provider answering one fixed status to the model-list call. */
  function answering(status: number): ModelListProbePort {
    return () => Promise.resolve({ kind: 'reply', status });
  }

  /** A provider that never answers at all. */
  const UNREACHABLE: ModelListProbePort = () => Promise.resolve({ kind: 'unreachable' });

  /** A probe that records every credential it was handed, so the source can be asserted. */
  function recording(): { readonly probe: ModelListProbePort; readonly seen: string[] } {
    const seen: string[] = [];
    return {
      seen,
      probe: (credential) => {
        seen.push(credential);
        return Promise.resolve({ kind: 'reply', status: 200 });
      },
    };
  }

  /** Run the probe against one secret manager and one answer. */
  function check(
    secretManager: SecretManagerPort,
    modelList: ModelListProbePort,
  ): Promise<PreflightFailure | null> {
    return checkCredential({ secretManager, credentialFilePath: CREDENTIAL_FILE, modelList });
  }

  it('refuses when no credential is available, naming the Credential_File and not the env file', async () => {
    // Criterion 7.17: the fix an operator reads must name the file the sweep actually reads.
    // `.env` is no longer that file, and an instruction naming the wrong one is worse than none.
    const failure = await checkCredential({
      secretManager: NO_CREDENTIAL,
      credentialFilePath: CREDENTIAL_FILE,
      modelList: answering(200),
    });
    expect(failure?.code).toBe('credential-missing');
    if (failure === null) return;
    expect(failure.fix).toContain('AWS_BEARER_TOKEN_BEDROCK');
    expect(failure.fix).toContain(CREDENTIAL_FILE);
    expect(failure.fix).toContain('never belongs in the sweep config');
    expect(renderPreflightFailure(failure).join('\n')).not.toContain('.env');
  });

  it('spends no call when there is no credential to authenticate with', async () => {
    const { probe, seen } = recording();

    expect(await check(NO_CREDENTIAL, probe)).not.toBeNull();
    expect(seen).toEqual([]);
  });

  it('admits the run when the provider ACCEPTS the credential', async () => {
    expect(await check(WITH_CREDENTIAL, answering(200))).toBeNull();
  });

  it('refuses a present credential the provider REFUSES, which presence alone cannot see', async () => {
    // The measured case: the pilot held a present and expired key, every sample recorded
    // `provider-unreachable`, and only a call could tell refusal from a network failure.
    const failure = await check(WITH_CREDENTIAL, answering(401));

    expect(failure).toMatchObject({ code: 'credential-refused' });
    expect(JSON.stringify(failure)).toContain(CREDENTIAL_FILE);
  });

  it('refuses a forbidden credential the same way, because the action is the same', async () => {
    expect(await check(WITH_CREDENTIAL, answering(403))).toMatchObject({
      code: 'credential-refused',
    });
  });

  it('separates an unreachable provider from a refused credential', async () => {
    // Different operator actions - fix the network, or refresh the token - so a run must not
    // report one as the other, which is exactly what the pilot's records did.
    const failure = await check(WITH_CREDENTIAL, UNREACHABLE);

    expect(failure).toMatchObject({ code: 'provider-unreachable' });
    expect(JSON.stringify(failure)).not.toContain(CREDENTIAL_FILE);
  });

  it('treats an answer that is neither acceptance nor refusal as unreachable', async () => {
    expect(await check(WITH_CREDENTIAL, answering(503))).toMatchObject({
      code: 'provider-unreachable',
    });
  });

  it('refuses the run when the Credential_File is missing, with no file ever read', async () => {
    const missingFile = new RefreshingSecretManager({
      path: CREDENTIAL_FILE,
      readFile: () => Promise.resolve(null),
    });

    expect(await check(missingFile, answering(200))).toMatchObject({
      code: 'credential-missing',
    });
  });

  it('authenticates with the credential the TRANSPORTS would send, from the one source', async () => {
    // Criterion 7.13: a probe reading a different source can accept a credential no request
    // will ever send. The probe resolves through the injected provider and sends exactly what
    // that provider returned, so the two cannot diverge.
    const { probe, seen } = recording();
    const fromFile = new RefreshingSecretManager({
      path: CREDENTIAL_FILE,
      readFile: () => Promise.resolve('  never-logged-file-value\n'),
    });

    expect(await check(fromFile, probe)).toBeNull();
    expect(seen).toEqual(['never-logged-file-value']);
  });

  it('never echoes the credential value in any message', async () => {
    const refused = await check(WITH_CREDENTIAL, answering(401));
    const unreachable = await check(WITH_CREDENTIAL, UNREACHABLE);
    const missing = await check(NO_CREDENTIAL, answering(200));

    for (const failure of [refused, unreachable, missing]) {
      expect(failure).not.toBeNull();
      expect(renderPreflightFailure(failure as PreflightFailure).join('\n')).not.toContain(
        'never-logged-test-value',
      );
    }
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

describe('preflight - the formal toolchain (Req 11.18)', () => {
  /** A probe reporting a present-but-not-invocable chain: the MEASURED bitwuzla 0.9.x case. */
  const NOT_INVOCABLE: FormalToolchainProbePort = () => ({
    available: false,
    reason: 'yosys-smtbmc -s bitwuzla is present but NOT INVOCABLE',
  });

  /** A probe reporting a chain that works. */
  const INVOCABLE: FormalToolchainProbePort = () => ({ available: true, reason: 'invocable' });

  it('refuses a formal run the composed invocation cannot make, before any sample', () => {
    const failure = checkFormalToolchain(true, NOT_INVOCABLE);

    expect(failure?.code).toBe('toolchain-missing');
    // The refusal names the measured trap rather than "a binary is missing", because every
    // binary IS present in this case, and it says what the records would otherwise look like.
    expect(failure?.problem).toContain('NOT INVOCABLE');
    expect(failure?.problem).toContain('toolchain-unavailable');
    // Both routes out: fix the chain, or measure with the simulation oracle alone.
    expect(failure?.fix).toContain('yosys-smtbmc -s bitwuzla');
    expect(failure?.fix).toContain('formalGateEnabled');
  });

  it('admits a formal run whose composed invocation works', () => {
    expect(checkFormalToolchain(true, INVOCABLE)).toBeNull();
  });

  it('admits a run with the gate OFF without probing at all, so nothing else changes', () => {
    let probes = 0;
    const counted: FormalToolchainProbePort = () => {
      probes += 1;
      return { available: false, reason: 'would refuse if it were asked' };
    };

    expect(checkFormalToolchain(false, counted)).toBeNull();
    // Not merely admitted: the question is never ASKED. A campaign that does not run the
    // Formal_Oracle cannot be refused for a toolchain it never invokes.
    expect(probes).toBe(0);
  });
});

describe('the artifact store composition (Req 12.16, 12.24)', () => {
  /** A note sink; the composition, not the notes, is under test here. */
  const onNote = (): void => {
    /* notes are not under test */
  };

  it('builds the store from a directory and a note sink, and injects NO artifact reader', () => {
    const deps = artifactStoreDeps('/runs/bakeoff', onNote);

    // The absence is the claim. A Counterexample's bytes ride on the capture, read where the
    // refuting run ended, so a reader here would only offer a second, later route to the same
    // trace - one that races the 1 MiB retention store every run on the runtime keeps filling.
    expect(deps).toStrictEqual({ outputDir: '/runs/bakeoff', onNote });
    expect(Object.keys(deps)).toEqual(['outputDir', 'onNote']);
  });

  it('takes no retention store, so the gate being on or off cannot change what it is built from', () => {
    // The signature is the claim: there is no parameter a gate could flow through, so the
    // retention object stays where the Formal_Gate reads its own reports through it.
    expect(artifactStoreDeps.length).toBe(2);
    expect(artifactStoreDeps('/runs/bakeoff', onNote)).toStrictEqual({
      outputDir: '/runs/bakeoff',
      onNote,
    });
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

  it('refuses a region it will not interpolate into the URL the credential is sent to', async () => {
    // The region is external configuration that ends up in an endpoint URL carrying a bearer
    // token, so it is refused here rather than trusted. NO_CREDENTIAL is deliberate: if the
    // guard ever stopped firing, this would refuse for a missing credential and still fail,
    // without reaching a network.
    const directory = await mkdtemp(join(tmpdir(), 'sweep-region-'));
    const configPath = join(directory, 'sweep.config.json');
    const base: unknown = JSON.parse(await readFile(EXAMPLE_CONFIG, 'utf8'));
    try {
      await writeFile(
        configPath,
        JSON.stringify({ ...(base as object), modelHost: { region: 'us-east-1/../elsewhere' } }),
        'utf8',
      );
      const result = await runSweep(configPath, { secretManager: NO_CREDENTIAL });

      expect(result.exitCode).toBe(1);
      expect(result.lines.join('\n')).toContain('modelHost.region');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('the exit status is a closed three-way decision (Req 7.6, 7.8, 7.9)', () => {
  /** A finished run; each shape overrides only the counters it is about. */
  function runResult(overrides: Partial<SweepRunResult> = {}): SweepRunResult {
    return {
      stopReason: 'completed',
      plannedSamples: 10,
      skippedSamples: 0,
      dispatchedSamples: 10,
      recordedSamples: 10,
      failedSamples: 0,
      ...overrides,
    };
  }

  it('gives 0 to a clean stop that measured samples with the credential intact', () => {
    const shape = runShapeOf(runResult({ stopReason: 'wall-clock-exhausted' }), 0);

    expect(shape).toMatchObject({ completedSamples: 10, notCompletedSamples: 0 });
    expect(runExitStatus(shape)).toBe(0);
  });

  it('gives 1 to a clean stop that measured NOTHING, which used to exit 0', () => {
    // The pilot's shape: `sample-limit-reached` is a clean stop, so a run whose every slot
    // was deferred reported itself fine. A run with no measurement is a 1 whatever stopped it.
    const shape = runShapeOf(
      runResult({ stopReason: 'sample-limit-reached', dispatchedSamples: 4, failedSamples: 4 }),
      0,
    );

    expect(shape).toMatchObject({ completedSamples: 0, notCompletedSamples: 4 });
    expect(runExitStatus(shape)).toBe(1);
  });

  it('gives 2 to a partial run a provider refused the credential on', () => {
    const shape = runShapeOf(
      runResult({ stopReason: 'provider-outage', dispatchedSamples: 6, failedSamples: 2 }),
      2,
    );

    expect(shape).toMatchObject({ completedSamples: 4, notCompletedSamples: 2 });
    // Distinct from the clean partial stop above, which is the whole reason the status exists:
    // a wrapper script reads 2 as "refresh the credential and resume".
    expect(runExitStatus(shape)).toBe(2);
  });

  it('partitions the dispatched samples, so the two counts sum to what was dispatched', () => {
    const result = runResult({ dispatchedSamples: 9, failedSamples: 3 });
    const shape = runShapeOf(result, 1);

    expect(shape.completedSamples + shape.notCompletedSamples).toBe(result.dispatchedSamples);
  });
});

describe('AuthFailureWatch - dispatch stops at the first refused credential (Req 7.7)', () => {
  /** The three classifications, keyed by the line a test appends. */
  const FACTS: Readonly<Record<string, AppendedSampleFacts>> = Object.freeze({
    measured: { completed: true, authFailure: false },
    refused: { completed: false, authFailure: true },
    deferred: { completed: false, authFailure: false },
  });

  /** A fact reader over those keys; `null` for anything it cannot classify. */
  const readFacts = (line: string): AppendedSampleFacts | null => FACTS[line] ?? null;

  /** A results log that keeps what it was handed, so the pass-through can be asserted. */
  function collectingLog(): { readonly log: ResultsLogPort; readonly lines: string[] } {
    const lines: string[] = [];
    return {
      lines,
      log: {
        appendLine: (line: string) => {
          lines.push(line);
          return Promise.resolve();
        },
        readAll: () => Promise.resolve(lines.join('\n')),
      },
    };
  }

  it('stops dispatch at the first refusal after a sample has been measured', async () => {
    const { log, lines } = collectingLog();
    const watch = new AuthFailureWatch(log, readFacts);

    await watch.appendLine('measured');
    expect(watch.stopDispatch()).toBe(false);
    await watch.appendLine('refused');

    expect(watch.stopDispatch()).toBe(true);
    expect(watch.authFailures()).toBe(1);
    // Every line still reaches the real log: the watch observes, it never filters.
    expect(lines).toEqual(['measured', 'refused']);
  });

  it('counts a refusal before anything was measured without stopping on it', async () => {
    const watch = new AuthFailureWatch(collectingLog().log, readFacts);

    await watch.appendLine('refused');

    expect(watch.authFailures()).toBe(1);
    expect(watch.stopDispatch()).toBe(false);
  });

  it('leaves a deferral that is not a refusal alone, because the remedy differs', async () => {
    const watch = new AuthFailureWatch(collectingLog().log, readFacts);

    await watch.appendLine('measured');
    await watch.appendLine('deferred');

    expect(watch.authFailures()).toBe(0);
    expect(watch.stopDispatch()).toBe(false);
  });

  it('keeps dispatching on a line it cannot classify, rather than guessing', async () => {
    const watch = new AuthFailureWatch(collectingLog().log, readFacts);

    await watch.appendLine('measured');
    await watch.appendLine('{not a record}');

    expect(watch.authFailures()).toBe(0);
    expect(watch.stopDispatch()).toBe(false);
  });

  it('classifies nothing from a line that is not a decodable record', () => {
    // The real reader the run wires in: unparseable text and a well-formed object that is not
    // a record both yield no classification, so neither can move the dispatch decision.
    expect(appendedSampleFacts('not json at all')).toBeNull();
    expect(appendedSampleFacts('{"outcomeStatus":"verified"}')).toBeNull();
  });
});

describe('summarizeSweepRun', () => {
  it('reports honestly when a directory holds no results log', async () => {
    const result = await summarizeSweepRun(resolve(HERE, 'no-such-run-dir'));
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('no results log');
  });
});

describe('distinctConfigHashes and the pooling guard (Req 9.8)', () => {
  /** A record for a helper that reads only `configHash`; every other field is irrelevant. */
  function withIdentity(configHash: string): SweepSampleRecord {
    return { configHash } as unknown as SweepSampleRecord;
  }

  it('returns one identity when every record shares it', () => {
    const records = [withIdentity('a'), withIdentity('a'), withIdentity('a')];

    expect(distinctConfigHashes(records)).toEqual(['a']);
  });

  it('names every distinct identity present, in first-seen order, with no duplicate', () => {
    const records = [withIdentity('b'), withIdentity('a'), withIdentity('b')];

    expect(distinctConfigHashes(records)).toEqual(['b', 'a']);
  });

  it('returns nothing for an empty population, which is not a pooling violation', () => {
    expect(distinctConfigHashes([])).toEqual([]);
  });

  it('names every identity present when more than one was found', () => {
    const lines = pooledIdentityRefusalLines(['b', 'a']);

    expect(lines.join('\n')).toContain('a, b');
    expect(lines.join('\n')).toContain('2');
  });
});

describe(
  'Feature: stimulus-transaction-structure, Property 23: A pooled figure exists only ' +
    'under one identity',
  () => {
    /** A record for the guard, which reads only `configHash`; every other field is irrelevant. */
    function withIdentity(configHash: string): SweepSampleRecord {
      return { configHash } as unknown as SweepSampleRecord;
    }

    /**
     * A hex-digest-shaped identity: long enough that it cannot coincidentally appear as a
     * substring of the refusal's fixed English sentence, the same needle-collision gotcha
     * `rendered-stimulus-layout.property.test.ts` guards against for a different renderer.
     */
    function identityArbitrary(): fc.Arbitrary<string> {
      return fc
        .array(fc.constantFrom(...'0123456789abcdef'.split('')), { minLength: 8, maxLength: 16 })
        .map((chars) => chars.join(''));
    }

    it('reports a pooled figure iff exactly one identity is present, naming every identity otherwise (Req 9.8)', () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(identityArbitrary(), { minLength: 1, maxLength: 6 }),
          fc.integer({ min: 1, max: 4 }),
          (identities, repeats) => {
            // The distinct population, repeated whole `repeats` times, so dedup is exercised
            // against real noise rather than merely assumed.
            const records = Array.from({ length: repeats }, () => identities)
              .flat()
              .map(withIdentity);
            const found = distinctConfigHashes(records);
            const exactlyOneIdentity = identities.length === 1;

            // Dedup is faithful to the distinct population drawn, regardless of the repeats.
            expect(found).toEqual(identities);

            // Both directions of the if-and-only-if: `summarizeSweepRun`'s guard
            // (`identities.length > 1`) does not fire exactly when one identity is present,
            // which is exactly when a pooled figure is reported rather than refused.
            expect(found.length === 1).toBe(exactlyOneIdentity);

            if (!exactlyOneIdentity) {
              // More than one identity: no pooled figure, and every identity present is
              // named in the refusal.
              const refusalText = pooledIdentityRefusalLines(found).join('\n');
              for (const identity of identities) {
                expect(refusalText).toContain(identity);
              }
            }
          },
        ),
      );
    });
  },
);

describe('runSweepCli', () => {
  it('prints usage and exits non-zero for a malformed invocation', async () => {
    const result = await runSweepCli(['--nonsense']);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('--config');
  });
});

describe('the Property_Set gate composition (Req 6.1, 6.5, 10.3)', () => {
  /** An HTTP seam that fails loudly: composing the gate must reach no provider. */
  const NO_NETWORK: JsonHttpPort = () =>
    Promise.reject(new Error('composing the gate must not call a provider'));

  /** A golden scorer nothing is allowed to run here; only the composition is under test. */
  const UNUSED_SCORER: GoldenTestbenchScorer = {
    score: () => Promise.reject(new Error('no mutant is scored in a composition test')),
  };

  /** The one calibrator a run builds, with no on-disk cache behind it. */
  function calibrator(): RtllmMutationCalibrator {
    const mutantWallMs = 60_000;
    return new RtllmMutationCalibrator({
      scorer: UNUSED_SCORER,
      golden: new Map(),
      references: new Map(),
      config: DEFAULT_MUTATION_CONFIG,
      mutantWallMs,
      cacheKey: { corpusCommit: 'commit1', mutationConfigHash: 'hash1', mutantWallMs },
    });
  }

  /** The committed example campaign, parsed: a real, valid `SweepConfig`. */
  async function exampleConfig(): Promise<SweepConfig> {
    const raw: unknown = JSON.parse(await readFile(EXAMPLE_CONFIG, 'utf8'));
    const parsed = parseSweepConfig(raw);
    if (!parsed.ok) {
      throw new Error('the committed example sweep config no longer parses');
    }
    return parsed.value;
  }

  /** The example campaign's first arm, which the per-arm author is built for. */
  function firstArm(config: SweepConfig): SweepArmConfig {
    const arm = config.arms[0];
    if (arm === undefined) {
      throw new Error('the committed example sweep config declares no arms');
    }
    return arm;
  }

  /**
   * Compose the gate exactly as `prepare` does, driven by the config flag.
   *
   * The retention store IS the switch: `prepare` derives it from `formalGateEnabled` and the
   * builder reads nothing else, so the flag is pushed through that same derivation rather
   * than checked against a second copy of the condition.
   */
  async function composed(
    formalGateEnabled: boolean,
  ): Promise<{ readonly config: SweepConfig; readonly gate: SweepPropertySetGate | null }> {
    const config = { ...(await exampleConfig()), formalGateEnabled };
    const formalArtifacts = config.formalGateEnabled ? new BoundedArtifactRetention() : null;
    return {
      config,
      gate: buildPropertySetGate({
        config,
        calibrator: calibrator(),
        formalArtifacts,
        sandboxRuntime: new LocalWorkerRuntime('python3', undefined, formalArtifacts),
        problems: FIXED_EVAL_SUBSET,
        http: NO_NETWORK,
        secretManager: NO_CREDENTIAL,
      }),
    };
  }

  it('builds BOTH halves when the formal gate is enabled', async () => {
    const { config, gate } = await composed(true);
    expect(gate).not.toBeNull();
    expect(typeof gate?.gate.calibrate).toBe('function');
    // Both halves or neither is the claim. A gate with no Property_Author has nothing to
    // score, so the harness would spend the gate and still record `not-gated`. The author is
    // built here rather than only asserted present, because building it is what validates the
    // arm's transport wiring - a bad region or a blank model id throws at this point.
    const authorFor = gate?.sourceFor(firstArm(config));
    const problem = FIXED_EVAL_SUBSET[0];
    expect(problem).toBeDefined();
    expect(problem === undefined ? undefined : typeof authorFor?.(problem).propertySetFor).toBe(
      'function',
    );
  });

  it('builds nothing when the formal gate is off, so a campaign behaves as it did before', async () => {
    const { gate } = await composed(false);
    // Absent, not a disabled gate: the harness receives no gate and no author, so every
    // sample records `not-gated` and nothing falls back.
    expect(gate).toBeNull();
  });
});
