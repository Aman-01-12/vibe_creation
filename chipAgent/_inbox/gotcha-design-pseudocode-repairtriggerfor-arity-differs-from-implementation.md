---
type: gotcha
title: design.md pseudocode calls repairTriggerFor(verdict) but the real signature takes (verdict, spec, diagnostic)
status: candidate
provenance: testbench-repair-loop spec, task 8.3 (app/eval/harness.ts#repairIfTriggered)
tags: [hdl, verification, eval, repair-loop, spec-design-drift]
timestamp: 2025-06-17T20:32:00Z
verifiedBy: 
---

# Gotcha

`design.md`'s traced pseudocode for `#repairIfTriggered` calls:

```ts
const trigger = repairTriggerFor(control.verdict); // null unless the two triggering defects
```

But the ACTUAL `repairTriggerFor` (implemented in tasks 8.1/8.2, `app/eval/testbench-repair.ts`)
has signature `repairTriggerFor(verdict, spec, diagnostic)` - see the companion decision note
`decision-repairtriggerfor-takes-spec-and-diagnostic-verdict-alone-is-insufficient.md`. This is
because `RecordedInstrumentVerdict` alone cannot supply a failing check name, rule family, or
diagnostic text - those had to be added as caller-supplied parameters during 8.1/8.2's actual
implementation, which happened AFTER the design.md pseudocode for 8.3's call site was written.

Task 8.3's implementer had to reconcile this: the real call became
`repairTriggerFor(control.verdict, problem.spec, control.stderr)`, using values already in
scope at the `#repairIfTriggered` call site (the `EvalProblem`'s `spec`, and the same
`InstrumentControlResult`'s own `stderr`).

# Why this matters going forward

Design.md's pseudocode for a LATER task can drift from an EARLIER task's actual landed
signature, when the earlier task's implementation added parameters the design's abbreviated
pseudocode didn't spell out. When implementing a task whose pseudocode calls a function from an
earlier, already-completed task, always re-read that earlier task's ACTUAL signature from the
real file rather than trusting the pseudocode's call arity - the design document's illustrative
code is not a contract, the landed implementation is.

# Links

- `app/eval/harness.ts` (`#repairIfTriggered`)
- `app/eval/testbench-repair.ts` (`repairTriggerFor`)
- `.kiro/specs/testbench-repair-loop/design.md`, section 7 (`EvalHarness#runSample` wiring)
