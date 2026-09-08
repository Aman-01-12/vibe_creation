// Cancellation lifecycle test for the Editor's long-run AbortController seam
// (task 15.10; Design: Error Handling, streaming and cancellation; Req 17.6).
//
// This is an example/lifecycle unit test (no browser, no network): it drives the
// real `startEditorRun` -> `EditorSkeleton` -> `consumeGatewayStream` path against
// a fake gateway whose stream models a long in-flight downstream call. The fake
// records whether it OBSERVED the run's abort and whether its subscription was
// TORN DOWN, so "no orphaned in-flight work remains" is asserted on the real
// teardown, not a stub. Timers use Vitest fake timers so the timeout path is
// deterministic and the default scheduler (`setTimeout`/`clearTimeout`) is the
// one exercised.
//
// It pins the three, and only three, cancellation outcomes:
//   - unmount    -> silent (no toast), downstream aborted + torn down
//   - navigation -> silent (no toast), downstream aborted + torn down
//   - timeout    -> exactly one sanitized toast, downstream aborted + torn down
// plus first-reason-wins idempotency and the fail-safe reason read at the seam.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GatewayStreamEvent, SkeletonSimulationInput } from '@app/api';

import {
  cancellationSignalReason,
  decideCancellationUi,
  EditorSkeleton,
  readCancellationReason,
  startEditorRun,
  TIMEOUT_TOAST_MESSAGE,
  type CancellationReason,
  type EditorGatewayClient,
  type RunCancellationOptions,
  type ToastSink,
} from './index.js';

/**
 * A gateway whose stream models a long-running downstream call: it yields no
 * events on its own and ends only when the run's `AbortSignal` fires. It records
 * that it saw the abort (`observedAbort`) and that its iterator was released
 * (`subscriptionTornDown`), so a cancelled run's teardown is directly assertable.
 */
class LongRunningGateway implements EditorGatewayClient {
  observedAbort = false;
  subscriptionTornDown = false;
  submitted: SkeletonSimulationInput | null = null;

  runSkeletonSimulation(
    input: SkeletonSimulationInput,
    signal?: AbortSignal,
  ): AsyncIterable<GatewayStreamEvent> {
    this.submitted = input;
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<GatewayStreamEvent> => ({
        next: (): Promise<IteratorResult<GatewayStreamEvent>> => this.#nextUntilAbort(signal),
        return: (): Promise<IteratorResult<GatewayStreamEvent>> => {
          this.subscriptionTornDown = true;
          return Promise.resolve({ value: undefined, done: true });
        },
      }),
    };
  }

  /** Stay pending (a live run producing no events yet) until the signal aborts. */
  #nextUntilAbort(signal: AbortSignal | undefined): Promise<IteratorResult<GatewayStreamEvent>> {
    const done: IteratorResult<GatewayStreamEvent> = { value: undefined, done: true };
    if (signal === undefined) {
      return Promise.resolve(done);
    }
    if (signal.aborted) {
      this.observedAbort = true;
      return Promise.resolve(done);
    }
    return new Promise((resolve) => {
      signal.addEventListener(
        'abort',
        () => {
          this.observedAbort = true;
          resolve(done);
        },
        { once: true },
      );
    });
  }
}

/** A toast sink that records every sanitized message it is asked to show. */
class RecordingToast implements ToastSink {
  readonly messages: string[] = [];
  show(message: string): void {
    this.messages.push(message);
  }
}

/** Substrings that would betray an internal host, path, stack, or secret. */
const LEAK_MARKERS: readonly string[] = [
  '://',
  '/Users',
  '/home',
  '/var',
  'localhost',
  '127.0.0.1',
  'Error:',
  '\n    at ',
  'stack',
  'secret',
  'token',
  'password',
];

/** Assert a surfaced message carries no internal detail (sanitized to the client). */
function expectSanitized(message: string): void {
  for (const marker of LEAK_MARKERS) {
    expect(message.toLowerCase()).not.toContain(marker.toLowerCase());
  }
}

const TIMEOUT_MS = 1_000;

/** Compose the real run controller over the long-running fake gateway. */
function startRun(timeoutMs: number | undefined): {
  toast: RecordingToast;
  gateway: LongRunningGateway;
  handle: ReturnType<typeof startEditorRun>;
} {
  const gateway = new LongRunningGateway();
  const editor = new EditorSkeleton(gateway, { render: () => undefined });
  const toast = new RecordingToast();
  // Omit `timeoutMs` entirely (rather than passing `undefined`) so the no-deadline
  // case is expressed under `exactOptionalPropertyTypes`.
  const options: RunCancellationOptions = timeoutMs === undefined ? {} : { timeoutMs };
  const handle = startEditorRun(editor, toast, options);
  return { toast, gateway, handle };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Editor cancellation lifecycle: host-driven aborts are silent (Req 17.6)', () => {
  for (const reason of ['unmount', 'navigation'] as const satisfies readonly CancellationReason[]) {
    it(`cancels the in-flight downstream call silently on ${reason} and leaves no orphaned work`, async () => {
      const { toast, gateway, handle } = startRun(TIMEOUT_MS);

      // Let the run park on the pending downstream call, then the host aborts.
      await Promise.resolve();
      handle.cancel(reason);
      const outcome = await handle.result;

      // Silent: the host teardown reasons never surface a user-facing toast.
      expect(toast.messages).toEqual([]);
      expect(outcome.cancellation).toBe(reason);

      // No orphaned work: the downstream call observed the abort and its
      // subscription was released.
      expect(gateway.observedAbort).toBe(true);
      expect(gateway.subscriptionTornDown).toBe(true);

      // No dangling timer, and firing the (now cleared) deadline changes nothing.
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 2);
      expect(toast.messages).toEqual([]);
    });
  }
});

describe('Editor cancellation lifecycle: a timeout abort surfaces one sanitized toast (Req 17.6)', () => {
  it('cancels the downstream call, tears it down, and shows exactly one sanitized toast', async () => {
    const { toast, gateway, handle } = startRun(TIMEOUT_MS);

    // Reach the deadline without any host action; the run self-cancels.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    const outcome = await handle.result;

    expect(outcome.cancellation).toBe('timeout');

    // Exactly one toast, and it is the sanitized, static timeout message.
    expect(toast.messages).toHaveLength(1);
    expect(toast.messages[0]).toBe(TIMEOUT_TOAST_MESSAGE);
    expectSanitized(toast.messages[0] ?? '');

    // No orphaned work after the timeout abort.
    expect(gateway.observedAbort).toBe(true);
    expect(gateway.subscriptionTornDown).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never times out (and never toasts) when no deadline is configured', async () => {
    const { toast, gateway, handle } = startRun(undefined);

    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);

    // A host abort still settles the run silently.
    handle.cancel('unmount');
    const outcome = await handle.result;

    expect(outcome.cancellation).toBe('unmount');
    expect(toast.messages).toEqual([]);
    expect(gateway.subscriptionTornDown).toBe(true);
  });
});

describe('Editor cancellation lifecycle: the first reason wins (Req 17.6)', () => {
  it('keeps the timeout toast and reason when a late unmount arrives afterwards', async () => {
    const { toast, handle } = startRun(TIMEOUT_MS);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    // A late host teardown must not overwrite the reason the user was shown, nor
    // emit a second toast.
    handle.cancel('unmount');
    const outcome = await handle.result;

    expect(outcome.cancellation).toBe('timeout');
    expect(toast.messages).toHaveLength(1);
    expect(toast.messages[0]).toBe(TIMEOUT_TOAST_MESSAGE);
  });

  it('stays silent when unmount wins and a later timer would have fired', async () => {
    const { toast, handle } = startRun(TIMEOUT_MS);

    await Promise.resolve();
    handle.cancel('unmount');
    // Any deadline that would have fired later is already disposed.
    handle.cancel('timeout');
    const outcome = await handle.result;

    expect(outcome.cancellation).toBe('unmount');
    expect(toast.messages).toEqual([]);
  });
});

describe('decideCancellationUi maps each reason to its only outcome', () => {
  it('is silent for unmount and navigation', () => {
    expect(decideCancellationUi('unmount')).toEqual({ kind: 'silent' });
    expect(decideCancellationUi('navigation')).toEqual({ kind: 'silent' });
  });

  it('surfaces a single sanitized toast for timeout', () => {
    const decision = decideCancellationUi('timeout');
    expect(decision).toEqual({ kind: 'toast', message: TIMEOUT_TOAST_MESSAGE });
    if (decision.kind === 'toast') {
      expectSanitized(decision.message);
    }
  });
});

describe('readCancellationReason validates the untrusted abort reason', () => {
  it('reads the branded reason back off an aborted signal', () => {
    const controller = new AbortController();
    controller.abort(cancellationSignalReason('timeout'));
    expect(readCancellationReason(controller.signal)).toBe('timeout');
  });

  it('returns null for a non-aborted signal', () => {
    expect(readCancellationReason(new AbortController().signal)).toBeNull();
  });

  it('fails safe to null for a foreign (unbranded) abort reason', () => {
    const controller = new AbortController();
    // A raw transport abort (e.g. a DOMException or plain string) is not ours.
    controller.abort('some transport-level reason');
    expect(readCancellationReason(controller.signal)).toBeNull();
  });
});
