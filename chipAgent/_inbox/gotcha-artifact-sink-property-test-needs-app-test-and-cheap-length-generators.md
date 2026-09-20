---
type: gotcha
title: A captureSampleArtifacts property test must live in app/test, and cap-spanning length arbitraries must not use fc.string at cap size
status: candidate
provenance: task 7.3 (instrument-precheck-and-attribution spec), spec-task-execution subagent
tags: [testing, property-based, fast-check, conventions, app-eval, app-test, eslint-boundaries, performance]
timestamp: 2026-09-21T00:41:00Z
verifiedBy: npx tsc -b app/test + eslint --max-warnings=0 + prettier --check + vitest run (5 passed)
---

# Gotcha

Writing `Feature: instrument-precheck-and-attribution, Property 12` (bounded capture) as
`app/eval/artifact-sink.test.ts`, importing `propertyParameters` from `@app/test`, fails
the import-boundary lint rule: `app/eval may not depend on @app/test` (dependencies flow
inward only). `@app/eval`'s own pure function under test cannot pull in the shared
property-test harness from where it lives.

The test -> eval reach was already wired at hdl-creation-loop task 19.4 (see
`chipAgent/_inbox/eval-harness-integration-needs-test-to-eval-boundary.md`), so the fix
is just to place the file in `app/test/` and import the subject
(`captureSampleArtifacts`, `ARTIFACT_CAPS`, `SampleResult`) from `@app/eval` - the same
shape as the web-layer and eval-harness precedents already in the vault.

# Second gotcha: cap-spanning length arbitraries must not generate real random text

A property spanning `ARTIFACT_CAPS.maxRejectedDraftChars` (65,536) and
`ARTIFACT_CAPS.maxMissingCheckNames` (256) needs strings and lists in the tens-of-KB
range per generated case. Building those with `fc.string({ unit: 'grapheme', maxLength:
131_072 })` (double the cap) timed out the default 5s vitest test timeout at 100
iterations - `fc.string` with `unit: 'grapheme'` does real per-character Unicode work,
and doing that ~100 times at six-figure lengths is slow enough to matter.

Fix: since the property is about LENGTH and which END survives truncation, not about
content, generate the length as an `fc.integer` and build the string by repeating one
fixed character (`'a'.repeat(length)`). Same fix for the per-check-name generator feeding
an array up to `maxMissingCheckNames * 2` entries long. Dropped a 12.3s single test to
32ms for the whole file.

# Rule going forward

- Any property test for an `@app/eval` (or other non-`test`-layer) pure function that
  wants the shared `propertyParameters`/`propertyTag` harness belongs in `app/test/`,
  importing the subject from its own package - check `ALLOWED_INNER` reach exists first
  (it does, for `eval`, `web`, and `api` already) before assuming a new wiring step is
  needed.
- When a property's input space is bounded by a large named cap (tens of thousands of
  characters or hundreds of list entries) and the claim is about length/boundary
  behaviour, drive the arbitrary from `fc.integer` over the length and repeat a fixed
  character/element, rather than `fc.string`/`fc.array` of a rich generator at that size.

# Links

- app/test/artifact-sink-bounded-capture.property.test.ts (task 7.3, Property 12)
- app/eval/artifact-sink.ts (`ARTIFACT_CAPS`, `captureSampleArtifacts`)
- chipAgent/_inbox/eval-harness-integration-needs-test-to-eval-boundary.md (the test -> eval wiring this reuses)
- chipAgent/_inbox/web-layer-property-tests-need-test-to-web-boundary.md (same shape, web layer)
- chipAgent/_inbox/gotcha-tsc-b-app-test-fails-on-incomplete-siblings.md (unrelated concurrent-wave failure encountered in the same `vitest run`, attributed correctly rather than blamed on this task)
