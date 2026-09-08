---
type: pattern
title: Optional-capability switch as a closed union with a lazy memoized-promise compile-once
status: candidate
provenance: task 15.6 (Live_Run enabled/deferred switch), app/web/live-run
tags: [typescript, modeling, vendor-isolation, invariants, web]
timestamp: 2025-06-13
verifiedBy: unit tests (app/web/live-run/live-run.test.ts); tsc -b + eslint --max-warnings=0 + vitest green
---

# Pattern

Model an optional/enabled-or-deferred capability as a closed two-arm discriminated union rather than a boolean flag plus guard clauses.
Put the capability (the method, and the injected vendor port it needs) ONLY on the enabled arm; the deferred arm structurally has no reference to the port and no method, so the disabled code path is unreachable by construction, not by convention.
The single decision function (`decideLiveRun(config)`) returns exactly one arm, making "both" and "neither" unrepresentable, which is exactly what a downstream "exactly one of X or Y" property needs to state over.

# When to use

- A feature is scoped to exactly one of two mutually exclusive states and you must guarantee the disabled state never touches the disabled machinery (e.g. "when deferred, NEVER compile to WASM").
- A result must never be mistaken for an authoritative value: pin an `authority` field to a single closed literal (`'preview-only'`), with no field/function converting it into the authoritative type. Here it kept a Live_Run result from ever being read as the correctness verdict.

# Recipe / example

- Config union: `{ mode: 'deferred' } | { mode: 'enabled'; port; request }` - enabled-without-port and deferred-with-port both fail to type-check.
- Lazy compile-once: memoize the PROMISE (not just the value): `if (cached === undefined) cached = port.compile(req); return cached;`. Concurrent first calls share one in-flight compile; a resolved success OR failure is reused. Assert with a fake port that counts `compile` invocations (0 after decide, 1 after N runs).
- Vendor isolation: the toolchain sits behind an injected port returning `Result`; the fake in tests never needs the real toolchain installed.

# Pitfalls

- Caching the failure too (memoizing the rejected/err promise) is deliberate here: it honors "compile at most once" and fails safe against unbounded recompute, but it means a transient compile failure disables the panel for the instance's lifetime. Fine for a per-session preview; reconsider if the capability must self-heal within a session.
- Keep the port contract "returns Result, never throws" consistent with the rest of the codebase (mirrors @app/core constructors and vcdToWaveJson), so callers stay try/catch-free. If a real adapter can reject, normalize it to a sanitized Result at the adapter, not with scattered catches.

# Links

- app/web/live-run/live-run.ts, app/web/live-run/live-run.test.ts
- Reuses (does not duplicate) app/web/visualizations delivery surface (task 15.3)
- Design: Recommended stack (Live_Run); Property 24; Req 9.6-9.9
