---
type: gotcha
title: A catch-all in #captureArtifacts silently swallowed a TypeError from stale test fixtures missing a newly-required field
status: candidate
provenance: testbench-repair-loop spec, task 8.7 (app/eval/artifact-sink.ts, app/eval/harness.ts)
tags: [hdl, verification, eval, testing, silent-failure]
timestamp: 2025-06-17T20:47:00Z
verifiedBy: 
---

# Gotcha

Task 8.7 added code in `captureSampleArtifacts` that reads `measured.repairProvenance.accepted`.
Several PRE-EXISTING test fixtures in `harness.test.ts` (predating task 2.1, which made
`repairProvenance` a required field on `VerificationOutcome`) build a `VerificationOutcome` via
`{ ... } as unknown as VerificationOutcome` casts that never got backfilled with the new
required field. Reading `.accepted` off `undefined` threw a `TypeError` at runtime.

This did NOT surface as a visible test failure. `EvalHarness#captureArtifacts` (the caller)
wraps its sink-write call in try/catch and swallows any throw by design (its own doc comment:
"an overnight campaign must not die because a diagnostic file could not be written"). So the
`TypeError` was caught and silently discarded, and the affected tests kept passing - they just
never actually got their artifact written, which the test itself wasn't asserting closely
enough to notice.

# Root cause

A DEFENSIVE catch-all designed to protect production robustness (never let an artifact-capture
bug kill an eval campaign) also hides genuine programming errors in code that feeds into it
during development/test. The same design property that makes `#captureArtifacts` safe in
production makes a bug inside `captureSampleArtifacts` invisible in tests, unless a test
specifically asserts the sink WAS called with the right shape.

# Fix

Made `captureSampleArtifacts` itself defensive at the point of read: default
`measured.repairProvenance` to `NO_REPAIR` when nullish, rather than patching every stale
fixture across the test suite. This matches the module's own already-stated contract
("`captureSampleArtifacts` ... never throws for a malformed outcome: an unreadable field
becomes an absent artifact") - the fix extends an existing documented discipline to a new
field, rather than being a one-off patch.

# Rule for next time

When adding a read of a "required" field to a PURE function that a fail-safe catch-all wraps
somewhere upstream, do not assume "the tests still pass" means the new code path was exercised
correctly - specifically check whether any caller silently swallows exceptions from the
function you're touching. If one does, the pure function itself must degrade gracefully for a
malformed/legacy input rather than relying on the field genuinely always being present, because
"required" at the TYPE level does not guarantee "actually present" for old runtime fixtures.

# Links

- `app/eval/artifact-sink.ts` (`captureSampleArtifacts`)
- `app/eval/harness.ts` (`#captureArtifacts`'s catch-all)
- `app/eval/harness.test.ts` (the stale fixtures)
