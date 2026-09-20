---
type: decision
title: ruleFamilyFor reuses prompt.ts's interface-fact helpers via export, not duplication
tags: [testbench-repair-loop, repair-hint, prompt-ts, design-ambiguity, code-reuse, app-agent]
provenance: task 1.2 (testbench-repair-loop spec), spec-task-execution subagent
timestamp: 2026-09-25T19:05:00Z
status: candidate
---

# What happened

design.md's Component 3 for `ruleFamilyFor` says it should read `declaresVectorDataPort`,
`timingQualifierNames`, `inputQualifierNames` "again here rather than threaded through... so
this function has the identical inputs prompt.ts had... and nothing else." That phrasing is
ambiguous between two implementations:

1. Duplicate the three functions' logic locally in `repair-hint.ts`.
2. Export the three (previously module-private) functions from `prompt.ts` and import them.

# Decision

Chose (2): exported all three from `prompt.ts` (added `export`, no logic change) and imported
them into `repair-hint.ts`. Both files are in `app/agent`, so there is no import-boundary
concern. Design's wording is about re-deriving from the same Spec-owned interface facts rather
than from tool output - not a mandate to fork the scan logic into two copies that could drift.

# Why this matters for later tasks

If a later task (or a fresh reading of design.md in isolation) assumes duplication was
intended, do NOT re-duplicate these functions in `repair-hint.ts` - the export already exists
and duplicating would create exactly the two-implementations-can-drift risk the design's own
reasoning (Component 2/3) argues against elsewhere.

# Links

- app/agent/roles/testbench/prompt.ts (`declaresVectorDataPort`, `timingQualifierNames`, `inputQualifierNames` - now exported)
- app/agent/orchestrator/repair-hint.ts (`ruleFamilyFor`)
- .kiro/specs/testbench-repair-loop/design.md, Component 3
