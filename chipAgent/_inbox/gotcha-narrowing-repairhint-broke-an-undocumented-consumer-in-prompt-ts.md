---
type: gotcha
title: Narrowing RepairHint to one member broke an undocumented consumer in prompt.ts that neither the task text nor design.md's end-state sketch mentioned
status: candidate
provenance: testbench-dialect-normalization spec, task 10.3 (narrowing repair-hint.ts)
tags: [dead-code-retirement, type-narrowing, cascading-break, prompt-ts, repair-hint]
timestamp: 2025-06-19T00:00:00Z
verifiedBy:
---

# What happened

Task 10.3 narrowed `RepairHint` from `BuildDiagnosticHint | ClassifiedFunctionalHint` to a
single-member `BuildDiagnosticHint`. The task's own instructions (and design.md's end-state
sketch) named every file to change: `repair-hint.ts`, `orchestrator/index.ts`, and the two
property test files. None of them named `app/agent/roles/testbench/prompt.ts`.

But `prompt.ts`'s `describeRepairHint` function had its own `if (hint.kind ===
'classified-functional')` branch reading `hint.defectClass`, backed by a 10-clause
`DEFECT_CLASS_HINTS: Record<DefectClass, string>` lookup table - a SEPARATE consumer of the
deleted vocabulary that only surfaced as a compile error once `RepairHint` narrowed.

# Root cause

The type narrowing itself was mechanically correct and exhaustive per TypeScript's own
checker, but the deletion inventory (both the task text and design.md's file list) was
compiled by tracing `repair-hint.ts`'s DIRECT exports and their re-export chain, not by
grepping every file that pattern-matches on `RepairHint.kind` or imports `DefectClass`. A
consumer that reads a union member via its own local narrowing (`hint.kind === '...'`) rather
than importing a name from the deleted set is invisible to an export-chain trace and only
found by the compiler once the type actually narrows.

# Fix / rule

Grep for every USE of a type before deleting a union member, not just every IMPORT of the
union member's name. `grep -rn "kind === 'classified-functional'"` (or the equivalent pattern
for the specific member being deleted) would have found this before the fact rather than
after `tsc -b` failed. When a spec's own design doc gives a file list for a deletion, treat
that list as a starting point verified by the LAST task that wrote it, not as exhaustive -
`tsc -b --force` after the deletion is still the actual completeness check, and a sub-agent
should expect and budget for at least one such cascading fix on any real deletion task.

# Links

- `app/agent/roles/testbench/prompt.ts` (`describeRepairHint`, formerly branching on `DefectClass`)
- `app/agent/orchestrator/repair-hint.ts` (the narrowed `RepairHint`)
- `.kiro/specs/testbench-dialect-normalization/tasks.md` (task 10.3)
