---
type: gotcha
title: SimulationVerdict collapses timeout / tool-crash / compile-error into one `error`; self-healing must re-derive the cause
status: candidate
provenance: task 14.3 (self-healing failure-recovery loop)
tags: [self-healing, verdict, oracle, error-handling, classification]
timestamp: 2025-06-14
---

# What happened

The self-healing loop must classify a failure into syntax error / simulation timeout / tool crash to pick a targeted recovery ladder.
The obvious input is the `SimulationVerdict` from the Simulator adapter, but a raw `SimulationVerdict` cannot tell those three apart on its own: a compile error, a wall-clock timeout, and an infra crash ALL surface as `verdict: 'error'`.

# Root cause

The Tool_Runner sandbox already decides capture-all-or-error and reserves `error` for "timeout OR infra failure OR missing required output".
`interpretSandboxResult` (in `@app/tools` `adapter.ts`) then propagates that single `error` verdict with `checks: []` and DISCARDS the sandbox's `timedOut` / `infraFailure` distinction.
So by the time the agent layer holds a `SimulationVerdict`, the cause is gone from the discriminant; only the residual fields (`exitCode`, `resourceUsage.wallMs`, `vcd`) still carry a weak signal.

# Fix / rule

- Prefer an EXPLICIT failure signal where the caller already knows the cause: the self-healing `FailureSignal` union has a `compile` variant (self-describing) and a `model-output` variant (parser already rejected malformed output), so classification is exact for those.
- For the raw `simulation` variant, classify heuristically and document it as best-effort: `exitCode === null && wallMs >= limits.wallMs` -> timeout; `exitCode !== 0 && vcd === null` -> compile/syntax error; else tool-crash.
- Any thrown tool/infra exception is its own `exception` signal -> tool-crash (fail safe), never a heuristic over a synthesized verdict.
- If exact timeout-vs-crash classification ever becomes load-bearing, thread the sandbox's `timedOut`/`infraFailure` through `SimulationVerdict` rather than widening the heuristic; the residual-field heuristic is deliberately conservative and tool-crash is the safe default (its ladder ends in a safe escalate).

# Links

- app/agent/orchestrator/self-healing.ts (classifyFailure, classifySimulation, looksLikeTimeout, looksLikeCompileError)
- app/tools/simulator/adapter.ts (interpretSandboxResult - where the cause is collapsed)
- app/tools/sandbox/runtime-runsc.ts (infraCapture - the timedOut/infraFailure origin)
