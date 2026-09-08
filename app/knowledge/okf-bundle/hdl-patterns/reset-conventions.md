---
type: pattern
title: Reset conventions (synchronous vs asynchronous)
tags: [hdl, verilog, reset, synchronous]
status: candidate
provenance: authored for the M1 OKF seed; standard Verilog idiom, not yet eval-gated in this vault
timestamp: 2026-07-05T00:00:00Z
verifiedBy:
---

# Pattern

The two standard reset styles for a synchronous register, and how to write each so simulation and synthesis agree.
This is a hint that improves the proposal; the oracle plus an independent testbench still decide correctness.

# When to use

Pick the style the Spec dictates and keep it consistent across the module.
Synchronous reset is the simple default for single-module FPGA designs and is easiest to verify; asynchronous reset is used when a register must clear regardless of the clock, but it needs a clean release to avoid metastability.

# Recipe / example

Synchronous, active-high reset (reset only takes effect on the active clock edge):

```verilog
always @(posedge clk) begin
  if (rst)
    q <= 1'b0;
  else
    q <= d;
end
```

Asynchronous, active-low reset (reset takes effect immediately, independent of the clock):

```verilog
always @(posedge clk or negedge rst_n) begin
  if (!rst_n)
    q <= 1'b0;
  else
    q <= d;
end
```

# Pitfalls

- Do not mix styles: an asynchronous-reset register must list the reset edge in its sensitivity list, and a synchronous one must not.
- State the polarity in the Spec and honor it; an active-low signal is conventionally named with a `_n` suffix (`rst_n`).
- Asynchronous reset release near a clock edge risks metastability; real hardware needs a reset synchronizer, though functional simulation of a single module does not model it.
- A testbench should always drive the reset sequence before the first functional check, so checks start from the defined reset state.

# Links

- Counter pattern: [[synchronous-counter]]
- FSM pattern: [[finite-state-machine]]
- Reset check in testbenches: [[boundary-and-known-answer-checks]]
