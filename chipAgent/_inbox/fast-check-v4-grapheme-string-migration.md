---
type: gotcha
title: fast-check v4 removed fullUnicodeString; use string({ unit: 'grapheme' })
status: candidate
provenance: hdl-creation-loop task 11.2 (Property 14 bounded-clarification property test)
tags: [testing, property-based, fast-check, migration, unicode]
timestamp: 2025-05-27T00:00:00Z
verifiedBy: npx tsc -b app/test --force + npx eslint --max-warnings=0 + npx vitest run (Property 14 file, 3 tests pass)
---

# What happened

The repo is pinned to fast-check 4.8.0 (`app/test/package.json`).
The old `fc.fullUnicodeString(...)` arbitrary that older fast-check guides reach for no longer exists in v4, so a property test that needs full-unicode text will not compile against it.

# Root cause

fast-check v4 collapsed the family of string arbitraries into a single `fc.string(...)` that takes a `unit` option describing the character unit.
The dedicated `fullUnicodeString` / `unicodeString` constructors were removed in the v4 API cleanup.

# Fix / rule

When a property needs full-unicode strings, use `fc.string({ unit: 'grapheme', minLength, maxLength })`.
When the value must be non-empty after trimming (for example, a field a boundary parser rejects when blank, like the Intent_Agent `summary`), a bare grapheme string can still trim to empty (whitespace-only or combining marks), so prefix a guaranteed-visible literal and map: `fc.string({ unit: 'grapheme', minLength: 0, maxLength: n }).map((s) => \`module \${s}\`)`.
Keep using the shared `propertyParameters()` / `propertyTag()` harness (see the shared-pbt-harness note); this only changes the string arbitrary, not the conventions.

# Links

- app/test/intent-clarification-bound.property.test.ts (nonEmptyText helper)
- app/test/package.json (fast-check pinned 4.8.0)
- chipAgent/_inbox/shared-pbt-harness-conventions.md
