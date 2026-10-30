// Live, paid `ConsensusSessionDeps` wiring shared by `smoke-session.ts` and `sweep.ts`:
// the real four-model router pool, the real `DesignGenerator`/`ReferenceModelGenerator`
// round-robin, and the real sandbox/toolchain assembly. Operator-script code, not shipped.

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildReferenceModelInput,
  checkAuthoringContract,
  createBedrockMantleTransport,
  createFetchJsonHttpPort,
  createModelRouter,
  DEFAULT_CREDENTIAL_FILE,
  GenerationAgent,
  InMemoryTracePersistence,
  MODEL_TASKS,
  parseReferenceModelDraft,
  PeerCalibratedMutationStrengthGate,
  primarySelectionFor,
  RefreshingSecretManager,
  singleProviderRoutingPolicy,
  SimulatorCandidateCompiler,
  ToolchainStructuralGate,
  TraceActionRecorder,
  type BudgetLedger,
  type ConsensusSessionDeps,
  type DesignGenerator,
  type GeneratedDesign,
  type GeneratedReferenceModel,
  type ModelFamily,
  type ReferenceModelDraft as AcceptedReferenceModelDraft,
  type ReferenceModelGenerator,
} from '@app/agent';
import { MeteredSessionBudget } from '../metered-budget.js';
import { makeSessionBudget, newUlid, type Spec } from '@app/core';
import {
  BoundedArtifactRetention,
  IcarusSimulatorAdapter,
  LocalWorkerRuntime,
  referenceModelFunctionHeaders,
  renderConsensusHarness,
  SAMPLE_BUDGET,
  SandboxToolRunner,
  YosysCheckLintAdapter,
  type ResourceLimits,
  type SourceFile,
  type ToolRunner,
} from '@app/tools';

import { findWorkerPython } from '../sweep/host-facts.js';

/** The four Model_Arms every campaign since grounding-ab-v1 has run; resolve to 3 distinct families. */
export const MODEL_IDS = [
  'moonshotai.kimi-k2.5',
  'zai.glm-5',
  'zai.glm-4.7',
  'deepseek.v3.2',
] as const;

const REFMODEL_PATH = 'refmodel.v';
const WATCHDOG_BUDGET_NS = 2_000_000;
/** Retries for one reference-model draw: a malformed or rejected reply is model noise, not a wiring fault. */
const MAX_REFERENCE_MODEL_ATTEMPTS = 3;

export const LIVE_WIRING_LIMITS: ResourceLimits = {
  cpu: 1,
  memMb: 512,
  procs: 128,
  diskMb: 128,
  wallMs: 30_000,
};

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(
  HERE,
  HERE.includes(`${'dist'}/`) ? '../../../..' : '../../..',
);

export function modelIdFor(index: number): string {
  return MODEL_IDS[index % MODEL_IDS.length] as string;
}

/** `zai.glm-5`/`zai.glm-4.7` collapse into one `zai/glm` lineage (Req 3.1). */
function familyOfModelId(modelId: string): ModelFamily {
  const lineage = modelId.startsWith('zai.glm') ? 'zai/glm' : modelId.split('.')[0];
  return { provider: 'bedrock-mantle', lineage: lineage ?? modelId };
}

/**
 * A `MeteredSessionBudget` rather than `InMemorySessionBudgetHandle`: both implement the
 * router's `SessionBudgetHandle` port identically, but only the metered one exposes
 * `.consumed()`, which is what lets `generate()` below charge the REAL token spend into the
 * Consensus `BudgetLedger` instead of leaving it at the hardcoded `tokensSpent: 0` every live
 * Session reported before this fix.
 */
function sessionBudgetHandle(maxIterations: number, maxTokens: number): MeteredSessionBudget {
  const built = makeSessionBudget({
    sessionId: newUlid(),
    maxIterations,
    maxTokens,
    maxWallClockMs: 120_000,
    maxCostCents: 2_000,
    consumedIterations: 0,
    consumedTokens: 0,
    consumedMs: 0,
    consumedCostCents: 0,
  });
  if (!built.ok) {
    throw new Error(`live-wiring defect: ${built.error.code}`);
  }
  return new MeteredSessionBudget(built.value);
}

/** One router per model id, each a single-entry, no-fallback chain for every task. */
export function buildRouters(): ReadonlyMap<string, ReturnType<typeof createModelRouter>> {
  const secretManager = new RefreshingSecretManager({
    path: join(REPOSITORY_ROOT, DEFAULT_CREDENTIAL_FILE),
    readFile: async (path: string) => {
      try {
        return await readFile(path, 'utf8');
      } catch {
        return null;
      }
    },
  });
  const routers = new Map<string, ReturnType<typeof createModelRouter>>();
  for (const modelId of MODEL_IDS) {
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
    routers.set(
      modelId,
      createModelRouter({
        secretManager,
        recorder: new TraceActionRecorder(new InMemoryTracePersistence(), newUlid),
        transports: { 'bedrock-mantle': transport },
        policy,
      }),
    );
  }
  return routers;
}

/** A live `DesignGenerator`: round-robin across the four model arms, through the real generate-compile-revise loop. */
export class LiveDesignGenerator implements DesignGenerator {
  readonly #routers: ReadonlyMap<string, ReturnType<typeof createModelRouter>>;
  readonly #simulator: IcarusSimulatorAdapter;
  #calls = 0;

  constructor(
    routers: ReadonlyMap<string, ReturnType<typeof createModelRouter>>,
    simulator: IcarusSimulatorAdapter,
  ) {
    this.#routers = routers;
    this.#simulator = simulator;
  }

  async generate(spec: Spec, ledger: BudgetLedger): Promise<GeneratedDesign> {
    const index = this.#calls;
    this.#calls += 1;
    const modelId = modelIdFor(index);
    const router = this.#routers.get(modelId);
    if (router === undefined) {
      throw new Error(`live-wiring defect: no router built for model id "${modelId}"`);
    }
    const compiler = new SimulatorCandidateCompiler(
      this.#simulator,
      spec.moduleInterface,
      LIVE_WIRING_LIMITS,
    );
    const agent = new GenerationAgent({
      router,
      compiler,
      recorder: new TraceActionRecorder(new InMemoryTracePersistence(), newUlid),
    });
    const budget = sessionBudgetHandle(3, 60_000);
    // `generate` (not `generateCandidate`) drives the full generate-compile-revise loop, so a
    // design that fails to compile on the first attempt still gets a chance to revise.
    const outcome = await agent.generate(
      { sessionId: newUlid(), projectId: newUlid(), spec },
      budget,
    );
    // Charge the Consensus BudgetLedger with what this call ACTUALLY spent, read from the
    // same metered handle the router's own retry loop charged - the gap this fixes: nothing
    // called `ledger.charge()` before, so the 80k Session ceiling never tripped on real traffic.
    ledger.charge(budget.consumed().tokens);
    if (outcome.status !== 'ready-for-verification') {
      const detail = outcome.status === 'generation-failed' ? outcome.detail : outcome.diagnostics;
      throw new Error(
        `live-wiring: generation did not reach a compiling candidate for ${modelId} (${outcome.status}): ${detail}`,
      );
    }
    const rtl: readonly SourceFile[] = [
      { path: `${spec.moduleInterface.moduleName}.v`, contents: outcome.candidate.rtl },
    ];
    return { designId: newUlid(), rtl, family: familyOfModelId(modelId) };
  }
}

/** Wrap the three accepted bodies in their headers, the shape `pilot.ts`'s `renderRefModel` builds. */
function renderRefModelBody(
  headers: { resetState: string; nextState: string; expect: string },
  bodies: {
    resetStateBody: string;
    nextStateBody: string;
    expectBody: string;
  },
): string {
  const parts: readonly [string, string][] = [
    [headers.resetState, bodies.resetStateBody],
    [headers.nextState, bodies.nextStateBody],
    [headers.expect, bodies.expectBody],
  ];
  const lines: string[] = [];
  for (const [header, body] of parts) {
    lines.push(header, body, 'endfunction');
  }
  return `${lines.join('\n')}\n`;
}

/** A live `ReferenceModelGenerator`: round-robin across the four model arms, through the real Authoring_Contract. */
export class LiveReferenceModelGenerator implements ReferenceModelGenerator {
  readonly #routers: ReadonlyMap<string, ReturnType<typeof createModelRouter>>;
  #calls = 0;
  /** Every router failure, unparseable reply, or Authoring_Contract rejection across every
   * `generate()` call this instance has made - stimulus-transaction-structure criterion 8.6's
   * "count of Reference_Model_Replies the Role_Parser refused", which nothing on `SessionRecord`
   * tracks (figures.ts's `roleAdoptionShareOf` takes it as a caller-supplied parameter for the
   * same reason). One instance is constructed fresh per Session by every caller in this module's
   * own scripts, so this count is already scoped to one Session without extra bookkeeping. */
  #refusedCount = 0;

  constructor(routers: ReadonlyMap<string, ReturnType<typeof createModelRouter>>) {
    this.#routers = routers;
  }

  /** Reset at construction, so this is always "refused replies this instance has drawn". */
  refusedReplyCount(): number {
    return this.#refusedCount;
  }

  async generate(spec: Spec, ledger: BudgetLedger): Promise<GeneratedReferenceModel> {
    const index = this.#calls;
    this.#calls += 1;
    const modelId = modelIdFor(index);
    const router = this.#routers.get(modelId);
    if (router === undefined) {
      throw new Error(`live-wiring defect: no router built for model id "${modelId}"`);
    }
    const bodies = await this.#draftWithRetries(spec, modelId, router, ledger);
    const nonce = `s${randomUUID().replace(/-/gu, '').slice(0, 12)}`;
    const headers = referenceModelFunctionHeaders(spec.moduleInterface);
    const referenceModel: SourceFile = {
      path: REFMODEL_PATH,
      contents: renderRefModelBody(headers, bodies),
    };
    // The Spec's own contract, never one built here: an all-`registered` substitute overwrote the
    // derived values and made purely combinational designs unwinnable (Req 5.1-5.3). This is
    // evaluation code, so a green result here is not the production fix the Spec_Agent carries.
    const harness = renderConsensusHarness({
      moduleInterface: spec.moduleInterface,
      timingContract: spec.timingContract,
      nonce,
      watchdogBudgetNs: WATCHDOG_BUDGET_NS,
      sampleBudget: SAMPLE_BUDGET,
      roles: bodies.roles,
    });
    if (!harness.ok) {
      throw new Error(`live-wiring defect: harness render failed: ${harness.error.code}`);
    }
    return {
      testbenchId: newUlid(),
      referenceModel,
      harness: harness.value,
      nonce,
      family: familyOfModelId(modelId),
      draft: bodies,
    };
  }

  /**
   * Retries up to `MAX_REFERENCE_MODEL_ATTEMPTS` on a malformed or rejected reply - model
   * noise, not a wiring fault, since `ReferenceModelGenerator` has no failure variant to report it through.
   *
   * Each attempt's own metered handle is charged into `ledger` as it completes, so a retried
   * draw's real token spend is never dropped (the same gap `LiveDesignGenerator.generate`
   * fixes for the design side): nothing charged `ledger` here before this fix either.
   */
  async #draftWithRetries(
    spec: Spec,
    modelId: string,
    router: ReturnType<typeof createModelRouter>,
    ledger: BudgetLedger,
  ): Promise<AcceptedReferenceModelDraft> {
    let lastReason = 'no attempt made';
    for (let attempt = 0; attempt < MAX_REFERENCE_MODEL_ATTEMPTS; attempt += 1) {
      const budget = sessionBudgetHandle(1, 20_000);
      const routed = await router.invoke('generation', buildReferenceModelInput(spec), budget);
      ledger.charge(budget.consumed().tokens);
      if (!routed.ok) {
        lastReason = `router call failed: ${routed.error.code}`;
        this.#refusedCount += 1;
        continue;
      }
      const parsed = parseReferenceModelDraft(routed.value.outputText, spec.moduleInterface);
      if (!parsed.ok) {
        lastReason = `unparseable reply: ${parsed.error.reason}`;
        this.#refusedCount += 1;
        continue;
      }
      const checked = checkAuthoringContract(parsed.value);
      if (checked.kind === 'rejected') {
        lastReason = `Authoring_Contract rejected: ${checked.excluded.join(', ')}`;
        this.#refusedCount += 1;
        continue;
      }
      return checked.bodies;
    }
    throw new Error(
      `live-wiring: no acceptable reference-model reply from ${modelId} after ${String(MAX_REFERENCE_MODEL_ATTEMPTS)} attempts; last reason: ${lastReason}`,
    );
  }
}

/** `liveConsensusSessionDeps`'s own `ToolRunner`, exposed so a caller can build a `GoldenJudge` on the same sandbox rails. */
export interface LiveWiring {
  readonly sessionDeps: ConsensusSessionDeps;
  readonly toolRunner: ToolRunner;
}

/** Assemble one real, paid `ConsensusSessionDeps`: live generators, real sandbox, real gates. */
export function liveConsensusSessionDeps(): LiveWiring {
  const pythonBin = findWorkerPython();
  if (pythonBin === null) {
    throw new Error('live-wiring: no worker-capable Python interpreter found on this host');
  }
  // The retention sink MUST be the runtime's own third constructor argument - without it the
  // worker's lint report is captured nowhere, so every design reads lint: could-not-run.
  const retention = new BoundedArtifactRetention();
  const runtime = new LocalWorkerRuntime(pythonBin, undefined, retention);
  const toolRunner = new SandboxToolRunner(runtime);
  const simulator = new IcarusSimulatorAdapter(toolRunner);
  const lint = new YosysCheckLintAdapter(toolRunner, retention);
  const routers = buildRouters();
  return {
    toolRunner,
    sessionDeps: {
      generateDesign: new LiveDesignGenerator(routers, simulator),
      generateReferenceModel: new LiveReferenceModelGenerator(routers),
      structuralGate: new ToolchainStructuralGate({ toolRunner, simulator, lint }),
      simulator,
      mutationStrengthGate: new PeerCalibratedMutationStrengthGate(),
      limits: LIVE_WIRING_LIMITS,
    },
  };
}
