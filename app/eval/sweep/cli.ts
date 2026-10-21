// The runnable eval sweep entry: the COMPOSITION ROOT for a model bake-off.
//
//   npm run eval:sweep -- --config app/eval/sweep/sweep.config.example.json
//   npm run eval:sweep -- --summarize .eval-runs/<runName>
//
// WHAT THIS FILE OWNS AND WHAT IT DOES NOT
//   It owns WIRING, stdout, and the exit code. Every decision - which samples to run,
//   which to skip, when to stop, what the numbers are - lives in the dependency-injected
//   modules beside it, which is why they are unit-tested without a network, a toolchain,
//   or a clock. This file is the only one that touches the real filesystem, the real
//   child processes, the real environment, and the real HTTP client.
//
// THE STACK IT COMPOSES (all real; nothing here is a stand-in)
//   sandbox    LocalWorkerRuntime over the host's worker Python -> real iverilog + vvp.
//   oracle     the Verification_Loop's own Simulator, inside EvalVerificationLoopRunner.
//   judge      RtllmGoldenJudge over SandboxGoldenTestbenchScorer: RTLLM's own unmodified
//              golden testbenches, which the loop never sees.
//   control    RtllmInstrumentControl over the SAME IcarusSimulatorAdapter the loop's oracle
//              uses, driving OUR generated testbench against RTLLM's own reference design
//              (positive control) and then against deliberately mutated versions of it
//              (negative control), with the DETECTABLE mutant set decided by RTLLM's own
//              golden testbench through RtllmMutationCalibrator - cached per corpus commit,
//              mutation-config hash, and mutant wall cap in .eval-cache/. Deterministic, no
//              model calls, no
//              budget: it decides whether a sample's verdict is admissible, never what the
//              verdict is.
//   models     createFetchJsonHttpPort, wrapped by the transport-level retry + breaker,
//              under the bedrock-mantle transport, credentials from the one
//              RefreshingSecretManager built here over the Credential_File.
//   corpus     the pinned RTLLM checkout, imported and reduced to the SCORED set.
//
// FAIL FAST, NEVER FAKE
//   Preflight refuses to start when the credential, the corpus, or the toolchain is
//   absent, and says which command or variable fixes it. There is no fallback path that
//   substitutes a fake oracle or a fake provider: a run that cannot produce a real verdict
//   must not run at all, because its output would look like a result. A config that enables
//   the FORMAL GATE is held to one more condition - the COMPOSED `yosys-smtbmc -s bitwuzla`
//   invocation has to actually run here - for the same reason: every binary can be present
//   and spawnable while every proof fails, and a results file full of `toolchain-unavailable`
//   is indistinguishable from a measurement of the designs.
//
// EXIT CODES - A CLOSED THREE-WAY DECISION, NOT A BOOLEAN OVER THE STOP REASON
//   0  the matrix completed, or stopped at a bound the operator configured (wall clock,
//      sample cap), with at least one sample measured and the credential still accepted.
//   1  preflight refused, nothing was measured, or the run stopped on a condition the
//      operator must act on (a sustained provider outage, an unwritable results log).
//   2  a provider ANSWERED and REFUSED the credential. Dispatch stopped at that sample, so
//      the samples before it are intact and the rest of the matrix was not spent against a
//      dead token. The pilot is why this status exists: an expired key recorded every slot
//      as a network failure and the run exited 0, which reads like a result.

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { newUlid } from '@app/core';
import {
  createBedrockMantleTransport,
  createFetchJsonHttpPort,
  createModelRouter,
  DEFAULT_CREDENTIAL_FILE,
  InMemoryTracePersistence,
  MODEL_TASKS,
  primarySelectionFor,
  RefreshingSecretManager,
  TESTBENCH_PROMPT_VERSION,
  TraceActionRecorder,
  type JsonHttpPort,
  type ModelPriceTable,
  type PropertySetSource,
  type SecretManagerPort,
  NORMALIZER_VERSION,
} from '@app/agent';
import { FileSystemOkfBundleReader, OkfFirstKnowledgeRetriever } from '@app/knowledge';
import {
  BoundedArtifactRetention,
  IcarusSimulatorAdapter,
  LocalWorkerRuntime,
  SandboxToolRunner,
  YosysSmtBmcFormalOracle,
  SIMULATION_HARNESS_VERSION,
  DUMP_LIMIT_BYTES,
  WATCHDOG_BUDGET_NS,
  probeDefaultTimescale,
} from '@app/tools';

import {
  FileSystemCorpusCheckout,
  importRtllmCorpus,
  localTimingDerivation,
  mutationConfigHash,
  NodeCheckoutProbePort,
  RTLLM_CHECKOUT_PATH,
  RtllmGoldenJudge,
  RtllmInstrumentControl,
  RtllmMutationCalibrator,
  RtllmMutationNegativeControl,
  SandboxGoldenTestbenchScorer,
  scoredRtllmCorpus,
  type RtllmCorpus,
} from '../corpus/index.js';
import { EVAL_CORPUS_ROOT } from '../corpus/fetch-node.js';
import { createEvalHarness } from '../harness.js';
import type { GoldenJudge } from '../golden-judge.js';
import { reachedOracleVerdict, type InstrumentControl } from '../instrument-control.js';
import type { MutationNegativeControl } from '../mutation-control.js';
import type { EvalLoopRunner } from '../loop-runner.js';
import type { EvalProblem } from '../problem.js';
import { RtllmPropertySetGate } from '../property-set-gate-rtllm.js';
import { evalRoutingPolicy } from '../routing-policy.js';
import { EvalVerificationLoopRunner, propertyAuthorFor } from '../verification-loop-runner.js';
import { ARTIFACTS_DIRNAME } from './artifact-layout.js';
import {
  FileSystemArtifactStore,
  type FileSystemArtifactStoreDeps,
} from './artifact-store-node.js';
import { readBaseline } from './baseline-reading.js';
import { renderCampaignReport } from './campaign-report.js';
import {
  modelSignatureOf,
  mutationConfigFor,
  type SweepArmConfig,
  type SweepConfig,
  type GroundingCampaignConfig,
} from './config.js';
import { parseSweepConfig } from './config-parse.js';
import { sweepConfigHash } from './config-identity.js';
import { FileSystemCalibrationCache } from './mutation-cache-node.js';
import {
  probeFormalToolchainAvailability,
  probeHarnessProvenance,
  probeHost,
  probeToolchainAvailability,
  probeToolchainVersions,
} from './host-facts.js';
import { SweepKillSwitch, type SweepStopReason } from './kill-switch.js';
import {
  assembleManifest,
  finalizeManifest,
  MANIFEST_FILENAME,
  nextCampaignPass,
  type SweepManifest,
} from './manifest.js';
import type { ReplayGateReport } from '../replay-gate.js';
import { renderGroundingReport } from './grounding-report.js';
import {
  checkCorpus,
  checkCredential,
  checkFormalToolchain,
  preflightFailure,
  replayGateRefusals,
  renderPreflightFailure,
  toolchainFailure,
  type ModelListAnswer,
  type ModelListProbePort,
  type PreflightFailure,
} from './preflight.js';
import { selectProblems } from './problem-selection.js';
import {
  decodeSampleRecord,
  parseResultsLog,
  CompletedSampleIndex,
  type ResultsLogPort,
  type SweepSampleRecord,
} from './results-log.js';
import { ensureDirectory, FileResultsLog, resultsLogPath } from './results-log-node.js';
import {
  campaignStartRefusal,
  SweepRunner,
  type SweepPropertySetGate,
  type SweepRunResult,
} from './runner.js';
import { renderSummary, summarizeRecords, SUMMARY_FILENAME } from './summary.js';
import { ThrottleGovernor } from './throttle-governor.js';
import {
  createRetryingHttpPort,
  TransportCircuitBreaker,
  type TransportRetryPolicy,
} from './transport-retry.js';

/** Largest config file this CLI will read, in bytes. */
const MAX_CONFIG_BYTES = 262_144;

/** The OKF bundle the Testbench_Agent retrieves hints from, relative to the repo root. */
const OKF_BUNDLE_RELATIVE = join('app', 'knowledge', 'okf-bundle');

/** Stop reasons that represent an operator-configured ending rather than a problem. */
const CLEAN_STOP_REASONS: readonly string[] = [
  'completed',
  'wall-clock-exhausted',
  'sample-limit-reached',
];

/** The no-verdict cause that means a provider answered and refused the credential. */
const AUTH_FAILURE_CAUSE = 'provider-refused-credential';

/** The run facts the exit status is a closed function of. */
export interface RunShape {
  readonly stopReason: SweepStopReason;
  /** Dispatched samples that reached an oracle verdict. */
  readonly completedSamples: number;
  /** Dispatched samples that did not; with the above this sums to the dispatched count. */
  readonly notCompletedSamples: number;
  /** Samples deferred for the Auth_Failure_Cause: a provider refused the credential. */
  readonly authFailureSamples: number;
}

/**
 * Partition one finished run into the shape its exit status is decided from.
 *
 * Both counts come from the runner's own counters rather than a second tally of the log, so
 * "dispatched" and "completed plus not-completed" cannot disagree.
 */
export function runShapeOf(result: SweepRunResult, authFailureSamples: number): RunShape {
  return {
    stopReason: result.stopReason,
    completedSamples: result.dispatchedSamples - result.failedSamples,
    notCompletedSamples: result.failedSamples,
    authFailureSamples,
  };
}

/**
 * The run's exit status (pure, total).
 *
 * This was `CLEAN_STOP_REASONS.includes(stopReason) ? 0 : 1`, and `sample-limit-reached` is a
 * clean stop, so the pilot's run - in which every slot was deferred against an expired key -
 * exited 0. What was measured and whether the credential held are therefore both part of the
 * decision now, and status 2 is what lets a wrapper script tell a half-dead credential from a
 * clean partial stop.
 *
 * The order IS the precedence. A run that measured nothing is a 1 whatever stopped it,
 * because there is no partial result to resume from. A preflight refusal never reaches here:
 * it returns 1 from `runSweep` before a run exists.
 */
export function runExitStatus(shape: RunShape): 0 | 1 | 2 {
  if (shape.completedSamples <= 0) {
    return 1;
  }
  if (shape.authFailureSamples > 0) {
    return 2;
  }
  return CLEAN_STOP_REASONS.includes(shape.stopReason) ? 0 : 1;
}

/** The two facts about one appended sample that dispatch and the exit status read. */
export interface AppendedSampleFacts {
  /** The oracle reached a verdict, so this slot is measured and finished. */
  readonly completed: boolean;
  /** The slot was deferred because a provider refused the credential. */
  readonly authFailure: boolean;
}

/**
 * Read those two facts off one appended results line, or `null` when it cannot be decoded.
 *
 * It decodes the record and reads its TYPED `noVerdictCause`, never the operator-facing
 * failure note. That is the whole point of `../no-verdict-cause.ts`: the pilot's defect was a
 * message-level classification, and a reworded or truncated note must not be able to turn a
 * dead credential back into a network outage.
 */
export function appendedSampleFacts(line: string): AppendedSampleFacts | null {
  let record: SweepSampleRecord | null;
  try {
    record = decodeSampleRecord(JSON.parse(line));
  } catch {
    // An unparseable line carries no classification, and guessing one is exactly what this
    // path exists to avoid. Dropped rather than surfaced: the line can quote a record.
    record = null;
  }
  if (record === null) {
    return null;
  }
  return {
    completed: reachedOracleVerdict(record.outcomeStatus),
    authFailure: record.noVerdictCause === AUTH_FAILURE_CAUSE,
  };
}

/**
 * The results log, plus the one question that must be answered WHILE samples land: has a
 * provider refused the credential?
 *
 * The run's own records are the only typed per-sample signal this layer sees, so the count is
 * taken as they are persisted. An undecodable line is counted as neither, which leaves
 * dispatch running - the conservative reading, since stopping on a line we cannot classify
 * would end a healthy campaign.
 */
export class AuthFailureWatch implements ResultsLogPort {
  readonly #log: ResultsLogPort;
  readonly #readFacts: (line: string) => AppendedSampleFacts | null;
  #authFailures = 0;
  #completed = 0;

  constructor(log: ResultsLogPort, readFacts: (line: string) => AppendedSampleFacts | null) {
    this.#log = log;
    this.#readFacts = readFacts;
  }

  /** Append through to the real log, then classify what was appended. */
  async appendLine(line: string): Promise<void> {
    await this.#log.appendLine(line);
    const facts = this.#readFacts(line);
    if (facts === null) {
      return;
    }
    this.#authFailures += facts.authFailure ? 1 : 0;
    this.#completed += facts.completed ? 1 : 0;
  }

  readAll(): Promise<string> {
    return this.#log.readAll();
  }

  /** Samples deferred for the Auth_Failure_Cause so far. */
  authFailures(): number {
    return this.#authFailures;
  }

  /**
   * Whether dispatch must stop: a credential was refused after at least one sample was
   * measured, so continuing would spend the rest of the matrix against a dead token.
   *
   * Reported through the breaker's own seam, so the kill switch takes the decision at a
   * sample boundary and every in-flight sample is still recorded.
   * ponytail: the run then reports `provider-outage`, the nearest existing stop reason, and
   * the report lines below name the real cause; a dedicated reason belongs in
   * `./kill-switch.ts`.
   */
  stopDispatch(): boolean {
    return this.#authFailures > 0 && this.#completed > 0;
  }
}

/**
 * The repository root, derived from the corpus module's own anchor.
 *
 * `EVAL_CORPUS_ROOT` is `<repoRoot>/.eval-corpus` and already resolves correctly from both
 * the source tree and the build output, so taking its parent reuses that one decision
 * instead of duplicating the level-counting here.
 */
function repositoryRoot(): string {
  return dirname(EVAL_CORPUS_ROOT);
}

/** The Credential_File this run reads its credential from, declared in exactly one place. */
function credentialFile(): string {
  return resolve(repositoryRoot(), DEFAULT_CREDENTIAL_FILE);
}

/** One UTF-8 file, or `null` where it cannot be read, which is the port's contract. */
async function readTextFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    // An unreadable Credential_File is a typed absence rather than an error, and the
    // rejection is dropped because it can quote the file.
    return null;
  }
}

/**
 * The ONE credential provider the preflight probe and every transport resolve through.
 *
 * One instance, because a probe reading a different source can accept a credential no
 * request will ever send. It reads the Credential_File alone, with no environment
 * fallback, and re-reads it per request so a token refreshed mid-run needs no restart.
 */
function credentialProvider(): SecretManagerPort {
  return new RefreshingSecretManager({
    path: credentialFile(),
    readFile: readTextFileOrNull,
  });
}

/**
 * Accepted shape of an AWS region label.
 *
 * The region is external configuration interpolated into the URL a bearer credential is
 * sent to, so it is validated at this boundary; the transport validates its own copy for
 * the same reason.
 */
const REGION_PATTERN = /^[a-z0-9-]{1,32}$/;

/** Path of the OpenAI-compatible model-list endpoint on the mantle host. */
const MODELS_PATH = '/v1/models';

/** Deadline for the credential probe: it is one list call, not a generation. */
const CREDENTIAL_PROBE_TIMEOUT_MS = 30_000;

/**
 * The real model-list probe, or `null` for a region that may not reach a URL.
 *
 * The reply body is never read and the credential is never held: only the status
 * distinguishes acceptance from refusal, and a provider error body can echo the token back.
 */
function modelListProbe(region: string): ModelListProbePort | null {
  if (!REGION_PATTERN.test(region)) {
    return null;
  }
  const url = `https://bedrock-mantle.${region}.api.aws${MODELS_PATH}`;
  return async (credential: string): Promise<ModelListAnswer> => {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${credential}` },
        // Following one would re-send the bearer token to a host nobody named.
        redirect: 'error',
        signal: AbortSignal.timeout(CREDENTIAL_PROBE_TIMEOUT_MS),
      });
      const status = response.status;
      // Cancelled rather than read: it releases the socket without the body ever existing
      // as a string here.
      await response.body?.cancel();
      return { kind: 'reply', status };
    } catch {
      // Dropped rather than surfaced: a fetch rejection names the host, the IP, and the
      // TLS chain.
      return { kind: 'unreachable' };
    }
  };
}

/** What a CLI invocation produced: lines to print and the exit code to set. */
export interface SweepCliResult {
  readonly exitCode: number;
  readonly lines: readonly string[];
}

/** The two things this CLI can be asked to do. */
export type SweepCommand =
  | { readonly kind: 'run'; readonly configPath: string }
  | { readonly kind: 'summarize'; readonly runDir: string }
  | { readonly kind: 'usage'; readonly problem: string };

/** Usage text, printed for a malformed invocation. */
export const SWEEP_USAGE: readonly string[] = Object.freeze([
  'usage:',
  '  eval:sweep -- --config <path/to/sweep.config.json>',
  '  eval:sweep -- --summarize <path/to/run/output/dir>',
]);

/**
 * Parse argv into a command.
 *
 * argv is untrusted input: exactly one recognized flag with exactly one value is
 * accepted, and anything else is a usage error rather than a guess.
 */
export function parseSweepArgs(argv: readonly string[]): SweepCommand {
  if (argv.length !== 2) {
    return { kind: 'usage', problem: 'expected exactly one flag and one value' };
  }
  const [flag, value] = argv;
  if (value === undefined || value.trim().length === 0) {
    return { kind: 'usage', problem: 'the flag value must not be empty' };
  }
  if (flag === '--config') {
    return { kind: 'run', configPath: value };
  }
  if (flag === '--summarize') {
    return { kind: 'summarize', runDir: value };
  }
  return { kind: 'usage', problem: `unrecognized flag ${String(flag)}` };
}

/** Read and validate the config file, returning a preflight failure on any problem. */
async function loadConfig(configPath: string): Promise<SweepConfig | PreflightFailure> {
  let text: string;
  try {
    text = await readFile(configPath, 'utf8');
  } catch {
    return preflightFailure(
      'config-invalid',
      'the sweep config file could not be read',
      'pass an existing readable file with --config',
    );
  }
  if (text.length > MAX_CONFIG_BYTES) {
    return preflightFailure(
      'config-invalid',
      `the sweep config exceeds ${MAX_CONFIG_BYTES} bytes`,
      'shrink the config; a campaign needs arms and a problem selection, not inline data',
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return preflightFailure(
      'config-invalid',
      'the sweep config is not valid JSON',
      'fix the JSON syntax and re-run',
    );
  }
  const parsed = parseSweepConfig(raw);
  if (!parsed.ok) {
    return preflightFailure(
      'config-invalid',
      `the sweep config is invalid at ${parsed.error.field || '(root)'}: ${parsed.error.message}`,
      'correct that field and re-run; see app/eval/sweep/sweep.config.example.json',
    );
  }
  return parsed.value;
}

/** Whether a value is a preflight failure rather than the parsed config. */
function isFailure(value: SweepConfig | PreflightFailure): value is PreflightFailure {
  return 'code' in value && 'fix' in value;
}

/** The real, retry-wrapped HTTP client every arm's transport calls through. */
function buildHttpPort(
  policy: TransportRetryPolicy,
  breaker: TransportCircuitBreaker,
  governor: ThrottleGovernor,
): JsonHttpPort {
  return createRetryingHttpPort(createFetchJsonHttpPort(), {
    policy,
    breaker,
    governor,
    sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
    random: Math.random,
  });
}

/** The collaborators every arm shares; built once so no arm re-composes them. */
interface SharedStack {
  readonly http: JsonHttpPort;
  readonly breaker: TransportCircuitBreaker;
  readonly governor: ThrottleGovernor;
  readonly sandboxRuntime: LocalWorkerRuntime;
  /** The retention store the formal gate reads its reports through; `null` when it is off. */
  readonly formalArtifacts: BoundedArtifactRetention | null;
  /** The EVAL-side Property_Set gate and its per-arm author; `null` when the gate is off. */
  readonly propertySetGate: SweepPropertySetGate | null;
  readonly retriever: OkfFirstKnowledgeRetriever;
  readonly secretManager: SecretManagerPort;
  readonly goldenJudge: GoldenJudge;
  readonly instrumentControl: InstrumentControl;
  readonly problems: readonly EvalProblem[];
  readonly prices: ModelPriceTable;
}

/**
 * Build the per-arm production loop runner.
 *
 * Only the routing policy differs between arms - which is exactly what a bake-off
 * permutes. The host, the prompt, the context strategy, the sandbox, the judge, and the
 * caps are held constant, because a comparison in which two things changed measures
 * neither.
 */
function loopRunnerFor(
  shared: SharedStack,
  config: SweepConfig,
  arm: SweepArmConfig,
): EvalLoopRunner {
  return new EvalVerificationLoopRunner({
    modelHost: { ...config.modelHost, prices: shared.prices },
    routingPolicy: evalRoutingPolicy({ taskModel: arm.roleModels }),
    http: shared.http,
    sandboxRuntime: shared.sandboxRuntime,
    retriever: shared.retriever,
    // Omitted rather than passed as `null` when the gate is off: absent is what the runner
    // reads as "no formal gate", and it is the same store for every arm, because the gate is
    // part of the held-constant stack a bake-off permutes models against.
    ...(shared.formalArtifacts === null ? {} : { formalArtifacts: shared.formalArtifacts }),
    secretManager: shared.secretManager,
  });
}

/**
 * What the run's artifact store is built from: a directory and a note sink, whatever the
 * formal gate is doing.
 *
 * NO ARTIFACT READER IS INJECTED HERE, and that is the point rather than an omission. A refuted
 * sample's Counterexample trace now arrives ON the capture, read where its own refuting run
 * ended, because the retention store those bytes sat in holds 1 MiB in total and every run on
 * the shared runtime keeps filling it - so a store that resolved a reference after the sample
 * was measured could lose the race for the one artifact a Student is coached from (Req 12.24).
 * The retention object itself stays on `SharedStack`, where the Formal_Gate reads its own
 * reports through it; the writer no longer needs it.
 */
export function artifactStoreDeps(
  outputDir: string,
  onNote: (note: string) => void,
): FileSystemArtifactStoreDeps {
  return { outputDir, onNote };
}

/** Everything preflight established, ready to run. */
interface PreparedRun {
  readonly config: SweepConfig;
  readonly configHash: string;
  readonly shared: SharedStack;
  readonly manifest: SweepManifest;
  readonly pythonBin: string;
}

/**
 * Run every preflight check in cost order: cheapest and most likely first.
 *
 * The credential stays first even though it now makes one call, because an absent
 * credential is detected without one and makes every later check moot.
 */
async function preflight(
  config: SweepConfig,
  secretManager: SecretManagerPort,
): Promise<PreflightFailure | { readonly pythonBin: string }> {
  const modelList = modelListProbe(config.modelHost.region);
  if (modelList === null) {
    return preflightFailure(
      'config-invalid',
      'modelHost.region is not a legal AWS region label, and it is interpolated into the endpoint URL the credential is sent to',
      'set modelHost.region to a region such as us-east-1 and re-run',
    );
  }
  const credential = await checkCredential({
    secretManager,
    credentialFilePath: credentialFile(),
    modelList,
  });
  if (credential !== null) {
    return credential;
  }
  const corpus = await checkCorpus(new NodeCheckoutProbePort(), RTLLM_CHECKOUT_PATH);
  if (corpus !== null) {
    return corpus;
  }
  const toolchain = probeToolchainAvailability();
  if (!toolchain.available) {
    return toolchainFailure(toolchain.reason);
  }
  // Only paid for when the config enables the gate, and ALWAYS before the first sample: a
  // formal run this host cannot make must refuse the whole run rather than record a wall of
  // `toolchain-unavailable` that reads like a measurement (Req 11.18).
  const formal = checkFormalToolchain(config.formalGateEnabled, probeFormalToolchainAvailability);
  if (formal !== null) {
    return formal;
  }
  const probe = createEvalHarness({
    loopRunner: { runSample: () => Promise.reject(new Error('preflight probe only')) },
    caps: config.caps,
    limits: config.limits,
    config: config.reproducibility,
    costEnvelopeCents: config.costEnvelopeCents,
    ks: config.ks,
  });
  if (!probe.ok) {
    return preflightFailure(
      'config-invalid',
      `the harness rejected this config: ${probe.error.message}`,
      'correct caps / ks / costEnvelopeCents and re-run',
    );
  }
  return { pythonBin: toolchain.pythonBin };
}

/**
 * Build the ONE mutant-set owner BOTH gates read (Req 9.8).
 *
 * The Negative_Control scores our generated testbench against these mutants and the
 * Property_Set_Gate scores the sample's Property_Set against the same ones, so a second
 * instance here would let the two disagree about which mutants exist and would pay the golden
 * judge twice for the answer. Built unconditionally and inert until something calls
 * `calibrate`, so a campaign with neither gate enabled costs nothing for it.
 *
 * The calibrator gets the GOLDEN scorer (RTLLM's testbench, VCS-style banners) and the negative
 * control gets the ICARUS adapter (our testbench, `CHECK` signalling). The two read different
 * output grammars, so each is handed the reader that speaks its language; sharing one would
 * classify every golden run as an error (see `../corpus/golden-scorer.ts`).
 *
 * The cache key is the corpus commit, a digest of the mutation config, and the mutant wall cap,
 * and nothing else - those are the only inputs a golden testbench's verdict on a mutant depends
 * on. The cap is in there because it decides whether a slow mutant reads as a failure or as a
 * hang, and those are different verdicts.
 */
function buildCalibrator(
  config: SweepConfig,
  corpus: RtllmCorpus,
  sandboxRuntime: LocalWorkerRuntime,
): RtllmMutationCalibrator {
  const mutationConfig = mutationConfigFor(config);
  const mutantWallMs = config.negativeControl.mutantWallMs;
  const cacheKey = {
    corpusCommit: corpus.pinnedCommit,
    mutationConfigHash: mutationConfigHash(mutationConfig, sha256Hex),
    // The cap is part of the key because it can change a verdict: a slow-but-terminating mutant
    // is `golden-killed` under a wide cap and `golden-timeout` under a narrow one.
    mutantWallMs,
  };
  return new RtllmMutationCalibrator({
    scorer: new SandboxGoldenTestbenchScorer(new SandboxToolRunner(sandboxRuntime)),
    golden: corpus.golden,
    references: corpus.references,
    config: mutationConfig,
    // The calibrator is the single owner of the cap; the negative control reads it from there.
    mutantWallMs,
    cacheKey,
    cache: new FileSystemCalibrationCache({ repositoryRoot: repositoryRoot(), cacheKey }),
    // Calibration takes minutes on a cold cache, so its progress goes to the same channel
    // as everything else: an operator must see it happening rather than a silent process.
    onNote: (note: string) => {
      console.log(note);
    },
  });
}

/**
 * Build the MUTATION-BASED NEGATIVE CONTROL over that one mutant set, or `null` when the config
 * disables it.
 */
function buildNegativeControl(
  config: SweepConfig,
  calibrator: RtllmMutationCalibrator,
  sandboxRuntime: LocalWorkerRuntime,
): MutationNegativeControl | null {
  if (!config.negativeControl.enabled) {
    return null;
  }
  return new RtllmMutationNegativeControl({
    simulator: new IcarusSimulatorAdapter(new SandboxToolRunner(sandboxRuntime)),
    calibrator,
  });
}

/** What the EVAL-side Property_Set gate is composed from, once preflight has passed. */
export interface PropertySetGateParts {
  readonly config: SweepConfig;
  /** The SAME instance the Negative_Control reads, so both gates score one mutant set. */
  readonly calibrator: RtllmMutationCalibrator;
  /**
   * The retention store the gate's oracle resolves its own report refs through, and the ONE
   * switch that wires the gate at all: `null` is exactly `formalGateEnabled` being off.
   *
   * It is the store rather than a second read of the flag for the reason
   * `EvalVerificationLoopRunnerDeps.formalArtifacts` is: "gate enabled, nothing to read its own
   * evidence through" would be representable, and that state can only produce
   * `toolchain-unavailable`.
   */
  readonly formalArtifacts: BoundedArtifactRetention | null;
  readonly sandboxRuntime: LocalWorkerRuntime;
  /** The run's selected problems; each one's declared interface renders its Property_Wrapper. */
  readonly problems: readonly EvalProblem[];
  readonly http: JsonHttpPort;
  readonly secretManager: SecretManagerPort;
}

/**
 * The arm's per-problem Property_Author, over the ARM'S OWN models.
 *
 * Keyed by arm because authoring is a model call: a bake-off that authored every arm's
 * properties with one fixed model would hold the wrong thing constant. Built through
 * `propertyAuthorFor`, the one exported construction path, so the author a gated eval run hands
 * the gate and the author a student session builds for itself cannot differ.
 *
 * The transport pins the run's temperature but NO seed: this seam carries the problem and not
 * the sample index, so there is no per-sample seed to pin and claiming one would be a lie.
 */
function propertyAuthorFactory(
  parts: PropertySetGateParts,
  arm: SweepArmConfig,
): (problem: EvalProblem) => PropertySetSource {
  const { modelHost, prices, reproducibility } = parts.config;
  const policy = evalRoutingPolicy({ taskModel: arm.roleModels });
  const transport = createBedrockMantleTransport({
    http: parts.http,
    config: {
      region: modelHost.region,
      // Derived from the policy's own primary, so the when-unrouted default cannot contradict
      // the policy - the same belt and braces `../verification-loop-runner.ts` applies.
      defaultModelId: primarySelectionFor(policy, 'generation').modelId,
      temperature: reproducibility.temperature,
      prices,
      ...(modelHost.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: modelHost.maxOutputTokens }),
      ...(modelHost.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: modelHost.requestTimeoutMs }),
    },
  });
  // A fresh recorder per call, matching the loop runner's own per-sample recorder: one shared
  // across an arm would hold every sample's spans in memory for the whole campaign.
  return () => {
    const recorder = new TraceActionRecorder(new InMemoryTracePersistence(), newUlid);
    const router = createModelRouter({
      secretManager: parts.secretManager,
      recorder,
      transports: { 'bedrock-mantle': transport },
      policy,
    });
    return propertyAuthorFor({ router, recorder, now: Date.now });
  };
}

/**
 * Build the EVAL-side Property_Set gate and its per-arm author, or `null` where the config
 * leaves the formal gate off.
 *
 * ONE ORACLE FOR THE WHOLE RUN, so a mutant and a candidate are decided under one set of caps:
 * the same sandbox runtime, the same retention store, and `config.limits`, which is the exact
 * object the harness hands every sample as `request.limits` and the loop derives its own formal
 * caps from. `wallMs` is dropped field by field rather than destructured, because
 * typescript-eslint's `no-unused-vars` defaults `ignoreRestSiblings` to false in this repo.
 *
 * Both halves are returned together or not at all, which is what keeps the harness from
 * spending a gate that has no Property_Set to score.
 */
export function buildPropertySetGate(parts: PropertySetGateParts): SweepPropertySetGate | null {
  const artifacts = parts.formalArtifacts;
  if (artifacts === null) {
    return null;
  }
  const { limits } = parts.config;
  return {
    gate: new RtllmPropertySetGate({
      calibrator: parts.calibrator,
      oracle: new YosysSmtBmcFormalOracle({
        toolRunner: new SandboxToolRunner(parts.sandboxRuntime),
        artifacts,
        caps: { cpu: limits.cpu, memMb: limits.memMb, procs: limits.procs, diskMb: limits.diskMb },
        now: Date.now,
      }),
      // Scoped to the run's own problems: a problem nobody selected can never be asked for, and
      // a missing interface is the gate's own could-not-run answer rather than a guess.
      interfaces: new Map(
        parts.problems.map((problem) => [problem.id, problem.spec.moduleInterface]),
      ),
    }),
    sourceFor: (arm: SweepArmConfig) => propertyAuthorFactory(parts, arm),
  };
}

/** The previous run's manifest in the output directory, or null when absent or unreadable. */
async function previousManifest(outputDir: string): Promise<unknown> {
  const text = await readTextFileOrNull(
    join(resolve(repositoryRoot(), outputDir), MANIFEST_FILENAME),
  );
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // An unparseable manifest records no pass, so it counts as none rather than failing open.
    return null;
  }
}

/**
 * A Campaign's start checks (Req 8.4, 8.8, 8.11, 8.13): its pass number, or the refusal that
 * stops it before anything is composed. Null outside a Campaign.
 */
async function campaignPassOrRefusal(
  config: SweepConfig,
  configHash: string,
  selected: readonly EvalProblem[],
  scoredCorpus: readonly EvalProblem[],
): Promise<number | PreflightFailure | null> {
  const scoreboard = config.scoreboardCampaign;
  const grounding = config.groundingCampaign;
  // Generalized over either block: the pass number and the resume limit are the same rule, and
  // only the scoreboard's recorded-list check is specific to it.
  const maxResumes = scoreboard?.maxResumes ?? grounding?.maxResumes;
  if (maxResumes === undefined) {
    return null;
  }
  if (scoreboard !== undefined) {
    const refusal = campaignStartRefusal(scoreboard, selected, scoredCorpus);
    if (refusal !== null) {
      return preflightFailure(
        'campaign-mismatch',
        refusal,
        'correct scoreboardCampaign and re-run',
      );
    }
  }
  const pass = nextCampaignPass(await previousManifest(config.outputDir), configHash);
  if (pass > maxResumes) {
    return preflightFailure(
      'campaign-resume-limit',
      `this would be resume ${pass}, and the Campaign allows ${maxResumes}`,
      'report the deferred slots as not-decided; do not resume again',
    );
  }
  return pass;
}

/**
 * The Replay_Gate report a config names, top-level or in its grounding block, or `undefined`.
 * The parser refuses a config naming two different reports, so `??` never hides one.
 */
export function replayGateReportPathOf(config: SweepConfig): string | undefined {
  return config.replayGateReportPath ?? config.groundingCampaign?.replayGateReportPath;
}

/**
 * The harness start checks any config naming a Replay_Gate report gets, in cost order: the
 * Default_Timescale probe runs a tiny simulation, the report check reads one file. Both run
 * before anything is composed, so a refusal dispatches zero slots (C8; grounding C11, C12).
 */
export async function harnessStartRefusal(
  config: SweepConfig,
  pythonBin: string,
): Promise<PreflightFailure | ReplayGateReport | null> {
  const reportPath = replayGateReportPathOf(config);
  if (reportPath === undefined) {
    return null;
  }
  const simulator = new IcarusSimulatorAdapter(
    new SandboxToolRunner(new LocalWorkerRuntime(pythonBin)),
  );
  const probe = await probeDefaultTimescale(simulator, config.limits);
  if (probe !== 'honored') {
    return preflightFailure(
      'default-timescale-not-honored',
      `this host's Icarus reports the Default_Timescale_Entry as ${probe}, so every testbench delay would run in the wrong unit`,
      'run this sweep on a host whose iverilog accepts a `+timescale+` command-file entry',
    );
  }
  const report = await readJsonFile(reportPath);
  const reasons = replayGateRefusals(report, {
    simulationHarnessVersion: SIMULATION_HARNESS_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
    watchdogBudgetNs: WATCHDOG_BUDGET_NS,
    dumpLimitBytes: DUMP_LIMIT_BYTES,
  });
  if (reasons.length > 0) {
    return preflightFailure(
      'replay-gate-not-passed',
      reasons.join('; '),
      `re-run \`node app/eval/dist/scripts/replay-gate.js --verify\` on this build and re-read ${reportPath}`,
    );
  }
  return report as ReplayGateReport;
}

/** Read and parse a JSON file, or `null` when it is absent or unreadable. */
async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** Compose the shared stack and the manifest once preflight has passed. */
async function prepare(
  config: SweepConfig,
  pythonBin: string,
  secretManager: SecretManagerPort,
): Promise<PreparedRun | PreflightFailure> {
  const corpus = scoredRtllmCorpus(
    await importRtllmCorpus(
      new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
      localTimingDerivation(),
    ),
  );
  const selected = selectProblems(corpus.problems, config.problems);
  if (!selected.ok) {
    return preflightFailure(
      'selection-empty',
      selected.error.message,
      'adjust problems and re-run',
    );
  }
  const configHash = sweepConfigHash(config, sha256Hex);
  const campaignPass = await campaignPassOrRefusal(
    config,
    configHash,
    selected.value,
    corpus.problems,
  );
  if (typeof campaignPass !== 'number' && campaignPass !== null) {
    return campaignPass;
  }
  const harness = await harnessStartRefusal(config, pythonBin);
  if (harness !== null && 'code' in harness) {
    return harness;
  }
  const replayGate: ReplayGateReport | null = harness;
  // THE COMPOSITION ROOT FOR ARTIFACT RETENTION, and it exists only for the formal gate. A
  // `SandboxResult` carries artifact refs and no bytes, and the runtime removes each workspace
  // in a `finally`, so the one object below is handed to BOTH sides: the runtime fills it after
  // the worker finishes and before the workspace goes, and the Formal_Oracle reads its own JSON
  // report back out of it. One object, so a ref cannot resolve to different bytes depending on
  // who asked. `null` when the gate is off, so a campaign that does not use it retains nothing
  // and pays no memory for evidence nobody reads.
  const formalArtifacts = config.formalGateEnabled ? new BoundedArtifactRetention() : null;
  const sandboxRuntime = new LocalWorkerRuntime(pythonBin, undefined, formalArtifacts);
  const breaker = new TransportCircuitBreaker(config.transportRetry, Date.now);
  const governor = new ThrottleGovernor(config.concurrency, Date.now);
  const http = buildHttpPort(config.transportRetry, breaker, governor);
  // ONE calibrator for both gates, built before either, so the Negative_Control and the
  // Property_Set_Gate are scored over the same mutant set (Req 9.8).
  const calibrator = buildCalibrator(config, corpus, sandboxRuntime);
  const negativeControl = buildNegativeControl(config, calibrator, sandboxRuntime);
  const shared: SharedStack = {
    http,
    breaker,
    governor,
    sandboxRuntime,
    formalArtifacts,
    // Built here beside the retention store it reads through, and under the same condition,
    // because the gate is part of the held-constant stack a bake-off permutes models against.
    propertySetGate: buildPropertySetGate({
      config,
      calibrator,
      formalArtifacts,
      sandboxRuntime,
      problems: selected.value,
      http,
      secretManager,
    }),
    retriever: new OkfFirstKnowledgeRetriever({
      okfReader: new FileSystemOkfBundleReader(join(repositoryRoot(), OKF_BUNDLE_RELATIVE)),
    }),
    secretManager,
    goldenJudge: new RtllmGoldenJudge(
      new SandboxGoldenTestbenchScorer(new SandboxToolRunner(sandboxRuntime)),
      corpus.golden,
    ),
    // The control runs our own testbench, which emits `CHECK` signalling and a waveform, so
    // it uses the SAME oracle adapter the loop's verdict came from. Only the RTL under the
    // testbench changes; anything else would leave "the control read the output differently"
    // as a live explanation for a disagreement.
    instrumentControl: new RtllmInstrumentControl({
      simulator: new IcarusSimulatorAdapter(new SandboxToolRunner(sandboxRuntime)),
      references: corpus.references,
      ...(negativeControl === null ? {} : { negativeControl }),
    }),
    problems: selected.value,
    prices: config.prices,
  };
  return {
    config,
    configHash,
    shared,
    pythonBin,
    manifest: assembleManifest({
      config,
      configHash,
      selectedProblemIds: selected.value.map((problem) => problem.id),
      campaignPass,
      replayGate,
      facts: {
        toolchain: probeToolchainVersions(pythonBin),
        host: probeHost(),
        harness: probeHarnessProvenance(repositoryRoot()),
        startedAt: new Date().toISOString(),
      },
    }),
  };
}

/** Lowercase hex SHA-256 of a UTF-8 string; the injected digest for the config hash. */
function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Write a JSON document, pretty-printed so a manifest is reviewable by a human. */
async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * The lines that report a finished run, including the honesty warnings.
 *
 * The completed / did-not-complete split is printed next to the raw counters because it is
 * what the exit status is decided from: an operator reading a 2 must see the same partition
 * the status came from, not have to infer it.
 */
function runReportLines(
  prepared: PreparedRun,
  result: SweepRunResult,
  shape: RunShape,
): readonly string[] {
  const dirty = prepared.manifest.harness.workingTreeDirty;
  const config = prepared.config;
  return [
    '',
    `run ${config.runName} stopped: ${result.stopReason}`,
    `planned ${result.plannedSamples}, skipped-as-already-recorded ${result.skippedSamples}, ` +
      `dispatched ${result.dispatchedSamples}, recorded ${result.recordedSamples}, ` +
      `no-verdict ${result.failedSamples}`,
    `of ${result.dispatchedSamples} dispatched: completed ${shape.completedSamples}, ` +
      `did-not-complete ${shape.notCompletedSamples}`,
    ...(shape.authFailureSamples > 0
      ? [
          `WARNING: a provider REFUSED the credential on ${shape.authFailureSamples} sample(s),`,
          '         so dispatch stopped rather than spending the matrix against a dead token.',
          '         Refresh the credential file and re-run: the measured samples are intact and',
          '         the refused ones are deferred, so a resume takes those slots again.',
        ]
      : []),
    ...(config.captureArtifacts
      ? [`per-sample artifacts: ${join(config.outputDir, ARTIFACTS_DIRNAME)}/<arm>/<problem>/`]
      : ['per-sample artifacts: DISABLED, so a verdict disagreement cannot be diagnosed']),
    ...(dirty === true
      ? [
          'WARNING: the harness working tree was DIRTY, so the recorded commit does not describe',
          '         the code that produced these numbers. They are not reproducible as cited.',
        ]
      : []),
    ...(dirty === null ? ['WARNING: harness git provenance could not be read'] : []),
  ];
}

/** The A/B Campaign block for a run that is one, read from its own records and manifest. */
async function campaignLines(
  config: SweepConfig,
  configHash: string,
  outputDir: string,
  records: readonly SweepSampleRecord[],
): Promise<readonly string[]> {
  const campaign = config.scoreboardCampaign;
  const grounding = config.groundingCampaign;
  if ((campaign === undefined && grounding === undefined) || config.problems.kind !== 'ids') {
    return [];
  }
  const own = records.filter((record) => record.configHash === configHash);
  const manifestText = await readTextFileOrNull(join(outputDir, MANIFEST_FILENAME));
  if (grounding !== undefined) {
    return groundingLines(config, grounding, configHash, own, manifestText);
  }
  if (campaign === undefined) {
    return [];
  }
  const supplement = new Set(campaign.streamingSupplement);
  const modelArms = [...new Set(config.arms.map((arm) => modelSignatureOf(arm, MODEL_TASKS)))];
  const baselinePath = resolve(repositoryRoot(), campaign.baseline.resultsPath);
  return renderCampaignReport({
    records: own,
    campaign,
    modelArms,
    problemIds: config.problems.ids,
    manifestCriterion: recordedCriterion(manifestText),
    deferredSlots: CompletedSampleIndex.fromRecords(own, configHash).deferredSize(),
    baseline: readBaseline({
      text: await readTextFileOrNull(baselinePath),
      configHash: campaign.baseline.configHash,
      modelArms,
      problemIds: config.problems.ids.filter((id) => !supplement.has(id)),
    }),
    baselineRunName: basename(dirname(baselinePath)),
  });
}

/** The Grounding Campaign block, read from its own records, manifest, and Reference_Campaign. */
async function groundingLines(
  config: SweepConfig,
  grounding: GroundingCampaignConfig,
  configHash: string,
  own: readonly SweepSampleRecord[],
  manifestText: string | null,
): Promise<readonly string[]> {
  if (config.problems.kind !== 'ids') {
    return [];
  }
  const modelArms = [...new Set(config.arms.map((arm) => modelSignatureOf(arm, MODEL_TASKS)))];
  const referencePath = resolve(repositoryRoot(), grounding.referenceCampaign.resultsPath);
  return renderGroundingReport({
    records: own,
    modelArms,
    problemIds: config.problems.ids,
    manifestCriterion: recordedGroundingCriterion(manifestText),
    deferredSlots: CompletedSampleIndex.fromRecords(own, configHash).deferredSize(),
    // The Reference_Campaign's own Control_Arm records, read as a CROSS-RUN reading only.
    baseline: readBaseline({
      text: await readTextFileOrNull(referencePath),
      configHash: grounding.referenceCampaign.configHash,
      schemaVersion: grounding.referenceCampaign.schemaVersion,
      strategyArm: 'control',
      modelArms,
      problemIds: config.problems.ids,
    }),
    baselineRunName: basename(dirname(referencePath)),
  });
}

/** The manifest's recorded Grounding criterion, or null when the manifest cannot be read. */
function recordedGroundingCriterion(manifestText: string | null): unknown {
  if (manifestText === null) {
    return null;
  }
  try {
    const manifest = JSON.parse(manifestText) as {
      readonly groundingCampaign?: { readonly successCriterion?: unknown };
    };
    return manifest.groundingCampaign?.successCriterion ?? null;
  } catch {
    return null;
  }
}

/** The manifest's recorded `successCriterion`, or null when the manifest cannot be read. */
function recordedCriterion(manifestText: string | null): unknown {
  if (manifestText === null) {
    return null;
  }
  try {
    const manifest = JSON.parse(manifestText) as { readonly successCriterion?: unknown };
    return manifest.successCriterion ?? null;
  } catch {
    // An unparseable manifest records no criterion, and the verdict then decides nothing.
    return null;
  }
}

/** Aggregate and persist the summary for a run directory. */
async function writeSummary(
  outputDir: string,
  ks: readonly number[],
  configHash: string | null,
  config?: SweepConfig,
): Promise<readonly string[]> {
  const log = new FileResultsLog(resultsLogPath(outputDir));
  const parsed = parseResultsLog(await log.readAll());
  const summary = summarizeRecords(parsed.records, ks, configHash, parsed);
  const campaign =
    config === undefined || configHash === null
      ? []
      : await campaignLines(config, configHash, outputDir, parsed.records);
  // The declared arms, so an arm that recorded nothing still renders its 0/0 reportability row.
  const declaredArms =
    config?.arms.map((arm) => arm.name) ?? summary.arms.map((arm) => arm.armName);
  const lines = [...renderSummary(summary, { declaredArms, baseline: null }), ...campaign];
  await writeFile(join(outputDir, SUMMARY_FILENAME), `${lines.join('\n')}\n`, 'utf8');
  return lines;
}

/** Execute a prepared run and produce its report. */
async function execute(prepared: PreparedRun): Promise<SweepCliResult> {
  const { config, configHash, shared } = prepared;
  const outputDir = resolve(repositoryRoot(), config.outputDir);
  await ensureDirectory(outputDir);
  const log = new FileResultsLog(resultsLogPath(outputDir));
  const history = parseResultsLog(await log.readAll());
  // Wraps the log rather than sitting beside it: the persisted record is the only TYPED
  // per-sample signal this layer sees, and the Auth_Failure_Cause has to be seen while the
  // run is still dispatching, not after it has spent the matrix.
  const watch = new AuthFailureWatch(log, appendedSampleFacts);
  const report = (line: string): void => {
    console.log(line);
  };
  // Per-sample evidence goes under the run's own directory. A failed artifact write is
  // reported through the SAME progress channel as everything else and never stops the run,
  // so an operator sees evidence being lost while it happens (see artifact-store-node.ts).
  const artifactStore = config.captureArtifacts
    ? new FileSystemArtifactStore(artifactStoreDeps(outputDir, report))
    : null;
  const runner = new SweepRunner({
    config,
    configHash,
    problems: shared.problems,
    loopRunnerFor: (arm) => loopRunnerFor(shared, config, arm),
    ...(artifactStore === null
      ? {}
      : { artifactSinkFor: (arm: SweepArmConfig) => artifactStore.sinkFor(arm.name) }),
    // Omitted rather than passed as `null` when the gate is off, the same way the artifact sink
    // above is: absent is what the runner reads as "no Property_Set gate".
    ...(shared.propertySetGate === null ? {} : { propertySetGate: shared.propertySetGate }),
    goldenJudge: shared.goldenJudge,
    instrumentControl: shared.instrumentControl,
    resultsLog: watch,
    completed: CompletedSampleIndex.fromRecords(history.records, configHash, {
      testbenchPromptVersion: TESTBENCH_PROMPT_VERSION,
      simulationHarnessVersion: SIMULATION_HARNESS_VERSION,
      strategyOf: (armName) =>
        config.arms.find((arm) => arm.name === armName)?.strategy ?? 'control',
    }),
    killSwitch: new SweepKillSwitch(config.killSwitch, Date.now),
    // A refused credential stops dispatch exactly as a sustained outage does - at a sample
    // boundary, with in-flight samples still recorded - because the alternative measured in
    // the pilot was the whole remaining matrix spent on an expired token.
    outage: () => shared.breaker.outage() || watch.stopDispatch(),
    governor: shared.governor,
    waitMs: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    onProgress: report,
    writeManifest: () => writeJson(join(outputDir, MANIFEST_FILENAME), prepared.manifest),
  });
  const result = await runner.run();
  await writeJson(
    join(outputDir, MANIFEST_FILENAME),
    finalizeManifest(prepared.manifest, new Date().toISOString(), result.stopReason),
  );
  const summaryLines = await writeSummary(outputDir, config.ks, configHash, config);
  const shape = runShapeOf(result, watch.authFailures());
  return {
    exitCode: runExitStatus(shape),
    lines: [...runReportLines(prepared, result, shape), '', ...summaryLines],
  };
}

/** Injectable seams for the run entry, so a test drives it without the real host. */
export interface RunSweepOptions {
  /** Credential source; defaults to the one Credential_File-backed provider. */
  readonly secretManager?: SecretManagerPort;
}

/**
 * Validate, preflight, and run one sweep - without touching stdout or the exit code, so
 * the whole decision path is unit-testable.
 *
 * Progress lines are printed as they happen inside `execute` because a multi-hour run must
 * not be silent; the returned lines are the report, not the log.
 */
export async function runSweep(
  configPath: string,
  options: RunSweepOptions = {},
): Promise<SweepCliResult> {
  // Built ONCE here and handed to both preflight and prepare, so the probe and every
  // transport read the one Credential_File.
  const secretManager = options.secretManager ?? credentialProvider();
  const config = await loadConfig(configPath);
  if (isFailure(config)) {
    return { exitCode: 1, lines: renderPreflightFailure(config) };
  }
  const checked = await preflight(config, secretManager);
  if ('code' in checked) {
    return { exitCode: 1, lines: renderPreflightFailure(checked) };
  }
  const prepared = await prepare(config, checked.pythonBin, secretManager);
  if ('code' in prepared) {
    return { exitCode: 1, lines: renderPreflightFailure(prepared) };
  }
  return execute(prepared);
}

/**
 * Read a manifest's k values, or null when they cannot be read.
 *
 * The manifest is untrusted input like any other file on disk, and it is read for exactly
 * one field rather than re-parsed as a config: the embedded config is the PARSED shape
 * (with a nested `reproducibility` block), not the on-disk one the parser accepts.
 */
async function ksFromManifest(runDir: string): Promise<readonly number[] | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(runDir, MANIFEST_FILENAME), 'utf8'));
    const config = (raw as { readonly config?: { readonly ks?: unknown } }).config;
    const ks = config?.ks;
    if (!Array.isArray(ks) || ks.length === 0) {
      return null;
    }
    const valid = ks.filter(
      (value): value is number =>
        typeof value === 'number' && Number.isInteger(value) && value >= 1,
    );
    return valid.length === ks.length ? valid : null;
  } catch {
    // A missing or unreadable manifest is not fatal for a summarize: the caller falls back
    // to a derived k set and says so, which is better than refusing to read the results.
    return null;
  }
}

/**
 * Re-summarize an existing run directory with no re-run.
 *
 * Reads the k values from the run's own manifest so the re-summary matches the original;
 * when the manifest is unavailable it falls back to pass@1 and states that in the output,
 * rather than inventing a k set silently.
 */
export async function summarizeSweepRun(runDir: string): Promise<SweepCliResult> {
  const log = new FileResultsLog(resultsLogPath(runDir));
  let text: string;
  try {
    text = await log.readAll();
  } catch {
    return { exitCode: 1, lines: ['eval sweep: the results log could not be read'] };
  }
  if (text.trim().length === 0) {
    return { exitCode: 1, lines: ['eval sweep: no results log found in that directory'] };
  }
  const ks = await ksFromManifest(runDir);
  const parsed = parseResultsLog(text);
  const summary = summarizeRecords(parsed.records, ks ?? [1], null, parsed);
  const note =
    ks === null ? ['note: the run manifest was unreadable, so only pass@1 is reported'] : [];
  // A refused summary is an operator action, not a report: it exits non-zero so a script that
  // re-summarizes an old run directory cannot mistake the refusal for a result.
  return {
    exitCode: summary.refusedStaleSchema ? 1 : 0,
    lines: [...note, ...renderSummary(summary)],
  };
}

/** Dispatch one parsed command. */
export async function runSweepCli(argv: readonly string[]): Promise<SweepCliResult> {
  const command = parseSweepArgs(argv);
  if (command.kind === 'usage') {
    return { exitCode: 1, lines: [`eval sweep: ${command.problem}`, ...SWEEP_USAGE] };
  }
  if (command.kind === 'summarize') {
    return summarizeSweepRun(command.runDir);
  }
  return runSweep(command.configPath);
}

/** Wire the real defaults, print the report, and set the exit code. */
async function main(): Promise<void> {
  const result = await runSweepCli(process.argv.slice(2));
  for (const line of result.lines) {
    console.log(line);
  }
  process.exitCode = result.exitCode;
}

// Run only when executed directly, not when imported by a test. Any unexpected throw
// fails the run safely with a sanitized message and a non-zero exit.
const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error(`eval sweep failed: ${message}`);
    process.exitCode = 1;
  });
}
