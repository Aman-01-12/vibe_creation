---
type: verification-recipe
title: Self-checking spec-derived testbench structure
tags: [verification, testbench, hdl, icarus]
status: candidate
provenance: authored for the M1 OKF seed; standard Verilog verification practice, not yet eval-gated in this vault
timestamp: 2026-07-05T00:00:00Z
verifiedBy:
---

# What this verifies

This recipe describes how to structure a self-checking testbench for a single synchronous module, so that the run decides each acceptance criterion on its own without a human reading the waveform.
It is a hint for the Testbench_Agent, not authority: the deterministic oracle and the pass-integrity rule still decide correctness.

The one part of testbench authoring that is authority is the per-check line format, which lives in [[check-line-signalling]].

# Independent oracle (never the model)

Correctness is decided by the Simulator plus the independently derived checks, never by model output and never by the testbench "agreeing with itself".
Every expected value is computed from the Spec and intent, not read back from the design under test.

# Steps

1. Instantiate the DUT against the exact Module_Interface from the Spec (same port names, directions, and widths).
2. Generate a free-running clock, for example a fixed half-period toggle, when the module is synchronous.
3. Apply the reset sequence the Spec defines before asserting any functional check, so checks start from a known state.
4. For each acceptance criterion, drive stimulus, wait the defined number of clock edges, sample the output, and compare against the independently computed expected value.
5. Emit one `CHECK <name> PASS|FAIL` line per criterion per [[check-line-signalling]], then `$finish`.
6. Include a watchdog (a bounded time limit that calls `$finish`) so a hung design ends the run instead of relying only on the sandbox wall-clock cap.

Skeleton:

```verilog
`timescale 1ns/1ps
module tb;
  reg clk = 0;
  always #5 clk = ~clk;   // 100 MHz-ish, timing is arbitrary for functional checks

  // DUT ports declared from the Spec Module_Interface only.
  // ... instantiate dut ...

  initial begin
    // reset sequence from the Spec
    // per-criterion stimulus + compare + CHECK line
    $finish;
  end

  initial begin
    #100000 $display("CHECK watchdog FAIL");  // bounded safety net
    $finish;
  end
endmodule
```

# Anti-circularity note

The testbench is generated from the Spec and intent only and never receives the RTL under test (Req 7.1, 7.2).
Assemble its model context from the Spec, the intent, and OKF retrieval, with no field that can carry RTL and no shared mutable context with the Generation_Agent.

# Pitfalls

- Sampling combinational output on the same edge that changes it can read a stale or racing value; sample after the settling edge the Spec implies.
- A testbench that never prints a `CHECK` line makes the whole run `error`, not a pass; always emit at least one check.
- Comparing with `==` instead of `===` hides `x`/`z` bugs, because `==` returns `x` when either operand has unknown bits.

# Links

- Per-check signalling contract (authority): [[check-line-signalling]]
- Boundary and known-answer checks: [[boundary-and-known-answer-checks]]
- Reset conventions: [[reset-conventions]]
- Canonical method: `product-ece/ECE-VERIFICATION-METHODOLOGY.md`
