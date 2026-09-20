---
type: decision
title: repairTriggerFor takes (verdict, spec, diagnostic) - RecordedInstrumentVerdict alone cannot build a RepairTrigger
status: candidate
provenance: testbench-repair-loop spec, tasks 8.1/8.2 (app/eval/testbench-repair.ts)
tags: [hdl, verification, eval, repair-loop, anti-circularity]
timestamp: 2025-06-17T20:21:00Z
verifiedBy: 
---

# Decision

`repairTriggerFor`'s final signature is:

```ts
function repairTriggerFor(
  verdict: RecordedInstrumentVerdict,
  spec: Spec,
  diagnostic: string,
): RepairTrigger | null
```

NOT `repairTriggerFor(verdict: RecordedInstrumentVerdict): RepairTrigger | null` as the task
text's wording ("the total function reading `RecordedInstrumentVerdict`") could suggest in
isolation.

# Rationale

`RecordedInstrumentVerdict` is a closed enum (`{ validity: 'invalid'; defect: ... }` etc.) with
NO free-text field and no Spec reference, by deliberate design
(`instrument-control.ts`'s own "WHY THE RECORDED VERDICT CARRIES NO FREE TEXT" header comment).
So it structurally cannot supply:
- a failing check NAME (needed for a `failed-reference` trigger) - this has to come from
  `requiredChecks(spec)`, a Spec-derived fact;
- a `ruleFamily` (needed for a `failed-reference` trigger) - from `ruleFamilyFor(check, spec.moduleInterface)`;
- a build `diagnostic` string (needed for a `reference-unbuildable` trigger) - from the SAME
  control result's `stderr` the verdict was already derived from, never the reference's stdout.

Both extra parameters are values the future caller (task 8.3's `#repairIfTriggered`) already
holds at its own call site (the `EvalProblem`'s `spec`, and the `InstrumentControlResult` it
just got a verdict from) - so this isn't new plumbing for the caller, just an honest function
signature that doesn't pretend the verdict alone is enough.

# Open question for task 8.3

`repairTriggerFor` deliberately picks only the FIRST required check
(`requiredChecks(spec)[0]`) for a `failed-reference` trigger's `failingCheckName`, rather than
disambiguating which of several required checks actually failed. This mirrors design.md's own
Component 2 note that "a future task may additionally read `simulation.checks` ... to confirm
which of the several required checks failed when more than one exists" - explicitly left open,
not attempted in tasks 8.1/8.2. When implementing 8.3, check whether this first-check
simplification is acceptable for the samples task 8.3 will actually drive, or whether it needs
revisiting using `simulation.checks`'s per-check pass/fail array (also Spec-derived-or-boolean,
never the reference's observed value, so it would stay within the anti-circularity guarantee if
added).

# Links

- `app/eval/testbench-repair.ts` (`repairTriggerFor`, `EvalTestbenchRepair`)
- `.kiro/specs/testbench-repair-loop/design.md`, Component 2 ("Deriving ruleFamily without ever reading the reference's observed value") and Component 8
