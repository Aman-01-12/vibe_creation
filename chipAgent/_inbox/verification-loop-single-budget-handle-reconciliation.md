---
type: decision
title: Verification_Loop threads ONE router-port SessionBudgetHandle through generation, testbench, and its own simulate accounting
status: candidate
provenance: hdl-creation-loop task 14.1 (Verification_Loop S7)
tags: [agent, orchestrator, session-budget, verification-loop, termination, budget-reconciliation]
timestamp: 2025-05-27T00:00:00Z
---

# Decision

Two `SessionBudgetHandle` shapes exist in the codebase and it is tempting to bridge them inside the loop.
They must NOT both be used inside the Verification_Loop.

- `app/core/budget` exposes an IMMUTABLE handle (`openSessionBudget`) with `admit()` / `chargeIteration()` / `charge(BudgetCharge)` returning a fresh handle.
- `app/agent/model-router/budget-handle.ts` exposes a MUTABLE port (`InMemorySessionBudgetHandle`) with `canAfford()` / `charge(AttemptCost)` / `stopReason()`, built from a core `SessionBudget` record.

The Generation_Agent and Testbench_Agent already consume the MUTABLE router-port handle (they hand it to `ModelRouter.invoke`, which charges it).
So the Verification_Loop takes that SAME mutable router-port handle and threads the one object through generation, testbench, AND its own per-iteration simulate accounting.
One budget bounds the whole loop; do not open a second core handle and try to keep the two in sync.

# Context / options considered

- Option A (rejected): loop uses the core immutable handle for its own iteration accounting and passes the router-port handle to the agents. This creates two divergent copies of "how much budget is left" - exactly the coupling the budget-handle.ts note warns against.
- Option B (chosen): single mutable router-port handle everywhere. Each model call (charged by the Model_Router) and each simulate (charged by the loop via `budget.charge({ tokens: 0, costCents: 0, wallClockMs })`) increments `consumedIterations`, so within `maxIterations` the loop always terminates.

# Gotchas that fell out of this

- Do NOT gate the FIRST simulate on budget. Simulate the candidate you already hold, THEN check budget only before repairing. A pass discovered on the last affordable run must still yield `Verified` (Req 8.9) - the label depends on the recorded verdict, never on budget status.
- Cost rollup: the router-port handle has no public "consumed cost" getter, and the generate/revise primitives return `CandidateEval`, not cost. Per-step model cost is recorded on the agents' own Trace spans (Req 8.8 is satisfied at Trace granularity); the loop's `VerificationResult.costCents` rollup is the tool cost it observes (0 for a simulate run). Do not fabricate a rollup number.
- `makeVerificationResult` only validates the PASS case (pass-integrity + provenance). For the non-pass `Unverified` result, build the literal directly - pass-integrity is vacuously satisfied and the validating constructor would force an awkward Result-unwrap for no invariant gain.

# Revisit trigger

If task 8.1's core budget accountant is chosen to implement the router-port `SessionBudgetHandle` interface (or a shim adapts it), re-check that the loop still threads exactly one handle instance.

# Links

- app/agent/orchestrator/verification-loop.ts
- app/agent/model-router/budget-handle.ts
- app/core/budget/index.ts
