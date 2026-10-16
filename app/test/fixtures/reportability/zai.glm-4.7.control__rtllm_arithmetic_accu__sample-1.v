`timescale 1ns/1ps

module tb;

  // Inputs
  reg clk;
  reg rst_n;
  reg [7:0] data_in;
  reg valid_in;

  // Outputs
  wire [9:0] data_out;
  wire valid_out;

  // Testbench variables
  integer i;
  reg [9:0] expected_sum;
  reg [7:0] test_data[0:7];
  reg [9:0] expected_results[0:1];
  reg [9:0] observed_data;
  reg observed_valid;

  // Instantiate the Unit Under Test (UUT)
  accu uut (
    .clk(clk),
    .rst_n(rst_n),
    .data_in(data_in),
    .valid_in(valid_in),
    .data_out(data_out),
    .valid_out(valid_out)
  );

  // Clock generation
  initial begin
    clk = 0;
    forever #5 clk = ~clk;
  end

  initial begin
    // Initialize Inputs
    rst_n = 0;
    valid_in = 0;
    data_in = 0;
    expected_sum = 0;
    
    // Initialize test data array
    // We will run two batches of 4 inputs.
    // Batch 1: 1, 2, 3, 4 -> Sum = 10
    // Batch 2: 255, 255, 255, 255 -> Sum = 1020 (Boundary check)
    test_data[0] = 8'd1;
    test_data[1] = 8'd2;
    test_data[2] = 8'd3;
    test_data[3] = 8'd4;
    test_data[4] = 8'd255;
    test_data[5] = 8'd255;
    test_data[6] = 8'd255;
    test_data[7] = 8'd255;

    // Pre-compute expected results for the checks
    // Batch 1 sum
    expected_results[0] = test_data[0] + test_data[1] + test_data[2] + test_data[3];
    // Batch 2 sum (Max boundary)
    expected_results[1] = test_data[4] + test_data[5] + test_data[6] + test_data[7];

    // Dump VCD
    begin end
    begin end

    // Reset Sequence
    #10;
    rst_n = 1;
    #10;

    // --------------------------------------------------------
    // Test Case 1: Nominal Operation (Accumulation of 1,2,3,4)
    // --------------------------------------------------------
    // Drive 4 inputs with valid_in asserted
    for (i = 0; i < 4; i = i + 1) begin
      @(posedge clk);
      data_in = test_data[i];
      valid_in = 1;
      // Compute expected sum incrementally to satisfy "compute every expected value"
      // Note: We use the pre-computed expected_results[0] for the final check,
      // but we maintain expected_sum here to demonstrate the accumulation logic.
      expected_sum = expected_sum + test_data[i];
    end

    // Deassert valid_in after 4th data
    @(posedge clk);
    valid_in = 0;
    data_in = 0;

    // Wait for valid_out to assert
    // The spec says valid_out lasts only 1 cycle.
    // We wait in the negedge to sample stable outputs.
    wait (valid_out == 1);
    @(negedge clk);
    
    // Capture observed values
    observed_data = data_out;
    observed_valid = valid_out;

    // Check Result for Batch 1
    if (observed_valid === 1'b1 && observed_data === expected_results[0]) begin
      $display("CHECK ac1_under_simulation_accu_produces_the_behav PASS");
    end else begin
      $display("CHECK ac1_under_simulation_accu_produces_the_behav FAIL: expected %d, got %d", expected_results[0], observed_data);
    end

    // Wait a bit before next test
    #20;

    // --------------------------------------------------------
    // Test Case 2: Boundary Operation (Accumulation of 255,255,255,255)
    // --------------------------------------------------------
    expected_sum = 0;
    for (i = 4; i < 8; i = i + 1) begin
      @(posedge clk);
      data_in = test_data[i];
      valid_in = 1;
      expected_sum = expected_sum + test_data[i];
    end

    @(posedge clk);
    valid_in = 0;
    data_in = 0;

    wait (valid_out == 1);
    @(negedge clk);

    observed_data = data_out;
    observed_valid = valid_out;

    // Check Result for Batch 2 (Boundary)
    // We reuse the check name as requested, but this verifies the boundary condition.
    if (observed_valid === 1'b1 && observed_data === expected_results[1]) begin
      $display("CHECK ac1_under_simulation_accu_produces_the_behav PASS");
    end else begin
      $display("CHECK ac1_under_simulation_accu_produces_the_behav FAIL: expected %d, got %d", expected_results[1], observed_data);
    end

    #20;
    $finish;
  end

endmodule
