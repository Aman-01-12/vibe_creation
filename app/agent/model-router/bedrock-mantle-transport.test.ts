// Unit tests for the bedrock-mantle transport (design: vendor adapters; Req
// 12.6-12.9).
//
// Driven entirely through the injected `JsonHttpPort` and a manually fired deadline
// timer, so NO test performs real network I/O and no test waits on real time. The
// credential used here is a synthetic string, never a real token.
//
// What these examples pin: the outbound request mirrors the reference client's
// contract (`{model, messages, max_tokens, temperature}` with a bearer header); the
// routed model id wins over the instance default; the documented
// `reasoning_content` fallback is read when `content` is empty; real `usage` is
// recorded; cost is computed only from an injected price and is 0 (price unknown)
// otherwise; and every failure - malformed reply, HTTP error, deadline breach,
// missing credential - collapses to a redacted `ProviderCallError` that leaks
// neither the credential, the host, the URL, nor the provider's error body.

import { describe, expect, it } from 'vitest';

import { BedrockMantleAdapter } from './bedrock-mantle-adapter.js';
import {
  createBedrockMantleTransport,
  type BedrockMantleTransportConfig,
  type ModelPriceTable,
} from './bedrock-mantle-transport.js';
import type { ModelRequest, ProviderCallError } from './contract.js';
import { EnvSecretManager, BEDROCK_CREDENTIAL_ENV_KEY } from './env-secret-manager.js';
import type {
  JsonHttpPort,
  JsonHttpRequest,
  JsonHttpResponse,
  ScheduleTimeout,
} from './json-http-port.js';
import type { ProviderTransport } from './remote-adapter.js';
import { scopeToProvider } from './secret-manager.js';

/** A synthetic credential. Never a real token; used to prove it never leaks. */
const SYNTHETIC_CREDENTIAL = 'synthetic-bearer-value-for-tests';

/** The routed model id a call carries, as the routing policy would supply it. */
const ROUTED_MODEL_ID = 'zai.glm-5';

/** The instance default, used only when a call arrives without a routed model id. */
const DEFAULT_MODEL_ID = 'qwen.qwen3-coder-480b-a35b-instruct';

/** A marker planted in a provider error body; must never reach a reason string. */
const PROVIDER_ERROR_BODY = 'internal detail: token synthetic-bearer-value-for-tests at 10.0.0.7';

/** Substrings a redacted failure reason must never contain. */
const FORBIDDEN_IN_REASON: readonly string[] = [
  SYNTHETIC_CREDENTIAL,
  'Bearer',
  'api.aws',
  'https://',
  '10.0.0.7',
];

const BASE_CONFIG: BedrockMantleTransportConfig = {
  region: 'us-east-1',
  defaultModelId: DEFAULT_MODEL_ID,
};

const PROMPT: ModelRequest = { prompt: 'Write a synchronous FIFO.' };

/** A price table where only the routed model is priced, so both paths are testable. */
const PRICES: ModelPriceTable = {
  [ROUTED_MODEL_ID]: { inputCentsPerMillionTokens: 100, outputCentsPerMillionTokens: 400 },
};

/** A JSON body shaped like the provider's reply, with the given message fields. */
function replyBody(message: Readonly<Record<string, unknown>>, usage?: unknown): string {
  return JSON.stringify({
    choices: [{ message }],
    ...(usage === undefined ? {} : { usage }),
  });
}

/** The usage block a successful call reports. */
const USAGE = { prompt_tokens: 1_000, completion_tokens: 2_000, total_tokens: 3_000 };

/**
 * A fake HTTP client: records every request and replies from a script.
 *
 * It performs no I/O, so the transport is exercised end to end with no network.
 */
class FakeJsonHttp {
  readonly requests: JsonHttpRequest[] = [];
  readonly #reply: (request: JsonHttpRequest) => Promise<JsonHttpResponse>;

  constructor(reply: (request: JsonHttpRequest) => Promise<JsonHttpResponse>) {
    this.#reply = reply;
  }

  /** A reply-with-this-body-and-status client. */
  static replying(status: number, body: string): FakeJsonHttp {
    return new FakeJsonHttp(() => Promise.resolve({ status, body }));
  }

  /** A client whose call never settles, so only the deadline can end the exchange. */
  static hanging(): FakeJsonHttp {
    return new FakeJsonHttp(() => new Promise<JsonHttpResponse>(() => undefined));
  }

  /** A client that rejects, standing in for a network, DNS, or TLS failure. */
  static failing(): FakeJsonHttp {
    return new FakeJsonHttp(() => Promise.reject(new Error(PROVIDER_ERROR_BODY)));
  }

  get port(): JsonHttpPort {
    return (request) => {
      this.requests.push(request);
      return this.#reply(request);
    };
  }

  /** The single request the transport made, failing the test if there was not one. */
  get onlyRequest(): JsonHttpRequest {
    const [first] = this.requests;
    if (first === undefined) {
      throw new Error('expected exactly one recorded request');
    }
    return first;
  }
}

/** A deadline timer the test fires by hand, so no real time ever passes. */
class ManualDeadline {
  #fire: (() => void) | null = null;
  #cancelled = false;

  readonly schedule: ScheduleTimeout = (callback) => {
    this.#fire = callback;
    return () => {
      this.#cancelled = true;
    };
  };

  /** Trip the deadline, as the host timer would when the call runs long. */
  fire(): void {
    this.#fire?.();
  }

  /** Whether the transport cancelled the timer, so a settled call leaves none pending. */
  get cancelled(): boolean {
    return this.#cancelled;
  }
}

/** Build a transport over the fake client, with the manual deadline and given config. */
function transportOver(
  http: FakeJsonHttp,
  deadline: ManualDeadline,
  config: BedrockMantleTransportConfig = BASE_CONFIG,
): ProviderTransport {
  return createBedrockMantleTransport({
    config,
    http: http.port,
    scheduleTimeout: deadline.schedule,
  });
}

/** Invoke a transport the way the router does: with a routed model id. */
function callWith(
  transport: ProviderTransport,
  modelId: string = ROUTED_MODEL_ID,
): ReturnType<ProviderTransport> {
  return transport({ credential: SYNTHETIC_CREDENTIAL, request: PROMPT, modelId });
}

/** Invoke a transport the way a directly driven adapter does: with no routed model id. */
function callUnrouted(transport: ProviderTransport): ReturnType<ProviderTransport> {
  return transport({ credential: SYNTHETIC_CREDENTIAL, request: PROMPT });
}

/** Assert a reason is redacted: no credential, host, URL, or provider body detail. */
function expectRedacted(error: ProviderCallError): void {
  for (const forbidden of FORBIDDEN_IN_REASON) {
    expect(error.reason).not.toContain(forbidden);
  }
}

// --- The outbound request --------------------------------------------------

describe('bedrock-mantle transport - outbound request', () => {
  it('posts the reference contract to the regional chat completions endpoint', async () => {
    const http = FakeJsonHttp.replying(200, replyBody({ content: 'module m; endmodule' }, USAGE));
    const result = await callWith(transportOver(http, new ManualDeadline()));

    expect(result.ok).toBe(true);
    const request = http.onlyRequest;
    expect(request.url).toBe('https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions');
    expect(request.headers.Authorization).toBe(`Bearer ${SYNTHETIC_CREDENTIAL}`);
    expect(request.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(request.body)).toEqual({
      model: ROUTED_MODEL_ID,
      messages: [{ role: 'user', content: PROMPT.prompt }],
      max_tokens: 6_000,
      temperature: 0,
    });
  });

  it('uses the instance default model only when no model id is routed', async () => {
    const http = FakeJsonHttp.replying(200, replyBody({ content: 'ok' }, USAGE));
    await callUnrouted(transportOver(http, new ManualDeadline()));

    expect(JSON.parse(http.onlyRequest.body)).toMatchObject({ model: DEFAULT_MODEL_ID });
  });

  it('honors the request output cap and the configured temperature', async () => {
    const http = FakeJsonHttp.replying(200, replyBody({ content: 'ok' }, USAGE));
    const transport = createBedrockMantleTransport({
      config: { ...BASE_CONFIG, temperature: 0.2 },
      http: http.port,
      scheduleTimeout: new ManualDeadline().schedule,
    });

    await transport({
      credential: SYNTHETIC_CREDENTIAL,
      request: { prompt: PROMPT.prompt, maxOutputTokens: 512 },
      modelId: ROUTED_MODEL_ID,
    });

    expect(JSON.parse(http.onlyRequest.body)).toMatchObject({
      max_tokens: 512,
      temperature: 0.2,
    });
  });

  it('forwards a configured seed and omits the field entirely when none is pinned', async () => {
    const seeded = FakeJsonHttp.replying(200, replyBody({ content: 'ok' }, USAGE));
    await callWith(
      transportOver(seeded, new ManualDeadline(), { ...BASE_CONFIG, seed: 20_240_115 }),
    );
    expect(JSON.parse(seeded.onlyRequest.body)).toMatchObject({ seed: 20_240_115 });

    const unseeded = FakeJsonHttp.replying(200, replyBody({ content: 'ok' }, USAGE));
    await callWith(transportOver(unseeded, new ManualDeadline()));
    expect(JSON.parse(unseeded.onlyRequest.body)).not.toHaveProperty('seed');
  });

  it('rejects an out-of-range seed at composition time rather than per call', () => {
    const http = FakeJsonHttp.replying(200, '{}');
    const build = (seed: number): ProviderTransport =>
      createBedrockMantleTransport({ config: { ...BASE_CONFIG, seed }, http: http.port });

    expect(() => build(-1)).toThrow(/out-of-range seed/);
    expect(() => build(1.5)).toThrow(/out-of-range seed/);
    expect(() => build(Number.NaN)).toThrow(/out-of-range seed/);
  });

  it('rejects a region that could rewrite the endpoint, at composition time', () => {
    const http = FakeJsonHttp.replying(200, '{}');
    const build = (region: string): ProviderTransport =>
      createBedrockMantleTransport({ config: { ...BASE_CONFIG, region }, http: http.port });

    expect(() => build('us-east-1/../../evil.example.com')).toThrow(/invalid region/);
    expect(() => build('us east 1')).toThrow(/invalid region/);
    expect(() => build('')).toThrow(/invalid region/);
  });
});

// --- Reading the reply ----------------------------------------------------

describe('bedrock-mantle transport - reading the reply', () => {
  it('returns the message content and the real reported token usage', async () => {
    const http = FakeJsonHttp.replying(
      200,
      replyBody({ content: 'module fifo; endmodule' }, USAGE),
    );
    const deadline = new ManualDeadline();
    const result = await callWith(transportOver(http, deadline));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.provider).toBe('bedrock-mantle');
    expect(result.value.outputText).toBe('module fifo; endmodule');
    expect(result.value.tokensUsed).toBe(3_000);
    expect(deadline.cancelled).toBe(true);
  });

  it('falls back to reasoning_content when content is empty', async () => {
    const http = FakeJsonHttp.replying(
      200,
      replyBody({ content: '', reasoning_content: 'module alu; endmodule' }, USAGE),
    );
    const result = await callWith(transportOver(http, new ManualDeadline()));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outputText).toBe('module alu; endmodule');
  });

  it('derives total tokens when the provider reports only the parts', async () => {
    const http = FakeJsonHttp.replying(
      200,
      replyBody({ content: 'ok' }, { prompt_tokens: 10, completion_tokens: 25 }),
    );
    const result = await callWith(transportOver(http, new ManualDeadline()));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tokensUsed).toBe(35);
  });

  it('classifies an unparseable or shapeless reply as invalid-response', async () => {
    const deadline = new ManualDeadline();
    const bodies = [
      'not json at all',
      '[]',
      JSON.stringify({ choices: [] }),
      JSON.stringify({ choices: [{ message: { content: '   ' } }] }),
    ];

    for (const body of bodies) {
      const result = await callWith(transportOver(FakeJsonHttp.replying(200, body), deadline));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('invalid-response');
      expectRedacted(result.error);
    }
  });

  it('treats a mis-shaped usage block as unreported rather than failing the call', async () => {
    const http = FakeJsonHttp.replying(
      200,
      replyBody({ content: 'ok' }, { prompt_tokens: 'lots', completion_tokens: -3 }),
    );
    const result = await callWith(transportOver(http, new ManualDeadline()));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tokensUsed).toBe(0);
    expect(result.value.costCents).toBe(0);
  });

  it('given a reported usage block, when parsed, then the prompt/completion split survives', async () => {
    // The split is what tokens-per-verified-artifact is built from, so it has to leave the
    // transport rather than being collapsed into the single total.
    const http = FakeJsonHttp.replying(200, replyBody({ content: 'ok' }, USAGE));

    const result = await callWith(transportOver(http, new ManualDeadline()));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tokenUsage).toEqual({
      kind: 'reported',
      promptTokens: 1_000,
      completionTokens: 2_000,
    });
  });

  it('given no usage block at all, when parsed, then it is unreported and NOT zero', async () => {
    // `tokensUsed: 0` alone is indistinguishable from a genuinely free call. The explicit
    // `unreported` marker is the only thing that keeps a silent provider out of a
    // tokens-per-artifact comparison it would otherwise win.
    const http = FakeJsonHttp.replying(200, replyBody({ content: 'ok' }));

    const result = await callWith(transportOver(http, new ManualDeadline()));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tokensUsed).toBe(0);
    expect(result.value.tokenUsage).toEqual({ kind: 'unreported' });
  });

  it('given a malformed usage block, when parsed, then it is unreported, not zero tokens', async () => {
    const http = FakeJsonHttp.replying(
      200,
      replyBody({ content: 'ok' }, { prompt_tokens: 'lots', completion_tokens: -3 }),
    );

    const result = await callWith(transportOver(http, new ManualDeadline()));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tokenUsage).toEqual({ kind: 'unreported' });
  });
});

// --- Cost -----------------------------------------------------------------

describe('bedrock-mantle transport - cost', () => {
  it('computes cost from real usage and the injected price', async () => {
    const http = FakeJsonHttp.replying(200, replyBody({ content: 'ok' }, USAGE));
    const result = await callWith(
      transportOver(http, new ManualDeadline(), { ...BASE_CONFIG, prices: PRICES }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 1000 input tokens at 100c/M plus 2000 output tokens at 400c/M.
    expect(result.value.costCents).toBeCloseTo(0.9, 10);
  });

  it('reports zero for a model with no configured price, keeping usage real', async () => {
    const http = FakeJsonHttp.replying(200, replyBody({ content: 'ok' }, USAGE));
    const result = await callWith(
      transportOver(http, new ManualDeadline(), { ...BASE_CONFIG, prices: PRICES }),
      'moonshotai.kimi-k2.5',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Zero means PRICE UNKNOWN, not free; the usage is still the provider's real count.
    expect(result.value.costCents).toBe(0);
    expect(result.value.tokensUsed).toBe(3_000);
  });
});

// --- Failure paths, all redacted -----------------------------------------

describe('bedrock-mantle transport - redacted failures', () => {
  it('classifies a non-success status as provider-unavailable without its body', async () => {
    const http = FakeJsonHttp.replying(500, PROVIDER_ERROR_BODY);
    const result = await callWith(transportOver(http, new ManualDeadline()));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('provider-unavailable');
    expect(result.error.reason).toContain('HTTP status 500');
    expectRedacted(result.error);
  });

  it('classifies a rejected call as provider-unavailable', async () => {
    const http = FakeJsonHttp.failing();
    const result = await callWith(transportOver(http, new ManualDeadline()));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('provider-unavailable');
    expectRedacted(result.error);
  });

  it('classifies a deadline breach as timeout and aborts the in-flight call', async () => {
    const http = FakeJsonHttp.hanging();
    const deadline = new ManualDeadline();
    const pending = callWith(transportOver(http, deadline));

    deadline.fire();
    const result = await pending;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('timeout');
    expectRedacted(result.error);
    expect(http.onlyRequest.signal?.aborted).toBe(true);
  });

  it('fails with credential-unavailable and makes no call when the env token is unset', async () => {
    const http = FakeJsonHttp.replying(200, replyBody({ content: 'ok' }, USAGE));
    const transport = transportOver(http, new ManualDeadline());
    const adapter = new BedrockMantleAdapter(
      scopeToProvider(new EnvSecretManager({}), 'bedrock-mantle'),
      transport,
    );

    const result = await adapter.call(PROMPT, { modelId: ROUTED_MODEL_ID });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('credential-unavailable');
    expect(http.requests).toHaveLength(0);
    expectRedacted(result.error);
  });

  it('resolves the env credential and confines it to the outbound header', async () => {
    const http = FakeJsonHttp.replying(200, replyBody({ content: 'ok' }, USAGE));
    const adapter = new BedrockMantleAdapter(
      scopeToProvider(
        new EnvSecretManager({ [BEDROCK_CREDENTIAL_ENV_KEY]: SYNTHETIC_CREDENTIAL }),
        'bedrock-mantle',
      ),
      transportOver(http, new ManualDeadline()),
    );

    const result = await adapter.call(PROMPT, { modelId: ROUTED_MODEL_ID });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(http.onlyRequest.headers.Authorization).toBe(`Bearer ${SYNTHETIC_CREDENTIAL}`);
    // The credential reached the header and nothing else: not the result, not the text.
    expect(JSON.stringify(result.value)).not.toContain(SYNTHETIC_CREDENTIAL);
  });
});
