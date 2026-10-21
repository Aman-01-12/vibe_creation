// Public surface of the Waveform_Viewer and Schematic_View (task 15.3).
//
// The two visualizations are delivered as independent channels, each carrying an
// artifact-derived view that inherits its source's trust tier or an explicit
// `unavailable` status with a sanitized reason (Req 9.1, 9.2, 9.4, 9.5, 9.10,
// 9.11, 9.12). The pure VCD-to-WaveJSON transform is exported separately from any
// rendering so it stays unit-testable and a future renderer swap stays localized
// (OD-5). Property 22 (task 15.4) states over `inheritTrust`; Property 23 (task
// 15.5) states over the delivery functions.

export {
  inheritTrust,
  unavailableVisualization,
  VISUALIZATION_UNAVAILABLE_REASONS,
  type AvailableSchematic,
  type AvailableWaveform,
  type PendingVisualization,
  type SchematicArtifactRef,
  type SchematicRendering,
  type SchematicVisualization,
  type UnavailableVisualization,
  type VisualizationDelivery,
  type VisualizationKind,
  type VisualizationTrust,
  type VisualizationUnavailableCause,
  type WaveformVisualization,
} from './visualization.js';
export { deliverWaveform, type WaveformSource } from './waveform-viewer.js';
export {
  deliverSchematic,
  decideSchematicRendering,
  RESPONSIVE_SCHEMATIC_MAX_BYTES,
  type SchematicSource,
} from './schematic-view.js';
export { deliverVisualizations } from './delivery.js';
export {
  vcdToWaveJson,
  type VcdParseErrorCode,
  type VcdToWaveJsonResult,
  type WaveJson,
  type WaveJsonSignal,
} from './waveform/vcd-to-wavejson.js';
export { signatureToWaveJson, type SampleRecord } from './waveform/signature-to-wavejson.js';
