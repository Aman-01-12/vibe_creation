---
type: verification-recipe
title: testbench-repair-loop spec cleared its final gate at 1709 passed / 6 skipped / 0 failed, build clean
status: candidate
provenance: testbench-repair-loop spec, task 11 (final checkpoint)
tags: [hdl, verification, eval, repair-loop, gate, milestone]
timestamp: 2025-06-17T21:36:00Z
verifiedBy: 
---

# What was verified

Full gate for the testbench-repair-loop spec, run individually (never chained, per this
environment's known chaining-timeout issue):

```
npx tsc -b            -> clean, exit 0
npx eslint app scripts --max-warnings=0  -> clean, exit 0
npx prettier --check .  -> all files conform
npx vitest run          -> 1709 passed / 6 skipped / 0 failed (149 files, 1 skipped file)
npm run build (tsc -b)  -> clean, exit 0
```

No `app/agent` module imports `@app/eval` (grep-confirmed zero matches) - the import
boundary this whole spec depends on (`TestbenchRepair` declared in `app/agent/orchestrator`,
implemented only in `app/eval`) held throughout every task.

# Progression this session (for continuity, not re-derivation)

- Pre-spec baseline (before this spec started): 1697 passed / 6 skipped
- After tasks 1-4 (repair-hint module, RepairProvenance, repairTestbench primitive): 1706-1708
- After task 6.4 (precheck-path wiring in verification-loop.ts): 1708/6, 0 failed
- After task 8.3 (harness.ts positive-control-path wiring): 1708/6, 0 failed (after fixing a
  real pre-existing regression - see the sibling gotcha notes on `repairProvenanceOf` and
  `captureSampleArtifacts` stale-fixture TypeErrors)
- After task 10.1 (RESULTS_SCHEMA_VERSION 10->11): briefly regressed to 1699/9-failed/6 due
  to the SAME stale-fixture defect class recurring at a third call site
  (`runner.test.ts`'s `verifiedOutcome`/`verifiedWithTestbench`) - fixed by backfilling
  `repairProvenance: NO_REPAIR` into those two fixtures (the correct fix, since the type
  system already required the field and the fixtures were lying about their shape via
  `as unknown as` casts).
- After task 10.6 (TESTBENCH_REPAIR_POLICY_VERSION folded into config-identity.ts): 2 EXPECTED
  pinned-hash test failures in manifest.test.ts (SMOKE_RUN_CONFIG_HASH, TBSLICE_RUN_CONFIG_HASH),
  resolved by task 10.8's re-pin to the newly-observed values (SMOKE: 0e45a8995706a637,
  TBSLICE: d098398e36cd3095).
- Final (task 11): 1709 passed / 6 skipped / 0 failed (the +1 over 1708 is task 10.9's new
  stale-schema-advice test).

# Remaining scope (not blocking, per tasks.md's own Notes)

- All `*`-marked optional property/unit tests (1.3-1.5, 4.3-4.4, 6.5-6.8, 8.4-8.6/8.8-8.9,
  10.2/10.5/10.7) are deliberately skippable per the spec's own stated policy - "every one of
  them is a test; none of the core behaviour is optional."
- Task 12.1 (re-measure against the real stage1-screen slice) is explicitly non-blocking for
  merge and costs real model spend - requires explicit user confirmation before running, per
  this workspace's spend-gated-action safety rule.

# Links

- `.kiro/specs/testbench-repair-loop/tasks.md` (task 11, and its Notes section on why 12.1 doesn't block)
- Sibling gotchas: `gotcha-catch-all-in-captureartifacts-masked-a-stale-fixture-typeerror.md`, `gotcha-repairprovenanceof-throws-on-stale-runner-test-fixtures-lacking-defensive-fallback.md`
