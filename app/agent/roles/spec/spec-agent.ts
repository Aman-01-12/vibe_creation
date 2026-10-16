// The Spec_Agent (S1): produce a Spec plus block-level architecture, run the two
// deterministic Spec gates, and model the student approve/edit cycle (Req 5.1-5.4,
// 5.8, 5.9).
//
// Collaborator seams are injected (no globals, no direct provider calls): model
// calls go through the `ModelRouter` under the threaded `SessionBudgetHandle`, and
// every agent action is recorded through the `ActionRecorder`. Model output is
// untrusted: it is structurally parsed (`parseSpecDraft`) and then domain-validated
// (`validateSpecDraft`) before it can ever be presented, let alone approved.
//
// Approval is deliberately NOT persisted here. This role only models the approval
// STATE on the produced `Spec` (`approved`, `version`); the generation gate and the
// Project_Store persistence of the approved Spec are separate concerns (tasks 11.6
// and 12.1). A Spec reaches `approved: true` only by passing the same validation
// that gates presentation, so the positive-width (Req 5.3, 5.9) and measurability
// (Req 5.4) rules cannot be bypassed by approving directly.

import {
  makeTimingContract,
  newUlid,
  ok,
  err,
  type Json,
  type Result,
  type Spec,
  type TimingContract,
  type Ulid,
} from '@app/core';

import type { ActionRecorder, SpanDraft } from '../../action-recorder/index.js';
import type {
  ModelRequest,
  ModelRouter,
  ModelTask,
  SessionBudgetHandle,
} from '../../model-router/index.js';

import { parseSpecDraft } from './parse.js';
import type {
  AwaitingApproval,
  NeedsRevision,
  SpecDraft,
  SpecEdit,
  SpecPresentation,
  SpecProductionFailure,
  SpecRevisionContext,
  SpecValidationError,
} from './types.js';
import { validateSpecDraft, type ValidatedSpecCore } from './validation.js';

/** The Trace `stageOrTool` name recorded for every Spec_Agent action. */
const SPEC_STAGE = 'Spec_Agent' as const;

/** Building the Spec and its architecture is an escalated hard-planning task. */
const SPEC_MODEL_TASK: ModelTask = 'hard-planning';

/** A presentation state that still holds an editable draft (not a hard failure). */
export type EditablePresentation = AwaitingApproval | NeedsRevision;

/** The injected collaborators and deterministic seams for the Spec_Agent. */
export interface SpecAgentDeps {
  readonly router: ModelRouter;
  readonly recorder: ActionRecorder;
  /** ULID source for the Spec id and criterion ids; defaults to `newUlid`. */
  readonly newId?: () => Ulid;
  /** Wall-clock source for recorded span timing; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** The request to produce a Spec from a confirmed intent (Req 5.1). */
export interface ProduceSpecInput {
  readonly sessionId: Ulid;
  readonly projectId: Ulid;
  /** The Student-confirmed restated intent from S0 that drives spec production. */
  readonly confirmedIntent: string;
  /** Optional explicit Spec id; a fresh ULID is generated when omitted. */
  readonly specId?: Ulid;
}

/**
 * The Spec_Agent (S1).
 *
 * Public flow: `produceSpec` runs the model and presents the first Spec;
 * `applyEdits` incorporates a pre-approval edit and re-presents (Req 5.8);
 * `approveSpec` flips the approval state only for a valid Spec; `presentDraft` is
 * the pure, model-free validation-and-presentation core the other flows build on.
 */
export class SpecAgent {
  readonly #router: ModelRouter;
  readonly #recorder: ActionRecorder;
  readonly #newId: () => Ulid;
  readonly #now: () => number;

  constructor(deps: SpecAgentDeps) {
    this.#router = deps.router;
    this.#recorder = deps.recorder;
    this.#newId = deps.newId ?? newUlid;
    this.#now = deps.now ?? Date.now;
  }

  /**
   * Produce a Spec from the confirmed intent and present it for approval (Req 5.1,
   * 5.2). Routes one hard-planning call through the Model_Router under the budget,
   * treats the output as untrusted, and records the outcome as a Trace span.
   */
  async produceSpec(
    input: ProduceSpecInput,
    budget: SessionBudgetHandle,
  ): Promise<SpecPresentation> {
    const startedAtMs = this.#now();
    const invocation = await this.#router.invoke(
      SPEC_MODEL_TASK,
      this.#buildRequest(input),
      budget,
    );
    if (!invocation.ok) {
      return this.#failProduction(input, startedAtMs, 0, {
        reason: 'model-call-failed',
        detail: invocation.error.code,
        routerFailure: invocation.error,
      });
    }
    const cost = invocation.value.costCents;
    const parsed = parseSpecDraft(invocation.value.outputText);
    if (!parsed.ok) {
      return this.#failProduction(input, startedAtMs, cost, {
        reason: 'unparseable-output',
        detail: parsed.error,
      });
    }
    const context = this.#initialContext(input);
    const presentation = this.presentDraft(context, parsed.value);
    await this.#recordPresentation(presentation, startedAtMs, cost, invocation.value.attempts - 1);
    return presentation;
  }

  /**
   * Incorporate a student's pre-approval edit onto the current draft and
   * re-present the updated Spec for approval at a new version (Req 5.8).
   *
   * The merged draft is re-validated through the same gates, so an edit can move a
   * Spec from `needs-revision` to `awaiting-approval` (or back) but can never yield
   * an approved Spec on its own.
   */
  async applyEdits(current: EditablePresentation, edit: SpecEdit): Promise<SpecPresentation> {
    const startedAtMs = this.#now();
    const mergedDraft = mergeDraft(current.draft, edit);
    const nextContext: SpecRevisionContext = {
      ...current.context,
      version: current.context.version + 1,
    };
    const presentation = this.presentDraft(nextContext, mergedDraft);
    await this.#recordPresentation(presentation, startedAtMs, 0, 0);
    return presentation;
  }

  /**
   * Approve a presented Spec, flipping its state to `approved` only when it is
   * valid (Req 5.5, 5.6 at the Spec level).
   *
   * A `needs-revision` presentation returns its blocking issues; an
   * `awaiting-approval` presentation is re-validated (defense in depth) and, on
   * success, yields the same Spec with `approved: true`.
   */
  async approveSpec(current: EditablePresentation): Promise<Result<Spec, SpecValidationError>> {
    const startedAtMs = this.#now();
    if (current.status === 'needs-revision') {
      await this.#recordApproval(current.context, startedAtMs, false);
      return err(current.issues);
    }
    const revalidated = validateSpecDraft(current.draft, this.#newId);
    if (!revalidated.ok) {
      await this.#recordApproval(current.context, startedAtMs, false);
      return err(revalidated.error);
    }
    const approvedSpec = assembleSpec(current.context, revalidated.value, true);
    await this.#recordApproval(current.context, startedAtMs, true);
    return ok(approvedSpec);
  }

  /**
   * Validate a draft and present it, without any model call or recording.
   *
   * This is the deterministic heart of S1: an `awaiting-approval` result means the
   * draft passed both gates (every signal positive-width, every criterion
   * measurable); a `needs-revision` result carries every blocking issue. Properties
   * 15 and 16 state directly over this method.
   */
  presentDraft(context: SpecRevisionContext, draft: SpecDraft): EditablePresentation {
    const validated = validateSpecDraft(draft, this.#newId);
    if (!validated.ok) {
      return { status: 'needs-revision', issues: validated.error, draft, context };
    }
    const spec = assembleSpec(context, validated.value, false);
    return { status: 'awaiting-approval', spec, draft, context };
  }

  /** The initial revision context for a freshly produced Spec (version 1). */
  #initialContext(input: ProduceSpecInput): SpecRevisionContext {
    return {
      sessionId: input.sessionId,
      projectId: input.projectId,
      specId: input.specId ?? this.#newId(),
      version: 1,
    };
  }

  /** Build the provider-neutral model request that asks for a structured Spec. */
  #buildRequest(input: ProduceSpecInput): ModelRequest {
    const prompt = [
      'You are the Spec_Agent for a single Verilog module.',
      'From the confirmed intent below, produce a JSON object with exactly these',
      'fields: goal (string), constraints (string[]), architecture (string),',
      'moduleInterface { moduleName, ports [{ name, direction, width }], clocking',
      '{ clockName, resetName, resetActiveLow } }, and acceptanceCriteria',
      '[{ text, measurable, method }]. Every port width must be a positive integer.',
      'Each acceptance criterion must be verifiable by simulation, formal, or',
      'manual-inspection.',
      '',
      'Confirmed intent:',
      input.confirmedIntent,
    ].join('\n');
    return { prompt };
  }

  /** Record a production failure span and return the fail-safe presentation. */
  async #failProduction(
    input: ProduceSpecInput,
    startedAtMs: number,
    costCents: number,
    failure: SpecProductionFailure,
  ): Promise<SpecPresentation> {
    await this.#record(
      input.sessionId,
      startedAtMs,
      costCents,
      {
        stage: 'spec-production',
        status: 'production-failed',
        reason: failure.reason,
        detail: failure.detail,
      },
      'tool-error',
    );
    return { status: 'production-failed', failure };
  }

  /** Record the outcome of presenting a validated-or-rejected draft. */
  #recordPresentation(
    presentation: EditablePresentation,
    startedAtMs: number,
    costCents: number,
    retryCount: number,
  ): Promise<void> {
    const outputs = presentationOutputs(presentation);
    return this.#record(
      presentation.context.sessionId,
      startedAtMs,
      costCents,
      outputs,
      undefined,
      retryCount,
    );
  }

  /** Record an approval decision (approved or rejected) as a span. */
  #recordApproval(
    context: SpecRevisionContext,
    startedAtMs: number,
    approved: boolean,
  ): Promise<void> {
    return this.#record(context.sessionId, startedAtMs, 0, {
      stage: 'spec-approval',
      status: approved ? 'approved' : 'rejected',
      specId: context.specId,
      version: context.version,
    });
  }

  /** Append one sanitized Spec_Agent span; the recorder redacts and orders it. */
  async #record(
    sessionId: Ulid,
    startedAtMs: number,
    costCents: number,
    outputs: Json,
    failureClass?: SpanDraft['failureClass'],
    retryCount = 0,
  ): Promise<void> {
    const base: SpanDraft = {
      sessionId,
      stageOrTool: SPEC_STAGE,
      inputs: { stage: SPEC_STAGE },
      outputs,
      exitCode: null,
      startedAt: new Date(startedAtMs).toISOString(),
      durationMs: Math.max(0, this.#now() - startedAtMs),
      retryCount,
      costCents,
    };
    const draft = failureClass === undefined ? base : { ...base, failureClass };
    await this.#recorder.record(draft);
  }
}

/** Merge a pre-approval edit onto a draft, keeping every untouched field (Req 5.8). */
function mergeDraft(current: SpecDraft, edit: SpecEdit): SpecDraft {
  return {
    goal: edit.goal ?? current.goal,
    constraints: edit.constraints ?? current.constraints,
    moduleInterface: edit.moduleInterface ?? current.moduleInterface,
    timingContractEntries: edit.timingContractEntries ?? current.timingContractEntries,
    acceptanceCriteria: edit.acceptanceCriteria ?? current.acceptanceCriteria,
    architecture: edit.architecture ?? current.architecture,
  };
}

/**
 * Build the Timing_Contract for an assembled Spec.
 *
 * ponytail: no current Spec_Agent prompt or draft field proposes a per-port timing
 * entry (that is the Spec role's own follow-up this task does not implement, per
 * `clarification-answers.md` Q-07), so every output port is placed at `registered`
 * here. Nothing reads `Spec.timingContract` yet, so this placeholder changes no
 * behaviour today; the upgrade path is wiring a real per-port proposal through
 * `SpecDraft.timingContractEntries` once the Spec role grows one.
 */
function assembleTimingContract(core: ValidatedSpecCore): TimingContract {
  const entries = core.moduleInterface.ports
    .filter((port) => port.direction === 'output')
    .map((port) => ({ portName: port.name, timing: 'registered' as const }));
  const built = makeTimingContract(core.moduleInterface, entries);
  if (!built.ok) {
    // Unreachable: `entries` is derived from `core.moduleInterface`'s own output ports.
    throw new Error(`Spec_Agent built an invalid timing contract: ${built.error.message}`);
  }
  return built.value;
}

/** Assemble the core Spec from a validated draft and its revision context. */
function assembleSpec(
  context: SpecRevisionContext,
  core: ValidatedSpecCore,
  approved: boolean,
): Spec {
  return {
    id: context.specId,
    projectId: context.projectId,
    goal: core.goal,
    constraints: core.constraints,
    moduleInterface: core.moduleInterface,
    timingContract: assembleTimingContract(core),
    acceptanceCriteria: core.acceptanceCriteria,
    architecture: core.architecture,
    approved,
    version: context.version,
  };
}

/** The sanitized span outputs summarizing a presentation outcome. */
function presentationOutputs(presentation: AwaitingApproval | NeedsRevision): Json {
  if (presentation.status === 'awaiting-approval') {
    return {
      stage: 'spec-production',
      status: presentation.status,
      moduleName: presentation.spec.moduleInterface.moduleName,
      portCount: presentation.spec.moduleInterface.ports.length,
      criteriaCount: presentation.spec.acceptanceCriteria.length,
    };
  }
  return {
    stage: 'spec-production',
    status: presentation.status,
    signalIssueCount: presentation.issues.signalIssues.length,
    unmeasurableCount: presentation.issues.unmeasurableCriteria.length,
  };
}
