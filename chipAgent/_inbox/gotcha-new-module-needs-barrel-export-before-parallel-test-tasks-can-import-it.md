---
type: gotcha
title: A brand-new module's barrel export must land before any parallel-dispatched test task can import it - three sub-agents hit the same gap independently
tags: [testbench-repair-loop, app-agent, barrel-exports, package-exports-map, orchestration, parallel-dispatch, dead-end]
provenance: tasks 1.3, 1.4, 2.2 (testbench-repair-loop spec), three concurrent spec-task-execution subagents
timestamp: 2026-09-25T19:20:00Z
status: candidate
---

# What happened

Tasks 1.1/1.2 created `app/agent/orchestrator/repair-hint.ts` (exporting `buildRepairHint`,
`ruleFamilyFor`, `RepairTrigger`, etc.) but did not add it to `app/agent/orchestrator/index.ts`'s
barrel - that wiring was deliberately deferred to task 10.10 ("Export the new surface") per the
spec's own build-order plan (identity/schema/export bumps land last).

Three tasks (1.3, 1.4, 2.2) were then dispatched in parallel, each writing a NEW property test
file under `app/test/` that needed to import from `repair-hint.ts` (and, for 2.2, `NO_REPAIR`/
`RepairProvenance` from `verification-loop.ts`, also not yet barrel-exported). `@app/agent`'s
`package.json` `exports` map resolves ONLY to `dist/index.js` - there is no deep-import path
into `dist/orchestrator/repair-hint.js` from outside the package. All three sub-agents hit this
independently, and all three fixed it the same way: adding the missing export block to
`app/agent/orchestrator/index.ts`. Landing near-simultaneously, this produced a transient
duplicate-identifier `tsc` error, which the third agent to finish resolved by deduplicating.

# Root cause

This spec's own task-dependency graph places the barrel-export task (10.10) at the very end,
but its OPTIONAL test tasks (1.3-1.5, 2.2, etc.) that need to actually IMPORT the new symbols
are scheduled to run in the same or an earlier wave. The plan's "exports last" build order is
correct for schema/identity bumps, but a package's own barrel is not purely cosmetic plumbing -
it is the only import surface `@app/agent`'s package-exports map allows, so a test written
against a brand-new module needs at least a MINIMAL barrel export the moment the first test
task that imports it is dispatched, not whenever the "export the surface" cleanup task
eventually runs.

# Fix / rule

No lasting damage this time (three agents converged on the identical one-line fix and the
duplicate resolved itself), but for future orchestration of this pattern:

- When queuing parallel test tasks against a freshly-created module, either (a) add the new
  module's barrel export as part of the IMPLEMENTATION task itself (e.g. fold a one-line export
  into task 1.1/1.2, not defer it to a later numbered task), or (b) explicitly warn each
  concurrently-dispatched test-task sub-agent that the barrel export is still pending and that
  they may need to add it themselves - which is what effectively happened here by accident.
- If dispatching >1 sub-agent in parallel where more than one might independently need to touch
  a SHARED file (a barrel index, a shared fixture file) for an incidental reason outside their
  assigned task, expect a race on that file and verify the final merged state (not just each
  agent's own reported diff) before trusting the gate - in this case verification happened
  correctly (a full `tsc -b`/`vitest run` after all three landed), which is what caught the
  transient duplicate would already have been resolved by the last agent's own dedup, but it
  is worth explicitly re-reading the shared file's final state when this pattern recurs.

# Links

- app/agent/orchestrator/repair-hint.ts (tasks 1.1, 1.2)
- app/agent/orchestrator/index.ts (the barrel; export block added ahead of task 10.10 by necessity)
- app/agent/orchestrator/verification-loop.ts (`NO_REPAIR`, `RepairProvenance`, task 2.1)
- .kiro/specs/testbench-repair-loop/tasks.md (task 10.10, "Export the new surface" - now partially pre-empted)
