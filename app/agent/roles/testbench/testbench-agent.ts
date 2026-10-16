// The Testbench_Agent (S6): generate an independent, spec-derived Testbench that
// the agent is architecturally denied the RTL for (Req 7.1-7.7).
//
// THE ANTI-CIRCULAR CORE. The testbench is derived WITHOUT ever seeing the RTL
// under test, so a passing check cannot silently agree with a bug. This is made
// STRUCTURAL, not conventional, three ways:
//   1. The public `generateTestbench` request carries only { sessionId, spec,
//      intentSummary } - there is no parameter that can hold RTL.
//   2. The internal model context is a `TestbenchGenerationInput` whose fields are
//      only { spec, intentSummary, okfPassages }; RTL is unrepresentable by type,
//      and the model input is assembled from that value alone (see prompt.ts).
//   3. There is no shared mutable context object with the Generation_Agent: this
//      agent holds only its own injected, read-only collaborators.
//
// Collaborator seams are injected (no globals, no direct provider calls): model
// calls go through the `ModelRouter` under the threaded `SessionBudgetHandle`; OKF
// hints come from the injected `KnowledgeRetriever` (hints only, never authority);
// every action is recorded through the `ActionRecorder`, attributed to the Spec
// version. Model output is untrusted: it is shaped at the boundary
// (`parseTestbenchDraft`) and then validated for full per-check coverage before any
// Testbench is produced.

import {
  makeTestbench,
  newUlid,
  type Json,
  type Result,
  type Testbench,
  type Ulid,
} from '@app/core';
import type { KnowledgeRetriever } from '@app/knowledge';

import type { ActionRecorder, SpanDraft } from '../../action-recorder/index.js';
import type {
  ModelRequest,
  ModelRouter,
  ModelTask,
  SessionBudgetHandle,
} from '../../model-router/index.js';

import {
  routeCheckingApproach,
  type CheckingApproach,
  type StrategyArm,
} from './approach-router.js';
import { coveredCriterionIds, requiredChecksFor, simulationCriteria } from './coverage.js';
import {
  parseFencedTestbenchDraft,
  parseTestbenchDraft,
  type TestbenchParseError,
} from './parse.js';
import {
  buildGroundedRepairModelInput,
  buildGroundedTestbenchModelInput,
  buildRepairModelInput,
  buildTestbenchModelInput,
} from './prompt.js';
import {
  MAX_REPLY_CHARS,
  parseFragmentReply,
  type FragmentRefusal,
} from './scoreboard/fragments.js';
import { buildScoreboardModelInput, buildScoreboardRepairModelInput } from './scoreboard/prompt.js';
import {
  assembleScoreboardTestbench,
  renderScoreboardScaffold,
  type ScoreboardScaffold,
} from './scoreboard/scaffold.js';
import { sourceEmitsCheck } from './signalling.js';
import type {
  GenerateTestbenchRequest,
  RepairTestbenchRequest,
  RequiredCheck,
  TestbenchDraft,
  TestbenchGenerationFailure,
  TestbenchGenerationInput,
  TestbenchGenerationOutcome,
} from './types.js';

/**
 * The fields shared by `GenerateTestbenchRequest` and `RepairTestbenchRequest`
 * that the coverage-gate and recording helpers below actually read.
 *
 * `#validateCoverage`, `#recordGenerated`, `#recordCoverageGap`, and `#fail` hold
 * the revised source to the identical gate and recording discipline a first
 * draft gets (Req 6.3), regardless of which request produced it, so they are
 * typed over this common shape rather than duplicated per request type.
 */
type TestbenchRequestSummary = Pick<GenerateTestbenchRequest, 'sessionId' | 'spec' | 'testbenchId'>;

/** When a model call started, what it cost, and how often the router retried it. */
interface SpanTiming {
  readonly startedAtMs: number;
  readonly costCents: number;
  readonly retryCount: number;
}

/** The Trace `stageOrTool` name recorded for every Testbench_Agent action. */
const TESTBENCH_STAGE = 'Testbench_Agent' as const;

/**
 * Testbench generation is its OWN routable role, not a case of `generation`.
 *
 * It remains a code-generation-class task and defaults to the same route, but it is a
 * separate `ModelTask` so a per-role bake-off can assign testbench generation a
 * DIFFERENT model from RTL generation and ship the winning mix. That separation is
 * not cosmetic: this agent's measured quality is instrument validity - does the
 * testbench it wrote pass a known-good reference design, and does it cover every
 * criterion - which is a distinct capability from the RTL pass@k the Generation_Agent
 * is scored on, and the two do not have to peak on the same model.
 */
const TESTBENCH_MODEL_TASK: ModelTask = 'testbench';

/** The injected collaborators and deterministic seams for the Testbench_Agent. */
export interface TestbenchAgentDeps {
  readonly router: ModelRouter;
  readonly recorder: ActionRecorder;
  /** OKF hints for grounding; the retriever is OKF-first and returns hints only. */
  readonly retriever: KnowledgeRetriever;
  /** ULID source for the Testbench id; defaults to `newUlid`. */
  readonly newId?: () => Ulid;
  /** Wall-clock source for recorded span timing; defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * The Strategy_Arm this agent serves (testbench-in-order-scoreboard, C6). A per-arm
   * constant, so a constructor dependency and never a request field. Absent on the
   * Student_Path, which means `control`, so the shipped path always routes Cycle_Timed.
   */
  readonly strategyArm?: StrategyArm;
}

/** The arm the shipped Student_Path runs; it moves only on a `succeeded` Campaign (Req 13.3). */
export const STUDENT_PATH_STRATEGY_ARM: StrategyArm = 'control';

/** Shapes one untrusted reply into a draft, in the format its prompt asked for. */
type DraftParser = (raw: string) => Result<TestbenchDraft, TestbenchParseError>;

/** One Cycle_Timed model call: the request and the parser for the format it requests. */
interface CycleTimedCall {
  readonly prompt: ModelRequest;
  readonly parse: DraftParser;
}

/**
 * The Testbench_Agent (S6).
 *
 * `generateTestbench` retrieves OKF hints, assembles the RTL-free generation input,
 * routes one generation call through the Model_Router under the budget, shapes the
 * untrusted reply, and produces a Testbench only when the source emits every
 * required per-check signal. Every outcome is recorded as a Trace span attributed
 * to the Spec version.
 */
export class TestbenchAgent {
  readonly #router: ModelRouter;
  readonly #recorder: ActionRecorder;
  readonly #retriever: KnowledgeRetriever;
  readonly #newId: () => Ulid;
  readonly #now: () => number;
  readonly #strategyArm: StrategyArm;

  constructor(deps: TestbenchAgentDeps) {
    this.#router = deps.router;
    this.#recorder = deps.recorder;
    this.#retriever = deps.retriever;
    this.#newId = deps.newId ?? newUlid;
    this.#now = deps.now ?? Date.now;
    this.#strategyArm = deps.strategyArm ?? STUDENT_PATH_STRATEGY_ARM;
  }

  /**
   * Generate an independent Testbench from the approved Spec (Req 7.1-7.7).
   *
   * Fails closed when the Spec is unapproved or has no simulation-verifiable
   * criteria, when the Model_Router gives up, or when the reply cannot be shaped.
   * Returns `coverage-incomplete` (and produces no Testbench) when the source omits
   * a required check, so any produced Testbench covers every criterion by
   * construction.
   */
  async generateTestbench(
    request: GenerateTestbenchRequest,
    budget: SessionBudgetHandle,
  ): Promise<TestbenchGenerationOutcome> {
    const startedAtMs = this.#now();
    const { spec } = request;
    if (!spec.approved) {
      return this.#fail(request, startedAtMs, 0, {
        reason: 'spec-not-approved',
        detail: 'A Testbench is generated only from an approved Spec.',
      });
    }
    const checks = requiredChecksFor(spec, this.#strategyArm);
    if (simulationCriteria(spec).length === 0) {
      return this.#fail(request, startedAtMs, 0, {
        reason: 'no-simulation-criteria',
        detail: 'The Spec has no acceptance criteria verifiable by simulation.',
      });
    }

    const generationInput = await this.#assembleInput(request);
    if (routeCheckingApproach(spec.moduleInterface, this.#strategyArm) === 'cycle-timed') {
      const call: CycleTimedCall =
        this.#strategyArm === 'grounded'
          ? {
              prompt: buildGroundedTestbenchModelInput(generationInput, checks),
              parse: parseFencedTestbenchDraft,
            }
          : {
              prompt: buildTestbenchModelInput(generationInput, checks),
              parse: parseTestbenchDraft,
            };
      return this.#runCycleTimed(request, call, checks, budget, startedAtMs);
    }
    const scaffold = this.#scaffoldFor(request, checks);
    if (!scaffold.ok) {
      return this.#fail(request, startedAtMs, 0, scaffold.failure);
    }
    const prompt = buildScoreboardModelInput(generationInput, checks, scaffold.value);
    return this.#runScoreboard(request, prompt, checks, scaffold.value, budget, startedAtMs);
  }

  /**
   * Revise a previously-generated Testbench from a sanitized Repair_Hint (Req
   * 8.1, 8.2).
   *
   * Structurally identical in spirit to `generateTestbench`: one model call
   * under the SAME injected `budget`, the SAME `#validateCoverage` gate applied
   * to the revised source (Req 6.3 - a repair that produces a
   * coverage-incomplete draft is rejected exactly as a first draft would be),
   * and the SAME Trace recording discipline attributed to the Spec version.
   * Accepts no candidate RTL: `RepairTestbenchRequest` has no field one could
   * occupy, the same guarantee `generateTestbench`'s request already gives.
   * There is no spec-approval or simulation-criteria guard here: a repair is
   * only ever attempted after a first draft already passed both (Req 8.1,
   * 8.2), and no OKF re-retrieval, since the model already has a testbench to
   * revise rather than a blank page.
   */
  async repairTestbench(
    request: RepairTestbenchRequest,
    budget: SessionBudgetHandle,
  ): Promise<TestbenchGenerationOutcome> {
    const startedAtMs = this.#now();
    const { spec } = request;
    const checks = requiredChecksFor(spec, this.#strategyArm);
    // Re-derived from the same two inputs, so a repair always uses the generation's approach.
    if (routeCheckingApproach(spec.moduleInterface, this.#strategyArm) === 'cycle-timed') {
      const call: CycleTimedCall =
        this.#strategyArm === 'grounded'
          ? { prompt: buildGroundedRepairModelInput(request), parse: parseFencedTestbenchDraft }
          : { prompt: buildRepairModelInput(request), parse: parseTestbenchDraft };
      return this.#runCycleTimed(request, call, checks, budget, startedAtMs);
    }
    const scaffold = this.#scaffoldFor(request, checks);
    if (!scaffold.ok) {
      return this.#fail(request, startedAtMs, 0, scaffold.failure);
    }
    const prompt = buildScoreboardRepairModelInput(request, scaffold.value);
    return this.#runScoreboard(request, prompt, checks, scaffold.value, budget, startedAtMs);
  }

  /** One Cycle_Timed model call: the model writes the whole testbench, as today. */
  async #runCycleTimed(
    request: TestbenchRequestSummary,
    call: CycleTimedCall,
    checks: readonly RequiredCheck[],
    budget: SessionBudgetHandle,
    startedAtMs: number,
  ): Promise<TestbenchGenerationOutcome> {
    const invocation = await this.#router.invoke(TESTBENCH_MODEL_TASK, call.prompt, budget);
    if (!invocation.ok) {
      return this.#fail(request, startedAtMs, 0, {
        reason: 'model-call-failed',
        detail: invocation.error.code,
        routerFailure: invocation.error,
      });
    }
    const cost = invocation.value.costCents;
    const retryCount = invocation.value.attempts - 1;
    const parsed = call.parse(invocation.value.outputText);
    if (!parsed.ok) {
      return this.#fail(request, startedAtMs, cost, {
        reason: 'unparseable-output',
        detail: parsed.error.reason,
        parseRefusal: parsed.error.refusal,
      });
    }
    const timing = { startedAtMs, costCents: cost, retryCount };
    return this.#validateCoverage(request, parsed.value.source, checks, timing, 'cycle-timed');
  }

  /** One In_Order_Scoreboard model call: the model returns fragments the scaffold is filled with. */
  async #runScoreboard(
    request: TestbenchRequestSummary,
    prompt: ModelRequest,
    checks: readonly RequiredCheck[],
    scaffold: ScoreboardScaffold,
    budget: SessionBudgetHandle,
    startedAtMs: number,
  ): Promise<TestbenchGenerationOutcome> {
    const invocation = await this.#router.invoke(TESTBENCH_MODEL_TASK, prompt, budget);
    if (!invocation.ok) {
      return this.#fail(request, startedAtMs, 0, {
        reason: 'model-call-failed',
        detail: invocation.error.code,
        routerFailure: invocation.error,
      });
    }
    const timing = {
      startedAtMs,
      costCents: invocation.value.costCents,
      retryCount: invocation.value.attempts - 1,
    };
    const reply = invocation.value.outputText;
    const fragments = parseFragmentReply(reply, scaffold);
    if (!fragments.ok) {
      await this.#recordFragmentsRefused(request, timing, fragments.error);
      return {
        status: 'fragments-refused',
        refusal: fragments.error,
        source: reply.slice(0, MAX_REPLY_CHARS),
      };
    }
    const source = assembleScoreboardTestbench(scaffold, fragments.value);
    return this.#validateCoverage(request, source, checks, timing, 'in-order-scoreboard');
  }

  /** Render the scaffold, or the generation failure an unrenderable interface becomes. */
  #scaffoldFor(
    request: TestbenchRequestSummary,
    checks: readonly RequiredCheck[],
  ):
    | { readonly ok: true; readonly value: ScoreboardScaffold }
    | { readonly ok: false; readonly failure: TestbenchGenerationFailure } {
    const rendered = renderScoreboardScaffold(
      request.spec.moduleInterface,
      checks.map((check) => check.name),
    );
    if (rendered.ok) {
      return rendered;
    }
    return {
      ok: false,
      failure: { reason: 'scaffold-unrenderable', detail: rendered.error.reason },
    };
  }

  /** Retrieve OKF hints and assemble the RTL-free generation input (Req 7.1). */
  async #assembleInput(request: GenerateTestbenchRequest): Promise<TestbenchGenerationInput> {
    const retrieval = await this.#retriever.retrieve({
      topic: `Verilog testbench for ${request.spec.moduleInterface.moduleName}: ${request.spec.goal}`,
      keywords: [request.spec.moduleInterface.moduleName],
    });
    return {
      spec: request.spec,
      intentSummary: request.intentSummary,
      okfPassages: retrieval.passages,
    };
  }

  /** Validate full per-check coverage and produce a Testbench when complete (Req 7.3). */
  async #validateCoverage(
    request: TestbenchRequestSummary,
    source: string,
    checks: readonly RequiredCheck[],
    timing: SpanTiming,
    checkingApproach: CheckingApproach,
  ): Promise<TestbenchGenerationOutcome> {
    const { startedAtMs, costCents, retryCount } = timing;
    const missingChecks = checks.filter((check) => !sourceEmitsCheck(source, check.name));
    if (missingChecks.length > 0) {
      await this.#recordCoverageGap(request, startedAtMs, costCents, retryCount, missingChecks);
      return { status: 'coverage-incomplete', missingChecks, source };
    }

    const testbench = makeTestbench({
      id: request.testbenchId ?? this.#newId(),
      specId: request.spec.id,
      specVersion: request.spec.version,
      source,
      coversCriteria: coveredCriterionIds(checks),
    });
    await this.#recordGenerated(request, testbench, checks, timing, checkingApproach);
    return { status: 'generated', testbench, checks, checkingApproach };
  }

  /** Record a successful generation span, attributed to the Spec version (Req 7.7). */
  #recordGenerated(
    request: TestbenchRequestSummary,
    testbench: Testbench,
    checks: readonly RequiredCheck[],
    timing: SpanTiming,
    checkingApproach: CheckingApproach,
  ): Promise<void> {
    const { startedAtMs, costCents, retryCount } = timing;
    return this.#record(request.sessionId, request.spec, startedAtMs, costCents, retryCount, {
      stage: 'testbench-generation',
      status: 'generated',
      checkingApproach,
      sourceAttribution: testbench.sourceAttribution,
      specId: request.spec.id,
      specVersion: request.spec.version,
      testbenchId: testbench.id,
      checkNames: checks.map((check) => check.name),
      criterionCheckCount: coveredCriterionIds(checks).length,
      knownAnswerCheckCount: checks.filter((check) => check.kind === 'known-answer').length,
    });
  }

  /** Record a coverage-gap span (no Testbench produced), attributed to the Spec version. */
  #recordCoverageGap(
    request: TestbenchRequestSummary,
    startedAtMs: number,
    costCents: number,
    retryCount: number,
    missingChecks: readonly RequiredCheck[],
  ): Promise<void> {
    return this.#record(request.sessionId, request.spec, startedAtMs, costCents, retryCount, {
      stage: 'testbench-generation',
      status: 'coverage-incomplete',
      sourceAttribution: 'spec',
      specId: request.spec.id,
      specVersion: request.spec.version,
      missingCheckNames: missingChecks.map((check) => check.name),
    });
  }

  /** Record a refused-fragments span; the refusal's three bounded fields, never the reply. */
  #recordFragmentsRefused(
    request: TestbenchRequestSummary,
    timing: SpanTiming,
    refusal: FragmentRefusal,
  ): Promise<void> {
    return this.#record(
      request.sessionId,
      request.spec,
      timing.startedAtMs,
      timing.costCents,
      timing.retryCount,
      {
        stage: 'testbench-generation',
        status: 'fragments-refused',
        checkingApproach: 'in-order-scoreboard',
        sourceAttribution: 'spec',
        specId: request.spec.id,
        specVersion: request.spec.version,
        fragment: refusal.fragment,
        criterion: refusal.criterion,
        construct: refusal.construct,
      },
    );
  }

  /** Record a generation failure span and return the fail-safe outcome. */
  async #fail(
    request: TestbenchRequestSummary,
    startedAtMs: number,
    costCents: number,
    failure: TestbenchGenerationFailure,
  ): Promise<TestbenchGenerationOutcome> {
    await this.#record(
      request.sessionId,
      request.spec,
      startedAtMs,
      costCents,
      0,
      {
        stage: 'testbench-generation',
        status: 'generation-failed',
        sourceAttribution: 'spec',
        specId: request.spec.id,
        specVersion: request.spec.version,
        reason: failure.reason,
        detail: failure.detail,
      },
      'tool-error',
    );
    return { status: 'generation-failed', failure };
  }

  /**
   * Append one sanitized Testbench_Agent span; the recorder redacts and orders it.
   *
   * Every span carries the Spec id and version in its inputs and outputs, so the
   * testbench work is always attributed to the Spec version it derived from (Req
   * 7.7), regardless of outcome.
   */
  async #record(
    sessionId: Ulid,
    spec: TestbenchRequestSummary['spec'],
    startedAtMs: number,
    costCents: number,
    retryCount: number,
    outputs: Json,
    failureClass?: SpanDraft['failureClass'],
  ): Promise<void> {
    const base: SpanDraft = {
      sessionId,
      stageOrTool: TESTBENCH_STAGE,
      inputs: { stage: TESTBENCH_STAGE, specId: spec.id, specVersion: spec.version },
      outputs,
      exitCode: failureClass === undefined ? 0 : null,
      startedAt: new Date(startedAtMs).toISOString(),
      durationMs: Math.max(0, this.#now() - startedAtMs),
      retryCount,
      costCents,
    };
    const draft = failureClass === undefined ? base : { ...base, failureClass };
    await this.#recorder.record(draft);
  }
}
