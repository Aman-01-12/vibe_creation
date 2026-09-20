---
type: gotcha
title: Widening SimulationVerdict with required fields breaks production fallback literals too, not just test fixtures
status: candidate
provenance: task 1.4 of .kiro/specs/instrument-precheck-and-attribution (adding failureCause/attributedFiles to SimulationVerdict)
tags: [tools, simulator, adapter, typescript, required-fields, refactor, blast-radius]
timestamp: 2026-09-22T00:00:00Z
verifiedBy:
---

# What happened

Adding two REQUIRED fields (`failureCause`, `attributedFiles`) to `SimulationVerdict` in
`app/tools/simulator/adapter.ts` was scoped by the task text as a test-fixture update
(golden-scorer, rtllm-instrument-control, mutation-calibration, rtllm-golden-judge, plus
arbitraries).
`tsc -b` also caught three PRODUCTION call sites that hand-construct a `SimulationVerdict`
object literal outside of `interpretSandboxResult`: a `toolFailureVerdict()` helper duplicated
verbatim in `app/agent/orchestrator/self-healing.ts`, `skeleton.ts`, and `verification-loop.ts`.
Each synthesizes an `error` verdict for the case where the injected `SimulatorAdapter.simulate`
itself THREW, before any `SandboxResult` existed to classify.

# Root cause

A required field on a shared interface is a compile-time search for every literal that
satisfies that interface, and TypeScript's structural typing does not care whether the literal
sits in a test file or a `catch` block in orchestration code.
The task description's own file list was a best-effort enumeration, not a proof of completeness -
grepping for `verdict: 'error'` alongside `SimulationVerdict` return-type annotations found the
three production sites the description didn't name.

# Fix / rule

- After widening a shared result/verdict type with a required field, grep for every literal that
  satisfies it - don't trust a hand-enumerated file list, even one written by the task author.
  `grep -n "SimulationVerdict" **/*.ts` (excluding `dist/`) plus a scan for `verdict: '<value>'`
  literals is enough to catch both test fixtures and production fallback paths.
- For a "the tool threw, we never got a `SandboxResult`" fallback, there is no diagnostic
  evidence to classify FROM, so the honest value is the catch-all cause the closed union has for
  exactly this: `RunFailureCause`'s `tool-failed` ("error with no cause we can name"). Do not
  invent a more specific cause (`build-failed`, `timed-out`) for a synthesized verdict that never
  saw a real run.
- These three sites are a single duplicated helper (`toolFailureVerdict()`), copy-pasted across
  three orchestrator files rather than shared. Left as-is for this task (out of scope to
  deduplicate mid-spec), but worth flagging: a fourth caller of the same shape would be the third
  copy to independently get right.

# Links

- `app/tools/simulator/adapter.ts` (`SimulationVerdict`, `interpretSandboxResult`)
- `app/tools/simulator/failure-attribution.ts` (`RunFailureCause`, `classifyRunFailure`)
- `app/agent/orchestrator/{self-healing,skeleton,verification-loop}.ts` (`toolFailureVerdict`)
- [[gotcha-simulation-verdict-collapses-error-causes]] (the collapse this task closes)
- `.kiro/specs/instrument-precheck-and-attribution/` (design.md "SimulationVerdict delta", Property 1)
