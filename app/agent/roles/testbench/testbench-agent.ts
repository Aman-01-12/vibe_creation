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

import { makeTestbench, newUlid, type Json, type Testbench, type Ulid } from '@app/core';
import type { KnowledgeRetriever } from '@app/knowledge';

import type { ActionRecorder, SpanDraft } from '../../action-recorder/index.js';
import type { ModelRouter, ModelTask, SessionBudgetHandle } from '../../model-router/index.js';

import { coveredCriterionIds, requiredChecks, simulationCriteria } from './coverage.js';
import { parseTestbenchDraft } from './parse.js';
import { buildTestbenchModelInput } from './prompt.js';
import { sourceEmitsCheck } from './signalling.js';
import type {
  GenerateTestbenchRequest,
  RequiredCheck,
  TestbenchGenerationFailure,
  TestbenchGenerationInput,
  TestbenchGenerationOutcome,
} from './types.js';

/** The Trace `stageOrTool` name recorded for every Testbench_Agent action. */
const TESTBENCH_STAGE = 'Testbench_Agent' as const;

/** Testbench generation is a generation-class model task, routed to DeepSeek. */
const TESTBENCH_MODEL_TASK: ModelTask = 'generation';

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

  constructor(deps: TestbenchAgentDeps) {
    this.#router = deps.router;
    this.#recorder = deps.recorder;
    this.#retriever = deps.retriever;
    this.#newId = deps.newId ?? newUlid;
    this.#now = deps.now ?? Date.now;
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
    const checks = requiredChecks(spec);
    if (simulationCriteria(spec).length === 0) {
      return this.#fail(request, startedAtMs, 0, {
        reason: 'no-simulation-criteria',
        detail: 'The Spec has no acceptance criteria verifiable by simulation.',
      });
    }

    const generationInput = await this.#assembleInput(request);
    const invocation = await this.#router.invoke(
      TESTBENCH_MODEL_TASK,
      buildTestbenchModelInput(generationInput, checks),
      budget,
    );
    if (!invocation.ok) {
      return this.#fail(request, startedAtMs, 0, {
        reason: 'model-call-failed',
        detail: invocation.error.code,
        routerFailure: invocation.error,
      });
    }

    const cost = invocation.value.costCents;
    const retryCount = invocation.value.attempts - 1;
    const parsed = parseTestbenchDraft(invocation.value.outputText);
    if (!parsed.ok) {
      return this.#fail(request, startedAtMs, cost, {
        reason: 'unparseable-output',
        detail: parsed.error.reason,
      });
    }

    return this.#validateCoverage(
      request,
      parsed.value.source,
      checks,
      startedAtMs,
      cost,
      retryCount,
    );
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
    request: GenerateTestbenchRequest,
    source: string,
    checks: readonly RequiredCheck[],
    startedAtMs: number,
    costCents: number,
    retryCount: number,
  ): Promise<TestbenchGenerationOutcome> {
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
    await this.#recordGenerated(request, testbench, checks, startedAtMs, costCents, retryCount);
    return { status: 'generated', testbench, checks };
  }

  /** Record a successful generation span, attributed to the Spec version (Req 7.7). */
  #recordGenerated(
    request: GenerateTestbenchRequest,
    testbench: Testbench,
    checks: readonly RequiredCheck[],
    startedAtMs: number,
    costCents: number,
    retryCount: number,
  ): Promise<void> {
    return this.#record(request.sessionId, request.spec, startedAtMs, costCents, retryCount, {
      stage: 'testbench-generation',
      status: 'generated',
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
    request: GenerateTestbenchRequest,
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

  /** Record a generation failure span and return the fail-safe outcome. */
  async #fail(
    request: GenerateTestbenchRequest,
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
    spec: GenerateTestbenchRequest['spec'],
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
