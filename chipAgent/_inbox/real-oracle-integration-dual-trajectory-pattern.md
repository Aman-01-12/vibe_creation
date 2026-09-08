---
type: pattern
title: Real-oracle integration tests - shared skip harness + dual real/fake trajectory
status: candidate
provenance: hdl-creation-loop task 14.2 (Verification_Loop integration test), building on 3.8
tags: [integration-tests, oracle, iverilog, skip, non-vacuous, verification-loop, test-harness]
timestamp: 2025-05-27T00:00:00Z
verifiedBy: tsc -b app/test; eslint; vitest run (fake trajectories pass, real trajectories skip)
---

# Pattern

Any integration test that says "through the real oracle" (iverilog + vvp) must do two things at once:
1. Gate the real-oracle assertions behind the shared capability probe and skip cleanly when the toolchain is absent, so a toolchain-less CI never fails spuriously.
2. Drive the SAME trajectory through a `FakeSandboxRuntime`-backed Simulator in an always-run suite, so the test is non-vacuous (real logic exercised) even when the real oracle is missing.

# When to use

Building integration tests for the Verification_Loop and everything downstream that re-runs it (S9 Iteration, Teach_Mode handoff, Eval_Harness) - anywhere the design asks for the real Icarus oracle but the dev/CI box has no iverilog/vvp/gVisor.

# Recipe / example

- Reuse `app/test/real-oracle-harness.ts` (single owner): it exports `PROBE`, `realOracleAdapter()`, `LocalWorkerRuntime`, and the shared counter fixtures (`COUNTER_MODULE_NAME`, `COUNTER_TESTBENCH`, `PASSING_COUNTER_RTL`, `BUGGY_COUNTER_RTL`). Do NOT re-inline the probe/worker-runtime per test; 3.8 and 14.2 both consume this module.
- Express each trajectory ONCE as `assertX(simulator: SimulatorAdapter)`, then call it from a `describe(...)` (fake sim, always runs) and a `describe.skipIf(!PROBE.available)(...)` (real sim). The two suites then assert identically and cannot drift.
- Fake captures emit the `CHECK <name> PASS|FAIL` stdout convention plus a `$dumpfile` VCD so the adapter classifies functionally, not as a missing-artifact error.
- The loop names workspace files from the TRUSTED spec module name, so the spec's `moduleInterface.moduleName` must equal the testbench's instantiated module (`counter`); candidate RTL is written as `<moduleName>.v`, testbench as `<moduleName>_tb.v`.
- Read the Trace back via `recorder.getTrace(sessionId)` and filter `stageOrTool === 'Verification_Loop'`; `outputs.verdict` and `outputs.iteration` survive redaction, so assert ordered spans (ascending seq, contiguous 1-based iteration) for Req 8.8.

# Pitfalls

- Budget accounting counts EVERY charge as one iteration (generation + testbench in setup, then each simulate + each repair). With `maxIterations = N`, setup burns 2, so the number of simulate iterations before exhaustion is bounded but < N; assert `iterations <= maxIterations`, not equality.
- The candidate is always simulated before the budget check, so a pass on the last affordable run still yields `Verified` (Req 8.9) - keep that in mind when picking caps for an exhaustion test (make the candidate never pass, not merely "run out").
- `ConfirmedGenerationContext` has a symbol-guarded constructor; tests mint it via `as unknown as ConfirmedGenerationContext` and must keep the `sessionId` to read the Trace.

# Links

- app/test/real-oracle-harness.ts
- app/test/verification-loop.integration.test.ts
- app/test/icarus-oracle.integration.test.ts
- chipAgent/_inbox/real-oracle-and-containment-unexercised-m0.md
