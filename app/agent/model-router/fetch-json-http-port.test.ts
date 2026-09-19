// Unit tests for the production `JsonHttpPort` (design: vendor adapters isolate their
// client behind our own interface; Req 12.6, 12.9).
//
// NO REAL NETWORK I/O. Every example injects a fake `fetch` and drives the deadline by
// hand, so no test opens a socket or waits on real time. The one example that must
// observe a host WITHOUT `fetch` removes the global for its duration and restores it,
// which also makes a real call impossible while it runs. The credential here is a
// synthetic string, used only to prove it never escapes.
//
// What these examples pin: the outbound POST carries the given url, headers, and body
// unchanged and refuses redirects; the reply status passes through unjudged; the reply
// body is bounded by a real streamed byte cap and an over-cap reply REJECTS rather than
// arriving truncated; a caller abort and the port's own deadline both tear the
// in-flight call down; a host with no `fetch` fails through the seam's documented
// rejection channel; a throttling host's `Retry-After` arrives as a bounded number of
// milliseconds while every other reply header stays behind; and no failure value carries
// the credential, the URL, the host, or the provider's body.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_REPLY_BYTES,
  JsonHttpPortError,
  MAX_HONOURED_RETRY_AFTER_MS,
  createFetchJsonHttpPort,
  type HostByteReader,
  type HostByteStream,
  type HostFetch,
  type HostFetchInit,
  type HostFetchResponse,
  type HostHeaderReader,
} from './fetch-json-http-port.js';
import {
  newHostAbortController,
  type AbortSignalLike,
  type JsonHttpPort,
  type JsonHttpRequest,
  type JsonHttpResponse,
  type ScheduleTimeout,
} from './json-http-port.js';

// -- Fixtures ---------------------------------------------------------------

/** A synthetic credential. Never a real token; used to prove it never leaks. */
const SYNTHETIC_CREDENTIAL = 'synthetic-bearer-value-for-tests';

/** The endpoint a transport would build; https, as the port requires. */
const SECURE_URL = 'https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions';

/** The credential-bearing headers a transport hands the port. */
const HEADERS: Readonly<Record<string, string>> = {
  Authorization: `Bearer ${SYNTHETIC_CREDENTIAL}`,
  'Content-Type': 'application/json',
};

/** The already-serialized JSON body the port must POST unchanged. */
const REQUEST_BODY = JSON.stringify({ model: 'zai.glm-5', messages: [] });

/** The per-call deadline a transport supplies. */
const TIMEOUT_MS = 240_000;

/** A reply body a healthy provider would send. */
const REPLY_BODY = JSON.stringify({ choices: [{ message: { content: 'module m; endmodule' } }] });

/** A marker planted in a client error and a provider error body; must never surface. */
const HOST_DETAIL = 'connect ECONNREFUSED 10.0.0.7:443 while POSTing to api.aws';

/** Substrings no failure value may contain. */
const FORBIDDEN_IN_FAILURE: readonly string[] = [
  SYNTHETIC_CREDENTIAL,
  'Bearer',
  'api.aws',
  'https://',
  '10.0.0.7',
];

/** Byte cap used by the bounding examples, small enough to reach with two chunks. */
const SMALL_CAP_BYTES = 16;

/** A `Retry-After` in the delta-seconds form, and the delay it must become. */
const RETRY_AFTER_SECONDS = '30';
const RETRY_AFTER_SECONDS_MS = 30_000;

/**
 * The RFC 7231 HTTP-date example, with its instant hardcoded.
 *
 * Hardcoded rather than derived with `Date.parse`, so the expected delay is a fixture
 * rather than a second copy of the behaviour under test.
 */
const RETRY_AFTER_DATE = 'Sun, 06 Nov 1994 08:49:37 GMT';
const RETRY_AFTER_DATE_MS = 784_111_777_000;

/** The same date with its time zone stripped, which is not a legal HTTP-date. */
const RETRY_AFTER_DATE_NO_ZONE = 'Sun, 06 Nov 1994 08:49:37';

/** Where the injected clock sits in the accepted HTTP-date example, and so the delay. */
const BEFORE_DATE_MS = 45_000;

/** A day, as the header would ask for it and as milliseconds; far beyond the ceiling. */
const A_DAY_SECONDS = 86_400;
const A_DAY_MS = A_DAY_SECONDS * 1_000;

/**
 * The headers a throttling reply really carries.
 *
 * Deliberately credential-adjacent and fingerprintable beyond the one hint we act on:
 * the containment example asserts that none of the rest travels upward.
 */
const THROTTLED_HEADERS: Readonly<Record<string, string>> = {
  'Retry-After': RETRY_AFTER_SECONDS,
  'Set-Cookie': `session=${SYNTHETIC_CREDENTIAL}`,
  'WWW-Authenticate': 'Bearer realm="api.aws"',
  'x-amzn-RequestId': '7f9c2b21-0b3e-4a11-9a3f-2f1d0c5e8a44',
};

/** ASCII bytes of a fixture body; every fixture string here is ASCII by construction. */
function asciiBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index);
  }
  return bytes;
}

/** Build a request, defaulting everything a transport would supply. */
function requestTo(
  options: {
    readonly url?: string;
    readonly signal?: AbortSignalLike;
    readonly timeoutMs?: number;
  } = {},
): JsonHttpRequest {
  return {
    url: options.url ?? SECURE_URL,
    headers: HEADERS,
    body: REQUEST_BODY,
    timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

// -- Fake host seams (no network, no real time) -----------------------------

/** One recorded outbound call: the url and the init the port built. */
interface RecordedCall {
  readonly url: string;
  readonly init: HostFetchInit;
}

/** The subscribe surface the port's own (real) signal offers a client. */
interface AbortSubscriberLike extends AbortSignalLike {
  addEventListener?: (type: string, listener: () => void) => void;
}

/** A scripted reply stream that records whether the port cancelled it. */
class FakeStream implements HostByteStream {
  readonly #chunks: readonly Uint8Array[];
  #next = 0;
  #cancelled = false;

  constructor(chunks: readonly Uint8Array[]) {
    this.#chunks = chunks;
  }

  /** Whether the port abandoned the read, so an over-cap socket is torn down. */
  get cancelled(): boolean {
    return this.#cancelled;
  }

  getReader(): HostByteReader {
    return {
      read: () => {
        const value = this.#chunks[this.#next];
        if (value === undefined) {
          return Promise.resolve({ done: true });
        }
        this.#next += 1;
        return Promise.resolve({ done: false, value });
      },
      cancel: () => {
        this.#cancelled = true;
        return Promise.resolve();
      },
    };
  }
}

/**
 * A by-name reader over a fixed header set, recording every name it was asked for.
 *
 * Case-insensitive, like the real `Headers` it stands in for, so an example pins the
 * port's containment rather than its choice of spelling. The recorded names are the
 * evidence that the port asks for ONE header instead of enumerating the set - a shape
 * assertion on the reply alone cannot show what was read.
 */
class FakeHeaders implements HostHeaderReader {
  /** Every name the port asked for, in order. */
  readonly asked: string[] = [];
  readonly #values: ReadonlyMap<string, string>;

  constructor(values: Readonly<Record<string, string>>) {
    this.#values = new Map(
      Object.entries(values).map(([name, value]) => [name.toLowerCase(), value]),
    );
  }

  get(name: string): string | null {
    this.asked.push(name);
    return this.#values.get(name.toLowerCase()) ?? null;
  }
}

/**
 * A header accessor that throws, as host-supplied code may.
 *
 * The `Retry-After` hint is advisory, so this must cost the caller the hint and nothing
 * else: a reply the port already read is a paid model call.
 */
const THROWING_HEADERS: HostHeaderReader = {
  get: () => {
    throw new Error(HOST_DETAIL);
  },
};

/** A fake `fetch`: records every call and answers from a script. Performs no I/O. */
class FakeFetch {
  readonly calls: RecordedCall[] = [];
  readonly #reply: (call: RecordedCall) => Promise<HostFetchResponse>;

  constructor(reply: (call: RecordedCall) => Promise<HostFetchResponse>) {
    this.#reply = reply;
  }

  /**
   * A client that answers with the given status and body stream.
   *
   * `headers` is omitted rather than passed as undefined when absent, so the reply is
   * indistinguishable from one built by a client that cannot read headers at all.
   */
  static streaming(
    status: number,
    stream: HostByteStream | null,
    headers?: HostHeaderReader,
  ): FakeFetch {
    return new FakeFetch(() =>
      Promise.resolve({ status, body: stream, ...(headers === undefined ? {} : { headers }) }),
    );
  }

  /** A client that answers with the given status and a single-chunk body. */
  static replying(status: number, body: string, headers?: HostHeaderReader): FakeFetch {
    return FakeFetch.streaming(status, new FakeStream([asciiBytes(body)]), headers);
  }

  /** A client that rejects with a host-naming error, as a real network failure does. */
  static rejecting(): FakeFetch {
    return new FakeFetch(() => Promise.reject(new Error(HOST_DETAIL)));
  }

  /** A client that settles only once the signal it was handed is aborted. */
  static abortAware(): FakeFetch {
    return new FakeFetch(
      (call) =>
        new Promise<HostFetchResponse>((_resolve, reject) => {
          const signal = call.init.signal as AbortSubscriberLike | undefined;
          signal?.addEventListener?.('abort', () => reject(new Error(HOST_DETAIL)));
        }),
    );
  }

  get fetch(): HostFetch {
    return (url, init) => {
      const call = { url, init };
      this.calls.push(call);
      return this.#reply(call);
    };
  }

  /** The single call the port made, failing the test if there was not exactly one. */
  get onlyCall(): RecordedCall {
    const [first] = this.calls;
    if (first === undefined) {
      throw new Error('expected exactly one recorded call');
    }
    return first;
  }
}

/** A deadline the test fires by hand, so no real time ever passes. */
class ManualDeadline {
  #fire: (() => void) | null = null;

  readonly schedule: ScheduleTimeout = (callback) => {
    this.#fire = callback;
    return () => {
      this.#fire = null;
    };
  };

  /** Trip the deadline, as the host timer would when the call runs long. */
  fire(): void {
    this.#fire?.();
  }
}

// -- Assembly ---------------------------------------------------------------

/** Build the port over a fake client and a hand-fired deadline. */
function portOver(
  http: FakeFetch,
  deadline: ManualDeadline = new ManualDeadline(),
  maxReplyBytes?: number,
): JsonHttpPort {
  return createFetchJsonHttpPort({
    fetch: http.fetch,
    scheduleTimeout: deadline.schedule,
    ...(maxReplyBytes === undefined ? {} : { maxReplyBytes }),
  });
}

/**
 * Build the port over a fake client and a FIXED clock.
 *
 * The `Retry-After` HTTP-date form resolves against `deps.now`, so an example that
 * measures one must own the instant; against the real clock the expected delay would be
 * a function of when the suite happened to run. The deadline is still hand-fired, so no
 * real timer is armed here either.
 */
function portWithClockAt(http: FakeFetch, nowMs: number): JsonHttpPort {
  return createFetchJsonHttpPort({
    fetch: http.fetch,
    scheduleTimeout: new ManualDeadline().schedule,
    now: () => nowMs,
  });
}

/** The error a call rejected with, failing the test if it resolved instead. */
async function rejectionOf(pending: Promise<JsonHttpResponse>): Promise<JsonHttpPortError> {
  try {
    await pending;
  } catch (cause) {
    if (cause instanceof JsonHttpPortError) {
      return cause;
    }
    throw new Error('expected the call to reject with a JsonHttpPortError');
  }
  throw new Error('expected the call to reject');
}

/** Assert a failure value carries no credential, URL, host, or provider detail. */
function expectRedacted(error: JsonHttpPortError): void {
  for (const forbidden of FORBIDDEN_IN_FAILURE) {
    expect(error.message).not.toContain(forbidden);
    expect(String(error)).not.toContain(forbidden);
    expect(JSON.stringify(error)).not.toContain(forbidden);
  }
}

/**
 * Run `body` on a host with no `fetch`, restoring the real one afterwards.
 *
 * A host that provides no `fetch` is a fact about the runtime rather than about an
 * injected dependency, so it is the one case that must be observed by removing the
 * global. Removal also makes a real network call impossible while the example runs.
 */
async function withoutHostFetch(body: () => Promise<void>): Promise<void> {
  const host = globalThis as { fetch?: unknown };
  const original = host.fetch;
  delete host.fetch;
  try {
    await body();
  } finally {
    host.fetch = original;
  }
}

// -- The outbound request ---------------------------------------------------

describe('fetch json http port - outbound request', () => {
  it('posts the given body and headers to the given url and returns the raw reply', async () => {
    const http = FakeFetch.replying(200, REPLY_BODY);
    const response = await portOver(http)(requestTo());

    expect(response).toEqual({ status: 200, body: REPLY_BODY });
    expect(http.onlyCall.url).toBe(SECURE_URL);
    expect(http.onlyCall.init.method).toBe('POST');
    expect(http.onlyCall.init.body).toBe(REQUEST_BODY);
    // Forwarded as given: the port neither rewrites nor copies the credential header.
    expect(http.onlyCall.init.headers).toBe(HEADERS);
  });

  it('refuses to follow a redirect, so the credential is never re-sent elsewhere', async () => {
    const http = FakeFetch.replying(200, REPLY_BODY);
    await portOver(http)(requestTo());

    expect(http.onlyCall.init.redirect).toBe('error');
  });

  it('refuses a cleartext url before opening any connection', async () => {
    const http = FakeFetch.replying(200, REPLY_BODY);
    const error = await rejectionOf(portOver(http)(requestTo({ url: 'http://localhost/v1/chat' })));

    expect(error.code).toBe('insecure-url');
    expect(http.calls).toHaveLength(0);
  });
});

// -- Reading the reply ------------------------------------------------------

describe('fetch json http port - reading the reply', () => {
  it('passes a non-2xx status through with its body, judging neither', async () => {
    const http = FakeFetch.replying(500, HOST_DETAIL);
    const response = await portOver(http)(requestTo());

    // Classification belongs to the transport, so the port reports both verbatim.
    expect(response.status).toBe(500);
    expect(response.body).toBe(HOST_DETAIL);
  });

  it('reads an empty body as the empty string when the reply carries no stream', async () => {
    const http = FakeFetch.streaming(204, null);
    const response = await portOver(http)(requestTo());

    expect(response).toEqual({ status: 204, body: '' });
  });

  it('decodes a multi-byte character split across two chunks without corrupting it', async () => {
    // 0xC3 0xA9 is one UTF-8 character; a per-chunk decode would produce two
    // replacement characters and the reply boundary would blame the provider.
    const stream = new FakeStream([
      asciiBytes('{"a":"'),
      new Uint8Array([0xc3]),
      new Uint8Array([0xa9]),
      asciiBytes('"}'),
    ]);
    const response = await portOver(FakeFetch.streaming(200, stream))(requestTo());

    expect(response.body).toBe('{"a":"\u00e9"}');
  });
});

// -- The byte cap ----------------------------------------------------------

describe('fetch json http port - bounded reply', () => {
  it('rejects an over-cap reply instead of returning a truncated body', async () => {
    const stream = new FakeStream([asciiBytes('a'.repeat(16)), asciiBytes('b'.repeat(16))]);
    const http = FakeFetch.streaming(200, stream);
    const error = await rejectionOf(
      portOver(http, new ManualDeadline(), SMALL_CAP_BYTES)(requestTo()),
    );

    expect(error.code).toBe('reply-too-large');
    // The read was abandoned mid-stream, so the socket is torn down rather than drained.
    expect(stream.cancelled).toBe(true);
    expectRedacted(error);
  });

  it('accepts a reply that exactly fills the cap', async () => {
    const body = 'a'.repeat(SMALL_CAP_BYTES);
    const http = FakeFetch.replying(200, body);
    const response = await portOver(http, new ManualDeadline(), SMALL_CAP_BYTES)(requestTo());

    expect(response.body).toBe(body);
  });

  it('rejects a non-positive byte cap at composition time rather than per call', () => {
    const http = FakeFetch.replying(200, REPLY_BODY);
    const build = (maxReplyBytes: number): JsonHttpPort =>
      createFetchJsonHttpPort({ fetch: http.fetch, maxReplyBytes });

    expect(() => build(0)).toThrow(/reply byte cap/);
    expect(() => build(-1)).toThrow(/reply byte cap/);
    expect(() => build(1.5)).toThrow(/reply byte cap/);
    // The default is a real, finite cap, not an absent one.
    expect(DEFAULT_MAX_REPLY_BYTES).toBeGreaterThan(0);
  });
});

// -- Cancellation and the port's own deadline ------------------------------

describe('fetch json http port - cancellation', () => {
  it('makes no call at all when the caller signal is already aborted', async () => {
    const http = FakeFetch.replying(200, REPLY_BODY);
    const error = await rejectionOf(portOver(http)(requestTo({ signal: { aborted: true } })));

    expect(error.code).toBe('request-failed');
    expect(http.calls).toHaveLength(0);
    expectRedacted(error);
  });

  it('tears the in-flight call down when the caller aborts', async () => {
    const caller = newHostAbortController();
    if (caller === null) {
      throw new Error('this host provides no AbortController');
    }
    const http = FakeFetch.abortAware();
    const pending = portOver(http)(requestTo({ signal: caller.signal }));

    caller.abort();
    const error = await rejectionOf(pending);

    expect(error.code).toBe('request-failed');
    expect(http.onlyCall.init.signal?.aborted).toBe(true);
    expectRedacted(error);
  });

  it('aborts the in-flight call when its own deadline fires', async () => {
    const http = FakeFetch.abortAware();
    const deadline = new ManualDeadline();
    const pending = portOver(http, deadline)(requestTo());

    deadline.fire();
    const error = await rejectionOf(pending);

    expect(error.code).toBe('deadline-exceeded');
    expect(http.onlyCall.init.signal?.aborted).toBe(true);
    expectRedacted(error);
  });
});

// -- Failing safe ----------------------------------------------------------

describe('fetch json http port - fails safe and redacted', () => {
  it('reports a rejected client call without its host-naming error', async () => {
    const http = FakeFetch.rejecting();
    const error = await rejectionOf(portOver(http)(requestTo()));

    expect(error.code).toBe('request-failed');
    expectRedacted(error);
  });

  it('rejects through the documented channel on a host with no fetch', async () => {
    await withoutHostFetch(async () => {
      const error = await rejectionOf(createFetchJsonHttpPort()(requestTo()));

      expect(error.code).toBe('host-unsupported');
      expectRedacted(error);
    });
  });
});

// -- The one reply header that travels upward ------------------------------

describe('fetch json http port - the Retry-After instruction', () => {
  it('surfaces a delta-seconds value as a delay in milliseconds', async () => {
    const headers = new FakeHeaders({ 'Retry-After': RETRY_AFTER_SECONDS });
    const http = FakeFetch.replying(429, REPLY_BODY, headers);
    const response = await portWithClockAt(http, RETRY_AFTER_DATE_MS)(requestTo());

    expect(response).toEqual({
      status: 429,
      body: REPLY_BODY,
      retryAfterMs: RETRY_AFTER_SECONDS_MS,
    });
  });

  it('measures an HTTP-date against the injected clock rather than the real one', async () => {
    const headers = new FakeHeaders({ 'Retry-After': RETRY_AFTER_DATE });
    const http = FakeFetch.replying(429, REPLY_BODY, headers);
    const response = await portWithClockAt(http, RETRY_AFTER_DATE_MS - BEFORE_DATE_MS)(requestTo());

    // The remaining duration, in milliseconds and positive: a subtraction the wrong way
    // round would surface a negative here rather than somewhere in a later backoff.
    expect(response.retryAfterMs).toBe(BEFORE_DATE_MS);
  });

  it('refuses an HTTP-date with no time zone, whose instant would vary by host', async () => {
    // The clock sits a full day before the date, further than any zone offset, so the
    // zone-less reading is in the FUTURE on every host. A port that accepted it would
    // therefore report a delay HERE, rather than only on machines whose local offset
    // happens to push the instant forward - which is what made this a real defect.
    const headers = new FakeHeaders({ 'Retry-After': RETRY_AFTER_DATE_NO_ZONE });
    const http = FakeFetch.replying(429, REPLY_BODY, headers);
    const response = await portWithClockAt(http, RETRY_AFTER_DATE_MS - A_DAY_MS)(requestTo());

    expect(response).not.toHaveProperty('retryAfterMs');
  });

  it('clamps a host asking for longer than the honoured ceiling', async () => {
    const headers = new FakeHeaders({ 'Retry-After': String(A_DAY_SECONDS) });
    const http = FakeFetch.replying(429, REPLY_BODY, headers);
    const response = await portWithClockAt(http, RETRY_AFTER_DATE_MS)(requestTo());

    // The ceiling is the denial-of-service guard: an obedient port with no clamp would
    // park an overnight campaign for a day on one untrusted header.
    expect(MAX_HONOURED_RETRY_AFTER_MS).toBeLessThan(A_DAY_MS);
    expect(response.retryAfterMs).toBe(MAX_HONOURED_RETRY_AFTER_MS);
  });

  it('omits the delay when the reply carries no Retry-After', async () => {
    const headers = new FakeHeaders({ 'Content-Type': 'application/json' });
    const http = FakeFetch.replying(200, REPLY_BODY, headers);
    const response = await portWithClockAt(http, RETRY_AFTER_DATE_MS)(requestTo());

    // OMITTED, not reported as null: absence and null already mean the same thing to a
    // caller, and a reply built by a header-reading port must stay identical to one
    // built by a port that cannot read headers.
    expect(response).toEqual({ status: 200, body: REPLY_BODY });
    expect(response).not.toHaveProperty('retryAfterMs');
  });

  it('omits the delay when the reply exposes no headers at all', async () => {
    const http = FakeFetch.replying(200, REPLY_BODY);
    const response = await portWithClockAt(http, RETRY_AFTER_DATE_MS)(requestTo());

    expect(response).toEqual({ status: 200, body: REPLY_BODY });
    expect(response).not.toHaveProperty('retryAfterMs');
  });

  it('reports no instruction when the host accessor throws, keeping the reply it read', async () => {
    const http = FakeFetch.replying(200, REPLY_BODY, THROWING_HEADERS);
    const response = await portWithClockAt(http, RETRY_AFTER_DATE_MS)(requestTo());

    // Resolves with the body. The hint is advisory, so a throw out of host code must not
    // convert a reply we already read - a paid model call - into a transport failure and
    // a pointless retry.
    expect(response).toEqual({ status: 200, body: REPLY_BODY });
  });

  it('carries the parsed delay and no other reply header', async () => {
    const headers = new FakeHeaders(THROTTLED_HEADERS);
    const http = FakeFetch.replying(429, REPLY_BODY, headers);
    const response = await portWithClockAt(http, RETRY_AFTER_DATE_MS)(requestTo());

    // The FULL shape, so a field later added to `JsonHttpResponse` fails here instead of
    // quietly carrying a `Set-Cookie`, a `WWW-Authenticate`, or a request id past a
    // boundary built to let nothing about the call escape.
    expect(response).toEqual({
      status: 429,
      body: REPLY_BODY,
      retryAfterMs: RETRY_AFTER_SECONDS_MS,
    });
    // Asked for by name, exactly once: the port cannot have enumerated the set.
    expect(headers.asked).toEqual(['Retry-After']);
  });
});
