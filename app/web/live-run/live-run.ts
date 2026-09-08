// The Live_Run enabled/deferred switch (Design: Recommended stack "Live_Run";
// Req 9.6, 9.7, 9.8, 9.9).
//
// Live_Run is the OPTIONAL in-browser behavioral view produced by compiling the
// design with Verilator to WebAssembly (WASM). For this slice a SINGLE slice-scope
// decision puts it in exactly one of two states, `enabled` or `deferred`, and this
// module models that decision so Property 24 (task 15.7) can state over it:
//
//   - Exactly one mode (Req 9.8): `decideLiveRun` returns one arm of the closed
//     `LiveRun` union. "Both" and "neither" are unrepresentable - the deferred arm
//     has no compile capability at all and the enabled arm always has exactly one.
//   - Deferred never compiles to WASM (Req 9.7, 9.9): the deferred arm captures no
//     compile port and exposes no `runLive`, so no WASM code path is reachable; it
//     still delivers the Waveform and Schematic_View from the backend oracle by
//     composing the task-15.3 delivery surface (never duplicating it).
//   - Enabled compiles lazily and caches (Req 9.6): the enabled arm compiles on the
//     FIRST panel use (not eagerly) through an injected port, and memoizes the
//     compile so it happens at most once for the instance.
//   - Never the verdict (Req 9.6, 9.8): a Live_Run result is a `LiveRunPreview`
//     whose `authority` is the closed literal `preview-only`. There is deliberately
//     no field or function that turns it into a `Verdict` or a `TrustTier`, and this
//     module imports nothing from the verification path. The backend Simulator
//     oracle remains the sole authority for correctness (the product prime
//     directive).
//
// Vendor isolation: the Verilator-to-WASM toolchain is reached only through the
// injected `WasmCompilePort`; this module never imports a vendor SDK, so a real or
// fake toolchain is swapped at the boundary. The decision and lazy-cache logic here
// are pure/synchronous data plus a single memoized promise, with no React
// rendering, so they stay directly unit-testable.

import { err, type Result } from '@app/core';

import {
  deliverVisualizations,
  type SchematicSource,
  type VisualizationDelivery,
  type WaveformSource,
} from '../visualizations/index.js';

/** The two, and only two, outcomes of the single Live_Run slice-scope decision. */
export type LiveRunMode = 'enabled' | 'deferred';

/**
 * The authority a Live_Run result carries.
 *
 * A closed literal with a single member: a Live_Run result is a behavioral PREVIEW
 * only and is never the correctness verdict (Req 9.6, 9.8). Because this is the only
 * inhabitant of the type, no Live_Run result can ever be constructed as a verdict.
 */
export const LIVE_RUN_AUTHORITY = 'preview-only' as const;
export type LiveRunAuthority = typeof LIVE_RUN_AUTHORITY;

/** Why a Live_Run could not be produced (sanitized, Student-safe causes). */
export type LiveRunErrorCode = 'compile-failed' | 'unsupported-construct' | 'run-failed';

/**
 * Fixed, sanitized reason strings for each Live_Run error code.
 *
 * Constant, Student-safe messages: no host, path, stack trace, secret, or raw tool
 * output is ever interpolated, so the reason is safe to surface verbatim.
 */
export const LIVE_RUN_ERROR_REASONS: Readonly<Record<LiveRunErrorCode, string>> = {
  'compile-failed': 'The live preview could not be compiled for this design.',
  'unsupported-construct': 'The live preview does not support a construct in this design.',
  'run-failed': 'The live preview could not run for the given inputs.',
};

/** A sanitized Live_Run failure carrying a fixed code and Student-safe reason. */
export interface LiveRunError {
  readonly code: LiveRunErrorCode;
  readonly reason: string;
}

/** Build a sanitized Live_Run error with its fixed reason string. */
export function liveRunError(code: LiveRunErrorCode): LiveRunError {
  return { code, reason: LIVE_RUN_ERROR_REASONS[code] };
}

/** One signal's sampled values across the previewed cycles. */
export interface LiveRunSignal {
  readonly name: string;
  readonly values: readonly number[];
}

/**
 * The result of a live preview run.
 *
 * `authority` is pinned to `preview-only`: this is explicitly NOT a correctness
 * verdict and must never flow into the Trust_Labeler or a Trust_Tier (Req 9.6, 9.8).
 */
export interface LiveRunPreview {
  readonly authority: LiveRunAuthority;
  readonly signals: readonly LiveRunSignal[];
}

/** The inputs that drive a single live preview run. */
export interface LiveRunStimulus {
  readonly cycles: number;
  readonly inputs: Readonly<Record<string, number>>;
}

/** The design to compile for the live preview (the current module's RTL). */
export interface LiveRunCompileRequest {
  readonly rtl: string;
  readonly topModule: string;
}

/**
 * A design compiled to WASM, ready to run behavioral previews.
 *
 * Produced behind the vendor boundary; `run` returns a typed `Result` and, per the
 * codebase Result convention, adapters implementing this interface never throw.
 */
export interface CompiledLiveModule {
  run(stimulus: LiveRunStimulus): Result<LiveRunPreview, LiveRunError>;
}

/**
 * The injected Verilator-to-WASM compile port (vendor isolation).
 *
 * The real toolchain lives behind this interface; tests drive a fake. Returns a
 * typed `Result`; implementations never throw (mirrors `@app/core` constructors).
 */
export interface WasmCompilePort {
  compile(request: LiveRunCompileRequest): Promise<Result<CompiledLiveModule, LiveRunError>>;
}

/**
 * The Live_Run when the slice defers the in-browser preview (Req 9.7, 9.9).
 *
 * Carries no compile port and exposes no `runLive`, so no WASM code path is
 * reachable. It still delivers the backend Waveform and Schematic_View.
 */
export interface DeferredLiveRun {
  readonly mode: 'deferred';
  deliverBackendVisualizations(
    waveformSource: WaveformSource,
    schematicSource: SchematicSource,
  ): VisualizationDelivery;
}

/**
 * The Live_Run when the slice enables the in-browser preview (Req 9.6).
 *
 * `runLive` compiles the design to WASM lazily on first use and caches it, so the
 * compile happens at most once; the backend visualizations are still delivered
 * exactly as in the deferred case.
 */
export interface EnabledLiveRun {
  readonly mode: 'enabled';
  deliverBackendVisualizations(
    waveformSource: WaveformSource,
    schematicSource: SchematicSource,
  ): VisualizationDelivery;
  runLive(stimulus: LiveRunStimulus): Promise<Result<LiveRunPreview, LiveRunError>>;
}

/**
 * The Live_Run for this slice: exactly one of enabled or deferred.
 *
 * A closed two-arm union discriminated on `mode`; "both" and "neither" are
 * unrepresentable (Req 9.8, Property 24).
 */
export type LiveRun = DeferredLiveRun | EnabledLiveRun;

/**
 * The single slice-scope decision input.
 *
 * The `enabled` arm requires the compile port and the design to compile; the
 * `deferred` arm carries neither, so an enabled-without-port or a deferred-with-port
 * configuration does not type-check.
 */
export type LiveRunConfig =
  | { readonly mode: 'deferred' }
  | {
      readonly mode: 'enabled';
      readonly compilePort: WasmCompilePort;
      readonly request: LiveRunCompileRequest;
    };

/** Deliver the backend Waveform and Schematic_View by composing the task-15.3 surface. */
function deliverBackendVisualizations(
  waveformSource: WaveformSource,
  schematicSource: SchematicSource,
): VisualizationDelivery {
  return deliverVisualizations(waveformSource, schematicSource);
}

/**
 * Build a lazy, at-most-once compile step.
 *
 * The compile is not started until the returned function is first called (lazy on
 * first panel use), and the resulting promise is memoized so the injected port's
 * `compile` runs at most once - concurrent first calls share the one in-flight
 * compile, and a resolved success or failure is reused rather than recompiled
 * (Req 9.6; fail safe against unbounded recompilation).
 */
function createLazyCompile(
  compilePort: WasmCompilePort,
  request: LiveRunCompileRequest,
): () => Promise<Result<CompiledLiveModule, LiveRunError>> {
  let cached: Promise<Result<CompiledLiveModule, LiveRunError>> | undefined;
  return () => {
    if (cached === undefined) {
      cached = compilePort.compile(request);
    }
    return cached;
  };
}

/** Build the deferred Live_Run: no compile port, no reachable WASM path (Req 9.9). */
function createDeferredLiveRun(): DeferredLiveRun {
  return { mode: 'deferred', deliverBackendVisualizations };
}

/** Build the enabled Live_Run with a lazy, cached compile behind the injected port. */
function createEnabledLiveRun(
  compilePort: WasmCompilePort,
  request: LiveRunCompileRequest,
): EnabledLiveRun {
  const compileOnce = createLazyCompile(compilePort, request);
  return {
    mode: 'enabled',
    deliverBackendVisualizations,
    async runLive(stimulus: LiveRunStimulus): Promise<Result<LiveRunPreview, LiveRunError>> {
      const compiled = await compileOnce();
      if (!compiled.ok) {
        return err(compiled.error);
      }
      return compiled.value.run(stimulus);
    },
  };
}

/**
 * Make the single Live_Run slice-scope decision (Req 9.8).
 *
 * Returns exactly one arm of the `LiveRun` union: `deferred` never compiles to WASM
 * and still delivers the backend visualizations (Req 9.7, 9.9); `enabled` compiles
 * lazily and caches behind the injected port (Req 9.6). In neither case is a
 * Live_Run result the correctness verdict.
 */
export function decideLiveRun(config: LiveRunConfig): LiveRun {
  if (config.mode === 'deferred') {
    return createDeferredLiveRun();
  }
  return createEnabledLiveRun(config.compilePort, config.request);
}
