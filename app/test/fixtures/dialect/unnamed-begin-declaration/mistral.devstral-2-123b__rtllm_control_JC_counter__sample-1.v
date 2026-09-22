`timescale 1ns/1ps

module tb;

  // Declare signals
  reg clk;
  reg rst_n;
  wire [63:0] Q;

  // Instantiate the design under test
  JC_counter dut (
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
    // Initialize signals
    rst_n = 0;
    #10;

    // Release reset
    rst_n = 1;
    #10;

    // Expected values for Johnson counter sequence
    reg [63:0] expected_Q;
    integer i;

    // Initial state after reset (all zeros)
    expected_Q = 64'b0;
    if (Q !== expected_Q) begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the FAIL: Initial state mismatch");
    end else begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the PASS");
    end

    // Check known answer sequence for 64-bit Johnson counter
    // The sequence follows the pattern: shift right with feedback from inverted LSB
    for (i = 0; i < 128; i = i + 1) begin
      #10;
      // Compute expected next state
      expected_Q = {expected_Q[62:0], ~expected_Q[0]};

      // Check current output
      if (Q !== expected_Q) begin
        $display("CHECK known_answer_counter_increments FAIL: Mismatch at cycle %0d", i);
        $display("Expected: %h", expected_Q);
        $display("Got:      %h", Q);
        $finish;
      end
    end

    // If we get here, all checks passed
    $display("CHECK known_answer_counter_increments PASS");
    $finish;
  end

  // Waveform dump
  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, tb);
  end

endmodule
