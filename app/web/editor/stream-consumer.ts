// The non-blocking gateway stream consumer (Design: Editor; Req 6.7, 17.6).
//
// This is the streaming-consumer pattern the M1 long runs reuse: it folds an
// async stream of `GatewayStreamEvent`s into `EditorViewState` incrementally,
// emitting each intermediate state so the interface updates as events arrive and
// never blocks waiting for the whole run. It halts on the first terminal event
// (a `result` or `error`), and it cleans up the underlying subscription on abort
// via the async iterator's `return()` (AbortController lifecycle, resilience
// steering).
//
// The consumer is defined over a plain `AsyncIterable<GatewayStreamEvent>`, not
// the tRPC client, so it is exercised in tests against a fake event source with
// no browser and no network. The typed gateway client adapts its SSE
// subscription (OD-6) into exactly this shape.

import type { GatewayStreamEvent } from '@app/api';

import {
  applyStreamEvent,
  initialEditorViewState,
  isTerminalPhase,
  type EditorViewState,
} from './view-state.js';

/** Callbacks and cancellation for a single consumption run. */
export interface StreamConsumerOptions {
  /** Invoked with every intermediate state so the view can render as it streams. */
  readonly onState?: (state: EditorViewState) => void;
  /** Cancels consumption cooperatively; the source subscription is released. */
  readonly signal?: AbortSignal;
}

/**
 * Consume a gateway event stream, returning the final settled view state.
 *
 * Non-blocking by construction: `await`ing the async iterator yields the event
 * loop between frames, so a long-running simulation never freezes the caller.
 * Each event produces a fresh immutable state handed to `onState`; the loop stops
 * at the first terminal phase or when the caller aborts.
 */
export async function consumeGatewayStream(
  source: AsyncIterable<GatewayStreamEvent>,
  options: StreamConsumerOptions = {},
): Promise<EditorViewState> {
  const { onState, signal } = options;
  const iterator = source[Symbol.asyncIterator]();
  let state = initialEditorViewState();
  try {
    while (!signal?.aborted) {
      const next = await iterator.next();
      if (next.done === true) {
        break;
      }
      state = applyStreamEvent(state, next.value);
      onState?.(state);
      if (isTerminalPhase(state.phase)) {
        break;
      }
    }
  } finally {
    await iterator.return?.();
  }
  return state;
}
