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

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { JsonHttpPort, JsonHttpRequest, JsonHttpResponse } from '@app/agent';

import { ThrottleGovernor } from './throttle-governor.js';
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
  governor: ThrottleGovernor = new ThrottleGovernor(Number.POSITIVE_INFINITY, () => 0),
): TransportRetryDeps & { readonly sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    policy,
    breaker,
    governor,
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => random,
    sleeps,
  };
}

/**
 * A port that answers from a scripted list of statuses, recording each body it saw.
 *
 * `retryAfterMs` is per-reply and optional, matching the shape `JsonHttpResponse`
 * itself allows, so a test can assert the host's own instruction is honoured without
 * the port pretending every reply carries one.
 */
function scriptedPort(
  statuses: readonly number[],
  retryAfterMs: ReadonlyMap<number, number> = new Map(),
): JsonHttpPort & { readonly bodies: string[] } {
  const bodies: string[] = [];
  let call = 0;
  const port = (request: JsonHttpRequest): Promise<JsonHttpResponse> => {
    bodies.push(request.body);
    const index = Math.min(call, statuses.length - 1);
    const status = statuses[index] ?? 200;
    call += 1;
    const hint = retryAfterMs.get(index);
    return Promise.resolve({
      status,
      body: '{}',
      ...(hint === undefined ? {} : { retryAfterMs: hint }),
    });
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

  // Feature: eval-campaign-readiness, Property 9: The applied delay is never below the
  // host's instruction.
  //
  // Validates: Requirements 5.5, 6.5, 6.7
  //
  // The composition under test, from transport-retry.ts, is:
  //   const clamped = Math.min(policy.maxDelayMs, computed);
  //   await deps.sleep(Math.max(clamped, retryAfterMs ?? 0));
  //
  // `Math.max` makes the host's instruction a FLOOR under our own backoff, never a
  // replacement for it: whichever of the two numbers is larger is what we wait. An
  // `Math.min` in its place would let a large host instruction be discarded in favour
  // of a smaller computed backoff - obeying the host LESS than it asked, which is the
  // one thing this module must never do to a rate-limited host. Asserting the applied
  // delay against BOTH `retryAfterMs` and `clamped` on every case, rather than only
  // the larger of the two, is what makes a future `Math.min` swap fail here: `Math.min`
  // would still satisfy "delay >= retryAfterMs" whenever retryAfterMs is the smaller
  // operand, but it would violate "delay >= clamped" on that very same case.
  it('applies the host-supplied Retry-After as a floor under the computed backoff, never a replacement for it', async () => {
    await fc.assert(
      fc.asyncProperty(
        // The random draw behind our own exponential backoff.
        fc.double({ min: 0, max: 0.999, noNaN: true }),
        // The host's instruction, generated across both sides of `clamped`: a zero (a
        // real, valid "retry now"), a small value likely below `clamped`, and a value
        // large enough to exceed even `policy.maxDelayMs` and so exceed `clamped` too.
        fc.oneof(
          fc.constant(0),
          fc.integer({ min: 1, max: POLICY.maxDelayMs }),
          fc.integer({ min: POLICY.maxDelayMs, max: POLICY.maxDelayMs * 4 }),
        ),
        async (random, retryAfterMs) => {
          const clamped = Math.min(
            POLICY.maxDelayMs,
            backoffDelayMs(POLICY, 1, () => random),
          );
          const breaker = new TransportCircuitBreaker(POLICY, () => 0);
          const deps = fakeDeps(POLICY, breaker, random);
          const port = scriptedPort([429, 200], new Map([[0, retryAfterMs]]));

          await createRetryingHttpPort(port, deps)(REQUEST);

          expect(deps.sleeps).toHaveLength(1);
          const applied = deps.sleeps[0];
          // The floor: the host's own instruction is never shorted, however small our
          // own backoff would otherwise have been.
          expect(applied).toBeGreaterThanOrEqual(retryAfterMs);
          // Never a ceiling: our own backoff is never shorted either. A zero-valued
          // instruction is a real "retry now", not an absent one - it must not read as
          // `retryAfterMs ?? 0` collapsing to the same 0 an absent header would produce
          // and accidentally overriding `clamped` downward.
          expect(applied).toBeGreaterThanOrEqual(clamped);
        },
      ),
      { numRuns: 200 },
    );
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
