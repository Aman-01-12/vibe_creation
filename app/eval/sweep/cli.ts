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
//              under the bedrock-mantle transport, credentials from EnvSecretManager.
//   corpus     the pinned RTLLM checkout, imported and reduced to the SCORED set.
//
// FAIL FAST, NEVER FAKE
//   Preflight refuses to start when the credential, the corpus, or the toolchain is
//   absent, and says which command or variable fixes it. There is no fallback path that
//   substitutes a fake oracle or a fake provider: a run that cannot produce a real verdict
//   must not run at all, because its output would look like a result.
//
// EXIT CODES
//   0  the matrix completed, or stopped at a bound the operator configured (wall clock,
//      sample cap) with every completed sample recorded.
//   1  preflight refused, or the run stopped on a condition the operator must act on (a
//      sustained provider outage, or a results log that could not be written).

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createFetchJsonHttpPort,
  EnvSecretManager,
  type JsonHttpPort,
  type ModelPriceTable,
  type SecretManagerPort,
} from '@app/agent';
import { FileSystemOkfBundleReader, OkfFirstKnowledgeRetriever } from '@app/knowledge';
import { IcarusSimulatorAdapter, LocalWorkerRuntime, SandboxToolRunner } from '@app/tools';

import {
  FileSystemCorpusCheckout,
  importRtllmCorpus,
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
import type { InstrumentControl } from '../instrument-control.js';
import type { MutationNegativeControl } from '../mutation-control.js';
import type { EvalLoopRunner } from '../loop-runner.js';
import type { EvalProblem } from '../problem.js';
import { evalRoutingPolicy } from '../routing-policy.js';
import { EvalVerificationLoopRunner } from '../verification-loop-runner.js';
import { ARTIFACTS_DIRNAME } from './artifact-layout.js';
import { FileSystemArtifactStore } from './artifact-store-node.js';
import { mutationConfigFor, type SweepArmConfig, type SweepConfig } from './config.js';
import { parseSweepConfig } from './config-parse.js';
import { sweepConfigHash } from './config-identity.js';
import { FileSystemCalibrationCache } from './mutation-cache-node.js';
import {
  probeHarnessProvenance,
  probeHost,
  probeToolchainAvailability,
  probeToolchainVersions,
} from './host-facts.js';
import { SweepKillSwitch } from './kill-switch.js';
import {
  assembleManifest,
  finalizeManifest,
  MANIFEST_FILENAME,
  type SweepManifest,
} from './manifest.js';
import {
  checkCorpus,
  checkCredential,
  preflightFailure,
  renderPreflightFailure,
  toolchainFailure,
  type PreflightFailure,
} from './preflight.js';
import { selectProblems } from './problem-selection.js';
import { parseResultsLog, CompletedSampleIndex } from './results-log.js';
import { ensureDirectory, FileResultsLog, resultsLogPath } from './results-log-node.js';
import { SweepRunner, type SweepRunResult } from './runner.js';
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
    secretManager: shared.secretManager,
  });
}

/** Everything preflight established, ready to run. */
interface PreparedRun {
  readonly config: SweepConfig;
  readonly configHash: string;
  readonly shared: SharedStack;
  readonly manifest: SweepManifest;
  readonly pythonBin: string;
}

/** Run every preflight check in cost order: cheapest and most likely first. */
async function preflight(
  config: SweepConfig,
  secretManager: SecretManagerPort,
): Promise<PreflightFailure | { readonly pythonBin: string }> {
  const credential = await checkCredential(secretManager);
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
 * Build the MUTATION-BASED NEGATIVE CONTROL, or `null` when the config disables it.
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
function buildNegativeControl(
  config: SweepConfig,
  corpus: RtllmCorpus,
  sandboxRuntime: LocalWorkerRuntime,
): MutationNegativeControl | null {
  if (!config.negativeControl.enabled) {
    return null;
  }
  const mutationConfig = mutationConfigFor(config);
  const mutantWallMs = config.negativeControl.mutantWallMs;
  const cacheKey = {
    corpusCommit: corpus.pinnedCommit,
    mutationConfigHash: mutationConfigHash(mutationConfig, sha256Hex),
    // The cap is part of the key because it can change a verdict: a slow-but-terminating mutant
    // is `golden-killed` under a wide cap and `golden-timeout` under a narrow one.
    mutantWallMs,
  };
  return new RtllmMutationNegativeControl({
    simulator: new IcarusSimulatorAdapter(new SandboxToolRunner(sandboxRuntime)),
    calibrator: new RtllmMutationCalibrator({
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
    }),
  });
}

/** Compose the shared stack and the manifest once preflight has passed. */
async function prepare(
  config: SweepConfig,
  pythonBin: string,
  secretManager: SecretManagerPort,
): Promise<PreparedRun | PreflightFailure> {
  const corpus = scoredRtllmCorpus(
    await importRtllmCorpus(new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH)),
  );
  const selected = selectProblems(corpus.problems, config.problems);
  if (!selected.ok) {
    return preflightFailure(
      'selection-empty',
      selected.error.message,
      'adjust problems and re-run',
    );
  }
  const sandboxRuntime = new LocalWorkerRuntime(pythonBin);
  const breaker = new TransportCircuitBreaker(config.transportRetry, Date.now);
  const governor = new ThrottleGovernor(config.concurrency, Date.now);
  const negativeControl = buildNegativeControl(config, corpus, sandboxRuntime);
  const shared: SharedStack = {
    http: buildHttpPort(config.transportRetry, breaker, governor),
    breaker,
    governor,
    sandboxRuntime,
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
  const configHash = sweepConfigHash(config, sha256Hex);
  return {
    config,
    configHash,
    shared,
    pythonBin,
    manifest: assembleManifest({
      config,
      configHash,
      selectedProblemIds: selected.value.map((problem) => problem.id),
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

/** The lines that report a finished run, including the honesty warnings. */
function runReportLines(prepared: PreparedRun, result: SweepRunResult): readonly string[] {
  const dirty = prepared.manifest.harness.workingTreeDirty;
  const config = prepared.config;
  return [
    '',
    `run ${config.runName} stopped: ${result.stopReason}`,
    `planned ${result.plannedSamples}, skipped-as-already-recorded ${result.skippedSamples}, ` +
      `dispatched ${result.dispatchedSamples}, recorded ${result.recordedSamples}, ` +
      `no-verdict ${result.failedSamples}`,
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

/** Aggregate and persist the summary for a run directory. */
async function writeSummary(
  outputDir: string,
  ks: readonly number[],
  configHash: string | null,
): Promise<readonly string[]> {
  const log = new FileResultsLog(resultsLogPath(outputDir));
  const parsed = parseResultsLog(await log.readAll());
  const summary = summarizeRecords(parsed.records, ks, configHash, parsed);
  const lines = renderSummary(summary);
  await writeFile(join(outputDir, SUMMARY_FILENAME), `${lines.join('\n')}\n`, 'utf8');
  return lines;
}

/** Execute a prepared run and produce its report. */
async function execute(prepared: PreparedRun): Promise<SweepCliResult> {
  const { config, configHash, shared } = prepared;
  const outputDir = resolve(repositoryRoot(), config.outputDir);
  await ensureDirectory(outputDir);
  await writeJson(join(outputDir, MANIFEST_FILENAME), prepared.manifest);
  const log = new FileResultsLog(resultsLogPath(outputDir));
  const history = parseResultsLog(await log.readAll());
  const report = (line: string): void => {
    console.log(line);
  };
  // Per-sample evidence goes under the run's own directory. A failed artifact write is
  // reported through the SAME progress channel as everything else and never stops the run,
  // so an operator sees evidence being lost while it happens (see artifact-store-node.ts).
  const artifactStore = config.captureArtifacts
    ? new FileSystemArtifactStore({ outputDir, onNote: report })
    : null;
  const runner = new SweepRunner({
    config,
    configHash,
    problems: shared.problems,
    loopRunnerFor: (arm) => loopRunnerFor(shared, config, arm),
    ...(artifactStore === null
      ? {}
      : { artifactSinkFor: (arm: SweepArmConfig) => artifactStore.sinkFor(arm.name) }),
    goldenJudge: shared.goldenJudge,
    instrumentControl: shared.instrumentControl,
    // Unconditionally on for every real CLI-driven run: this is the eval layer's own
    // Testbench_Repair capability being exercised end to end, not a per-experiment
    // variable a bake-off permutes (unlike `arm.roleModels`), so there is no config
    // field gating it the way `negativeControl.enabled` gates the mutation control.
    testbenchRepairEnabled: true,
    resultsLog: log,
    completed: CompletedSampleIndex.fromRecords(history.records, configHash),
    killSwitch: new SweepKillSwitch(config.killSwitch, Date.now),
    outage: () => shared.breaker.outage(),
    governor: shared.governor,
    waitMs: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    onProgress: report,
  });
  const result = await runner.run();
  await writeJson(
    join(outputDir, MANIFEST_FILENAME),
    finalizeManifest(prepared.manifest, new Date().toISOString(), result.stopReason),
  );
  const summaryLines = await writeSummary(outputDir, config.ks, configHash);
  return {
    exitCode: CLEAN_STOP_REASONS.includes(result.stopReason) ? 0 : 1,
    lines: [...runReportLines(prepared, result), '', ...summaryLines],
  };
}

/** Injectable seams for the run entry, so a test drives it without the real host. */
export interface RunSweepOptions {
  /** Credential source; defaults to the env-backed manager (the only env reader). */
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
  const secretManager = options.secretManager ?? new EnvSecretManager();
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
