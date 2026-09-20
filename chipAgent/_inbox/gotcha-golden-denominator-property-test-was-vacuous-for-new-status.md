---
type: gotcha
title: Widening a status union left an existing property test vacuously passing on the new member
status: candidate
provenance: task 7.4 (instrument-precheck-and-attribution spec), spec-task-execution subagent
tags: [testing, property-based, fast-check, non-vacuous, golden-judge, sample-outcome-status]
timestamp: 2026-09-19T23:11:15Z
verifiedBy:
---

# Gotcha

`countsInGoldenPassAtK` and `summarizeGoldenPassAtK` in `app/eval/golden-judge.ts` both gated
golden-denominator membership strictly on `reachedOracleVerdict(outcomeStatus)`. That made an
`instrument-refused` sample permanently EXCLUDED from the golden denominator - even though it
carries a real candidate (via `candidateRtlOf`, fixed in task 7.1) that the independent judge
CAN score. This was the exact bug Requirement 5.7 exists to fix.

The existing property test in `golden-judge.test.ts` (Property 1) had a generator
(`OUTCOME_STATUSES`) that never drew `instrument-refused` as a value, even after task 4.1 added
that literal to `SampleOutcomeStatus`. So the property test kept passing throughout tasks
4.1-7.1 - it was checking a real property, correctly, over a domain that silently excluded the
one value whose behavior was about to change. Widening the type did not widen the test's
generator, and nothing forced it to.

# Root cause

A property test's generator is a SEPARATE piece of code from the type it enumerates over.
TypeScript's exhaustiveness checking (a `switch` with a `never`-check default, a total
`Record<SomeUnion, X>`) catches an unhandled union member at COMPILE time. A hand-written
array of literal values used as a fast-check generator (`OUTCOME_STATUSES = ['verified',
'unverified', ...]`) has no equivalent check - adding a member to the source union does not
force the generator array to grow, and the test suite stays green while quietly testing less
than it did before the type changed.

# The fix

Added `'instrument-refused'` to the generator array, added a `HAD_CANDIDATE_TO_JUDGE` set
mirroring the requirement's own wording (`reachedOracleVerdict(status) ||
status === 'instrument-refused'`) so the property test's own oracle tracks the production
logic's new admission rule, and added four explicit example-based tests (admits with `passed`,
admits with `failed`, excludes with no golden outcome, and the `summarizeGoldenPassAtK` bucket
check) that would have failed against the OLD code and pass against the NEW code - proving the
property test suite could not have caught this bug before the fix and can now.

# Rule going forward

When a status/outcome union gains a new member (especially one added across several sequential
tasks, as here - the literal landed in task 4.1, the exclusion-from-pass@k logic in task 6.x,
and the golden-denominator admission in 7.4), grep every hand-written enumeration array used as
a property-test generator for that union and confirm the new member is included. TypeScript
will not catch this for you; only re-reading the generator will. Prefer deriving a generator
from the union's own exhaustive mapping table (the way `NO_VERDICT_CAUSES` in
`no-verdict-cause.ts` is derived from `Object.keys(DEFERRABLE_BY_CAUSE)`) over a hand-written
literal array, wherever the union already has one canonical total `Record` to derive from.

# Links

- `app/eval/golden-judge.ts` (`countsInGoldenPassAtK`, `hadCandidateToJudge`)
- `app/eval/golden-judge.test.ts` (the widened `OUTCOME_STATUSES` generator)
- `app/eval/no-verdict-cause.ts` (`NO_VERDICT_CAUSES`, the derive-don't-hand-write precedent)
