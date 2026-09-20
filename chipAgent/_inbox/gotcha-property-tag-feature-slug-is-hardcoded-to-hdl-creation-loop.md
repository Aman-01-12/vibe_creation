---
type: gotcha
title: app/test's propertyTag hardcodes FEATURE_TAG to hdl-creation-loop, so a later spec's property tests must not call it
status: candidate
provenance: task 1.2 (instrument-precheck-and-attribution spec), spec-task-execution subagent
tags: [testing, property-based, fast-check, conventions, app-test, multi-spec]
timestamp: 2026-09-19T23:11:15Z
verifiedBy:
---

# Gotcha

`app/test/property.ts` exports `propertyTag(n, text)`, which renders
`Feature: ${FEATURE_TAG}, Property {n}: {text}`. `FEATURE_TAG` is a single
top-level `const` hardcoded to `'hdl-creation-loop'` - the feature that shared
harness was built for (task 1.3 of that spec, properties numbered 1-32, all
already claimed: e.g. Property 2 there is "Display_Layer fails closed on
Verified labels", `app/test/display-layer-fail-closed.property.test.ts`).

`instrument-precheck-and-attribution`'s own design.md numbers its correctness
properties 1-14 independently, in its own namespace. Its Property 2 ("A
resource-bound kill outranks every other cause") has NOTHING to do with
hdl-creation-loop's Property 2. Calling `propertyTag(2, 'A resource-bound kill
outranks every other cause')` would silently render
`Feature: hdl-creation-loop, Property 2: A resource-bound kill outranks every
other cause` - a tag that falsely claims membership in the wrong feature and
collides (same feature, same number, two different claims) with the tag the
real hdl-creation-loop Property 2 test already emits. Nothing in the type
system or the test runner catches this; `propertyTag` takes a bare number and
string and will happily stamp any spec's claim under any other spec's slug.

# Root cause

The harness was built once, for one spec, with a single hardcoded feature slug
rather than a parameter. It was never extended when a second spec
(`instrument-precheck-and-attribution`) started adding its own numbered
properties into the same `app/test/` directory, because nothing forces a
call site to pass the RIGHT slug - there is no slug parameter at all.

# The fix (task 1.2)

Did not call `propertyTag`. Built the describe-block tag as a plain literal
string instead: `'instrument-precheck-and-attribution, Property 2: A
resource-bound kill outranks every other cause'`, matching the doc-comment
style `failure-attribution.ts` itself already uses to reference `Property 1`,
`Property 2`, `Property 3` (its own design's numbering). Still called
`propertyParameters()` from the same module, since the 100+-iteration
convention IS shared and feature-agnostic - only the tag string is
feature-scoped.

# Rule going forward

Before calling `propertyTag(n, ...)` in any new property test file under
`app/test/`, check which spec's Property `n` you actually mean. If it is not
hdl-creation-loop's own numbered property, do NOT call `propertyTag` - write
the tag as a literal string prefixed with the correct feature slug instead
(`'<spec-name>, Property <n>: <text>'`), and still use `propertyParameters()`
for the shared iteration-count default. If a third spec starts adding property
tests here, the harness itself should probably grow a `featureTag` parameter
rather than staying a hardcoded constant - flag that as a design smell if it
recurs a third time.

# Links

- `app/test/property.ts` (`FEATURE_TAG`, `propertyTag`)
- `app/test/failure-attribution-precedence.property.test.ts` (the workaround)
- `app/tools/simulator/failure-attribution.ts` (source of the instrument-precheck-and-attribution property numbering)
- `.kiro/specs/instrument-precheck-and-attribution/design.md` (Correctness Properties section)
