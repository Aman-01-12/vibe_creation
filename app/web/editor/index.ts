// Public surface of the M0 Editor skeleton (task 6.2).
//
// The Editor submits a hardcoded Verilog module + testbench to the API_Gateway
// (and only the gateway) via an end-to-end typed tRPC client, consumes the SSE
// stream without blocking, and renders the pass/fail/error verdict.

export {
  applyStreamEvent,
  initialEditorViewState,
  isTerminalPhase,
  type EditorOutcome,
  type EditorPhase,
  type EditorViewState,
  type ProgressEntry,
} from './view-state.js';
export { consumeGatewayStream, type StreamConsumerOptions } from './stream-consumer.js';
export {
  observerToAsyncIterable,
  type Subscribe,
  type StreamObserver,
  type Subscription,
} from './subscription-stream.js';
export {
  createEditorGatewayClient,
  type EditorGatewayClient,
  type EditorGatewayConfig,
} from './gateway-client.js';
export { SAMPLE_SKELETON_SIMULATION } from './sample-design.js';
export {
  createEditorSkeleton,
  createTextEditorView,
  EditorSkeleton,
  renderEditorViewState,
  type EditorView,
  type RunSampleOptions,
} from './editor.js';
