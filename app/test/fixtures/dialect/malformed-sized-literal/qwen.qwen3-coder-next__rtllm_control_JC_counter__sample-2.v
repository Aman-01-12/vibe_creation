`timescale 1ns/1ps

module tb;
  // Clock and reset signals
  reg clk;
  reg rst_n;

  // DUT interface
  wire [64:0] Q;

  // Instantiate the device under test
  JC_counter #(
    .WIDTH(64)
  ) dut (
    .Q(Q),
    .clk(clk),
    .rst_n(rst_n)
  );

  // Clock generation: 10ns period (5ns high, 5ns low)
  initial begin
    clk = 0;
    forever #5 clk = ~clk;
  end

  // Stimulus and checks
  initial begin
    integer i;
    reg [64:0] expected_state;
    reg [64:0] observed_state;
    integer check_passed;

    // Initialize
    rst_n = 0;
    #10;

    // Assert reset for several cycles to ensure clean reset
    for (i = 0; i < 5; i = i + 1) begin
      @(posedge clk);
    end

    // Deassert reset
    rst_n = 1;
    @(posedge clk);

    // Expected Johnson counter sequence for 64-bit:
    // The pattern is: start with all zeros, then shift in 1s from the left,
    // then shift in 0s from the left (complement of the complemented bit fed back).
    // For a Johnson counter, the feedback is the complement of the MSB.
    // Sequence for 4-bit: 0000, 1000, 1100, 1110, 1111, 0111, 0011, 0001, 0000
    // So for 64-bit:
    //   Cycle 0: 64'b0000...0000
    //   Cycle 1: 64'b1000...0000
    //   Cycle 2: 64'b1100...0000
    //   ...
    //   Cycle 63: 64'b1111...1110
    //   Cycle 64: 64'b1111...1111
    //   Cycle 65: 64'b0111...1111
    //   ...
    //   Cycle 126: 64'b0000...0001
    //   Cycle 127: 64'b0000...0000 (wrap)

    // Precompute expected states for first 128 cycles (full period)
    // expected_state = (cycle < 65) ? ({65{1'b1}} << (64 - cycle)) : ({65{1'b0}} >> (cycle - 64));
    // But we compute it step-by-step in the test to avoid hand-calculation errors.

    // Check AC1: Under simulation, JC_counter produces the behaviour the design requires
    // We verify the first 128 states (full period) and wrap-around

    // Start at cycle 0 (after reset deassertion on posedge, state updates on next posedge)
    // So first observed state is at cycle 0 (after 1st posedge after rst_n=1)

    // Expected state at cycle 0: all zeros
    expected_state = 65'b0;
    @(posedge clk);
    observed_state = Q;
    if (observed_state === expected_state) begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the PASS");
    end else begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the FAIL: expected %b, got %b", expected_state, observed_state);
    end

    // Now run through the full sequence and verify each state
    check_passed = 1;
    for (i = 1; i < 128; i = i + 1) begin
      // Compute expected state for cycle i
      if (i <= 64) begin
        // First half: i ones from MSB down
        // For i=1: 1000...0 (64 zeros after 1) -> 65'b1000...0
        // For i=64: 64 ones then 0 -> 65'b111...10
        expected_state = ({65{1'b1}} << (64 - i)) & ~({65{1'b1}} << 65);
      end else begin
        // Second half: (128 - i) zeros from LSB up, rest ones
        // i=65: 0111...1 (64 ones after 0) -> 65'b0111...1
        // i=127: 000...01 -> 65'b000...1
        expected_state = ({65{1'b0}} >> (i - 64)) | ({65{1'b1}} << (128 - i));
      end

      // Wait for next clock edge and sample
      @(posedge clk);
      observed_state = Q;

      if (observed_state !== expected_state) begin
        check_passed = 0;
        $display("CHECK ac1_under_simulation_jc_counter_produces_the FAIL: cycle %0d, expected %b, got %b", i, expected_state, observed_state);
      end
    end

    // Final wrap-around check: cycle 128 should be back to all zeros
    expected_state = 65'b0;
    @(posedge clk);
    observed_state = Q;
    if (observed_state === expected_state) begin
      if (check_passed) begin
        $display("CHECK ac1_under_simulation_jc_counter_produces_the PASS");
      end
    end else begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the FAIL: wrap-around, expected %b, got %b", expected_state, observed_state);
    end

    // Known answer check: counter increments and wraps at modulus
    // We verify that the counter increments correctly and wraps from all-ones to next state
    // The modulus is 128 (2 * 64)

    // Reset and re-run to verify increment behavior
    rst_n = 0;
    @(posedge clk);
    rst_n = 1;
    @(posedge clk);

    // Sample state at cycle 0
    observed_state = Q;
    expected_state = 65'b0;
    if (observed_state !== expected_state) begin
      $display("CHECK known_answer_counter_increments FAIL: initial state, expected %b, got %b", expected_state, observed_state);
    end else begin
      // Now verify increment sequence for first few cycles
      for (i = 1; i <= 5; i = i + 1) begin
        @(posedge clk);
        observed_state = Q;
        // Expected: i ones followed by (64-i) zeros
        expected_state = ({65{1'b1}} << (64 - i)) & ~({65{1'b1}} << 65);
        if (observed_state !== expected_state) begin
          $display("CHECK known_answer_counter_increments FAIL: cycle %0d, expected %b, got %b", i, expected_state, observed_state);
        end
      end

      // Verify wrap-around: go to cycle 64 (all ones)
      for (i = 6; i <= 64; i = i + 1) begin
        @(posedge clk);
      end
      observed_state = Q;
      expected_state = {65{1'b1}};
      if (observed_state !== expected_state) begin
        $display("CHECK known_answer_counter_increments FAIL: all-ones state, expected %b, got %b", expected_state, observed_state);
      end else begin
        // Next cycle should be 0111...1
        @(posedge clk);
        observed_state = Q;
        expected_state = {1'b0, 64{1'b1}};
        if (observed_state !== expected_state) begin
          $display("CHECK known_answer_counter_increments FAIL: after all-ones, expected %b, got %b", expected_state, observed_state);
        end else begin
          $display("CHECK known_answer_counter_increments PASS");
        end
      end
    end

    $finish;
  end

  // VCD dump
  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, tb);
  end
endmodule
