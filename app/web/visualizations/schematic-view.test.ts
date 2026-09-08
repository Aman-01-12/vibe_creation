// Unit tests for the Schematic_View delivery logic (task 15.3).
//
// Cover: a ready SVG source produces a delivered schematic inheriting the verified
// netlist's tier (trust inheritance, Property 22 in 15.4); the top-level drill-down
// is chosen for large diagrams and the full view for small ones (Req 9.5); and
// pending/unavailable sources produce the pending or explicit `unavailable` channel
// (Req 9.11).

import { describe, expect, it } from 'vitest';

import {
  newUlid,
  treatmentForTier,
  type ArtifactRef,
  type LabeledArtifact,
  type Ulid,
} from '@app/core';

import {
  decideSchematicRendering,
  deliverSchematic,
  RESPONSIVE_SCHEMATIC_MAX_BYTES,
} from './schematic-view.js';
import { VISUALIZATION_UNAVAILABLE_REASONS, type SchematicArtifactRef } from './visualization.js';

/** A module-version artifact reference. */
function moduleRef(): ArtifactRef {
  return { kind: 'module-version', id: newUlid(), version: 1 };
}

/** A `Verified` module label bound to a passing oracle span. */
function verifiedLabel(spanId: Ulid = newUlid()): LabeledArtifact {
  return { artifactRef: moduleRef(), tier: 'Verified', oracleSpanRef: spanId };
}

/** A schematic SVG reference of the given size. */
function svgRef(sizeBytes: number): SchematicArtifactRef {
  return { name: 'schematic.svg', sizeBytes, sha256: 'd'.repeat(64) };
}

describe('decideSchematicRendering - top-level drill-down for large designs (Req 9.5)', () => {
  it('draws a small schematic in full', () => {
    expect(decideSchematicRendering(1024)).toBe('full');
  });

  it('draws a schematic at the threshold in full', () => {
    expect(decideSchematicRendering(RESPONSIVE_SCHEMATIC_MAX_BYTES)).toBe('full');
  });

  it('falls back to top-level for a schematic larger than the threshold', () => {
    expect(decideSchematicRendering(RESPONSIVE_SCHEMATIC_MAX_BYTES + 1)).toBe('top-level');
  });
});

describe('deliverSchematic - delivered from a ready source', () => {
  it('delivers a full view inheriting the verified netlist tier and treatment', () => {
    const result = deliverSchematic({
      state: 'ready',
      svgRef: svgRef(4096),
      sourceLabel: verifiedLabel(),
    });

    expect(result.phase).toBe('available');
    if (result.phase !== 'available') return;
    expect(result.tier).toBe('Verified');
    expect(result.treatment).toBe(treatmentForTier('Verified'));
    expect(result.rendering).toBe('full');
    expect(result.drillDownEnabled).toBe(false);
  });

  it('delivers a top-level view with drill-down enabled for a large design', () => {
    const result = deliverSchematic({
      state: 'ready',
      svgRef: svgRef(RESPONSIVE_SCHEMATIC_MAX_BYTES + 1),
      sourceLabel: verifiedLabel(),
    });

    expect(result.phase).toBe('available');
    if (result.phase !== 'available') return;
    expect(result.rendering).toBe('top-level');
    expect(result.drillDownEnabled).toBe(true);
  });
});

describe('deliverSchematic - pending and unavailable', () => {
  it('returns a pending channel when no schematic has been requested', () => {
    expect(deliverSchematic({ state: 'pending' })).toEqual({ phase: 'pending', kind: 'schematic' });
  });

  it('surfaces source-unavailable when the synth adapter returned unavailable', () => {
    const result = deliverSchematic({ state: 'unavailable' });
    expect(result).toEqual({
      phase: 'unavailable',
      kind: 'schematic',
      cause: 'source-unavailable',
      reason: VISUALIZATION_UNAVAILABLE_REASONS['source-unavailable'],
    });
  });
});
