---
type: gotcha
title: Three Testbench_Agent defect classes that fail the reference design - precomputed literals, assumed timing, and an unjustified known-answer block
status: candidate
provenance: real Stage 1 campaign (kimi-k2_5, .eval-runs/stage1-screening) diagnosed from persisted control-stdout.txt; repaired in app/agent/roles/testbench and re-measured by .eval-runs/tbfix-verify + tbfix-verify2
tags:
  [
    testbench,
    prompt,
    context-engineering,
    eval,
    instrument-validity,
    pass-at-k,
    rtllm,
    defect-class,
    known-answer,
    timing,
  ]
timestamp: 2026-09-16
---

# What happened

The first real Stage 1 campaign (4 arms x 46 problems x 3 samples) had to be killed.
Of the first 7 samples, 6 were `INSTRUMENT-INVALID(TESTBENCH_FAILED_REFERENCE)` - our generated testbench rejected RTLLM's own human-verified reference design - while the independent golden judge PASSED 6 of the same 7 candidates.
The models were producing correct designs and OUR TESTBENCH was rejecting them, which empties the pass@k denominator and makes the campaign measure nothing.

This is the revisit trigger [[decision-instrument-invalid-samples-leave-the-pass-at-k-denominator]] wrote down, firing exactly as predicted: "if `instrument-invalid` is a meaningful fraction, the finding is about the Testbench_Agent prompt".
It is NOT one bug. The persisted `control-stdout.txt` separates three distinct classes, and only one of them is the reset/state-anchoring class already recorded in [[gotcha-generated-testbench-assumes-a-reset-that-does-not-exist]].

## Class 1 - a hand-precomputed expected value is simply wrong

`rtllm/arithmetic/adder_32bit`, two samples of the same problem:

```
sample-0: CHECK ..._case14_random_pattern2 FAIL: expected S=a9ac7aad C32=1, got S=a9ac79ad C32=1
sample-1: CHECK ..._pattern1              FAIL: expected S=a9ae7aad C32=1, got S=a9ac79ad C32=1
```

The `got` value is IDENTICAL across both samples, so it is the reference's correct output.
Our testbench wrote a DIFFERENT WRONG literal each time. 19 of 20 cases passed; the one that failed was the random pattern, the only one not trivially computable in the head.

## Class 2 - an assumed latency or handshake phase the Spec never stated

`rtllm/arithmetic/accu`:

```
FAIL: cycle 1, expected valid_out=0, got 1
FAIL: valid_out not 1 after 4 inputs
FAIL: expected valid_out=1, data_out=0a0, got valid_out=0, data_out=090
```

## Class 3 - a known-answer block check that the declared interface cannot justify

`rtllm/arithmetic/adder_16bit`:

```
Known answer fail: a=1, b=1, cin=0, got y[0]=0 Co=0, exp y[0]=0 Co=1
CHECK known_answer_full_adder_truth_table FAIL: 4 errors
```

Against the REFERENCE. The 4 failing rows are exactly the rows where the 1-bit full adder carries out.

# Root cause

Class 1 and Class 2 are prompt gaps. Class 3 is a BLOCK-MATCHING BUG, not a prompt issue.

**Class 1.** Nothing in the prompt said where an expected value must come from, so the model performed 32-bit arithmetic mentally and baked the answer in as a constant. The check then tests the model's own hand calculation rather than the design. This is a general failure for any arithmetic or bit-manipulation result, not an adder quirk.

**Class 2.** The Spec pins WHAT `accu` outputs, not the cycle on which `valid_out` rises. The testbench assumed one. Many events settle on the same clock edge, so an assumed cycle offset rejects a correct design.

**Class 3 - what was actually wrong.** `detectStandardBlocks` matched on Spec PROSE alone. RTLLM's `adder_16bit` description reads "Implement a module of a 16-bit full adder in combinational logic", so the keyword `full adder` matched and `known_answer_full_adder_truth_table` was emitted - a 1-bit truth table asserted over 16-bit ports. Driving `a=1, b=1, cin=0` on a 16-bit adder gives `0x0002`, so `Co=0`; the truth table demands `Co=1`. The check is unpassable by ANY 16-bit design.

The general failure is prose-only matching. A design is routinely described in terms of the primitive it is BUILT FROM, so the prose names the full adder while the interface declares 16-bit ports. The same shape would hit a "half adder chain" 8-bit adder, or a combinational "counter of set bits" getting a clocked increment sequence it has no clock to step.

# Fix / rule

Two prompt rules (`app/agent/roles/testbench/prompt.ts`) and one detection guard (`standard-blocks.ts`).

**Class 1 - `EXPECTED_VALUE_RULE`, unconditional.** COMPUTE each expected value in the testbench as a Verilog expression over the same stimulus driven (`expected_sum = a + b + cin;`) and compare against that; do NOT write in a constant worked out by hand while composing the testbench, because for any arithmetic or bit-manipulation result the check then tests that hand calculation.

**Class 2 - `describeTiming`, conditioned on the DECLARED interface**, the same shape as `describeStateAnchoring`. The Spec is the only source of latency, pipeline depth, and the valid cycle; where it states none, do not assume one. Then exactly one legal derivation is offered:

- the interface declares single-bit qualifier outputs (`valid` / `ready` / `done` / `ack` / `busy` / `complete`) - wait on those, and treat the qualifier as an OBSERVATION that gates the data check, never as an expected value to predict;
- it declares none - sample only where the Spec pins the moment down, never at a chosen cycle number.

The observation carve-out was NOT in the first attempt, and the second measurement is why it exists (below). It is also the one exception to Class 1: predicting a qualifier per cycle is how an unstated latency re-enters wearing the label "expected value".

**Class 3 - detection now takes TWO agreeing signals.** Every `StandardBlockReference` carries `assumesSingleBitDataPorts` and `assumesClockedSequence`, both REQUIRED on every entry (so a new dimension is a compile error, not a permissive default), and `detectStandardBlocks` requires a keyword match AND `interfaceJustifies`. Data ports are derived from the clocking contract (everything that is not the declared clock or reset), never guessed by name. A check the declared ports cannot justify is dropped, and criterion coverage stands on its own.

`buildTestbenchModelInput` still has no channel for RTL; Property 4 holds and now also asserts the new rules (the unconditional two, plus that exactly one timing derivation is offered - asserted WITHOUT re-deriving which, so the branch stays owned by the prompt).

## Measured before / after (3 problems, 1 arm, 1 sample - a data point, not a rate)

| problem     | campaign (before) | tbfix-verify (attempt 1) | tbfix-verify2 (attempt 2) |
| ----------- | ----------------- | ------------------------ | ------------------------- |
| accu        | invalid           | invalid                   | invalid                   |
| adder_16bit | invalid           | VALID, verified           | VALID, verified           |
| adder_32bit | invalid (3/3)     | VALID, verified           | VALID, verified           |

Instrument-valid went 0/3 -> 2/3. Class 1 and Class 3 are fixed on the evidence; both fixed samples also killed every mutant the golden judge kills (23/23 and 23/24, zero coverage gaps), so validity was NOT bought with permissiveness. The known-weak fixture testbenches still classify `invalid` under both controls on the real toolchain.

## Class 2 is NOT fixed, and its cause moved twice under the fix

Worth more than the two wins, because it says the class is layered. `accu` failed three times with three DIFFERENT shapes:

1. before - assumed the cycle `valid_out` rises (`valid_out not 1 after 4 inputs`);
2. after attempt 1 - stopped counting cycles and instead PREDICTED `valid_out` every cycle, off by exactly one, so every line read `expected 0, got 1` / `expected 1, got 0` alternating. Told not to count cycles, the model re-encoded the same assumed latency as an expected value. That is what the observation carve-out was added for, and it worked - the `valid_out mismatch` lines are gone;
3. after attempt 2 - `expected data_out=0a0, got 040`. `0xa0` is the sum of all four inputs, `0x40` is the LAST input alone, so the testbench is now reading a different accumulation WINDOW than the design filled. The residual is INPUT-side alignment: the Spec does not pin the edge on which `valid_in`/`data_in` are sampled, so which four inputs form a window is not stated, and the testbench picked one.

Stopped at two prompt iterations by instruction rather than tuning against `accu`.
On the last run the `accu` candidate had `golden=passed` while our testbench rejected both it and the reference, so this is unambiguously our instrument.

Next attempt should target input-side window alignment, not the output-side qualifier - and should be validated on a WIDER slice than three problems, because a per-problem fix loop is how a prompt gets overfitted to `accu`.

# Links

- app/agent/roles/testbench/prompt.ts (`EXPECTED_VALUE_RULE`, `describeTiming`, `timingQualifierNames`)
- app/agent/roles/testbench/standard-blocks.ts (`interfaceJustifies`, `dataPorts`, the two assumption fields)
- app/agent/roles/testbench/coverage.ts (`knownAnswerChecks`, which now documents the single owner of the rule)
- app/test/testbench-agent.test.ts, app/test/testbench-signalling-known-answer.test.ts, app/test/testbench-rtl-isolation.property.test.ts
- .eval-runs/stage1-screening/artifacts/kimi-k2_5/\*/sample-\*/control-stdout.txt (the three original causes)
- .eval-runs/tbfix-verify2/artifacts/kimi-k2_5/rtllm_arithmetic_accu/sample-0/control-stdout.txt (the residual)
- [[gotcha-generated-testbench-assumes-a-reset-that-does-not-exist]]
- [[decision-instrument-invalid-samples-leave-the-pass-at-k-denominator]]
- [[decision-instrument-validity-gate-is-zero-coverage-gaps-not-a-kill-rate]]
- product-ece/ECE-CONTEXT-ENGINEERING.md (prompt altitude, conditional rules over enumerated cases)
