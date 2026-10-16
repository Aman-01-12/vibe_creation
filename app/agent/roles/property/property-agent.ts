// The Property_Author: derive a Property_Set from the Spec's acceptance criteria, blind
// to the candidate design (Req 6.8, 6.14, 6.15, 6.16, 6.17).
//
// ADDED ONLY NOW THAT THE GATE IS TRUSTED. Groups 1 to 7 built and falsified the
// Formal_Oracle first, deliberately, so that a property written by a model is measured
// by an instrument already known to be sound. Nothing in this role relaxes that: it
// writes properties and reports what it could not write, and it NEVER judges its own
// output. `propertySetAdmitted` is always `'not-gated'` here, because the mutation gate on
// the property set reads a reference design, a student session has none, and `app/agent`
// must not import `app/eval`. Group 10 owns admission, and the eval layer stamps its own
// outcome onto the set at the hand-off.
//
// RTL-BLIND BY CONSTRUCTION, NOT BY INSTRUCTION (Req 6.16). `derivePropertySet(spec,
// deps)` takes the Spec and the role's injected seams. No parameter in the public
// surface - not the Spec, not `PropertyAuthorDeps`, not `PropertyAgent`'s constructor -
// can carry a candidate design source, generated RTL, or any Generation_Agent artifact.
// That is the same structural guarantee `generateTestbench` already has, and Property 30
// (task 9.3) extends its existing assertion over this role rather than restating it.
//
// THREE RULES THE PARTITION RESTS ON, so the invariant holds by construction rather than
// by test (Req 6.15, 6.17; Property 17):
//   1. The loop iterates the SPEC's criteria, never the model's reply. A criterion the
//      model omitted lands in `unexpressedCriteria` because nothing was found for it -
//      so a criterion cannot silently vanish from both sets.
//   2. A criterion yields AT MOST ONE property, built from the FIRST draft the model
//      emitted for that criterion, and ONLY that draft is submitted to the
//      Property_Validator (Req 6.17, execution question E10). Where the first draft is
//      rejected - by the validator, or because it is clocked on an interface that
//      declares no clock - the criterion is reported UNEXPRESSED and the later drafts
//      for it are never tried. See the next paragraph for why the retry is refused.
//   3. A draft naming an id that is not a criterion of this Spec is DROPPED. An
//      unattributable property would be a verdict about nothing (Req 6.14), and
//      admitting it would put something in the expressed set that is in neither half of
//      the partition.
//
// UNEXPRESSED, NEVER WEAKER (Req 6.17). Where the dialect refuses an expression, the
// criterion is reported unexpressed and NO property is emitted for it. Emitting a
// weaker property in its place would be the property-strength failure Requirement 10
// exists to catch, introduced deliberately: it would be proved, the sample would read as
// verified, and the measurement would be of something smaller than the criterion asked
// for. See `prompt.ts` for the same rule as the model is told it.
//
// AND THAT IS WHY A REJECTED FIRST DRAFT IS NOT RETRIED. "Submit the first draft, and if
// the validator refuses it try the next one the model wrote" reads like robustness,
// which is precisely why the refusal is written down here rather than left implicit in
// the control flow. Letting the Property_Validator pick whichever of a model's
// alternative drafts it happens to accept is the exact path by which a weaker fallback
// property slips in: the later draft is the one the model reached for after its first
// attempt, and a model that cannot state the criterion in the dialect reaches for a
// SMALLER claim, not an equivalent one. That is ADR-019's standing risk, arriving under
// the name of resilience, and Requirement 10's mutation gate is what exists to catch it
// - so the author has no retry that could silently lower property strength, and the
// criterion is reported unexpressed instead, where it is visible.
//
// It is also what keeps Property 17's partition EXACT. One criterion yields at most one
// Formal_Property, so a criterion can be neither in both the expressed and the
// unexpressed set nor twice in either.
//
// THE DIALECT CHECK HAS ONE OWNER. Every expression leaves this role only through
// `validateExpression` (`@app/tools`), which returns the `ValidatedExpression` brand that
// every expression field of a `FormalProperty` requires - so unvalidated model text has
// no channel into the set, and nothing here re-implements any part of the dialect rule.
// The dialect's one rule about an assembled property rather than an expression, which kinds
// may carry which sampled-value functions, is `propertyShapeRejection`'s in the same module,
// and every property built here passes through it; see design.md, Component 18.
//
// Collaborator seams are injected (no globals, no direct provider calls): the model call
// goes through the `ModelRouter` under the caller's own `SessionBudgetHandle`, so a
// model-driven author cannot spend unaccounted time, and every outcome is recorded
// through the `ActionRecorder` attributed to the Spec version.

import {
  propertyShapeRejection,
  validateExpression,
  type FormalProperty,
  type PropertyRejection,
} from '@app/tools';
import {
  err,
  ok,
  type AcceptanceCriterion,
  type ClockingContract,
  type Json,
  type Result,
  type Spec,
  type Ulid,
} from '@app/core';

import type { ActionRecorder, SpanDraft } from '../../action-recorder/index.js';
import type { ModelRouter, ModelTask, SessionBudgetHandle } from '../../model-router/index.js';
// TYPE-ONLY, and that is what keeps the module graph free of a runtime edge. This is the
// PORT's own contract rather than this role's data model, and a structurally-identical
// twin declared here would be assignable to it, so the duplication would hide a later
// divergence instead of failing on it - the drift risk task 8.7 names for `prove` and
// `proveSet`. `import type` is fully erased, so no runtime import of the orchestrator is
// created. It does deviate from the role-local-ports convention recorded in
// `chipAgent/_inbox/pattern-iteration-role-local-ports-avoid-orchestrator-cycle.md`,
// whose reason is a RUNTIME cycle; the precedent for a type-only exception is
// `roles/testbench/types.ts` importing `orchestrator/repair-hint.js`. The end state the
// `CandidateGenerator` precedent points at - the ROLE owning the shape and the loop
// importing it - is a change to `verification-loop.ts` and therefore not this task's.
import type { FormalPropertySet } from '../../orchestrator/verification-loop.js';

import { buildPropertyModelInput } from './prompt.js';
import { parsePropertyDrafts, type PropertyDraft } from './model-output.js';

/** The Trace `stageOrTool` name recorded for every Property_Author action. */
const PROPERTY_STAGE = 'Property_Author' as const;

/**
 * The route property authoring is served by.
 *
 * ponytail: this REUSES the `testbench` role rather than adding a seventh `ModelTask`,
 * and the ceiling is that a per-role bake-off cannot yet assign property authoring a
 * different model from testbench generation. The reuse is honest rather than arbitrary -
 * both roles author the measuring INSTRUMENT from the Spec and are scored on instrument
 * validity rather than on the RTL pass@k `generation` is scored on. The upgrade path is a
 * `property` member on `ModelTask`, whose measured cost is recorded in
 * `chipAgent/_inbox/decision-testbench-is-its-own-routable-model-role.md`: two pinned
 * sweep config hashes move, because adding a role changes every arm's canonical role map
 * and therefore the experiment identity. That is a deliberate decision with its own
 * re-pins, not a side effect to take inside this task.
 */
const PROPERTY_MODEL_TASK: ModelTask = 'testbench';

/** Why an acceptance criterion could not be expressed in the Property_Dialect. */
export type UnexpressedReason =
  /** The author produced no readable property for this criterion. */
  | 'no-property-emitted'
  /** The Property_Validator refused an expression of this criterion's property. */
  | 'dialect-refused'
  /** A clocked property was written for an interface that declares no clock. */
  | 'no-clock-declared';

/**
 * One acceptance criterion reported as unexpressed, with the reason it was.
 *
 * Reported rather than approximated (Req 6.17). The `rejection` is the validator's own
 * value, not a re-spelling of it, so the refusal vocabulary keeps its single owner and
 * the named construct reaches the Trace intact (Req 6.7).
 */
export interface UnexpressedCriterion {
  readonly criterionId: Ulid;
  readonly reason: UnexpressedReason;
  /** The validator's refusal, present exactly when `reason` is `dialect-refused`. */
  readonly rejection?: PropertyRejection;
}

/**
 * The Property_Set and the criteria that could not be expressed, partitioning the
 * Spec's criteria between them.
 *
 * This is `FormalPropertySet` plus the unexpressed REASONS, which the port does not
 * carry: the loop needs only the criterion ids, while the Trace wants to say why.
 * `propertySetAdmitted` is inherited as `'not-gated'` from `FormalPropertySet`'s contract.
 */
export interface PropertySetOutcome extends FormalPropertySet {
  readonly unexpressed: readonly UnexpressedCriterion[];
}

/**
 * The injected collaborators and deterministic seams for the Property_Author.
 *
 * No field here can carry a candidate design source, which is half of why the role is
 * RTL-blind by construction; the other half is that `Spec` cannot either.
 */
export interface PropertyAuthorDeps {
  readonly router: ModelRouter;
  readonly recorder: ActionRecorder;
  /**
   * The caller's own single budget handle, charged by the Model_Router for this call.
   *
   * Also the session the recorded span is attributed to: the handle already owns a
   * `sessionId`, so asking for a second one would create two owners of one fact that
   * could disagree.
   */
  readonly budget: SessionBudgetHandle;
  /** Wall-clock source for recorded span timing; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** The author's seams minus the per-call budget, as `PropertyAgent` binds them. */
export type PropertyAgentDeps = Omit<PropertyAuthorDeps, 'budget'>;

/** The property id of the nth emitted property, in submission order. */
function propertyId(index: number): string {
  return `p${index + 1}`;
}

/** Report a criterion as unexpressed because the validator refused an expression. */
function refused(
  criterion: AcceptanceCriterion,
  rejection: PropertyRejection,
): UnexpressedCriterion {
  return { criterionId: criterion.id, reason: 'dialect-refused', rejection };
}

/**
 * The assembled property, or the criterion reported unexpressed for a shape the renderer
 * cannot emit. Every kind goes through it, so a later clocked rule needs no second call site.
 */
function shaped(
  property: FormalProperty,
  criterion: AcceptanceCriterion,
): Result<FormalProperty, UnexpressedCriterion> {
  const rejection = propertyShapeRejection(property);
  return rejection === null ? ok(property) : err(refused(criterion, rejection));
}

/**
 * Build one validated `FormalProperty` from a draft, or report the criterion unexpressed.
 *
 * Every expression passes `validateExpression` before it reaches the returned property,
 * and the clock is taken from the Spec's own `ClockingContract` rather than from model
 * text - so a clock signal the interface does not declare is unrepresentable rather than
 * merely unlikely. A clocked draft on a combinational interface has no clock to validate,
 * so it is reported unexpressed instead of being downgraded to a combinational property,
 * which would assert the consequent at every instant rather than at a clock edge.
 */
function buildProperty(
  draft: PropertyDraft,
  criterion: AcceptanceCriterion,
  clocking: ClockingContract,
  id: string,
): Result<FormalProperty, UnexpressedCriterion> {
  const consequent = validateExpression(draft.consequent);
  if (!consequent.ok) {
    return err(refused(criterion, consequent.error));
  }
  if (draft.kind === 'combinational') {
    return shaped(
      { kind: 'combinational', id, criterionRef: criterion.id, consequent: consequent.value },
      criterion,
    );
  }
  if (clocking.clockName === null) {
    return err({ criterionId: criterion.id, reason: 'no-clock-declared' });
  }
  const clock = validateExpression(clocking.clockName);
  if (!clock.ok) {
    return err(refused(criterion, clock.error));
  }
  const antecedent = draft.antecedent === null ? ok(null) : validateExpression(draft.antecedent);
  if (!antecedent.ok) {
    return err(refused(criterion, antecedent.error));
  }
  return shaped(
    {
      kind: 'clocked',
      id,
      criterionRef: criterion.id,
      clock: clock.value,
      antecedent: antecedent.value,
      consequent: consequent.value,
    },
    criterion,
  );
}

/**
 * The first draft naming each criterion id, in the model's own emission order (rule 2).
 *
 * A later duplicate is dropped UNSEEN: it never reaches `validateExpression`, so no
 * later draft can stand in for a rejected first one. Reading the first rather than the
 * first ACCEPTED draft is the whole rule (Req 6.17, execution question E10) - see the
 * no-retry paragraph in this file's header for why that is not a missed robustness
 * opportunity.
 */
function firstDraftByCriterion(
  drafts: readonly PropertyDraft[],
): ReadonlyMap<string, PropertyDraft> {
  const byCriterion = new Map<string, PropertyDraft>();
  for (const draft of drafts) {
    if (!byCriterion.has(draft.criterionId)) {
      byCriterion.set(draft.criterionId, draft);
    }
  }
  return byCriterion;
}

/**
 * Partition the Spec's acceptance criteria into expressed properties and unexpressed
 * criteria (Req 6.15, 6.17; Property 17).
 *
 * Driven by the SPEC's criteria rather than by the model's reply, so every criterion
 * lands in exactly one half and a draft naming an unknown id contributes to neither.
 */
function partitionCriteria(spec: Spec, drafts: readonly PropertyDraft[]): PropertySetOutcome {
  const byCriterion = firstDraftByCriterion(drafts);
  const properties: FormalProperty[] = [];
  const unexpressed: UnexpressedCriterion[] = [];
  for (const criterion of spec.acceptanceCriteria) {
    const draft = byCriterion.get(criterion.id);
    if (draft === undefined) {
      unexpressed.push({ criterionId: criterion.id, reason: 'no-property-emitted' });
      continue;
    }
    const built = buildProperty(
      draft,
      criterion,
      spec.moduleInterface.clocking,
      propertyId(properties.length),
    );
    if (built.ok) {
      properties.push(built.value);
    } else {
      // The rejection of the FIRST draft ends this criterion (Req 6.17). Do not reach for
      // another draft here: that is the weaker-fallback path ADR-019 names and Property 17
      // needs closed. The header's no-retry paragraph is the argument.
      unexpressed.push(built.error);
    }
  }
  return outcomeOf(properties, unexpressed);
}

/** Assemble the outcome, projecting the unexpressed reasons down to the port's ids. */
function outcomeOf(
  properties: readonly FormalProperty[],
  unexpressed: readonly UnexpressedCriterion[],
): PropertySetOutcome {
  return {
    properties,
    unexpressed,
    unexpressedCriteria: unexpressed.map((entry) => entry.criterionId),
    // The author does not gate its own output; group 10 owns admission (Req 10.3, 13.6).
    // `'not-gated'` rather than `'no-gate-set'`: no gate ran here at all, and claiming one
    // ran with an empty gate set would report a measurement nobody took.
    propertySetAdmitted: 'not-gated',
  };
}

/**
 * The outcome where the author produced nothing: every criterion unexpressed.
 *
 * This is the required shape rather than an empty set, and the distinction is load
 * bearing. `PropertySetSource` has no failure channel, so a failed model call or an
 * unreadable reply must still partition the Spec's criteria - and the Verification_Loop
 * tells "a gate ran over an empty set" from "no gate was injected" by exactly this:
 * for an empty set, `unexpressedCriteria` names every criterion of the Spec.
 */
function nothingExpressed(spec: Spec): PropertySetOutcome {
  return outcomeOf(
    [],
    spec.acceptanceCriteria.map((criterion) => ({
      criterionId: criterion.id,
      reason: 'no-property-emitted' as const,
    })),
  );
}

/** Render the unexpressed criteria for the Trace, naming the construct where there was one. */
function describeUnexpressed(unexpressed: readonly UnexpressedCriterion[]): Json {
  return unexpressed.map((entry) => ({
    criterionId: entry.criterionId,
    reason: entry.reason,
    construct:
      entry.rejection?.reason === 'unaccepted-construct' ? entry.rejection.construct : null,
  }));
}

/** What one derivation attempt cost and how it ended, as the Trace records it. */
interface AttemptRecord {
  readonly startedAtMs: number;
  readonly nowMs: number;
  readonly costCents: number;
  readonly retryCount: number;
  /** Whether the attempt produced no readable property set at all (fail safe). */
  readonly failed: boolean;
}

/**
 * Append one sanitized Property_Author span, attributed to the Spec version.
 *
 * Every span carries the Spec id and version, so the authored Property_Set is always
 * attributable to the Spec it derived from regardless of outcome, and every emitted
 * property's `criterionRef` is on the record beside it (Req 6.14).
 */
async function recordSpan(
  spec: Spec,
  deps: PropertyAuthorDeps,
  outcome: PropertySetOutcome,
  attempt: AttemptRecord,
): Promise<void> {
  const outputs: Json = {
    stage: PROPERTY_STAGE,
    sourceAttribution: 'spec',
    specId: spec.id,
    specVersion: spec.version,
    propertyCount: outcome.properties.length,
    criterionRefs: outcome.properties.map((property) => property.criterionRef),
    unexpressed: describeUnexpressed(outcome.unexpressed),
    // READ from the outcome rather than re-spelled, so the Trace and the port can never
    // disagree about what this role gated. It is always `'not-gated'` today; reading it
    // means that stays true by construction rather than by two literals agreeing.
    propertySetAdmitted: outcome.propertySetAdmitted,
    propertySetAuthoredUpFront: false,
  };
  const base: SpanDraft = {
    sessionId: deps.budget.sessionId,
    stageOrTool: PROPERTY_STAGE,
    inputs: { stage: PROPERTY_STAGE, specId: spec.id, specVersion: spec.version },
    outputs,
    exitCode: attempt.failed ? null : 0,
    startedAt: new Date(attempt.startedAtMs).toISOString(),
    durationMs: Math.max(0, attempt.nowMs - attempt.startedAtMs),
    retryCount: attempt.retryCount,
    costCents: attempt.costCents,
  };
  await deps.recorder.record(attempt.failed ? { ...base, failureClass: 'tool-error' } : base);
}

/**
 * Derive the Property_Set for one approved Spec (Req 6.8, 6.14, 6.15, 6.16, 6.17).
 *
 * One model call under the caller's budget, the untrusted reply shaped at the boundary,
 * then every expression held to the Property_Validator before it can reach a property.
 * At most ONE draft per acceptance criterion is submitted to the validator - the first
 * the model emitted for it - and a criterion whose first draft the validator rejects is
 * reported unexpressed rather than re-drafted from a later one (Req 6.17).
 * The returned sets always partition the Spec's acceptance criteria, including on every
 * failure path, and `propertySetAdmitted` is always `'not-gated'`.
 *
 * NAMING: this is the function design.md and task 9.1 name. `PropertyAgent`'s
 * `propertySetFor(spec, budget)` - the method `PropertySetSource` declares - delegates
 * here, so the two names are one behaviour and cannot drift.
 */
export async function derivePropertySet(
  spec: Spec,
  deps: PropertyAuthorDeps,
): Promise<PropertySetOutcome> {
  const now = deps.now ?? Date.now;
  const startedAtMs = now();
  const invocation = await deps.router.invoke(
    PROPERTY_MODEL_TASK,
    buildPropertyModelInput(spec),
    deps.budget,
  );
  if (!invocation.ok) {
    const outcome = nothingExpressed(spec);
    await recordSpan(spec, deps, outcome, {
      startedAtMs,
      nowMs: now(),
      costCents: 0,
      retryCount: 0,
      failed: true,
    });
    return outcome;
  }

  const { costCents, attempts, outputText } = invocation.value;
  const parsed = parsePropertyDrafts(outputText);
  const outcome = parsed.ok ? partitionCriteria(spec, parsed.value) : nothingExpressed(spec);
  await recordSpan(spec, deps, outcome, {
    startedAtMs,
    nowMs: now(),
    costCents,
    retryCount: attempts - 1,
    failed: !parsed.ok,
  });
  return outcome;
}

/**
 * The Property_Author as the Verification_Loop's property source.
 *
 * `propertySetFor` satisfies `PropertySetSource` STRUCTURALLY, exactly as
 * `GenerationAgent` satisfies `CandidateGenerator`, so the loop depends on the one
 * primitive it needs rather than on this whole role - and this role names no
 * orchestrator port. The method is a pure delegation to `derivePropertySet`: one
 * behaviour under two names, with no second implementation to diverge from.
 */
export class PropertyAgent {
  readonly #deps: PropertyAgentDeps;

  constructor(deps: PropertyAgentDeps) {
    this.#deps = deps;
  }

  /** Derive one run's Property_Set, charging the model call to the caller's budget. */
  propertySetFor(spec: Spec, budget: SessionBudgetHandle): Promise<PropertySetOutcome> {
    return derivePropertySet(spec, { ...this.#deps, budget });
  }
}
