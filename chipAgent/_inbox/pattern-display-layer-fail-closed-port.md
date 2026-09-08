---
type: pattern
title: Fail-closed Display_Layer with an injected discrepancy port (app/web)
status: candidate
provenance: task 15.1 (hdl-creation-loop) - app/web/display
tags: [web, trust, fail-closed, layering, ports]
timestamp: 2025-02-14
verifiedBy: tsc -b app/web; eslint --max-warnings=0; vitest run app/web (47 passing)
---

# Pattern

The web Display_Layer applies a Trust_Tier visual treatment ONLY after a pure, rendering-free integrity check on the label's oracle provenance.
The decision function `decideTrustTreatment(rawLabel: unknown, evidence): TrustTreatmentDecision` is kept pure and separate from any React/rendering so the property test (task 15.2, Property 2) can state over it directly.
The thin `createDisplayLayer(port)` edge runs the decision, emits any discrepancy, and returns a display model that always carries the resolved tier (Req 14.5).

# When to use

Any outer-layer surface that must fail closed on an untrusted trust claim: apply the trusted treatment only on validated evidence, otherwise degrade to the less-trusted treatment and record the anomaly - never the reverse.

# Recipe / example

- Treat the streamed label + provenance ref as UNTRUSTED: the decision takes `unknown` and validates shape at the boundary (artifactRef kind/ULID id/non-negative version, tier, oracleSpanRef).
- Reuse `@app/core`'s `OracleVerdictSpan` as the Trace evidence shape (the same projection the core Trust_Labeler consumes) - do not invent a second representation.
- `Verified` treatment iff tier is `Verified` AND ref is a valid ULID AND a matching PASSING span for the exact (kind,id,version) exists. Else fail closed to `Unverified`.
- Emit the discrepancy through an INJECTED port defined in web terms (`DiscrepancyEmitPort.emit`), not by importing app/agent: `web -> api -> agent` is inward-only. The composition root wires the port to the Action_Recorder.
- Reuse the core injective mapping (`treatmentForTier`); never re-derive correctness and never run a simulator in web.

# Pitfalls

- A discrepancy is recorded ONLY when a label that CLAIMS `Verified` is rejected (Req 14.15). A plain `Unverified`/`Not_Applicable` label, or unreadable junk, fails closed to `Unverified` with NO discrepancy - otherwise the Trace fills with noise.
- Keep the emit port fire-and-forget and non-throwing so rendering never blocks on Trace persistence; the decision is already made before `emit` is called.
- Only propagate the offending span ref into the discrepancy when it is a valid ULID; otherwise `null`, so no untrusted free-form string reaches the Trace.

# Links

- app/web/display/{trust-treatment,display-layer,discrepancy}.ts
- .kiro/specs/hdl-creation-loop/design.md (Display_Layer fail-closed check; Property 2)
- app/core/trust/index.ts (TRUST_TIER_TREATMENTS, OracleVerdictSpan)
