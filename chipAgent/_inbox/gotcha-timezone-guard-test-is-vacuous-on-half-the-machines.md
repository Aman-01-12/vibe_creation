---
type: gotcha
title: A test that a date parser refuses a zone-less date is vacuous on half the world's machines
status: candidate
provenance: task 4.4 of .kiro/specs/eval-campaign-readiness - app/agent/model-router/fetch-json-http-port.test.ts
tags: [testing, non-vacuous, timezone, date-parsing, untrusted-input, model-router, retry-after]
timestamp: 2026-09-20
---

# What happened

`parseRetryAfterMs` refuses an HTTP-date with no explicit time zone, because `Date.parse` reads a zone-less date in the HOST's local time and the same header would then resolve to a different instant on every machine.
The obvious test - inject a clock slightly before the date, assert no delay is reported - PASSES on a host whose UTC offset is positive even with the guard removed, and so proves nothing there.

Measured on this machine (IST, +05:30):

- `Date.parse('Sun, 06 Nov 1994 08:49:37 GMT')` = `784111777000`
- `Date.parse('Sun, 06 Nov 1994 08:49:37')` = `784091977000` (19_800_000 ms EARLIER)

# Root cause

Removing the guard does not make the parser report a delay; it makes the parser report the local-time instant.
Whether that instant is in the future - and so whether a delay is reported at all - depends on the sign of the host's UTC offset.
With the clock set just before the GMT instant, a positive-offset host reads the zone-less instant as already elapsed, the parser's own "already elapsed reports no instruction" branch fires, and the assertion passes for the wrong reason.
CI in UTC and a developer in UTC+5:30 both go green; a developer in UTC-6 is the only one who sees the defect.

# Fix / rule

Put the injected clock a FULL DAY before the date, further than any legal zone offset (max +/-14h = 50_400_000 ms).
Then the zone-less reading is in the future on every host, so an accepting parser reports a positive delay everywhere and the assertion fails everywhere.

General rule: when an assertion's non-vacuity depends on an ENVIRONMENT value (a zone offset, a locale, a path separator, a clock), choose the fixture so the defect is observable across that value's whole range - do not choose the fixture that reads most naturally on the machine in front of you.
A cheap check: state out loud what the code under test would return with the guard deleted, and confirm THAT value fails the assertion.

# Links

- app/agent/model-router/retry-after.ts (`ENDS_WITH_TIME_ZONE`, and the `CONTAINS_LETTER` gate next to it, which has the same shape of risk)
- app/agent/model-router/fetch-json-http-port.test.ts ('refuses an HTTP-date with no time zone')
- chipAgent/_inbox/decision-retry-after-ceiling-is-a-port-build-constant.md (same boundary, task 4.3)
- chipAgent/_inbox/gotcha-union-widening-breaks-total-record-fakes.md (other recorded way an assertion goes quietly vacuous)
