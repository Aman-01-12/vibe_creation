---
type: gotcha
title: PrecheckOutcome's 'built' literal was unreachable, silently making the Instrument_Admission port dead code
status: candidate
provenance: task 4.3 (instrument-precheck-and-attribution spec), discovered while writing/running Property 7's property test; fixed via founder-delegated Option A decision
tags: [testbench-precheck, instrument-admission, verification-loop, dead-code, type-design, exhaustiveness, app-agent, design-review]
timestamp: 2026-09-23T00:00:00Z
verifiedBy:
---

# What happened

`PrecheckOutcome` was typed as a three-member union:

```ts
export type PrecheckOutcome = 'built' | 'testbench-build-failed' | 'undecided';
```

`TestbenchPrecheck.run`'s real decision table (as implemented in task 3.1 and confirmed
by task 3.4's real-Icarus test) only ever assigns two of the three members: it returns
`testbench-build-failed` when the toolchain attributed a build failure to the testbench's
own path, and `undecided` for every other case - including a genuinely clean build. `'built'`
was never assigned anywhere.

`VerificationLoop#admitInstrument` gated consultation of the optional `InstrumentAdmission`
port on `precheckOutcome !== 'built'`. Since `precheckOutcome` could never equal `'built'`,
that condition was **always true**, so the admission port was never consulted in any real
run - it was dead code. Task 4.3's property test (Property 7: "the only difference an
admission port can make is a refusal") caught this immediately: an `inadmissible` decision
from a wired port never produced an `instrument-refused` outcome, because `admit` was never
called.

This was not a test-writing mistake; it was found by writing a correct test against a real
bug in already-shipped, already-typechecked, already-passing-lint production code. Nothing
in the type system flagged it, because `'built'` being unreachable is a semantic fact about
`TestbenchPrecheck.run`'s implementation, not a type error - the union itself was
perfectly well-typed and compiled cleanly.

# Root cause

The design's own decision table (design.md, component 3) documented three rows but the
router function in `TestbenchPrecheck.run` only had logic for two: `failureCause ===
'build-failed'` attributed to the testbench -> refuse, everything else -> `undecided`.
Requirement 4.2 was written against a THIRD, never-implemented positive-confirmation state
("the Testbench_Precheck build succeeded") that doesn't correspond to anything the actual
decision table distinguishes - "no build failure was attributed" and "the stub genuinely
elaborated and the testbench genuinely compiled" collapse to the same `undecided` outcome,
because the stub is deliberately passive/behaviourless (Req 1.3) and can never produce a
stronger positive signal than "we found no reason to refuse."

The caller (`#admitInstrument`) was written to the REQUIREMENT's literal wording
("build succeeded" -> gate on `'built'`) rather than to what the callee actually returns,
and nothing forced the two to be checked against each other until a property test exercised
the real code path end to end with a real toolchain-shaped fixture.

# Fix / rule

Founder explicitly delegated "go with the best option which suits our architecture" after
being presented three options in a clarification-questions file (per the founder's spec-
clarification steering rule). Chose Option A: narrow `PrecheckOutcome` to the two outcomes
the decision table actually produces (`'testbench-build-failed' | 'undecided'`), reword
Requirement 4.2 to match ("did not attribute a build failure to the Testbench" instead of
"build succeeded"), and change the gate condition in `#admitInstrument` from
`!== 'built'` to `!== 'undecided'`. Rejected: Option B (make the precheck genuinely
distinguish a third state) because it would reopen three already-shipped, already-tested
components for a distinction nothing else in the spec needs, and risks conflating "the
passive stub run didn't error" with "this is a sound instrument." Rejected: Option C
(leave it as dead code, defer) because the design doc's own quantified justification for
this spec (9 of 11 instrument-invalid samples closed by the admission port) would be false
in every real run.

**Rule for future work on this port/gate pair**: when a caller's gate condition is written
against a callee's DECLARED type rather than against what the callee's real decision logic
actually PRODUCES, write at least one test that drives the real callee (not a mock returning
an arbitrary member of the declared union) before trusting the caller's branch is reachable.
A closed union with a documented-but-unassigned literal is a silent trap: `tsc`/`eslint`
cannot catch it, only an end-to-end test that exercises the real decision function can.

# Links

- `app/agent/orchestrator/testbench-precheck.ts` (`PrecheckOutcome`, `TestbenchPrecheck.run`)
- `app/agent/orchestrator/verification-loop.ts` (`#admitInstrument`, the fixed gate condition)
- `app/test/admission-non-interference.property.test.ts` (task 4.3, Property 7 - the test that caught it)
- `app/test/testbench-precheck-measured-cases.integration.test.ts` (task 3.4 - already documented `'built'` as unreachable in its own header comment, before this was traced to the admission-port consequence)
- `.kiro/specs/instrument-precheck-and-attribution/clarification-questions-precheck-built.md`
- `.kiro/specs/instrument-precheck-and-attribution/clarification-answers-precheck-built.md`
- [[gotcha-precompiling-a-testbench-needs-a-spec-derived-stub-and-stopping-early-nearly-kills-the-golden-denominator]] (the same precheck/admission mechanism this bug lived in)
