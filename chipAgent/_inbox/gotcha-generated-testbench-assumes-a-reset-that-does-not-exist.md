---
type: gotcha
title: A generated testbench can assume a reset the interface never declared, and then fail the reference design
status: candidate
provenance: smoke-v2 sweep artifact (kimi-k2_5, rtllm/memory/right_shifter, sample-0) reproduced by hand with iverilog 13 + vvp
tags:
  [
    testbench,
    eval,
    pass-at-k,
    instrument-validity,
    rtllm,
    reset,
    icarus,
    defect-class,
    attribution,
  ]
timestamp: 2026-09-06
---

# What happened

The first real smoke sweep reported `pass@1 = 0.333` over three RTLLM designs.
On `rtllm/memory/right_shifter` our own spec-derived testbench rejected the candidate:

```
CHECK ac1_under_simulation_right_shifter_produces FAIL
ERROR at fill-1s step           0: expected q=10000000, got q=11010101
```

The independent golden judge PASSED the same candidate, so the sample was recorded as `over-strict`.
Chasing it as a model or prompt problem would have been wasted work.

Reproduced by hand against RTLLM's own human-verified reference design, with the top module renamed exactly as `importRtllmCorpus` renames it:

```
$ iverilog -g2012 -o a.out dut_reference.v tb.v && vvp a.out
CHECK ac1_under_simulation_right_shifter_produces FAIL
ERROR at fill-1s step           0: expected q=10000000, got q=11010101
```

Byte-identical against the reference AND against the model's candidate.
The testbench compiles and elaborates fine; it simply cannot be passed by anything.

# Root cause

The testbench runs several stimulus phases in one `initial` block.
Its "fill-1s" phase expects `q == 0` at the phase start and then predicts `q` from zero.

`right_shifter` declares only `clk`, `d`, and `q` - there is NO reset port.
The reference establishes zero with `initial q = 0;`, which is observable at time 0 and never again.
After the testbench's own earlier stimulus, `q` holds `11010101`, and nothing in the declared interface can return it to zero.

So the testbench invented a capability the interface does not have.
The generation side is not at fault: the candidate implements `q <= {d, q[7:1]}` correctly.

This is a DEFECT CLASS, not one bug. A phase-structured testbench that re-anchors its own expected value must either
(a) derive the expected value from the observed state at the phase boundary, or
(b) only re-anchor to a known state the declared interface can actually reach (a reset port, or time 0).
Anything else produces an instrument that fails every design, including the correct one.

# Fix / rule

Detection, not hand-inspection: RTLLM ships a known-good reference for every problem, so run the SAME generated testbench against the reference after the loop finishes.
A reference that fails our testbench proves the testbench is not a measuring stick.
That is the positive control in `app/eval/instrument-control.ts`; the sample is then excluded from the pass@k denominator and reported as `instrument-invalid` instead of as a model failure.

Two rules fell out of this:

- `over-strict` and `missed bugs` (the golden-judge agreement cells) are UNINTERPRETABLE until instrument validity is known. An `over-strict` sample whose instrument is invalid is our defect, not a disagreement worth chasing, so the summary counts it separately rather than blending it.
- The three non-pass causes must stay distinct: "our testbench REJECTED the reference" (an incorrect expectation, this case), "our testbench did not BUILD with the reference" (a structural mismatch), and "the control produced no verdict". `SimulationVerdict.verdict === 'error'` collapses the last two, so the cause is re-derived from the diagnostics - see [[gotcha-simulation-verdict-collapses-error-causes]].

The regression is pinned with the real artifact, not a hand-invented testbench: `app/test/fixtures/smoke-v2/right-shifter-testbench.v` is the file that actually produced the verdict, and `app/test/eval-instrument-control.integration.test.ts` requires it to classify `invalid` / `TESTBENCH_FAILED_REFERENCE` under real iverilog. The same suite requires a reset-free testbench over the same reference to classify `valid`, so an always-invalid control cannot pass it.

Open follow-up: this says nothing yet about HOW OFTEN the class occurs. One of three smoke problems is one data point, not a rate. The Testbench_Agent prompt is the place to fix the cause, and the control is what will measure whether the fix worked.

# Links

- app/eval/instrument-control.ts (the control port, the verdict union, THE pass@k denominator invariant)
- app/eval/corpus/rtllm-instrument-control.ts (the RTLLM-backed control over the loop's own IcarusSimulatorAdapter)
- app/eval/corpus/nonpass-cause.ts (the shared reported-failure / did-not-build / produced-nothing rule)
- app/test/eval-instrument-control.integration.test.ts (the real-toolchain regression)
- .eval-runs/smoke-v2-artifacts/artifacts/kimi-k2_5/rtllm_memory_right_shifter/sample-0/ (the original evidence)
- [[decision-instrument-invalid-samples-leave-the-pass-at-k-denominator]]
- [[decision-independent-golden-judge-and-vcs-icarus-gap]]
