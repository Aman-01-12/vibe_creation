// Our own minimal JSON-over-HTTPS seam for vendor transports (design: vendor
// adapters isolate their SDK behind our interface; Req 12.6, 12.9).
//
// A vendor transport must not embed an HTTP client: it programs to `JsonHttpPort`,
// and deployment injects a concrete implementation (fetch, an SDK, a signed
// client). Tests inject a fake, so no test ever performs real network I/O.
//
// The port speaks in raw strings, never parsed objects, for two reasons: the reply
// is UNTRUSTED and must be validated by its own boundary module before any field is
// read, and a port that never parses cannot leak a half-validated shape upward.
//
// This module also owns the deadline: `exchangeJson` bounds every call with a timer
// and never rejects, so a transport can classify `timeout` itself instead of
// trusting the injected client to honor its own deadline. The raw transport error is
// deliberately dropped at this boundary - it can embed the URL, host, or an echoed
// credential - so only a redacted classification travels onward (Req 12.6).

/**
 * The cancellation signal handed to a JSON HTTP port.
 *
 * Declared structurally so the agent layer needs no runtime-specific global
 * typings; a standard `AbortSignal` satisfies it. A port only forwards it to its
 * HTTP client - nothing in this layer inspects it beyond `aborted`.
 */
export interface AbortSignalLike {
  readonly aborted: boolean;
}

/**
 * One outbound JSON request.
 *
 * `body` is already-serialized JSON. `headers` may carry a credential (an
 * `Authorization` header), so a port implementation must never log, echo, or store
 * this object; it exists only for the duration of the call.
 */
export interface JsonHttpRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** Deadline the port should apply to its own socket, in milliseconds. */
  readonly timeoutMs: number;
  /** Cancellation signal; present when the caller can abort the in-flight call. */
  readonly signal?: AbortSignalLike;
}

/**
 * One raw JSON reply: the HTTP status and the unparsed body.
 *
 * A port implementation MUST bound the number of bytes it reads into `body`, so an
 * oversized or hostile reply cannot exhaust memory before validation runs.
 */
export interface JsonHttpResponse {
  readonly status: number;
  readonly body: string;
}

/**
 * The injected HTTP client seam: POST JSON, return the raw reply.
 *
 * An implementation may reject (network failure, DNS, TLS, its own timeout);
 * `exchangeJson` converts a rejection into a redacted outcome so callers never see
 * a vendor error object.
 */
export type JsonHttpPort = (request: JsonHttpRequest) => Promise<JsonHttpResponse>;

/** Schedules `callback` after `ms` and returns the function that cancels that timer. */
export type ScheduleTimeout = (callback: () => void, ms: number) => () => void;

/** A host timer accessed without depending on a specific runtime's global typings. */
type HostTimer = (callback: () => void, ms: number) => unknown;

/** The matching host canceller, so a settled call never leaves a timer pending. */
type HostTimerCancel = (handle: unknown) => void;

/**
 * The default timer, backed by the host `setTimeout`/`clearTimeout` when present.
 *
 * A host with no timer (an exotic embedding; never Node or a browser) cannot
 * enforce a deadline, so the returned canceller is a no-op and the call is bounded
 * only by the injected client. Deployment may inject its own scheduler instead.
 */
export const hostScheduleTimeout: ScheduleTimeout = (callback, ms) => {
  const schedule = (globalThis as { setTimeout?: HostTimer }).setTimeout;
  if (typeof schedule !== 'function') {
    return () => {
      // Nothing was scheduled on a timer-less host, so nothing needs cancelling.
    };
  }
  const handle = schedule(callback, ms);
  return () => {
    const cancel = (globalThis as { clearTimeout?: HostTimerCancel }).clearTimeout;
    if (typeof cancel === 'function') {
      cancel(handle);
    }
  };
};

/** A host `AbortController`, reached without depending on runtime global typings. */
export interface HostAbortController {
  abort(): void;
  readonly signal: AbortSignalLike;
}

/** The host constructor shape; absent on a runtime without abort support. */
type HostAbortControllerCtor = new () => HostAbortController;

/**
 * Create a host abort controller, or null when the runtime provides none.
 *
 * A transport aborts this on a deadline breach so a timed-out call tears down its
 * in-flight socket instead of leaking it. On a runtime without `AbortController`
 * the call carries no signal and is bounded by the deadline alone.
 */
export function newHostAbortController(): HostAbortController | null {
  const ctor = (globalThis as { AbortController?: HostAbortControllerCtor }).AbortController;
  return typeof ctor === 'function' ? new ctor() : null;
}

/**
 * The outcome of one deadline-guarded exchange, already redacted.
 *
 * `unreachable` covers every way the injected client failed to produce a reply; the
 * underlying error is dropped rather than surfaced, so no host, URL, or credential
 * can escape through it.
 */
export type JsonHttpOutcome =
  | { readonly kind: 'reply'; readonly response: JsonHttpResponse }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'unreachable' };

/** Everything one guarded exchange needs; grouped so the call stays a single param. */
export interface JsonHttpExchange {
  readonly port: JsonHttpPort;
  readonly request: JsonHttpRequest;
  readonly scheduleTimeout: ScheduleTimeout;
  /** Invoked when the deadline fires first, so the caller can abort in-flight work. */
  readonly onTimeout?: () => void;
}

/**
 * Invoke the port, so that even a synchronous throw arrives as a rejection.
 *
 * A port that throws before returning a promise is the same failure as one that
 * rejects, and `exchangeJson` must handle both to keep its never-rejects contract.
 */
function invokePort(port: JsonHttpPort, request: JsonHttpRequest): Promise<JsonHttpResponse> {
  try {
    return port(request);
  } catch {
    // The thrown value is dropped for the same reason a rejection is: it can embed
    // the URL, the host, or an echoed credential. The generic error below never
    // reaches a caller; it only routes into the `unreachable` classification.
    return Promise.reject(new Error('json http port failed'));
  }
}

/**
 * Perform one JSON exchange bounded by `request.timeoutMs`.
 *
 * Never rejects: every failure becomes a redacted `JsonHttpOutcome`, so a caller
 * cannot accidentally propagate a vendor error. The timer is always cancelled once
 * the call settles, so a completed exchange leaves nothing pending.
 */
export function exchangeJson(exchange: JsonHttpExchange): Promise<JsonHttpOutcome> {
  const { port, request, scheduleTimeout, onTimeout } = exchange;
  return new Promise<JsonHttpOutcome>((resolve) => {
    const cancelTimer = scheduleTimeout(() => {
      onTimeout?.();
      resolve({ kind: 'timeout' });
    }, request.timeoutMs);
    void invokePort(port, request).then(
      (response) => {
        cancelTimer();
        resolve({ kind: 'reply', response });
      },
      () => {
        // The rejection value is dropped on purpose, not swallowed by accident: a
        // client error can embed the URL, the host, or an echoed credential, and
        // only the classification below is safe to travel onward (Req 12.6).
        cancelTimer();
        resolve({ kind: 'unreachable' });
      },
    );
  });
}
