---
type: gotcha
title: Loop VerifiedModule.oracleSpanId vs LabeledArtifact.oracleSpanRef, and projecting Trace evidence for the Display_Layer
status: candidate
provenance: task 17.1 (full hero-loop integration test)
tags: [verification-loop, trust-labeler, display-layer, provenance, integration, testing]
timestamp: 2025-06-16
---

# What happened

Wiring the Verification_Loop outcome to the Display_Layer end to end, two field names that hold the SAME value are spelled differently and are easy to swap by mistake:

- `VerifiedModule.oracleSpanId` (the loop outcome) - the Trace span that is the ground truth.
- `VerifiedModule.label.oracleSpanRef` (the `VerifiedArtifact` label) - the provenance the label is bound to.

They are equal by construction (the loop sets both from the same recorded span id), but `verified.oracleSpanRef` does NOT exist and fails to type-check. The editor language server did not flag it in this case; only `tsc -b app/test --force` did. Always run the real `tsc -b`, not just editor diagnostics.

# Rule / recipe

To feed the Display_Layer (`decideTrustTreatment` / `createDisplayLayer().resolveTreatment`) real evidence from the recorded Trace, project the passing `Verification_Loop` verdict spans, NOT a synthesized stub:

```ts
trace.spans
  .filter((s) => s.stageOrTool === 'Verification_Loop')
  .filter((s) => asRecord(s.outputs).verdict === 'pass')
  .map((s) => ({ spanId: s.id, artifactRef: verified.label.artifactRef, verdict: 'pass' as const }));
```

The projected `spanId` (= `span.id`) equals both `verified.oracleSpanId` and `verified.label.oracleSpanRef`, so the display validates the label against the actual Trace. To prove "Verified only because provenance validates", re-run the SAME label against `[]` (fails closed -> `unvalidatable-provenance`) and against a tampered `oracleSpanRef: newUlid()` (also fails closed). This is the crux of Req 14.13-14.15 end to end.

# Links

- app/agent/orchestrator/verification-loop.ts (VerifiedModule.oracleSpanId)
- app/core/models/labeled-artifact.ts (VerifiedArtifact.oracleSpanRef)
- app/web/display/trust-treatment.ts (decideTrustTreatment; OracleVerdictSpan evidence)
- app/test/hero-loop.integration.test.ts (oracleEvidenceFromTrace, assertDisplayLayerProvenance)
