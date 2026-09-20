---
type: gotcha
title: An unconditional new simulate call inserted before the iteration loop silently shifts order-dependent fake sandbox sequences
status: candidate
provenance: task 4.2 (instrument-precheck-and-attribution spec), spec-task-execution subagent
tags: [testing, fakes, verification-loop, sandbox, order-dependent, precheck, regression]
timestamp: 2026-09-19T21:55:50Z
verifiedBy: 
---

# Gotcha

Task 4.2 made `VerificationLoop` construct and unconditionally run a `TestbenchPrecheck`
(one extra `simulator.simulate(...)` call) between `#setup` succeeding and the first repair
iteration. Three existing tests broke silently in the sense that they still ran and still
produced a verdict - just the WRONG one - because their fake `SimulatorAdapter`/
`FakeSandboxRuntime` scripts a response sequence keyed by a call COUNTER (`runs++ === 0 ?
fail : pass`, or an index into a scripted array), not by what job was actually submitted.

The new precheck call consumes slot 0 of that sequence. Every subsequent real iteration's
expected capture then shifts by one, so a test expecting 2 iterations (fail then pass)
instead saw `iterations: 1` - the precheck's fail-capture at slot 0 got consumed as "iteration
1 failed", and the scripted pass at slot 1 was read as "iteration 1 passed", collapsing what
should have been a 2-iteration repair loop.

Affected files (all test-only): `app/agent/orchestrator/verification-loop.test.ts`,
`app/test/verification-loop.integration.test.ts`, `app/test/hero-loop.integration.test.ts`.
Two other `fakeSimulator` users (`app/test/eval-harness.integration.test.ts`,
`app/test/iteration-edit-demotion.property.test.ts`) were unaffected because their fakes
derive the response from the submitted `SandboxJob` content, not from a call counter.

# Root cause

Any fake collaborator whose scripted response depends on CALL ORDER rather than on the
content of the call it received is fragile to a new, earlier call being inserted anywhere in
the production code path - even one that is designed to be a safe, refusal-only no-op on the
happy path. The fake has no way to distinguish "the precheck asking" from "iteration 1
asking".

# The fix (root-caused, not patched around)

Made each affected fake PRECHECK-AWARE by detecting the precheck's own call via the STABLE,
DOCUMENTED marker it already exposes: `TestbenchPrecheck`'s stub file is always named via
`INTERFACE_STUB_MODULE` (`testbench_precheck_stub.v`, defined in
`app/agent/orchestrator/testbench-precheck.ts`). Since `FakeSandboxRuntime`'s callback already
receives the full `SandboxJob` (including `workspaceFiles`), the fake can check for that
specific path and answer it with a benign, non-advancing capture, leaving the counter/index
untouched for every REAL iteration call.

Before trusting this was semantically safe (not just test-green), the subagent verified against
`classifyRunFailure`'s actual rule: it only reports `'build-failed'` when `verdict === 'error'`
AND stderr names a submitted path at a `path:line` location. Every affected fixture's benign
capture has empty stderr, so the precheck call could never have been wrongly classified
`'testbench-build-failed'` even before the fix - only the counter bookkeeping was wrong.

# Rule going forward

When inserting a new, unconditional call into a production code path ahead of an existing
loop, any test double keyed by call ORDER (not by call CONTENT) is a candidate for silent
breakage - "still green, wrong number" rather than a compile error or an obvious failure.
Prefer content-derived fake responses (branch on what the job actually is) over
counter/index-based ones; where a counter-based fake already exists and must be kept, give the
new call a stable, importable identifying marker (a filename constant, in this case) so a fake
can special-case it without becoming order-dependent on the new call's position.

# Links

- `app/agent/orchestrator/verification-loop.ts` - `#admitInstrument`, the new unconditional call.
- `app/agent/orchestrator/testbench-precheck.ts` - `INTERFACE_STUB_MODULE`, the marker used.
- [[pattern-faithful-fake-detects-stale-input-defect]] - a related fake-design principle (derive
  fake output from input) in the same spirit as this fix.
