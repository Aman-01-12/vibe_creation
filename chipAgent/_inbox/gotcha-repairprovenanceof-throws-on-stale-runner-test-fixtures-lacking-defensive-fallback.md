---
type: gotcha
title: repairProvenanceOf throws on stale runner.test.ts fixtures - it never got the defensive-fallback fix captureSampleArtifacts already got
status: candidate
provenance: testbench-repair-loop spec, task 10.1 verification (app/eval/harness.ts, app/eval/sweep/runner.test.ts)
tags: [hdl, verification, eval, testing, silent-failure, repair-loop, app-eval]
timestamp: 2025-06-18T00:00:00Z
verifiedBy:
---

# What happened

While verifying task 10.1 (bumping `RESULTS_SCHEMA_VERSION` to 11 and adding
`repairAttempted`/`repairAccepted` to `SweepSampleRecord`), the full `npx vitest run` gate showed
9 failing tests, all in `app/eval/sweep/runner.test.ts`, none touching the new fields directly -
`passed`, `instrumentValidity`, and `instrumentDefect` came back wrong (`unchecked` instead of
`valid`/`invalid`, `false` instead of `true`).

Root cause: `verifiedOutcome()` and `verifiedWithTestbench()` in `runner.test.ts` build a
`VerificationOutcome` via `{ ... } as unknown as VerificationOutcome` casts that predate task 2.1
(which made `repairProvenance` a required field on `VerifiedModule`/`UnverifiedModule`/
`InstrumentRefusedModule`) and were never backfilled. `harness.ts#repairProvenanceOf` reads
`outcome.repairProvenance` verbatim for a `verified`/`unverified`/`instrument-refused` status with
NO fallback:

```ts
function repairProvenanceOf(outcome: DriveOutcome): RepairProvenance {
  if (outcome.status === 'verified' || outcome.status === 'unverified' || outcome.status === 'instrument-refused') {
    return outcome.repairProvenance;   // undefined for a stale-cast fixture
  }
  return NO_REPAIR;
}
```

`#repairIfTriggered` then reads `precheckProvenance.attempted` on that `undefined`, throwing a
`TypeError` inside `#runSample`. `SweepRunner`'s own per-sample catch-all turns the thrown sample
into a crash record (`passed: false`, `instrumentValidity: 'unchecked'`), which is exactly the
observed failure shape.

# Root cause

This is the SAME defect class as
[[gotcha-catch-all-in-captureartifacts-masked-a-stale-fixture-typeerror]] - a required field added
by task 2.1, read by new code from task 8.3, unread by pre-existing stale test-fixture casts - but
at a DIFFERENT site. That earlier gotcha's fix made `captureSampleArtifacts` defensive at the read
site (`measured.repairProvenance ?? NO_REPAIR`). `repairProvenanceOf` in the same file was not
given the identical treatment, so the same fixture staleness that was fixed for the artifact-sink
path is still live for the `#repairIfTriggered` gating path.

Confirmed NOT a regression introduced by task 10.1: `git stash` back to the last commit
(`e3bb5c1`, before any of tasks 1-10 in this uncommitted working tree existed) leaves
`runner.test.ts` at a clean 34/34. The defect was introduced somewhere between task 2.1 (required
field added) and task 8.3 (`repairProvenanceOf`/`#repairIfTriggered` wired into `harness.ts`);
`runner.test.ts`'s fixtures were never updated to match either.

# Fix / rule

Not fixed here - out of scope for task 10.1, which touches only `results-log.ts` and the
`SweepSampleRecord`-literal construction sites in `runner.ts`/`runner.test.ts` (both already
correct). Reported to the orchestrator instead.

The rule from the earlier gotcha generalizes exactly: when a pure function reads a "required"
field that a fail-safe catch-all sits somewhere above in the call stack, "the tests still pass"
is not evidence the new code path was exercised correctly - and per this note, "the tests visibly
FAIL" also is not enough to localize the defect to the task that made them fail, since the actual
defect can predate that task's own diff by several tasks. Grep every call site of a function that
reads a newly-required field (`repairProvenanceOf`, not just `captureSampleArtifacts`) for the
identical defensive-default treatment, don't assume one fix at one call site closes the whole
class.

# Links

- `app/eval/harness.ts` (`repairProvenanceOf`, `#repairIfTriggered`)
- `app/eval/sweep/runner.test.ts` (`verifiedOutcome`, `verifiedWithTestbench`)
- [[gotcha-catch-all-in-captureartifacts-masked-a-stale-fixture-typeerror]] (the sibling fix, same field, different call site)
- `.kiro/specs/testbench-repair-loop/tasks.md` (task 2.1, task 8.3, task 10.1)
