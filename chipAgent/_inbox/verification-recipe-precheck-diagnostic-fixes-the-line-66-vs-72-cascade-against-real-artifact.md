---
type: verification-recipe
title: PrecheckDiagnostic verified against the actual campaign artifact - names line 66, not the line-72 iverilog cascade
status: candidate
provenance: testbench-dialect-normalization spec, tasks 9.1/9.2
tags: [verification-loop, precheck, diagnostic, iverilog, verification-recipe, evidence]
timestamp: 2025-06-19T00:00:00Z
verifiedBy:
---

# What this closes

This spec's own motivating evidence was: `Malformed statement` appears 54 times across the
measured 48 precheck failures, and it is an iverilog CASCADE - in the FIRST sample the real
defect is at line 66 (a stray `}` where Verilog needs `end`) and the cascade is reported at
line 72. `TestbenchPrecheck.runWithDiagnostic` used to return `verdict.stderr` whole, so a
Repair_Hint pointed six lines past the actual defect.

Tasks 9.1/9.2 replaced that with a closed `PrecheckDiagnostic` selecting, by MEMBERSHIP (basename
match against `testbench.path`, never text extraction from untrusted diagnostic content), the
FIRST line naming the Testbench file that also contains `syntax error` - preferring it over any
later cascade line naming the same file.

# How it was verified - against the real artifact, not a synthetic approximation

`.eval-runs/stage1-screen-repair-v1/artifacts/deepseek.v3.2/rtllm_control_JC_counter/sample-0/`
holds the ACTUAL captured `testbench.v` from the campaign. Independently re-ran real
`iverilog -g2012 -t null` against it and reconfirmed: `syntax error` at line 66, `Malformed
statement` cascade at line 72.

Drove `TestbenchPrecheck.runWithDiagnostic` through a fake `SimulatorAdapter` replaying that
EXACT captured verdict (not a hand-built minimal repro). Confirmed `firstError` names line 66
and `sourceLine.text` reports its actual content (`}`) - never the line-72 cascade.

# Pattern worth repeating

When a spec is motivated by a specific measured artifact (a real campaign run, a real defect
line), verify the fix against THAT artifact directly rather than only a hand-built minimal
repro. A synthetic case can accidentally avoid exercising the exact code path the real evidence
took (different toolchain version, different cascade shape, different attribution logic). The
real artifact is already committed evidence (or, here, reachable from `.eval-runs/` before the
Dialect_Fixture task copies a curated subset into `app/test/fixtures/dialect/`), so replaying it
costs nothing extra.

# Links

- `app/agent/orchestrator/testbench-precheck.ts` (`PrecheckDiagnostic`, `selectFirstError`, `diagnoseBuildFailure`)
- `app/agent/orchestrator/repair-hint.ts` (`describePrecheckDiagnostic`)
- `.eval-runs/stage1-screen-repair-v1/artifacts/deepseek.v3.2/rtllm_control_JC_counter/sample-0/`
- [[gotcha-testbench-repair-near-zero-is-two-mechanical-dialect-classes-not-a-feedback-problem]] (the original diagnosis this fixes)
