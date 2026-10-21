// Task 18.1: the reference-model pilot over the Pilot_Design_Set (Req 5.8, 16.3). PARKED and paid.
//
// Drives the C7 pieces directly against each design's own reference RTL: a failure is always the
// Reference_Model's, never a candidate's. Every reply is saved, so `--replay <runDir>` re-judges a
// run with zero model calls. Operator script, not a shipped component.

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildReferenceModelInput,
  checkAuthoringContract,
  createBedrockMantleTransport,
  createFetchJsonHttpPort,
  createModelRouter,
  DEFAULT_CREDENTIAL_FILE,
  InMemorySessionBudgetHandle,
  InMemoryTracePersistence,
  MODEL_TASKS,
  parseReferenceModelDraft,
  primarySelectionFor,
  REFERENCE_MODEL_PROMPT_VERSION,
  RefreshingSecretManager,
  singleProviderRoutingPolicy,
  TraceActionRecorder,
  type ExcludedConstruct,
  type ModelRouter,
  type ReferenceModelDraft,
} from '@app/agent';
import {
  makeSessionBudget,
  makeTimingContract,
  newUlid,
  type ModuleInterface,
  type Spec,
} from '@app/core';
import {
  IcarusSimulatorAdapter,
  LocalWorkerRuntime,
  referenceModelFunctionHeaders,
  renderConsensusHarness,
  SAMPLE_BUDGET,
  SandboxToolRunner,
  type ResourceLimits,
  type SimulatorAdapter,
  type SourceFile,
} from '@app/tools';

import { FileSystemCorpusCheckout } from '../corpus/checkout-port.js';
import { RTLLM_CHECKOUT_PATH } from '../corpus/fetch-node.js';
import { importRtllmCorpus } from '../corpus/import.js';
import { localTimingDerivation } from '../corpus/timing-derivation-node.js';
import { findWorkerPython } from '../sweep/host-facts.js';

const PILOT_PROBLEM_IDS = [
  'rtllm/control/counter_12',
  'rtllm/miscellaneous/traffic_light',
  'rtllm/arithmetic/accu',
] as const;

/** Enough draws that a 50% share is a measurement rather than a coin flip. */
const SAMPLES_PER_DESIGN = 8;
/** The four Model_Arms every campaign since grounding-ab-v1 has run; the gate's pool spans them. */
const MODEL_IDS = ['moonshotai.kimi-k2.5', 'zai.glm-5', 'zai.glm-4.7', 'deepseek.v3.2'] as const;
const REFMODEL_PATH = 'refmodel.v';
// Takes the shared SAMPLE_BUDGET (2048) rather than its own, which raises the pilot's rendered
// budget from the 64 it used before this task 32-fold. Every figure measured from here on is a
// 2048-step figure and is not comparable with the recorded 64-step probe table (C7).
const WATCHDOG_BUDGET_NS = 2_000_000;
const MAX_DIAGNOSTIC_LINES = 5;
const LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, HERE.includes(`${'dist'}/`) ? '../../../..' : '../../..');

/** Which of the three model-written bodies a compile diagnostic or a mismatch points at. */
export type BodyName = 'ece_reset_state' | 'ece_next_state' | 'ece_expect';

const BODY_ORDER: readonly BodyName[] = ['ece_reset_state', 'ece_next_state', 'ece_expect'];

/** Where one draw stopped; `pass` is the only success. */
export type PilotOutcome =
  'router' | 'parse' | 'authoring-contract' | 'compile' | 'run-error' | 'mismatch' | 'pass';

/** The first CHECK FAIL line of a run, located by step and port. */
export interface FirstMismatch {
  readonly step: number;
  readonly port: string;
  readonly expected: string;
  readonly got: string;
}

export interface PilotSample {
  readonly modelId: string;
  readonly problemId: string;
  readonly sampleIndex: number;
  readonly outcome: PilotOutcome;
  readonly excludedConstructs: readonly ExcludedConstruct[];
  /** Bodies a compile diagnostic named; empty unless `outcome === 'compile'`. */
  readonly bodiesNamedByCompiler: readonly BodyName[];
  /** First diagnostic lines, bounded; tool output, never model text. */
  readonly diagnostics: readonly string[];
  readonly firstMismatch: FirstMismatch | null;
  /** Steps with at least one failing CHECK, out of the steps the run sampled. */
  readonly failingSteps: number;
  readonly sampledSteps: number;
  readonly tokensUsed: number;
}

/** One rendered Reference_Model file, plus the 1-based line range each body occupies. */
interface RenderedRefModel {
  readonly file: SourceFile;
  readonly bodyLines: Readonly<Record<BodyName, { readonly first: number; readonly last: number }>>;
}

/** Wrap the four bodies in the harness's own headers, recording where each body landed. */
export function renderRefModel(
  moduleInterface: ModuleInterface,
  draft: ReferenceModelDraft,
): RenderedRefModel {
  const headers = referenceModelFunctionHeaders(moduleInterface);
  const parts: readonly [BodyName, string, string][] = [
    ['ece_reset_state', headers.resetState, draft.resetStateBody],
    ['ece_next_state', headers.nextState, draft.nextStateBody],
    ['ece_expect', headers.expect, draft.expectBody],
  ];
  const lines: string[] = [];
  const bodyLines = {} as Record<BodyName, { first: number; last: number }>;
  for (const [name, header, body] of parts) {
    lines.push(header);
    const bodyText = body.split('\n');
    bodyLines[name] = { first: lines.length + 1, last: lines.length + bodyText.length };
    lines.push(...bodyText, 'endfunction');
  }
  return { file: { path: REFMODEL_PATH, contents: `${lines.join('\n')}\n` }, bodyLines };
}

/** The bodies an iverilog diagnostic names by `refmodel.v:<line>:`, in body order. */
export function bodiesNamedBy(stderr: string, rendered: RenderedRefModel): readonly BodyName[] {
  const named = new Set<BodyName>();
  for (const match of stderr.matchAll(/refmodel\.v:(\d+):/gu)) {
    const line = Number(match[1]);
    for (const [name, range] of Object.entries(rendered.bodyLines) as [
      BodyName,
      { first: number; last: number },
    ][]) {
      if (line >= range.first && line <= range.last) {
        named.add(name);
      }
    }
  }
  return BODY_ORDER.filter((n) => named.has(n));
}

/** The first failing CHECK, and how many sampled steps had any failing CHECK. */
export function locateMismatches(
  stdout: string,
  nonce: string,
): {
  readonly first: FirstMismatch | null;
  readonly failingSteps: number;
  readonly sampledSteps: number;
} {
  const failPattern = new RegExp(`^CHECK ${nonce}_(\\w+) FAIL: expected (\\S+), got (\\S+)`, 'u');
  const samplePrefix = `ECE_SAMPLE ${nonce} `;
  let step = 0;
  let stepFailed = false;
  let failingSteps = 0;
  let first: FirstMismatch | null = null;
  for (const line of stdout.split('\n')) {
    const fail = failPattern.exec(line.trim());
    if (fail !== null) {
      stepFailed = true;
      first ??= { step, port: fail[1] ?? '', expected: fail[2] ?? '', got: fail[3] ?? '' };
    } else if (line.startsWith(samplePrefix)) {
      failingSteps += stepFailed ? 1 : 0;
      stepFailed = false;
      step += 1;
    }
  }
  return { first, failingSteps, sampledSteps: step };
}

/** Bounded first non-empty lines of tool output. */
function firstLines(text: string): readonly string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_DIAGNOSTIC_LINES);
}

/** Every pilot output port is synchronous (`always @(posedge clk ...)`), so registered is the fact. */
function registeredContract(moduleInterface: ModuleInterface) {
  const built = makeTimingContract(
    moduleInterface,
    moduleInterface.ports
      .filter((port) => port.direction === 'output')
      .map((port) => ({ portName: port.name, timing: 'registered' as const })),
  );
  if (!built.ok) {
    throw new Error(`pilot defect: ${built.error.code}`);
  }
  return built.value;
}

type Judged = Omit<PilotSample, 'modelId' | 'problemId' | 'sampleIndex' | 'tokensUsed'>;

const NOT_RUN = {
  excludedConstructs: [],
  bodiesNamedByCompiler: [],
  diagnostics: [],
  firstMismatch: null,
  failingSteps: 0,
  sampledSteps: 0,
} as const;

/** Parse, contract-check, render, and simulate one saved reply. Makes no model call. */
export async function judgeReply(
  spec: Spec,
  referenceRtl: SourceFile,
  reply: string,
  simulator: SimulatorAdapter,
): Promise<Judged> {
  const parsed = parseReferenceModelDraft(reply, spec.moduleInterface);
  if (!parsed.ok) {
    return { ...NOT_RUN, outcome: 'parse', diagnostics: [parsed.error.reason] };
  }
  const checked = checkAuthoringContract(parsed.value);
  if (checked.kind === 'rejected') {
    return { ...NOT_RUN, outcome: 'authoring-contract', excludedConstructs: checked.excluded };
  }
  const rendered = renderRefModel(spec.moduleInterface, checked.bodies);
  const nonce = `p${randomUUID().replace(/-/gu, '').slice(0, 12)}`;
  const harness = renderConsensusHarness({
    moduleInterface: spec.moduleInterface,
    timingContract: registeredContract(spec.moduleInterface),
    nonce,
    watchdogBudgetNs: WATCHDOG_BUDGET_NS,
    sampleBudget: SAMPLE_BUDGET,
    roles: parsed.value.roles,
  });
  if (!harness.ok) {
    throw new Error(`pilot defect: harness render failed: ${harness.error.code}`);
  }
  const verdict = await simulator.simulate([referenceRtl, rendered.file], harness.value, LIMITS);
  if (verdict.failureCause === 'build-failed') {
    return {
      ...NOT_RUN,
      outcome: 'compile',
      bodiesNamedByCompiler: bodiesNamedBy(verdict.stderr, rendered),
      diagnostics: firstLines(verdict.stderr),
    };
  }
  const located = locateMismatches(verdict.stdout, nonce);
  if (verdict.verdict === 'pass') {
    return { ...NOT_RUN, outcome: 'pass', sampledSteps: located.sampledSteps };
  }
  if (located.first === null) {
    return {
      ...NOT_RUN,
      outcome: 'run-error',
      diagnostics: [verdict.failureCause, ...firstLines(verdict.stderr)],
      sampledSteps: located.sampledSteps,
    };
  }
  return {
    ...NOT_RUN,
    outcome: 'mismatch',
    firstMismatch: located.first,
    failingSteps: located.failingSteps,
    sampledSteps: located.sampledSteps,
  };
}

function buildRouter(modelId: string): ModelRouter {
  const taskModel = Object.fromEntries(MODEL_TASKS.map((task) => [task, modelId])) as Record<
    (typeof MODEL_TASKS)[number],
    string
  >;
  const policy = singleProviderRoutingPolicy({ provider: 'bedrock-mantle', taskModel });
  const transport = createBedrockMantleTransport({
    http: createFetchJsonHttpPort(),
    config: {
      region: process.env.BEDROCK_REGION ?? 'us-east-1',
      defaultModelId: primarySelectionFor(policy, 'generation').modelId,
      temperature: 0,
      prices: {},
    },
  });
  return createModelRouter({
    secretManager: new RefreshingSecretManager({
      path: join(REPOSITORY_ROOT, DEFAULT_CREDENTIAL_FILE),
      readFile: async (path: string) => {
        try {
          return await readFile(path, 'utf8');
        } catch {
          return null;
        }
      },
    }),
    recorder: new TraceActionRecorder(new InMemoryTracePersistence(), newUlid),
    transports: { 'bedrock-mantle': transport },
    policy,
  });
}

/** A one-call budget; the single-entry chain means one attempt is the whole call. */
function oneCallBudget(): InMemorySessionBudgetHandle {
  const built = makeSessionBudget({
    sessionId: newUlid(),
    maxIterations: 1,
    maxTokens: 50_000,
    maxWallClockMs: 300_000,
    maxCostCents: 10_000,
    consumedIterations: 0,
    consumedTokens: 0,
    consumedMs: 0,
    consumedCostCents: 0,
  });
  if (!built.ok) {
    throw new Error('pilot budget construction must succeed');
  }
  return new InMemorySessionBudgetHandle(built.value);
}

function replyFilename(modelId: string, problemId: string, sampleIndex: number): string {
  const safe = (text: string) => text.replace(/[^A-Za-z0-9_-]/gu, '_');
  return `${safe(modelId)}__${safe(problemId)}__${String(sampleIndex)}.txt`;
}

/** Per-design tally over the pooled arms (what Req 5.8 reads), then per arm. */
function summarize(samples: readonly PilotSample[]) {
  return {
    pooled: tally(samples),
    byModel: Object.fromEntries(
      MODEL_IDS.map((modelId) => [modelId, tally(samples.filter((s) => s.modelId === modelId))]),
    ),
  };
}

/** Per-design tally of every outcome, the compiler-named bodies, and token spend. */
function tally(samples: readonly PilotSample[]) {
  return PILOT_PROBLEM_IDS.map((problemId) => {
    const mine = samples.filter((sample) => sample.problemId === problemId);
    const outcomes: Record<string, number> = {};
    const compileBodies: Record<string, number> = {};
    for (const sample of mine) {
      outcomes[sample.outcome] = (outcomes[sample.outcome] ?? 0) + 1;
      for (const body of sample.bodiesNamedByCompiler) {
        compileBodies[body] = (compileBodies[body] ?? 0) + 1;
      }
    }
    const passCount = outcomes.pass ?? 0;
    return {
      problemId,
      passCount,
      sampleCount: mine.length,
      passShare: mine.length === 0 ? 0 : passCount / mine.length,
      outcomes,
      compileBodies,
      totalTokens: mine.reduce((sum, sample) => sum + sample.tokensUsed, 0),
    };
  });
}

interface PilotInputs {
  readonly spec: Spec;
  readonly referenceRtl: SourceFile;
}

async function loadPilotInputs(): Promise<ReadonlyMap<string, PilotInputs>> {
  const corpus = await importRtllmCorpus(
    new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
    localTimingDerivation(),
  );
  const inputs = new Map<string, PilotInputs>();
  for (const problemId of PILOT_PROBLEM_IDS) {
    const problem = corpus.problems.find((candidate) => candidate.id === problemId);
    const reference = corpus.references.get(problemId);
    if (problem === undefined || reference === undefined) {
      throw new Error(`pilot defect: ${problemId} is not in the imported corpus`);
    }
    inputs.set(problemId, { spec: problem.spec, referenceRtl: reference.rtl });
  }
  return inputs;
}

function realSimulator(): SimulatorAdapter {
  const pythonBin = findWorkerPython();
  if (pythonBin === null) {
    throw new Error('pilot requires a Python interpreter that can import tool_runner_worker');
  }
  return new IcarusSimulatorAdapter(new SandboxToolRunner(new LocalWorkerRuntime(pythonBin)));
}

interface ArmRun {
  readonly modelId: string;
  readonly inputs: ReadonlyMap<string, PilotInputs>;
  readonly simulator: SimulatorAdapter;
  readonly outDir: string;
  readonly replayDir: string | null;
  readonly tokensByFile: ReadonlyMap<string, number>;
}

/** One reply: drawn from the model (paid) or read back from a saved run (free). */
async function replyFor(
  arm: ArmRun,
  router: ModelRouter | null,
  spec: Spec,
  filename: string,
): Promise<
  { readonly reply: string; readonly tokensUsed: number } | { readonly routerError: string }
> {
  if (router === null) {
    const reply = await readFile(join(arm.replayDir ?? arm.outDir, 'replies', filename), 'utf8');
    return { reply, tokensUsed: arm.tokensByFile.get(filename) ?? 0 };
  }
  const invoked = await router.invoke(
    'generation',
    buildReferenceModelInput(spec),
    oneCallBudget(),
  );
  if (!invoked.ok) {
    return { routerError: invoked.error.code };
  }
  await writeFile(join(arm.outDir, 'replies', filename), invoked.value.outputText, 'utf8');
  return { reply: invoked.value.outputText, tokensUsed: invoked.value.tokensUsed };
}

/** Every draw of one Model_Arm, in design then sample order. */
async function runArm(arm: ArmRun): Promise<readonly PilotSample[]> {
  const router = arm.replayDir === null ? buildRouter(arm.modelId) : null;
  const samples: PilotSample[] = [];
  for (const problemId of PILOT_PROBLEM_IDS) {
    const { spec, referenceRtl } = arm.inputs.get(problemId) as PilotInputs;
    for (let sampleIndex = 0; sampleIndex < SAMPLES_PER_DESIGN; sampleIndex += 1) {
      const where = { modelId: arm.modelId, problemId, sampleIndex };
      const drawn = await replyFor(
        arm,
        router,
        spec,
        replyFilename(arm.modelId, problemId, sampleIndex),
      );
      if ('routerError' in drawn) {
        samples.push({
          ...NOT_RUN,
          ...where,
          outcome: 'router',
          tokensUsed: 0,
          diagnostics: [drawn.routerError],
        });
        console.log(
          `${arm.modelId} ${problemId} #${String(sampleIndex)}: router ${drawn.routerError}`,
        );
        continue;
      }
      const judged = await judgeReply(spec, referenceRtl, drawn.reply, arm.simulator);
      samples.push({ ...judged, ...where, tokensUsed: drawn.tokensUsed });
      const detail =
        judged.firstMismatch === null
          ? judged.bodiesNamedByCompiler.join(',')
          : `step ${String(judged.firstMismatch.step)} ${judged.firstMismatch.port} exp ${judged.firstMismatch.expected} got ${judged.firstMismatch.got}`;
      console.log(
        `${arm.modelId} ${problemId} #${String(sampleIndex)}: ${judged.outcome} ${detail}`,
      );
    }
  }
  return samples;
}

/** Draw and judge every arm concurrently (paid), or re-judge saved replies from `replayDir` (free). */
async function runPilot(outDir: string, replayDir: string | null): Promise<void> {
  const inputs = await loadPilotInputs();
  const simulator = realSimulator();
  await mkdir(join(outDir, 'replies'), { recursive: true });
  const tokensByFile =
    replayDir === null ? new Map<string, number>() : await savedTokens(replayDir);
  const perArm = await Promise.all(
    MODEL_IDS.map((modelId) =>
      runArm({ modelId, inputs, simulator, outDir, replayDir, tokensByFile }),
    ),
  );
  const samples = perArm.flat();
  const summary = {
    promptVersion: REFERENCE_MODEL_PROMPT_VERSION,
    modelIds: MODEL_IDS,
    replayedFrom: replayDir,
    designs: summarize(samples),
  };
  await writeFile(join(outDir, 'samples.json'), `${JSON.stringify(samples, null, 2)}\n`, 'utf8');
  await writeFile(join(outDir, 'results.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

/** Token counts recorded by the run being replayed, keyed by reply filename. */
async function savedTokens(runDir: string): Promise<ReadonlyMap<string, number>> {
  const raw = JSON.parse(await readFile(join(runDir, 'samples.json'), 'utf8')) as readonly {
    readonly modelId: string;
    readonly problemId: string;
    readonly sampleIndex: number;
    readonly tokensUsed: number;
  }[];
  const replies = new Set(await readdir(join(runDir, 'replies')));
  const tokens = new Map<string, number>();
  for (const sample of raw) {
    const filename = replyFilename(sample.modelId, sample.problemId, sample.sampleIndex);
    if (replies.has(filename)) {
      tokens.set(filename, sample.tokensUsed);
    }
  }
  return tokens;
}

async function main(): Promise<void> {
  const replayAt = process.argv.indexOf('--replay');
  const replayDir = replayAt === -1 ? null : resolve(process.argv[replayAt + 1] ?? '');
  const mode = replayDir === null ? 'pilot' : 'replay';
  const runName = `consensus-${mode}-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
  const outDir = join(REPOSITORY_ROOT, '.eval-runs', runName);
  await mkdir(outDir, { recursive: true });
  console.log(`consensus ${mode} (prompt v${String(REFERENCE_MODEL_PROMPT_VERSION)}): ${outDir}`);
  await runPilot(outDir, replayDir);
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(`consensus pilot failed: ${error instanceof Error ? error.message : 'unknown'}`);
    process.exitCode = 1;
  });
}
