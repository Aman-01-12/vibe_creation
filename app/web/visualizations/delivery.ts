// Composition of the two independent visualization channels (Req 9.7, 9.10).
//
// This assembles the `VisualizationDelivery` from the waveform source and the
// schematic source. The composition is structurally independent: each channel is
// computed by its own delivery function from ONLY its own source, so the readiness,
// success, or failure of one is never an input to the other. Delivering the pair
// together is purely a convenience for the Editor; it introduces no coupling and
// never blocks one channel on the other or on the pass/fail verdict.

import { deliverSchematic, type SchematicSource } from './schematic-view.js';
import type { VisualizationDelivery } from './visualization.js';
import { deliverWaveform, type WaveformSource } from './waveform-viewer.js';

/**
 * Assemble the waveform and schematic channels from their independent sources.
 *
 * Each channel is delivered from its own source alone; there is deliberately no
 * cross-reads between the two, so this function cannot make one channel block or
 * downgrade the other (Property 23, Req 9.10). A source that is `pending` yields a
 * pending channel and a source that failed yields an explicit `unavailable`
 * channel, independently on each side.
 */
export function deliverVisualizations(
  waveformSource: WaveformSource,
  schematicSource: SchematicSource,
): VisualizationDelivery {
  return {
    waveform: deliverWaveform(waveformSource),
    schematic: deliverSchematic(schematicSource),
  };
}
