---
type: gotcha
title: Display_Layer fail-closed invariants differ from the Trust_Labeler's
status: candidate
provenance: hdl-creation-loop task 15.2 (Property 2, Display_Layer fails closed on Verified labels)
tags: [display-layer, trust, fail-closed, property-based, app-web, testing]
timestamp: 2025-05-27T00:00:00Z
verifiedBy: npx tsc -b app/web app/test + eslint --max-warnings=0 + vitest run (3 passed, 100 runs/property)
---

# Gotcha

The Display_Layer's fail-closed decision (`decideTrustTreatment` in `app/web/display/trust-treatment.ts`) is a provenance-integrity check on an UNTRUSTED streamed label, and its rules are subtly different from the Trust_Labeler's (`@app/core` `labelArtifact`, Property 1). Do not assume they behave the same:

1. No pedagogy special-casing. The Trust_Labeler forces `intent`/`spec`/`testbench`/`explanation` to `Not_Applicable` regardless of evidence. The Display_Layer does NOT: it applies `Verified` to ANY artifact kind whose label claims `Verified` and whose `oracleSpanRef` is a valid ULID matching a PASSING span for the exact kind/id/version. Kind is irrelevant to the Display_Layer's check. An independent oracle for Property 2 must therefore NOT special-case kind.

2. `Verified` is earned only by an EXACT-version passing span. A passing span for a stale version, a different id, a different kind, or a non-pass verdict never validates the claim; it fails closed to `Unverified` with an `unvalidatable-provenance` discrepancy whose `rejectedOracleSpanRef` is the (valid-ULID) claimed ref.

3. Provenance rejection ordering: absent (`undefined`/`null`/`''`) -> `missing-provenance` (rejectedRef `null`); present but not a valid ULID string, OR any non-string value -> `malformed-provenance` (rejectedRef `null`). Only a valid-ULID-but-no-match reaches `unvalidatable-provenance` (rejectedRef = the ref). The rejected ref is only ever surfaced when it is a well-formed ULID, so no untrusted free-form string leaks into the Trace.

4. Unreadable => null artifactRef. If the `artifactRef` cannot be parsed (bad kind, non-ULID id, negative/non-integer version, non-object) OR the `tier` is unknown/absent, the WHOLE label is junk: `tier` fails closed to `Unverified`, `artifactRef` is `null`, and NO discrepancy is emitted (no coherent `Verified` claim can be attributed). Note a readable ref + unknown tier STILL yields `artifactRef: null`.

5. Discrepancy is emitted (Req 14.15) ONLY when a label CLAIMING `Verified` is rejected. A plain `Unverified`/`Not_Applicable` label keeps its own tier and emits nothing; unreadable junk fails closed silently.

# Independent-oracle recipe (Property 2)

Build each case from a labelled arm (earned / wrong-verdict / stale-version / no-span / missing-prov / malformed-prov / unreadable-ref / plain-unverified / plain-not-applicable / junk-unknown-tier / junk-non-object) and derive the expected `{tier, artifactRef, discrepancy}` from the arm identity - never by calling `decideTrustTreatment`. Wrap the matching span in leading/trailing NOISE spans that reference `differentUlid(target.id)` so they can never accidentally match. Assert BOTH the pure `decideTrustTreatment` and the impure `createDisplayLayer(port).resolveTreatment` (the latter proves the discrepancy reaches the Trace port exactly once iff a Verified claim is rejected). fast-check v4 untrusted strings via `fc.string({ unit: 'grapheme' })`.

# Links

- app/test/display-layer-fail-closed.property.test.ts (Property 2)
- app/web/display/trust-treatment.ts, app/web/display/display-layer.ts, app/web/display/discrepancy.ts
- Related: chipAgent/_inbox/web-layer-property-tests-need-test-to-web-boundary.md (placement + boundary), chipAgent/_inbox/pattern-display-layer-fail-closed-port.md
