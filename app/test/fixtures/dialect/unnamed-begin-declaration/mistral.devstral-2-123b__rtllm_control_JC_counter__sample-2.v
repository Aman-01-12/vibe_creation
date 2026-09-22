`timescale 1ns/1ps

module tb;
  reg clk;
  reg rst_n;
  wire [63:0] Q;

  // Instantiate the design
  JC_counter uut (
    .clk(clk),
    .rst_n(rst_n),
    .Q(Q)
  );

  // Clock generation
  initial begin
    clk = 0;
    forever #5 clk = ~clk;
  end

  // Test sequence
  initial begin
    // Initialize
    $dumpfile("dump.vcd");
    $dumpvars(0, tb);

    // Reset
    rst_n = 0;
    #10;
    rst_n = 1;

    // Expected values for 64-bit Johnson counter
    reg [63:0] expected_Q;
    integer i;

    // Initial state after reset
    expected_Q = 64'b0;

    // Check reset state
    #10;
    if (Q === expected_Q) begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the PASS");
    end else begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the FAIL: expected 64'b0, got %b", Q);
    end

    // Run through the Johnson counter sequence
    for (i = 0; i < 128; i = i + 1) begin
      #10;
      // Compute expected next state
      expected_Q = {expected_Q[62:0], ~expected_Q[63]};

      // Check current state
      if (Q === expected_Q) begin
        $display("CHECK known_answer_counter_increments PASS at step %d", i);
      end else begin
        $display("CHECK known_answer_counter_increments FAIL at step %d: expected %b, got %b", i, expected_Q, Q);
      end
    end

    // Final check
    #10;
    if (Q === 64'b0) begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the PASS (final state)");
    end else begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the FAIL (final state): expected 64'b0, got %b", Q);
    end

    $finish;
  end

endmodule
