# Clarification answer - the 'built' precheck outcome is unreachable

Decision: **Option A.**

Delegated explicitly: "go with the best option which suits our architecture of the product and our workflow." Reasoning below is the agent's (mine), made on that delegation, not an independently-supplied founder rationale - recorded transparently per the workflow rule that every decision in this file states who decided and why.

## Why A

The entire evidentiary case in design.md's "What the measured numbers say this is worth" section
(52 of 53 iterations and 197,901 of 223,034 tokens spent on instrument-invalid samples) depends on
the Instrument_Admission port actually being consulted. As implemented, `precheckOutcome === 'built'`
can never be true, so the port is dead code and Requirement 4 - the majority of this spec's stated
payoff (9 of 11 samples) - does nothing in any real run.

Option B (make TestbenchPrecheck genuinely distinguish a third state) would reopen and re-verify
three already-shipped, already-tested components (tasks 3.1-3.4, including a real-Icarus
integration test) for a distinction nothing else in the spec reads or needs. It also risks its own
misclassification: the stub is deliberately behaviourless (Req 1.3), so "the stub run didn't error"
is not the same claim as "this is a sound instrument," and building a third state around that
conflation trades one ambiguity for another.

Option C (accept the gate as dead code, defer as a tracked follow-up) ships a spec whose own design
document names a mechanism as its main quantified benefit while leaving that mechanism unreachable
in every real run. That is a worse state than fixing a one-line gate condition: it is not a smaller
diff, it is a documented mechanism that silently does nothing.

Option A is the smallest change that makes the code match the design's own stated intent, and it
does not touch any already-shipped, already-tested component.

## What changes

- **Requirement 4.2** (requirements.md): reworded from "WHEN Loop_Setup has produced a Testbench
  AND the Testbench_Precheck build succeeded" to "WHEN Loop_Setup has produced a Testbench AND the
  Testbench_Precheck did not attribute a build failure to the Testbench" - matching what the
  decision table actually distinguishes (Req 1.9's own two-outcome reality: `testbench-build-failed`
  vs. `undecided`), not a third state that was never implemented.
- **design.md**, component 5 (`#admitInstrument`): the prose describing the gate condition updated
  to read `precheckOutcome !== 'testbench-build-failed'` (equivalently `=== 'undecided'` given the
  real two-outcome decision table), replacing the reference to a `'built'` branch.
- **`PrecheckOutcome` type** (`app/agent/orchestrator/testbench-precheck.ts`, design.md component 3):
  narrow the union to `'testbench-build-failed' | 'undecided'`, removing the dead `'built'` literal
  entirely rather than keeping it as a documented-but-unused placeholder - a type with no dead
  literal is easier to reason about and nothing in the spec's 15 properties or its tasks reads
  `'built'` by name.
- **`app/agent/orchestrator/verification-loop.ts`** (`#admitInstrument`): the gate condition changes
  from `precheckOutcome !== 'built'` to `precheckOutcome !== 'undecided'` (i.e., only proceed to
  admission on `'undecided'`; `'testbench-build-failed'` is already handled by the branch above it
  and returns before this check is reached).
- **Task 4.2** (tasks.md, already marked complete): its own bullet text updated to say "after a
  precheck that did not attribute a build failure" rather than "a successful precheck build," for
  consistency; no re-implementation needed since the fix is confined to the gate condition and the
  type.
- **Property 6 and Property 7** (design.md): restated to drop any implied reference to a `'built'`
  outcome; both properties already describe the real two-outcome behavior correctly in their
  "for any precheck simulation result" / "for any admission decision" phrasing; the fix is only in
  the components table's prose, not the properties themselves.

## What does not change

- `TestbenchPrecheck.run`'s actual implementation and decision table (tasks 3.1, already complete) -
  no code change there, only the type it returns loses a literal it never produced.
- Tasks 3.2, 3.3, 3.4 (already complete, already verified) - none of them assert on or generate a
  `'built'` outcome; task 3.4's own header comment already documents that `'built'` is unreachable
  and asserts `undecided` for the clean-build case. No re-verification needed.
- The `InstrumentAdmission` port's own interface (`app/agent/orchestrator/instrument-admission.ts`,
  task 3.5) - unaffected; only the CALLER's gate condition changes.
- Requirements 4.1, 4.3-4.16 - unaffected; only 4.2's own wording changes.

## Re-verification required

Task 4.3's property test (`app/test/admission-non-interference.property.test.ts`, already written
by the sub-agent this session) should pass unchanged once the gate condition is fixed - it was
written correctly against the spec's stated intent; only the production code needs to change to
match it.
