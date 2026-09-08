// The production `JsonHttpPort`: one POST over the host `fetch`, whose reply is read
// under a hard byte cap (design: vendor adapters isolate their client behind our own
// interface; Req 12.6, 12.9).
//
// `json-http-port.ts` defines the seam and states that deployment injects a concrete
// implementation. This is that implementation, and the only module in the agent layer
// that performs real network I/O. It is deliberately thin: it POSTs the bytes it was
// handed, reads the reply into a bounded raw string, and classifies nothing else.
// Status interpretation and parsing stay with the transport and the reply-boundary
// module, so no half-validated shape can travel upward from here.
//
// THE REPLY IS UNTRUSTED AND OF UNBOUNDED SIZE
//   A remote host can answer with gigabytes. The seam's own contract therefore
//   requires a port to bound what it reads, so the body is pulled off the response
//   stream chunk by chunk and the running byte count is checked BEFORE each chunk is
//   decoded. Reading `response.text()` and slicing afterwards would be no bound at
//   all: the whole reply would already be resident. `Content-Length` is deliberately
//   not trusted as the bound either - a hostile host controls it - so the streamed
//   count is the single enforcement point.
//
// WHAT AN OVER-CAP REPLY BECOMES
//   The read is abandoned, the stream is cancelled so the socket is torn down, and
//   the call REJECTS with `JsonHttpPortError('reply-too-large')`. It never resolves.
//   Truncating and returning what fitted would be the dangerous outcome the seam
//   warns about: a clipped prefix can still parse as a plausible reply, and a caller
//   would read a fabricated answer as the provider's. `exchangeJson` maps this
//   rejection to its redacted `unreachable` outcome, which every transport already
//   classifies as a non-pass, so an over-cap reply can never become a verified result.
//
// NOTHING ABOUT THE CALL ESCAPES IN A FAILURE
//   `request.headers` carries the `Authorization` credential. It is forwarded to
//   `fetch` and referenced nowhere else: never copied, logged, stored, or echoed. The
//   client's own error is dropped and replaced by a `JsonHttpPortError` carrying only
//   a stable code, because a `fetch` rejection routinely names the host, the port, the
//   IP, and the TLS chain. So no rejection from here can carry a URL, a host, a reply
//   body, or a credential.

import {
  hostScheduleTimeout,
  newHostAbortController,
  type AbortSignalLike,
  type HostAbortController,
  type JsonHttpPort,
  type JsonHttpRequest,
  type JsonHttpResponse,
  type ScheduleTimeout,
} from './json-http-port.js';

/** The only HTTP method this port speaks; the seam is POST-JSON by contract. */
const HTTP_METHOD_POST = 'POST';

/**
 * The only URL scheme this port will send to.
 *
 * The request carries a bearer credential, so a cleartext URL is refused before any
 * connection is opened rather than trusted to be a local convenience.
 */
const REQUIRED_URL_SCHEME = 'https://';

/**
 * Redirects are refused rather than followed.
 *
 * A JSON API endpoint has no reason to redirect a credentialed POST, and following
 * one would re-send the `Authorization` header to a host the caller never named.
 */
const REDIRECT_MODE = 'error';

/** The DOM event a real `AbortSignal` fires when it is aborted. */
const ABORT_EVENT = 'abort';

/** One mebibyte, named so the cap below is not a bare literal. */
const BYTES_PER_MIB = 1_048_576;

/**
 * Default cap on the bytes read into `JsonHttpResponse.body`.
 *
 * A completion at the transport's default 6000-token cap is tens of kilobytes, so one
 * mebibyte leaves roughly two orders of magnitude of headroom for long replies and
 * verbose reasoning traces while keeping a hostile reply far below anything that
 * threatens the process. A run configured for much larger outputs raises it
 * explicitly through `FetchJsonHttpPortDeps.maxReplyBytes`.
 */
export const DEFAULT_MAX_REPLY_BYTES = BYTES_PER_MIB;

/** Why one exchange could not produce a reply. Stable, and safe to surface. */
export type JsonHttpPortFailureCode =
  'host-unsupported' | 'insecure-url' | 'reply-too-large' | 'deadline-exceeded' | 'request-failed';

/**
 * The only error this port rejects with.
 *
 * It carries a classification and nothing else: no URL, host, header, reply body, or
 * underlying client error. That is what makes it safe to log or trace at any layer.
 */
export class JsonHttpPortError extends Error {
  readonly code: JsonHttpPortFailureCode;

  constructor(code: JsonHttpPortFailureCode) {
    super(`json http port could not complete the exchange: ${code}`);
    this.name = 'JsonHttpPortError';
    this.code = code;
  }
}

/** The request init this port passes to the host `fetch`. */
export interface HostFetchInit {
  readonly method: string;
  /** Forwarded as given; it may carry a credential, so it is never copied or read. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly redirect: 'error' | 'follow' | 'manual';
  readonly signal?: AbortSignalLike;
}

/** The byte reader this port pulls a bounded reply off, one chunk at a time. */
export interface HostByteReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>;
  /** Discards the rest of the reply and tears down the underlying connection. */
  cancel(): Promise<void>;
}

/** The reply byte stream; `null` on a reply that carries no body at all. */
export interface HostByteStream {
  getReader(): HostByteReader;
}

/** The subset of a `fetch` response this port reads. */
export interface HostFetchResponse {
  readonly status: number;
  readonly body: HostByteStream | null;
}

/**
 * The host `fetch`, narrowed to what this port uses.
 *
 * Declared structurally so the agent layer needs no DOM or Node global typings; the
 * standard `fetch` satisfies it. Injectable so a test drives every path with no
 * network, and so a deployment may wrap it (a proxy, a signer, metrics) without this
 * module knowing.
 */
export type HostFetch = (url: string, init: HostFetchInit) => Promise<HostFetchResponse>;

/** Decodes reply bytes to text, incrementally, without a runtime-specific typing. */
interface HostTextDecoder {
  decode(input?: Uint8Array, options?: { readonly stream?: boolean }): string;
}

/** The host constructor shape; absent on a runtime with no text decoding. */
type HostTextDecoderCtor = new () => HostTextDecoder;

/** The subscribe surface a real `AbortSignal` has and `AbortSignalLike` does not. */
interface AbortSubscriber extends AbortSignalLike {
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

/** Everything one port instance needs; all optional, all injected, no globals. */
export interface FetchJsonHttpPortDeps {
  /**
   * Largest reply read into `body`, in bytes; defaults to `DEFAULT_MAX_REPLY_BYTES`.
   * A reply that exceeds it is rejected, never truncated.
   */
  readonly maxReplyBytes?: number;
  /** The HTTP client; defaults to the host `fetch`, resolved per call. */
  readonly fetch?: HostFetch;
  /** Deadline timer; defaults to the host timer. */
  readonly scheduleTimeout?: ScheduleTimeout;
}

/** Dependencies after validation and defaulting. */
interface ResolvedDeps {
  readonly maxReplyBytes: number;
  /** Null means "take the host `fetch` at call time", so a late polyfill still works. */
  readonly fetch: HostFetch | null;
  readonly scheduleTimeout: ScheduleTimeout;
}

/** A function that does nothing, for the paths where nothing was ever registered. */
function noop(): void {
  // Nothing was armed or subscribed, so nothing needs releasing.
}

/** The host `fetch`, or null when the runtime provides none. */
function hostFetch(): HostFetch | null {
  const found = (globalThis as { fetch?: HostFetch }).fetch;
  return typeof found === 'function' ? found : null;
}

/**
 * A FRESH host text decoder, or null when the runtime provides none.
 *
 * One decoder per call, never hoisted into the instance: an incremental decoder holds
 * the partial multi-byte character between chunks, so sharing one across concurrent
 * calls would let one reply's trailing bytes corrupt another's body.
 */
function newHostTextDecoder(): HostTextDecoder | null {
  const ctor = (globalThis as { TextDecoder?: HostTextDecoderCtor }).TextDecoder;
  return typeof ctor === 'function' ? new ctor() : null;
}

/** Reject a wiring mistake loudly at composition time rather than once per call. */
function resolveMaxReplyBytes(configured: number | undefined): number {
  if (configured === undefined) {
    return DEFAULT_MAX_REPLY_BYTES;
  }
  if (!Number.isInteger(configured) || configured < 1) {
    throw new Error(
      'Model_Router wiring error: fetch json http port was given a non-positive reply byte cap',
    );
  }
  return configured;
}

/** Default every optional collaborator exactly once, so no call site re-decides. */
function resolveDeps(deps: FetchJsonHttpPortDeps): ResolvedDeps {
  return {
    maxReplyBytes: resolveMaxReplyBytes(deps.maxReplyBytes),
    fetch: deps.fetch ?? null,
    scheduleTimeout: deps.scheduleTimeout ?? hostScheduleTimeout,
  };
}

/**
 * Bridge the caller's cancellation onto the controller whose signal `fetch` received.
 *
 * The seam types a signal as `AbortSignalLike`, which exposes only `aborted`, so the
 * subscription is attempted structurally: a real `AbortSignal` is bridged and a bare
 * `AbortSignalLike` is not. That degradation is safe rather than silent - an
 * already-aborted signal is refused before the call is made, and the port's own
 * deadline still bounds an in-flight call - so the worst case is a late abort landing
 * one deadline later instead of at once. Returns the unsubscribe function, so a
 * settled call leaves no listener on a signal the caller may reuse.
 */
function linkAbort(
  signal: AbortSignalLike | undefined,
  controller: HostAbortController | null,
): () => void {
  if (signal === undefined || controller === null) {
    return noop;
  }
  const subscriber = signal as AbortSubscriber;
  if (typeof subscriber.addEventListener !== 'function') {
    return noop;
  }
  const forward = (): void => controller.abort();
  subscriber.addEventListener(ABORT_EVENT, forward);
  return () => subscriber.removeEventListener?.(ABORT_EVENT, forward);
}

/**
 * Arm the port's own deadline, so a stalled socket is torn down here too.
 *
 * Defense in depth: `exchangeJson` already bounds the exchange, but a caller that
 * invokes the port directly gets the same protection. An unusable `timeoutMs` arms
 * nothing rather than inventing a deadline the caller never asked for or failing the
 * call over a number the port does not own.
 */
function armDeadline(
  scheduleTimeout: ScheduleTimeout,
  timeoutMs: number,
  onDeadline: () => void,
): () => void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return noop;
  }
  return scheduleTimeout(onDeadline, timeoutMs);
}

/** The fetch init for one call; the credential-bearing headers pass straight through. */
function buildInit(request: JsonHttpRequest, signal: AbortSignalLike | undefined): HostFetchInit {
  return {
    method: HTTP_METHOD_POST,
    headers: request.headers,
    body: request.body,
    redirect: REDIRECT_MODE,
    ...(signal === undefined ? {} : { signal }),
  };
}

/**
 * Cancel the reader, dropping a cancel failure on purpose.
 *
 * The reply is already being discarded, so a failed cancel leaves nothing to act on,
 * and its reason can name the host. It is therefore dropped here rather than surfaced
 * or logged - the outcome the caller sees is decided by `code` alone.
 */
async function cancelQuietly(reader: HostByteReader): Promise<void> {
  await reader.cancel().catch(() => undefined);
}

/**
 * Read the reply as text, refusing to hold more than `maxReplyBytes` of it.
 *
 * The byte count is checked before each chunk is decoded, so at most one chunk beyond
 * the cap is ever resident. Decoding is incremental, so a multi-byte character split
 * across two chunks still decodes correctly instead of becoming a corrupt body that
 * the reply boundary would then blame on the provider.
 */
async function readBoundedText(
  stream: HostByteStream | null,
  maxReplyBytes: number,
  decoder: HostTextDecoder,
): Promise<string> {
  if (stream === null) {
    return '';
  }
  const reader = stream.getReader();
  let text = '';
  let bytesRead = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.value !== undefined) {
      bytesRead += chunk.value.length;
      if (bytesRead > maxReplyBytes) {
        await cancelQuietly(reader);
        throw new JsonHttpPortError('reply-too-large');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    if (chunk.done) {
      return text + decoder.decode();
    }
  }
}

/**
 * The redacted failure for a call that did not produce a bounded reply.
 *
 * Our own classification is preserved; anything else is replaced, because a client or
 * stream error can embed the URL, the host, the TLS chain, or an echoed credential.
 * Dropping it is the point of this boundary, not an oversight.
 */
function portFailure(cause: unknown, deadlineExceeded: boolean): JsonHttpPortError {
  if (cause instanceof JsonHttpPortError) {
    return cause;
  }
  return new JsonHttpPortError(deadlineExceeded ? 'deadline-exceeded' : 'request-failed');
}

/** Perform one POST and return its status with a bounded body. */
async function exchange(deps: ResolvedDeps, request: JsonHttpRequest): Promise<JsonHttpResponse> {
  const send = deps.fetch ?? hostFetch();
  const decoder = newHostTextDecoder();
  if (send === null || decoder === null) {
    throw new JsonHttpPortError('host-unsupported');
  }
  if (!request.url.startsWith(REQUIRED_URL_SCHEME)) {
    throw new JsonHttpPortError('insecure-url');
  }
  if (request.signal?.aborted === true) {
    throw new JsonHttpPortError('request-failed');
  }
  const controller = newHostAbortController();
  const release = linkAbort(request.signal, controller);
  let deadlineExceeded = false;
  const cancelTimer = armDeadline(deps.scheduleTimeout, request.timeoutMs, () => {
    deadlineExceeded = true;
    controller?.abort();
  });
  try {
    const response = await send(request.url, buildInit(request, controller?.signal));
    const body = await readBoundedText(response.body, deps.maxReplyBytes, decoder);
    return { status: response.status, body };
  } catch (cause) {
    throw portFailure(cause, deadlineExceeded);
  } finally {
    cancelTimer();
    release();
  }
}

/**
 * Build the production `JsonHttpPort` over the host `fetch`.
 *
 * An illegal byte cap throws HERE, at composition time, so a wiring mistake can never
 * masquerade as a provider outage. Every other failure - including a host with no
 * `fetch` - arrives as a rejected `JsonHttpPortError`, which is the seam's documented
 * failure channel and which `exchangeJson` turns into a redacted outcome.
 */
export function createFetchJsonHttpPort(deps: FetchJsonHttpPortDeps = {}): JsonHttpPort {
  const resolved = resolveDeps(deps);
  return (request) => exchange(resolved, request);
}
