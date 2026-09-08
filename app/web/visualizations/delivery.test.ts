// Unit tests for independent visualization delivery (task 15.3).
//
// These anchor the independence the universal Property 23 (task 15.5) states: each
// channel is delivered from its own source alone, so any combination of one channel
// failing/pending and the other succeeding is delivered without one affecting the
// other, and a failed channel always carries an explicit `unavailable` status
// rather than being omitted (Req 9.10, 9.11).

import { describe, expect, it } from 'vitest';

import { newUlid, type ArtifactRef, type LabeledArtifact, type Ulid } from '@app/core';

import { deliverVisualizations } from './delivery.js';
import type { SchematicArtifactRef } from './visualization.js';

function moduleRef(): ArtifactRef {
  return { kind: 'module-version', id: newUlid(), version: 1 };
}

function verifiedLabel(spanId: Ulid = newUlid()): LabeledArtifact {
  return { artifactRef: moduleRef(), tier: 'Verified', oracleSpanRef: spanId };
}

const CLOCK_VCD = ['$var wire 1 ! clk $end', '$enddefinitions $end', '#0', '0!', '#5', '1!'].join(
  '\n',
);
const SMALL_SVG: SchematicArtifactRef = {
  name: 'schematic.svg',
  sizeBytes: 2048,
  sha256: 'e'.repeat(64),
};

describe('deliverVisualizations - channels are independent (Req 9.10)', () => {
  it('delivers the waveform even when the schematic is unavailable', () => {
    const delivery = deliverVisualizations(
      { state: 'ready', vcd: CLOCK_VCD, sourceLabel: verifiedLabel() },
      { state: 'unavailable' },
    );

    expect(delivery.waveform.phase).toBe('available');
    expect(delivery.schematic.phase).toBe('unavailable');
  });

  it('delivers the schematic even when the waveform is unavailable', () => {
    const delivery = deliverVisualizations(
      { state: 'unavailable' },
      { state: 'ready', svgRef: SMALL_SVG, sourceLabel: verifiedLabel() },
    );

    expect(delivery.waveform.phase).toBe('unavailable');
    expect(delivery.schematic.phase).toBe('available');
  });

  it('delivers a ready channel while the other is still pending', () => {
    const delivery = deliverVisualizations(
      { state: 'ready', vcd: CLOCK_VCD, sourceLabel: verifiedLabel() },
      { state: 'pending' },
    );

    expect(delivery.waveform.phase).toBe('available');
    expect(delivery.schematic.phase).toBe('pending');
  });

  it('surfaces both channels as explicit unavailable when both sources failed', () => {
    const delivery = deliverVisualizations({ state: 'unavailable' }, { state: 'unavailable' });

    expect(delivery.waveform.phase).toBe('unavailable');
    expect(delivery.schematic.phase).toBe('unavailable');
  });
});
