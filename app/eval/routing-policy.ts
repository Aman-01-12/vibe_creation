// The eval run's routing policy: every role served by the bedrock-mantle host, with
// a caller-supplied model id PER ROLE (Req 15.10; `ECE-CONTEXT-ENGINEERING.md` s7).
//
// WHY THE EVAL NEEDS ITS OWN POLICY
//   `DEFAULT_ROUTING_POLICY` names aspirational model classes (`deepseek-v4-pro`,
//   `gemini-3-flash`, `claude-sonnet`) on three providers that are not provisioned
//   here, and it puts `bedrock-mantle` - the one host we actually hold a credential
//   for - on no route at all. Running the eval on that policy would measure nothing:
//   every call would fail `provider-unavailable`. So the eval builds its own policy
//   pinning every `ModelTask` to `bedrock-mantle` with real catalog model ids.
//
// WHY PER-ROLE IDS ARE THE POINT
//   The per-role bake-off holds ONE context configuration constant (provider, prompt,
//   context strategy) and permutes the model id per role, then selects on Cost per
//   Verified Artifact. The per-role map below IS that permutation knob: swap the
//   `generation` id and rerun, and the delta in oracle-verified pass@k and cost is
//   attributable to that model in that role.
//
// FALLBACK: DELIBERATELY OFF BY DEFAULT
//   `evalRoutingPolicy` produces single-entry chains and `maxAttempts: 1` unless a
//   fallback is asked for explicitly. That is a measurement decision, not laziness.
//   A fallback entry lets the router silently retry a failed call on ANOTHER model
//   and return success; the harness would then bank a `verified` sample - and its
//   cost - against the model under test, when a different model earned it. pass@k
//   and CPVA would both be corrupted in the flattering direction, and the corruption
//   would be invisible in the aggregate report. Attribution integrity therefore
//   outranks robustness here: a bake-off run should record the model under test
//   failing, because that failure rate IS part of what is being measured.
//
//   `fallbackModel` remains available for the other legitimate eval question - "how
//   does the SHIPPING stack, escalation included, score?" - because a certified
//   configuration includes its fallback behaviour. Opting in is explicit, per role,
//   and same-provider only, so it can never be mistaken for a clean bake-off.
//
// Model ids are NOT validated against a catalog list. The bedrock-mantle catalog
// changes without our code changing, and a hardcoded allow-list would reject a
// newly available model or, worse, invite someone to disable the check. What IS
// validated at this boundary is the shape: every role must name a non-blank model
// id, and a blank or missing one throws HERE, at composition time, rather than
// surfacing later as an indistinguishable provider failure mid-run.
//
// Real catalog ids look like: `qwen.qwen3-coder-480b-a35b-instruct`, `deepseek.v3.2`,
// `zai.glm-5`, `moonshotai.kimi-k2.5`, `mistral.devstral-2-123b`.

import {
  MODEL_TASKS,
  singleProviderRoutingPolicy,
  type ModelTask,
  type RoutingPolicy,
} from '@app/agent';

/** The one provider serving every role in an eval run. */
const EVAL_PROVIDER = 'bedrock-mantle' as const;

/**
 * Attempts allowed per `invoke` when no fallback is configured: exactly one, so a
 * failed call is recorded as a failure of the model under test.
 */
const NO_FALLBACK_MAX_ATTEMPTS = 1;

/** Attempts allowed per `invoke` when a fallback IS configured: the primary plus it. */
const WITH_FALLBACK_MAX_ATTEMPTS = 2;

/** The model id serving each role; the unit a per-role bake-off permutes. */
export type EvalRoleModels = Readonly<Record<ModelTask, string>>;

/** The optional same-provider fallback model per role; a role may have none. */
export type EvalRoleFallbackModels = Readonly<Partial<Record<ModelTask, string>>>;

/** Inputs to `evalRoutingPolicy`. */
export interface EvalRoutingPolicyInput {
  /** The bedrock-mantle model id for every role. Each must be non-blank. */
  readonly taskModel: EvalRoleModels;
  /**
   * Opt-in same-provider fallback per role. OMIT THIS for a bake-off: see the
   * module header on why a silent fallback misattributes a verified artifact.
   */
  readonly fallbackModel?: EvalRoleFallbackModels;
  /**
   * Attempts allowed per `invoke`. Defaults to 1 with no fallback and 2 with one,
   * so the configured chain is exactly reachable and never over-walked.
   */
  readonly maxAttempts?: number;
}

/** Reject a wiring mistake loudly at composition time rather than mid-run. */
function policyError(detail: string): never {
  // Names the role, never the supplied value: a policy is composed from config that
  // an operator may have pasted a credential into by mistake, and this message can
  // reach a log.
  throw new Error(`Eval routing policy error: ${detail}`);
}

/** A model id trimmed of surrounding whitespace, or a loud failure when unusable. */
function requireModelId(role: string, label: string, modelId: string | undefined): string {
  if (typeof modelId !== 'string') {
    policyError(`no ${label} model id configured for role ${role}`);
  }
  const trimmed = modelId.trim();
  if (trimmed.length === 0) {
    policyError(`the ${label} model id for role ${role} is blank`);
  }
  return trimmed;
}

/** The validated per-role primary model ids, covering every `ModelTask`. */
function validatePrimaryModels(taskModel: EvalRoleModels): Record<ModelTask, string> {
  const validated = {} as Record<ModelTask, string>;
  for (const task of MODEL_TASKS) {
    validated[task] = requireModelId(task, 'primary', taskModel[task]);
  }
  return validated;
}

/**
 * The validated per-role fallback model ids.
 *
 * A role absent from the input has no fallback (its chain stays single-entry); a
 * role PRESENT with a blank id is a wiring mistake and fails loudly, because
 * silently dropping it would leave the caller believing a fallback was configured.
 */
function validateFallbackModels(
  fallbackModel: EvalRoleFallbackModels | undefined,
): Partial<Record<ModelTask, string>> {
  if (fallbackModel === undefined) {
    return {};
  }
  const validated: Partial<Record<ModelTask, string>> = {};
  for (const task of MODEL_TASKS) {
    if (task in fallbackModel) {
      validated[task] = requireModelId(task, 'fallback', fallbackModel[task]);
    }
  }
  return validated;
}

/** The attempt cap to use: the caller's when valid, else the fallback-aware default. */
function resolveMaxAttempts(requested: number | undefined, hasFallback: boolean): number {
  const fallbackAware = hasFallback ? WITH_FALLBACK_MAX_ATTEMPTS : NO_FALLBACK_MAX_ATTEMPTS;
  if (requested === undefined) {
    return fallbackAware;
  }
  if (!Number.isInteger(requested) || requested < 1) {
    policyError('maxAttempts must be a positive integer');
  }
  return requested;
}

/**
 * Build the eval `RoutingPolicy`: every `ModelTask` on `bedrock-mantle` with the
 * caller's per-role model id.
 *
 * Throws on a blank or missing model id and on a non-positive `maxAttempts`, so a
 * mis-wired bake-off cannot start and later be read as a model's poor score.
 */
export function evalRoutingPolicy(input: EvalRoutingPolicyInput): RoutingPolicy {
  const taskModel = validatePrimaryModels(input.taskModel);
  const fallbackModel = validateFallbackModels(input.fallbackModel);
  const hasFallback = Object.keys(fallbackModel).length > 0;
  return singleProviderRoutingPolicy({
    provider: EVAL_PROVIDER,
    taskModel,
    fallbackModel,
    maxAttempts: resolveMaxAttempts(input.maxAttempts, hasFallback),
  });
}

/**
 * Build the eval `RoutingPolicy` serving EVERY role from one model id.
 *
 * The convenience for the baseline arm of a bake-off ("this one model, everywhere")
 * and for a smoke run. It is the same builder underneath, so it validates
 * identically and inherits the no-fallback default.
 */
export function singleModelEvalRoutingPolicy(modelId: string, maxAttempts?: number): RoutingPolicy {
  const shared = requireModelId('all-roles', 'primary', modelId);
  const taskModel = {} as Record<ModelTask, string>;
  for (const task of MODEL_TASKS) {
    taskModel[task] = shared;
  }
  return evalRoutingPolicy({
    taskModel,
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
  });
}
