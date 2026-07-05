// Bridge from an observer-style subscription to an `AsyncIterable` (Design: OD-6
// streaming; Editor).
//
// The tRPC vanilla client exposes subscriptions through observer callbacks
// (`onData`/`onError`/`onComplete`) and an `unsubscribe` handle, but the Editor's
// stream consumer and the design's `EditorClient` interface are defined over an
// `AsyncIterable`. This module adapts one to the other with a small backpressure
// buffer so events are never dropped between `next()` calls, and it wires an
// `AbortSignal` to tear the subscription down promptly - even while a `next()` is
// pending - satisfying the AbortController lifecycle expectation for streams.

/** The observer a subscription pushes events into. */
export interface StreamObserver<T> {
  readonly onData: (value: T) => void;
  readonly onError: (error: unknown) => void;
  readonly onComplete: () => void;
}

/** A live subscription that can be torn down. */
export interface Subscription {
  readonly unsubscribe: () => void;
}

/** Starts a subscription against the given observer. */
export type Subscribe<T> = (observer: StreamObserver<T>) => Subscription;

/**
 * Adapt an observer-style `subscribe` into an `AsyncIterable`.
 *
 * Each iterator drives its own subscription; aborting `signal` completes the
 * iterator and unsubscribes, so a consumer blocked in `next()` is released.
 */
export function observerToAsyncIterable<T>(
  subscribe: Subscribe<T>,
  signal?: AbortSignal,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<T> => new PushStreamIterator(subscribe, signal),
  };
}

/** A pending `next()` awaiting either a value or a terminal signal. */
interface Waiter<T> {
  readonly resolve: (result: IteratorResult<T>) => void;
  readonly reject: (error: unknown) => void;
}

/** Buffers pushed events and hands them to `next()` callers in order. */
class PushStreamIterator<T> implements AsyncIterator<T> {
  readonly #buffer: T[] = [];
  readonly #waiters: Waiter<T>[] = [];
  #state: 'open' | 'done' | 'error' = 'open';
  #error: Error | null = null;
  #subscription: Subscription | null = null;
  readonly #signal: AbortSignal | undefined;
  readonly #onAbort: () => void;

  constructor(subscribe: Subscribe<T>, signal?: AbortSignal) {
    this.#signal = signal;
    this.#onAbort = (): void => this.#complete();
    if (signal?.aborted === true) {
      this.#state = 'done';
      return;
    }
    signal?.addEventListener('abort', this.#onAbort, { once: true });
    this.#subscription = subscribe({
      onData: (value: T): void => this.#push(value),
      onError: (error: unknown): void => this.#fail(error),
      onComplete: (): void => this.#complete(),
    });
  }

  next(): Promise<IteratorResult<T>> {
    const buffered = this.#buffer.shift();
    if (buffered !== undefined) {
      return Promise.resolve({ value: buffered, done: false });
    }
    if (this.#state === 'error' && this.#error !== null) {
      this.#state = 'done';
      return Promise.reject(this.#error);
    }
    if (this.#state === 'done') {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  /** Called by the consumer's `finally`; tears the subscription down. */
  return(): Promise<IteratorResult<T>> {
    this.#complete();
    return Promise.resolve({ value: undefined, done: true });
  }

  #push(value: T): void {
    if (this.#state !== 'open') {
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {
      this.#buffer.push(value);
      return;
    }
    waiter.resolve({ value, done: false });
  }

  #fail(error: unknown): void {
    if (this.#state !== 'open') {
      return;
    }
    // Preserve an upstream Error as-is (tRPC errors are Errors); normalize any
    // other rejection reason so consumers always receive an Error.
    this.#error = error instanceof Error ? error : new Error(String(error));
    this.#state = 'error';
    this.#teardown();
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(this.#error);
    }
  }

  #complete(): void {
    if (this.#state === 'done') {
      return;
    }
    this.#state = 'done';
    this.#teardown();
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  #teardown(): void {
    this.#signal?.removeEventListener('abort', this.#onAbort);
    this.#subscription?.unsubscribe();
    this.#subscription = null;
  }
}
