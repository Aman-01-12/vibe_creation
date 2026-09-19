---
type: decision
title: The port's Retry-After ceiling is a build constant, not the eval retry policy's maxDelayMs
status: candidate
provenance: task 4.3 of .kiro/specs/eval-campaign-readiness - app/agent/model-router/fetch-json-http-port.ts
tags: [model-router, http, untrusted-input, layering, throttling, retry-after, dos, eval-sweep]
timestamp: 2026-09-20
---

# Decision

`createFetchJsonHttpPort` clamps a parsed `Retry-After` to `MAX_HONOURED_RETRY_AFTER_MS = 60_000`, a build constant declared in the port module.
It is NOT `TransportRetryPolicy.maxDelayMs` and it is NOT injected from the policy, even though Requirement 5.4 reads "no greater than the retry policy's maximum delay".

The reply carries `retryAfterMs?: number | null` and nothing else from the header set.
`HostFetchResponse.headers` is typed as `HostHeaderReader { get(name): string | null }` - a by-name accessor, never a map - so the module is structurally unable to enumerate or forward headers even though the real object it receives is a full `Headers`.

# Context / options considered

Two candidate sources for the clamp ceiling:

1. Thread `policy.maxDelayMs` down from `app/eval/sweep/transport-retry.ts`. Rejected on two counts.
   - `app/eval` imports `@app/agent`, not the reverse, so the port reaching the policy inverts the dependency direction the port exists to hold.
   - The upstream composition is `Math.max(Math.min(policy.maxDelayMs, computed), retryAfterMs ?? 0)` (design Area 2, task 5.3). If the port had already clamped to `policy.maxDelayMs`, the floor could never raise the delay past the clamp and would be dead code. The design's "a host asking for longer than our own ceiling is still obeyed" only means something if the port's ceiling is the WIDER one.
2. A named build constant in the port. Chosen.

`request.timeoutMs` was considered and is a category error: it bounds how long we wait for a reply, not how long we wait before retrying.

# Rationale

One minute as the anchor: longer than any legitimate per-attempt throttle instruction, same order as `DEFAULT_TRANSPORT_RETRY_POLICY.breakerCooldownMs` (the duration we already accept for waiting out an unhealthy endpoint), and far below anything that parks an overnight campaign.
Past that the circuit breaker ends the run; that is not a header's decision.
Worst case per request is `maxAttempts - 1` waits, so 3 minutes at the defaults, and only if the host explicitly asks for >= 60s each time.

Two smaller shape decisions worth not re-deriving:

- The field is OMITTED (conditional spread) rather than reported as `retryAfterMs: null` when there is no instruction. Absence and null already mean the same thing to callers, and always emitting `null` breaks every `expect(response).toEqual({ status, body })` in the suite - vitest's `toEqual` ignores `undefined` properties but not `null` ones.
- `headers?.get()` is wrapped in a try that reports "no instruction" on a throw. `headers` is host-supplied code, and letting an ADVISORY hint throw would convert a reply we already read successfully - a paid model call - into `request-failed` plus a pointless retry. `parseRetryAfterMs` is itself total, so the guard covers only the host accessor.

# Revisit trigger

If a provider is measured returning `Retry-After` values above 60s that we actually want to obey, raise the constant with the measurement recorded - do not make it a sweep-config field (that enters the Config_Identity and orphans paid samples; see decision-diagnostic-only-config-fields-are-excluded-from-configHash).

# Links

- app/agent/model-router/fetch-json-http-port.ts, json-http-port.ts, retry-after.ts
- app/eval/sweep/transport-retry.ts (owner of `policy.maxDelayMs`; applies the floor after its clamp)
- .kiro/specs/eval-campaign-readiness/design.md, Area 2 - Throttling survivability
- chipAgent/_inbox/pattern-bounded-untrusted-http-reply-reject-not-truncate.md (same boundary, same containment argument)
