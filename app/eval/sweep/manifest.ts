// The run MANIFEST: everything a reader needs to believe, reproduce, or reject a
// number this sweep produced.
//
// WHY A MANIFEST IS THE DIFFERENCE BETWEEN A NUMBER AND A CITABLE NUMBER
//   "GLM-5 scored 0.62 pass@5" is not a result; it is an anecdote. The result is that
//   number PLUS the corpus commit it was measured on, the exclusions applied, the seed
//   and temperature and sample count, the student caps, the exact model id per role,
//   the EDA tool versions that decided each verdict, the host, and the commit of the
//   harness that ran it. Without those, a later run that disagrees cannot be
//   diagnosed - and a run that agrees proves nothing either.
//
// THE DIRTY-TREE FIELD IS THE HONEST PART
//   `workingTreeDirty` records whether the harness had uncommitted changes. A result
//   from uncommitted code is NOT reproducible: the commit hash points at code that did
//   not produce it. Recording that plainly - and printing it in the summary - is the
//   whole point. Hiding it would make every clean-looking manifest untrustworthy,
//   because a reader could no longer tell which ones were checked.
//
// TOOL VERSIONS ARE PROBED, NOT ASSUMED
//   The Stage 0 quarantine exists because Icarus and VCS disagree about several golden
//   testbenches, so the simulator version is part of what a verdict MEANS. The version
//   strings are supplied by a probe (`./host-facts.ts`) rather than hardcoded here; a
//   probe that could not read a version records `null`, which reads as "unknown" and
//   not as "some default".
//
// THE PROMPT VERSION AND THE INSTRUMENT POLICY VERSION ARE PINNED THE SAME WAY THE
// CORPUS COMMIT IS
//   `testbenchPromptVersion` is read directly from `TESTBENCH_PROMPT_VERSION`, exactly
//   like `corpus.pinnedCommit` is read directly from the pinned corpus constant, rather
//   than being threaded in through `ManifestFacts` or accepted as a parameter. A prompt
//   change is a different experiment from the one before it, and a manifest that could be
//   handed a version number would let a run claim a prompt it never ran.
//   `instrumentPolicyVersion` is read directly from `INSTRUMENT_POLICY_VERSION` for the
//   identical reason: a manifest must not be able to claim a policy the run did not
//   actually use. `testbenchRepairPolicyVersion` is read directly from
//   `TESTBENCH_REPAIR_POLICY_VERSION` following the same discipline, and
//   `normalizerVersion` is read directly from `NORMALIZER_VERSION` following the same
//   discipline: a manifest must not be able to claim a transform the run did not use.
//
// WHAT IS DELIBERATELY ABSENT
//   No credential, obviously - but also no hostname and no absolute paths. A machine
//   name identifies a person's laptop and answers nothing about reproducibility, which
//   the platform, architecture, and runtime version already do. This module is pure:
//   every fact is injected, so manifest assembly is unit-tested with no host at all.

import {
  INSTRUMENT_POLICY_VERSION,
  MODEL_TASKS,
  NORMALIZER_VERSION,
  TESTBENCH_PROMPT_VERSION,
  TESTBENCH_REPAIR_POLICY_VERSION,
  type ModelTask,
} from '@app/agent';

import { RTLLM_PINNED_COMMIT } from '../corpus/pinned-source.js';
import {
  RTLLM_SCORED_DESIGN_COUNT,
  STAGE0_QUARANTINE,
  type Stage0QuarantineEntry,
} from '../corpus/stage0-quarantine.js';
import type { ReproducibilityConfig } from '../reproducibility.js';
import { armCostIsKnown, isSingleModel, modelSignatureOf, type SweepConfig } from './config.js';

/** The manifest filename inside a run's output directory. */
export const MANIFEST_FILENAME = 'manifest.json';

/** The manifest schema version, bumped only when a field's meaning changes. */
export const MANIFEST_SCHEMA_VERSION = 1;

/** One arm as the manifest records it: the exact models, and whether cost is real. */
export interface ManifestArm {
  readonly name: string;
  readonly roleModels: Readonly<Record<ModelTask, string>>;
  /** Stable rendering of the models; matches `modelSignature` on every record. */
  readonly modelSignature: string;
  /** True when one model id serves every role. */
  readonly singleModel: boolean;
  /** True only when every model this arm uses has a configured price. */
  readonly costKnown: boolean;
}

/** One quarantine exclusion, as recorded so a reader sees what was dropped and why. */
export interface ManifestExclusion {
  readonly problemId: string;
  readonly code: string;
  readonly reason: string;
}

/** The corpus provenance: what was measured, at which commit, minus what. */
export interface ManifestCorpus {
  readonly pinnedCommit: string;
  /** Designs whose reference passes its own golden testbench under this toolchain. */
  readonly scoredDesignCount: number;
  /** The problem ids this run actually selected, in run order. */
  readonly selectedProblemIds: readonly string[];
  readonly quarantined: readonly ManifestExclusion[];
}

/** The EDA toolchain that decided every verdict in this run. */
export interface ManifestToolchain {
  /** `iverilog -V` first line, or null when it could not be read. */
  readonly iverilogVersion: string | null;
  /** `vvp -V` first line, or null when it could not be read. */
  readonly vvpVersion: string | null;
  /** The interpreter that ran the sandbox worker, as a bare name (never a full path). */
  readonly workerPython: string | null;
}

/** The host, described only as far as reproducibility requires. */
export interface ManifestHost {
  readonly platform: string;
  readonly arch: string;
  readonly release: string;
  readonly runtimeVersion: string;
}

/** The harness code that produced the run. */
export interface ManifestHarness {
  /** The git commit, or null when it could not be read. */
  readonly commit: string | null;
  /**
   * Whether the working tree had uncommitted changes; null when git could not be read.
   *
   * `true` means the recorded commit does NOT describe the code that ran, so the run is
   * not reproducible from it. Recorded honestly and surfaced in the summary.
   */
  readonly workingTreeDirty: boolean | null;
}

/** The facts the composition root probes from the host and injects here. */
export interface ManifestFacts {
  readonly toolchain: ManifestToolchain;
  readonly host: ManifestHost;
  readonly harness: ManifestHarness;
  /** ISO-8601 instant the run started. */
  readonly startedAt: string;
}

/** One run's complete manifest. */
export interface SweepManifest {
  readonly schemaVersion: number;
  readonly runName: string;
  /** The identity every persisted record is keyed by. */
  readonly configHash: string;
  /** The config verbatim, so the manifest is self-contained. */
  readonly config: SweepConfig;
  readonly arms: readonly ManifestArm[];
  readonly corpus: ManifestCorpus;
  /**
   * The Testbench_Agent prompt version that generated every sample in this run.
   *
   * Read directly from `TESTBENCH_PROMPT_VERSION`, the same way `corpus.pinnedCommit` is
   * read directly from the pinned corpus constant rather than threaded through `facts`: a
   * manifest must not be able to claim a prompt version the run did not actually use.
   */
  readonly testbenchPromptVersion: number;
  /**
   * The Verification_Loop's instrument-admission policy version that ran for every sample
   * in this run.
   *
   * Read directly from `INSTRUMENT_POLICY_VERSION`, the same way `testbenchPromptVersion`
   * is read directly from its own constant: a manifest must not be able to claim a policy
   * the run did not actually use.
   */
  readonly instrumentPolicyVersion: number;
  /**
   * The testbench-repair-loop's repair-attempt policy version that ran for every sample
   * in this run.
   *
   * Read directly from `TESTBENCH_REPAIR_POLICY_VERSION`, the same way
   * `instrumentPolicyVersion` is read directly from its own constant: a manifest must not
   * be able to claim a policy the run did not actually use.
   */
  readonly testbenchRepairPolicyVersion: number;
  /**
   * The Dialect_Normalizer's transform version that ran for every sample in this run.
   *
   * Read directly from `NORMALIZER_VERSION`, the same way `testbenchRepairPolicyVersion`
   * is read directly from its own constant: a manifest must not be able to claim a
   * transform the run did not use.
   */
  readonly normalizerVersion: number;
  readonly reproducibility: ReproducibilityConfig;
  readonly toolchain: ManifestToolchain;
  readonly host: ManifestHost;
  readonly harness: ManifestHarness;
  readonly startedAt: string;
  /** ISO-8601 instant the run stopped, or null while it is still running. */
  readonly finishedAt: string | null;
  /** Why the run stopped, or null while it is still running. */
  readonly stopReason: string | null;
}

/** Render one reviewed Stage 0 exclusion into the manifest's flat shape. */
function toExclusion(entry: Stage0QuarantineEntry): ManifestExclusion {
  return { problemId: entry.problemId, code: entry.code, reason: entry.reason };
}

/** Every arm in manifest form, in declaration order (pure; every field derived). */
function toManifestArms(config: SweepConfig): readonly ManifestArm[] {
  return config.arms.map((arm) => ({
    name: arm.name,
    roleModels: arm.roleModels,
    modelSignature: modelSignatureOf(arm, MODEL_TASKS),
    singleModel: isSingleModel(arm),
    costKnown: armCostIsKnown(arm, MODEL_TASKS, config.prices),
  }));
}

/** The inputs manifest assembly needs, grouped so the call stays a single parameter. */
export interface ManifestInput {
  readonly config: SweepConfig;
  readonly configHash: string;
  /** The problem ids this run selected, already resolved against the scored corpus. */
  readonly selectedProblemIds: readonly string[];
  readonly facts: ManifestFacts;
}

/**
 * Assemble the run manifest (pure).
 *
 * The corpus commit, the scored size, and the quarantine list are read from the pinned
 * corpus constants rather than passed in, so a manifest cannot claim a different corpus
 * than the code will actually import. Everything host-dependent arrives through
 * `facts`, so this function has no clock, no filesystem, and no child processes.
 */
export function assembleManifest(input: ManifestInput): SweepManifest {
  const { config, facts } = input;
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    runName: config.runName,
    configHash: input.configHash,
    config,
    arms: toManifestArms(config),
    corpus: {
      pinnedCommit: RTLLM_PINNED_COMMIT,
      scoredDesignCount: RTLLM_SCORED_DESIGN_COUNT,
      selectedProblemIds: input.selectedProblemIds,
      quarantined: STAGE0_QUARANTINE.map(toExclusion),
    },
    testbenchPromptVersion: TESTBENCH_PROMPT_VERSION,
    instrumentPolicyVersion: INSTRUMENT_POLICY_VERSION,
    testbenchRepairPolicyVersion: TESTBENCH_REPAIR_POLICY_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
    reproducibility: config.reproducibility,
    toolchain: facts.toolchain,
    host: facts.host,
    harness: facts.harness,
    startedAt: facts.startedAt,
    finishedAt: null,
    stopReason: null,
  };
}

/** The manifest with its ending recorded; written again when the run stops. */
export function finalizeManifest(
  manifest: SweepManifest,
  finishedAt: string,
  stopReason: string,
): SweepManifest {
  return { ...manifest, finishedAt, stopReason };
}
