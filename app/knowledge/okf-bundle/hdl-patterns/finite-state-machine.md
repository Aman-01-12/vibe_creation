---
type: pattern
title: Finite state machine (two-block Moore FSM)
tags: [hdl, verilog, fsm, synchronous]
status: candidate
provenance: authored for the M1 OKF seed; standard Verilog idiom, not yet eval-gated in this vault
timestamp: 2026-07-05T00:00:00Z
verifiedBy:
---

# Pattern

A two-block Moore finite state machine: one clocked block holds the state register, one combinational block computes the next state and outputs.
This is a hint that improves the proposal; the oracle plus an independent testbench still decide correctness.

# When to use

Use for control logic with a small number of named states and well-defined transitions: protocol handshakes, sequence detectors, and multi-step controllers.
Prefer the two-block form because it keeps the sequential and combinational concerns separate, which is easier to read and to verify.

# Recipe / example

```verilog
module fsm (
  input  wire clk,
  input  wire rst,      // synchronous, active-high
  input  wire start,
  output reg  busy
);
  localparam [1:0] IDLE = 2'd0,
                   RUN  = 2'd1,
                   DONE = 2'd2;

  reg [1:0] state, next_state;

  // Sequential: state register only.
  always @(posedge clk) begin
    if (rst)
      state <= IDLE;
    else
      state <= next_state;
  end

  // Combinational: next state and outputs.
  always @(*) begin
    next_state = state;           // default: hold
    busy       = 1'b0;            // default output avoids latches
    case (state)
      IDLE: if (start) next_state = RUN;
      RUN:  begin busy = 1'b1; next_state = DONE; end
      DONE: next_state = IDLE;
      default: next_state = IDLE; // defined recovery from illegal state
    endcase
  end
endmodule
```

# Pitfalls

- Every signal assigned in the combinational block needs a default before the `case`, or the tool infers an unintended latch.
- Include a `default` branch so an illegal or `x` state recovers deterministically instead of locking up.
- Moore outputs depend only on state; if the Spec needs an output that reacts within the same cycle as an input, that is a Mealy output and must be stated as such.

# Links

- Reset conventions: [[reset-conventions]]
- Counter pattern: [[synchronous-counter]]
- FSM verification (boundary and known-answer): [[boundary-and-known-answer-checks]]
