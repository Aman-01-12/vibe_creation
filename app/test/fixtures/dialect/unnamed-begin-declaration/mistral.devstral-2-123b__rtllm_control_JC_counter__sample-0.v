`timescale 1ns/1ps

module tb;
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
    expected_Q = 64'h0000000000000000;
    if (Q !== expected_Q) begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the FAIL: Initial state mismatch");
    end else begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the PASS");
    end

    // Check known answer sequence (first 9 states of 64-bit Johnson counter)
    // The pattern follows: 000...0, 100...0, 110...0, ..., 000...1, 000...0
    for (i = 0; i < 9; i = i + 1) begin
      #10;  // Wait for next clock edge
      
      // Compute expected value based on Johnson counter pattern
      if (i == 0) begin
        expected_Q = 64'h0000000000000000;  // All zeros
      end else if (i == 1) begin
        expected_Q = 64'h8000000000000000;  // 1 followed by 63 zeros
      end else if (i == 2) begin
        expected_Q = 64'hC000000000000000;  // 11 followed by 62 zeros
      end else if (i == 3) begin
        expected_Q = 64'hE000000000000000;  // 111 followed by 61 zeros
      end else if (i == 4) begin
        expected_Q = 64'hF000000000000000;  // 1111 followed by 60 zeros
      end else if (i == 5) begin
        expected_Q = 64'hF800000000000000;  // 01111 followed by 59 zeros
      end else if (i == 6) begin
        expected_Q = 64'hFC00000000000000;  // 001111 followed by 58 zeros
      end else if (i == 7) begin
        expected_Q = 64'hFE00000000000000;  // 0001111 followed by 57 zeros
      end else if (i == 8) begin
        expected_Q = 64'hFF00000000000000;  // 00001111 followed by 56 zeros
      end

      if (Q !== expected_Q) begin
        $display("CHECK known_answer_counter_increments FAIL: Step %0d expected %h got %h", i, expected_Q, Q);
      end
    end

    // Final check after full cycle (should return to all zeros)
    #10;
    expected_Q = 64'h0000000000000000;
    if (Q !== expected_Q) begin
      $display("CHECK known_answer_counter_increments FAIL: Final state mismatch");
    end else begin
      $display("CHECK known_answer_counter_increments PASS");
    end

    // Finish simulation
    #10;
    $finish;
  end

  // Waveform dump
  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, tb);
  end

endmodule
