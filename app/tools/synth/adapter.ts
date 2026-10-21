// The Synth adapter: Yosys `write_json` -> netlistsvg as the gate/schematic
// generator for a verified netlist (design "Tool_Runner and EDA adapters",
// `SynthAdapter`; Req 9.2, 9.5, 9.11).
//
// Like the Simulator adapter, this sits ON TOP of the Tool_Runner sandbox. It
// does not isolate, run tools, or classify capture-all-or-error itself; it
// assembles a `synthesize` `SandboxJob` (the RTL as workspace files, the Yosys
// netlist JSON as a required output), drives it through an injected `ToolRunner`,
// and interprets the raw `SandboxResult` into either a rendered `SvgArtifact` or an
// explicit `UnavailableStatus`.
//
// Division of responsibility (kept single-owner, never duplicated):
//   - The sandbox (`ToolRunner`) owns isolation, path confinement, and
//     capture-all-or-error: a timeout, an infrastructure failure, or a missing
//     required output (including a missing netlist JSON) already yields a
//     `SandboxResult` with verdict `error`. Yosys and netlistsvg run inside that
//     sandbox; this adapter never executes them itself.
//   - This adapter maps that result to the design's `SvgArtifact | UnavailableStatus`
//     union: it surfaces an explicit, sanitized `unavailable` status on any tool
//     failure, unsupported construct, or timeout rather than silently omitting the
//     schematic (Req 9.11), and returns the rendered SVG otherwise.
//
// The Synth adapter turns a verified netlist into a schematic; it never assigns
// trust. A schematic is requested only for a `Verified` module (the caller gates
// this, per the design's hero-loop sequence), and the visualization inherits the
// module's trust tier in the Display_Layer, not here.

import type {
  ArtifactBlobRef,
  RequiredOutput,
  ResourceLimits,
  SandboxJob,
  SandboxResult,
  SourceFile,
  ToolRunner,
} from '../sandbox/index.js';

/**
 * The artifact-map key under which the sandbox worker returns the Yosys
 * `write_json` netlist. Matches the `netlistJson` `RequiredOutput`, so a completed
 * capture is guaranteed to carry it (capture-all-or-error).
 */
const NETLIST_JSON_ARTIFACT_KEY = 'netlistJson' as const;

/**
 * The artifact-map key under which the sandbox worker returns the netlistsvg
 * rendering. It is NOT a declared `RequiredOutput`: netlistsvg can decline to draw
 * an unsupported construct while the run still exits cleanly, so a missing SVG is
 * interpreted here as an explicit `unavailable` rather than a capture error.
 */
const SVG_ARTIFACT_KEY = 'svg' as const;

/**
 * The outputs a synthesize invocation must produce for its capture to be complete.
 *
 * The netlist JSON is the guaranteed product of the Yosys `write_json` stage
 * (Req 9.2); `exitCode` marks that the process ran. If either is missing the
 * sandbox classifies the whole run `error` (capture-all-or-error).
 */
const SYNTHESIZE_REQUIRED_OUTPUTS: readonly RequiredOutput[] = [
  NETLIST_JSON_ARTIFACT_KEY,
  'exitCode',
];

/**
 * Why a schematic could not be produced.
 *
 * These are the coarse, non-sensitive categories the adapter can distinguish from
 * a `SandboxResult` without inspecting tool output that could carry paths:
 *   - `synthesis-error`: the sandbox classified the run `error` (a timeout, an
 *     infrastructure failure, or a missing required netlist) - Req 9.11.
 *   - `synthesis-failed`: the toolchain ran but exited non-zero (for example an
 *     unsupported construct rejected by Yosys).
 *   - `no-schematic`: the toolchain exited cleanly but produced no drawable
 *     schematic (netlistsvg emitted nothing to render).
 */
export type SynthUnavailableCause = 'synthesis-error' | 'synthesis-failed' | 'no-schematic';

/**
 * Fixed, sanitized reason strings for each cause.
 *
 * These are constant, human-readable messages chosen so nothing sensitive can
 * leak: no host, path, stack trace, secret, or raw tool output is ever
 * interpolated into a reason (Req 9.11, sanitized-error standard). The Display_Layer
 * shows the reason verbatim, so it must be safe by construction.
 */
export const SYNTH_UNAVAILABLE_REASONS: Readonly<Record<SynthUnavailableCause, string>> = {
  'synthesis-error': 'The schematic tool did not complete (it failed or timed out).',
  'synthesis-failed': 'The schematic tool could not synthesize this design.',
  'no-schematic': 'The schematic tool did not produce a diagram for this design.',
};

/**
 * A successfully rendered schematic.
 *
 * `svg` references the netlistsvg rendering and `netlistJson` the Yosys
 * `write_json` output it was drawn from; both are blob references (their bytes
 * live in the blob store, fetched by ref), never inline contents. `sizeBytes` on
 * the SVG reference is the size signal the Schematic_View uses to decide the
 * top-level-first drill-down for large designs (Req 9.5).
 */
export interface SvgArtifact {
  readonly status: 'available';
  /** The rendered schematic SVG (netlistsvg output). */
  readonly svg: ArtifactBlobRef;
  /** The Yosys `write_json` netlist the schematic was rendered from. */
  readonly netlistJson: ArtifactBlobRef;
}

/**
 * An explicit "the schematic is unavailable" status with a sanitized reason.
 *
 * Returned instead of throwing or silently omitting, so the caller can deliver any
 * available visualization and surface this one as `unavailable` (Req 9.11). The
 * `reason` is always drawn from `SYNTH_UNAVAILABLE_REASONS`, never from tool output.
 */
export interface UnavailableStatus {
  readonly status: 'unavailable';
  readonly cause: SynthUnavailableCause;
  /** A sanitized, fixed reason string safe to show a Student. */
  readonly reason: string;
}

/**
 * The Synth port (design "Tool_Runner and EDA adapters", `SynthAdapter`): render a
 * gate/schematic SVG from a verified netlist, or return an explicit unavailable
 * status. Callers depend on this interface, not on the concrete Yosys/netlistsvg
 * implementation, so the vendor tools stay isolated behind our own contract.
 */
export interface SynthAdapter {
  netlistSvg(
    rtl: readonly SourceFile[],
    topModule: string,
    limits: ResourceLimits,
  ): Promise<SvgArtifact | UnavailableStatus>;
}

/**
 * Assemble the `SandboxJob` for a synthesize run: the RTL sources as workspace
 * files, the fixed synthesize required-output set, the caller's resource limits,
 * and the `synthesize` payload (Top_Module and Schematic_Request) the widened
 * seam now requires. Pure and exported so job assembly is unit-testable in
 * isolation.
 */
export function assembleSynthesizeJob(
  rtl: readonly SourceFile[],
  topModule: string,
  limits: ResourceLimits,
  schematic: boolean,
): SandboxJob {
  return {
    kind: 'synthesize',
    workspaceFiles: [...rtl],
    limits,
    requiredOutputs: SYNTHESIZE_REQUIRED_OUTPUTS,
    synthesize: { topModule, schematic },
  };
}

/**
 * The Synthesis_Check (SGT-Q05): did Yosys synthesize the design, independent of
 * whether a schematic was drawn? True iff the sandbox did not classify the run
 * `error`, the process exited 0, and `netlistJson` was captured.
 *
 * Reads `netlistJson` only, never `svg`: netlistsvg can decline to draw, or be
 * absent, while synthesis itself still succeeded, and the Structural_Gate's own
 * synthesis-only check (built in a later task) must not fail on that account.
 */
export function synthesisCheckPassed(result: SandboxResult): boolean {
  return (
    result.verdict !== 'error' &&
    result.exitCode === 0 &&
    Object.prototype.hasOwnProperty.call(result.artifacts, NETLIST_JSON_ARTIFACT_KEY)
  );
}

/** Build an `UnavailableStatus` for a cause, pairing it with its sanitized reason. */
function unavailable(cause: SynthUnavailableCause): UnavailableStatus {
  return { status: 'unavailable', cause, reason: SYNTH_UNAVAILABLE_REASONS[cause] };
}

/** The captured artifact reference under a key, or `null` when absent. */
function capturedArtifact(result: SandboxResult, key: string): ArtifactBlobRef | null {
  return result.artifacts[key] ?? null;
}

/**
 * Interpret a raw `SandboxResult` into a `SvgArtifact` or an `UnavailableStatus`.
 *
 * Fail-safe classification, most-severe first:
 *   1. A sandbox `error` verdict (timeout, infra failure, or missing netlist) is
 *      `synthesis-error` - the run did not complete (Req 9.11).
 *   2. A non-zero process exit is `synthesis-failed` - the toolchain rejected the
 *      design (for example an unsupported construct).
 *   3. A missing SVG or netlist artifact on an otherwise clean run is
 *      `no-schematic` - nothing drawable was produced.
 *   4. Otherwise the schematic is available.
 *
 * Pure and exported for unit testing. It never throws and never surfaces tool
 * output, so a failure always degrades to an explicit, sanitized `unavailable`.
 */
export function interpretSynthResult(result: SandboxResult): SvgArtifact | UnavailableStatus {
  if (result.verdict === 'error') {
    return unavailable('synthesis-error');
  }
  if (result.exitCode !== 0) {
    return unavailable('synthesis-failed');
  }
  const svg = capturedArtifact(result, SVG_ARTIFACT_KEY);
  const netlistJson = capturedArtifact(result, NETLIST_JSON_ARTIFACT_KEY);
  if (svg === null || netlistJson === null) {
    return unavailable('no-schematic');
  }
  return { status: 'available', svg, netlistJson };
}

/**
 * `SynthAdapter` backed by the Tool_Runner sandbox running Yosys + netlistsvg.
 *
 * The `ToolRunner` is injected so a `FakeSandboxRuntime`-backed runner can drive
 * the adapter in tests; the concrete sandbox runtime is never hardcoded here. Real
 * Yosys/netlistsvg are exercised by the integration test (task 15.8); when they are
 * absent the run degrades to an explicit `unavailable`, never a crash.
 */
export class YosysNetlistSvgAdapter implements SynthAdapter {
  private readonly toolRunner: ToolRunner;

  constructor(toolRunner: ToolRunner) {
    this.toolRunner = toolRunner;
  }

  async netlistSvg(
    rtl: readonly SourceFile[],
    topModule: string,
    limits: ResourceLimits,
  ): Promise<SvgArtifact | UnavailableStatus> {
    // This adapter's whole purpose is rendering a schematic, so it always
    // requests one; the Structural_Gate's synthesis-only check is a separate,
    // lower-level job built directly by the Structural_Gate_Adapter (SGT-Q05).
    const job = assembleSynthesizeJob(rtl, topModule, limits, true);
    const result = await this.toolRunner.run(job);
    return interpretSynthResult(result);
  }
}
