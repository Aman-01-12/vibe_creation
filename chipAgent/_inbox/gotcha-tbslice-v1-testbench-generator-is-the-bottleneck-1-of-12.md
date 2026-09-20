---
type: gotcha
title: tbslice-v1 measured - the Testbench_Agent is the bottleneck, 1 of 12 testbenches passes its reference design
status: candidate
provenance: tbslice-v1 campaign run (config 5ede5f843ac2859b, commit e3bb5c1, clean tree, TESTBENCH_PROMPT_VERSION 2)
tags:
  [
    eval,
    campaign,
    instrument-validity,
    testbench,
    pass-at-k,
    coverage-gap,
    requirement-9.6,
    measured,
  ]
timestamp: 2026-09-19T14:02:43Z
verifiedBy: 
---

# What was measured

First run of the committed campaign-readiness slice `app/eval/sweep/sweep.config.tbslice.json`
(15 RTLLM problems spanning arithmetic/control/memory/miscellaneous, one arm
`kimi-k2_5` = `moonshotai.kimi-k2.5`, `sampleCount` 1, concurrency 1). Clean tree, so these
numbers ARE reproducible as cited - `workingTreeDirty: false`, commit `e3bb5c1`.

Ran to completion: planned 15, dispatched 15, recorded 15, no-verdict 3. No kill-switch trip,
no transport failures, no rate-limit burst (Track B's governor was never stressed).

```
GOLDEN pass@1 = 0.700   over 10 samples judged by the INDEPENDENT golden testbench
self-graded pass@1 = 1.000  over 1 (ONE) instrument-valid sample
instrument: 1/12 testbenches pass their reference design
instrument-invalid: 11  (rejected-reference 7, did-not-build 3, no-verdict 1)
statuses: verified 1, unverified 11, setup-failed 3
tokens: 223034 total (a FLOOR - 1 call returned no usable usage block)
```

# The finding

**The model's capability is not the constraint; our instrument is.** The independent judge
passed 7 of the 10 candidates it could rule on. Our own generated testbench was a usable
measuring stick in 1 of 12 cases where it was checked.

So the self-graded `pass@1 = 1.000` is arithmetically true and practically meaningless: n=1.
The same applies to the coverage-gap gate, which reads "none - met" but over a single probed
sample, making that gate statement close to vacuous at this sample size. Do not cite either
number without the denominator.

# What this says about Track C (requirement 9.6)

Track C added the input-window alignment rule (task 7.1) and the stimulus-adequacy rule
(task 8.1) specifically to reduce `TESTBENCH_FAILED_REFERENCE`. On this slice those defects
are NOT closed: `rejected-reference` is still the single largest invalidity cause at 7 of 11.

Do NOT read this as "Track C made it worse". The earlier 3-problem smoke slice
(`smoke-v1`, 1/3 valid) and this 15-problem slice are different problem sets and are not
directly comparable. The honest statement is the measured one: on the slice Requirement 9.6
is cited against, the instrument passes its reference in 1 of 12 checks.

# Three distinct failure modes, not one

Worth separating, because they point at different fixes:

1. **`TESTBENCH_FAILED_REFERENCE` (7)** - the testbench builds but rejects RTLLM's own
   human-verified reference. An incorrect expectation; the defect class Track C targeted.
2. **`TESTBENCH_REFERENCE_UNBUILDABLE` (3)** - the testbench does not even elaborate against
   the reference. A structural/interface mismatch, NOT a timing-expectation bug, so the
   input-window rule cannot address it. This one is arguably easier to close and was not
   separately targeted.
3. **`setup-failed` / testbench-unavailable (3)** - "The independent testbench did not cover
   every acceptance criterion", `iters=0`, so the loop never ran at all. A precondition
   check between our derived acceptance criteria and the golden testbench's coverage. Hit
   `div_16bit`, `counter_12`, `right_shifter`. Distinct from both defects above.

# The honesty machinery all worked (worth recording as a positive)

Every guard built in tracks A/B/C behaved correctly on real data:

- Track A's widened golden vocabulary produced distinct `did-not-build` (1) and `no-output`
  (1) exclusions rather than collapsing them into one "error".
- The golden block named its own denominator (10) and listed all 5 exclusions by cause.
- `over-strict 6` was explicitly attributed to broken instruments and NOT presented as
  disagreements to chase.
- The token figure self-labelled as a FLOOR because one call returned no usage block.
- Dollar cost reported UNKNOWN rather than assuming a price.
- The pinned `TBSLICE_RUN_CONFIG_HASH` from task 9.4 (`5ede5f843ac2859b`) matched the hash the
  live run actually computed - end-to-end confirmation the pin is real.

# Links

- `.eval-runs/tbslice-v1/` (results.jsonl, manifest.json, per-sample artifacts)
- `app/eval/sweep/sweep.config.tbslice.json` (the slice, task 9.3)
- [[gotcha-prompt-version-absent-from-experiment-identity]] (the identity fix this run validates)
- [[decision-instrument-invalid-samples-leave-the-pass-at-k-denominator]] (why 11 samples left
  the denominator rather than being scored)
- [[gotcha-three-testbench-defect-classes-that-fail-the-reference-design]] (the defect taxonomy
  this run re-measures at larger n)
- `.kiro/specs/eval-campaign-readiness/requirements.md` (Requirement 9.6, cited against this slice)

# Root-cause diagnosis (artifact pass over all 15 samples, no model calls)

**89% of the run's tokens (197,901 of 223,034) and 52 iterations bought nothing.** In 6 of the
11 instrument-invalid samples the independent judge says the candidate RTL was ALREADY CORRECT.

## The three buckets are four different bugs, not one

**`UNBUILDABLE` (3) splits into two unrelated causes.** Put every generated testbench through
`iverilog -t null`: exactly 2 of 12 have syntax errors, and both are the SAME bug - variable
declarations placed after executable statements inside `initial begin ... end`, illegal in the
Verilog-2001 dialect Icarus compiles:
- `adder_8bit` lines 49-50 (`integer pass_count;` after `$dumpfile`/`$dumpvars`)
- `multi_booth_8bit` lines 177-184 (8 declarations mid-block)
The model is declaring variables where it first needs them, C99-style. Note `JC_counter`
declares at the very TOP of an unnamed `initial begin` and DOES compile, so Icarus tolerates
head-of-block but not mid-block.

The third, `multi_16bit`, is NOT a syntax error - it parses fine. Its stderr reads
`workspace reached its 134217728-byte disk cap`. Resource exhaustion MISCLASSIFIED as a
testbench defect. Probable cause: `$dumpvars(0, tb)` writing an unbounded VCD; present in
**12 of 12** generated testbenches, so this is latent in all of them.

**`FAILED_REFERENCE` (7) is dominated by a sampling-MOMENT offset, not a wrong expected value.**
Signatures:
- `multi_pipe_8bit`: "third result expected 005a, got 0038" where `0038` was the SECOND
  expectation - output lags expectation by exactly one result
- `JC_counter`: expected lags actual by exactly 2 cycles
- `signal_generator`: `expected 5'd0, got 2`, `expected 1, got 3` - offset by 2
- `adder_pipe_64bit`: hardcodes `(pipe_idx+3)%4`, an ASSUMED pipeline depth
- `fsm`: different in kind - `expected MATCH=0 for pattern 110011, got 1`. A genuine
  spec-semantics disagreement about overlapping sequence detection (110011 does contain 10011),
  so here the testbench's understanding is arguably the wrong one.

**CORRECTION to the earlier JC_counter reading:** the self-referential
`expected = f(observed_output)` pattern is NOT the dominant defect. `adder_pipe_64bit` and
`multi_pipe_8bit` both derive the expected value from inputs the testbench itself drove -
exactly what task 7.1's rule demanded - and STILL fail. **Task 7.1's rule governs where the
expected VALUE comes from; these failures are about WHEN the output is sampled.** That is the
actual open gap, and it is why two rounds of prompt wording have not closed this bucket.

**`setup-failed` (3) is a fail-closed coverage gate plus an observability hole.** Cause is
`coverage-incomplete` in `testbench-agent.ts`: the source did not emit a `CHECK <name>` line
for every required check, decided by EXACT text match (`sourceEmitsCheck`). Names are
`ac<n>_` + a 40-char slug of the criterion text, giving 44-char mid-word-cut tokens like
`ac1_under_simulation_jc_counter_produces_the`, which the model must reproduce byte-exactly or
the whole sample is abandoned at `iters=0`. The rejected draft is NOT persisted
(`files: {}`), and `missingCheckNames` goes only to the trace, so from the artifacts we cannot
see what was written or even which check was missing.

`CONTROL_RUN_ERRORED` (1, `calendar`) not yet diagnosed.

## The structural finding, and the one with the most leverage

`harness.ts#runSample` does `await this.#drive(...)` - the WHOLE loop - and only THEN
`await this.#controlInstrument(...)`. So the repair budget is spent before anything checks
whether the instrument was ever valid.

It compounds: the loop's own oracle collapses "the testbench did not compile" into a generic
`verdict: 'error'`, so it responds by repairing the RTL. On `adder_8bit` the oracle returned
`verdict: 'error'`, `exitCode: 4`, `checks: []` on all 6 iterations, while stderr plainly named
the failing file as `adder_8bit_tb.v:49` - the TESTBENCH. The attribution information was
present and discarded, so the loop spent 6 iterations repairing RTL the golden judge then
passed. This is the concrete instance of [[gotcha-simulation-verdict-collapses-error-causes]].

## Ranked by leverage per unit of effort (only #4 is a prompt problem)

1. **Compile the generated testbench the instant it is produced**, before any repair iteration.
   Deterministic, free, needs no reference design and no model call. Catches both syntax cases
   immediately and would have saved 12 iterations. And attribute a compile failure to the
   FAILING FILE, so testbench breakage can never trigger RTL repair.
2. **Run the positive control before the repair loop**, not after.
3. **Bound or drop `$dumpvars` in eval** - fixes the disk-cap case, removes a latent failure
   from all 12, and stops resource exhaustion being labelled a testbench defect.
4. **The sampling-moment rule** - the genuinely hard one, where prose has now failed twice.
   Needs a different mechanism than wording (e.g. requiring the testbench to sample only on a
   qualifier the DUT itself asserts, and structurally forbidding absolute-cycle sampling).
5. **Persist the rejected draft and the missing check names**; reconsider byte-exact matching
   of a 44-char machine-generated token as an all-or-nothing sample gate.

Items 1, 2, 3 and 5 are mechanical harness changes, not prompt work. The cheapest wins are not
in the testbench generator at all - they are in the harness noticing sooner that the testbench
is broken.
