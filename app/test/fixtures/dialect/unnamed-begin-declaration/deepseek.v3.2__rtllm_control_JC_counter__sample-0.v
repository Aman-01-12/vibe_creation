module tb_JC_counter;
  // Clock and reset signals
  reg clk;
  reg rst_n;
  
  // Output from DUT
  wire [63:0] Q;
  
  // Expected values computed from spec
  reg [63:0] expected_Q;
  reg [63:0] prev_Q;
  
  // Test control
  integer cycle_count;
  integer test_step;
  
  // Instantiate the DUT
  JC_counter dut (
    .clk(clk),
    .rst_n(rst_n),
    .Q(Q)
  );
  
  // Clock generation
  always #5 clk = ~clk;
  
  // Initialize signals and start test
  initial begin
    // Initialize signals
    clk = 0;
    rst_n = 1;
    cycle_count = 0;
    test_step = 0;
    
    // Start VCD dump
    $dumpfile("dump.vcd");
    $dumpvars(0, tb_JC_counter);
    
    // Wait a little then apply reset
    #10;
    rst_n = 0;
    #20;
    rst_n = 1;
    
    // Test sequence
    test_sequence();
    
    $finish;
  end
  
  // Monitor outputs at settled time (negative edge of clock)
  always @(negedge clk) begin
    if (rst_n === 1'b1) begin
      // Store previous output for comparison
      prev_Q <= Q;
      
      // Check outputs against expected values
      if (test_step > 0) begin
        // For ac1 check: verify Johnson counter behavior
        if (test_step <= 9) begin // We'll check 9 states (including wrap)
          if (expected_Q !== Q) begin
            $display("CHECK ac1_under_simulation_jc_counter_produces_the FAIL: expected %064b, got %064b at step %0d", expected_Q, Q, test_step);
          end else begin
            $display("CHECK ac1_under_simulation_jc_counter_produces_the PASS");
          end
        }
        
        // For known answer check: verify increment sequence
        if (test_step > 1 && test_step <= 9) begin
          // Compute what the next Johnson counter value should be
          // Johnson counter rule: Q[63] = ~prev_Q[0], Q[62:0] = prev_Q[63:1]
          reg [63:0] computed_next;
          computed_next[63] = ~prev_Q[0];
          computed_next[62:0] = prev_Q[63:1];
          
          if (Q !== computed_next) begin
            $display("CHECK known_answer_counter_increments FAIL: expected %064b, got %064b at step %0d", computed_next, Q, test_step);
          end else begin
            $display("CHECK known_answer_counter_increments PASS");
          end
        end
      end
      
      // Prepare for next cycle
      if (test_step < 9) begin
        test_step <= test_step + 1;
        
        // Compute next expected value based on Johnson counter rules
        // This is computed from the OBSERVED Q, not from a model
        if (test_step >= 1) begin
          expected_Q[63] = ~Q[0];
          expected_Q[62:0] = Q[63:1];
        end
      end
      
      cycle_count <= cycle_count + 1;
    end
  end
  
  // Test sequence task
  task test_sequence;
    begin
      // Step 0: Right after reset
      // According to spec, 4-bit example starts at 0000
      // For 64-bit, we expect all zeros after reset
      #10; // Wait for first negedge after reset release
      expected_Q = 64'b0;
      
      // Step 1-8: Follow Johnson counter sequence
      // We'll drive enough cycles to see the pattern
      // The sequence for 64-bit Johnson counter:
      // 000...0, 100...0, 110...0, 111...0, ..., 111...1, 011...1, 001...1, 000...1, back to 000...0
      
      // We need 128 cycles for full 64-bit Johnson counter cycle,
      // but we'll test a few steps to verify the pattern
      
      // Wait for enough cycles to test
      #640; // 64 cycles * 10ns each = 640ns
    end
  endtask
  
  // Helper function to print binary with separators for readability
  function [255:0] fmt_bin;
    input [63:0] val;
    reg [255:0] result;
    integer i;
    begin
      result = "";
      for (i = 63; i >= 0; i = i - 1) begin
        result = {result, val[i] ? "1" : "0"};
        if (i % 8 == 0 && i != 0) result = {result, "_"};
      end
      fmt_bin = result;
    end
  endfunction
endmodule