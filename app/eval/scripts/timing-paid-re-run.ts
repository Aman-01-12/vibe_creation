// timing-contract-inference, the Paid_Re_Run (Req 8.9): does a FRESH Reference_Model draw pass a
// purely combinational design now that the Timing_Contract is derived rather than fabricated?
//
// WHAT QUESTION THIS ANSWERS, AND WHY THE BANKED REPLIES CANNOT ANSWER IT
//   Task 15.5 replayed the 32 Reference_Models recorded on 2026-10-19 and none passed under the
//   derived contract. That is not a capability measurement: those draws predate the fix, so the
//   prompt told them `sum (registered: depends on 's' only)` and they complied, writing
//   `ece_expect = s[8:0]`. Replaying an obedient answer to a different question measures
//   staleness. Only a fresh draw, against a prompt carrying the DERIVED contract, measures
//   whether the model writes a correct combinational body when correctly asked.
//
//   Task 15.2 already fixed the other half on real Icarus: a hand-written combinational body
//   passes `adder_8bit` with zero CHECK-FAIL under the derived contract and fails under the
//   pre-feature one. So the contract is no longer the binding constraint; this run measures
//   whether anything else is.
//
// THIS SPENDS TOKENS, AND IS GATED ON A RECORDED APPROVAL
//   `requirePaidReRunApproval` is called BEFORE any router is constructed, so an absent approval
//   file refuses the run rather than refusing it halfway through a charged session (Req 8.9).
//
// EVERY REPLY IS SAVED
//   Each raw reply lands under the run directory, so a parser or harness change can be re-judged
//   later at zero token charge - the same discipline `pilot.ts --replay` already follows.
//
// Run with `node app/eval/dist/scripts/timing-paid-re-run.js`, after `npm run build`.
// Requires the Credential_File, `iverilog`/`vvp`, a worker-capable Python, and the pinned checkout.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
  RefreshingSecretManager,
  singleProviderRoutingPolicy,
  TraceActionRecorder,
  type ModelRouter,
} from '@app/agent';
import { makeSessionBudget, newUlid, type Spec } from '@app/core';
import {
  IcarusSimulatorAdapter,
  LocalWorkerRuntime,
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
import { decidePairedContractVerdict } from '../paired-contract-verdict.js';
import { locateMismatches, renderRefModel } from '../consensus-regression/pilot.js';
import { findWorkerPython } from '../sweep/host-facts.js';
import { requirePaidReRunApproval } from './paired-contract-approval-gate.js';

/** The design under test: one of Requirement 3.2's thirteen, and the one the whole spec centres
 *  on. Its recorded baseline is 0 of 8 trusted testbenches under the fabricated contract. */
const PROBLEM_ID = 'rtllm/arithmetic/adder_8bit';

/** The four Model_Arms every campaign since grounding-ab-v1 has run. */
const MODEL_IDS = ['moonshotai.kimi-k2.5', 'zai.glm-5', 'zai.glm-4.7', 'deepseek.v3.2'] as const;

/** Two draws per arm, so the sample count matches the recorded sweep's 8 per design. */
const DRAWS_PER_ARM = 2;

/** Per-call token ceiling, matching the Live_Wiring's own per-attempt budget. */
const TOKENS_PER_CALL = 20_000;

const WATCHDOG_BUDGET_NS = 2_000_000;
const LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, HERE.includes(`${'dist'}/`) ? '../../../..' : '../../..');

/** Where one draw stopped. `pass` is the only success. */
type DrawOutcome =
  'router' | 'parse' | 'authoring-contract' | 'compile' | 'run-error' | 'mismatch' | 'pass';

/** One fresh draw, judged under the DERIVED contract. */
interface Draw {
  readonly modelId: string;
  readonly drawIndex: number;
  readonly outcome: DrawOutcome;
  readonly checkFailCount: number;
  readonly verdict: 'supported' | 'unsupported';
  readonly firstMismatch: string | null;
  readonly tokensUsed: number;
  readonly diagnostics: readonly string[];
}

/** A one-call budget handle; the single-entry chain means one attempt is the whole call. */
function oneCallBudget(): InMemorySessionBudgetHandle {
  const built = makeSessionBudget({
    sessionId: newUlid(),
    maxIterations: 1,
    maxTokens: TOKENS_PER_CALL,
    maxWallClockMs: 300_000,
    maxCostCents: 10_000,
    consumedIterations: 0,
    consumedTokens: 0,
    consumedMs: 0,
    consumedCostCents: 0,
  });
  if (!built.ok) throw new Error('re-run budget construction must succeed');
  return new InMemorySessionBudgetHandle(built.value);
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
          // An unreadable Credential_File is a typed absence, never a thrown secret.
          return null;
        }
      },
    }),
    recorder: new TraceActionRecorder(new InMemoryTracePersistence(), newUlid),
    transports: { 'bedrock-mantle': transport },
    policy,
  });
}

function realSimulator(): SimulatorAdapter {
  const pythonBin = findWorkerPython();
  if (pythonBin === null) {
    throw new Error('the re-run requires a Python interpreter that can import tool_runner_worker');
  }
  return new IcarusSimulatorAdapter(new SandboxToolRunner(new LocalWorkerRuntime(pythonBin)));
}

/** Bounded first non-empty lines of tool output; never model text. */
function firstLines(text: string): readonly string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 5);
}

/**
 * Judge one raw reply against the design's own reference RTL under the DERIVED contract.
 *
 * `spec.timingContract` is passed through unchanged - the whole point of the run. A contract
 * built here would reintroduce exactly the substitution this feature removed.
 */
async function judge(
  spec: Spec,
  referenceRtl: SourceFile,
  reply: string,
  simulator: SimulatorAdapter,
): Promise<Omit<Draw, 'modelId' | 'drawIndex' | 'tokensUsed'>> {
  const base = { checkFailCount: 0, firstMismatch: null, diagnostics: [] as readonly string[] };
  const parsed = parseReferenceModelDraft(reply, spec.moduleInterface);
  if (!parsed.ok) {
    return {
      ...base,
      outcome: 'parse',
      verdict: 'unsupported',
      diagnostics: [parsed.error.reason],
    };
  }
  const checked = checkAuthoringContract(parsed.value);
  if (checked.kind === 'rejected') {
    return {
      ...base,
      outcome: 'authoring-contract',
      verdict: 'unsupported',
      diagnostics: checked.excluded,
    };
  }
  const rendered = renderRefModel(spec.moduleInterface, checked.bodies);
  const nonce = `r${randomUUID().replace(/-/gu, '').slice(0, 12)}`;
  const harness = renderConsensusHarness({
    moduleInterface: spec.moduleInterface,
    timingContract: spec.timingContract,
    nonce,
    watchdogBudgetNs: WATCHDOG_BUDGET_NS,
    sampleBudget: SAMPLE_BUDGET,
    roles: parsed.value.roles,
  });
  if (!harness.ok) throw new Error(`re-run defect: harness render failed: ${harness.error.code}`);

  const verdict = await simulator.simulate([referenceRtl, rendered.file], harness.value, LIMITS);
  if (verdict.failureCause === 'build-failed') {
    return {
      ...base,
      outcome: 'compile',
      verdict: 'unsupported',
      diagnostics: firstLines(verdict.stderr),
    };
  }
  const located = locateMismatches(verdict.stdout, nonce);
  const checkFailCount = (verdict.stdout.match(/^CHECK \S+ FAIL\b/gmu) ?? []).length;
  const paired = decidePairedContractVerdict({
    checkFailCount,
    passed: verdict.verdict === 'pass',
  });
  if (verdict.verdict === 'pass') {
    return { ...base, outcome: 'pass', verdict: paired, checkFailCount };
  }
  if (located.first === null) {
    return {
      ...base,
      outcome: 'run-error',
      verdict: paired,
      checkFailCount,
      diagnostics: [verdict.failureCause, ...firstLines(verdict.stderr)],
    };
  }
  return {
    ...base,
    outcome: 'mismatch',
    verdict: paired,
    checkFailCount,
    firstMismatch: `step ${String(located.first.step)} ${located.first.port} expected ${located.first.expected} got ${located.first.got}`,
  };
}

async function main(): Promise<void> {
  // Req 8.9: refuse before a single token is spent, not partway through.
  await requirePaidReRunApproval();

  const corpus = await importRtllmCorpus(
    new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
    localTimingDerivation(),
  );
  const problem = corpus.problems.find((candidate) => candidate.id === PROBLEM_ID);
  const reference = corpus.references.get(PROBLEM_ID);
  if (problem === undefined || reference === undefined) {
    throw new Error(`${PROBLEM_ID} is not in the imported corpus`);
  }
  const spec = problem.spec;
  const declared = spec.timingContract.entries
    .map((entry) => `${entry.portName}=${entry.timing}`)
    .join(' ');
  console.log(`re-run on ${PROBLEM_ID} under the DERIVED contract: ${declared}`);

  const runDir = join(
    REPOSITORY_ROOT,
    '.eval-runs',
    `timing-paid-re-run-${new Date().toISOString().replace(/[:.]/gu, '-')}`,
  );
  await mkdir(join(runDir, 'replies'), { recursive: true });

  const simulator = realSimulator();
  const draws: Draw[] = [];
  for (const modelId of MODEL_IDS) {
    const router = buildRouter(modelId);
    for (let drawIndex = 0; drawIndex < DRAWS_PER_ARM; drawIndex += 1) {
      const where = { modelId, drawIndex };
      const budget = oneCallBudget();
      const invoked = await router.invoke('generation', buildReferenceModelInput(spec), budget);
      if (!invoked.ok) {
        draws.push({
          ...where,
          outcome: 'router',
          checkFailCount: 0,
          verdict: 'unsupported',
          firstMismatch: null,
          tokensUsed: 0,
          diagnostics: [invoked.error.code],
        });
        console.log(`${modelId} #${String(drawIndex)}: router ${invoked.error.code}`);
        continue;
      }
      await writeFile(
        join(runDir, 'replies', `${modelId}__${String(drawIndex)}.txt`),
        invoked.value.outputText,
        'utf8',
      );
      const judged = await judge(spec, reference.rtl, invoked.value.outputText, simulator);
      draws.push({ ...where, ...judged, tokensUsed: invoked.value.tokensUsed });
      console.log(
        `${modelId} #${String(drawIndex)}: ${judged.outcome} ` +
          `(CHECK-FAIL ${String(judged.checkFailCount)}, ${judged.verdict})` +
          `${judged.firstMismatch === null ? '' : ` ${judged.firstMismatch}`}`,
      );
    }
  }

  const passCount = draws.filter((draw) => draw.outcome === 'pass').length;
  const report = {
    problemId: PROBLEM_ID,
    declaredContract: spec.timingContract.entries,
    drawCount: draws.length,
    passCount,
    recordedBaselinePassCount: 0,
    totalTokens: draws.reduce((sum, draw) => sum + draw.tokensUsed, 0),
    outcomes: Object.fromEntries(
      [...new Set(draws.map((d) => d.outcome))].map((o) => [
        o,
        draws.filter((d) => d.outcome === o).length,
      ]),
    ),
    draws,
  };
  await writeFile(join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\n${JSON.stringify({ ...report, draws: undefined }, null, 2)}`);
  console.log(`\nreplies and report under ${runDir}`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === `file://${invokedPath}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown failure';
    console.error(`timing-paid-re-run: ${message}`);
    process.exitCode = 1;
  });
}
