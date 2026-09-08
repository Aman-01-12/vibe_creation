module tb;
  reg clk;
  reg d;
  wire [7:0] q;
  
  // Instantiate the DUT
  right_shifter dut (
    .clk(clk),
    .d(d),
    .q(q)
  );
  
  // Clock generation: 10ns period
  initial begin
    clk = 0;
    forever #5 clk = ~clk;
  end
  
  // Test stimulus and checking
  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, tb);
    
    // Initialize
    d = 0;
    
    // Wait for first clock edge to see initial state
    @(posedge clk);
    #1; // Small delay to observe output
    
    // Check initial state: q should be 0 after initialization
    // The spec says "initializing the q register to 0"
    // After first posedge, q should still be 0 (initialized value)
    
    // Test case 1: Shift in 1s
    // Expected behavior: on each rising edge, q shifts right and d goes to MSB
    // Starting from 0, shift in 1s
    d = 1;
    @(posedge clk); #1;
    // After 1st shift with d=1: q should be 8'b1000_0000 = 128
    
    @(posedge clk); #1;
    // After 2nd shift with d=1: q should be 8'b1100_0000 = 192
    
    @(posedge clk); #1;
    // After 3rd shift with d=1: q should be 8'b1110_0000 = 224
    
    @(posedge clk); #1;
    // After 4th shift with d=1: q should be 8'b1111_0000 = 240
    
    @(posedge clk); #1;
    // After 5th shift with d=1: q should be 8'b1111_1000 = 248
    
    @(posedge clk); #1;
    // After 6th shift with d=1: q should be 8'b1111_1100 = 252
    
    @(posedge clk); #1;
    // After 7th shift with d=1: q should be 8'b1111_1110 = 254
    
    @(posedge clk); #1;
    // After 8th shift with d=1: q should be 8'b1111_1111 = 255
    
    // Now shift in 0s
    d = 0;
    @(posedge clk); #1;
    // After shift with d=0: q should be 8'b0111_1111 = 127
    
    @(posedge clk); #1;
    // After shift with d=0: q should be 8'b0011_1111 = 63
    
    @(posedge clk); #1;
    // After shift with d=0: q should be 8'b0001_1111 = 31
    
    @(posedge clk); #1;
    // After shift with d=0: q should be 8'b0000_1111 = 15
    
    @(posedge clk); #1;
    // After shift with d=0: q should be 8'b0000_0111 = 7
    
    @(posedge clk); #1;
    // After shift with d=0: q should be 8'b0000_0011 = 3
    
    @(posedge clk); #1;
    // After shift with d=0: q should be 8'b0000_0001 = 1
    
    @(posedge clk); #1;
    // After shift with d=0: q should be 8'b0000_0000 = 0
    
    // Run comprehensive check
    // Reset simulation and run known-answer test
    $display("Starting comprehensive right shifter test");
    
    // Re-initialize for clean test
    // Since there's no reset, we need to run through enough cycles to establish known state
    
    // Test: Verify the shifter behavior matches spec
    // The spec requires: 8-bit right shift, initialized to 0
    // On each rising edge: shift right, insert d into MSB (bit 7)
    
    // Known answer test: Pattern 10101010
    // Start from 0, apply pattern
    
    // First, let's verify with a clean simulation by checking behavior
    // We'll check that the shifter produces correct output for a known sequence
    
    // Apply test pattern: 1, 0, 1, 0, 1, 0, 1, 0 (MSB first)
    // Expected results after each clock:
    // Initial: 00000000
    // After d=1: 10000000 (128)
    // After d=0: 01000000 (64)
    // After d=1: 10100000 (160)
    // After d=0: 01010000 (80)
    // After d=1: 10101000 (168)
    // After d=0: 01010100 (84)
    // After d=1: 10101010 (170)
    // After d=0: 01010101 (85)
    
    // Run the verification
    verify_shifter();
    
    $finish;
  end
  
  // Task to verify shifter behavior
  task verify_shifter;
    reg [7:0] expected_q;
    reg [7:0] actual_q;
    integer i;
    reg [7:0] test_pattern;
    begin
      test_pattern = 8'b10101010;
      expected_q = 8'b00000000;
      
      // First, ensure we're at a known state by running 8 cycles with d=0
      // This should clear any state to 0
      d = 0;
      for (i = 0; i < 8; i = i + 1) begin
        @(posedge clk);
      end
      #1;
      
      // Now verify we're at 0
      if (q !== 8'b00000000) begin
        $display("CHECK ac1_under_simulation_right_shifter_produces FAIL");
        $display("ERROR: Initial state not zero, q=%b", q);
      end
      
      // Apply test pattern and verify each step
      for (i = 7; i >= 0; i = i - 1) begin
        d = test_pattern[i];
        @(posedge clk);
        #1;
        
        // Compute expected: shift right, insert d at MSB
        expected_q = {d, expected_q[7:1]};
        actual_q = q;
        
        if (actual_q !== expected_q) begin
          $display("CHECK ac1_under_simulation_right_shifter_produces FAIL");
          $display("ERROR at step %d: expected q=%b, got q=%b", i, expected_q, actual_q);
          $finish;
        end
      end
      
      // Also test with all 1s pattern
      test_pattern = 8'b11111111;
      expected_q = actual_q; // Continue from current state
      
      for (i = 7; i >= 0; i = i - 1) begin
        d = test_pattern[i];
        @(posedge clk);
        #1;
        
        expected_q = {d, expected_q[7:1]};
        actual_q = q;
        
        if (actual_q !== expected_q) begin
          $display("CHECK ac1_under_simulation_right_shifter_produces FAIL");
          $display("ERROR at all-1s step %d: expected q=%b, got q=%b", i, expected_q, actual_q);
          $finish;
        end
      end
      
      // Test with all 0s pattern
      test_pattern = 8'b00000000;
      expected_q = actual_q;
      
      for (i = 7; i >= 0; i = i - 1) begin
        d = test_pattern[i];
        @(posedge clk);
        #1;
        
        expected_q = {d, expected_q[7:1]};
        actual_q = q;
        
        if (actual_q !== expected_q) begin
          $display("CHECK ac1_under_simulation_right_shifter_produces FAIL");
          $display("ERROR at all-0s step %d: expected q=%b, got q=%b", i, expected_q, actual_q);
          $finish;
        end
      end
      
      // Test alternating pattern starting with 0
      test_pattern = 8'b01010101;
      expected_q = actual_q;
      
      for (i = 7; i >= 0; i = i - 1) begin
        d = test_pattern[i];
        @(posedge clk);
        #1;
        
        expected_q = {d, expected_q[7:1]};
        actual_q = q;
        
        if (actual_q !== expected_q) begin
          $display("CHECK ac1_under_simulation_right_shifter_produces FAIL");
          $display("ERROR at alt-0s step %d: expected q=%b, got q=%b", i, expected_q, actual_q);
          $finish;
        end
      end
      
      // Boundary test: single bit walk
      // Test that each bit position can be set and shifted through
      expected_q = 8'b00000000;
      
      // Set d=1 for 8 cycles to fill with 1s
      d = 1;
      for (i = 0; i < 8; i = i + 1) begin
        @(posedge clk);
        #1;
        expected_q = {1'b1, expected_q[7:1]};
        if (q !== expected_q) begin
          $display("CHECK ac1_under_simulation_right_shifter_produces FAIL");
          $display("ERROR at fill-1s step %d: expected q=%b, got q=%b", i, expected_q, q);
          $finish;
        end
      end
      
      // Now shift in 0s to walk the 0 through
      d = 0;
      for (i = 0; i < 8; i = i + 1) begin
        @(posedge clk);
        #1;
        expected_q = {1'b0, expected_q[7:1]};
        if (q !== expected_q) begin
          $display("CHECK ac1_under_simulation_right_shifter_produces FAIL");
          $display("ERROR at walk-0s step %d: expected q=%b, got q=%b", i, expected_q, q);
          $finish;
        end
      end
      
      // All tests passed
      $display("CHECK ac1_under_simulation_right_shifter_produces PASS");
    end
  endtask
  
endmodule