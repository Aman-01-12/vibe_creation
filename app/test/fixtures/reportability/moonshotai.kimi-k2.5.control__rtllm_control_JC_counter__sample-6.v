module tb;
  // Clock and reset
  reg clk;
  reg rst_n;
  
  // DUT outputs
  wire [63:0] Q;
  
  // Testbench variables
  reg [63:0] expected_Q;
  reg [63:0] prev_Q;
  integer i;
  integer cycle_count;
  reg [63:0] initial_state;
  reg check_passed;
  
  // Instantiate DUT
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
  
  // Main test sequence
  initial begin
    begin end
    begin end
    
    // Initialize
    rst_n = 0;
    expected_Q = 64'd0;
    prev_Q = 64'd0;
    cycle_count = 0;
    check_passed = 1;
    
    // Wait for reset to propagate
    @(negedge clk);
    @(negedge clk);
    
    // Release reset
    rst_n = 1;
    
    // Check reset value - should be 0
    @(negedge clk);
    if (Q !== 64'd0) begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the FAIL: reset value expected 64'h0, got %h", Q);
      check_passed = 0;
    end
    
    // Capture initial state after reset
    initial_state = Q;
    prev_Q = Q;
    
    // Run through full Johnson counter cycle (128 states for 64-bit)
    // Check that the Johnson counter follows the correct pattern
    // Pattern: shift left, insert inverted MSB at LSB
    for (i = 0; i < 130; i = i + 1) begin
      @(negedge clk);
      
      // Compute expected next state: {~Q[63], Q[63:1]}
      expected_Q = {~prev_Q[63], prev_Q[63:1]};
      
      if (Q !== expected_Q) begin
        $display("CHECK ac1_under_simulation_jc_counter_produces_the FAIL: cycle %d expected %h, got %h", i, expected_Q, Q);
        check_passed = 0;
      end
      
      prev_Q = Q;
      cycle_count = cycle_count + 1;
      
      // Check wrap-around after 128 cycles
      if (i == 127) begin
        if (Q !== initial_state) begin
          $display("CHECK known_answer_counter_increments FAIL: wrap-around failed, expected %h, got %h", initial_state, Q);
          check_passed = 0;
        end
      end
    end
    
    if (check_passed) begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the PASS");
      $display("CHECK known_answer_counter_increments PASS");
    end else begin
      // Already printed FAIL messages above
    end
    
    // Additional boundary checks: verify specific bit patterns
    // Test that we can observe the pattern from the 4-bit example scaled to 64-bit
    // After 0 cycles:  0000...0000
    // After 1 cycle:  1000...0000
    // After 2 cycles: 1100...0000
    // etc.
    
    // Reset and verify specific known states
    rst_n = 0;
    @(negedge clk);
    @(negedge clk);
    rst_n = 1;
    @(negedge clk);
    
    // State 0: all zeros
    if (Q !== 64'h0000000000000000) begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the FAIL: state 0 mismatch");
    end
    
    @(negedge clk);
    // State 1: MSB set
    if (Q !== 64'h8000000000000000) begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the FAIL: state 1 mismatch, expected 64'h8000000000000000, got %h", Q);
    end
    
    @(negedge clk);
    // State 2: top two bits set
    if (Q !== 64'hC000000000000000) begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the FAIL: state 2 mismatch, expected 64'hC000000000000000, got %h", Q);
    end
    
    @(negedge clk);
    // State 3: top three bits set
    if (Q !== 64'hE000000000000000) begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the FAIL: state 3 mismatch, expected 64'hE000000000000000, got %h", Q);
    end
    
    @(negedge clk);
    // State 4: top four bits set
    if (Q !== 64'hF000000000000000) begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the FAIL: state 4 mismatch, expected 64'hF000000000000000, got %h", Q);
    end
    
    // Continue to all-ones state (64 cycles)
    for (i = 5; i < 64; i = i + 1) begin
      @(negedge clk);
    end
    
    // State 64: all ones
    if (Q !== 64'hFFFFFFFFFFFFFFFF) begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the FAIL: all-ones state mismatch, expected 64'hFFFFFFFFFFFFFFFF, got %h", Q);
    end
    
    @(negedge clk);
    // State 65: MSB clear, rest ones (0111...)
    if (Q !== 64'h7FFFFFFFFFFFFFFF) begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the FAIL: state 65 mismatch, expected 64'h7FFFFFFFFFFFFFFF, got %h", Q);
    end
    
    @(negedge clk);
    // State 66: top two bits clear, rest ones
    if (Q !== 64'h3FFFFFFFFFFFFFFF) begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the FAIL: state 66 mismatch, expected 64'h3FFFFFFFFFFFFFFF, got %h", Q);
    end
    
    // Verify wrap-around: after 128 cycles from reset, should return to 0
    rst_n = 0;
    @(negedge clk);
    @(negedge clk);
    rst_n = 1;
    @(negedge clk);
    
    // Run 128 cycles
    for (i = 0; i < 128; i = i + 1) begin
      @(negedge clk);
    end
    
    // Should be back to initial state
    if (Q !== 64'h0000000000000000) begin
      $display("CHECK known_answer_counter_increments FAIL: after 128 cycles expected 64'h0, got %h", Q);
    end else begin
      $display("CHECK known_answer_counter_increments PASS");
    end
    
    // Final verification of Johnson counter property: adjacent states differ by one bit shift
    rst_n = 0;
    @(negedge clk);
    @(negedge clk);
    rst_n = 1;
    @(negedge clk);
    
    check_passed = 1;
    for (i = 0; i < 128; i = i + 1) begin
      prev_Q = Q;
      @(negedge clk);
      
      // Verify Johnson counter transition: Q = {~prev_Q[63], prev_Q[63:1]}
      expected_Q = {~prev_Q[63], prev_Q[63:1]};
      if (Q !== expected_Q) begin
        $display("CHECK ac1_under_simulation_jc_counter_produces_the FAIL: transition %d failed", i);
        check_passed = 0;
      end
    end
    
    if (check_passed) begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the PASS");
    end
    
    $finish;
  end
endmodule
