---
type: decision
title: New Testbench_Repair summary fields prefixed testbenchRepair* to avoid colliding with the pre-existing RTL-iteration repairedSamples
status: candidate
provenance: testbench-repair-loop spec, task 10.4 (app/eval/sweep/summary.ts)
tags: [hdl, verification, eval, summary, naming, repair-loop]
timestamp: 2025-06-17T21:20:00Z
verifiedBy: 
---

# Decision

`ArmSummary` already had `repairedSamples` (and `repairedRate`) meaning "passing samples that
needed at least one RTL repair ITERATION" - the base hero-loop concept, unrelated to this spec.
Task 10.4 needed to add NEW fields for Testbench_Repair (a completely different concept: whether
a sample's TESTBENCH was repaired, not its RTL). To avoid a name collision or reader confusion
between two "repair" concepts on the same interface, the new fields are explicitly prefixed:

```ts
readonly testbenchRepairAttempted: number;
readonly testbenchRepairAccepted: number;
readonly validNoRepair: number;
readonly validAfterRepair: number;
```

`validAfterRepair` is derived as exactly `testbenchRepairAccepted` (an accepted repair, by
construction of `harness.ts#runSample`'s `accepted: finalControl.verdict.validity === 'valid'`,
is always the reason a sample ended `valid`), and `validNoRepair = instrument.validSamples -
testbenchRepairAccepted`.

# Why

This codebase already distinguishes "RTL repair" (revising candidate RTL from simulator output,
the base loop) from "Testbench_Repair" (revising the testbench itself, this spec) at the
prose level throughout - e.g. `verification-loop.ts`'s comments always say "Testbench_Repair"
capitalized when meaning this spec's concept. The `summary.ts` interface previously had no
field for the testbench concept at all, so there was no established naming convention on
THIS interface to collide with - but `repairedSamples` already existed and reads exactly like
what a naive name (`repairAttempted`, `repairAccepted`) would suggest. Prefixing the new
fields removes the ambiguity structurally rather than relying on doc comments alone.

# When this matters again

Any future field added to `ArmSummary` (or any other flat aggregate interface in this codebase)
for a NEW kind of "repair" must check whether `repair*`-shaped names already exist on that
interface for a DIFFERENT repair concept, and prefix distinctly if so - `summary.ts` in
particular now has both an RTL-iteration repair vocabulary and a Testbench_Repair vocabulary
living side by side.

# Links

- `app/eval/sweep/summary.ts` (`ArmSummary.repairedSamples` vs `.testbenchRepairAttempted`/`.testbenchRepairAccepted`)
- `app/eval/sweep/results-log.ts` (`SweepSampleRecord.repairAttempted`/`.repairAccepted`, the flat per-sample source these aggregate)
