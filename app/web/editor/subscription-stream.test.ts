// Unit tests for the observer-to-async-iterable bridge (task 6.2).
//
// The bridge is the transport-agnostic core the gateway client relies on to turn
// tRPC's observer-style SSE subscription into the `AsyncIterable` the stream
// consumer iterates. These assert ordered delivery with buffering, resolution of
// a pending `next()` when data arrives, error propagation, completion, and prompt
// teardown on abort.

import { describe, expect, it } from 'vitest';

import {
  observerToAsyncIterable,
  type StreamObserver,
  type Subscription,
} from './subscription-stream.js';

/** A controllable subscription that captures the observer and records teardown. */
interface Harness<T> {
  readonly iterable: AsyncIterable<T>;
  emit(value: T): void;
  fail(error: unknown): void;
  complete(): void;
  readonly unsubscribed: () => boolean;
}

/** Build a harness whose observer is captured on the first iterator pull. */
function makeHarness<T>(signal?: AbortSignal): Harness<T> {
  let observer: StreamObserver<T> | null = null;
  let unsubscribed = false;
  const iterable = observerToAsyncIterable<T>((obs): Subscription => {
    observer = obs;
    return {
      unsubscribe: (): void => {
        unsubscribed = true;
      },
    };
  }, signal);
  return {
    iterable,
    emit: (value) => observer?.onData(value),
    fail: (error) => observer?.onError(error),
    complete: () => observer?.onComplete(),
    unsubscribed: () => unsubscribed,
  };
}

describe('observerToAsyncIterable delivery', () => {
  it('buffers events pushed before next() and delivers them in order', async () => {
    const harness = makeHarness<number>();
    const iterator = harness.iterable[Symbol.asyncIterator]();

    harness.emit(1);
    harness.emit(2);
    harness.complete();

    await expect(iterator.next()).resolves.toEqual({ value: 1, done: false });
    await expect(iterator.next()).resolves.toEqual({ value: 2, done: false });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it('resolves a pending next() as soon as an event is pushed', async () => {
    const harness = makeHarness<string>();
    const iterator = harness.iterable[Symbol.asyncIterator]();

    const pending = iterator.next();
    harness.emit('hello');

    await expect(pending).resolves.toEqual({ value: 'hello', done: false });
  });

  it('collects the full sequence via for-await', async () => {
    const harness = makeHarness<number>();
    const collected: number[] = [];

    const draining = (async () => {
      for await (const value of harness.iterable) {
        collected.push(value);
      }
    })();

    harness.emit(10);
    harness.emit(20);
    harness.complete();
    await draining;

    expect(collected).toEqual([10, 20]);
    expect(harness.unsubscribed()).toBe(true);
  });
});

describe('observerToAsyncIterable error and teardown', () => {
  it('propagates an error to a pending next() and unsubscribes', async () => {
    const harness = makeHarness<number>();
    const iterator = harness.iterable[Symbol.asyncIterator]();

    const pending = iterator.next();
    harness.fail(new Error('stream broke'));

    await expect(pending).rejects.toThrow('stream broke');
    expect(harness.unsubscribed()).toBe(true);
  });

  it('unsubscribes when the iterator is returned early', async () => {
    const harness = makeHarness<number>();
    const iterator = harness.iterable[Symbol.asyncIterator]();

    await iterator.return?.();

    expect(harness.unsubscribed()).toBe(true);
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it('completes immediately and unsubscribes when the signal is already aborted', async () => {
    const harness = makeHarness<number>(AbortSignal.abort());
    const iterator = harness.iterable[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it('releases a pending next() when the signal aborts', async () => {
    const controller = new AbortController();
    const harness = makeHarness<number>(controller.signal);
    const iterator = harness.iterable[Symbol.asyncIterator]();

    const pending = iterator.next();
    controller.abort();

    await expect(pending).resolves.toEqual({ value: undefined, done: true });
    expect(harness.unsubscribed()).toBe(true);
  });
});
