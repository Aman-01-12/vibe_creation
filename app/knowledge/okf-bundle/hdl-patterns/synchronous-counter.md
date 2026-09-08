---
type: pattern
title: Synchronous counter (up, with reset and enable)
tags: [hdl, verilog, counter, synchronous]
status: candidate
provenance: authored for the M1 OKF seed; standard Verilog idiom, not yet eval-gated in this vault
timestamp: 2026-07-05T00:00:00Z
verifiedBy:
---

# Pattern

A width-parameterized synchronous up-counter that increments on the active clock edge, holds when disabled, and returns to zero on reset.
This is a hint that improves the proposal; the oracle plus an independent testbench still decide correctness.

# When to use

Use for any design that counts clock events or maintains a monotonic index: timers, address generators, dividers, and the count portion of a larger datapath.
Prefer this synchronous form over gated clocks or combinational feedback, which cause glitches and are hard to verify.

# Recipe / example

```verilog
module counter #(
  parameter WIDTH = 8
) (
  input  wire              clk,
  input  wire              rst,     // synchronous, active-high
  input  wire              en,
  output reg  [WIDTH-1:0]  count
);
  always @(posedge clk) begin
    if (rst)
      count <= {WIDTH{1'b0}};
    else if (en)
      count <= count + 1'b1;
  end
endmodule
```

Behavior contract:

- On the active clock edge, reset takes priority over enable.
- When enabled and not reset, `count` increments by one.
- When disabled and not reset, `count` holds its value.
- At the maximum value `2**WIDTH - 1`, the next enabled increment wraps to zero.

# Pitfalls

- Wrap at the maximum value is a required boundary check, not an error; the Spec should say whether wrap or saturation is intended.
- Mixing blocking (`=`) and non-blocking (`<=`) assignments to the same sequential register causes simulation/synthesis mismatch; use non-blocking in clocked blocks.
- Match the reset style (synchronous vs asynchronous) to the Spec; see [[reset-conventions]].

# Links

- Reset conventions: [[reset-conventions]]
- Boundary and known-answer checks: [[boundary-and-known-answer-checks]]
- FSM pattern: [[finite-state-machine]]
