---
type: gotcha
title: Web-layer property tests live in app/test and require the test -> web import boundary
status: candidate
provenance: hdl-creation-loop task 15.7 (Property 24, Live_Run scope and authority)
tags: [testing, property-based, layering, eslint-boundaries, tsconfig, app-web, app-test]
timestamp: 2025-05-27T00:00:00Z
verifiedBy: npx tsc -b app/test --force + eslint --max-warnings=0 + vitest run (2 passed)
---

# Gotcha

Property tests for the outermost `@app/web` layer cannot be co-located in `app/web`.
The shared harness (`propertyParameters`/`propertyTag`) lives in `@app/test`, and the import-boundary gate (eslint.config.js `ALLOWED_INNER`) forbids `web` from importing `test` ("nothing imports the test layer"). So a web-layer property test must live in `app/test` and import the web module under test from `@app/web`.

But out of the box `app/test` could not import `@app/web` either: `ALLOWED_INNER.test` listed only up to `api`, `app/test/tsconfig.json` had no `../web` project reference, and `@app/web` was not in `app/test/package.json`. Task 15.7 was the first web-layer property test, so this gap surfaced there.

# Fix (one-time, already applied)

Extend the test layer's inward reach to include web:
- `eslint.config.js`: add `'web'` to `ALLOWED_INNER.test`.
- `app/test/tsconfig.json`: add `{ "path": "../web" }` to `references`.
- `app/test/package.json`: add `"@app/web": "*"` to dependencies (workspace symlink already exists).

This only relaxes a restriction for files under `app/test/**`; web still may not import test, and no inner layer changes. Tasks 15.2, 15.4, 15.5 (the remaining web-layer property tests) can now import `@app/web` from `app/test` directly.

# Recipe

- Place the file at `app/test/<name>.property.test.ts`; import the subject from `@app/web` and the harness from `@app/test`.
- `runLive` is async, so use `fc.asyncProperty` + `await fc.assert(...)`.
- Drive lazy/compile-once with a fake `WasmCompilePort` that counts `compile` invocations; derive the expected count independently (`invocations === 0 ? 0 : 1`).
- fast-check v4: full-unicode strings via `fc.string({ unit: 'grapheme' })`.

# Links

- app/test/live-run-scope-authority.property.test.ts (Property 24)
- app/web/live-run/live-run.ts, app/web/live-run/index.ts
- eslint.config.js (ALLOWED_INNER), app/test/tsconfig.json, app/test/package.json
- Related: chipAgent/_inbox/shared-pbt-harness-conventions.md
