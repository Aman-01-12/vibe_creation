---
type: gotcha
title: SandboxResult collapses timeout/infra/missing-output into one `error` verdict
status: candidate
provenance: task 15.3 (Waveform_Viewer + Schematic_View); app/tools/synth
tags: [tools, sandbox, eda-adapter, error-handling]
timestamp: 2025-05-27
---

# What happened

While building the Synth adapter (`app/tools/synth`) on top of the Tool_Runner sandbox, I wanted to map a failed run to a specific `unavailable` cause (timeout vs tool crash vs missing output).
The post-classification `SandboxResult` does not carry that distinction: `classifyCapture` folds `timedOut`, `infraFailure`, and any missing required output into a single `verdict: 'error'`.
Only the pre-classification `RawRunCapture` has the separate `timedOut` / `infraFailure` flags, and that never leaves the sandbox package.

# Root cause

Capture-all-or-error (Property 8) is intentionally coarse: the sandbox's single job is "did the run complete with all required outputs, yes/no", so it deliberately does not preserve the failure sub-cause in its public result.

# Fix / rule

An EDA adapter layered on the sandbox (simulator, synth, future ones) must derive its own `unavailable`/`error` cause from what the `SandboxResult` DOES expose: `verdict === 'error'` (any incomplete run), `exitCode` (tool ran but rejected the design), and presence/absence of specific `artifacts[...]` keys (nothing drawable/parseable produced).
Do not expect to distinguish "timeout" from "infra failure" at the adapter layer, and never reach for `RawRunCapture` above the sandbox boundary.
Keep the sanitized reason strings a fixed table keyed by that coarse cause; never interpolate `stderr` (it can carry paths).

# Links

- app/tools/synth/adapter.ts (`interpretSynthResult`, `SYNTH_UNAVAILABLE_REASONS`)
- app/tools/sandbox/classification.ts (`classifyCapture`)
- app/tools/simulator/adapter.ts (`interpretSandboxResult`, same shape)
