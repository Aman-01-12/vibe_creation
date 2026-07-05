---
type: pattern
title: Encode "provenance iff Verified" as a discriminated union, not an optional field
status: candidate
provenance: hdl-creation-loop tasks 2.1 (domain types) and 2.2 (verdict)
tags: [typescript, domain-modelling, invariants, trust-labeling, core]
timestamp: 2025-05-27T00:00:00Z
---

# What was attempted

The design sketched `LabeledArtifact` as a single interface with an optional `oracleSpanRef?`.
The implementation instead modelled it as a discriminated union on `tier`: `VerifiedArtifact` (carries a required `oracleSpanRef`) | `UnverifiedArtifact` | `NotApplicableArtifact`.

# Why this is better

"A Verified label has provenance, and only a Verified label has provenance" (Req 14.8/14.12) becomes a compile-time guarantee: a Verified artifact without a span, or an Unverified/Not_Applicable artifact carrying a span, does not type-check.
Optional-field modelling can only enforce this at runtime.
Smart constructors still reject an empty/non-ULID span at construction, so the runtime boundary is covered too.
Trust tier stays derived: there is no writable `verified` boolean anywhere; a label is only ever produced by the Trust_Labeler from a recorded passing oracle span.

# Companion rule: single-owner predicates

The pass-integrity rule lives once in `app/core/verdict` as `passIntegrityHolds(verdict, allChecksPassed)`.
`verification.ts` imports it rather than re-implementing, so the classifier and the `VerificationResult` constructor can never diverge.
Consumers of the union form: task 8.3 (Trust_Labeler) and any Property tests (2.3/2.4/8.x) should destructure on `tier`, not read an optional field.

# Links

- app/core/models/labeled-artifact.ts
- app/core/verdict/index.ts
