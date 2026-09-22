---
type: gotcha
title: repairProvenanceOf's missing defensive fallback surfaced at a NEW call site (mergeRepairProvenance) - fixed at the reader, not the caller
status: candidate
provenance: testbench-dialect-normalization spec, task 1.5 verification (app/eval/harness.ts)
tags: [hdl, verification, eval, testing, silent-failure, repair-loop, app-eval]
timestamp: 2025-06-19T00:00:00Z
verifiedBy:
---

# What happened

Task 1.5 replaced the `wasRepaired ? {...} : repairProvenance` ternary in `#runSample` with
`mergeRepairProvenance(precheck, control)`, which reads `precheck.attempted`. After the edit,
`npx vitest run` showed 46 new failures (`app/eval/harness.test.ts`, `app/eval/gate/measure.test.ts`),
all `TypeError: Cannot read properties of undefined (reading 'attempted')` inside
`mergeRepairProvenance`.

This is the exact defect
[[gotcha-repairprovenanceof-throws-on-stale-runner-test-fixtures-lacking-defensive-fallback]]
already described and left unfixed ("reported to the orchestrator instead", out of scope for that
task). What's new here: the OLD ternary's `false` branch assigned `repairProvenance` (from
`repairProvenanceOf(outcome)`) straight through with no property read on it, so a stale-cast test
fixture's `undefined` never got dereferenced and the tests passed despite the field being unsound.
`mergeRepairProvenance` is the first caller to actually call `.attempted` on that value in the
common (not-attempted) path, which is exactly what exposed the latent defect - task 1.5's own
correctness is what surfaced it, not a regression in task 1.5 itself.

Confirmed via `git stash`: `app/eval/harness.test.ts` + `app/eval/gate/measure.test.ts` were
32/32 green on the pre-task-1.5 commit.

# Root cause

`repairProvenanceOf` in `app/eval/harness.ts` read `outcome.repairProvenance` verbatim for
`verified`/`unverified`/`instrument-refused`, with no fallback, even though the sibling read site
(`captureSampleArtifacts` in `app/eval/artifact-sink.ts`) already does `measured.repairProvenance ??
NO_REPAIR` for the identical field. Stale `as unknown as VerificationOutcome` casts in test
fixtures (predating the field becoming required) hand back `undefined` at runtime despite the
compile-time guarantee.

# Fix / rule

Applied the SAME one-line defensive default at `repairProvenanceOf` itself (its sole caller is
`#runSample`, so this is the correct single fix point rather than patching every future reader):

```ts
return outcome.repairProvenance ?? NO_REPAIR;
```

Confirmed via `git stash`: `app/eval/harness.test.ts` + `app/eval/gate/measure.test.ts` returned to
32/32, and the full suite returned to the 1710/6/0 baseline.

The generalized rule from the sibling gotcha holds again: when a NEW caller of an existing "total"
reader function actually exercises the branch a stale fixture never touched, "the tests still
pass" was never evidence the reader was sound - it only meant no caller yet dereferenced the gap.
Fix at the reader (the total function), not at each new caller.

# Links

- `app/eval/harness.ts` (`repairProvenanceOf`, `mergeRepairProvenance`, `#repairIfTriggered`)
- `app/eval/artifact-sink.ts` (`captureSampleArtifacts`, the sibling site with the fix already applied)
- [[gotcha-repairprovenanceof-throws-on-stale-runner-test-fixtures-lacking-defensive-fallback]] (the original report, same defect, first observed at a different caller)
- [[gotcha-catch-all-in-captureartifacts-masked-a-stale-fixture-typeerror]] (the earliest instance of this defect class)
- `.kiro/specs/testbench-dialect-normalization/tasks.md` (task 1.5)
