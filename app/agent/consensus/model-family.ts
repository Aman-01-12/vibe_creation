// Model_Family resolution and the diverse routing planner (Req 3.1, 3.2, 3.4, 3.5,
// 3.7, 3.8, 3.9, 5.9, 5.11).
//
// A Model_Family is vendor plus base lineage, derived from the `{provider, modelId}`
// pair the Model_Router already resolves. Two selections are the same family when
// `modelFamilyOf` returns equal `provider` and `lineage`, which groups e.g.
// `deepseek-v3.2` with `deepseek-v4-pro`, and `zai.glm-4.7` with `zai.glm-5` into
// `zai/glm`, because both collapse into the single lineage the measurement grouped on.
//
// MEASURED (`.eval-runs/wave-consensus-replay-v1/model_family.py`, 47,725 simulated
// sessions): 2.6% wrong labels at 1 family, 0.3% at 2, 0.3% at 3. The cliff sits
// between 1 and 2 families, not between 2 and 3, which is why `MIN_MODEL_FAMILIES`
// stays the Design_Pool requirement and `MODEL_FAMILY_FALLBACK_FLOOR` records 2 as
// the grounded floor for a provider outage rather than a guess.
//
// THE DESIGN-SIDE / TESTBENCH-SIDE ASYMMETRY (Q-11)
//   Design_Pool family spread is a Grant_Condition: `planDesignPoolFamilies` enforces
//   the structural slot cap (`floor(N / 2)` per family) by construction, so no family
//   can ever be assigned a Strict_Majority of design slots even if every one of its
//   calls succeeds. Whether the achieved count also reaches `MIN_MODEL_FAMILIES` is
//   judged downstream by the Grant_Condition evaluator (C2), not by this planner.
//   Testbench_Pool family spread is a routing TARGET only (Req 5.9): same-family
//   Reference_Model_Testbench pairs shared a correctness verdict 64.0% of the time
//   over 1,196 pairs against 59.5% over 4,048 cross-family pairs (Req 5.11), a
//   4.5-point correlation roughly ninefold weaker than the design-side effect. So
//   `planTestbenchPoolFamilies` carries no cap and always fills every slot; the
//   achieved family count is recorded rather than enforced.

import {
  MODEL_TASKS,
  singleProviderRoutingPolicy,
  type ModelSelection,
  type ModelTask,
  type ProviderName,
  type RoutingPolicy,
} from '../model-router/index.js';

/** The vendor-and-lineage grouping a generation model belongs to. */
export interface ModelFamily {
  readonly provider: ProviderName;
  /** The base lineage, which is the model id with its version suffix removed. */
  readonly lineage: string;
}

/** The Design_Pool requirement, and the configuration every headline figure was measured under. */
export const MIN_MODEL_FAMILIES = 3;

/**
 * The evidence-backed floor beneath `MIN_MODEL_FAMILIES`, for a provider outage only
 * (Req 3.8). MEASURED: the wrong-label cliff is between 1 and 2 families, not between
 * 2 and 3 (Req 3.9).
 */
export const MODEL_FAMILY_FALLBACK_FLOOR = 2;

/**
 * Strips a trailing version marker from a model-name segment, which may itself
 * contain a dot (e.g. `v3.2`, `glm-4.7`), so the split cannot be "cut at the next dot".
 *
 * Two shapes are stripped, tried in order. First, a `-v<digit>` marker and
 * everything after it, so a trailing qualifier riding on the version (`v4-pro`)
 * collapses with a bare version (`v3.2`). Second, a single trailing
 * `[-.]?<letter>?<digits>[.digits]` group - at most one separator, one optional
 * version-letter (`v`, or moonshotai's `k`-series), and a digit run with an
 * optional decimal - so `glm-5`, `glm-4.7`, `kimi-k2.5`, and a bare `v3.2` with no
 * name prefix at all each collapse to their name (or to nothing, for a model id
 * that IS its version).
 *
 * ponytail: this is a naming-convention heuristic over today's observed catalog
 * ids, not a parser against a vendor's published lineage table, so a version shape
 * this repository has not seen (e.g. a two-letter version prefix) will not
 * collapse. The upgrade path, if that ever causes a wrong family split, is an
 * explicit vendor-to-lineage table alongside this function rather than a cleverer
 * regex.
 */
function stripVersionTail(model: string): string {
  const versionAndTrailingTag = /-v\d.*$/i;
  if (versionAndTrailingTag.test(model)) {
    return model.replace(versionAndTrailingTag, '');
  }
  const bareVersion = /[-.]?[a-z]?\d+(?:\.\d+)?$/i;
  return model.replace(bareVersion, '');
}

/**
 * Splits a `modelId` into its vendor and base-model segments.
 *
 * Only the bedrock-mantle host serves a whole catalog under one credential, so only
 * there does `modelId` carry a second vendor as a dot-prefix (e.g. `zai.glm-5`); the
 * split is on the FIRST `.` alone, since the remainder (the model segment) may
 * itself contain a dot as part of its own version (`v3.2`, `glm-4.7`). Every other
 * provider's `modelId` names one of that provider's own models directly (e.g.
 * `deepseek-v3.2`), so there is no embedded vendor to extract and the selection's
 * own `provider` is the vendor.
 */
function vendorAndModel(selection: ModelSelection): { vendor: string; model: string } {
  const { modelId, provider } = selection;
  if (provider !== 'bedrock-mantle') {
    return { vendor: provider, model: modelId };
  }
  const dotIndex = modelId.indexOf('.');
  if (dotIndex === -1) {
    return { vendor: provider, model: modelId };
  }
  return { vendor: modelId.slice(0, dotIndex), model: modelId.slice(dotIndex + 1) };
}

/** Resolve a `ModelSelection` to its Model_Family: vendor plus base lineage. */
export function modelFamilyOf(selection: ModelSelection): ModelFamily {
  const { vendor, model } = vendorAndModel(selection);
  const baseLineage = stripVersionTail(model);
  // A model id that IS its version (`v3.2`, stripped to '') has no name component
  // beyond the vendor, so the lineage falls back to the vendor alone rather than a
  // lineage with a dangling separator.
  const lineage =
    baseLineage === ''
      ? vendor
      : vendor === selection.provider
        ? baseLineage
        : `${vendor}/${baseLineage}`;
  return { provider: selection.provider, lineage };
}

/** The stable key two `ModelFamily` values share iff they are the same family. */
function familyKey(family: ModelFamily): string {
  return `${family.provider}\u0000${family.lineage}`;
}

/** One generation call's assigned family and the chain that routes it with no cross-family fallback. */
export interface FamilyRoutedCall {
  readonly family: ModelFamily;
  readonly selection: ModelSelection;
  /** Every `ModelTask` resolves to this one selection, so no task can escalate past it. */
  readonly routingPolicy: RoutingPolicy;
}

/** The planner's output for one pool: the per-call routing plan and the distinct family count it achieved. */
export interface FamilyPlan {
  readonly calls: readonly FamilyRoutedCall[];
  readonly distinctFamilyCount: number;
}

/**
 * The single-entry, no-fallback `RoutingPolicy` for one routed call (Req 3.5).
 *
 * The existing `RoutingPolicy` escalates `generation` to Claude on failure, which
 * would silently collapse the Model_Family diversity this planner just assigned. So
 * every `ModelTask`, not just `generation`, is pinned to this one selection with
 * `maxAttempts: 1`: there is no second entry in any chain for the router to fall
 * back to, so a provider failure surfaces as a failed call rather than a quiet
 * substitution.
 */
function singleEntryPolicyFor(selection: ModelSelection): RoutingPolicy {
  const taskModel = {} as Record<ModelTask, string>;
  for (const task of MODEL_TASKS) {
    taskModel[task] = selection.modelId;
  }
  return singleProviderRoutingPolicy({
    provider: selection.provider,
    taskModel,
    maxAttempts: 1,
  });
}

/** One available selection, deduplicated to its first-seen representative per family. */
interface FamilyCandidate {
  readonly family: ModelFamily;
  readonly selection: ModelSelection;
}

/** Collapse the available selections to one representative selection per distinct family. */
function dedupeByFamily(
  availableSelections: readonly ModelSelection[],
): readonly FamilyCandidate[] {
  const seen = new Map<string, FamilyCandidate>();
  for (const selection of availableSelections) {
    const family = modelFamilyOf(selection);
    const key = familyKey(family);
    if (!seen.has(key)) {
      seen.set(key, { family, selection });
    }
  }
  return [...seen.values()];
}

/**
 * Assign `poolSize` calls round-robin across `families`, never letting one family
 * exceed `perFamilyCap` slots.
 *
 * `perFamilyCap` of `Number.POSITIVE_INFINITY` (the Testbench_Pool case) always
 * fills every slot. A finite cap (the Design_Pool case) can leave the plan SHORT of
 * `poolSize` when too few families are available to fill the pool without any one
 * of them exceeding its cap - the cap is the invariant that must hold, not the slot
 * count, so a plan that cannot fill every slot without violating it simply builds
 * fewer calls.
 */
function roundRobinAssign(
  families: readonly FamilyCandidate[],
  poolSize: number,
  perFamilyCap: number,
): readonly FamilyRoutedCall[] {
  const remaining = families.map(() => perFamilyCap);
  const calls: FamilyRoutedCall[] = [];
  let index = 0;
  let consecutiveSkips = 0;
  while (calls.length < poolSize && consecutiveSkips < families.length) {
    const candidate = families[index];
    const remainingForCandidate = remaining[index];
    if (
      candidate !== undefined &&
      remainingForCandidate !== undefined &&
      remainingForCandidate > 0
    ) {
      calls.push({
        family: candidate.family,
        selection: candidate.selection,
        routingPolicy: singleEntryPolicyFor(candidate.selection),
      });
      remaining[index] = remainingForCandidate - 1;
      consecutiveSkips = 0;
    } else {
      consecutiveSkips += 1;
    }
    index = (index + 1) % families.length;
  }
  return calls;
}

/** The number of distinct families actually used across a set of routed calls. */
function distinctFamilyCount(calls: readonly FamilyRoutedCall[]): number {
  return new Set(calls.map((call) => familyKey(call.family))).size;
}

/** Validate the two planner inputs shared by both pools; throws on a wiring mistake. */
function validatePlanInputs(
  availableSelections: readonly ModelSelection[],
  poolSize: number,
): void {
  if (availableSelections.length === 0) {
    throw new Error('Model_Family planning error: no available Model_Selection to route from');
  }
  if (!Number.isInteger(poolSize) || poolSize <= 0) {
    throw new Error(
      `Model_Family planning error: poolSize must be a positive integer, got ${poolSize}`,
    );
  }
}

/**
 * Plan the N Design_Pool generation calls (Req 3.1, 3.2, 3.4, 3.5).
 *
 * No single family is assigned more than `Math.floor(poolSize / 2)` slots, so no
 * family can contribute a Strict_Majority of the Design_Pool on its own even if
 * every one of its calls succeeds (Req 3.2) - which also pre-empts Requirement 3
 * criterion 7 structurally, since a cluster of a Strict_Majority or more can never
 * be single-family. Whether the achieved `distinctFamilyCount` also reaches
 * `MIN_MODEL_FAMILIES` is the Design_Pool diversity Grant_Condition, judged by the
 * Grant_Condition evaluator (C2) against the plan's own `distinctFamilyCount`
 * record, not enforced here.
 */
export function planDesignPoolFamilies(
  availableSelections: readonly ModelSelection[],
  poolSize: number,
): FamilyPlan {
  validatePlanInputs(availableSelections, poolSize);
  const families = dedupeByFamily(availableSelections);
  const perFamilyCap = Math.floor(poolSize / 2);
  const calls = roundRobinAssign(families, poolSize, perFamilyCap);
  return { calls, distinctFamilyCount: distinctFamilyCount(calls) };
}

/**
 * Plan the N Testbench_Pool generation calls (Req 5.9, 5.11).
 *
 * Family spread here is a routing TARGET, not a Grant_Condition: every slot is
 * filled with no per-family cap, and the achieved `distinctFamilyCount` is recorded
 * on the plan so a routing target that is persistently missed stays visible rather
 * than silent. No caller may fail a Session on this plan's family count.
 */
export function planTestbenchPoolFamilies(
  availableSelections: readonly ModelSelection[],
  poolSize: number,
): FamilyPlan {
  validatePlanInputs(availableSelections, poolSize);
  const families = dedupeByFamily(availableSelections);
  const calls = roundRobinAssign(families, poolSize, Number.POSITIVE_INFINITY);
  return { calls, distinctFamilyCount: distinctFamilyCount(calls) };
}
