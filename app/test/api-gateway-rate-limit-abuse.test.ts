// Rate-limiting abuse tests for the API_Gateway trust boundary (task 5.3).
//
// These are deterministic example/abuse checks (not one of the 32 numbered
// properties) that drive the InMemoryRateLimiter with an injected clock. They
// exercise the OWASP LLM unbounded-consumption class at the request-frequency
// layer and pin down the guarantee the gateway must never lose:
//
//   1. A sustained burst from ONE principal is admitted only up to the
//      per-principal cap; the rest of the flood is rejected with the correct
//      scope and a real remaining-window retry hint.
//   2. A burst spread across MANY fresh principals is admitted only up to the
//      GLOBAL cap; further requests are rejected even for brand-new principals
//      whose own per-principal windows are empty.
//   3. Rejected requests consume no quota, so an abuser flooding rejected
//      traffic cannot starve legitimate principals of their allotment.
//   4. This request-frequency cap is DISTINCT from and INDEPENDENT of the
//      per-session Session_Budget: the limiter imports nothing (so it cannot
//      consult `@app/core/budget`), its decision channel carries no token, cost,
//      or iteration data, and the tRPC enforcement path wires the limiter, not
//      the budget. The two caps answer different questions.
//
// The distinctness matters because conflating the two would let an attacker use
// a generous Session_Budget to justify an unbounded request rate, or let request
// throttling silently double as agentic-work accounting. They are separate
// controls and are asserted here to stay separate.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { InMemoryRateLimiter, type RateLimitDecision } from '@app/api';

/** A generous window used where a single control is under test in isolation. */
const WINDOW_MS = 60_000;

/** Run `count` checks for one principal at a fixed instant and tally outcomes. */
function burstOnePrincipal(
  limiter: InMemoryRateLimiter,
  principalId: string,
  count: number,
  now: number,
): { allowed: number; rejections: RateLimitDecision[] } {
  let allowed = 0;
  const rejections: RateLimitDecision[] = [];
  for (let i = 0; i < count; i += 1) {
    const decision = limiter.check(principalId, now);
    if (decision.allowed) {
      allowed += 1;
    } else {
      rejections.push(decision);
    }
  }
  return { allowed, rejections };
}

/** Extract the module specifiers of every `import ... from '...'` in a source file. */
function importSpecifiersOf(relativeToTest: string): string[] {
  const path = fileURLToPath(new URL(relativeToTest, import.meta.url));
  const source = readFileSync(path, 'utf8');
  const specifiers: string[] = [];
  const importFrom = /\bimport\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(importFrom)) {
    const specifier = match[1];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

/** Count top-of-line `import` statements in a source file. */
function importStatementCount(relativeToTest: string): number {
  const path = fileURLToPath(new URL(relativeToTest, import.meta.url));
  const source = readFileSync(path, 'utf8');
  const importLines = source.match(/^\s*import\b/gm);
  return importLines === null ? 0 : importLines.length;
}

describe('per-principal burst abuse', () => {
  it('admits only up to the per-principal cap and rejects the whole remaining flood', () => {
    const perPrincipalMax = 10;
    const limiter = new InMemoryRateLimiter({
      perPrincipalMax,
      // Global cap kept far out of reach so the per-principal cap is what trips.
      globalMax: 10_000,
      windowMs: WINDOW_MS,
    });

    const burstSize = 50;
    const { allowed, rejections } = burstOnePrincipal(limiter, 'abuser', burstSize, 1_000);

    expect(allowed).toBe(perPrincipalMax);
    expect(rejections).toHaveLength(burstSize - perPrincipalMax);
    for (const rejection of rejections) {
      expect(rejection.scope).toBe('principal');
      // Same instant as the window start, so the full window remains as the hint.
      expect(rejection.retryAfterMs).toBe(WINDOW_MS);
    }
  });

  it('reports a shrinking retry hint as the fixed window elapses', () => {
    const limiter = new InMemoryRateLimiter({
      perPrincipalMax: 1,
      globalMax: 10_000,
      windowMs: WINDOW_MS,
    });

    // The first request opens the window at t=1000; later rejects hint the
    // remaining time in THAT window, never a fresh full window.
    expect(limiter.check('abuser', 1_000).allowed).toBe(true);
    expect(limiter.check('abuser', 1_000).retryAfterMs).toBe(WINDOW_MS);
    expect(limiter.check('abuser', 30_000).retryAfterMs).toBe(1_000 + WINDOW_MS - 30_000);
  });
});

describe('global burst abuse across many fresh principals', () => {
  it('admits only up to the global cap even though every principal is distinct', () => {
    const globalMax = 5;
    const limiter = new InMemoryRateLimiter({
      // Per-principal cap kept far out of reach so the global cap is what trips.
      perPrincipalMax: 100,
      globalMax,
      windowMs: WINDOW_MS,
    });

    const principalCount = 200;
    let allowed = 0;
    const rejections: RateLimitDecision[] = [];
    for (let i = 0; i < principalCount; i += 1) {
      const decision = limiter.check(`fresh-${i}`, 0);
      if (decision.allowed) {
        allowed += 1;
      } else {
        rejections.push(decision);
      }
    }

    expect(allowed).toBe(globalMax);
    expect(rejections).toHaveLength(principalCount - globalMax);
    for (const rejection of rejections) {
      // A brand-new principal with an empty per-principal window is still
      // rejected because the shared global window is full.
      expect(rejection.scope).toBe('global');
      expect(rejection.retryAfterMs).toBe(WINDOW_MS);
    }
  });
});

describe('rejected traffic consumes no quota (abuse cannot starve legitimate principals)', () => {
  it('lets a legitimate principal claim its full allotment after an abuser floods rejected requests', () => {
    const perPrincipalMax = 3;
    const globalMax = 10;
    const limiter = new InMemoryRateLimiter({ perPrincipalMax, globalMax, windowMs: 1_000 });

    // Abuser exhausts its own cap, then hammers the gateway.
    const abuse = burstOnePrincipal(limiter, 'abuser', perPrincipalMax + 100, 0);
    expect(abuse.allowed).toBe(perPrincipalMax);
    expect(abuse.rejections).toHaveLength(100);
    for (const rejection of abuse.rejections) {
      expect(rejection.scope).toBe('principal');
    }

    // The 100 rejected requests consumed no global quota: only the 3 admitted
    // abuser requests count, leaving room for other principals.
    const legit = burstOnePrincipal(limiter, 'legit', perPrincipalMax, 0);
    expect(legit.allowed).toBe(perPrincipalMax);
    expect(legit.rejections).toHaveLength(0);

    // Global room still remains (3 + 3 of 10 used), so yet another principal is admitted.
    expect(limiter.check('legit-2', 0).allowed).toBe(true);
  });
});

describe('rate limit is distinct from and independent of the Session_Budget', () => {
  it('rejects purely on request frequency, with no channel for token/cost/iteration data', () => {
    const limiter = new InMemoryRateLimiter({
      perPrincipalMax: 2,
      globalMax: 10_000,
      windowMs: 1_000,
    });

    // The decision channel takes exactly (principalId, now): there is no way to
    // feed it agentic token/cost/iteration accounting. That accounting is the
    // Session_Budget's job (`app/core/budget`), not the limiter's.
    expect(limiter.check.length).toBe(2);

    // Frequency window reset is orthogonal to a Session_Budget's monotonic
    // consumption. A budget's consumed counters only ever grow, so if throttling
    // were the same mechanism it could never re-admit; the limiter DOES re-admit
    // once a new window opens, proving the two caps answer different questions.
    expect(limiter.check('user', 0).allowed).toBe(true);
    expect(limiter.check('user', 0).allowed).toBe(true);
    expect(limiter.check('user', 0).allowed).toBe(false);
    expect(limiter.check('user', 1_000).allowed).toBe(true);
  });

  it('has no dependency on the budget module (the limiter imports nothing)', () => {
    // The limiter is self-contained: it has zero import statements, so it
    // provably cannot consult `@app/core/budget` or any budget accounting.
    expect(importStatementCount('../api/gateway/rate-limit.ts')).toBe(0);
  });

  it('wires the rate limiter, not the Session_Budget, into the tRPC enforcement path', () => {
    const specifiers = importSpecifiersOf('../api/trpc/trpc.ts');
    expect(specifiers).toContain('../gateway/rate-limit.js');
    expect(specifiers).not.toContain('@app/core/budget');
    for (const specifier of specifiers) {
      expect(specifier).not.toContain('budget');
    }
  });
});
