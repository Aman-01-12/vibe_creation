// structural-gate-toolchain, Property 3: The Synthesis_Check reads synthesis, not the
// schematic (task 4.2; Req 7.2, 7.3, 7.4).
//
// THE ORACLE IS INDEPENDENT OF THE CODE UNDER TEST
//   `expectedPassed` restates design.md's own rule - not `error`, exit code 0, and
//   `netlistJson` present - from the three draw inputs directly. It never calls
//   `synthesisCheckPassed`, so the property is a real check of the adapter and not a
//   restatement of its own machinery.
//
// WHAT A SAMPLED DRAW WOULD MISS, PINNED BY CONSTRUCTION (per the task's own draw list)
//   - exit 0 with `netlistJson` present and `svg` present: the ordinary passing shape.
//   - exit 0 with `netlistJson` present and `svg` ABSENT: the core claim under test -
//     schematic absence must never flip a synthesis pass to a failure.
//   - `svg` present with `netlistJson` ABSENT: a schematic can exist without the check
//     reading it as success; only `netlistJson` governs.
//
// Validates: Requirements 7.2, 7.3, 7.4

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Verdict } from '@app/core';
import {
  synthesisCheckPassed,
  type ArtifactBlobRef,
  type ResourceUsage,
  type SandboxResult,
} from '@app/tools';

import { propertyParameters } from './property.js';

const PROPERTY =
  'structural-gate-toolchain, Property 3: The Synthesis_Check reads synthesis, not the schematic';

const RESOURCE_USAGE: ResourceUsage = { wallMs: 20, maxMemMb: 16, cpuMs: 18 };

const NETLIST_ARTIFACT: ArtifactBlobRef = {
  name: 'netlist.json',
  sizeBytes: 512,
  sha256: 'c'.repeat(64),
};
const SVG_ARTIFACT: ArtifactBlobRef = {
  name: 'schematic.svg',
  sizeBytes: 2048,
  sha256: 'b'.repeat(64),
};

/** An exit code draw spanning the clean, failing, and timed-out-kill (`null`) shapes. */
function arbExitCode(): fc.Arbitrary<number | null> {
  return fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 255 }), fc.constant(null));
}

/** The artifact map for a draw, carrying `netlistJson`/`svg` under their own presence flags. */
function buildArtifacts(
  netlistJsonPresent: boolean,
  svgPresent: boolean,
): Readonly<Record<string, ArtifactBlobRef>> {
  return {
    ...(netlistJsonPresent ? { netlistJson: NETLIST_ARTIFACT } : {}),
    ...(svgPresent ? { svg: SVG_ARTIFACT } : {}),
  };
}

/** A full `SandboxResult`, defaulting every field the check does not read to a clean run. */
function buildResult(
  verdict: Verdict,
  exitCode: number | null,
  artifacts: Readonly<Record<string, ArtifactBlobRef>>,
): SandboxResult {
  return {
    verdict,
    timedOut: false,
    exitCode,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts,
    deniedOperations: [],
    resourceUsage: RESOURCE_USAGE,
  };
}

/** design.md's rule, restated independently of `synthesisCheckPassed`. */
function expectedPassed(
  verdict: Verdict,
  exitCode: number | null,
  netlistJsonPresent: boolean,
): boolean {
  return verdict !== 'error' && exitCode === 0 && netlistJsonPresent;
}

describe(PROPERTY, () => {
  it('matches the independent oracle for any verdict, exit code, and netlistJson/svg presence', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Verdict>('pass', 'fail', 'error'),
        arbExitCode(),
        fc.boolean(),
        fc.boolean(),
        (verdict, exitCode, netlistJsonPresent, svgPresent) => {
          const result = buildResult(
            verdict,
            exitCode,
            buildArtifacts(netlistJsonPresent, svgPresent),
          );
          expect(synthesisCheckPassed(result)).toBe(
            expectedPassed(verdict, exitCode, netlistJsonPresent),
          );
        },
      ),
      propertyParameters(),
    );
  });

  it('never changes when an svg artifact is added to or removed from an otherwise identical result', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Verdict>('pass', 'fail', 'error'),
        arbExitCode(),
        fc.boolean(),
        (verdict, exitCode, netlistJsonPresent) => {
          const withoutSvg = buildResult(
            verdict,
            exitCode,
            buildArtifacts(netlistJsonPresent, false),
          );
          const withSvg = buildResult(verdict, exitCode, buildArtifacts(netlistJsonPresent, true));
          expect(synthesisCheckPassed(withSvg)).toBe(synthesisCheckPassed(withoutSvg));
        },
      ),
      propertyParameters(),
    );
  });

  it('is true on exit 0 with netlistJson present and svg present', () => {
    const result = buildResult('pass', 0, buildArtifacts(true, true));
    expect(synthesisCheckPassed(result)).toBe(true);
  });

  it('is true on exit 0 with netlistJson present and svg absent (schematic absence must not fail synthesis)', () => {
    const result = buildResult('pass', 0, buildArtifacts(true, false));
    expect(synthesisCheckPassed(result)).toBe(true);
  });

  it('is false when svg is present but netlistJson is absent', () => {
    const result = buildResult('pass', 0, buildArtifacts(false, true));
    expect(synthesisCheckPassed(result)).toBe(false);
  });
});
