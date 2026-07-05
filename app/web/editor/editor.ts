// The M0 Editor skeleton (Design: Components and Interfaces, Editor; Req 1.1,
// 17.6).
//
// It wires the three pieces of the spine's browser surface together: the fixed
// sample design, the typed gateway client (the only outbound seam), and the
// non-blocking stream consumer. Submitting the sample streams the run's progress
// and settles on a pass/fail/error verdict, updating the injected view as each
// event arrives so the interface is never blocked on the long simulation.
//
// The render layer is an injected port rather than a concrete UI framework: the
// M0 skeleton proves the streaming surface end to end, and M1's React Editor (and
// the deferred Display_Layer, Waveform_Viewer, etc.) plug into the same
// `EditorView` seam.

import type { GatewayStreamEvent } from '@app/api';

import { consumeGatewayStream, type StreamConsumerOptions } from './stream-consumer.js';
import { createEditorGatewayClient, type EditorGatewayClient } from './gateway-client.js';
import { SAMPLE_SKELETON_SIMULATION } from './sample-design.js';
import { initialEditorViewState, isTerminalPhase, type EditorViewState } from './view-state.js';

/** The render seam the streaming loop pushes each intermediate state into. */
export interface EditorView {
  render(state: EditorViewState): void;
}

/** Options for a single sample run. */
export interface RunSampleOptions {
  /** Aborts the run and tears down the underlying stream. */
  readonly signal?: AbortSignal;
}

/**
 * The skeleton Editor: submit the hardcoded sample to the gateway and render the
 * streamed pass/fail/error verdict.
 */
export class EditorSkeleton {
  readonly #gateway: EditorGatewayClient;
  readonly #view: EditorView;

  constructor(gateway: EditorGatewayClient, view: EditorView) {
    this.#gateway = gateway;
    this.#view = view;
  }

  /**
   * Run the fixed sample end to end, returning the final settled view state.
   *
   * Progress renders incrementally as events stream in; the promise resolves once
   * a terminal verdict is reached or the run is aborted.
   */
  async runSample(options: RunSampleOptions = {}): Promise<EditorViewState> {
    this.#view.render(initialEditorViewState());
    const stream = this.#gateway.runSkeletonSimulation(SAMPLE_SKELETON_SIMULATION, options.signal);
    const consumerOptions: StreamConsumerOptions = { onState: (state) => this.#view.render(state) };
    return consumeGatewayStream(
      stream,
      options.signal === undefined
        ? consumerOptions
        : { ...consumerOptions, signal: options.signal },
    );
  }
}

/**
 * Compose a ready-to-run skeleton Editor from gateway configuration and a view.
 *
 * A thin convenience over `createEditorGatewayClient` + `EditorSkeleton` for the
 * common case; callers needing to inject a fake gateway (tests) construct
 * `EditorSkeleton` directly.
 */
export function createEditorSkeleton(
  gatewayConfig: Parameters<typeof createEditorGatewayClient>[0],
  view: EditorView,
): EditorSkeleton {
  return new EditorSkeleton(createEditorGatewayClient(gatewayConfig), view);
}

/** Render one view state to a human-readable, display-only text block. */
export function renderEditorViewState(state: EditorViewState): string {
  const header = renderHeader(state);
  if (state.progress.length === 0) {
    return header;
  }
  const lines = state.progress.map((entry) => `  #${entry.seq} ${entry.message}`);
  return [header, ...lines].join('\n');
}

/** Build the status header line for a view state. */
function renderHeader(state: EditorViewState): string {
  const cursor = state.lastEventId === null ? 'none' : `#${state.lastEventId}`;
  if (isTerminalPhase(state.phase) && state.outcome !== null) {
    return `[${state.phase}] verdict=${state.outcome.verdict} - ${state.outcome.detail} | last event ${cursor}`;
  }
  return `[${state.phase}] ${state.progress.length} update(s) | last event ${cursor}`;
}

/**
 * A minimal text view: renders each state to a line via the injected sink.
 * Keeps the skeleton free of a UI framework while remaining fully testable.
 */
export function createTextEditorView(write: (text: string) => void): EditorView {
  return {
    render(state: EditorViewState): void {
      write(renderEditorViewState(state));
    },
  };
}

/** Re-exported so callers can type view sinks against the streamed event shape. */
export type { GatewayStreamEvent };
