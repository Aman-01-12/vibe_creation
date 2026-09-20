---
type: decision
title: Testbench_Repair is wired into the sweep as a per-sample factory (testbenchRepairFor), not a fixed EvalHarnessDeps.testbenchRepair instance
status: candidate
provenance: closing a real gap found before a testbench-repair-loop task 12.1 real-model campaign; EvalTestbenchRepair (app/eval/testbench-repair.ts, task 8.3) existed but nothing in the sweep composition root ever constructed or wired it
tags: [hdl, verification, eval, repair-loop, harness, sweep, ports, per-sample-factory, app-eval]
timestamp: 2026-09-27T22:11:00Z
verifiedBy:
---

# Decision

`EvalTestbenchRepair`'s own doc comment says "one instance per sample, constructed with the
sample's own `sessionId` and its own `SessionBudgetHandle`" - but `EvalHarnessDeps` declared
`testbenchRepair?: TestbenchRepair`, a SINGLE FIXED instance passed once at harness-construction
time, before any sample's sessionId/budget exist. Nothing could satisfy that contract, so nothing
in `sweep/cli.ts` or `sweep/runner.ts` ever built one - every real campaign was silently skipping
the entire repair loop (`repairProvenance` stuck at `NO_REPAIR` for every sample).

Fixed by turning the field into a **factory**: `EvalHarnessDeps.testbenchRepairFor?: (sessionId,
budget) => TestbenchRepair`, called once per sample inside `#runSample` right after the fresh
budget is built (mirroring `#buildAdmission`'s existing per-sample-factory pattern for
`MemoizingInstrumentAdmission` - see
[[pattern-admission-adapter-preferred-over-post-loop-fallback]]). `#repairIfTriggered` now takes
the built port as a parameter instead of reading `this.#resolved.testbenchRepair` directly.

# Context / options considered

- Option A (rejected): keep a fixed instance, have the harness minit a NEW `sessionId` for the
  repair separately from the sample's own. Rejected because it breaks Req 5.1/5.4/5.5 - repair
  must charge the SAME budget every other model call in that sample charges against, and
  `MeteredSessionBudget` already exposes `sessionId` publicly, so there is no reason to mint a
  second one.
- Option B (chosen): factory field, called from `#runSample` with `budget.sessionId` (read off the
  already-built `MeteredSessionBudget`, not a separately-minted ulid) and the budget itself.

## The `RepairingTestbenchGenerator` supply problem (Part 1)

`EvalTestbenchRepair`'s constructor needs a `RepairingTestbenchGenerator` (`{ repairTestbench(request,
budget) }`) to call. The only thing with a real `TestbenchAgent` was `EvalVerificationLoopRunner`,
which built one FRESH AND PRIVATELY inside `runSample` with no seam exposing it. Fixed by adding a
public `repairTestbench` method to `EvalVerificationLoopRunner` itself, making it implement BOTH
`EvalLoopRunner` and `RepairingTestbenchGenerator`. That method builds its OWN fresh router +
recorder (a repair happens after the original sample's `runSample` call already fully completed
and discarded its router/recorder) under a FIXED neutral sampling value: seed `0`, temperature `0`
- not the original sample's seed/temperature, because Req 15.10's reproducibility concern is about
the ORIGINAL sample's model calls, not a repair call's, and every eval config in this repo already
pins `temperature: 0` for the whole campaign anyway, so this is not an observable behavior change.

`#buildRouter`'s parameter was narrowed from the full `EvalSampleRequest` to a 2-field
`SamplingParams` (`{ seed, temperature }`) so both `runSample` and `repairTestbench` can call it
without either constructing a fake wider request just to satisfy the old signature.

## The sweep-layer typing problem (Part 3)

`SweepRunnerDeps.loopRunnerFor` is declared to return `EvalLoopRunner`, but the CONCRETE production
runner also implements `RepairingTestbenchGenerator` (Part 1). `SweepRunner#armRunner(arm)` needed
to hand that same shared per-arm instance to `EvalTestbenchRepair`'s constructor. Chosen fix: widen
ONLY `#armRunner`'s return type (and the `#runnerByArm` map's value type) to a LOCAL intersection
alias `ArmRunner = EvalLoopRunner & Partial<RepairingTestbenchGenerator>`, rather than widening the
public `loopRunnerFor` deps field itself - every other caller/fake of that field stays untouched,
and a fake arm runner that doesn't implement `repairTestbench` still type-checks (the property is
optional) and fails safe at the one call site that actually invokes it (rejects rather than throws
synchronously, matching every other fail-safe path in `SweepRunner`).

Enablement is a single boolean (`SweepRunnerDeps.testbenchRepairEnabled`), NOT an injected
collaborator like `goldenJudge`/`instrumentControl` - because the collaborator itself
(`EvalTestbenchRepair`) needs a per-sample sessionId/budget only the harness has, so there is
nothing arm-shared to inject; only a decision of whether to build the factory at all, closing over
the arm's own already-shared loop runner (Req 8.4: reuses the SAME `TestbenchAgent#repairTestbench`
the precheck path calls directly - no second `TestbenchAgent` instantiated for this).

`cli.ts` sets `testbenchRepairEnabled: true` unconditionally for every real run (no `SweepConfig`
field gates it - this is the eval layer's own capability being exercised, not a bake-off
parameter like `arm.roleModels`, unlike why `negativeControl.enabled` IS a config field).

# Rationale

Matches [[pattern-admission-adapter-preferred-over-post-loop-fallback]]'s recipe almost exactly:
build the per-sample adapter only if the underlying collaborator is wired, thread it through
optionally, never widen unrelated fields. The `Partial<>` intersection trick for `ArmRunner` keeps
the widening local to the one file that actually needs the extra capability instead of leaking it
into the port every other caller of `EvalLoopRunner` depends on.

# Revisit trigger

If a second sweep-layer capability ever needs to call back into the arm's own loop runner for
something beyond `repairTestbench`, generalize `ArmRunner`'s intersection member rather than
adding a third ad hoc capability check.

# Links

- `app/eval/verification-loop-runner.ts` (`repairTestbench`, `SamplingParams`, `#buildRouter`)
- `app/eval/harness.ts` (`EvalHarnessDeps.testbenchRepairFor`, `#buildTestbenchRepair`, `#runSample`, `#repairIfTriggered`)
- `app/eval/sweep/runner.ts` (`ArmRunner`, `#buildTestbenchRepairFor`, `SweepRunnerDeps.testbenchRepairEnabled`)
- `app/eval/sweep/cli.ts` (`testbenchRepairEnabled: true`)
- `app/eval/testbench-repair.ts` (`EvalTestbenchRepair`, `RepairingTestbenchGenerator`)
- [[pattern-admission-adapter-preferred-over-post-loop-fallback]]
- [[verification-loop-single-budget-handle-reconciliation]]
- [[gotcha-repairprovenanceof-throws-on-stale-runner-test-fixtures-lacking-defensive-fallback]]
