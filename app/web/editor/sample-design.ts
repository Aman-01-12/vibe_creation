// The hardcoded skeleton sample: a small counter and its matching testbench
// (Design: End-to-end hero loop, skeleton subset; Req 1.4).
//
// The M0 Editor skeleton submits this fixed pair to the API_Gateway to prove the
// Editor -> gateway -> Orchestrator -> sandbox oracle path end to end, before any
// agentic generation exists. It is typed as `SkeletonSimulationInput` so the
// sample cannot drift from the gateway's validated wire contract (OD-7). The
// testbench does not need the Simulator's CHECK-line signalling here - the
// gateway and Orchestrator own verdict interpretation - but it is a realistic,
// self-checking bench so the oracle path is exercised meaningfully.

import type { SkeletonSimulationInput } from '@app/api';

/** A synchronous 4-bit up counter with active-low reset. */
const COUNTER_RTL = `module counter #(
  parameter WIDTH = 4
) (
  input  wire             clk,
  input  wire             rst_n,
  output reg  [WIDTH-1:0] count
);
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      count <= {WIDTH{1'b0}};
    end else begin
      count <= count + 1'b1;
    end
  end
endmodule
`;

/** A self-checking bench: reset, then confirm the counter increments each clock. */
const COUNTER_TESTBENCH = `\`timescale 1ns / 1ps
module counter_tb;
  localparam WIDTH = 4;
  reg              clk;
  reg              rst_n;
  wire [WIDTH-1:0] count;

  counter #(.WIDTH(WIDTH)) dut (.clk(clk), .rst_n(rst_n), .count(count));

  initial clk = 1'b0;
  always #5 clk = ~clk;

  integer expected;
  initial begin
    rst_n    = 1'b0;
    expected = 0;
    @(negedge clk);
    rst_n = 1'b1;
    if (count !== 0) $display("FAIL: reset did not clear count");

    repeat (WIDTH * 2) begin
      @(posedge clk);
      #1;
      expected = (expected + 1) % (1 << WIDTH);
      if (count !== expected[WIDTH-1:0]) begin
        $display("FAIL: expected %0d got %0d", expected, count);
      end
    end
    $display("counter_tb complete");
    $finish;
  end
endmodule
`;

/**
 * The fixed Verilog module + testbench the skeleton Editor submits.
 *
 * Frozen so no caller can mutate the shared sample between runs.
 */
export const SAMPLE_SKELETON_SIMULATION: SkeletonSimulationInput = Object.freeze({
  rtl: COUNTER_RTL,
  testbench: COUNTER_TESTBENCH,
});
