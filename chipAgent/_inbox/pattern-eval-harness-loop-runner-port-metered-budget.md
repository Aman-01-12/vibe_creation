---
type: pattern
title: Eval_Harness measures the loop through an EvalLoopRunner port + a MeteredSessionBudget, not by importing the loop directly
status: candidate
provenance: hdl-creation-loop task 19.3 (Eval_Harness in app/eval)
tags: [eval, eval-harness, pass-at-k, session-budget, reproducibility, ports, cost-envelope]
timestamp: 2025-05-27T00:00:00Z
---

# Pattern

The Eval_Harness orchestrates and MEASURES; it does not construct the Verification_Loop or any provider.
Two seams make it unit-testable with fakes while still faithfully driving the real loop in integration (task 19.4).

1. `EvalLoopRunner` port (`runSample(request) -> Promise<VerificationOutcome>`). The harness does NOT call `VerificationLoop.verify` directly, because the per-sample seed + temperature (Req 15.10) must reach the provider through the Model_Router, which is built with the generation/testbench agents BENEATH the loop. Threading a per-sample seed therefore means constructing a seeded loop per sample - a composition-root concern (19.4), not a measuring-harness concern. So the harness injects a runner port; the production adapter builds a seeded `VerificationLoop` and calls `verify`, the unit test injects a deterministic fake.

2. `MeteredSessionBudget` (a `SessionBudgetHandle` that also exposes `consumed()`). The model-router `SessionBudgetHandle` port intentionally has NO "consumed cost" getter, but the harness needs per-session cost (Req 15.2). Rather than read budget internals from elsewhere, the harness owns a thin handle that delegates ALL accounting to the core `app/core/budget` functions (`chargeBudget`/`chargeBudgetIteration`/`budgetStopReason`) and adds a read-only `consumed()` snapshot. This reuses the single budget accountant (no re-implementation) AND gives the harness the cost number it must assert against the pennies-per-session envelope.

# Why this is oracle-honest (Req 15.3, 15.5)

A sample "passed" is defined as exactly `outcome.status === 'verified'`. The Verification_Loop only emits `verified` when a passing oracle verdict was recorded and bound by the Trust_Labeler, so the harness never inspects or trusts model output - it reads a status the oracle already decided. pass@k is the standard unbiased estimator (`1 - prod_{i=n-c+1}^{n}(1 - k/i)`) over that oracle-decided c.

# Gotchas that fell out of this

- Reproducibility (Req 15.10) is structural: iterate the subset in order, samples in index order, derive each per-sample seed deterministically (FNV-1a over `seed:problemId:sampleIndex`), and keep every reported number a pure function of the samples. Per-session budget ULIDs are nondeterministic but never appear in the report, so two runs `toEqual`. A fake runner keyed on the derived seed makes this testable without a provider.
- The eval layer MAY import core/knowledge/tools/agent/api but NOT `@app/test` (boundary lint). So eval tests use `fast-check` directly and cannot pull the shared `propertyParameters` helper.
- Config validation reuses core `DomainError`; eval-config codes are append-only additions to the closed `DomainErrorCode` union (same pattern task 19.1 used for the `EVAL_*` gate codes).
- Fail-safe: a runner that throws is classified `runner-error` (a non-pass) so one bad sample never aborts the whole eval run; its error detail never enters the report.

# Revisit trigger

When 19.4 wires the real `VerificationLoop`-backed `EvalLoopRunner`: confirm the seeded Model_Router actually threads `request.seed`/`request.temperature` into the fake provider adapter, and that the same subset run twice yields identical pass@k end to end (the non-vacuous half of Property 10).

# Links

- app/eval/harness.ts
- app/eval/loop-runner.ts
- app/eval/metered-budget.ts
- app/eval/metrics.ts
- app/eval/reproducibility.ts
