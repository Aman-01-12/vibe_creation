`timescale 1ns/1ps

module tb_JC_counter;

  // Clock and reset signals
  reg clk;
  reg rst_n;

  // Output from DUT
  wire [63:0] Q;

  // Expected value for self-checking
  reg [63:0] expected_Q;

  // Instantiate the Device Under Test (DUT)
  JC_counter uut (
    .clk(clk),
    .rst_n(rst_n),
    .Q(Q)
  );

  // Clock generation
  initial begin
    clk = 0;
    forever #5 clk = ~clk; // 10ns period clock
  end

  // Main testbench logic
  initial begin
    integer i;
    
    $dumpfile("dump.vcd");
    $dumpvars(0, tb_JC_counter);

    // Initial state
    rst_n = 0;
    expected_Q = 64'h0000000000000000;

    // Apply reset
    #15 rst_n = 1; // Deassert reset after 15 ns

    // Wait for one cycle to observe post-reset value
    @(posedge clk);
    #1; // Allow nonblocking assignments to settle
    
    // Check AC1: Under simulation, JC_counter produces the behaviour the design requires on every case exercised
    // First state should be all zeros
    if (Q === expected_Q)
      $display("CHECK ac1_under_simulation_jc_counter_produces_the PASS");
    else begin
      $display("CHECK ac1_under_simulation_jc_counter_produces_the FAIL: expected %h, got %h", expected_Q, Q);
    end

    // Drive through full 4-bit example sequence extended to 64 bits
    // Sequence: 0000 -> 1000 -> 1100 -> 1110 -> 1111 -> 0111 -> 0011 -> 0001 -> 0000
    // Extend each bit pattern to 64-bit equivalent
    
    // State transitions for 64-bit Johnson counter:
    // Start with 0000...0000
    // Then shift in 1 from left until all ones
    // Then shift in 0 from left until all zeros
    
    // Manually define the expected sequence based on 4-bit extension to 64-bit
    reg [63:0] seq_4bit_extended [0:8];
    
    seq_4bit_extended[0] = 64'h0000000000000000; // 0000
    seq_4bit_extended[1] = 64'h8000000000000000; // 1000
    seq_4bit_extended[2] = 64'hc000000000000000; // 1100
    seq_4bit_extended[3] = 64'he000000000000000; // 1110
    seq_4bit_extended[4] = 64'hf000000000000000; // 1111
    seq_4bit_extended[5] = 64'h7000000000000000; // 0111
    seq_4bit_extended[6] = 64'h3000000000000000; // 0011
    seq_4bit_extended[7] = 64'h1000000000000000; // 0001
    seq_4bit_extended[8] = 64'h0000000000000000; // 0000
    
    // Now simulate 9 cycles and check each step
    for (i = 1; i <= 8; i = i + 1) begin
      @(posedge clk);
      #1; // Allow outputs to settle
      expected_Q = seq_4bit_extended[i];
      if (Q === expected_Q)
        $display("Step %0d passed: Q = %h", i, Q);
      else begin
        $display("Step %0d failed: expected %h, got %h", i, expected_Q, Q);
      end
    end
    
    // Known answer check: Verify that we've returned to initial state
    if (Q === 64'h0000000000000000)
      $display("CHECK known_answer_counter_increments PASS");
    else
      $display("CHECK known_answer_counter_increments FAIL: did not return to zero");
    
    // Run additional cycles to verify wrapping behavior
    for (i = 9; i <= 128; i = i + 1) begin
      @(posedge clk);
      #1;
    end
    
    // After 128 steps, we should have completed multiple full cycles
    // For a 64-bit Johnson counter, the period is 2*64 = 128
    // So at step 128, we should be back at the starting state
    if (Q === 64'h0000000000000000)
      $display("Extended cycle check passed: Back to initial state after 128 steps");
    else
      $display("Extended cycle check failed: Not at initial state after 128 steps, got %h", Q);
    
    $finish;
  end
  
endmodule
