---
type: pattern
title: Carry cancellation reason on signal.reason as a branded marker; keep reason -> UI a pure function
status: candidate
provenance: task 15.9 (hdl-creation-loop) - AbortController lifecycle across app/web and app/api
tags: [cancellation, abortcontroller, sse, streaming, ui, purity, security]
timestamp: 2025-02-14
verifiedBy: tsc -b app/web + app/api, eslint --max-warnings=0, vitest run app/web app/api (47 passed)
---

# Pattern

For request cancellation, do not infer WHY a run was aborted from side channels.
Attach the reason to the abort itself via `AbortController.abort(reason)` using a branded marker object, then validate it on read (`signal.reason` is typed `unknown`).
Keep the reason -> UI decision (`silent` vs `sanitized toast`) a pure, total function so the lifecycle is testable with no browser, timer, or network, and a property test can state over it directly.

# When to use

Any long, cancellable run that must react differently by cause: unmount/navigation aborts are silent (expected teardown), a timeout abort surfaces one sanitized toast. Generalizes to any AbortController lifecycle where the consumer needs the cause, not just the fact, of cancellation.

# Recipe / example

- `cancellationSignalReason(reason)` -> `{ [SYMBOL]: reason }`; `RunCancellation.cancel(reason)` calls `abort(that)`. First reason wins (idempotent), so a late unmount cannot overwrite the timeout the user was shown.
- `readCancellationReason(signal)`: guard `signal.aborted`, guard object, check the symbol brand, narrow to the union; anything foreign (e.g. a raw `DOMException`) -> `null` (fail safe, never a wrong toast).
- `decideCancellationUi(reason)`: pure switch with an `assertNever` default; timeout message is a static constant (no interpolated internal state -> nothing to leak).
- Inject the timer (`TimeoutScheduler`) so the timeout path is deterministic; `dispose()` clears the timer without aborting for the normal-completion path (no dangling timer).

# Pitfalls

- `exactOptionalPropertyTypes` + `verbatimModuleSyntax`: build option objects conditionally and use `import type` for type-only imports.
- Thread the signal through the existing authenticated seam; do not add a new cancellation endpoint. At the gateway the inbound signal is untrusted transport input - validate it is a real `AbortSignal` (`resolveDownstreamSignal`) and fail safe to a fresh never-aborting signal when absent/malformed.
- app/api can only thread the signal as far as its port (`GatewayHandlers`); the concrete handler (tasks 6/14) must pass it onward into ModelRouter/Tool_Runner. Changing `ModelRouter.invoke` here would ripple into completed agent tests - out of scope for a web+api task.

# Links

- app/web/editor/cancellation.ts, app/web/editor/run-controller.ts
- app/api/gateway/cancellation.ts, app/api/trpc/router.ts (GatewayHandlers port)
- Lifecycle test lands in task 15.10.
