// The PRODUCTION `EvalLoopRunner` (task 19.4): one eval sample driven through the
// real agentic loop against the real Icarus oracle (Req 15.1-15.3, 15.6, 15.10).
//
// This is the adapter the `loop-runner.ts` port describes: for each sample it
// composes a seeded `VerificationLoop` over the REAL collaborators and returns the
// oracle-decided `VerificationOutcome`. Nothing here is a stand-in:
//
//   Model_Router     real `createModelRouter`, bedrock-mantle transport over an
//                    injected HTTP seam, credentials from the env-backed secret
//                    manager, routed by the eval policy (`./routing-policy.ts`).
//   Generation_Agent real S4 agent: prompts, untrusted-output shaping, the exact
//                    interface check, and compile-driven repair.
//   Testbench_Agent  real S6 agent, RTL-isolated by type (see below).
//   Simulator        real `IcarusSimulatorAdapter` over `SandboxToolRunner` over the
//                    injected `SandboxRuntime` - `LocalWorkerRuntime` on a
//                    provisioned host, so real `iverilog` + `vvp` decide pass/fail.
//   Gate + labeler   the real `GenerationGate` and `oracleTrustLabeler`.
//
// THE ORACLE DECIDES, THIS RUNNER DOES NOT
//   `runSample` returns whatever `VerificationLoop.verify` returned, unmodified. It
//   never inspects model output, never re-reads a verdict, never synthesizes one. The
//   only outcomes it produces itself are the two sanitized `setup-failed` values
//   below, which report that the loop could not be started at all - never a pass.
//
// ANTI-CIRCULAR, STILL STRUCTURAL (Property 4)
//   The testbench request the loop builds is a `GenerateTestbenchRequest`
//   ({sessionId, spec, intentSummary}) and the agent's internal context is a
//   `TestbenchGenerationInput` ({spec, intentSummary, okfPassages}). Neither has a
//   field that can hold RTL, and this runner adds no shared mutable context between
//   the two agents: each gets its own instance and its own injected collaborators.
//   Feeding the candidate RTL into testbench generation therefore remains impossible
//   by type, not by convention.
//
// STUDENT-SESSION PARITY (Req 15.6)
//   `request.budget` and `request.limits` are threaded through UNCHANGED - into the
//   generation and testbench model calls, into every simulate run, and into the
//   Generation_Agent's compile seam. The runner never widens a cap, never substitutes
//   its own limits, and never builds a second budget, so an eval sample is metered
//   exactly like a real session.
//
// REPRODUCIBILITY (Req 15.10)
//   `request.seed` and `request.temperature` are pinned onto the per-sample transport
//   and so reach every model call in that sample. A hosted provider is NOT
//   bit-deterministic even at temperature 0 - batching, kernel selection, and silent
//   model-server revisions all move the sampled tokens - so a seed buys repeatability
//   only as far as the host offers it. That irreducible noise is precisely why the
//   harness draws k samples per problem and reports pass@k rather than one verdict.

import { newUlid, ok, oracleTrustLabeler, type Result, type Ulid } from '@app/core';
import type { KnowledgeRetriever } from '@app/knowledge';
import {
  IcarusSimulatorAdapter,
  SandboxToolRunner,
  type SandboxRuntime,
  type SimulatorAdapter,
} from '@app/tools';
import {
  EnvSecretManager,
  GenerationAgent,
  GenerationGate,
  InMemoryTracePersistence,
  SimulatorCandidateCompiler,
  TestbenchAgent,
  TraceActionRecorder,
  VerificationLoop,
  createBedrockMantleTransport,
  createModelRouter,
  intentArtifactLabel,
  primarySelectionFor,
  type ActionRecorder,
  type GenerationAdmissionRequest,
  type IntentSession,
  type JsonHttpPort,
  type ModelPriceTable,
  type ModelRouter,
  type ProviderTransport,
  type RoutingPolicy,
  type SecretManagerPort,
  type SpecApprovalReceipt,
  type SpecApprovalSink,
  type SpecApprovalSinkError,
  type TracePersistencePort,
  type VerificationOutcome,
  type VerificationSetupFailed,
} from '@app/agent';

import type { EvalLoopRunner, EvalSampleRequest } from './loop-runner.js';
import type { EvalProblem } from './problem.js';

// The accepted sampling ranges are re-stated here on purpose: the transport rejects an
// illegal value by THROWING at composition time, which is right for a wiring mistake
// but wrong for a per-sample value arriving over a port. Checking them here converts
// that into a sanitized outcome the harness can record and carry on from.

/** Highest accepted sampling temperature, matching the reproducibility config. */
const MAX_TEMPERATURE = 2;

/** Highest accepted per-sample seed: the 32-bit unsigned range the transport takes. */
const MAX_SEED = 0xffffffff;

/** Non-secret configuration of the bedrock-mantle host this eval run calls. */
export interface EvalModelHostConfig {
  /** AWS region hosting the OpenAI-compatible endpoint, e.g. `us-east-1`. */
  readonly region: string;
  /** Output-token cap per model call; the transport's default applies when omitted. */
  readonly maxOutputTokens?: number;
  /** Per-call deadline in milliseconds; the transport's default applies when omitted. */
  readonly requestTimeoutMs?: number;
  /**
   * Per-model prices, so per-session cost is real. A model with no price reports
   * `costCents: 0`, which means PRICE UNKNOWN and NOT free - price every model in the
   * bake-off or the cost envelope silently understates spend.
   */
  readonly prices?: ModelPriceTable;
}

/** The injected collaborators for the production runner; no globals. */
export interface EvalVerificationLoopRunnerDeps {
  /** The bedrock-mantle host every role is served from. */
  readonly modelHost: EvalModelHostConfig;
  /** The per-role model routing for this run; build it with `evalRoutingPolicy`. */
  readonly routingPolicy: RoutingPolicy;
  /** The HTTP seam the transport calls through; a fake in tests, a client in deployment. */
  readonly http: JsonHttpPort;
  /**
   * The sandbox runtime the Simulator oracle runs in. `LocalWorkerRuntime` on a
   * provisioned eval host (real `iverilog` + `vvp`); `RunscSandboxRuntime` where
   * gVisor is available; a fake in tests.
   */
  readonly sandboxRuntime: SandboxRuntime;
  /** OKF retrieval for the Testbench_Agent; hints only, never authority. */
  readonly retriever: KnowledgeRetriever;
  /** Credential source; defaults to the env-backed manager (the only env reader). */
  readonly secretManager?: SecretManagerPort;
  /** Where the gate commits the approved Spec; defaults to the headless eval sink. */
  readonly approvalSink?: SpecApprovalSink;
  /** Trace storage; defaults to a fresh in-memory store per sample. */
  readonly tracePersistence?: TracePersistencePort;
  /** ULID source for session, module, and testbench ids; defaults to `newUlid`. */
  readonly newId?: () => Ulid;
  /** Wall-clock source for recorded span timing; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** The resolved dependency set: every optional collaborator defaulted exactly once. */
interface ResolvedDeps {
  readonly modelHost: EvalModelHostConfig;
  readonly routingPolicy: RoutingPolicy;
  readonly http: JsonHttpPort;
  readonly sandboxRuntime: SandboxRuntime;
  readonly retriever: KnowledgeRetriever;
  readonly secretManager: SecretManagerPort;
  readonly approvalSink: SpecApprovalSink;
  readonly tracePersistence: TracePersistencePort | null;
  readonly newId: () => Ulid;
  readonly now: () => number;
}

/**
 * The default `SpecApprovalSink` for a headless eval run.
 *
 * An eval problem's Spec is already approved, version-controlled fixture data and
 * there is no student and no Project_Store in the loop, so there is nothing to
 * persist and no durable checkpoint to write. It therefore admits the Spec and
 * reports `checkpointWritten: false` - the honest answer, recorded on the gate's
 * decision span. A provisioned run that DOES have a store injects the real
 * store-backed sink instead.
 */
export const HEADLESS_EVAL_APPROVAL_SINK: SpecApprovalSink = {
  // The `ApprovedSpecPersistInput` the port supplies is deliberately not read: there
  // is nothing to write it to on this path.
  persistApprovedSpec(): Promise<Result<SpecApprovalReceipt, SpecApprovalSinkError>> {
    return Promise.resolve(ok({ checkpointWritten: false }));
  },
};

/**
 * The generation-runner port the gate's constructor requires.
 *
 * The Verification_Loop opens the confirmed context itself and drives generation
 * directly, so this entry point is unreachable on this path. It throws rather than
 * returning a stand-in outcome: a silent placeholder here would look like a real
 * generation result and could reach the report.
 */
const UNREACHABLE_GENERATION_RUNNER = {
  runGeneration(): Promise<never> {
    throw new Error('The Verification_Loop must drive generation, not GenerationRunner');
  },
};

/**
 * A sanitized setup failure: no credential, host, path, or stack trace.
 *
 * The cause is fixed at `inputs-inadmissible` because this runner only ever refuses a sample
 * BEFORE any model call, on a value it validated itself. Nothing here can be an
 * infrastructure failure, so nothing here may be deferred and retried - a re-run would
 * validate the same out-of-range number and refuse again.
 */
function setupFailed(
  reason: VerificationSetupFailed['reason'],
  detail: string,
): VerificationSetupFailed {
  return { status: 'setup-failed', reason, detail, cause: 'inputs-inadmissible' };
}

/**
 * Reject a per-sample request whose seed or temperature the model call cannot honor.
 *
 * The request crosses a port boundary, so its numbers are validated here rather than
 * trusted: an out-of-range value would otherwise be rejected by the provider and read
 * as an outage. Returns a sanitized outcome (never a throw, never a pass) so the
 * harness records the sample and the run completes.
 */
function validateSampling(request: EvalSampleRequest): VerificationSetupFailed | null {
  if (!Number.isInteger(request.seed) || request.seed < 0 || request.seed > MAX_SEED) {
    return setupFailed('generation-unavailable', 'The sample seed is outside the accepted range.');
  }
  if (
    !Number.isFinite(request.temperature) ||
    request.temperature < 0 ||
    request.temperature > MAX_TEMPERATURE
  ) {
    return setupFailed(
      'generation-unavailable',
      'The sample temperature is outside the accepted range.',
    );
  }
  return null;
}

/** A confirmed, in-scope intent session admitting generation for the problem's Spec. */
function confirmedIntent(sessionId: Ulid, problem: EvalProblem, newId: () => Ulid): IntentSession {
  return {
    sessionId,
    artifact: intentArtifactLabel(newId(), 1),
    // The problem carries a settled restatement summary; a headless eval has no
    // clarification turns, so no rounds were consumed and nothing is unconfirmed.
    restatement: { summary: problem.intentSummary, constraints: [], assumptions: [] },
    scope: 'single-module',
    clarificationRounds: 0,
    outcome: { kind: 'ready-for-confirmation' },
    confirmation: 'confirmed',
  };
}

/** The gate admission request for one problem: confirmed intent + its approved Spec. */
function admissionFor(problem: EvalProblem, intent: IntentSession): GenerationAdmissionRequest {
  return { intent, spec: problem.spec };
}

/**
 * The production `EvalLoopRunner`.
 *
 * Construct it once at the wiring root; the harness calls `runSample` per sample.
 * Host configuration is validated at construction (a bad region or a blank model id
 * throws HERE), so a wiring mistake can never masquerade as a provider outage or as a
 * model's poor score.
 */
export class EvalVerificationLoopRunner implements EvalLoopRunner {
  readonly #deps: ResolvedDeps;

  constructor(deps: EvalVerificationLoopRunnerDeps) {
    this.#deps = resolveDeps(deps);
    // Build and discard one transport so an illegal region or a blank model id
    // throws HERE. Per-sample transports differ only by the seed and temperature,
    // both of which `validateSampling` checks, so nothing else can fail later.
    createTransport(this.#deps, 0, 0);
  }

  /**
   * Drive one sample through the real loop and return the ORACLE's outcome.
   *
   * The returned `VerificationOutcome` is passed through untouched; the runner adds
   * no verdict of its own.
   */
  runSample(request: EvalSampleRequest): Promise<VerificationOutcome> {
    const invalid = validateSampling(request);
    if (invalid !== null) {
      return Promise.resolve(invalid);
    }
    const sessionId = this.#deps.newId();
    const recorder = this.#buildRecorder();
    const simulator = this.#buildSimulator();
    const router = this.#buildRouter(request, recorder);
    const loop = this.#buildLoop({ request, recorder, simulator, router });
    const intent = confirmedIntent(sessionId, request.problem, this.#deps.newId);
    // The harness's budget and limits go in unchanged: same caps as a real session.
    return loop.verify(admissionFor(request.problem, intent), request.budget, request.limits);
  }

  /** The Trace recorder for one sample: the injected store, or a fresh in-memory one. */
  #buildRecorder(): ActionRecorder {
    const persistence = this.#deps.tracePersistence ?? new InMemoryTracePersistence();
    return new TraceActionRecorder(persistence, this.#deps.newId);
  }

  /** The real Simulator oracle over the injected sandbox runtime. */
  #buildSimulator(): SimulatorAdapter {
    return new IcarusSimulatorAdapter(new SandboxToolRunner(this.#deps.sandboxRuntime));
  }

  /**
   * The real Model_Router for one sample: bedrock-mantle transport seeded for this
   * sample, credentials resolved per adapter at the point of use, eval policy.
   *
   * A missing credential or an unwired transport surfaces as a typed, redacted
   * provider failure that the agents turn into a sanitized setup failure - never a
   * crash and never a pass.
   */
  #buildRouter(request: EvalSampleRequest, recorder: ActionRecorder): ModelRouter {
    const transport = createTransport(this.#deps, request.seed, request.temperature);
    return createModelRouter({
      secretManager: this.#deps.secretManager,
      recorder,
      transports: { 'bedrock-mantle': transport },
      policy: this.#deps.routingPolicy,
    });
  }

  /**
   * The real Verification_Loop for one sample: real gate, real Generation_Agent,
   * real RTL-isolated Testbench_Agent, real oracle, oracle Trust_Labeler.
   */
  #buildLoop(parts: {
    readonly request: EvalSampleRequest;
    readonly recorder: ActionRecorder;
    readonly simulator: SimulatorAdapter;
    readonly router: ModelRouter;
  }): VerificationLoop {
    const { request, recorder, simulator, router } = parts;
    return new VerificationLoop({
      gate: this.#buildGate(recorder),
      generator: this.#buildGenerationAgent(request, recorder, simulator, router),
      testbench: new TestbenchAgent({
        router,
        recorder,
        retriever: this.#deps.retriever,
        newId: this.#deps.newId,
        now: this.#deps.now,
      }),
      simulator,
      recorder,
      trustLabeler: oracleTrustLabeler,
      newId: this.#deps.newId,
      now: this.#deps.now,
    });
  }

  /** The real generation gate; the loop opens its context once per sample. */
  #buildGate(recorder: ActionRecorder): GenerationGate<never> {
    return new GenerationGate<never>({
      runner: UNREACHABLE_GENERATION_RUNNER,
      approvalSink: this.#deps.approvalSink,
      recorder,
      now: this.#deps.now,
    });
  }

  /**
   * The real Generation_Agent, with its compile seam pointed at the SAME sandbox and
   * the SAME limits the oracle uses - never a widened set.
   *
   * The Verification_Loop drives this agent through its `generateCandidate` /
   * `reviseFromErrors` primitives, which do not compile: the loop's own simulate run
   * against the independent testbench subsumes the compile check, and a candidate
   * that fails to compile comes back `error` with the compiler output in the repair
   * diagnostics. The compiler is still wired to the real Simulator rather than a stub
   * so the two paths can never diverge if a driver ever calls the agent's own
   * generate-compile-revise loop.
   */
  #buildGenerationAgent(
    request: EvalSampleRequest,
    recorder: ActionRecorder,
    simulator: SimulatorAdapter,
    router: ModelRouter,
  ): GenerationAgent {
    const compiler = new SimulatorCandidateCompiler(
      simulator,
      // The trusted Spec interface, never a model-parsed one: it is the contract the
      // candidate must match exactly.
      request.problem.spec.moduleInterface,
      request.limits,
    );
    return new GenerationAgent({
      router,
      compiler,
      recorder,
      newId: this.#deps.newId,
      now: this.#deps.now,
    });
  }
}

/**
 * Build the bedrock-mantle transport for one sample.
 *
 * The transport's own default model id is derived from the policy's `generation`
 * primary, so the when-unrouted default can never contradict the policy. The router
 * always routes an id, so that default is belt and braces.
 */
function createTransport(deps: ResolvedDeps, seed: number, temperature: number): ProviderTransport {
  const { modelHost } = deps;
  return createBedrockMantleTransport({
    http: deps.http,
    config: {
      region: modelHost.region,
      defaultModelId: primarySelectionFor(deps.routingPolicy, 'generation').modelId,
      temperature,
      seed,
      ...(modelHost.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: modelHost.maxOutputTokens }),
      ...(modelHost.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: modelHost.requestTimeoutMs }),
      ...(modelHost.prices === undefined ? {} : { prices: modelHost.prices }),
    },
  });
}

/** Default every optional collaborator exactly once, so no call site re-decides. */
function resolveDeps(deps: EvalVerificationLoopRunnerDeps): ResolvedDeps {
  return {
    modelHost: deps.modelHost,
    routingPolicy: deps.routingPolicy,
    http: deps.http,
    sandboxRuntime: deps.sandboxRuntime,
    retriever: deps.retriever,
    secretManager: deps.secretManager ?? new EnvSecretManager(),
    approvalSink: deps.approvalSink ?? HEADLESS_EVAL_APPROVAL_SINK,
    tracePersistence: deps.tracePersistence ?? null,
    newId: deps.newId ?? newUlid,
    now: deps.now ?? Date.now,
  };
}
