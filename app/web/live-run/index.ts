// Public surface of the Live_Run enabled/deferred switch (task 15.6).
//
// A single slice-scope decision (`decideLiveRun`) returns exactly one arm of the
// closed `LiveRun` union: `deferred` (no WASM path reachable, backend Waveform +
// Schematic_View still delivered) or `enabled` (Verilator-to-WASM compiled lazily
// on first panel use and cached, behind the injected `WasmCompilePort`). A Live_Run
// result is a `LiveRunPreview` whose `authority` is `preview-only`; it is never the
// correctness verdict, which remains the backend Simulator oracle's. Property 24
// (task 15.7) states over this surface (Req 9.6, 9.7, 9.8, 9.9).

export {
  decideLiveRun,
  liveRunError,
  LIVE_RUN_AUTHORITY,
  LIVE_RUN_ERROR_REASONS,
  type CompiledLiveModule,
  type DeferredLiveRun,
  type EnabledLiveRun,
  type LiveRun,
  type LiveRunAuthority,
  type LiveRunCompileRequest,
  type LiveRunConfig,
  type LiveRunError,
  type LiveRunErrorCode,
  type LiveRunMode,
  type LiveRunPreview,
  type LiveRunSignal,
  type LiveRunStimulus,
  type WasmCompilePort,
} from './live-run.js';
