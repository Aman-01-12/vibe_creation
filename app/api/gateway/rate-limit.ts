// Gateway request rate limiting: per-principal AND global.
//
// This cap is deliberately DISTINCT from the per-session Session_Budget (task
// 8.1). Rate limiting bounds request FREQUENCY per principal and across the
// whole service to blunt abuse and the OWASP LLM unbounded-consumption class; it
// knows nothing about agentic iterations, tokens, or cost inside a single loop
// run, which is the Session_Budget's job. This module deliberately does not
// import anything from `@app/core/budget`.
//
// The limiter is an interface with a deterministic in-memory implementation
// sufficient for tests and single-node use. A distributed implementation
// (shared counter store) can replace it behind the same interface without
// touching callers.

/** The outcome of a single rate-limit check. */
export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Which limit tripped, when `allowed` is false. */
  readonly scope?: 'principal' | 'global';
  /** Hint for when the caller may retry, in milliseconds, when rejected. */
  readonly retryAfterMs?: number;
}

/** The rate-limiting port. `now` is injected so decisions are deterministic. */
export interface RateLimiter {
  check(principalId: string, now: number): RateLimitDecision;
}

/** Fixed-window limits. A request is allowed only if BOTH windows have room. */
export interface RateLimitConfig {
  readonly perPrincipalMax: number;
  readonly globalMax: number;
  readonly windowMs: number;
}

/** Mutable counter for one fixed window. */
interface Window {
  start: number;
  count: number;
}

/**
 * In-memory fixed-window rate limiter.
 *
 * Uses a peek-then-commit strategy: it computes whether admitting the request
 * keeps BOTH the principal and global windows within their caps, and increments
 * only when it will admit, so a rejected request never consumes quota. Expired
 * principal windows are pruned lazily on access, bounding memory to recently
 * active principals.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly perPrincipal = new Map<string, Window>();
  private readonly global: Window = { start: 0, count: 0 };

  constructor(private readonly config: RateLimitConfig) {}

  check(principalId: string, now: number): RateLimitDecision {
    const principalWindow = this.currentPrincipalWindow(principalId, now);
    const globalWindow = this.currentGlobalWindow(now);

    if (principalWindow.count >= this.config.perPrincipalMax) {
      return this.reject('principal', principalWindow, now);
    }
    if (globalWindow.count >= this.config.globalMax) {
      return this.reject('global', globalWindow, now);
    }

    principalWindow.count += 1;
    globalWindow.count += 1;
    return { allowed: true };
  }

  /** Reset-or-fetch the principal window, pruning it when its window has elapsed. */
  private currentPrincipalWindow(principalId: string, now: number): Window {
    const existing = this.perPrincipal.get(principalId);
    if (existing === undefined || this.expired(existing, now)) {
      const fresh: Window = { start: now, count: 0 };
      this.perPrincipal.set(principalId, fresh);
      return fresh;
    }
    return existing;
  }

  /** Reset-or-fetch the shared global window. */
  private currentGlobalWindow(now: number): Window {
    if (this.global.count === 0 || this.expired(this.global, now)) {
      this.global.start = now;
      this.global.count = 0;
    }
    return this.global;
  }

  private expired(window: Window, now: number): boolean {
    return now - window.start >= this.config.windowMs;
  }

  private reject(scope: 'principal' | 'global', window: Window, now: number): RateLimitDecision {
    const retryAfterMs = Math.max(0, window.start + this.config.windowMs - now);
    return { allowed: false, scope, retryAfterMs };
  }
}
