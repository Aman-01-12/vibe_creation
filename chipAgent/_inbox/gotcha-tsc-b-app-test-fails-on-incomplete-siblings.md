---
type: gotcha
title: tsc -b app/test is package-wide and fails on unrelated in-progress sibling test files
status: candidate
provenance: hdl-creation-loop task 16.6 (example tests for teach phrasing + verifying transient)
tags: [typescript, testing, monorepo, parallel-waves, verification]
timestamp: 2025-06-05T00:00:00Z
---

# What happened

Task 16.6 adds two new example test files under `app/test/`. Verifying them with
`npx tsc -b app/test --force` reported 61 errors - but every one was in two OTHER
files: `hero-loop.integration.test.ts` (task 17.1) and
`teach-mode-grounding.property.test.ts` (task 16.5), both still `[-]` in-progress in
the same dependency wave. Zero errors referenced the task 16.6 files.

# Root cause

`tsc -b <package>` type-checks the WHOLE package, not just the files you added. In a
parallel-wave build, sibling tasks land incomplete `.test.ts` files in the same
`app/test` package (unused imports, stubbed helpers). Those break the package build
even though they are unrelated to your change, so a red `tsc -b app/test` does not by
itself mean your new file is wrong.

# Fix / rule

To verify a single new test file in isolation when the package build is red for
unrelated reasons, rely on three signals that ARE file-scoped:
- `get_diagnostics` (LSP) on your exact file paths - reports only your files;
- `eslint <your files> --max-warnings=0` - type-aware and file-scoped;
- `vitest run <your files>` - transforms+runs only those files.
Also confirm the layer you import from builds clean (`tsc -b app/agent`) so the red is
provably confined to sibling test files. Attribute every `tsc -b` error to a filename
before assuming your change caused it.

# Links

- .kiro/specs/hdl-creation-loop/tasks.md (wave 14: tasks 16.5, 16.6, 17.1)
- app/test/teach-mode-phrasing.test.ts, app/test/iteration-verifying-transient.test.ts
