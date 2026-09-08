// The Editor's request-cancellation lifecycle (Design: Error Handling, streaming
// and cancellation; Req 17.6).
//
// One `AbortController` is created per long run. It is cancelled on exactly one
// of three occasions, each tagged with its REASON so the UI can react correctly:
//
//   - `unmount`     - the component was torn down (silent; no user-facing error)
//   - `navigation`  - the user navigated away        (silent; no user-facing error)
//   - `timeout`     - the run outran its deadline     (single sanitized toast)
//
// The reason is carried on the abort signal itself (`AbortController.abort(reason)`)
// as a branded marker object, so any consumer - here or across the SSE boundary -
// reads the same authoritative reason from `signal.reason` and never has to infer
// it. The reason is validated at every read (`readCancellationReason`) rather than
// trusted, because `signal.reason` is `unknown` and a stray transport-level abort
// (e.g. a raw `DOMException`) must fail safe to "unknown", never to a wrong toast.
//
// The reason -> UI decision (`decideCancellationUi`) is a PURE, total function so
// the lifecycle behavior is testable without a browser, a timer, or a network.

/** The three, and only three, occasions that cancel a run. */
export type CancellationReason = 'unmount' | 'navigation' | 'timeout';

/**
 * The UI's response to a cancellation.
 *
 * `silent` renders nothing (unmount/navigation are expected teardown); `toast`
 * surfaces a single sanitized message (timeout only). No variant ever carries an
 * internal host, path, stack trace, or secret.
 */
export type CancellationUiDecision =
  { readonly kind: 'silent' } | { readonly kind: 'toast'; readonly message: string };

/**
 * The one sanitized message shown on a timeout abort. A fixed, static constant:
 * it is chosen by reason alone and never interpolates internal state.
 */
export const TIMEOUT_TOAST_MESSAGE =
  'The run took too long and was cancelled. Please try again.' as const;

/** The brand key under which a run's cancellation reason rides on `signal.reason`. */
const CANCELLATION_REASON_KEY = Symbol('editor.cancellationReason');

/** The marker object stored as an abort reason; recognized only by its brand. */
interface BrandedCancellationReason {
  readonly [CANCELLATION_REASON_KEY]: CancellationReason;
}

/** Build the branded abort reason threaded through `AbortController.abort`. */
export function cancellationSignalReason(reason: CancellationReason): BrandedCancellationReason {
  return { [CANCELLATION_REASON_KEY]: reason };
}

/** Narrow an untrusted value to a known `CancellationReason`. */
function isCancellationReason(value: unknown): value is CancellationReason {
  return value === 'unmount' || value === 'navigation' || value === 'timeout';
}

/**
 * Read the cancellation reason off an abort signal, or `null` when the signal is
 * not aborted or was aborted without our branded reason.
 *
 * Validation, not trust: `signal.reason` is `unknown`, so a non-object reason or a
 * foreign brand yields `null` and the caller treats it as a non-cancellation
 * (fail safe), never as a wrong reason.
 */
export function readCancellationReason(signal: AbortSignal): CancellationReason | null {
  if (!signal.aborted) {
    return null;
  }
  const reason: unknown = signal.reason;
  if (typeof reason !== 'object' || reason === null) {
    return null;
  }
  const branded = (reason as Record<PropertyKey, unknown>)[CANCELLATION_REASON_KEY];
  return isCancellationReason(branded) ? branded : null;
}

/**
 * Decide the UI response to a cancellation reason (pure, total).
 *
 * Unmount and navigation are silent; a timeout surfaces one sanitized toast. This
 * is the single decision point the lifecycle and its tests state over.
 */
export function decideCancellationUi(reason: CancellationReason): CancellationUiDecision {
  switch (reason) {
    case 'unmount':
    case 'navigation':
      return { kind: 'silent' };
    case 'timeout':
      return { kind: 'toast', message: TIMEOUT_TOAST_MESSAGE };
    default:
      return assertNever(reason);
  }
}

/** An opaque timer handle, so the scheduler can be faked in tests. */
export type TimerHandle = ReturnType<typeof setTimeout>;

/** An injectable timer, so the timeout path is deterministic under test. */
export interface TimeoutScheduler {
  readonly set: (handler: () => void, delayMs: number) => TimerHandle;
  readonly clear: (handle: TimerHandle) => void;
}

/** The default scheduler, backed by the host's `setTimeout`/`clearTimeout`. */
export const defaultTimeoutScheduler: TimeoutScheduler = {
  set: (handler, delayMs) => setTimeout(handler, delayMs),
  clear: (handle) => clearTimeout(handle),
};

/** Options for a single run's cancellation controller. */
export interface RunCancellationOptions {
  /** Deadline after which the run self-cancels with reason `timeout`. */
  readonly timeoutMs?: number;
  /** Injected timer; defaults to the host's `setTimeout`. */
  readonly scheduler?: TimeoutScheduler;
}

/**
 * One run's cancellation controller: a single-shot `AbortController` wired to a
 * timeout and driven by the host for unmount/navigation.
 *
 * The host calls `cancel('unmount')` from its teardown hook and
 * `cancel('navigation')` on route change; the timeout fires `cancel('timeout')`
 * on its own. Cancellation is idempotent - the first reason wins - so a late
 * unmount after a timeout can never overwrite the reason the user was shown.
 * `dispose` releases the timer without aborting, for the normal-completion path,
 * so no timer is ever left dangling.
 */
export class RunCancellation {
  readonly #controller = new AbortController();
  readonly #scheduler: TimeoutScheduler;
  #timer: TimerHandle | null = null;
  #settled = false;

  constructor(options: RunCancellationOptions = {}) {
    this.#scheduler = options.scheduler ?? defaultTimeoutScheduler;
    this.#armTimeout(options.timeoutMs);
  }

  /** The signal threaded into the run (and, via the client, across the SSE seam). */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** Cancel the run with the given reason; the first call wins, later calls no-op. */
  cancel(reason: CancellationReason): void {
    if (this.#settled) {
      return;
    }
    this.#settle();
    this.#controller.abort(cancellationSignalReason(reason));
  }

  /** Release the timer without aborting; used once the run completes normally. */
  dispose(): void {
    this.#settle();
  }

  /** Arm the timeout only for a finite, positive deadline; otherwise no timeout. */
  #armTimeout(timeoutMs: number | undefined): void {
    if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return;
    }
    this.#timer = this.#scheduler.set(() => this.cancel('timeout'), timeoutMs);
  }

  /** Mark settled and clear any pending timer exactly once. */
  #settle(): void {
    this.#settled = true;
    if (this.#timer !== null) {
      this.#scheduler.clear(this.#timer);
      this.#timer = null;
    }
  }
}

/** Exhaustiveness guard: unreachable for a well-typed `CancellationReason`. */
function assertNever(value: never): never {
  throw new Error(`Unhandled cancellation reason: ${String(value)}`);
}
