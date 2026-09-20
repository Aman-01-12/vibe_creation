---
type: pattern
title: Reserve an artifact filename constant ahead of the data path that will populate it
status: candidate
provenance: task 9.4 (instrument-precheck-and-attribution spec), spec-task-execution subagent
tags: [artifacts, schema, artifact-layout, precheck, reserved-slot]
timestamp: 2026-09-19T23:38:31Z
verifiedBy:
---

# Pattern

A task's literal instruction ("add filename X to the filename set") can outrun the data
plumbing that would actually populate it. Rather than either skipping the filename (violating
the task) or inventing a fake data path just to have something to write (scope creep), add the
filename CONSTANT with a clear "RESERVED, NOT YET POPULATED" doc comment naming exactly which
upstream function currently discards the value, and do not wire it into the file-planning
function.

# When to use

Task 9.4 (instrument-precheck-and-attribution) required adding `precheck-stderr.txt` to
`ARTIFACT_FILENAMES` in `app/eval/sweep/artifact-layout.ts`. Verified by reading
`TestbenchPrecheck.run` (`app/agent/orchestrator/testbench-precheck.ts`): it calls
`simulator.simulate(...)`, gets a full `SimulationVerdict` (with real `stderr`) back, and
reduces it to a bare three-member `PrecheckOutcome` enum with no stderr passthrough. Nothing
in the outcome chain reaching `artifact-sink.ts` carries a precheck-specific stderr today, so
there was genuinely no value to plan a file for.

# Recipe / example

```ts
export const ARTIFACT_FILENAMES = Object.freeze({
  // ...
  /**
   * RESERVED, NOT YET POPULATED: <upstream function> reduces its result to a bare enum
   * with no stderr passthrough, so nothing in the outcome chain reaching this layer
   * carries this value today. The slot is reserved here for a future task or spec that
   * threads the diagnostic through; `planArtifactFiles` below plans no file for it yet.
   */
  precheckStderr: 'precheck-stderr.txt',
});
```
`planArtifactFiles` deliberately has NO `sourcePlan`/`diagnosticsPlan` call for this filename.

# Pitfalls

- Do not silently omit the filename because "nothing populates it yet" - the task explicitly
  named it, and a future task threading the value through should find the constant already
  named and documented, not have to invent it.
- Do not fabricate a data path (e.g. re-deriving stderr from somewhere it doesn't actually
  live) just to make the reserved slot look used - that manufactures a claim the system does
  not make.
- Verify the "not yet populated" claim by actually reading the upstream function, not by
  assuming from the task's own wording - the task text alone does not tell you whether the
  plumbing exists.

# Links

- `app/eval/sweep/artifact-layout.ts` (`ARTIFACT_FILENAMES.precheckStderr`)
- `app/agent/orchestrator/testbench-precheck.ts` (`TestbenchPrecheck.run`, the discarding call site)
