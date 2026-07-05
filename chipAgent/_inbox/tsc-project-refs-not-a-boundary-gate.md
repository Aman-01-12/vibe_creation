---
type: gotcha
title: TypeScript project references do not enforce import boundaries on incremental builds
status: candidate
provenance: hdl-creation-loop task 1.1 (scaffold app/ monorepo import boundaries)
tags: [monorepo, typescript, eslint, ci, import-boundaries]
timestamp: 2025-05-27T00:00:00Z
---

# What happened

The `app/` monorepo enforces the inward-only dependency rule (`web -> api -> agent -> {knowledge, tools} -> core`) with two mechanisms: TypeScript project `references` and an ESLint `no-restricted-imports` boundary rule.
The project-references mechanism was assumed to be an equally reliable, always-on gate.
It is not.

# Root cause

`tsc -b` only rejects an inner-to-outer import when the outer package's declarations are not built as a prerequisite (a clean build via build ordering).
On an incremental build where the outer package's `dist/` already exists, `tsc` resolves the import through the npm workspace symlink and does NOT flag the violation.
So project references catch the violation on a clean build but silently miss it incrementally.

# Fix / rule

Treat the ESLint boundary rule as the authoritative import-boundary gate; it fires at author time regardless of build state.
CI (task 1.2) must run `eslint app --max-warnings=0` as the boundary gate rather than relying on `tsc -b` alone.
Verified the ESLint rule fires: a temporary `app/agent/__boundary_probe.ts` importing `@app/api` failed lint with exit 1 and the actionable message, then was removed.
The `app/README.md` "cannot resolve" wording overstates the tsc guarantee and should be softened in a later docs pass.

# Links

- .kiro/specs/hdl-creation-loop/tasks.md (task 1.2 CI gates)
- app/README.md (enforcement mechanisms section)
