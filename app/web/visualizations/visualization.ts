// The visualization delivery model: two independent channels (waveform and
// schematic), each carrying either a delivered artifact-derived view or an
// explicit `unavailable` status (Design: Error Handling "Visualization
// degradation"; Req 9.4, 9.7, 9.10, 9.11, 9.12).
//
// Two invariants are modelled structurally so tasks 15.4/15.5 (Property 22 and 23)
// can state over this code:
//   - Trust inheritance (Property 22): a delivered visualization's Trust_Tier and
//     visual treatment are inherited from the SOURCE artifact's label via the core
//     `treatmentForTier` mapping; a visualization is never given the `Verified`
//     treatment unless its own source artifact is `Verified` (Req 9.4, 9.12).
//   - Independent delivery (Property 23): the waveform and schematic are distinct
//     channels. Each is computed from ONLY its own source, so the failure or
//     absence of one can never block or downgrade the other, and a channel that
//     cannot be produced carries an explicit `unavailable` status with a sanitized
//     reason rather than being silently omitted (Req 9.10, 9.11).
//
// Layering: this file depends only inward on `@app/core` for the trust types; it
// never imports `@app/tools` (the backend synth adapter's `SvgArtifact` type) or
// `@app/agent`. The web receives artifact references and upstream unavailability
// across the API_Gateway boundary, modelled here as web-local input types.

import {
  treatmentForTier,
  type LabeledArtifact,
  type TrustTier,
  type TrustTreatment,
} from '@app/core';

import type { WaveJson } from './waveform/vcd-to-wavejson.js';

/** Which visualization a channel carries. */
export type VisualizationKind = 'waveform' | 'schematic';

/**
 * Why a visualization channel is unavailable (Req 9.11).
 *
 * - `source-unavailable`: the upstream artifact/tool could not be produced (the
 *   backend returned an unavailable status, or the run timed out/failed).
 * - `render-failed`: the source artifact was present but could not be transformed
 *   or rendered (for example a malformed VCD).
 * - `unsupported-construct`: the design uses a construct the visualizer cannot draw.
 */
export type VisualizationUnavailableCause =
  'source-unavailable' | 'render-failed' | 'unsupported-construct';

/**
 * Fixed, sanitized reason strings for each unavailable cause.
 *
 * Constant, Student-safe messages: no host, path, stack trace, secret, or raw tool
 * output is ever interpolated, so the reason is safe to render verbatim (Req 9.11).
 */
export const VISUALIZATION_UNAVAILABLE_REASONS: Readonly<
  Record<VisualizationUnavailableCause, string>
> = {
  'source-unavailable': 'This view is unavailable because its source could not be produced.',
  'render-failed': 'This view could not be rendered from its source.',
  'unsupported-construct': 'This design uses a construct this view does not support.',
};

/** The trust a visualization inherits from its source artifact (Property 22). */
export interface VisualizationTrust {
  readonly tier: TrustTier;
  readonly treatment: TrustTreatment;
}

/** A channel whose source artifact is not yet available (no delivery attempted). */
export interface PendingVisualization {
  readonly phase: 'pending';
  readonly kind: VisualizationKind;
}

/** A channel that could not be produced, carrying an explicit sanitized reason. */
export interface UnavailableVisualization {
  readonly phase: 'unavailable';
  readonly kind: VisualizationKind;
  readonly cause: VisualizationUnavailableCause;
  readonly reason: string;
}

/** A delivered waveform, with its inherited trust and the WaveDrom document. */
export interface AvailableWaveform extends VisualizationTrust {
  readonly phase: 'available';
  readonly kind: 'waveform';
  readonly wave: WaveJson;
}

/** How much of a schematic is drawn: the whole design, or the top level only. */
export type SchematicRendering = 'full' | 'top-level';

/**
 * A reference to a rendered schematic SVG, as received across the API boundary.
 *
 * Mirrors the backend `SvgArtifact.svg` blob reference without importing the tools
 * layer; `sizeBytes` is the size signal used to decide the top-level drill-down.
 */
export interface SchematicArtifactRef {
  readonly name: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

/** A delivered schematic, with its inherited trust and the top-level view decision. */
export interface AvailableSchematic extends VisualizationTrust {
  readonly phase: 'available';
  readonly kind: 'schematic';
  readonly svgRef: SchematicArtifactRef;
  /** `top-level` when the design is too large to draw responsively (Req 9.5). */
  readonly rendering: SchematicRendering;
  /** True when the view starts at the top level and submodules can be drilled into. */
  readonly drillDownEnabled: boolean;
}

/** The waveform channel: pending, delivered, or explicitly unavailable. */
export type WaveformVisualization =
  PendingVisualization | AvailableWaveform | UnavailableVisualization;

/** The schematic channel: pending, delivered, or explicitly unavailable. */
export type SchematicVisualization =
  PendingVisualization | AvailableSchematic | UnavailableVisualization;

/**
 * The two independent visualization channels for a module.
 *
 * Each field is delivered on its own timeline; neither is derived from the other,
 * so one being `unavailable` never affects the other (Req 9.10).
 */
export interface VisualizationDelivery {
  readonly waveform: WaveformVisualization;
  readonly schematic: SchematicVisualization;
}

/**
 * Derive the trust a visualization inherits from its source artifact's label.
 *
 * The tier is copied from the source and the treatment is resolved through the
 * single core injective mapping, so a visualization can carry the `Verified`
 * treatment only when its own source artifact is `Verified` (Property 22).
 */
export function inheritTrust(source: LabeledArtifact): VisualizationTrust {
  return { tier: source.tier, treatment: treatmentForTier(source.tier) };
}

/** Build an explicit unavailable channel with its fixed, sanitized reason. */
export function unavailableVisualization(
  kind: VisualizationKind,
  cause: VisualizationUnavailableCause,
): UnavailableVisualization {
  return { phase: 'unavailable', kind, cause, reason: VISUALIZATION_UNAVAILABLE_REASONS[cause] };
}
