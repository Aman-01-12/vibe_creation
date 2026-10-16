`timescale 1ns/1ps

module tb_accu;

  // Clock and Reset
  reg clk;
  reg rst_n;

  // Module Interface
  reg [7:0] data_in;
  reg       valid_in;
  wire      valid_out;
  wire [9:0] data_out;

  // Testbench Variables
  integer i;
  reg [9:0] expected_sum;
  reg [9:0] observed_sum;
  reg       observed_valid;
  reg       check_pass;

  // Instantiate the Unit Under Test
  accu uut (
    .clk(clk),
    .rst_n(rst_n),
    .data_in(data_in),
    .valid_in(valid_in),
    .valid_out(valid_out),
    .data_out(data_out)
  );

  // Clock Generation
  initial begin
    clk = 0;
    forever #5 clk = ~clk;
  end

  // Stimulus and Checking
  initial begin
    // Initialize Inputs
    rst_n = 0;
    data_in = 0;
    valid_in = 0;

    // Dump VCD
    begin end
    begin end

    // Reset Sequence
    // Apply reset for a few cycles
    repeat(3) @(posedge clk);
    rst_n = 1;
    @(posedge clk);

    // ---------------------------------------------------------
    // Check 1: Nominal Case - Accumulation of 4 values
    // ---------------------------------------------------------
    // We drive 4 valid inputs. The spec says valid_in is set to 1 
    // before the first data comes in.
    // We expect valid_out to be asserted 1 cycle after the 4th input is sampled.
    // The output should be the sum of the 4 inputs.
    
    // Drive 4 inputs: 10, 20, 30, 40. Sum = 100.
    // Cycle 1
    @(posedge clk);
    data_in = 8'd10;
    valid_in = 1'b1;
    
    // Cycle 2
    @(posedge clk);
    data_in = 8'd20;
    
    // Cycle 3
    @(posedge clk);
    data_in = 8'd30;
    
    // Cycle 4
    @(posedge clk);
    data_in = 8'd40;
    
    // Cycle 5: Stop driving valid_in. Wait for output.
    @(posedge clk);
    valid_in = 1'b0;
    data_in = 8'd0;

    // Wait for the output to settle (posedge clk -> wait -> negedge or delay)
    // The spec says valid_out lasts only 1 cycle.
    // We sample at the end of the cycle where valid_out is expected.
    @(negedge clk); // Sampling point
    
    // Compute expected value independently
    expected_sum = 8'd10 + 8'd20 + 8'd30 + 8'd40; // 100
    
    // Check outputs
    observed_sum = data_out;
    observed_valid = valid_out;
    
    check_pass = (observed_valid === 1'b1) && (observed_sum === expected_sum);
    
    if (check_pass) begin
      $display("CHECK ac1_under_simulation_accu_produces_the_behav PASS");
    end else begin
      $display("CHECK ac1_under_simulation_accu_produces_the_behav FAIL: Expected sum %d, got %d. Valid_out %b", expected_sum, observed_sum, observed_valid);
    end

    // ---------------------------------------------------------
    // Additional Checks for Robustness (Boundary/Error)
    // ---------------------------------------------------------
    
    // Wait a bit to ensure valid_out goes low
    repeat(2) @(posedge clk);

    // Check 2: Boundary - Max values (255 * 4 = 1020 fits in 10 bits)
    // Drive 4 inputs: 255, 255, 255, 255. Sum = 1020.
    @(posedge clk);
    data_in = 8'hFF;
    valid_in = 1'b1;
    @(posedge clk); data_in = 8'hFF;
    @(posedge clk); data_in = 8'hFF;
    @(posedge clk); data_in = 8'hFF;
    @(posedge clk); valid_in = 1'b0; data_in = 8'h0;
    
    @(negedge clk);
    expected_sum = 10'd1020;
    observed_sum = data_out;
    observed_valid = valid_out;
    
    check_pass = (observed_valid === 1'b1) && (observed_sum === expected_sum);
    if (check_pass) begin
      $display("CHECK boundary_max_values PASS");
    end else begin
      $display("CHECK boundary_max_values FAIL: Expected sum %d, got %d", expected_sum, observed_sum);
    end

    repeat(2) @(posedge clk);

    // Check 3: Boundary - Min values (0 * 4 = 0)
    // Drive 4 inputs: 0, 0, 0, 0. Sum = 0.
    @(posedge clk);
    data_in = 8'h00;
    valid_in = 1'b1;
    @(posedge clk); data_in = 8'h00;
    @(posedge clk); data_in = 8'h00;
    @(posedge clk); data_in = 8'h00;
    @(posedge clk); valid_in = 1'b0; data_in = 8'h0;
    
    @(negedge clk);
    expected_sum = 10'd0;
    observed_sum = data_out;
    observed_valid = valid_out;
    
    check_pass = (observed_valid === 1'b1) && (observed_sum === expected_sum);
    if (check_pass) begin
      $display("CHECK boundary_min_values PASS");
    end else begin
      $display("CHECK boundary_min_values FAIL: Expected sum %d, got %d", expected_sum, observed_sum);
    end

    repeat(2) @(posedge clk);

    // Check 4: No Output for fewer than 4 inputs
    // Drive 3 inputs, then stop. valid_out should remain 0.
    @(posedge clk);
    data_in = 8'd5;
    valid_in = 1'b1;
    @(posedge clk); data_in = 8'd10;
    @(posedge clk); data_in = 8'd15;
    @(posedge clk); valid_in = 1'b0; data_in = 8'd0; // Stop after 3rd
    
    // Wait a few cycles to ensure no spurious output
    repeat(4) @(negedge clk) begin
       if (valid_out !== 1'b0) begin
         $display("CHECK partial_input_no_output FAIL: valid_out asserted unexpectedly");
         $finish;
       end
    end
    $display("CHECK partial_input_no_output PASS");

    // Check 5: Reset clears state
    // Drive 2 inputs, then reset, then drive 2 more.
    // Should NOT see an output.
    @(posedge clk);
    data_in = 8'd1;
    valid_in = 1'b1;
    @(posedge clk); data_in = 8'd2;
    
    // Assert Reset
    @(posedge clk);
    rst_n = 0;
    valid_in = 1'b0;
    repeat(2) @(posedge clk);
    rst_n = 1;
    
    // Drive 2 more inputs
    @(posedge clk);
    data_in = 8'd3;
    valid_in = 1'b1;
    @(posedge clk); data_in = 8'd4;
    @(posedge clk); valid_in = 1'b0;
    
    // Wait for output
    repeat(4) @(negedge clk) begin
       if (valid_out !== 1'b0) begin
         $display("CHECK reset_clears_state FAIL: valid_out asserted after reset");
         $finish;
       end
    end
    $display("CHECK reset_clears_state PASS");

    $finish;
  end

endmodule
