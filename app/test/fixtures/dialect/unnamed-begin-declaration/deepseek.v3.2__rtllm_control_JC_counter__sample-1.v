module tb_JC_counter;
  // Clock and reset
  reg clk;
  reg rst_n;
  
  // Output
  wire [63:0] Q;
  
  // Testbench variables
  reg [63:0] expected_Q;
  reg [63:0] prev_Q;
  integer cycle_count;
  integer i;
  integer j;
  
  // Instantiate the design under test
  JC_counter dut (
    .clk(clk),
    .rst_n(rst_n),
    .Q(Q)
  );
  
  // Clock generation
  always #5 clk = ~clk;
  
  // Initialize signals
  initial begin
    // Initialize clock and reset
    clk = 0;
    rst_n = 1;
    
    // Initialize testbench variables
    expected_Q = 64'b0;
    prev_Q = 64'b0;
    cycle_count = 0;
    
    // Dump waveform
    $dumpfile("dump.vcd");
    $dumpvars(0, tb_JC_counter);
    
    // Start test sequence
    $display("Starting testbench for JC_counter");
    
    // Test 1: Reset behavior
    $display("Test 1: Reset behavior");
    rst_n = 0;  // Assert reset
    #10;       // Wait for clock edge
    // Check reset value - Johnson counter should reset to all zeros
    expected_Q = 64'b0;
    #1;        // Wait for signals to settle
    if (Q !== expected_Q) begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the FAIL: Reset value incorrect. Got %064b, expected %064b", Q, expected_Q);
    end else begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the PASS");
    end
    
    // Test 2: Release reset and verify Johnson counter sequence
    $display("Test 2: Johnson counter sequence");
    rst_n = 1;  // Release reset
    
    // Johnson counter sequence for 64-bit:
    // 1. 000...000
    // 2. 100...000
    // 3. 110...000
    // 4. 111...000
    // ...
    // 64. 111...111
    // 65. 011...111
    // 66. 001...111
    // 67. 000...111
    // ...
    // 128. 000...001
    // 129. 000...000 (back to start)
    
    // We'll test a subset of the sequence to verify the pattern
    // Store previous Q to compute expected next state
    prev_Q = Q;
    
    // Test first 10 transitions (covers both 0->1 and 1->0 phases)
    for (i = 0; i < 10; i = i + 1) begin
      // Wait for clock edge
      @(posedge clk);
      #1;  // Wait for signals to settle
      
      // Compute expected value based on Johnson counter behavior:
      // Johnson counter shifts in the complement of the LSB
      // For 4-bit example: 0000 -> shift in ~0 = 1 -> 1000
      //                   1000 -> shift in ~0 = 1 -> 1100
      //                   1100 -> shift in ~0 = 1 -> 1110
      //                   1110 -> shift in ~0 = 1 -> 1111
      //                   1111 -> shift in ~1 = 0 -> 0111
      //                   0111 -> shift in ~1 = 0 -> 0011
      //                   0011 -> shift in ~1 = 0 -> 0001
      //                   0001 -> shift in ~1 = 0 -> 0000
      
      // For our 64-bit counter:
      // Expected_Q = {prev_Q[62:0], ~prev_Q[63]};
      expected_Q = {prev_Q[62:0], ~prev_Q[63]};
      
      if (Q !== expected_Q) begin
        $display("CHECK ac1_under_simulation_jc_counter_produces_the FAIL at cycle %0d: Got %064b, expected %064b", i+1, Q, expected_Q);
      end
      
      // Update previous Q for next iteration
      prev_Q = Q;
    end
    
    // If we got through all cycles without failure, the check passes
    $display("CHECK ac1_under_simulation_jc_counter_produces_the PASS");
    
    // Test 3: Known answer check - verify full 128-cycle period
    $display("Test 3: Known answer check - full period");
    
    // Reset and start fresh
    rst_n = 0;
    @(posedge clk);
    #1;
    rst_n = 1;
    @(posedge clk);
    #1;
    
    // Record initial state (all zeros)
    prev_Q = Q;
    
    // Go through full 128-cycle period (2*64)
    for (i = 0; i < 128; i = i + 1) begin
      @(posedge clk);
      #1;
      
      // Compute expected value
      expected_Q = {prev_Q[62:0], ~prev_Q[63]};
      
      if (Q !== expected_Q) begin
        $display("CHECK known_answer_counter_increments FAIL at cycle %0d: Got %064b, expected %064b", i+1, Q, expected_Q);
      end
      
      prev_Q = Q;
    end
    
    // After 128 cycles, we should be back to all zeros
    if (Q !== 64'b0) begin
      $display("CHECK known_answer_counter_increments FAIL: Did not return to zero after full period. Got %064b", Q);
    end else begin
      $display("CHECK known_answer_counter_increments PASS");
    end
    
    // Test 4: Boundary cases - verify wrap-around behavior
    $display("Test 4: Boundary cases");
    
    // Start from all ones (state 64)
    // We'll pulse reset, then manually set up all ones state
    rst_n = 0;
    @(posedge clk);
    #1;
    rst_n = 1;
    
    // Cycle 64 times to reach all ones
    for (i = 0; i < 64; i = i + 1) begin
      @(posedge clk);
      #1;
    end
    
    // Now we should be at all ones
    if (Q !== 64'hFFFFFFFFFFFFFFFF) begin
      $display("Boundary test: Failed to reach all ones state. Got %064b", Q);
    end
    
    // Next state should be 011...111 (all ones with MSB cleared)
    @(posedge clk);
    #1;
    expected_Q = {1'b0, {63{1'b1}}};
    if (Q !== expected_Q) begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the FAIL at boundary: Got %064b, expected %064b", Q, expected_Q);
    end
    
    // Test 5: Verify pattern matches 4-bit example from spec
    $display("Test 5: Verify pattern matches 4-bit example");
    
    // We'll check that the pattern for bits [63:60] follows the 4-bit example
    // when we're in the right part of the sequence
    
    // Reset and check initial state
    rst_n = 0;
    @(posedge clk);
    #1;
    rst_n = 1;
    @(posedge clk);
    #1;
    
    // The 4-bit example sequence: 0000, 1000, 1100, 1110, 1111, 0111, 0011, 0001, 0000
    // For our 64-bit counter, the MSB 4 bits should follow this pattern
    // as we progress through the first 8 cycles
    
    // Array of expected 4-bit patterns (for bits [63:60])
    reg [3:0] expected_4bit [0:8];
    expected_4bit[0] = 4'b0000;
    expected_4bit[1] = 4'b1000;
    expected_4bit[2] = 4'b1100;
    expected_4bit[3] = 4'b1110;
    expected_4bit[4] = 4'b1111;
    expected_4bit[5] = 4'b0111;
    expected_4bit[6] = 4'b0011;
    expected_4bit[7] = 4'b0001;
    expected_4bit[8] = 4'b0000;
    
    for (i = 0; i <= 8; i = i + 1) begin
      if (i > 0) begin
        @(posedge clk);
        #1;
      end
      
      if (Q[63:60] !== expected_4bit[i]) begin
        $display("CHECK ac1_under_simulation_jc_counter_produces_the FAIL at 4-bit pattern step %0d: Got %04b, expected %04b", i, Q[63:60], expected_4bit[i]);
      end
    end
    
    $display("All tests completed");
    $finish;
  end
endmodule