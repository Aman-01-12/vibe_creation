// Unit tests for the transport-level retry, the backoff bounds, and the circuit breaker.
//
// THE ASSERTION THAT MATTERS MOST
//   A retryable failure resends THE SAME REQUEST BODY. If a retry ever varied the request
//   - a different seed, a different temperature, a fresh prompt - it would be a second
//   sample and pass@k would be silently inflated. `it('resends byte-identical bytes')`
//   below is the guard on that, and it should be the last test anyone deletes.
//
// No test here opens a socket, waits on a real timer, or consumes real entropy: the clock,
// the sleep, and the randomness are all injected.

import { describe, expect, it } from 'vitest';

import type { JsonHttpPort, JsonHttpRequest, JsonHttpResponse } from '@app/agent';

import {
  backoffDelayMs,
  classifyStatus,
  createRetryingHttpPort,
  DEFAULT_TRANSPORT_RETRY_POLICY,
  TransportCircuitBreaker,
  TransportCircuitOpenError,
  type TransportRetryDeps,
  type TransportRetryPolicy,
} from './transport-retry.js';

/**
 * A tight policy so a test exercises exhaustion in a few attempts.
 *
 * The breaker threshold is deliberately ABOVE `maxAttempts` so the retry tests observe
 * retry behaviour alone; the breaker tests below use `BREAKER_POLICY`, which trips inside
 * one request, so the interaction between the two is asserted separately rather than
 * accidentally.
 */
const POLICY: TransportRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
  jitterRatio: 0.5,
  breakerFailureThreshold: 5,
  breakerCooldownMs: 5_000,
  breakerMaxTrips: 2,
};

/** A policy whose breaker trips within a single request's retries. */
const BREAKER_POLICY: TransportRetryPolicy = { ...POLICY, breakerFailureThreshold: 2 };

/** A request whose body is checked for byte-identity across attempts. */
const REQUEST: JsonHttpRequest = Object.freeze({
  url: 'https://example.invalid/chat',
  headers: Object.freeze({ authorization: 'Bearer never-logged' }),
  body: JSON.stringify({ model: 'zai.glm-5', seed: 7, temperature: 0 }),
  timeoutMs: 1_000,
});

/** A controllable clock and sleep recorder; nothing here waits. */
function fakeDeps(
  policy: TransportRetryPolicy,
  breaker: TransportCircuitBreaker,
  random = 0,
): TransportRetryDeps & { readonly sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    policy,
    breaker,
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => random,
    sleeps,
  };
}

/** A port that answers from a scripted list of statuses, recording each body it saw. */
function scriptedPort(statuses: readonly number[]): JsonHttpPort & { readonly bodies: string[] } {
  const bodies: string[] = [];
  let call = 0;
  const port = (request: JsonHttpRequest): Promise<JsonHttpResponse> => {
    bodies.push(request.body);
    const status = statuses[Math.min(call, statuses.length - 1)] ?? 200;
    call += 1;
    return Promise.resolve({ status, body: '{}' });
  };
  return Object.assign(port, { bodies });
}

describe('classifyStatus', () => {
  it('treats 2xx as answered', () => {
    expect(classifyStatus(200)).toBe('answered');
    expect(classifyStatus(299)).toBe('answered');
  });

  it('treats 429 and the 5xx class as retryable', () => {
    expect(classifyStatus(429)).toBe('retryable');
    expect(classifyStatus(500)).toBe('retryable');
    expect(classifyStatus(503)).toBe('retryable');
  });

  it('treats other 4xx as terminal, so a rejected credential is not hammered', () => {
    expect(classifyStatus(401)).toBe('terminal');
    expect(classifyStatus(400)).toBe('terminal');
    expect(classifyStatus(404)).toBe('terminal');
  });
});

describe('backoffDelayMs - bounds and jitter', () => {
  it('doubles per attempt before the cap is reached', () => {
    const noJitter: TransportRetryPolicy = { ...POLICY, jitterRatio: 0 };
    expect(backoffDelayMs(noJitter, 1, () => 0)).toBe(100);
    expect(backoffDelayMs(noJitter, 2, () => 0)).toBe(200);
    expect(backoffDelayMs(noJitter, 3, () => 0)).toBe(400);
  });

  it('clamps to maxDelayMs however many attempts have failed', () => {
    const noJitter: TransportRetryPolicy = { ...POLICY, jitterRatio: 0 };
    expect(backoffDelayMs(noJitter, 20, () => 0)).toBe(1_000);
  });

  it('keeps every delay within [capped * (1 - jitterRatio), capped]', () => {
    for (const attempt of [1, 2, 3, 8]) {
      const capped = Math.min(POLICY.maxDelayMs, POLICY.baseDelayMs * 2 ** (attempt - 1));
      for (const draw of [0, 0.25, 0.5, 0.999]) {
        const delay = backoffDelayMs(POLICY, attempt, () => draw);
        expect(delay).toBeLessThanOrEqual(capped);
        expect(delay).toBeGreaterThanOrEqual(capped * (1 - POLICY.jitterRatio));
      }
    }
  });

  it('is never negative even when a hostile random source returns out-of-range values', () => {
    expect(backoffDelayMs(POLICY, 1, () => 5)).toBeGreaterThanOrEqual(0);
    expect(backoffDelayMs(POLICY, 1, () => Number.NaN)).toBeGreaterThanOrEqual(0);
  });

  it('never exceeds the cap with the shipped default policy', () => {
    const policy = DEFAULT_TRANSPORT_RETRY_POLICY;
    expect(backoffDelayMs(policy, 12, () => 0)).toBe(policy.maxDelayMs);
  });
});

describe('the retrying port - a retry is the SAME question, never a second sample', () => {
  it('resends byte-identical bytes on every attempt', async () => {
    const breaker = new TransportCircuitBreaker(POLICY, () => 0);
    const port = scriptedPort([503, 503, 200]);
    const retrying = createRetryingHttpPort(port, fakeDeps(POLICY, breaker));
    await retrying(REQUEST);
    expect(port.bodies).toHaveLength(3);
    expect(new Set(port.bodies).size).toBe(1);
    expect(port.bodies[0]).toBe(REQUEST.body);
  });

  it('returns the first answered reply without retrying', async () => {
    const breaker = new TransportCircuitBreaker(POLICY, () => 0);
    const port = scriptedPort([200]);
    const deps = fakeDeps(POLICY, breaker);
    const response = await createRetryingHttpPort(port, deps)(REQUEST);
    expect(response.status).toBe(200);
    expect(port.bodies).toHaveLength(1);
    expect(deps.sleeps).toEqual([]);
  });

  it('does NOT retry a terminal 4xx', async () => {
    const breaker = new TransportCircuitBreaker(POLICY, () => 0);
    const port = scriptedPort([401]);
    const response = await createRetryingHttpPort(port, fakeDeps(POLICY, breaker))(REQUEST);
    expect(response.status).toBe(401);
    expect(port.bodies).toHaveLength(1);
  });

  it('backs off between attempts, once per retry', async () => {
    const breaker = new TransportCircuitBreaker(POLICY, () => 0);
    const deps = fakeDeps(POLICY, breaker);
    await createRetryingHttpPort(scriptedPort([429, 429, 200]), deps)(REQUEST);
    expect(deps.sleeps).toEqual([100, 200]);
  });

  it('returns the last retryable reply on exhaustion, so the transport classifies it', async () => {
    const breaker = new TransportCircuitBreaker(POLICY, () => 0);
    const response = await createRetryingHttpPort(
      scriptedPort([503]),
      fakeDeps(POLICY, breaker),
    )(REQUEST);
    expect(response.status).toBe(503);
  });

  it('re-throws the inner port error on exhaustion, preserving its redaction', async () => {
    const breaker = new TransportCircuitBreaker(POLICY, () => 0);
    const inner: JsonHttpPort = () => Promise.reject(new Error('json http port failed'));
    await expect(createRetryingHttpPort(inner, fakeDeps(POLICY, breaker))(REQUEST)).rejects.toThrow(
      'json http port failed',
    );
  });
});

describe('the circuit breaker - three states', () => {
  it('starts closed and stays closed while calls succeed', () => {
    const breaker = new TransportCircuitBreaker(BREAKER_POLICY, () => 0);
    expect(breaker.state()).toBe('closed');
    breaker.recordSuccess();
    expect(breaker.state()).toBe('closed');
    expect(breaker.outage()).toBe(false);
  });

  it('opens after the configured consecutive failures and refuses calls', () => {
    const breaker = new TransportCircuitBreaker(BREAKER_POLICY, () => 1_000);
    breaker.recordFailure();
    expect(breaker.state()).toBe('closed');
    breaker.recordFailure();
    expect(breaker.state()).toBe('open');
    expect(breaker.admitCall()).toBe(false);
  });

  it('moves to half-open after the cooldown and admits exactly one trial call', () => {
    let clock = 0;
    const breaker = new TransportCircuitBreaker(BREAKER_POLICY, () => clock);
    breaker.recordFailure();
    breaker.recordFailure();
    clock = BREAKER_POLICY.breakerCooldownMs;
    expect(breaker.state()).toBe('half-open');
    expect(breaker.admitCall()).toBe(true);
    expect(breaker.admitCall()).toBe(false);
  });

  it('fully resets on a success, so a recovered provider is not held down', () => {
    let clock = 0;
    const breaker = new TransportCircuitBreaker(BREAKER_POLICY, () => clock);
    breaker.recordFailure();
    breaker.recordFailure();
    clock = BREAKER_POLICY.breakerCooldownMs;
    breaker.recordSuccess();
    expect(breaker.state()).toBe('closed');
    expect(breaker.outage()).toBe(false);
  });

  it('reports a sustained OUTAGE after the configured trips without a success', () => {
    let clock = 0;
    const breaker = new TransportCircuitBreaker(BREAKER_POLICY, () => clock);
    for (let trip = 0; trip < BREAKER_POLICY.breakerMaxTrips; trip += 1) {
      breaker.recordFailure();
      breaker.recordFailure();
      clock += BREAKER_POLICY.breakerCooldownMs;
    }
    expect(breaker.outage()).toBe(true);
  });

  it('makes the retrying port fail fast with a redacted error while already open', async () => {
    const breaker = new TransportCircuitBreaker(BREAKER_POLICY, () => 0);
    breaker.recordFailure();
    breaker.recordFailure();
    const port = scriptedPort([200]);
    await expect(
      createRetryingHttpPort(port, fakeDeps(BREAKER_POLICY, breaker))(REQUEST),
    ).rejects.toThrow(TransportCircuitOpenError);
    expect(port.bodies).toHaveLength(0);
  });

  it('never lets a credential or a host reach the breaker-open error message', async () => {
    const breaker = new TransportCircuitBreaker(BREAKER_POLICY, () => 0);
    breaker.recordFailure();
    breaker.recordFailure();
    const failure = await createRetryingHttpPort(
      scriptedPort([200]),
      fakeDeps(BREAKER_POLICY, breaker),
    )(REQUEST).catch((error: unknown) => error);
    const text = failure instanceof Error ? `${failure.name}${failure.message}` : String(failure);
    expect(text).not.toContain('Bearer');
    expect(text).not.toContain('example.invalid');
  });

  it('stops retrying when its own retries trip the breaker, keeping the real outcome', async () => {
    const breaker = new TransportCircuitBreaker(BREAKER_POLICY, () => 0);
    const port = scriptedPort([503]);
    const response = await createRetryingHttpPort(port, fakeDeps(BREAKER_POLICY, breaker))(REQUEST);
    // Two attempts trip the threshold, so the third is not made - and the caller still
    // sees the provider's real 503 rather than a breaker error it cannot diagnose.
    expect(port.bodies).toHaveLength(2);
    expect(response.status).toBe(503);
    expect(breaker.state()).toBe('open');
  });
});
