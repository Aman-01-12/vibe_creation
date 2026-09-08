// Synth adapter: Yosys `write_json` -> netlistsvg for gate/schematic views
// (design "Tool_Runner and EDA adapters", `SynthAdapter`; Req 9.2, 9.11).
//
// The adapter drives the Tool_Runner sandbox (it does not isolate or run tools
// itself), assembling a synthesize `SandboxJob`, and interpreting the run into
// either a rendered `SvgArtifact` or an explicit, sanitized `UnavailableStatus`.
// Real Yosys/netlistsvg are exercised by the integration test (task 15.8); when
// absent the path degrades to `unavailable`, never a crash.

export {
  YosysNetlistSvgAdapter,
  assembleSynthesizeJob,
  interpretSynthResult,
  SYNTH_UNAVAILABLE_REASONS,
} from './adapter.js';
export type {
  SvgArtifact,
  SynthAdapter,
  SynthUnavailableCause,
  UnavailableStatus,
} from './adapter.js';
