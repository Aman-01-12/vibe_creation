---
type: verification-recipe
title: testbench-dialect-normalization checkpoint 2 - RC-1 and RC-2 (repair accounting) fixed and gate-clean at 1710/6/0
status: candidate
provenance: testbench-dialect-normalization spec, tasks 1.1/1.2/1.5/1.7, checkpoint 2
tags: [eval, repair-loop, verification-recipe, accounting, testbench-repair-loop, checkpoint]
timestamp: 2025-06-19T00:00:00Z
verifiedBy:
---

# What this milestone closes

The two accounting defects (RC-1, RC-2) that made `stage1-screen-repair-v1`'s 259/2 number
uninterpretable are now structurally fixed and independently gate-verified, BEFORE any
Dialect_Normalizer code exists. This was the spec's own mandated ordering
(`clarification-answers.md` Q1): nothing else is measurable until this lands.

- RC-1 (Req 4.2): a declined control-path repair no longer records `attempted: false`.
  `#repairIfTriggered` (`app/eval/harness.ts`) now returns a `RepairProvenance` directly;
  `mergeRepairProvenance(precheck, control)` replaces the old `wasRepaired ? {...} : ...`
  ternary that discarded declines.
- RC-2 (Req 4.7): the precheck-path `RepairHint` no longer dies as a local. It rides out on
  `RepairProvenance` (both the declined and accepted members carry `hint`), so
  `captureSampleArtifacts` derives it by narrowing `measured.repairProvenance` - one source
  of truth, no parallel field that can disagree.

# Concrete proof, not just "tests pass"

A control-path decline (port returns `{decision: 'not-repaired'}`) now persists:
`{"attempted":true,"accepted":false,"hint":{...},"declineReason":"no-admissible-revision"}`
- verified with a scratch test during task 1.5, then deleted.

# The gate

Run individually, never chained (chaining times out in this workspace):
```
npx tsc -b --force
npx eslint app --max-warnings=0
npx prettier --check .
npx vitest run
npm run build
```
Result: 1710 passed / 6 skipped / 0 failed (Test Files 148 passed | 1 skipped), tsc/eslint/
prettier/build all exit 0. No `app/agent` file imports `@app/eval` (grepped directly).
This is the SAME baseline the spec inherited from `testbench-repair-loop` - the accounting
fix changed zero test outcomes, only what a future decline is capable of recording.

# Gotcha this surfaced (already captured separately, cross-referenced here)

Implementing `mergeRepairProvenance` required calling `.attempted` on
`repairProvenanceOf(outcome)`'s return in the common path for the first time, which exposed
a pre-existing latent gap (`repairProvenanceOf` had no `?? NO_REPAIR` defensive default,
unlike its sibling in `artifact-sink.ts`). See
[[gotcha-repairprovenanceof-defensive-fallback-added-task-1-5]] for the fix. Pattern: "tests
still pass" was never evidence a total reader was sound - only that no caller yet
dereferenced the gap.

# Links

- `.kiro/specs/testbench-dialect-normalization/tasks.md` (group 1, checkpoint 2)
- `app/eval/harness.ts` (`#repairIfTriggered`, `mergeRepairProvenance`, `repairProvenanceOf`)
- `app/agent/orchestrator/verification-loop.ts` (`RepairProvenance`, `RepairDeclineReason`, `repairDeclined`, `repairAccepted`)
- `app/eval/artifact-sink.ts` (`captureSampleArtifacts`)
- [[gotcha-testbench-repair-near-zero-is-two-mechanical-dialect-classes-not-a-feedback-problem]] (why this spec exists)
- [[gotcha-repairprovenanceof-defensive-fallback-added-task-1-5]]
