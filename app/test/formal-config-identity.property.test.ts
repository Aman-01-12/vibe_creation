// formal-property-oracle, Property 27: The formal oracle's version is part of the experiment's
// identity (task 12.7).
//
// WHAT IS CLAIMED, OVER WHAT
//   For any sweep config: the canonical form carries `FORMAL_ORACLE_VERSION` under its own reserved
//   `__formalOracleVersion` key with the build constant's value (Req 12.2), the manifest records
//   that same value (Req 12.5), and two identities differing only in that version hash differently
//   (Req 12.3). The configs are drawn as raw on-disk JSON and admitted through the real
//   `parseSweepConfig`, so each one is a config a campaign could actually run rather than an object
//   that skipped the boundary, and the claim is asserted over that space instead of over the one
//   fixture the sibling version properties in `app/eval/sweep/manifest.test.ts` vary a seed of.
//
// THE SEAM FOR "DIFFERING ONLY IN THAT VERSION", AND WHY IT IS HONEST
//   The version is a BUILD constant, not a config field: `sweepConfigHash` reads it from the import
//   and takes no version parameter, and that unchanged signature is itself Req 12.4. So no two
//   configs can differ in it, and no test may add a parameter to make them. What CAN differ is the
//   identity a build carrying another value would compute, and this file builds exactly that from
//   the production pieces, contributing nothing of its own except the one value:
//     - the canonical text is the one `sweepConfigHash` itself produced, received through the
//       injected `DigestHex` the module already exposes in order to stay pure;
//     - the one edit is that reserved value, made by re-serializing the parsed text, and it is
//       REFUSED unless the key is present and holds the running build's constant, so a version-only
//       difference can never be manufactured by ADDING a key the identity lacks;
//     - the same edit at the running build's own value is asserted to reproduce the production
//       canonical text BYTE FOR BYTE, and with it the production hash, so the re-serialization is
//       shown to be the identity map rather than assumed to be one - over model ids JSON has to
//       escape and integer-like price keys JavaScript reorders, the two shapes likeliest to break it;
//     - both hashes are `sweepConfigHash`'s own output, truncation included, over the SHA-256
//       digest the sweep CLI injects.
//
// ponytail: the seam proves the fold-in carries the RUNNING value and that a change to that value
//   moves the hash. It cannot prove that a DIFFERENT build value would reach the identity, because a
//   build holds exactly one: a fold-in or a manifest field wired to another constant that happens to
//   equal this one today - `INSTRUMENT_POLICY_VERSION` is also 1 - passes here, and fails here the
//   moment either constant is bumped. The upgrade path is re-importing the identity under a module
//   mock of `@app/agent`, a pattern this repository has never used; a version parameter is not one,
//   because Req 12.4 forbids it.
//
// OUT OF SCOPE
//   `__formalGateEnabled`, the sixth reserved key, is task 8.8's and not this property's. The
//   generator varies `formalGateEnabled` only so the claim is shown to hold with the gate on and
//   off, and the hash-difference test asserts that both settings were drawn.
//
// Run `npx tsc -b` FIRST: this file reads the identity through `@app/eval` and the constant through
// `@app/agent`, and both resolve to `dist/`, so an unbuilt change is invisible here
// (`chipAgent/_inbox/gotcha-a-build-constant-bump-is-invisible-to-vitest-until-tsc-b-rebuilds-dist.md`).
//
// The tag string is a literal, not `propertyTag(...)`, whose `FEATURE_TAG` is hardcoded to a
// different spec's property numbering
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// **Validates: Requirements 12.2, 12.3, 12.5**

import { createHash } from 'node:crypto';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { FORMAL_ORACLE_VERSION, MODEL_TASKS } from '@app/agent';
import {
  assembleManifest,
  canonicalSweepConfigJson,
  MAX_MUTANT_WALL_MS,
  MAX_MUTANTS_PER_PROBLEM_LIMIT,
  MIN_MUTANT_WALL_MS,
  parseSweepConfig,
  RTLLM_CATEGORY_DIRECTORIES,
  SWEEP_CONFIG_BOUNDS,
  SWEEP_CONFIG_SCHEMA_VERSION,
  sweepConfigHash,
  type ManifestFacts,
  type SweepConfig,
} from '@app/eval';

import { propertyParameters } from './property.js';

// **Feature: formal-property-oracle, Property 27: The formal oracle's version is part of the
// experiment's identity**
const PROPERTY =
  "formal-property-oracle, Property 27: The formal oracle's version is part of the experiment's identity";

/** The reserved canonical key design.md (Component 11) names for the Formal_Oracle_Version. */
const FORMAL_ORACLE_VERSION_KEY = '__formalOracleVersion';

/** The problems a manifest says the run selected; not under test, so one fixed list serves. */
const SELECTED_PROBLEM_IDS: readonly string[] = ['rtllm/arithmetic/adder_8bit'];

/** Every Formal_Toolchain entry, for a test that spawns nothing. */
const NOT_PROBED = { kind: 'not-measured', reason: 'this test probes no host' } as const;

/** The probed host facts a manifest embeds; injected and not under test, so one value serves. */
const FACTS: ManifestFacts = {
  toolchain: {
    iverilogVersion: null,
    vvpVersion: null,
    workerPython: null,
    yosysVersion: NOT_PROBED,
    yosysBuildId: NOT_PROBED,
    yosysSmtBmcVersion: NOT_PROBED,
    bitwuzlaVersion: NOT_PROBED,
    z3Version: NOT_PROBED,
  },
  host: { platform: 'darwin', arch: 'arm64', release: '24.0.0', runtimeVersion: 'v20.19.0' },
  harness: { commit: null, workingTreeDirty: null },
  startedAt: '2024-06-01T00:00:00.000Z',
};

/**
 * A model id the boundary accepts. Mixes realistic ids with ids JSON has to escape (any grapheme,
 * so quotes, backslashes, controls, and non-ASCII) and integer-like ids, which JavaScript orders
 * ahead of every other key once they key `prices` - the shapes the byte-for-byte assertion below
 * has to survive for the re-serialization to count as the identity map.
 */
const arbModelId: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('zai.glm-5', 'deepseek.v3.2', 'moonshotai.kimi-k2.5'),
  fc.string({ unit: 'grapheme', minLength: 1, maxLength: 8 }).filter((id) => id.trim() !== ''),
  fc.nat({ max: 99 }).map(String),
);

/** A run or arm name inside `SWEEP_NAME_PATTERN`, bounded well under the name cap. */
const arbName: fc.Arbitrary<string> = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/);

/** Either declaration an arm may make: one model for every role, or a complete per-role map. */
const arbArmModels: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
  arbModelId.map((model) => ({ model })),
  fc
    .record(Object.fromEntries(MODEL_TASKS.map((task) => [task, arbModelId])))
    .map((roleModels) => ({ roleModels })),
);

/** One to three arms; the names are unique because a duplicate name is a config error. */
const arbArms = fc
  .uniqueArray(fc.tuple(arbName, arbArmModels), {
    minLength: 1,
    maxLength: 3,
    selector: ([name]) => name,
  })
  .map((arms) => arms.map(([name, models]) => ({ name, ...models })));

/** Every problem-selection kind: the whole corpus, explicit ids, or categories. */
const arbProblems: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
  fc.constant({ kind: 'all' }),
  fc
    .uniqueArray(fc.stringMatching(/^rtllm\/[a-z]{1,8}\/[a-z0-9_]{1,12}$/), {
      minLength: 1,
      maxLength: 4,
    })
    .map((ids) => ({ kind: 'ids', ids })),
  fc
    .subarray([...RTLLM_CATEGORY_DIRECTORIES], { minLength: 1 })
    .map((categories) => ({ kind: 'categories', categories })),
);

/** `sampleCount` with a non-empty `ks` inside `[1, sampleCount]`, so no draw is refused for it. */
const arbSampling = fc
  .tuple(
    fc.uniqueArray(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 3 }),
    fc.nat({ max: 10 }),
  )
  .map(([ks, headroom]) => ({ ks, sampleCount: Math.max(...ks) + headroom }));

/** The student-session caps, each inside the range the boundary accepts. */
const arbCaps = fc.record({
  maxIterations: fc.integer({ min: 1, max: 1_000 }),
  maxTokens: fc.integer({ min: 1, max: 1_000_000 }),
  maxWallClockMs: fc.integer({ min: 1, max: 3_600_000 }),
  maxCostCents: fc.double({ min: 0, max: 10_000, noNaN: true }),
});

/** The sandbox resource limits, each inside the range the boundary accepts. */
const arbLimits = fc.record({
  cpu: fc.double({ min: 0.1, max: 16, noNaN: true }),
  memMb: fc.integer({ min: 16, max: 16_384 }),
  procs: fc.integer({ min: 1, max: 4_096 }),
  diskMb: fc.integer({ min: 1, max: 16_384 }),
  wallMs: fc.integer({ min: 1_000, max: 3_600_000 }),
});

/** The model host, with both optional fields drawn present and absent. */
const arbModelHost = fc.record(
  {
    region: fc.constantFrom('us-east-1', 'us-west-2', 'eu-central-1'),
    maxOutputTokens: fc.integer({ min: 1, max: 200_000 }),
    requestTimeoutMs: fc.integer({ min: 1_000, max: 3_600_000 }),
  },
  { requiredKeys: ['region'] },
);

/** A price table keyed by model id, possibly empty. */
const arbPrices = fc
  .uniqueArray(
    fc.tuple(
      arbModelId,
      fc.record({
        inputCentsPerMillionTokens: fc.double({ min: 0, max: 1_000, noNaN: true }),
        outputCentsPerMillionTokens: fc.double({ min: 0, max: 1_000, noNaN: true }),
      }),
    ),
    { maxLength: 3, selector: ([id]) => id },
  )
  .map((entries) => Object.fromEntries(entries));

/** The negative-control block, every field defaulted and so drawn present and absent. */
const arbNegativeControl = fc.record(
  {
    enabled: fc.boolean(),
    maxMutantsPerProblem: fc.integer({ min: 1, max: MAX_MUTANTS_PER_PROBLEM_LIMIT }),
    mutantWallMs: fc.integer({ min: MIN_MUTANT_WALL_MS, max: MAX_MUTANT_WALL_MS }),
  },
  { requiredKeys: [] },
);

/**
 * A raw on-disk sweep config, varied across the sections a campaign author edits, with every
 * defaulted field - `formalGateEnabled` and `captureArtifacts` among them - drawn both present and
 * absent, so the identity is exercised over the defaults as well as over explicit values.
 */
const arbRawConfig: fc.Arbitrary<Record<string, unknown>> = fc
  .record(
    {
      runName: arbName,
      arms: arbArms,
      problems: arbProblems,
      sampling: arbSampling,
      seed: fc.integer({ min: 0, max: 0xffffffff }),
      temperature: fc.double({ min: 0, max: 2, noNaN: true }),
      caps: arbCaps,
      limits: arbLimits,
      costEnvelopeCents: fc.double({ min: 0, max: 10_000, noNaN: true }),
      modelHost: arbModelHost,
      prices: arbPrices,
      outputDir: fc.stringMatching(/^[A-Za-z0-9_-]{1,16}$/).map((dir) => `.eval-runs/${dir}`),
      captureArtifacts: fc.boolean(),
      negativeControl: arbNegativeControl,
      formalGateEnabled: fc.boolean(),
      concurrency: fc.integer({ min: 1, max: SWEEP_CONFIG_BOUNDS.maxConcurrency }),
    },
    {
      requiredKeys: [
        'runName',
        'arms',
        'problems',
        'sampling',
        'seed',
        'temperature',
        'caps',
        'limits',
        'costEnvelopeCents',
        'modelHost',
        'outputDir',
      ],
    },
  )
  .map(({ sampling, ...fields }) => ({
    schemaVersion: SWEEP_CONFIG_SCHEMA_VERSION,
    ...fields,
    ...sampling,
  }));

/** Admit a raw draw through the real boundary; a refusal means the generator drifted, so it is loud. */
function admitted(raw: Record<string, unknown>): SweepConfig {
  const parsed = parseSweepConfig(raw);
  if (!parsed.ok) {
    throw new Error(
      `the generator drew a config the boundary refuses at ${parsed.error.field}: ${parsed.error.message}`,
    );
  }
  return parsed.value;
}

/** Any sweep config a campaign could run, exactly as `parseSweepConfig` admits it. */
const arbSweepConfig: fc.Arbitrary<SweepConfig> = arbRawConfig.map(admitted);

/** A Formal_Oracle_Version another build could carry: any positive integer but this build's. */
const arbOtherVersion: fc.Arbitrary<number> = fc
  .integer({ min: 1, max: 1_000 })
  .filter((version) => version !== FORMAL_ORACLE_VERSION);

/** Lowercase hex SHA-256, the digest the sweep CLI injects into `sweepConfigHash`. */
function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The config's identity as the production canonical text spells it, parsed back to its fields. */
function canonicalFieldsOf(config: SweepConfig): Record<string, unknown> {
  return JSON.parse(canonicalSweepConfigJson(config)) as Record<string, unknown>;
}

/**
 * The canonical text a build carrying `version` would produce, given the text THIS build produced:
 * the same text with that one reserved value replaced and nothing else touched.
 *
 * Refuses unless the key is present and holds the running build's constant, so a version-only
 * difference can never be manufactured by ADDING a key the identity lacks - which would let the
 * hash-difference clause pass over an identity that never carried the version at all.
 */
function canonicalTextUnderVersion(canonicalText: string, version: number): string {
  const fields = JSON.parse(canonicalText) as Record<string, unknown>;
  if (fields[FORMAL_ORACLE_VERSION_KEY] !== FORMAL_ORACLE_VERSION) {
    throw new Error(
      `the canonical form does not carry ${FORMAL_ORACLE_VERSION_KEY}: ${FORMAL_ORACLE_VERSION}, so there is no version-only difference to build`,
    );
  }
  return JSON.stringify({ ...fields, [FORMAL_ORACLE_VERSION_KEY]: version });
}

/**
 * `sweepConfigHash` as a build carrying `version` would compute it: the production function,
 * truncation included, digesting the canonical text it built itself with only that value replaced.
 */
function hashUnderVersion(config: SweepConfig, version: number): string {
  return sweepConfigHash(config, (canonicalText) =>
    sha256Hex(canonicalTextUnderVersion(canonicalText, version)),
  );
}

describe(PROPERTY, () => {
  it('carries the running FORMAL_ORACLE_VERSION under its own reserved key, for any config', () => {
    fc.assert(
      fc.property(arbSweepConfig, (config) => {
        // GIVEN any config a campaign could run, WHEN its identity is canonicalized, THEN the
        // reserved key holds the build constant's value (Req 12.2) ...
        expect(canonicalFieldsOf(config)[FORMAL_ORACLE_VERSION_KEY]).toBe(FORMAL_ORACLE_VERSION);
        // ... and the key belongs to the identity rather than to the config: no admitted config
        // carries it, so the value can only have come from the build constant.
        expect(Object.keys(config)).not.toContain(FORMAL_ORACLE_VERSION_KEY);
      }),
      propertyParameters(),
    );
  });

  it('records in the manifest the same version the identity carries, for any config', () => {
    fc.assert(
      fc.property(arbSweepConfig, (config) => {
        // GIVEN any config and the hash the sweep CLI computes for it, WHEN its manifest is
        // assembled, THEN the recorded version is the identity's own (Req 12.5) ...
        const manifest = assembleManifest({
          config,
          configHash: sweepConfigHash(config, sha256Hex),
          selectedProblemIds: SELECTED_PROBLEM_IDS,
          campaignPass: null,
          facts: FACTS,
        });
        expect(manifest.formalOracleVersion).toBe(FORMAL_ORACLE_VERSION);
        expect(manifest.formalOracleVersion).toBe(
          canonicalFieldsOf(config)[FORMAL_ORACLE_VERSION_KEY],
        );
        // ... and it is the version the recorded hash was computed under, so the manifest and the
        // hash that scopes a resume cannot describe two different gates for one run.
        expect(hashUnderVersion(config, manifest.formalOracleVersion)).toBe(manifest.configHash);
      }),
      propertyParameters(),
    );
  });

  it('hashes two identities differing only in that version differently, for any config', () => {
    const gateSettingsDrawn = new Set<boolean>();
    fc.assert(
      fc.property(arbSweepConfig, arbOtherVersion, (config, otherVersion) => {
        gateSettingsDrawn.add(config.formalGateEnabled);
        const canonicalText = canonicalSweepConfigJson(config);
        const productionHash = sweepConfigHash(config, sha256Hex);
        // GIVEN the re-serialization at this build's own version is the identity map, byte for
        // byte, and therefore reproduces the production hash ...
        expect(canonicalTextUnderVersion(canonicalText, FORMAL_ORACLE_VERSION)).toBe(canonicalText);
        expect(hashUnderVersion(config, FORMAL_ORACLE_VERSION)).toBe(productionHash);
        // ... WHEN only the version differs, THEN the hash differs (Req 12.3).
        expect(hashUnderVersion(config, otherVersion)).not.toBe(productionHash);
      }),
      propertyParameters(),
    );
    // Non-vacuity: the claim was exercised with the Formal_Gate both on and off.
    expect(gateSettingsDrawn).toEqual(new Set([false, true]));
  });
});
