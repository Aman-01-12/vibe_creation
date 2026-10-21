// The Reply-format probe (testbench-spec-grounding, C18): does each of the four Model_Arms
// actually return ONE fenced Verilog block when the Grounded prompt asks for it?
//
// It exists because the Campaign's whole measurement rests on the reply parsing at all. A
// format refusal discovered on slot 1 of 760 would cost the run; discovered here it costs 12
// calls. `--send` makes those calls and SAVES the raw replies; `--parse` reads them offline, so
// a parser fix is re-measured against the same replies without paying again.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CREDENTIAL_FILE,
  RefreshingSecretManager,
  InMemoryTracePersistence,
  TESTBENCH_PARSE_REFUSALS,
  InMemorySessionBudgetHandle,
  TraceActionRecorder,
  buildGroundedTestbenchModelInput,
  MODEL_TASKS,
  createBedrockMantleTransport,
  createFetchJsonHttpPort,
  createModelRouter,
  parseFencedTestbenchDraft,
  primarySelectionFor,
  requiredChecksFor,
  type ModelRouter,
  type SessionBudgetHandle,
  type TestbenchParseRefusal,
} from '@app/agent';

import { makeSessionBudget, newUlid } from '@app/core';

import {
  FileSystemCorpusCheckout,
  importRtllmCorpus,
  localTimingDerivation,
} from '../corpus/index.js';
import { RTLLM_CHECKOUT_PATH } from '../corpus/fetch-node.js';
import type { EvalProblem } from '../problem.js';
import { evalRoutingPolicy, type EvalRoleModels } from '../routing-policy.js';

/** The two designs the probe always sends, plus the longest-architecture Campaign_Design. */
const FIXED_DESIGNS = ['rtllm/control/JC_counter', 'rtllm/arithmetic/multi_16bit'] as const;

/** Where the raw replies are saved; outside the Campaign's own directory on purpose. */
const PROBE_DIRNAME = '.eval-runs/grounding-confirmatory-v1-probe';

/** This module's directory, for the both-layouts path rule (dist runs one level deeper). */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, HERE.includes(`${'dist'}/`) ? '../../../..' : '../../..');

/** One probe outcome per reply: the parser's answer, or `accepted`. */
export type ProbeOutcome = 'accepted' | TestbenchParseRefusal;

/** The per-Model_Arm tally `--parse` prints. */
export type ProbeTally = Readonly<Record<string, Readonly<Record<string, number>>>>;

/** A saved reply: which arm and design it came from, and the raw text. */
interface SavedReply {
  readonly modelArm: string;
  readonly problemId: string;
  readonly reply: string;
}

/** The parser's answer for one raw reply (pure, total). */
export function probeOutcomeOf(reply: string): ProbeOutcome {
  const parsed = parseFencedTestbenchDraft(reply);
  return parsed.ok ? 'accepted' : parsed.error.refusal;
}

/** An all-zero tally, so every outcome is reported even at zero. */
function emptyOutcomes(): Record<string, number> {
  const tally: Record<string, number> = { accepted: 0 };
  for (const refusal of TESTBENCH_PARSE_REFUSALS) {
    tally[refusal] = 0;
  }
  return tally;
}

/** Tally the outcomes per Model_Arm (pure), so the print and a test read one rule. */
export function tallyReplies(replies: readonly SavedReply[]): ProbeTally {
  const tally: Record<string, Record<string, number>> = {};
  for (const saved of replies) {
    const arm = (tally[saved.modelArm] ??= emptyOutcomes());
    const outcome = probeOutcomeOf(saved.reply);
    arm[outcome] = (arm[outcome] ?? 0) + 1;
  }
  return tally;
}

/** A file name that cannot escape the probe directory: the two ids, slashes flattened. */
function replyFilename(modelArm: string, problemId: string): string {
  const flat = (text: string): string => text.replace(/[^A-Za-z0-9._-]/gu, '_');
  return `${flat(modelArm)}__${flat(problemId)}.txt`;
}

/** Read every saved reply under `directory`; a file whose name has no separator is skipped. */
export async function readSavedReplies(directory: string): Promise<readonly SavedReply[]> {
  let names: readonly string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const replies: SavedReply[] = [];
  for (const name of names.filter((entry) => entry.endsWith('.txt')).sort()) {
    const [modelArm, rest] = name.replace(/\.txt$/u, '').split('__');
    if (modelArm === undefined || rest === undefined) {
      continue;
    }
    replies.push({
      modelArm,
      problemId: rest,
      reply: await readFile(join(directory, name), 'utf8'),
    });
  }
  return replies;
}

/** The three designs the probe sends: the two fixed ones, plus the longest Architecture_Text. */
export function probeDesigns(
  problems: readonly EvalProblem[],
  campaignIds: readonly string[],
): readonly EvalProblem[] {
  const byId = new Map(problems.map((problem) => [problem.id, problem]));
  const fixed = FIXED_DESIGNS.map((id) => byId.get(id)).filter(
    (problem): problem is EvalProblem => problem !== undefined,
  );
  const longest = campaignIds
    .map((id) => byId.get(id))
    .filter((problem): problem is EvalProblem => problem !== undefined)
    .filter((problem) => !FIXED_DESIGNS.some((id) => id === problem.id))
    .sort((a, b) => b.spec.architecture.length - a.spec.architecture.length)
    .at(0);
  return longest === undefined ? fixed : [...fixed, longest];
}

/** The Campaign config's model host, prices, and design ids. */
interface ProbeConfig {
  readonly modelHost: {
    readonly region: string;
    readonly maxOutputTokens?: number;
    readonly requestTimeoutMs?: number;
  };
  readonly temperature: number;
  readonly problemIds: readonly string[];
  readonly modelArms: readonly string[];
}

/** Read the Campaign config, so the probe sends under the Campaign's own model host. */
async function readProbeConfig(): Promise<ProbeConfig> {
  const path = join(REPOSITORY_ROOT, 'app/eval/sweep/sweep.config.grounding-confirmatory-v1.json');
  const raw = JSON.parse(await readFile(path, 'utf8')) as {
    readonly modelHost: ProbeConfig['modelHost'];
    readonly temperature: number;
    readonly problems: { readonly ids: readonly string[] };
    readonly arms: readonly { readonly model: string; readonly strategy?: string }[];
  };
  return {
    modelHost: raw.modelHost,
    temperature: raw.temperature,
    problemIds: raw.problems.ids,
    modelArms: [
      ...new Set(raw.arms.filter((arm) => arm.strategy === 'grounded').map((a) => a.model)),
    ],
  };
}

/** Build one Model_Arm's router, composed exactly as the sweep composes a per-arm router. */
function routerFor(config: ProbeConfig, model: string): ModelRouter {
  // Every role on the one model, as a single-model Campaign arm declares it.
  const roleModels = Object.fromEntries(MODEL_TASKS.map((task) => [task, model])) as EvalRoleModels;
  const policy = evalRoutingPolicy({ taskModel: roleModels });
  const transport = createBedrockMantleTransport({
    http: createFetchJsonHttpPort(),
    config: {
      region: config.modelHost.region,
      defaultModelId: primarySelectionFor(policy, 'testbench').modelId,
      temperature: config.temperature,
      prices: {},
      ...(config.modelHost.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: config.modelHost.maxOutputTokens }),
      ...(config.modelHost.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: config.modelHost.requestTimeoutMs }),
    },
  });
  return createModelRouter({
    // THE SAME ONE SOURCE THE SWEEP RESOLVES THROUGH: the Credential_File, read per request,
    // with no environment fallback. A probe reading another source would either accept a
    // credential no Campaign request sends, or report a failure the Campaign will not have.
    secretManager: new RefreshingSecretManager({
      path: join(REPOSITORY_ROOT, DEFAULT_CREDENTIAL_FILE),
      readFile: async (path: string) => {
        try {
          return await readFile(path, 'utf8');
        } catch {
          // An unreadable Credential_File is a typed absence; the rejection can quote the file.
          return null;
        }
      },
    }),
    recorder: new TraceActionRecorder(new InMemoryTracePersistence(), newUlid),
    transports: { 'bedrock-mantle': transport },
    policy,
  });
}

/**
 * A budget generous enough that the probe's own 12 calls cannot be refused by it.
 *
 * A real handle rather than a stub, so the probe charges the same seam a Campaign slot does
 * and a budget bug shows up here rather than on the paid run.
 */
function probeBudget(): SessionBudgetHandle {
  const built = makeSessionBudget({
    sessionId: newUlid(),
    maxIterations: 12,
    maxTokens: 1_000_000,
    maxWallClockMs: 600_000,
    maxCostCents: 100_000,
    consumedIterations: 0,
    consumedTokens: 0,
    consumedMs: 0,
    consumedCostCents: 0,
  });
  if (!built.ok) {
    throw new Error('the probe budget must be valid');
  }
  return new InMemorySessionBudgetHandle(built.value);
}

/** Print the tally as a table, one row per Model_Arm. */
function printTally(tally: ProbeTally): void {
  console.log(JSON.stringify(tally, null, 2));
}

/** `--parse`: read the saved replies and print the per-Model_Arm outcome counts. */
export async function parseSavedReplies(directory: string): Promise<ProbeTally> {
  const replies = await readSavedReplies(directory);
  const tally = tallyReplies(replies);
  console.log(`grounded-reply-probe: ${String(replies.length)} saved replies`);
  printTally(tally);
  return tally;
}

/** `--send`: 12 real calls, no Campaign slot and no Results_Log record. */
async function sendProbe(directory: string): Promise<void> {
  const config = await readProbeConfig();
  const corpus = await importRtllmCorpus(
    new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
    localTimingDerivation(),
  );
  const designs = probeDesigns(corpus.problems, config.problemIds);
  await mkdir(directory, { recursive: true });
  for (const model of config.modelArms) {
    const router = routerFor(config, model);
    for (const problem of designs) {
      const request = buildGroundedTestbenchModelInput(
        { spec: problem.spec, intentSummary: problem.spec.goal, okfPassages: [] },
        requiredChecksFor(problem.spec, 'grounded'),
      );
      const invocation = await router.invoke('testbench', request, probeBudget());
      const reply = invocation.ok
        ? invocation.value.outputText
        : `ROUTER_FAILED ${invocation.error.code}`;
      await writeFile(join(directory, replyFilename(model, problem.id)), reply, 'utf8');
      console.log(`sent ${model} ${problem.id}: ${String(reply.length)} characters`);
    }
  }
}

/** The probe's two modes. */
export interface ProbeArgs {
  readonly mode: 'send' | 'parse';
  readonly directory: string;
}

export function parseProbeArgs(argv: readonly string[]): ProbeArgs {
  const at = argv.indexOf('--directory');
  return {
    mode: argv.includes('--send') ? 'send' : 'parse',
    directory: (at === -1 ? undefined : argv[at + 1]) ?? join(REPOSITORY_ROOT, PROBE_DIRNAME),
  };
}

async function main(): Promise<void> {
  const args = parseProbeArgs(process.argv.slice(2));
  if (args.mode === 'send') {
    await sendProbe(args.directory);
    return;
  }
  await parseSavedReplies(args.directory);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    // A local operator script: the message names what to fix, and no secret is ever echoed.
    const reason = error instanceof Error ? error.message : 'unknown failure';
    console.error(`grounded-reply-probe: ${reason}`);
    process.exitCode = 1;
  });
}
