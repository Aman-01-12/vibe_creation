// Criterion 8.8 in total form: whatever the Formal_Toolchain probe read, the manifest this build
// writes records a schema version no pre-formal manifest records, read from the written file alone.
// See design.md, C16. The tag is a literal because `propertyTag` here hardcodes another spec's slug.
//
// **Validates: Requirements 8.8**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  assembleManifest,
  finalizeManifest,
  parseSweepConfig,
  SWEEP_CONFIG_SCHEMA_VERSION,
  type ManifestToolchain,
  type ProbedVersion,
  type SweepConfig,
  type SweepManifest,
} from '@app/eval';

import { propertyParameters } from './property.js';

// Feature: formal-gate-first-light, Property 27: An older manifest shape is distinguishable from an unreadable version
const PROPERTY =
  'formal-gate-first-light, Property 27: An older manifest shape is distinguishable from an unreadable version';

/** What every manifest recorded before the Formal_Toolchain fields existed, the pilot's included. */
const PRE_FORMAL_MANIFEST_SCHEMA_VERSION = 1;

/** The whole toolchain block of a pre-formal manifest. */
type PreFormalToolchain = Pick<
  ManifestToolchain,
  'iverilogVersion' | 'vvpVersion' | 'workerPython'
>;

/** The Formal_Toolchain entries a pre-formal manifest never had. */
type FormalEntries = Omit<ManifestToolchain, keyof PreFormalToolchain>;

const SHAPES = [
  'pre-formal',
  'every-formal-entry-read',
  'formal-entries-mixed',
  'no-formal-entry-read',
] as const;

type Shape = (typeof SHAPES)[number];

// -- Generators ---------------------------------------------------------------

const arbText = fc.string({ unit: 'grapheme', minLength: 1, maxLength: 24 });

const arbPreFormalToolchain: fc.Arbitrary<PreFormalToolchain> = fc.record({
  iverilogVersion: fc.option(arbText),
  vvpVersion: fc.option(arbText),
  workerPython: fc.option(arbText),
});

const arbRead = arbText.map((value): ProbedVersion => ({ kind: 'read', value }));

const arbNotMeasured = arbText.map((reason): ProbedVersion => ({ kind: 'not-measured', reason }));

/** Typed against `FormalEntries`, so a sixth formal field fails to compile here. */
function formalEntriesFrom(entry: fc.Arbitrary<ProbedVersion>): fc.Arbitrary<FormalEntries> {
  return fc.record({
    yosysVersion: entry,
    yosysBuildId: entry,
    yosysSmtBmcVersion: entry,
    bitwuzlaVersion: entry,
    z3Version: entry,
  });
}

/** One arm per shape: drawn entry by entry, reading nothing would be one draw in 32. */
const arbFormalEntries = fc.oneof(
  formalEntriesFrom(arbRead),
  formalEntriesFrom(fc.oneof(arbRead, arbNotMeasured)),
  formalEntriesFrom(arbNotMeasured),
);

/** The shape the probe's answers give a manifest, from the entries rather than the arm. */
function formalShapeOf(formal: FormalEntries): Shape {
  const kinds = new Set(Object.values<ProbedVersion>(formal).map((entry) => entry.kind));
  if (kinds.size > 1) {
    return 'formal-entries-mixed';
  }
  return kinds.has('read') ? 'every-formal-entry-read' : 'no-formal-entry-read';
}

// -- The manifests ------------------------------------------------------------

/** Not under test, so one admitted config serves. */
const CONFIG: SweepConfig = (() => {
  const parsed = parseSweepConfig({
    schemaVersion: SWEEP_CONFIG_SCHEMA_VERSION,
    runName: 'manifest-shape',
    arms: [{ name: 'arm', model: 'model.a' }],
    problems: { kind: 'all' },
    sampleCount: 1,
    ks: [1],
    seed: 7,
    temperature: 0,
    caps: { maxIterations: 12, maxTokens: 1_000, maxWallClockMs: 1_000, maxCostCents: 100 },
    limits: { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 },
    costEnvelopeCents: 25,
    modelHost: { region: 'us-east-1' },
    outputDir: '.eval-runs/manifest-shape',
  });
  if (!parsed.ok) {
    throw new Error(`the fixture config is invalid: ${parsed.error.message}`);
  }
  return parsed.value;
})();

/** The manifest this build writes when a run starts, and again when it stops. */
function writtenManifests(toolchain: ManifestToolchain): readonly SweepManifest[] {
  const started = assembleManifest({
    config: CONFIG,
    configHash: 'deadbeefdeadbeef',
    selectedProblemIds: [],
    campaignPass: null,
    facts: {
      toolchain,
      host: { platform: 'darwin', arch: 'arm64', release: '24.0.0', runtimeVersion: 'v20.19.0' },
      harness: { commit: null, workingTreeDirty: null },
      startedAt: '2024-06-01T00:00:00.000Z',
    },
  });
  return [started, finalizeManifest(started, '2024-06-01T01:00:00.000Z', 'completed')];
}

/** `schemaVersion` as a reader of the written file sees it, and nothing else. */
function recordedVersionOf(manifest: object): unknown {
  const document = JSON.parse(JSON.stringify(manifest)) as { readonly schemaVersion?: unknown };
  return document.schemaVersion;
}

// -- Property 27 --------------------------------------------------------------

describe(PROPERTY, () => {
  it('records a version no pre-formal manifest carries, whatever the probe could read', () => {
    const seen = new Map<Shape, number>();
    const tally = (shape: Shape): void => {
      seen.set(shape, (seen.get(shape) ?? 0) + 1);
    };

    fc.assert(
      fc.property(arbPreFormalToolchain, arbFormalEntries, (preFormal, formal) => {
        tally('pre-formal');
        tally(formalShapeOf(formal));
        // GIVEN a pre-formal manifest holding the same three toolchain fields ...
        const older = { schemaVersion: PRE_FORMAL_MANIFEST_SCHEMA_VERSION, toolchain: preFormal };

        for (const written of writtenManifests({ ...preFormal, ...formal })) {
          // ... WHEN only each version is read, THEN the written one is recorded and differs.
          const version = recordedVersionOf(written);
          expect(Number.isSafeInteger(version), 'the written manifest records no version').toBe(
            true,
          );
          expect(version).not.toBe(recordedVersionOf(older));
        }
      }),
      propertyParameters(),
    );

    for (const shape of SHAPES) {
      expect(seen.get(shape) ?? 0, `no draw exercised ${shape}`).toBeGreaterThan(0);
    }
  });
});
