---
type: pattern
title: Iteration re-verification via role-local ports (no orchestrator import cycle); demotion by absence of provenance
status: candidate
provenance: task 16.1 (Iteration_Agent S9), app/agent/roles/iteration
tags: [agent, roles, iteration, trust-labeler, verification-loop, dependency-direction]
timestamp: 2025
verifiedBy: "npx tsc -b app/agent; npx eslint app/agent/roles/iteration --max-warnings=0; npx vitest run app/agent (43 passed)"
---

# Pattern

A role under `app/agent/roles/*` must not import from `app/agent/orchestrator`, because the orchestrator (e.g. `verification-loop.ts`) already imports the roles - importing back creates a cycle.
When a role needs to drive the Verification_Loop (as the Iteration_Agent does for re-verification), define narrow role-local PORTS (`IterationReVerifier`, `IterationSpecUpdater`) plus role-local input/result types, and let the composition root adapt `VerificationLoop.verify`'s `VerificationOutcome` onto the role-local `ReVerifyResult`.
The role never names an orchestrator type.

# When to use

Any inner role that must reuse an outer orchestrator capability. Invert the dependency with a port owned by the inner role.

# Recipe / example

- `IterationReVerifier.reVerify({ intent, spec }, budget, limits): Promise<ReVerifyResult>` - satisfied at the wiring root by an adapter over `VerificationLoop.verify`.
- Demotion (Req 10.7) is expressed by DERIVING `unverified(editedRef)` (`demoteOnEdit`), never by clearing a flag: a new module version has no passing oracle span, so it is `Unverified` until the loop records a fresh pass. The positive `Verified` label only ever comes from the loop's oracle-derived Trust_Labeler.
- The conversational change is applied to the SPEC (source of truth) via `IterationSpecUpdater`; interface change is then DETECTED by comparing updated vs current `ModuleInterface` (`interfaceChangedBetween`), so the loop regenerates the Testbench from the updated Spec (spec-consistent re-verification holds by construction).

# Pitfalls

- Do not fold the requested change straight into RTL and bypass the Spec: that breaks the S1->S4->S6->S7 pipeline and the anti-circular guarantee across iterations.
- `VerificationLoop.verify` always regenerates the Testbench from the Spec you pass; there is no seed-candidate entry point, so "reuse the existing testbench" for a non-interface change is modeled as re-deriving from the unchanged Spec (still spec-consistent), not by handing the loop an existing testbench.

# Links

- app/agent/roles/iteration/{types,diff,iteration-agent}.ts
- app/agent/orchestrator/verification-loop.ts
- .kiro/specs/hdl-creation-loop/design.md (Iteration demotion)
