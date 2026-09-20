---
type: gotcha
title: stage1-screen-v2 measured the instrument defect mix - a Verilog-2001 DIALECT defect and one RTL CONCURRENCY defect account for ~85% of it, and the concurrency class is now on its THIRD prompt attempt
status: candidate
provenance: 495-sample campaign .eval-runs/stage1-screen-v2 (11 models x 15 RTLLM designs x n=3), diagnosed from persisted control-stdout.txt and offending testbench source lines; repaired in app/agent/roles/testbench/prompt.ts at TESTBENCH_PROMPT_VERSION 3, NOT yet re-measured
tags:
  [
    testbench,
    prompt,
    context-engineering,
    eval,
    instrument-validity,
    rtllm,
    defect-class,
    verilog-2001,
    icarus,
    systemverilog,
    dialect,
    concurrency,
    timing,
    config-identity,
  ]
timestamp: 2026-09-24
---

# What happened

The first campaign large enough to be a RATE rather than a data point: 495 samples, 11 models x 15 RTLLM designs x n=3.
322 of them were `instrument-invalid` - our own generated testbench, not the candidate design, decided the outcome.

The mix splits cleanly, and neither half is the class two previous prompt attempts were aimed at:

| share of the 322 | cause                                                                     |
| ---------------- | ------------------------------------------------------------------------- |
| ~25%             | `did-not-build` - the testbench does not COMPILE                          |
| ~60%             | `rejected-reference` - it compiles, runs, and rejects the known-good design |

That is the first honest answer to the open follow-up left by
[[gotcha-generated-testbench-assumes-a-reset-that-does-not-exist]] ("this says nothing yet about HOW OFTEN the class occurs")
and it closes the "validate on a WIDER slice than three problems" instruction left by
[[gotcha-three-testbench-defect-classes-that-fail-the-reference-design]].

## The did-not-build half is a DIALECT defect, not a logic defect

Of 38 bare `syntax error` diagnostics, ~30 point at a DECLARATION in a position Verilog-2001 forbids.
The offending source lines, with counts:

- `integer i;` x10 - the single most common offending line
- ~20 further `reg ...;` declarations (`reg holding;`, `reg [4:0] expected;`, `reg [15:0] prev_out;`, `reg [64:0] pipeline_data [0:10];`)
- `logic [16:0] expected = compute_expected_product(a_val, b_val);` - a SystemVerilog `logic` type
- `integer seq[0:9] = {1,0,0,1,1,1,0,0,1,1};` - SV array-with-initializer
- `reg [3:0] expected_count = 4'b0000;` and `reg [3:0] saved_count = expected_count;` - declaration-with-initializer inside a procedural block
- `a = 9'sd-1;` - malformed signed literal; the correct form is `-9'sd1`

Root cause: the oracle is Icarus Verilog compiling the **Verilog-2001** dialect, and the models emit **SystemVerilog** idioms.
Per-arm this tracks training recency rather than capability - qwen3-235b 27 `did-not-build`, qwen3-coder-30b 17, against glm-5 5 and deepseek 6.
Nothing in the prompt had ever named the dialect, so the models were guessing, and the newer ones guessed SystemVerilog.

This is the same root cause [[gotcha-tbslice-v1-testbench-generator-is-the-bottleneck-1-of-12]] hit at N=12 and
`app/test/testbench-precheck-measured-cases.integration.test.ts` pins as fixtures. The precheck CATCHES it; the prompt now tries to prevent it.

## The rejected-reference half is ONE concurrency defect wearing four disguises

The founder's diagnosis, which the evidence supports better than any per-symptom framing:
**hardware is CONCURRENT** - at one clock edge many things resolve simultaneously - while LLMs are trained on sequential
imperative code and reason about the design as a program they step. Every sub-symptom is that one error:

- `counter_12`: `FAIL: at cycle 0, expected 0, got 1`; `calendar`: `FAIL: Post-reset values incorrect - Hours= 0 Mins= 0 Secs= 1`.
  The testbench sequences "reset ends, THEN counting begins" - two things that resolve on the SAME edge.
- `adder_pipe_64bit`: expectation computed as `expected_result = result_pipe[1];` - a SHADOW PIPELINE, indexed at a stage the
  testbench chose, reported as `Basic Add Mismatch. Expected 0...03, Got 0`.
- `signal_generator`: `expected_wave = 5'd0;` / `if(expected_wave == 5'd30)` - a SHADOW STATE MACHINE carrying its own phase,
  reported as `cycle=1 expected=0 actual=3`. Note the BLOCKING assignment: the expectation is computed in the same instant the
  DUT's nonblocking updates are still settling.
- `multi_16bit`: `FAIL: Test nominal timed out waiting for done.` - a chosen timeout bound is still an assumed latency.

**Why this hid for two attempts:** the failure MESSAGES mostly read `expected X, got Y` with no timing word anywhere in them.
Read as text, they look like value bugs, so the class kept getting counted against `EXPECTED_VALUE_RULE` instead.

# Fix / rule

Two new unconditional constants in `app/agent/roles/testbench/prompt.ts`, both included in the assembled prompt.
Nothing existing was replaced: `EXPECTED_VALUE_RULE`, `describeStateAnchoring`, `describeTiming`, and `describeInputWindow` are untouched.

**`DIALECT_RULE`** (targets did-not-build). Stated as a fact about the TOOLCHAIN, not a style constraint - the oracle compiles
Verilog-2001 with Icarus, so an SV idiom is a compile error for every design:

- declare every `reg`, `integer`, and array at MODULE scope before the first `initial`/`always`, never inside a procedural block and never after an executable statement;
- give no declaration an initial value; assign inside an `initial` block;
- `reg`/`wire` only, never `logic` or `bit`;
- no array-with-initializer syntax;
- `-9'sd1`, never `9'sd-1`.

Each clause is pinned to a construct the measurement actually caught, rather than a general "write portable Verilog" a model can agree with and still violate line by line.

**`CONCURRENCY_RULE`** (targets rejected-reference). Three clauses: the design is a concurrent machine you OBSERVE rather than a
program you step (so reset deassertion and the first state update can resolve on the same edge); build NO second implementation
inside the testbench (no shadow pipeline, no shadow state machine, no self-shifted latency array, no re-derived state stepped
across edges); sample only in the SETTLED part of a clock period, and compute expectations with blocking assignments only over
values already OBSERVED.

## Why this is the THIRD attempt at the timing class, and why it is different in KIND

Attempts 1 and 2 are recorded in [[gotcha-three-testbench-defect-classes-that-fail-the-reference-design]]: the class moved twice
under two prompt rewrites, re-entering each time in a new disguise (assumed cycle -> predicted qualifier per cycle -> misaligned
input window). That note's warning was explicit: do not restate an existing rule in new words.

`describeTiming` and `describeInputWindow` both answer a **WHICH-MOMENT** question - which moment may I sample, which inputs form
one result. A model can follow either to the letter and still get it wrong, because neither touches the belief underneath.
`CONCURRENCY_RULE` targets the **MENTAL MODEL**: it forbids the testbench from being a second implementation at all, which is the
generator of every disguise the class has worn. That is a different kind of rule, not a reworded one.

**Consistency check against `describeStateAnchoring`** (which permits "carry the expected value forward from the previous phase,
or derive it from the OBSERVED outputs"): checked, and NOT a conflict. Both rules anchor in observation. Carrying forward a value
you observed is anchored; re-deriving the design's own state transition and stepping it is anchored in nothing. The distinction
is stated inside the prompt text ("Carrying forward a value you OBSERVED, as the state-anchoring rule above allows, is not that")
so the two cannot be read as contradicting each other, and the property test asserts that carve-out is present.

## Identity cost (paid deliberately, again)

`TESTBENCH_PROMPT_VERSION` 2 -> 3, which is folded into the sweep config identity, so three pins moved and all three were
re-pinned from OBSERVED values, never pre-computed:

| pin                          | before             | after              |
| ---------------------------- | ------------------ | ------------------ |
| `PINNED_PROMPT_DIGEST` (v2 -> v3) | `f781f7a4...0aeab9` | `f7c633e8...6322d0` |
| `SMOKE_RUN_CONFIG_HASH`      | `87dcd6c3f78c23fa` | `0a0102b7b3b2a9c4` |
| `TBSLICE_RUN_CONFIG_HASH`    | `ded77955f2374691` | `b29f5d4a8f373956` |

Reason, appended to both history comments: a testbench prompt change is a different experiment, so samples either side must never
pool - the same argument [[gotcha-prompt-version-absent-from-experiment-identity]] made when the version was first folded in.
That means `.eval-runs/stage1-screen-v2`'s 495 samples are now unresumable under the new identity. Correct: they measure the
instrument this change is trying to fix.

## Context budget cost

The assembled prompt for the canonical fixture Spec went **4875 -> 6898 characters** (+2023, **+41.5%**); word count 810 -> 1137
(+40.4%). Well over the ~15% the instruction flagged, and stated plainly rather than smoothed over: the two rules carry ten
distinct clauses against a prompt that was only 4875 characters to begin with, so a large relative growth was unavoidable once the
clause count was fixed. Against `product-ece/ECE-CONTEXT-ENGINEERING.md`'s "smallest set of high-signal tokens", the argument for
paying it is that ~85% of a 322-sample invalid population is as high-signal as a prompt clause gets - but that is a judgment, and
it is the founder's to make, not a measured result.

## NOT yet measured

This is the important caveat. Both rules are written and every gate passes, but **no campaign has run under prompt version 3**.
Attempt 1 and attempt 2 both looked right and both failed on re-measurement, so nothing here should be read as a fix until a
slice is re-run. The next measurement should be the wider `tbslice` (15 designs), not a per-problem loop - a per-problem fix loop
is how a prompt gets overfitted, which is why neither rule names a design.

# Links

- app/agent/roles/testbench/prompt.ts (`DIALECT_RULE`, `CONCURRENCY_RULE`, and the five rules they join)
- app/agent/roles/testbench/prompt-version.ts (the 2 -> 3 bump and its HISTORY block)
- app/agent/roles/testbench/prompt-version.test.ts (the re-pinned assembled-prompt digest)
- app/eval/sweep/manifest.test.ts (both re-pinned config hashes and their appended reasons)
- app/test/testbench-rtl-isolation.property.test.ts (Property 4 now asserts both new rules, clause by clause)
- app/test/testbench-precheck-measured-cases.integration.test.ts (the dialect defect as committed fixtures - left untouched; those artifacts are EVIDENCE, not broken fixtures to repair)
- [[gotcha-three-testbench-defect-classes-that-fail-the-reference-design]]
- [[gotcha-generated-testbench-assumes-a-reset-that-does-not-exist]]
- [[gotcha-tbslice-v1-testbench-generator-is-the-bottleneck-1-of-12]]
- [[gotcha-prompt-version-absent-from-experiment-identity]]
- [[decision-instrument-invalid-samples-leave-the-pass-at-k-denominator]]
- product-ece/ECE-CONTEXT-ENGINEERING.md (prompt altitude, conditional rules over enumerated cases, token budget)
