---
type: decision
title: Task 10.1 inlines TestbenchRepair and repairTriggerFor locally in harness.ts rather than restoring the deleted files
status: candidate
provenance: testbench-dialect-normalization spec, task 10.1 (deleting app/eval/testbench-repair.ts and app/agent/orchestrator/testbench-repair.ts)
tags: [hdl, verification, eval, repair-loop, harness, dead-code-retirement, app-eval, testbench-dialect-normalization]
timestamp: 2026-01-01T00:00:00Z
---

# Decision

Task 10.1 deletes `app/eval/testbench-repair.ts` (`EvalTestbenchRepair`, `RepairingTestbenchGenerator`, `repairTriggerFor`) and `app/agent/orchestrator/testbench-repair.ts` (the `TestbenchRepair` port and its request/outcome types) in full, per design.md Component 16.
But `app/eval/harness.ts`'s own control-path repair machinery (`#buildTestbenchRepair`, `#repairIfTriggered`, `withRevisedTestbench`, `EvalHarnessDeps.testbenchRepairFor`) is explicitly task 10.2's deletion, not 10.1's - the tasks file separates them on purpose.
Deleting the two dependency files in 10.1 while leaving `harness.ts`'s consumers of them intact for 10.2 is therefore a real, unavoidable intermediate non-compiling state, not a mistake.

Fixed by inlining a private, unexported `TestbenchRepair` interface and a private `repairTriggerFor` function directly inside `app/eval/harness.ts`, byte-for-byte equivalent to what the deleted files declared, immediately after the import block, with a comment block explaining the hand-off to task 10.2 (which deletes this whole inlined block along with everything that reads it).
`harness.test.ts`'s own local fake (`stubPort`) lost its `TestbenchRepair` type annotation and now relies on structural inference against `EvalHarnessDeps.testbenchRepairFor`'s parameter type, since the local interface in `harness.ts` is not exported for a test file to name.

# Context / options considered

- Restore the deleted files until 10.2: rejected - directly contradicts design.md Component 16's explicit deletion list; the whole point of 10.1 is that the two files no longer exist.
- Delete `#buildTestbenchRepair`/`#repairIfTriggered`/`withRevisedTestbench` early (do 10.2's work inside 10.1): rejected - explicitly forbidden by the task's own sequencing note ("task 10.2 is a SEPARATE, later task... DO NOT do those three tasks' work now").
- Inline the two small pieces `harness.ts` actually needs, unexported, with a hand-off comment: chosen - keeps 10.1 scoped to exactly its nine deletions, keeps `harness.ts` compiling, and gives 10.2 a clearly marked block to delete instead of a scattered diff to reconstruct.

# Rationale

`TestbenchRepair` and `repairTriggerFor` had exactly one remaining call site each after 10.1 (`harness.ts`'s `#buildTestbenchRepair`/`#repairIfTriggered` and the `port: TestbenchRepair | null` parameter), so inlining costs about 40 lines and zero behavior change - `repairTriggerFor`'s body, `TRIGGERING_DEFECTS`, and the port's `repair()` shape are copied verbatim from the deleted files.
`ruleFamilyFor` and `requiredChecks` are unaffected: design.md's "What is KEPT" list keeps them in `@app/agent`, so the inlined `repairTriggerFor` still imports them normally rather than also inlining them.

# Revisit trigger

Task 10.2 deletes this entire inlined block (the comment marks its exact boundaries) along with `#buildTestbenchRepair`, `#repairIfTriggered`, and `withRevisedTestbench`. If 10.2 is executed and the block survives, that is a regression of this decision, not a valid keep.

# Links

- `app/eval/harness.ts` (the inlined block, and `EvalHarnessDeps.testbenchRepairFor`)
- `app/eval/harness.test.ts` (`stubPort`, now untyped/inferred)
- `.kiro/specs/testbench-dialect-normalization/tasks.md` (task 10.1, task 10.2)
- `.kiro/specs/testbench-dialect-normalization/design.md` Component 16
</content>
