// The declarative sweep configuration: the shape of one bake-off campaign.
//
// One JSON file declares the WHOLE experiment - the arms, the problem selection, the
// sampling, the student caps, the sandbox limits, the output location, the
// concurrency, the retry/breaker policy, the kill switch, and the optional price
// table. Nothing about the experiment lives in code, so a different campaign is a
// different file rather than a different build, and the file itself is the artifact a
// result is cited against.
//
// WHAT IS DELIBERATELY NOT IN HERE
//   The CREDENTIAL. It comes from the environment through the env-backed secret
//   manager and nothing else. A config file gets committed, pasted into a chat, and
//   attached to a report; a credential in one is a credential leaked. The example
//   config says so at the top, and no field here can hold one.
//
// EVERY FIELD IS VALIDATED AT THE BOUNDARY
//   `parseSweepConfig` (in `./config-parse.ts`) turns untrusted JSON into this shape
//   or into a typed, field-attributed error. A bad config therefore fails BEFORE the
//   first model call - which matters because the alternative is discovering the typo
//   three hours and a hundred paid samples into the matrix.

import type { ResourceLimits } from '@app/tools';
import type { ModelPriceTable, ModelTask } from '@app/agent';

import type { StudentSessionCaps } from '../loop-runner.js';
import {
  DEFAULT_MAX_MUTANTS_PER_PROBLEM,
  DEFAULT_MUTANT_WALL_MS,
  MUTATION_OPERATORS,
  type MutationConfig,
} from '../mutation-control.js';
import type { ReproducibilityConfig } from '../reproducibility.js';
import type { RtllmCategory } from '../corpus/pinned-source.js';
import type { KillSwitchBounds } from './kill-switch.js';
import type { TransportRetryPolicy } from './transport-retry.js';

/** The only config schema version this build understands. */
export const SWEEP_CONFIG_SCHEMA_VERSION = 1;

/**
 * Bounds on the config's own sizes.
 *
 * Present because the config is untrusted input: a hand-edit or a generated file
 * could name ten thousand arms, and the matrix is multiplicative. Each bound is
 * generous for a real campaign and finite.
 */
export const SWEEP_CONFIG_BOUNDS = Object.freeze({
  /** Longest accepted run or arm name. */
  maxNameLength: 64,
  /** Most arms one campaign may declare. */
  maxArms: 64,
  /** Most explicit problem ids one selection may name. */
  maxProblemIds: 500,
  /** Most samples per problem (the n in pass@k). */
  maxSampleCount: 50,
  /** Most concurrent samples in flight. */
  maxConcurrency: 32,
  /** Longest accepted output directory path. */
  maxOutputDirLength: 240,
  /** Most priced models one table may carry. */
  maxPricedModels: 256,
});

/**
 * Whether per-sample artifacts are captured when the config does not say.
 *
 * ENABLED, because the campaign's whole purpose is tuning: the first real smoke sweep
 * disagreed with the independent judge on two of three problems and the persisted record
 * could not say why. A default of off would make every future run of that campaign just as
 * blind, and an operator who does not want the files can turn them off explicitly.
 */
export const DEFAULT_CAPTURE_ARTIFACTS = true;

/**
 * Whether the MUTATION-BASED NEGATIVE CONTROL runs when the config does not say.
 *
 * ENABLED, because `smoke-v4-oracle` shipped a `verified` sample whose testbench passed a
 * design the independent golden judge fails 100/100, and the positive control read that
 * sample `valid`. Defaulting this off would leave every future campaign unable to see that
 * class - and the class is the one that produces a false `Verified`.
 *
 * It is a real wall-clock cost (one simulation per VALID mutant per sample, plus a cached
 * one-off calibration per problem), so an operator who wants a cheap run can turn it off
 * explicitly. The summary then LABELS the arm's instrument numbers as positive-control-only, so
 * a weaker standard is never cited as the full one.
 */
export const DEFAULT_NEGATIVE_CONTROL_ENABLED = true;

/**
 * The mutation-based negative control's knobs.
 *
 * IN the config identity, unlike `captureArtifacts`: every field here can move a measured
 * number, because instrument validity decides the pass@k denominator. Two runs with different
 * mutant budgets are answering different questions and their samples must not be pooled.
 *
 * WHY THERE IS NO `minKillRate` HERE ANY MORE. The negative control's gate is zero
 * coverage-gap survivors - our testbench must kill every valid mutant the INDEPENDENT golden
 * testbench kills - and that is not a tunable fraction. The kill rate is still measured and
 * reported as a quality signal, but a threshold on it decides nothing, and a config field that
 * cannot move a measured number is a field a future reader will assume gates something. It was
 * removed rather than demoted to reporting-only for exactly that reason.
 */
export interface SweepNegativeControlConfig {
  readonly enabled: boolean;
  /** Mutants generated per problem; the wall-clock knob (mutants x simulations). */
  readonly maxMutantsPerProblem: number;
  /**
   * Wall-clock ceiling for ONE MUTANT run, in milliseconds; the OTHER wall-clock knob.
   *
   * A mutant run does NOT inherit `limits.wallMs`. The student cap is sized for a real design
   * under load; a mutant run is the same toolchain over the same tiny design, so the only way it
   * approaches that cap is by HANGING - and RTLLM's golden testbenches hang structurally, because
   * they commonly spin on a design signal that a mutant can break. Measured, at
   * `limits.wallMs = 30000`: a real mutant run costs 137-237ms and a hanging one costs the full
   * 30005ms. See `DEFAULT_MUTANT_WALL_MS` for the numbers and why the default is 5000ms.
   *
   * It is IN the config identity like its sibling, and for a sharper reason: it can change which
   * mutants classify `golden-timeout`, `golden-timeout` is a golden KILL, golden kills are the
   * GATE set, and the gate decides instrument validity - which decides the pass@k denominator. So
   * two caps are two experiments and their samples must not pool.
   *
   * It replaces ONLY the wall clock. cpu, memMb, procs, and diskMb stay identical to the student
   * session's, because the mutant runs on the same rails as the oracle.
   */
  readonly mutantWallMs: number;
}

/** The default negative-control configuration. */
export const DEFAULT_NEGATIVE_CONTROL_CONFIG: SweepNegativeControlConfig = Object.freeze({
  enabled: DEFAULT_NEGATIVE_CONTROL_ENABLED,
  maxMutantsPerProblem: DEFAULT_MAX_MUTANTS_PER_PROBLEM,
  mutantWallMs: DEFAULT_MUTANT_WALL_MS,
});

/**
 * The mutation config a sweep's negative control generates mutants with.
 *
 * Derived rather than stored, so the sweep config and the mutation config cannot disagree, and
 * so the calibration cache key (which hashes the mutation config) is a function of the sweep
 * config alone. Every operator is enabled: the operator SET is not a campaign knob, because a
 * campaign that quietly disabled the operators it fails would be tuning the measurement rather
 * than the instrument.
 */
export function mutationConfigFor(config: SweepConfig): MutationConfig {
  return {
    maxMutantsPerProblem: config.negativeControl.maxMutantsPerProblem,
    operators: MUTATION_OPERATORS,
  };
}

/**
 * Names accepted for a run or an arm.
 *
 * Restricted because these travel into filenames, stdout, and every persisted record.
 * A conservative charset removes path traversal, shell metacharacters, and log
 * injection from consideration entirely rather than escaping them at each use.
 */
export const SWEEP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * One bake-off arm: a name plus the model serving each role.
 *
 * A config may declare an arm with ONE model id for every role (the common case, "how
 * does this model do?") or with a per-role map (the per-role bake-off, "does a cheaper
 * model suffice for repair?"). Both resolve to the same shape here, so everything
 * downstream - the routing policy, the manifest, the records - handles exactly one
 * case. Whether the arm was declared as a single model is DERIVED (`isSingleModel`)
 * rather than stored, so the two can never disagree.
 */
export interface SweepArmConfig {
  readonly name: string;
  /** The model id serving each role; every `ModelTask` is present and non-blank. */
  readonly roleModels: Readonly<Record<ModelTask, string>>;
}

/**
 * Which scored RTLLM problems an arm attempts.
 *
 * `all` is every problem in the scored corpus (the Stage 0 quarantine already
 * removed). `ids` and `categories` are for a smoke run or a shard; both are matched
 * against the scored corpus, and a selection that matches nothing is a config error
 * rather than a silently empty run.
 */
export type SweepProblemSelection =
  | { readonly kind: 'all' }
  | { readonly kind: 'ids'; readonly ids: readonly string[] }
  | { readonly kind: 'categories'; readonly categories: readonly RtllmCategory[] };

/** Non-secret configuration of the bedrock-mantle host the run calls. */
export interface SweepModelHostConfig {
  /** AWS region hosting the OpenAI-compatible endpoint, e.g. `us-east-1`. */
  readonly region: string;
  /** Output-token cap per model call; the transport's default applies when omitted. */
  readonly maxOutputTokens?: number;
  /** Per-call deadline in milliseconds; the transport's default applies when omitted. */
  readonly requestTimeoutMs?: number;
}

/** One validated sweep campaign. */
export interface SweepConfig {
  readonly schemaVersion: number;
  /** Names the campaign; appears in the manifest and the summary, not in a path. */
  readonly runName: string;
  readonly arms: readonly SweepArmConfig[];
  readonly problems: SweepProblemSelection;
  /** Seed, temperature, and sampleCount, validated by the reproducibility module. */
  readonly reproducibility: ReproducibilityConfig;
  /** The k values pass@k is reported for; each an integer in [1, sampleCount]. */
  readonly ks: readonly number[];
  /** The student-session caps every sample runs under - the same a student gets. */
  readonly caps: StudentSessionCaps;
  /** The sandbox resource limits, identical to a student session. */
  readonly limits: ResourceLimits;
  /** The pennies-per-session envelope the harness asserts for every sample. */
  readonly costEnvelopeCents: number;
  readonly modelHost: SweepModelHostConfig;
  /**
   * Per-model prices, keyed by model id - OPTIONAL, and it buys only the dollar figures.
   *
   * A model ABSENT here has an UNKNOWN price, which is not the same as a free one: the
   * summary reports that arm's cost IN DOLLARS as UNKNOWN and omits the dollar cost per
   * verified artifact rather than printing a misleading 0.
   *
   * It does NOT decide whether the campaign has a cost metric. Tokens per verified artifact
   * and wall clock per verified artifact are measured from the endpoint's own usage counts
   * and the runner's clock, so they are reported for every campaign, priced or not. Dollars
   * are the optional restatement of the same consumption, because no endpoint returns money.
   */
  readonly prices: ModelPriceTable;
  /** Directory the manifest, the results log, and the summary are written to. */
  readonly outputDir: string;
  /**
   * Whether each sample's inputs and oracle evidence are written under `outputDir`.
   *
   * Defaults to `true` (see `DEFAULT_CAPTURE_ARTIFACTS`). Purely diagnostic: it decides
   * whether files are written beside the results, never what a sample measures.
   *
   * DELIBERATELY EXCLUDED from the config identity - see `./config-identity.ts`. Two runs
   * that differ only in this flag are the SAME experiment, so a recorded sample stays
   * resumable whether or not its evidence was captured.
   */
  readonly captureArtifacts: boolean;
  /**
   * The MUTATION-BASED NEGATIVE CONTROL's knobs.
   *
   * Part of the config identity, because instrument validity decides the pass@k denominator
   * and these fields decide instrument validity.
   */
  readonly negativeControl: SweepNegativeControlConfig;
  /** Samples in flight at once; conservative by default because the host rate-limits. */
  readonly concurrency: number;
  readonly transportRetry: TransportRetryPolicy;
  readonly killSwitch: KillSwitchBounds;
}

/** Whether an arm named one model for every role (derived, never stored). */
export function isSingleModel(arm: SweepArmConfig): boolean {
  return new Set(Object.values(arm.roleModels)).size === 1;
}

/**
 * A stable, human-readable rendering of an arm's model ids.
 *
 * Persisted on every sample record so the results file is self-describing: a row says
 * which model produced it without a reader having to hold the config alongside. A
 * single-model arm renders as the bare id; a per-role arm renders every role in
 * `MODEL_TASKS` order, supplied by the caller so this stays pure.
 */
export function modelSignatureOf(arm: SweepArmConfig, taskOrder: readonly ModelTask[]): string {
  if (isSingleModel(arm)) {
    return arm.roleModels[taskOrder[0] ?? 'generation'];
  }
  return taskOrder.map((task) => `${task}=${arm.roleModels[task]}`).join(',');
}

/** Every distinct model id an arm uses, in first-seen role order. */
export function armModelIds(
  arm: SweepArmConfig,
  taskOrder: readonly ModelTask[],
): readonly string[] {
  return [...new Set(taskOrder.map((task) => arm.roleModels[task]))];
}

/**
 * Whether every model this arm uses has a price, so its cost figures mean something.
 *
 * An arm with even one unpriced model reports UNKNOWN cost: a partial cost is worse
 * than none, because it looks like a real number.
 */
export function armCostIsKnown(
  arm: SweepArmConfig,
  taskOrder: readonly ModelTask[],
  prices: ModelPriceTable,
): boolean {
  const ids = armModelIds(arm, taskOrder);
  return ids.length > 0 && ids.every((id) => prices[id] !== undefined);
}
