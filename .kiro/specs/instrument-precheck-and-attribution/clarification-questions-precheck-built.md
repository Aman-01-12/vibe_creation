# Clarification question - the `'built'` precheck outcome is unreachable

Found while implementing task 4.3's property test (Property 7). One genuinely blocking question, discovered mid-implementation rather than during design review. Please answer in `clarification-answers-precheck-built.md` in this folder.

---

## Q1 - What does Requirement 4.2's "the Testbench_Precheck build succeeded" actually mean?

**Maps to:** Requirement 4.2, design.md component 3 (`app/agent/orchestrator/testbench-precheck.ts`, the decision table) and component 5 (`#admitInstrument`), Property 6, Property 7, task 4.3.

**The tension.** `PrecheckOutcome` is declared as a three-member union:

```ts
export type PrecheckOutcome = 'built' | 'testbench-build-failed' | 'undecided';
```

But `TestbenchPrecheck.run`'s actual decision table (design.md, component 3) only ever returns two of the three members:

- `testbench-build-failed` when the toolchain attributed a build failure to the testbench's own path.
- `undecided` for every other case: a `build-failed` cause naming only the stub, any other `failureCause` (including a clean build with an incomplete waveform capture, `output-incomplete`), or a thrown `simulate` call.

`'built'` is never assigned anywhere in the implementation. Task 3.4's real-toolchain integration test confirmed this by hand: the real `adder_16bit` testbench, which genuinely does build clean against its stub, reports `undecided` - not `built` - because "no build failure was ever attributed to the testbench" and "the stub genuinely elaborated and the testbench genuinely compiled" are the same fact from this decision table's point of view (Req 1.3's stub is deliberately passive/behaviourless, so it can never make a testbench's functional checks literally pass; there is no stronger positive signal than "we found no reason to refuse" for this module to report).

Requirement 4.2 reads: *"WHEN Loop_Setup has produced a Testbench AND the Testbench_Precheck build succeeded, THE Verification_Loop SHALL consult the Instrument_Admission port before the first iteration."*

`#admitInstrument` (`verification-loop.ts`) implements this literally against the `'built'` member:

```ts
if (precheckOutcome !== 'built' || this.#instrumentAdmission === undefined) {
  return null;  // never consults admission
}
```

Since `precheckOutcome` can never actually equal `'built'`, this condition is **always true** whenever an admission port is wired (unless the branch above it already returned for `testbench-build-failed`), so **the `InstrumentAdmission` port is never consulted, in any real run.** Task 4.3's property test (Property 7: "the only difference an admission port can make is a refusal") fails immediately: an `inadmissible` decision from a wired port never causes an `instrument-refused` outcome, because `admit` is never called at all.

This is not a test-writing mistake - I verified by tracing `#admitInstrument`'s only two callers of `precheckOutcome` and by driving the real `TestbenchPrecheck` with a real Icarus toolchain (matching task 3.4's fixture) that a clean build reports `undecided`, never `built`.

**Why this matters:** Requirement 4 - the whole reason this spec exists per the design doc's "measured numbers" section - closes 0 of the 11 instrument-invalid `tbslice-v1` samples as currently implemented, because the admission port that Requirement 4 depends on is dead code. Only the Testbench_Precheck (Requirement 1) is actually wired, closing 2 of 11.

**Options.**

| | option | consequence |
| --- | --- | --- |
| A | **Change the gate condition to `precheckOutcome === 'undecided'`** (i.e., drop `'built'` as a real state; keep it in the type only as a documented placeholder for a future positive-build-verification improvement, or remove it from the union entirely). Requirement 4.2 is reworded to "the Testbench_Precheck did not attribute a build failure to the Testbench" rather than "the build succeeded". | Smallest diff. Makes the admission port reachable exactly where the design's own numbers assume it is (all 11 instrument-invalid samples, since none of them were building-failed testbenches after the precheck fix). `'built'` becomes either a dead literal (confusing) or is deleted (touches the type's public signature, already exported from `app/agent/index.ts`). |
| B | **Make `TestbenchPrecheck` distinguish `'built'` from `'undecided'` for real** - e.g. only report `'built'` when the simulate run's `verdict` is not `'error'` at all (a stronger positive signal than merely "no build failure attributed"), keeping `'undecided'` for the genuinely ambiguous cases (thrown simulate, `output-incomplete`, build-failed-on-stub-only). Then Requirement 4.2's condition is satisfiable as literally written. | Larger diff: changes `TestbenchPrecheck.run`'s actual decision table (a component this spec already shipped and task 3.2/3.3/3.4 already tested against the CURRENT two-outcome behavior - all three would need re-verification). Also questionable substantively: the stub is deliberately behaviourless (Req 1.3), so a testbench connected to it may still report `pass`/`fail`/`error` for reasons that have nothing to do with whether it is a sound instrument against a REAL reference design - conflating "the stub run didn't error" with "build succeeded" risks its own misclassification. |
| C | **Leave `'built'` unreachable and accept that Requirement 4's admission gate is currently dead code**, closing this out as a known, tracked follow-up rather than a merge blocker - similar in spirit to how Q2 in the original clarification round deferred testbench regeneration. | Ships the Testbench_Precheck (Requirement 1, 2/11 samples closed) but not the Instrument_Admission gate (Requirement 4, the other 9/11) that the design's own "what this is worth" section cites as the main payoff. Property 7's test would need to be written against a scenario that can never occur in production, which makes it a test of dead code rather than of the loop's real behavior - arguably worse than not having the property test at all. |

**Recommended: A.** The whole evidentiary case for this spec (design.md's "measured numbers" section: 52 of 53 iterations and 197,901 of 223,034 tokens spent on instrument-invalid samples) depends on the admission port actually running, and it is described throughout the design and requirements as consulting the port after "the build succeeded" in the colloquial sense - i.e., after the precheck found no reason to refuse - not after a THIRD, never-implemented positive-confirmation step. Option B changes a component this spec already shipped and re-opens tasks 3.2-3.4 for re-verification, for a distinction (`'built'` vs `'undecided'`) that isn't clearly warranted by anything in the requirements: nothing else in the spec ever reads or needs a `'built'`-vs-`'undecided'` distinction; `#admitInstrument` is `TestbenchPrecheck`'s only consumer. Recommend rewording Requirement 4.2 and the gate condition to key off `precheckOutcome !== 'testbench-build-failed'` (equivalently, `=== 'undecided'` given the two-outcome reality), and downgrading `'built'` in the `PrecheckOutcome` type to a documented-but-currently-unused member reserved for a future positive-verification enhancement (or removing it, if a reviewer prefers a type with no dead literal).

---

## What is already blocked on this answer

- Task 4.3 (Property 7's property test) cannot pass against the current `verification-loop.ts` until this is resolved one way or another - the test itself is written and correct against the SPEC's stated intent; the production code is what's out of step.
- Checkpoint 11 (final gate) will fail vitest if task 4.3's test is merged as-is against unchanged production code.
- No other completed task in this session depends on this fix. Tasks 1-3.x, 6.x, 7.x, 9.x, 10.x are all independent of `#admitInstrument`'s gate condition.
