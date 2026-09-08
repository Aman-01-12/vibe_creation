// The Waveform_Viewer delivery logic (Design: Waveform_Viewer; Req 9.1, 9.4, 9.10,
// 9.11, 9.12).
//
// Given ONLY the waveform's own source - the captured VCD plus the trust label of
// the artifact it came from - this produces the waveform channel: a delivered
// WaveDrom view that inherits the source's trust tier, or an explicit `unavailable`
// status with a sanitized reason. It reads no schematic state, so the schematic can
// never block or affect the waveform (independent delivery, Req 9.10).
//
// The VCD-to-WaveJSON transform is kept behind the pure `vcdToWaveJson` adapter so
// this surface stays free of parsing and free of WaveDrom itself; a transform
// failure degrades to `render-failed` rather than throwing (fail safe, Req 9.11).

import type { LabeledArtifact } from '@app/core';

import {
  inheritTrust,
  unavailableVisualization,
  type WaveformVisualization,
} from './visualization.js';
import { vcdToWaveJson } from './waveform/vcd-to-wavejson.js';

/**
 * The waveform's source, as it arrives across the API boundary.
 *
 * - `pending`: the simulation has not yet produced a VCD, so nothing is delivered.
 * - `ready`: the VCD text and the label of the artifact it was derived from (the
 *   module version or verification result whose tier the waveform inherits).
 * - `unavailable`: the upstream run failed or timed out, so no VCD exists.
 */
export type WaveformSource =
  | { readonly state: 'pending' }
  | { readonly state: 'ready'; readonly vcd: string; readonly sourceLabel: LabeledArtifact }
  | { readonly state: 'unavailable' };

/**
 * Deliver the waveform channel from its own source.
 *
 * Pending and upstream-unavailable sources map to a pending or `unavailable`
 * channel directly. For a ready source the untrusted VCD is transformed; a
 * transform error yields an explicit `render-failed` unavailable status, and a
 * success yields a delivered waveform whose tier and treatment are inherited from
 * the source label (Property 22). Total and side-effect-free.
 */
export function deliverWaveform(source: WaveformSource): WaveformVisualization {
  if (source.state === 'pending') {
    return { phase: 'pending', kind: 'waveform' };
  }
  if (source.state === 'unavailable') {
    return unavailableVisualization('waveform', 'source-unavailable');
  }
  const parsed = vcdToWaveJson(source.vcd);
  if (!parsed.ok) {
    return unavailableVisualization('waveform', 'render-failed');
  }
  return {
    phase: 'available',
    kind: 'waveform',
    wave: parsed.wave,
    ...inheritTrust(source.sourceLabel),
  };
}
