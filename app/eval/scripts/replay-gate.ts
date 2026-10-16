// The Replay_Gate driver (testbench-spec-grounding, C12): replays every recorded Control_Arm
// testbench of the Reference_Campaign against its reference design, twice - once through
// today's pipeline, once through this spec's harness pipeline - and makes NO model call.
//
// Two modes. `--select` measures the simulated end times under a deliberately huge ceiling and
// prints the Watchdog_Budget to commit; `--verify` runs both replays at the committed constants
// and writes `replay-gate.json`, which the Campaign's preflight refuses to start without.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeDialect, requiredChecksFor } from '@app/agent';
import {
  DUMP_LIMIT_BYTES,
  IcarusSimulatorAdapter,
  LocalWorkerRuntime,
  SandboxToolRunner,
  SIMULATION_HARNESS_VERSION,
  WATCHDOG_BUDGET_NS,
  assembleSimulateJob,
  interpretSandboxResult,
  renderSimulationHarness,
  type ResourceLimits,
  type SandboxJob,
  type SimulationVerdict,
  type SourceFile,
} from '@app/tools';
import { NORMALIZER_VERSION } from '@app/agent';

import { CONTROL_TESTBENCH_WORKSPACE_FILENAME } from '../corpus/rtllm-instrument-control.js';
import { FileSystemCorpusCheckout, importRtllmCorpus } from '../corpus/index.js';
import { RTLLM_CHECKOUT_PATH } from '../corpus/fetch-node.js';
import {
  decideReplayGate,
  replayRunOf,
  roundValueAbove,
  type ReplayGateReport,
  type ReplayPair,
  type ReplayRun,
  type ReplaySampleKey,
} from '../replay-gate.js';
import { findWorkerPython, probeToolchainVersions } from '../sweep/host-facts.js';

/** The Reference_Campaign's own sandbox caps, so a replay is the run it replays. */
const LIMITS: ResourceLimits = { cpu: 1, memMb: 2048, procs: 64, diskMb: 128, wallMs: 30_000 };

/** How many replays run at once; the local worker is a process per run. */
const CONCURRENCY = 3;

/**
 * The `--select` measurement ceiling: 1000 s simulated, so only the wall clock can stop a hung
 * run and every finishing run reports its true end time.
 */
const MEASUREMENT_CEILING_NS = 1_000_000_000_000;

/** This module's directory, for the both-layouts path rule (dist runs one level deeper). */
const HERE = dirname(fileURLToPath(import.meta.url));

/** The repository root, named from this module's own location in either layout. */
const REPOSITORY_ROOT = resolve(HERE, HERE.includes(`${'dist'}/`) ? '../../../..' : '../../..');

/** One Replay_Set member: a recorded Control_Arm sample with a testbench to replay. */
interface ReplaySample {
  readonly key: ReplaySampleKey;
  /** The normalized source the Reference_Campaign actually ran. */
  readonly recordedSource: string;
  /** The model's raw reply source, which this spec's pipeline would normalize itself. */
  readonly rawSource: string;
}

/** Read one artifact file, or null when it is absent. */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Directory entries that are directories, by name. */
async function subdirectories(path: string): Promise<readonly string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/**
 * Collect the Replay_Set: every `*.control` arm sample carrying a testbench and a recorded
 * control stream. The problem id comes from `outcome.json`, never from the directory name,
 * because the directory name is a flattened form.
 */
export async function collectReplaySet(artifactsRoot: string): Promise<readonly ReplaySample[]> {
  const samples: ReplaySample[] = [];
  for (const arm of (await subdirectories(artifactsRoot)).filter((name) =>
    name.endsWith('.control'),
  )) {
    const armRoot = join(artifactsRoot, arm);
    for (const design of await subdirectories(armRoot)) {
      const designRoot = join(armRoot, design);
      for (const sample of await subdirectories(designRoot)) {
        const directory = join(designRoot, sample);
        const testbench = await readIfPresent(join(directory, 'testbench.v'));
        const stdout = await readIfPresent(join(directory, 'control-stdout.txt'));
        const stderr = await readIfPresent(join(directory, 'control-stderr.txt'));
        const outcome = await readIfPresent(join(directory, 'outcome.json'));
        if (testbench === null || outcome === null || (stdout === null && stderr === null)) {
          continue;
        }
        const parsed = JSON.parse(outcome) as {
          readonly problemId?: unknown;
          readonly sampleIndex?: unknown;
        };
        if (typeof parsed.problemId !== 'string' || typeof parsed.sampleIndex !== 'number') {
          continue;
        }
        const raw = await readIfPresent(join(directory, 'pre-normalization-testbench.v'));
        samples.push({
          key: { problemId: parsed.problemId, modelArm: arm, sample: parsed.sampleIndex },
          recordedSource: testbench,
          rawSource: raw ?? testbench,
        });
      }
    }
  }
  return samples;
}

/** The adapter and the harness-substituting runner share one Tool_Runner. */
interface Replayer {
  /** Today's Positive_Control job: no harness, no entry. */
  baseline(reference: SourceFile, testbench: string): Promise<SimulationVerdict>;
  /** This spec's job, with the harness rendered at `budgetNs`. */
  harnessed(
    reference: SourceFile,
    testbench: string,
    requiredCheckNames: readonly string[],
    budgetNs: number,
  ): Promise<SimulationVerdict>;
}

/**
 * Build the replayer over the local worker.
 *
 * The harness file is substituted into the assembled job rather than passed to the adapter,
 * because `--select` needs a harness at the measurement ceiling and the adapter only ever
 * compiles the committed one.
 */
function buildReplayer(pythonBin: string): Replayer {
  const runner = new SandboxToolRunner(new LocalWorkerRuntime(pythonBin));
  const adapter = new IcarusSimulatorAdapter(runner);
  const testbenchFile = (contents: string): SourceFile => ({
    path: CONTROL_TESTBENCH_WORKSPACE_FILENAME,
    contents,
  });
  return {
    baseline: (reference, testbench) =>
      adapter.simulate([reference], testbenchFile(testbench), LIMITS),
    harnessed: async (reference, testbench, requiredCheckNames, budgetNs) => {
      const run = { requiredCheckNames };
      const assembled = assembleSimulateJob([reference], testbenchFile(testbench), LIMITS, run);
      const harness = renderSimulationHarness(budgetNs, DUMP_LIMIT_BYTES);
      const job: SandboxJob = {
        ...assembled,
        workspaceFiles: assembled.workspaceFiles.map((file) =>
          file.path === harness.path ? harness : file,
        ),
      };
      const result = await runner.run(job);
      return interpretSandboxResult(
        result,
        job.workspaceFiles.map((file) => file.path),
        run,
      );
    },
  };
}

/** Run `tasks` at most `CONCURRENCY` at a time, preserving input order in the result. */
async function inParallel<T>(tasks: readonly (() => Promise<T>)[]): Promise<readonly T[]> {
  const results: T[] = new Array<T>(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      const task = tasks[index];
      if (task !== undefined) {
        results[index] = await task();
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/** Everything one replay needs that is not a mode decision. */
interface ReplayContext {
  readonly replayer: Replayer;
  readonly references: ReadonlyMap<string, SourceFile>;
  readonly requiredCheckNames: ReadonlyMap<string, readonly string[]>;
}

/** The harness-pipeline replay of one sample at `budgetNs`, or null without a reference. */
async function harnessReplay(
  context: ReplayContext,
  sample: ReplaySample,
  budgetNs: number,
): Promise<ReplayRun | null> {
  const reference = context.references.get(sample.key.problemId);
  if (reference === undefined) {
    return null;
  }
  const normalized = normalizeDialect(sample.rawSource).source;
  const names = context.requiredCheckNames.get(sample.key.problemId) ?? [];
  return replayRunOf(await context.replayer.harnessed(reference, normalized, names, budgetNs));
}

/** Load the corpus references and each design's Control_Arm Required_Check names. */
async function loadCorpus(): Promise<Omit<ReplayContext, 'replayer'>> {
  const corpus = await importRtllmCorpus(new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH));
  const references = new Map<string, SourceFile>();
  for (const [problemId, reference] of corpus.references) {
    references.set(problemId, reference.rtl);
  }
  const requiredCheckNames = new Map<string, readonly string[]>();
  for (const problem of corpus.problems) {
    requiredCheckNames.set(
      problem.id,
      requiredChecksFor(problem.spec, 'control').map((check) => check.name),
    );
  }
  return { references, requiredCheckNames };
}

/** `--select`: print the Watchdog_Budget the measured end times imply. */
async function select(context: ReplayContext, samples: readonly ReplaySample[]): Promise<void> {
  const measured = await inParallel(
    samples.map((sample) => async () => {
      const reference = context.references.get(sample.key.problemId);
      if (reference === undefined) {
        return null;
      }
      const baseline = replayRunOf(
        await context.replayer.baseline(reference, sample.recordedSource),
      );
      if (baseline.ending !== 'finished') {
        return null;
      }
      return harnessReplay(context, sample, MEASUREMENT_CEILING_NS);
    }),
  );
  const ends = measured
    .filter((run): run is ReplayRun => run !== null)
    .map((run) => run.simulatedEndNs)
    .filter((end): end is number => end !== null);
  const maxEndNs = ends.length === 0 ? 0 : Math.max(...ends);
  console.log(
    JSON.stringify(
      {
        replaySetSize: samples.length,
        finishedBaselines: ends.length,
        maxFinishedEndNs: maxEndNs,
        selectedBudgetNs: roundValueAbove(maxEndNs),
      },
      null,
      2,
    ),
  );
}

/** `--verify`: run both replays at the committed constants and write the report. */
async function verify(
  context: ReplayContext,
  samples: readonly ReplaySample[],
  reportPath: string,
): Promise<ReplayGateReport> {
  const pairs = await inParallel(
    samples.map((sample) => async (): Promise<ReplayPair | null> => {
      const reference = context.references.get(sample.key.problemId);
      if (reference === undefined) {
        return null;
      }
      const baseline = replayRunOf(
        await context.replayer.baseline(reference, sample.recordedSource),
      );
      const harness = await harnessReplay(context, sample, WATCHDOG_BUDGET_NS);
      return harness === null ? null : { key: sample.key, baseline, harness };
    }),
  );
  const report = decideReplayGate({
    pairs: pairs.filter((pair): pair is ReplayPair => pair !== null),
    simulationHarnessVersion: SIMULATION_HARNESS_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
    watchdogBudgetNs: WATCHDOG_BUDGET_NS,
    dumpLimitBytes: DUMP_LIMIT_BYTES,
    iverilogVersion: probeToolchainVersions(null).iverilogVersion ?? 'unknown',
    baselineDrift: 0,
  });
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

/** The two modes, plus where to read and write. */
export interface ReplayGateArgs {
  readonly mode: 'select' | 'verify';
  readonly artifactsRoot: string;
  readonly reportPath: string;
}

/** Parse the driver's arguments; the paths are arguments so a test can point at fixtures. */
export function parseReplayGateArgs(argv: readonly string[]): ReplayGateArgs {
  const mode = argv.includes('--select') ? 'select' : 'verify';
  const valueOf = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  return {
    mode,
    artifactsRoot:
      valueOf('--artifacts') ?? join(REPOSITORY_ROOT, '.eval-runs/scoreboard-ab-v1/artifacts'),
    reportPath:
      valueOf('--report') ??
      join(REPOSITORY_ROOT, '.eval-runs/reportability-slice-v1/replay-gate.json'),
  };
}

/** Run the driver; exported so the integration test drives it over fixtures. */
export async function runReplayGate(args: ReplayGateArgs): Promise<ReplayGateReport | null> {
  const pythonBin = findWorkerPython();
  if (pythonBin === null) {
    throw new Error('no Python interpreter can import the tool_runner_worker package');
  }
  const samples = await collectReplaySet(args.artifactsRoot);
  const context = { ...(await loadCorpus()), replayer: buildReplayer(pythonBin) };
  if (args.mode === 'select') {
    await select(context, samples);
    return null;
  }
  const report = await verify(context, samples, args.reportPath);
  console.log(
    `replay-gate: ${report.passed ? 'PASSED' : 'FAILED'} over ${String(report.replaySetSize)} samples`,
  );
  console.log(JSON.stringify({ ...report, verdictChanges: report.verdictChanges.length }, null, 2));
  return report;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runReplayGate(parseReplayGateArgs(process.argv.slice(2))).catch((error: unknown) => {
    // A local operator script: the message names what to fix, and no secret is ever read here.
    const reason = error instanceof Error ? error.message : 'unknown failure';
    console.error(`replay-gate: ${reason}`);
    process.exitCode = 1;
  });
}
