---
type: pattern
title: Teach_Mode grounds each claim by its TYPE, with a literal-typed non-omittable limit
status: candidate
provenance: hdl-creation-loop task 16.4 (Teach_Mode role)
tags: [typescript, domain-modelling, invariants, trust-labeling, teach-mode, agent]
timestamp: 2025-05-27T00:00:00Z
---

# Pattern

Teach_Mode explanations mix two claim kinds that need DIFFERENT grounding (Req 11.2, 11.3, 11.7, 11.8).
Model this as a discriminated union on `kind` so the wrong grounding is unrepresentable:
a `design` claim structurally carries a `ToolOutputRef` (oracle verdict / recorded Trace span / VCD reading);
a `general` fact structurally carries a `Citation`.
A design claim can never be grounded by a citation and vice versa, and both may appear in one `claims` list.

A single pure `groundClaim(claim, session, explanationRef)` decides disposition: `taught` only when the
grounding actually RESOLVES against the session's real artifacts (ids match a recorded verdict/span, or a
signal present in the session VCD; a general-fact citation must match one the Knowledge_Retriever surfaced
this session), else `unverified` (reusing the core `unverified()` labeler) or `omitted` (empty statement).
So "ungrounded => Unverified or not taught" (Req 11.6, 11.9) holds by construction, and Teach_Mode can never
invent an artifact.

# When to use

Any role that presents mixed model-authored claims where correctness grounding differs by claim type, and
where "LLM proposes, oracle/citation decides" must be enforced structurally rather than by prose.

# Recipe / example

- Reuse `presentExternalFact` (@app/knowledge) as the single Cited-vs-Unverified derivation for general facts;
  add a session-availability gate on top so a fabricated citation still lands `Unverified`.
- Make a mandatory statement non-omittable via the type system: type the field as the literal constant
  (`simulationVsSiliconLimit: typeof SIMULATION_VS_SILICON_LIMIT`). A `Verified` presentation then cannot be
  built without stating the simulation-vs-silicon limit (Req 11.5) and cannot alter its text.
- Keep the whole grounding decision pure (teach-claims.ts) so the property test (16.5) and example tests
  (16.6) state directly over `groundClaim` / `assembleExplanation` / `presentVerifiedResult` / `coachFailingCase`.
- The explanation ARTIFACT stays `Not_Applicable` (pedagogy); only its claims carry grounding.

# Pitfalls

- Barrel collision: `roles/index.ts` uses `export *`, and intent already exports `ModelOutputParseError`.
  Alias role-local parse-error types on re-export (exported here as `TeachClaimsParseError`) to avoid an
  ambiguous star re-export.
- Coach on the failing case (Req 11.4/11.8) must ground in the oracle verdict span and never hide the failure;
  build the guidance deterministically from the real `FailingCase`, not from free model text.

# Links

- app/agent/roles/teach/types.ts
- app/agent/roles/teach/teach-claims.ts
- chipAgent/_inbox/discriminated-union-invariants-over-optional-flags.md
- chipAgent/_inbox/pattern-iteration-role-local-ports-avoid-orchestrator-cycle.md
