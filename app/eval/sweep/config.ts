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
import type { DesignGroup, ModelPriceTable, ModelTask, StrategyArm } from '@app/agent';

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
import type { SuccessCriterion } from './success-criterion.js';
import type { GroundingSuccessCriterion } from './grounding-criterion.js';
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
 * Whether the FORMAL_GATE runs beside the simulation oracle, when the config does not say.
 *
 * DISABLED, so no existing campaign's behaviour, cost, or recorded identity changes until a
 * config turns it on, and a runner that wires nothing sees exactly the behaviour the
 * Verification_Loop had before the gate existed (Req 11.16).
 *
 * It is a real wall-clock cost - a Property_Author model call plus a Yosys pre-pass and up to
 * four `yosys-smtbmc` invocations per property per sample - and it needs a toolchain the
 * simulation oracle does not: a run with it enabled is REFUSED where the composed
 * `yosys-smtbmc -s bitwuzla` invocation cannot run (Req 11.18). Off is therefore the only
 * default that leaves every committed campaign runnable on the host it was measured on.
 */
export const DEFAULT_FORMAL_GATE_ENABLED = false;

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
  /**
   * The Strategy_Arm this arm's Testbench_Agent runs under; absent means `control`.
   * Left off the parsed arm when the config omits it, so existing config hashes do not move.
   */
  readonly strategy?: StrategyArm;
}

/** The only resume limit a Campaign may declare (Req 8.11, 8.13). */
export const SCOREBOARD_CAMPAIGN_MAX_RESUMES = 2;

/**
 * Why Sample_Count 7, recorded verbatim so the manifest states what the size was chosen against.
 *
 * Every `exploratory*` field is a de-duplicated recount of
 * `.eval-runs/grounding-ab-v1/results.jsonl`, taking the last record per slot, which is how
 * `CompletedSampleIndex` reads it. The requirements cite 85/1470 and 99/2209 for the two
 * coverage-gap fractions; this constant carries the recount instead, because a pre-registration
 * must not hold a number the build cannot reproduce (design answer Q-07).
 *
 * Every `expected*` field is its observed counterpart times 7/5, rounded, which is exactly the
 * Sample_Count ratio and therefore exactly the Slot_Pair ratio 532/380. `minGroundedOnlyToHold`
 * is the one exception: it is the smallest Grounded_Arm-only count that clears the one-sided
 * exact McNemar level at 110 discordant pairs, pinned from an independent summation in the test.
 */
export interface GroundingPowerArithmetic {
  readonly exploratoryConfigHash: '773b798cf6bbe129';
  readonly exploratorySlotPairs: 380;
  readonly exploratoryGroundedOnlyValid: 56;
  readonly exploratoryControlOnlyValid: 23;
  readonly exploratoryJudgedControl: 58;
  readonly exploratoryJudgedGrounded: 97;
  readonly exploratoryCoverageGapSurvivorsControl: 87;
  readonly exploratoryCoverageGapSurvivorsGrounded: 100;
  readonly exploratoryScoredMutantsControl: 1493;
  readonly exploratoryScoredMutantsGrounded: 2230;
  readonly slotPairs: 532;
  readonly expectedGroundedOnlyValid: 78;
  readonly expectedControlOnlyValid: 32;
  readonly expectedDiscordantPairs: 110;
  readonly minGroundedOnlyToHold: 65;
  readonly expectedJudgedControl: 81;
  readonly expectedJudgedGrounded: 136;
  readonly expectedCoverageGapSurvivorsControl: 122;
  readonly expectedCoverageGapSurvivorsGrounded: 140;
  readonly expectedScoredMutantsControl: 2090;
  readonly expectedScoredMutantsGrounded: 3122;
}

/** The pre-registered power arithmetic; the parser accepts only these values. */
export const PRE_REGISTERED_GROUNDING_POWER: GroundingPowerArithmetic = {
  exploratoryConfigHash: '773b798cf6bbe129',
  exploratorySlotPairs: 380,
  exploratoryGroundedOnlyValid: 56,
  exploratoryControlOnlyValid: 23,
  exploratoryJudgedControl: 58,
  exploratoryJudgedGrounded: 97,
  exploratoryCoverageGapSurvivorsControl: 87,
  exploratoryCoverageGapSurvivorsGrounded: 100,
  exploratoryScoredMutantsControl: 1493,
  exploratoryScoredMutantsGrounded: 2230,
  slotPairs: 532,
  expectedGroundedOnlyValid: 78,
  expectedControlOnlyValid: 32,
  expectedDiscordantPairs: 110,
  minGroundedOnlyToHold: 65,
  expectedJudgedControl: 81,
  expectedJudgedGrounded: 136,
  expectedCoverageGapSurvivorsControl: 122,
  expectedCoverageGapSurvivorsGrounded: 140,
  expectedScoredMutantsControl: 2090,
  expectedScoredMutantsGrounded: 3122,
};

/** The Grounding Campaign block (testbench-spec-grounding, C15). */
export interface GroundingCampaignConfig {
  /** The pre-registered rule; the parser accepts only the constant's values (Req 12.1-12.3). */
  readonly successCriterion: GroundingSuccessCriterion;
  readonly powerArithmetic: GroundingPowerArithmetic;
  /** The Reference_Campaign records the cross-run reading is taken from (Req 11.6). */
  readonly referenceCampaign: {
    readonly resultsPath: string;
    readonly configHash: string;
    readonly schemaVersion: 15;
  };
  /** Where the Replay_Gate wrote its `--verify` report (Req 6.8, 6.9). */
  readonly replayGateReportPath: string;
  readonly maxResumes: 2;
}

/** The A/B Campaign block: recorded Design_Groups, the supplement, and the verdict rule. */
export interface ScoreboardCampaignConfig {
  /** Every Campaign design's Design_Group, written when the config was authored (Req 8.4). */
  readonly designGroups: Readonly<Record<string, DesignGroup>>;
  /** The Streaming_Supplement problem ids, a subset of `problems.ids` (Req 8.8). */
  readonly streamingSupplement: readonly string[];
  /** The pre-registered Success_Criterion (Req 10.1-10.3, 10.13). */
  readonly successCriterion: SuccessCriterion;
  /** The baseline the reproducibility reading is taken from (Req 9.3). */
  readonly baseline: { readonly resultsPath: string; readonly configHash: string };
  /** Resumes allowed after the first pass (Req 8.11, 8.13). */
  readonly maxResumes: typeof SCOREBOARD_CAMPAIGN_MAX_RESUMES;
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
  /**
   * Whether the FORMAL_GATE is constructed and injected into every sample's
   * Verification_Loop (Req 11.16, 11.17).
   *
   * Defaults to `false` (see `DEFAULT_FORMAL_GATE_ENABLED`). The ONE owner of that choice:
   * the composition root reads it to decide whether to build the Formal_Oracle and the
   * Property_Set source at all, and preflight reads it to decide whether the composed
   * `yosys-smtbmc -s bitwuzla` invocation has to work before the run may start.
   *
   * IN the config identity, and under its own reserved key - see `./config-identity.ts`.
   * This is the exact MIRROR IMAGE of `captureArtifacts` below it: capturing evidence does
   * not change the experiment, so that flag hashes identically on and off, while enabling a
   * SECOND ORACLE does change it. A sample whose verdict a proof could have decided and a
   * sample only the simulation could decide are answers to different questions, so their
   * samples must not pool under one fingerprint.
   */
  readonly formalGateEnabled: boolean;
  /** Samples in flight at once; conservative by default because the host rate-limits. */
  readonly concurrency: number;
  readonly transportRetry: TransportRetryPolicy;
  readonly killSwitch: KillSwitchBounds;
  /**
   * The committed Replay_Gate report a run refuses to start without, or absent. Top-level
   * because the gate is a claim about the build's harness, which a non-Campaign run needs too;
   * the grounding block keeps its own field so the Confirmatory identity does not move.
   */
  readonly replayGateReportPath?: string;
  /** The A/B Campaign block; absent from every config that is not the Campaign. */
  readonly scoreboardCampaign?: ScoreboardCampaignConfig;
  /** The Grounding Campaign block; a config declares at most one Campaign block. */
  readonly groundingCampaign?: GroundingCampaignConfig;
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
