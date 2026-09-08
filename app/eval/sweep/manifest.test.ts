// Unit tests for manifest assembly and the config identity that scopes a resume.
//
// The manifest is what turns a number into a citable one, so these tests pin down that it
// carries the pinned corpus commit, the applied exclusions, the exact per-role model ids,
// the probed tool versions, and - the honesty field - the dirty working tree, recorded as
// given rather than smoothed over.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { RTLLM_PINNED_COMMIT } from '../corpus/pinned-source.js';
import {
  RTLLM_SCORED_DESIGN_COUNT,
  STAGE0_QUARANTINED_PROBLEM_IDS,
} from '../corpus/stage0-quarantine.js';
import { canonicalSweepConfigJson, sweepConfigHash } from './config-identity.js';
import { parseSweepConfig } from './config-parse.js';
import type { SweepConfig } from './config.js';
import { assembleManifest, finalizeManifest, type ManifestFacts } from './manifest.js';

/**
 * The config hash the committed smoke config currently produces.
 *
 * Pinned so a config change that would orphan already-paid-for samples fails a test instead of
 * quietly re-running them.
 *
 * It has MOVED three times, deliberately every time, because `negativeControl` can change
 * instrument validity and instrument validity decides the pass@k denominator - so two settings of
 * it are two experiments and must not pool samples:
 *   - when the mutation-based negative control shipped, adding the block at all;
 *   - when the default kill-rate threshold went 1 -> 0.95 alongside the mutant denominator
 *     changing from "the mutants the golden testbench kills" to "every mutant that compiles". A
 *     sample admitted under the old rule was scored against a smaller, judge-shaped set, so
 *     pooling it with a new one would average two different measurements.
 *   - when the kill-rate threshold was RETIRED from the validity decision in favour of the
 *     zero-coverage-gap gate, and `minKillRate` left the config entirely. The field can no longer
 *     move a measured number, so keeping it in the identity would be wrong - and removing it
 *     changes the canonical JSON, so the pin moves with it.
 *   - when `negativeControl.mutantWallMs` was added. It decides how long ONE mutant run may take,
 *     which decides which mutants classify as hanging, which decides which mutants are golden
 *     KILLS, which is the GATE set, which decides instrument validity - and instrument validity
 *     decides the pass@k denominator. So two caps are two experiments, exactly like two mutant
 *     budgets.
 * Nothing was orphaned in any case - the results schema bump had already refused every
 * pre-existing smoke record for the same reason.
 */
const SMOKE_RUN_CONFIG_HASH = '552626a05719c93c';

/** Lowercase hex SHA-256, the digest the CLI injects. */
function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A valid on-disk config, parsed so the tests operate on the real validated shape. */
function config(overrides: Record<string, unknown> = {}): SweepConfig {
  const parsed = parseSweepConfig({
    schemaVersion: 1,
    runName: 'bakeoff-v1',
    arms: [
      { name: 'glm-5', model: 'zai.glm-5' },
      {
        name: 'mixed',
        roleModels: {
          generation: 'zai.glm-5',
          repair: 'deepseek.v3.2',
          orchestration: 'zai.glm-5',
          teaching: 'zai.glm-5',
          'hard-planning': 'zai.glm-5',
        },
      },
    ],
    problems: { kind: 'all' },
    sampleCount: 5,
    ks: [1, 5],
    seed: 42,
    temperature: 0,
    caps: { maxIterations: 12, maxTokens: 1_000, maxWallClockMs: 1_000, maxCostCents: 100 },
    limits: { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 },
    costEnvelopeCents: 25,
    modelHost: { region: 'us-east-1' },
    outputDir: '.eval-runs/bakeoff-v1',
    prices: { 'zai.glm-5': { inputCentsPerMillionTokens: 60, outputCentsPerMillionTokens: 220 } },
    ...overrides,
  });
  if (!parsed.ok) {
    throw new Error(`fixture config is invalid: ${parsed.error.message}`);
  }
  return parsed.value;
}

/** Probed host facts; every one injected so the test needs no host. */
function facts(overrides: Partial<ManifestFacts> = {}): ManifestFacts {
  return {
    toolchain: {
      iverilogVersion: 'Icarus Verilog version 13.0 (devel)',
      vvpVersion: 'Icarus Verilog runtime version 13.0 (devel)',
      workerPython: 'python',
    },
    host: { platform: 'darwin', arch: 'arm64', release: '24.0.0', runtimeVersion: 'v20.19.0' },
    harness: { commit: 'a'.repeat(40), workingTreeDirty: false },
    startedAt: '2024-06-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Assemble a manifest over the fixture inputs. */
function manifest(overrides: { readonly facts?: ManifestFacts } = {}) {
  return assembleManifest({
    config: config(),
    configHash: 'deadbeefdeadbeef',
    selectedProblemIds: ['rtllm/arithmetic/adder_8bit', 'rtllm/control/counter'],
    facts: overrides.facts ?? facts(),
  });
}

describe('assembleManifest - corpus provenance', () => {
  it('cites the pinned RTLLM commit rather than whatever happens to be checked out', () => {
    expect(manifest().corpus.pinnedCommit).toBe(RTLLM_PINNED_COMMIT);
  });

  it('records the scored corpus size, the honest denominator for pass@k', () => {
    expect(manifest().corpus.scoredDesignCount).toBe(RTLLM_SCORED_DESIGN_COUNT);
  });

  it('records every quarantine exclusion with its reason, so nothing is silently dropped', () => {
    const ids = manifest().corpus.quarantined.map((entry) => entry.problemId);
    expect(ids).toEqual([...STAGE0_QUARANTINED_PROBLEM_IDS]);
    for (const entry of manifest().corpus.quarantined) {
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(entry.code.length).toBeGreaterThan(0);
    }
  });

  it('records the problems actually selected, in run order', () => {
    expect(manifest().corpus.selectedProblemIds).toEqual([
      'rtllm/arithmetic/adder_8bit',
      'rtllm/control/counter',
    ]);
  });
});

describe('assembleManifest - arm attribution', () => {
  it('records the exact model id for every role of every arm', () => {
    const arms = manifest().arms;
    expect(arms.map((arm) => arm.name)).toEqual(['glm-5', 'mixed']);
    expect(arms[1]?.roleModels.repair).toBe('deepseek.v3.2');
    expect(arms[1]?.roleModels.generation).toBe('zai.glm-5');
  });

  it('marks a single-model arm as such and a per-role arm as not', () => {
    expect(manifest().arms[0]?.singleModel).toBe(true);
    expect(manifest().arms[1]?.singleModel).toBe(false);
  });

  it('records cost as known only for an arm whose every model is priced', () => {
    expect(manifest().arms[0]?.costKnown).toBe(true);
    expect(manifest().arms[1]?.costKnown).toBe(false);
  });
});

describe('assembleManifest - reproducibility and toolchain', () => {
  it('embeds the seed, temperature, and sample count that produced the numbers', () => {
    expect(manifest().reproducibility).toEqual({ seed: 42, temperature: 0, sampleCount: 5 });
  });

  it('records the probed EDA tool versions rather than an assumed one', () => {
    expect(manifest().toolchain.iverilogVersion).toContain('Icarus Verilog version 13.0');
    expect(manifest().toolchain.vvpVersion).toContain('runtime version');
  });

  it('records unknown tool versions as null, never as a default string', () => {
    const unknown = manifest({
      facts: facts({ toolchain: { iverilogVersion: null, vvpVersion: null, workerPython: null } }),
    });
    expect(unknown.toolchain.iverilogVersion).toBeNull();
    expect(unknown.toolchain.vvpVersion).toBeNull();
  });

  it('describes the host without naming the machine', () => {
    const host = manifest().host;
    expect(host.platform).toBe('darwin');
    expect(Object.keys(host).sort()).toEqual(['arch', 'platform', 'release', 'runtimeVersion']);
  });
});

describe('assembleManifest - the dirty-tree honesty field', () => {
  it('records a clean tree as clean', () => {
    expect(manifest().harness.workingTreeDirty).toBe(false);
  });

  it('records a DIRTY tree as dirty, alongside the commit that does not describe it', () => {
    const dirty = manifest({
      facts: facts({ harness: { commit: 'b'.repeat(40), workingTreeDirty: true } }),
    });
    expect(dirty.harness.workingTreeDirty).toBe(true);
    expect(dirty.harness.commit).toBe('b'.repeat(40));
  });

  it('records an unreadable git state as unknown, never as clean', () => {
    const unknown = manifest({
      facts: facts({ harness: { commit: null, workingTreeDirty: null } }),
    });
    expect(unknown.harness.workingTreeDirty).toBeNull();
  });
});

describe('assembleManifest - lifecycle', () => {
  it('starts with no ending recorded', () => {
    expect(manifest().finishedAt).toBeNull();
    expect(manifest().stopReason).toBeNull();
  });

  it('records the ending and the stop reason when finalized', () => {
    const finished = finalizeManifest(manifest(), '2024-06-01T08:00:00.000Z', 'completed');
    expect(finished.finishedAt).toBe('2024-06-01T08:00:00.000Z');
    expect(finished.stopReason).toBe('completed');
    expect(finished.startedAt).toBe('2024-06-01T00:00:00.000Z');
  });

  it('carries no credential anywhere in the serialized manifest', () => {
    const text = JSON.stringify(manifest()).toLowerCase();
    // The config has no field that can hold a credential, and the manifest embeds the
    // config verbatim, so these are the markers that would appear if one ever leaked in.
    expect(text).not.toContain('bearer');
    expect(text).not.toContain('authorization');
    expect(text).not.toContain('aws_bearer_token_bedrock');
    expect(text).not.toContain('secret');
  });
});

describe('the config identity that scopes a resume', () => {
  const digest = (text: string): string =>
    // A deterministic non-cryptographic stand-in: the real digest is injected, and this
    // test is about the canonical form and the sensitivity, not about SHA-256.
    [...text]
      .reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 0xffffffff, 7)
      .toString(16)
      .padStart(20, '0');

  it('is stable across key ordering, so the same experiment always resumes', () => {
    const left = canonicalSweepConfigJson(config());
    const right = canonicalSweepConfigJson({ ...config() });
    expect(left).toBe(right);
  });

  it('changes when the seed changes, so a different experiment cannot reuse samples', () => {
    expect(sweepConfigHash(config(), digest)).not.toBe(
      sweepConfigHash(config({ seed: 43 }), digest),
    );
  });

  it('changes when an arm model changes', () => {
    expect(sweepConfigHash(config(), digest)).not.toBe(
      sweepConfigHash(config({ arms: [{ name: 'glm-5', model: 'zai.glm-4.7' }] }), digest),
    );
  });

  it('changes when the student caps change, because the caps change the experiment', () => {
    const looser = config({
      caps: { maxIterations: 24, maxTokens: 1_000, maxWallClockMs: 1_000, maxCostCents: 100 },
    });
    expect(sweepConfigHash(config(), digest)).not.toBe(sweepConfigHash(looser, digest));
  });

  it('is unchanged for an identical config, so a resume finds its own samples', () => {
    expect(sweepConfigHash(config(), digest)).toBe(sweepConfigHash(config(), digest));
  });

  it('is UNCHANGED by artifact capture, because it measures nothing', () => {
    // Deliberate exclusion. Capture writes diagnostic files beside the results; it moves no
    // seed, no cap, no model, and no verdict, so a sample recorded with it off is equally
    // valid with it on. Including it would have made every already-recorded sample invisible
    // to the resume index the moment the option shipped, forcing a re-pay for measurements
    // that are still exactly right.
    const off = config({ captureArtifacts: false });
    const on = config({ captureArtifacts: true });
    expect(on.captureArtifacts).not.toBe(off.captureArtifacts);
    expect(sweepConfigHash(on, digest)).toBe(sweepConfigHash(off, digest));
    expect(canonicalSweepConfigJson(on)).not.toContain('captureArtifacts');
  });

  it('CHANGES when the negative-control settings change, because that is a different experiment', () => {
    // The mirror image of the `captureArtifacts` exclusion above. These CAN move a measured
    // number: instrument validity decides the pass@k denominator, so a run over 24 mutants and a
    // run over 8 are answering different questions and their samples must never pool. Being
    // conservative here costs a re-run; being wrong here blends two experiments into one number
    // with nothing in the report to show it.
    const wide = config();
    const narrow = config({ negativeControl: { maxMutantsPerProblem: 8 } });
    const off = config({ negativeControl: { enabled: false } });

    expect(sweepConfigHash(wide, digest)).not.toBe(sweepConfigHash(narrow, digest));
    // Turning it off makes `valid` mean something weaker, which is also a different experiment.
    expect(sweepConfigHash(wide, digest)).not.toBe(sweepConfigHash(off, digest));
    expect(canonicalSweepConfigJson(wide)).toContain('negativeControl');
    // And the RETIRED threshold is gone from the identity entirely, because it can no longer
    // move a measured number: the gate is zero coverage-gap survivors, not a rate.
    expect(canonicalSweepConfigJson(wide)).not.toContain('minKillRate');
  });

  it('CHANGES when the MUTANT WALL CAP changes, because that changes which mutants hang', () => {
    // GIVEN two configs differing only in the per-mutant wall cap.
    const tight = config({ negativeControl: { mutantWallMs: 5_000 } });
    const loose = config({ negativeControl: { mutantWallMs: 20_000 } });

    // THEN they are two experiments. The chain is short and every link moves a number: the cap
    // decides which mutants classify as hanging -> a hanging mutant is a golden KILL -> golden
    // kills are the GATE set -> the gate decides instrument validity -> validity decides the
    // pass@k denominator. Pooling their samples would average two different measurements.
    expect(sweepConfigHash(tight, digest)).not.toBe(sweepConfigHash(loose, digest));
    expect(canonicalSweepConfigJson(tight)).toContain('mutantWallMs');
  });

  it('still matches the committed smoke config, so its recorded samples stay resumable', async () => {
    // A regression guard with real stakes: a results file's records are keyed by this exact
    // hash. If a config change ever alters it, those records go invisible and the run silently
    // re-pays for them - so the pin must be updated deliberately, with a reason, never
    // incidentally.
    const here = dirname(fileURLToPath(import.meta.url));
    const raw: unknown = JSON.parse(
      await readFile(resolve(here, 'sweep.config.smoke.json'), 'utf8'),
    );
    const parsed = parseSweepConfig(raw);
    if (!parsed.ok) {
      throw new Error(`the committed smoke config is invalid: ${parsed.error.message}`);
    }
    expect(sweepConfigHash(parsed.value, sha256Hex)).toBe(SMOKE_RUN_CONFIG_HASH);
  });
});
