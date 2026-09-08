// The Schematic_View delivery logic (Design: Schematic_View; Req 9.2, 9.4, 9.5,
// 9.10, 9.11, 9.12).
//
// Given ONLY the schematic's own source - the rendered SVG reference plus the trust
// label of the verified netlist it came from - this produces the schematic channel:
// a delivered view that inherits the source's trust tier and decides the top-level
// drill-down for large designs, or an explicit `unavailable` status with a
// sanitized reason. It reads no waveform state, so the waveform can never block or
// affect the schematic (independent delivery, Req 9.10).
//
// A schematic is only requested for a `Verified` module (the Verification_Loop
// gates this upstream). This surface still inherits the source's tier faithfully,
// so a schematic can carry the `Verified` treatment only when its own source is
// `Verified` (Property 22, Req 9.4).

import type { LabeledArtifact } from '@app/core';

import {
  inheritTrust,
  unavailableVisualization,
  type SchematicArtifactRef,
  type SchematicRendering,
  type SchematicVisualization,
} from './visualization.js';

/**
 * The largest schematic SVG (in bytes) drawn in full before the view falls back to
 * a top-level-first drill-down.
 *
 * Beyond this size the full diagram is treated as too large to render responsively,
 * so the top level is shown with drill-down rather than blocking the interface
 * (Req 9.5). A single named threshold keeps the policy in one place.
 */
export const RESPONSIVE_SCHEMATIC_MAX_BYTES = 262_144;

/**
 * The schematic's source, as it arrives across the API boundary.
 *
 * - `pending`: the module is not yet `Verified`, so no schematic has been requested.
 * - `ready`: the rendered SVG reference and the label of the verified netlist it was
 *   derived from (whose tier the schematic inherits).
 * - `unavailable`: the synth adapter returned an unavailable status (tool failure,
 *   unsupported construct, or timeout).
 */
export type SchematicSource =
  | { readonly state: 'pending' }
  | {
      readonly state: 'ready';
      readonly svgRef: SchematicArtifactRef;
      readonly sourceLabel: LabeledArtifact;
    }
  | { readonly state: 'unavailable' };

/**
 * Decide whether a schematic of the given size is drawn in full or top-level-first.
 *
 * Pure and exported so the drill-down policy is directly testable: a diagram at or
 * under the responsiveness threshold is drawn in full; a larger one starts at the
 * top level with drill-down (Req 9.5).
 */
export function decideSchematicRendering(svgSizeBytes: number): SchematicRendering {
  return svgSizeBytes > RESPONSIVE_SCHEMATIC_MAX_BYTES ? 'top-level' : 'full';
}

/**
 * Deliver the schematic channel from its own source.
 *
 * Pending and upstream-unavailable sources map to a pending or `unavailable`
 * channel directly. For a ready source the tier and treatment are inherited from
 * the source label (Property 22) and the top-level drill-down is decided from the
 * SVG size (Req 9.5). Total and side-effect-free.
 */
export function deliverSchematic(source: SchematicSource): SchematicVisualization {
  if (source.state === 'pending') {
    return { phase: 'pending', kind: 'schematic' };
  }
  if (source.state === 'unavailable') {
    return unavailableVisualization('schematic', 'source-unavailable');
  }
  const rendering = decideSchematicRendering(source.svgRef.sizeBytes);
  return {
    phase: 'available',
    kind: 'schematic',
    svgRef: source.svgRef,
    rendering,
    drillDownEnabled: rendering === 'top-level',
    ...inheritTrust(source.sourceLabel),
  };
}
