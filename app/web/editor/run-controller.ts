// The Editor run controller: starts a cancellable sample run and routes the
// cancellation reason to the correct UI outcome (Design: Error Handling,
// streaming and cancellation; Req 17.6).
//
// This is the seam a host surface (M1's React Editor) uses to launch a long run.
// It owns one `RunCancellation` per run - created here, wired to a timeout, and
// exposed so the host can cancel on component unmount or navigation - and it
// applies the pure `decideCancellationUi` decision when the run settles: silent
// for an unmount/navigation abort, a single sanitized toast for a timeout abort.
// The toast destination is an injected port, so no browser is needed to test the
// lifecycle end to end. The underlying stream consumer already tears the SSE
// subscription down on abort, so a cancelled run leaves no orphaned client work.

import type { EditorSkeleton, RunSampleOptions } from './editor.js';
import {
  decideCancellationUi,
  readCancellationReason,
  RunCancellation,
  type CancellationReason,
  type RunCancellationOptions,
} from './cancellation.js';
import type { EditorViewState } from './view-state.js';

/** Where a sanitized cancellation toast is shown. Injected; never a global. */
export interface ToastSink {
  show(message: string): void;
}

/** The settled result of a controlled run. */
export interface EditorRunOutcome {
  /** The final rendered view state (a terminal verdict, or the last state at abort). */
  readonly state: EditorViewState;
  /** The reason the run was cancelled, or `null` when it ran to a verdict. */
  readonly cancellation: CancellationReason | null;
}

/** A live, cancellable run: await `result`, or `cancel` it from a host hook. */
export interface EditorRunHandle {
  /** Resolves once the run reaches a verdict or is cancelled; never rejects on abort. */
  readonly result: Promise<EditorRunOutcome>;
  /** Cancel the in-flight run; call with `unmount` or `navigation` from the host. */
  cancel(reason: CancellationReason): void;
}

/**
 * Start a cancellable sample run.
 *
 * Creates the run's `AbortController` (via `RunCancellation`), threads its signal
 * through the Editor into the gateway subscription, and - once settled - surfaces
 * a sanitized toast only for a timeout abort. The returned handle lets the host
 * cancel on unmount or navigation; the timeout self-cancels.
 */
export function startEditorRun(
  editor: EditorSkeleton,
  toast: ToastSink,
  options: RunCancellationOptions = {},
): EditorRunHandle {
  const cancellation = new RunCancellation(options);
  const result = completeRun(editor, toast, cancellation);
  return {
    result,
    cancel: (reason) => cancellation.cancel(reason),
  };
}

/** Run to settle, apply the cancellation UI decision, and always release the timer. */
async function completeRun(
  editor: EditorSkeleton,
  toast: ToastSink,
  cancellation: RunCancellation,
): Promise<EditorRunOutcome> {
  try {
    const runOptions: RunSampleOptions = { signal: cancellation.signal };
    const state = await editor.runSample(runOptions);
    const reason = readCancellationReason(cancellation.signal);
    if (reason !== null) {
      applyCancellationUi(toast, reason);
    }
    return { state, cancellation: reason };
  } finally {
    cancellation.dispose();
  }
}

/** Surface the sanitized toast for a timeout; stay silent for unmount/navigation. */
function applyCancellationUi(toast: ToastSink, reason: CancellationReason): void {
  const decision = decideCancellationUi(reason);
  if (decision.kind === 'toast') {
    toast.show(decision.message);
  }
}
