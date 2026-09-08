// Unit tests for the Waveform_Viewer delivery logic (task 15.3).
//
// Cover: a ready VCD source produces a delivered waveform whose tier and treatment
// are inherited from the source artifact (trust inheritance, Property 22 in 15.4);
// a pending source produces a pending channel; an upstream-unavailable source and a
// malformed VCD each produce an explicit `unavailable` status with a sanitized
// reason (Req 9.11). The worked cases here anchor the universal Property 22/23
// statements landing in tasks 15.4/15.5.

import { describe, expect, it } from 'vitest';

import {
  newUlid,
  treatmentForTier,
  type ArtifactRef,
  type LabeledArtifact,
  type Ulid,
} from '@app/core';

import { VISUALIZATION_UNAVAILABLE_REASONS } from './visualization.js';
import { deliverWaveform } from './waveform-viewer.js';

/** A module-version artifact reference. */
function moduleRef(version = 1): ArtifactRef {
  return { kind: 'module-version', id: newUlid(), version };
}

/** A `Verified` module label bound to a passing oracle span. */
function verifiedLabel(spanId: Ulid = newUlid()): LabeledArtifact {
  return { artifactRef: moduleRef(), tier: 'Verified', oracleSpanRef: spanId };
}

/** An `Unverified` module label. */
function unverifiedLabel(): LabeledArtifact {
  return { artifactRef: moduleRef(), tier: 'Unverified' };
}

const CLOCK_VCD = ['$var wire 1 ! clk $end', '$enddefinitions $end', '#0', '0!', '#5', '1!'].join(
  '\n',
);

describe('deliverWaveform - delivered from a ready source', () => {
  it('delivers a WaveDrom view inheriting the source Verified tier and treatment', () => {
    const result = deliverWaveform({
      state: 'ready',
      vcd: CLOCK_VCD,
      sourceLabel: verifiedLabel(),
    });

    expect(result.phase).toBe('available');
    if (result.phase !== 'available') return;
    expect(result.tier).toBe('Verified');
    expect(result.treatment).toBe(treatmentForTier('Verified'));
    expect(result.wave.signal[0]?.name).toBe('clk');
  });

  it('inherits an Unverified source tier, never the Verified treatment', () => {
    const result = deliverWaveform({
      state: 'ready',
      vcd: CLOCK_VCD,
      sourceLabel: unverifiedLabel(),
    });

    expect(result.phase).toBe('available');
    if (result.phase !== 'available') return;
    expect(result.tier).toBe('Unverified');
    expect(result.treatment).toBe(treatmentForTier('Unverified'));
    expect(result.treatment).not.toBe(treatmentForTier('Verified'));
  });
});

describe('deliverWaveform - pending and unavailable', () => {
  it('returns a pending channel when the source is not yet available', () => {
    expect(deliverWaveform({ state: 'pending' })).toEqual({ phase: 'pending', kind: 'waveform' });
  });

  it('surfaces source-unavailable when the upstream run failed', () => {
    const result = deliverWaveform({ state: 'unavailable' });
    expect(result).toEqual({
      phase: 'unavailable',
      kind: 'waveform',
      cause: 'source-unavailable',
      reason: VISUALIZATION_UNAVAILABLE_REASONS['source-unavailable'],
    });
  });

  it('surfaces render-failed for a malformed VCD rather than throwing', () => {
    const result = deliverWaveform({
      state: 'ready',
      vcd: 'not a vcd',
      sourceLabel: verifiedLabel(),
    });
    expect(result.phase).toBe('unavailable');
    if (result.phase !== 'unavailable') return;
    expect(result.cause).toBe('render-failed');
    expect(result.reason).toBe(VISUALIZATION_UNAVAILABLE_REASONS['render-failed']);
  });
});
