---
type: pattern
title: A dependency-free types.ts breaks the cycle when a composing entry point and its independently-built rule modules would otherwise import each other
status: candidate
provenance: testbench-dialect-normalization spec, task 4.5 (dialect/normalizer.ts composing unnamed-begin.ts, sized-literal.ts, prose-as-statement.ts)
tags: [typescript, architecture, circular-import, parallel-agents, pattern, dialect-normalizer]
timestamp: 2025-06-19T00:00:00Z
verifiedBy:
---

# The shape of the problem

Three sibling modules (`unnamed-begin.ts`, `sized-literal.ts`, `prose-as-statement.ts`) were
built in PARALLEL by separate subagents, each instructed to define its own local, structurally
identical copy of shared types (`DialectClass`, `DialectFinding`, `DialectDeclineCause`,
`SpanEdit`) so each file would compile in isolation with no dependency on the others or on the
not-yet-existing composing entry point.

A later reconciliation task then needed to: (1) create the composing entry point
(`normalizer.ts`) that IMPORTS the three rule functions, and (2) have the three rule modules
import the CANONICAL types from somewhere, so there is one definition instead of four. The
naive fix - put the canonical types in `normalizer.ts` and have the rule modules import from
there - creates a cycle: `normalizer.ts` imports `planUnnamedBeginLabels` etc. from the rule
modules, and the rule modules would import types back from `normalizer.ts`.

# The fix

A fourth file, `dialect/types.ts`, holding ONLY the type declarations with no imports of its
own (no dependency on any rule module or on the composing entry point). All three rule modules
import from `types.ts`; the composing entry point ALSO imports from `types.ts` and then
re-exports those types for external consumers, so the public surface is unchanged.

# Why this generalizes

Any time an orchestrator/composer-plus-parallel-workers build shape is used (multiple subagents
each build a rule/handler/strategy module against a shared shape that doesn't exist yet, then
a later task composes them), the reconciliation step will hit this exact cycle if the shared
type's "natural" home looks like the composer file. The fix is always the same: extract the
type-only file FIRST (or as the first act of reconciliation), with zero imports, and have both
the composer and every worker import from it.

# Links

- `app/agent/orchestrator/dialect/types.ts` (the extracted file)
- `app/agent/orchestrator/dialect/normalizer.ts` (the composer, re-exports from types.ts)
- `.kiro/specs/testbench-dialect-normalization/tasks.md` (tasks 4.1-4.5)
- `.kiro/specs/testbench-dialect-normalization/design.md` Component 2
