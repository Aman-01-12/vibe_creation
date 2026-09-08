---
type: gotcha
title: The eval gate's "equal-to-baseline never blocks" needs a structural floor < baseline invariant
status: candidate
provenance: hdl-creation-loop task 19.1 (app/core/eval-gate)
tags: [typescript, domain-modelling, invariants, eval-gate, ci, core]
timestamp: 2025-05-27T00:00:00Z
---

# What happened

Property 28 / Req 15.4 require that a measured pass@k equal to the baseline never blocks the merge, while Req 15.8 requires that a pass@k at or below the absolute floor always blocks (catastrophic total-failure can never merge, regardless of baseline).
Written naively, `decideEvalGate` checks `measured <= floor` first, so a degenerate armed-gate config with `floor === baseline` (or `floor > baseline`) would block an at-baseline run, directly contradicting Req 15.4.

# Root cause

The two acceptance criteria only coexist when the absolute floor sits strictly below the ratcheting baseline.
Nothing in the raw numeric inputs enforces that, so the contradiction is reachable from an unvalidated config.

# Fix / rule

Enforce `floor < baseline` at construction in `makeArmedGate` (new domain error `EVAL_FLOOR_NOT_BELOW_BASELINE`), so an `ArmedGate` value can only exist when the invariant holds.
Then "equal-to-baseline never blocks" is a theorem, not a runtime accident: with `floor < baseline` and `tolerance >= 0`, a measured value equal to the baseline is always strictly above the floor and never below `baseline - tolerance`.
General rule for this codebase: when two acceptance criteria can contradict on a boundary input, make the reconciling relationship a construction-time invariant on a discriminated-union arm rather than trusting callers or ordering guard clauses.

Companion decisions in the same module:
- `armed` is a discriminated union (`UnarmedGate | ArmedGate`), so baseline/tolerance/floor exist only when armed (optionality made explicit; matches the sibling note on unions over optional flags).
- The baseline can only rise via `ratchetBaseline` (total, never lowers); lowering is a distinct `lowerBaselineWithReview` that refuses anything not an approved (`approved: true` literal), reasoned, genuine decrease. No silent downward path (Req 15.9).

# Links

- app/core/eval-gate/index.ts
- app/core/models/domain-error.ts
